begin;

-- Build the alert page from the already-materialized event table while
-- resolving caller permissions and employee scope once per request.  The old
-- reader invoked session/scope helpers once for every event, which amplified a
-- small 38-row page into multi-second work under concurrent browser requests.
-- This private helper is installed first so it can be benchmarked while the
-- public emergency breaker remains in place.
create or replace function alerts_private.admin_alert_center_page_fast(
  p_user_id uuid,
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
  v_role_id uuid;
  v_role_code text;
  v_scope text;
  v_caller_employee_id uuid;
  v_alert_view boolean := false;
  v_result jsonb;
begin
  if p_user_id is null then raise exception 'not_authenticated'; end if;

  select access.role_id, role.code, access.data_scope, access.employee_id
  into v_role_id, v_role_code, v_scope, v_caller_employee_id
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = p_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if v_role_id is null then raise exception 'permission_denied'; end if;

  if v_role_code = 'founder' then
    v_alert_view := true;
  else
    select coalesce(
      (
        select override.allowed
        from public.user_permission_overrides override
        join public.permissions permission on permission.id = override.permission_id
        where override.auth_user_id = p_user_id
          and permission.code = 'alert.view'
        limit 1
      ),
      exists (
        select 1
        from public.role_permissions role_permission
        join public.permissions permission on permission.id = role_permission.permission_id
        where role_permission.role_id = v_role_id
          and permission.code = 'alert.view'
      )
    ) into v_alert_view;
  end if;
  if not coalesce(v_alert_view, false) then raise exception 'permission_denied'; end if;

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

  with alert_permission(alert_type, permission_code) as (
    values
      ('payout_change', 'alert.payout_change.view'),
      ('resigned_account_active', 'alert.resigned_account_active.view'),
      ('today_missing_clock_in', 'alert.today_missing_clock_in.view'),
      ('today_missing_daily_report', 'alert.today_missing_daily_report.view'),
      ('leave_activity', 'alert.leave_activity.view'),
      ('late_timeout_frequency', 'alert.late_timeout_frequency.view'),
      ('consecutive_rest', 'alert.consecutive_rest.view'),
      ('weekly_absence', 'alert.weekly_absence.view'),
      ('monthly_leave', 'alert.monthly_leave.view'),
      ('error_spike', 'alert.error_spike.view'),
      ('repeated_error', 'alert.repeated_error.view'),
      ('deduction_frequency', 'alert.deduction_frequency.view'),
      ('exam_failed', 'alert.exam_failed.view'),
      ('low_workload_streak', 'alert.low_workload_streak.view')
  ), allowed_type as materialized (
    select mapping.alert_type
    from alert_permission mapping
    where v_role_code = 'founder'
       or coalesce(
         (
           select override.allowed
           from public.user_permission_overrides override
           join public.permissions permission on permission.id = override.permission_id
           where override.auth_user_id = p_user_id
             and permission.code = mapping.permission_code
           limit 1
         ),
         exists (
           select 1
           from public.role_permissions role_permission
           join public.permissions permission on permission.id = role_permission.permission_id
           where role_permission.role_id = v_role_id
             and permission.code = mapping.permission_code
         )
       )
  ), visible as materialized (
    select event.*,
      employee.hire_date,
      (event.is_active and receipt.alert_id is null) unread
    from public.admin_alert_events event
    join allowed_type allowed on allowed.alert_type = event.alert_type
    left join public.employees employee on employee.id = event.employee_id
    left join public.admin_alert_read_receipts receipt
      on receipt.alert_id = event.id
     and receipt.auth_user_id = p_user_id
     and receipt.alert_cycle = event.alert_cycle
    left join public.user_scope_employees scoped_employee
      on scoped_employee.auth_user_id = p_user_id
     and scoped_employee.employee_id = event.employee_id
    where (
      (event.employee_id is not null and (
        v_role_code = 'founder'
        or v_scope = 'all'
        or (v_scope = 'self' and event.employee_id = v_caller_employee_id)
        or (v_scope in ('own_team', 'assigned_teams')
          and scoped_employee.employee_id is not null)
      ))
      or (event.employee_id is null and v_role_code = 'founder')
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
        'team_name', coalesce(nullif(btrim(team.name), ''), ''),
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
        'resolved_at', alert.resolved_at,
        'readers', coalesce((
          select jsonb_agg(jsonb_build_object(
            'auth_user_id', reader.auth_user_id,
            'account', reader.account,
            'read_at', reader.read_at
          ) order by reader.read_at desc)
          from (
            select reader_receipt.auth_user_id,
              reader_receipt.read_at,
              coalesce(
                nullif(btrim(reader_access.login_username), ''),
                nullif(btrim(reader_access.login_email), ''),
                left(reader_receipt.auth_user_id::text, 8)
              ) account
            from public.admin_alert_read_receipts reader_receipt
            left join public.user_access reader_access
              on reader_access.auth_user_id = reader_receipt.auth_user_id
            where reader_receipt.alert_id = alert.id
              and reader_receipt.alert_cycle = alert.alert_cycle
          ) reader
        ), '[]'::jsonb),
        'follow_up', coalesce((
          select jsonb_build_object(
            'status', follow_up.status,
            'confirmed_by', follow_up.confirmed_by,
            'confirmed_by_name', follow_up.confirmed_by_name,
            'confirmed_at', follow_up.confirmed_at,
            'handled_by', follow_up.handled_by,
            'handled_by_name', follow_up.handled_by_name,
            'handled_at', follow_up.handled_at,
            'handling_note', follow_up.handling_note,
            'updated_at', follow_up.updated_at
          )
          from public.admin_alert_follow_ups follow_up
          where follow_up.alert_id = alert.id
            and follow_up.alert_cycle = alert.alert_cycle
        ), jsonb_build_object('status', 'pending'))
      ) order by alert.is_active desc, alert.last_seen_at desc, alert.id desc)
      from paged alert
      left join scope_private.current_employee_scope_directory() directory
        on directory.employee_id = alert.employee_id
      left join public.teams team on team.id = directory.current_team_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function alerts_private.admin_alert_center_page_fast(
  uuid, jsonb, integer, integer
) from public, anon, authenticated, service_role;

alter function alerts_private.admin_alert_center_page_fast(
  uuid, jsonb, integer, integer
) set statement_timeout = '3s';
alter function alerts_private.admin_alert_center_page_fast(
  uuid, jsonb, integer, integer
) set lock_timeout = '500ms';

comment on function alerts_private.admin_alert_center_page_fast(
  uuid, jsonb, integer, integer
) is 'Private precomputed alert reader that resolves caller permission and scope once; benchmark before swapping the public recovery breaker.';

commit;
