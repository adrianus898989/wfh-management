begin;

-- Keep one payout-change alert per request. Pending review is informational;
-- an approved request whose manually-edited profile does not match becomes a
-- new warning cycle so it reappears as unread in the bell.
create or replace function alerts_private.sync_payout_change_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees%rowtype;
  v_condition_key text;
  v_title text;
  v_message text;
  v_severity text;
  v_fulfillment_status text;
begin
  if tg_op = 'DELETE' then
    v_condition_key := 'payout_change:' || old.id::text;
    update public.admin_alert_events event
    set is_active = false,
        last_seen_at = clock_timestamp(),
        resolved_at = coalesce(event.resolved_at, clock_timestamp()),
        payload = event.payload || jsonb_build_object('request_status', 'deleted')
    where event.condition_key = v_condition_key
      and event.is_active = true;
    return old;
  end if;

  v_condition_key := 'payout_change:' || new.id::text;

  select * into v_employee
  from public.employees employee
  where employee.id = new.employee_id;

  if new.status = 'pending' then
    v_title := '收款资料待审核';
    v_message := v_employee.full_name || ' 提交了收款资料修改申请';
    v_severity := 'info';
    v_fulfillment_status := 'awaiting_review';
  elsif new.status = 'approved' and new.fulfillment_status = 'mismatch' then
    v_title := '工资资料修改未匹配';
    v_message := v_employee.full_name || ' 的收款资料已修改，但与审核通过的申请不一致';
    v_severity := 'warning';
    v_fulfillment_status := 'mismatch';
  else
    update public.admin_alert_events event
    set is_active = false,
        last_seen_at = clock_timestamp(),
        resolved_at = coalesce(event.resolved_at, clock_timestamp()),
        payload = event.payload || jsonb_build_object(
          'request_status', new.status,
          'fulfillment_status', new.fulfillment_status
        )
    where event.condition_key = v_condition_key
      and event.is_active = true;
    return new;
  end if;

  insert into public.admin_alert_events (
    alert_key, condition_key, alert_type, severity, employee_id,
    employee_no, employee_name, title, message, window_start, window_end,
    occurrence_count, payload, source_ref, is_active, last_seen_at, resolved_at
  ) values (
    v_condition_key || ':' || gen_random_uuid()::text,
    v_condition_key,
    'payout_change',
    v_severity,
    new.employee_id,
    v_employee.employee_no,
    v_employee.full_name,
    v_title,
    v_message,
    (new.created_at at time zone 'Asia/Manila')::date,
    (clock_timestamp() at time zone 'Asia/Manila')::date,
    1,
    jsonb_build_object(
      'request_id', new.id,
      'request_status', new.status,
      'fulfillment_status', v_fulfillment_status,
      'payment_kind', new.payment_kind,
      'reason', new.reason
    ),
    new.id::text,
    true,
    clock_timestamp(),
    null
  )
  on conflict (condition_key) where is_active do update set
    severity = excluded.severity,
    employee_no = excluded.employee_no,
    employee_name = excluded.employee_name,
    title = excluded.title,
    message = excluded.message,
    window_end = excluded.window_end,
    payload = excluded.payload,
    alert_cycle = case
      when public.admin_alert_events.payload->>'fulfillment_status'
        is distinct from excluded.payload->>'fulfillment_status'
      then public.admin_alert_events.alert_cycle + 1
      else public.admin_alert_events.alert_cycle
    end,
    last_seen_at = clock_timestamp(),
    resolved_at = null;

  return new;
end;
$$;

revoke all on function alerts_private.sync_payout_change_alert()
  from public, anon, authenticated;

drop trigger if exists payout_change_admin_alert_trigger
  on public.payout_change_requests;
create trigger payout_change_admin_alert_trigger
after insert or update of
  status,
  payment_kind,
  reason,
  fulfillment_status
on public.payout_change_requests
for each row execute function alerts_private.sync_payout_change_alert();

-- Re-evaluate any already-approved mismatch after installing the expanded
-- trigger. This does not alter the approved request or any payout profile.
update public.payout_change_requests
set fulfillment_status = fulfillment_status
where status = 'approved'
  and fulfillment_status = 'mismatch';

