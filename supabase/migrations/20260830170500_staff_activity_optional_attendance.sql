-- The staff workspace already loads canonical attendance through
-- public.staff_attendance_home().  Allow that page to request only connectivity
-- from the legacy combined activity endpoint instead of scanning and returning
-- up to 120 duplicate online-training attendance rows on every login.

begin;

set local lock_timeout = '1s';
set local statement_timeout = '15s';

create or replace function employee_ops_private.staff_activity_home(
  p_include_attendance boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '4s'
set jit = 'off'
as $function$
declare
  v_user uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text;
  v_result jsonb;
begin
  if coalesce(p_include_attendance, true) then
    return employee_ops_private.staff_activity_home();
  end if;

  if v_user is null then
    raise exception 'not_authenticated';
  end if;

  select employee.id, employee.employee_no
  into v_employee_id, v_employee_no
  from public.user_access access
  join public.employees employee on employee.id = access.employee_id
  where access.auth_user_id = v_user
    and access.active
    and access.employee_portal_enabled
  order by access.updated_at desc
  limit 1;

  if v_employee_id is null then
    raise exception 'staff_profile_not_linked';
  end if;

  with connectivity_summary as materialized (
    select
      count(*)::integer as total,
      count(*) filter (where incident.incident_type = 'power_outage')::integer as power,
      count(*) filter (where incident.incident_type = 'internet_outage')::integer as internet
    from public.employee_connectivity_incidents incident
    where incident.employee_id = v_employee_id
  ), recent_connectivity as materialized (
    select
      incident.id,
      incident.incident_date,
      incident.incident_type,
      incident.started_at,
      incident.ended_at,
      incident.duration_minutes,
      incident.details,
      incident.evidence_url,
      incident.attachments,
      incident.status,
      incident.created_at
    from public.employee_connectivity_incidents incident
    where incident.employee_id = v_employee_id
    order by incident.incident_date desc, incident.id desc
    limit 120
  )
  select jsonb_build_object(
    'employee_no', v_employee_no,
    'attendance', null,
    'connectivity', jsonb_build_object(
      'total', summary.total,
      'power', summary.power,
      'internet', summary.internet,
      'rows', coalesce((
        select jsonb_agg(to_jsonb(recent) order by recent.incident_date desc, recent.id desc)
        from recent_connectivity recent
      ), '[]'::jsonb)
    )
  )
  into v_result
  from connectivity_summary summary;

  return v_result;
end;
$function$;

create or replace function public.staff_activity_home(
  p_include_attendance boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '4500ms'
as $function$
begin
  if not session_private.current_app_session_is_valid('staff') then
    raise exception 'session_not_current';
  end if;
  return employee_ops_private.staff_activity_home(p_include_attendance);
end;
$function$;

revoke all on function employee_ops_private.staff_activity_home(boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.staff_activity_home(boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_activity_home(boolean) to authenticated;

comment on function public.staff_activity_home(boolean) is
  'Returns the current staff member activity payload; pass false when canonical attendance is loaded separately so only bounded connectivity history is queried.';

commit;
