begin;

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
  v_employee_id_text text := btrim(coalesce(p_filters->>'employee_id', ''));
  v_employee_id uuid;
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
  if v_employee_id_text <> '' then
    begin
      v_employee_id := v_employee_id_text::uuid;
    exception when invalid_text_representation then
      raise exception 'invalid_employee_id';
    end;
  end if;

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
  ), employee_visible as materialized (
    select * from visible alert
    where v_employee_id is null or alert.employee_id = v_employee_id
  ), filtered as materialized (
    select * from employee_visible alert
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
    'active_total', (select count(*) from employee_visible where is_active),
    'unread_total', (select count(*) from employee_visible where is_active and unread),
    'type_counts', coalesce((
      select jsonb_object_agg(alert_type, total order by alert_type)
      from (
        select alert_type, count(*) total
        from employee_visible where is_active group by alert_type
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
  'Returns scoped alert records with an optional exact employee_id filter for employee warning history.';

notify pgrst, 'reload schema';

commit;