-- Return the employee hire date in the already scope-checked alert payload so
-- the new warning table does not need an extra per-row browser query.
create or replace function public.admin_alert_center(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_status text := lower(btrim(coalesce(p_filters->>'status', 'active')));
  v_type text := lower(btrim(coalesce(p_filters->>'alert_type', '')));
  v_group text := lower(btrim(coalesce(p_filters->>'group', 'all')));
  v_severity text := lower(btrim(coalesce(p_filters->>'severity', '')));
  v_search text := lower(btrim(coalesce(p_filters->>'search', '')));
  v_unread_only boolean := lower(coalesce(p_filters->>'unread_only', 'false')) = 'true';
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 1000000);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not (
    public.has_permission('payroll.payout_change.review')
    or public.has_permission('report.view')
    or public.has_permission('adjustment.view')
    or public.has_permission('attendance.view')
    or public.has_permission('daily_work.manage')
    or public.has_permission('exam.view')
    or public.has_permission('account.view')
    or public.has_permission('user.view')
  ) then raise exception 'permission_denied'; end if;
  if v_status not in ('all', 'active', 'resolved') then
    raise exception 'invalid_alert_status';
  end if;
  if v_group not in ('all', 'account', 'attendance', 'quality') then
    raise exception 'invalid_alert_group';
  end if;
  if v_severity <> '' and v_severity not in ('info', 'warning', 'critical') then
    raise exception 'invalid_alert_severity';
  end if;
  if v_type <> '' and v_type not in (
    'payout_change', 'error_spike', 'deduction_frequency',
    'late_timeout_frequency', 'consecutive_rest', 'weekly_absence',
    'monthly_leave', 'exam_failed', 'resigned_account_active'
  ) then raise exception 'invalid_alert_type'; end if;

  with visible as materialized (
    select event.*,
      employee.hire_date,
      (event.is_active and receipt.alert_id is null) unread
    from public.admin_alert_events event
    left join public.employees employee on employee.id = event.employee_id
    left join public.admin_alert_read_receipts receipt
      on receipt.alert_id = event.id
     and receipt.auth_user_id = v_user_id
     and receipt.alert_cycle = event.alert_cycle
    where alerts_private.caller_can_view_alert_type(event.alert_type)
      and (
        public.backend_employee_in_scope(event.employee_id)
        or (event.employee_id is null and public.is_founder())
      )
  ), filtered as materialized (
    select * from visible alert
    where (v_status = 'all'
      or (v_status = 'active' and alert.is_active)
      or (v_status = 'resolved' and not alert.is_active))
      and (v_type = '' or alert.alert_type = v_type)
      and (
        v_group = 'all'
        or (v_group = 'account' and alert.alert_type in (
          'payout_change', 'resigned_account_active'
        ))
        or (v_group = 'attendance' and alert.alert_type in (
          'late_timeout_frequency', 'consecutive_rest', 'weekly_absence',
          'monthly_leave'
        ))
        or (v_group = 'quality' and alert.alert_type in (
          'error_spike', 'deduction_frequency', 'exam_failed'
        ))
      )
      and (v_severity = '' or alert.severity = v_severity)
      and (not v_unread_only or alert.unread)
      and (
        v_search = ''
        or lower(concat_ws(' ', alert.employee_no, alert.employee_name,
          alert.title, alert.message)) like '%' || v_search || '%'
      )
  ), paged as materialized (
    select * from filtered
    order by is_active desc, last_seen_at desc, id desc
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from filtered),
    'pages', greatest(1,
      ceil((select count(*) from filtered)::numeric / v_page_size)::integer),
    'active_total', (select count(*) from visible where is_active),
    'unread_total', (select count(*) from visible where is_active and unread),
    'type_counts', coalesce((
      select jsonb_object_agg(alert_type, total order by alert_type)
      from (
        select alert_type, count(*) total
        from visible where is_active group by alert_type
      ) counts
    ), '{}'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', alert.id,
        'alert_key', alert.alert_key,
        'alert_type', alert.alert_type,
        'severity', alert.severity,
        'employee_id', alert.employee_id,
        'employee_no', alert.employee_no,
        'employee_name', alert.employee_name,
        'hire_date', alert.hire_date,
        'title', alert.title,
        'message', alert.message,
        'window_start', alert.window_start,
        'window_end', alert.window_end,
        'occurrence_count', alert.occurrence_count,
        'payload', alert.payload,
        'source_ref', alert.source_ref,
        'is_active', alert.is_active,
        'unread', alert.unread,
        'first_seen_at', alert.first_seen_at,
        'last_seen_at', alert.last_seen_at,
        'resolved_at', alert.resolved_at
      ) order by alert.is_active desc, alert.last_seen_at desc, alert.id desc)
      from paged alert
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_alert_center(jsonb, integer, integer)
  from public, anon;
grant execute on function public.admin_alert_center(jsonb, integer, integer)
  to authenticated, service_role;

comment on function public.admin_alert_center(jsonb, integer, integer) is
  'Returns scoped alert records, employee hire dates, and attendance evidence for the admin warning table.';

notify pgrst, 'reload schema';

commit;
