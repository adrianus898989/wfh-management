begin;

-- The list is normally opened by date and always sorted newest-first.  Existing
-- indexes start with employee/type/status, so an all-scope date query could not
-- use an index for either the date window or the requested order.
create index if not exists employee_connectivity_incident_date_idx
  on public.employee_connectivity_incidents (incident_date desc, id desc);

-- Materialize the caller's canonical employee allow-list once and reuse the
-- resulting employee directory for rows and all three filter option lists.
-- This replaces four independent scans that each performed a row-level scope
-- check once per employee.
create or replace function public.admin_connectivity_home(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
set lock_timeout = '500ms'
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_page integer := greatest(coalesce(nullif(p_filters->>'page', '')::integer, 1), 1);
  v_size integer := least(greatest(coalesce(nullif(p_filters->>'page_size', '')::integer, 30), 1), 100);
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no', '')));
  v_employee_name text := lower(btrim(coalesce(p_filters->>'employee_name', '')));
  v_team text := btrim(coalesce(p_filters->>'team', ''));
  v_position text := btrim(coalesce(p_filters->>'position', ''));
  v_type text := btrim(coalesce(p_filters->>'incident_type', ''));
  v_status text := btrim(coalesce(p_filters->>'status', ''));
  v_country text := btrim(coalesce(p_filters->>'country', ''));
  v_from date := nullif(p_filters->>'date_from', '')::date;
  v_to date := nullif(p_filters->>'date_to', '')::date;
  v_all boolean := false;
  v_can_create boolean;
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('connectivity.view') then
    raise exception 'permission_denied';
  end if;
  v_can_create := public.has_permission('connectivity.create');

  select role.code = 'founder' or access.data_scope = 'all'
  into v_all
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;
  if not found then raise exception 'permission_denied'; end if;

  if v_from is not null and v_to is not null and v_from > v_to then
    select v_to, v_from into v_from, v_to;
  end if;

  with authorized_employee_ids as materialized (
    select scope.employee_id
    from public.admin_scope_effective_employee_ids(v_user_id) scope
  ), current_directory as materialized (
    select directory.*
    from scope_private.current_employee_scope_directory() directory
  ), scoped_employees as materialized (
    select
      employee.id employee_id,
      employee.employee_no,
      employee.full_name,
      employee.hire_date,
      employee.status employee_status,
      coalesce(
        nullif(btrim(employee.country), ''),
        nullif(btrim(employee.nationality), ''),
        '未填写'
      ) employee_country,
      case
        when directory.employee_id is not null then current_team.name
        else historical_team.name
      end team_name,
      case
        when directory.employee_id is not null then current_position.name
        else historical_position.name
      end position_name
    from authorized_employee_ids allowed
    join public.employees employee on employee.id = allowed.employee_id
    left join current_directory directory on directory.employee_id = employee.id
    left join public.teams current_team on current_team.id = directory.current_team_id
    left join public.positions current_position on current_position.id = directory.current_position_id
    -- Historical employee columns are not authorization truth.  They are used
    -- only so Founder/all can still read archived incidents for a person who is
    -- no longer present in the canonical current-roster directory.
    left join public.teams historical_team
      on historical_team.id = employee.team_id
     and v_all
     and directory.employee_id is null
    left join public.positions historical_position
      on historical_position.id = employee.position_id
     and v_all
     and directory.employee_id is null
    where directory.employee_id is not null or v_all
  ), filtered as materialized (
    select
      incident.id,
      incident.employee_id,
      incident.incident_date,
      incident.incident_type,
      incident.started_at,
      incident.ended_at,
      incident.duration_minutes,
      incident.details,
      incident.evidence_url,
      incident.attachments,
      incident.status,
      incident.created_at,
      employee.employee_no,
      employee.full_name,
      employee.hire_date,
      employee.employee_status,
      employee.employee_country,
      employee.team_name,
      employee.position_name,
      coalesce(
        nullif(btrim(recorder.login_username), ''),
        '后台账号'
      ) recorded_by_name
    from public.employee_connectivity_incidents incident
    join scoped_employees employee on employee.employee_id = incident.employee_id
    left join lateral (
      select btrim(access.login_username) login_username
      from public.user_access access
      where access.auth_user_id = incident.recorded_by
        and access.active
        and nullif(btrim(access.login_username), '') is not null
        and strpos(btrim(access.login_username), '@') = 0
      order by access.updated_at desc
      limit 1
    ) recorder on true
    where (v_employee_no = '' or lower(employee.employee_no) like '%' || v_employee_no || '%')
      and (v_employee_name = '' or lower(employee.full_name) like '%' || v_employee_name || '%')
      and (v_team = '' or lower(coalesce(employee.team_name, '')) = lower(v_team))
      and (v_position = '' or lower(coalesce(employee.position_name, '')) = lower(v_position))
      and (v_type = '' or incident.incident_type = v_type)
      and (v_status = '' or incident.status = v_status)
      and (v_country = '' or lower(employee.employee_country) = lower(v_country))
      and (v_from is null or incident.incident_date >= v_from)
      and (v_to is null or incident.incident_date <= v_to)
  ), country_daily as materialized (
    select incident_date, employee_country, count(distinct employee_id)::integer employees
    from filtered
    group by incident_date, employee_country
  ), daily as materialized (
    select
      entry.incident_date,
      count(*)::integer total_records,
      count(distinct entry.employee_id)::integer affected_employees,
      count(*) filter (where entry.incident_type = 'power_outage')::integer power,
      count(*) filter (where entry.incident_type = 'internet_outage')::integer internet,
      coalesce((
        select jsonb_agg(
          jsonb_build_object('name', country.employee_country, 'employees', country.employees)
          order by country.employees desc, country.employee_country
        )
        from country_daily country
        where country.incident_date = entry.incident_date
      ), '[]'::jsonb) countries
    from filtered entry
    group by entry.incident_date
  ), paged as materialized (
    select *
    from filtered
    order by incident_date desc, id desc
    limit v_size offset (v_page - 1) * v_size
  ), totals as materialized (
    select
      count(*)::integer total,
      count(distinct employee_id)::integer affected_employees,
      count(*) filter (where incident_type = 'power_outage')::integer power,
      count(*) filter (where incident_type = 'internet_outage')::integer internet
    from filtered
  )
  select jsonb_build_object(
    'permissions', jsonb_build_object('create', v_can_create),
    'page', v_page,
    'page_size', v_size,
    'total', total.total,
    'pages', greatest(1, ceil(total.total::numeric / v_size)::integer),
    'summary', jsonb_build_object(
      'total', total.total,
      'affected_employees', total.affected_employees,
      'power', total.power,
      'internet', total.internet
    ),
    'country_options', coalesce((
      select jsonb_agg(option.name order by option.name)
      from (
        select distinct employee_country name from scoped_employees
      ) option
    ), '[]'::jsonb),
    'team_options', coalesce((
      select jsonb_agg(option.name order by option.name)
      from (
        select distinct team_name name
        from scoped_employees
        where nullif(btrim(team_name), '') is not null
      ) option
    ), '[]'::jsonb),
    'position_options', coalesce((
      select jsonb_agg(option.name order by option.name)
      from (
        select distinct position_name name
        from scoped_employees
        where nullif(btrim(position_name), '') is not null
      ) option
    ), '[]'::jsonb),
    'daily_stats', coalesce((
      select jsonb_agg(to_jsonb(entry) order by entry.incident_date desc)
      from (
        select * from daily order by incident_date desc limit 31
      ) entry
    ), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(entry) order by entry.incident_date desc, entry.id desc)
      from paged entry
    ), '[]'::jsonb)
  ) into v_result
  from totals total;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

revoke all on function public.admin_connectivity_home(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_connectivity_home(jsonb)
  to authenticated, service_role;

comment on function public.admin_connectivity_home(jsonb) is
  'Bounded connectivity home response using one canonical employee allow-list for rows, summaries, and filter options.';

notify pgrst, 'reload schema';

commit;
