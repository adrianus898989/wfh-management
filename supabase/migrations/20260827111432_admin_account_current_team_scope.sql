begin;

-- Team scope is an authorization boundary.  The canonical teams table keeps
-- historical rows intentionally, so it cannot by itself answer which teams
-- still exist in the current organization.  Build the account-scope directory
-- from the current schedule read model (`source_kind = roster`) and use the
-- current home-roster presence state only to resolve employees who are absent
-- from the schedule.  A team is selectable only when the current schedule has
-- at least one member in it.
create or replace function public.admin_scope_current_team_directory()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with canonical_teams as materialized (
    select
      pg_catalog.lower(pg_catalog.btrim(team.name)) team_key,
      (pg_catalog.array_agg(
        team.id order by team.id
      ))[1] team_id
    from public.teams team
    where team.status = 'active'
      and nullif(pg_catalog.btrim(team.name), '') is not null
    group by pg_catalog.lower(pg_catalog.btrim(team.name))
  ), roster_rows as materialized (
    select
      public.employee_master_normalize_id(directory.employee_no) employee_no,
      pg_catalog.lower(pg_catalog.btrim(directory.team_name)) team_key,
      pg_catalog.btrim(directory.team_name) team_name,
      directory.source_row,
      directory.refreshed_at
    from public.report_employee_directory_cache directory
    where directory.source_kind = 'roster'
      and nullif(public.employee_master_normalize_id(directory.employee_no), '') is not null
      and nullif(pg_catalog.btrim(directory.team_name), '') is not null
  ), roster_assignments as materialized (
    select distinct on (roster.employee_no)
      roster.employee_no,
      roster.team_key,
      roster.team_name,
      roster.source_row,
      roster.refreshed_at
    from roster_rows roster
    order by roster.employee_no, roster.source_row desc nulls last
  ), matched_roster as materialized (
    select
      roster.employee_no,
      canonical.team_id,
      roster.team_name,
      roster.source_row,
      roster.refreshed_at
    from roster_assignments roster
    join canonical_teams canonical using (team_key)
  ), current_teams as materialized (
    select
      roster.team_id id,
      (pg_catalog.array_agg(
        roster.team_name order by roster.source_row desc nulls last, roster.team_name
      ))[1] name,
      pg_catalog.count(distinct roster.employee_no)::integer member_count
    from matched_roster roster
    group by roster.team_id
  ), current_home_assignments as materialized (
    select distinct on (public.employee_master_normalize_id(employee.employee_no))
      public.employee_master_normalize_id(employee.employee_no) employee_no,
      employee.team_id,
      'home_roster'::text assignment_source
    from public.employee_master_presence_state presence
    join public.employees employee on employee.id = presence.employee_id
    join current_teams team on team.id = employee.team_id
    where presence.last_home_present
      and employee.status in ('active', 'probation', 'suspended')
      and coalesce(employee.source_type, '') <> 'google_deleted'
      and nullif(public.employee_master_normalize_id(employee.employee_no), '') is not null
    order by public.employee_master_normalize_id(employee.employee_no), employee.updated_at desc nulls last, employee.id
  ), current_assignments as materialized (
    select roster.employee_no, roster.team_id, 'schedule_roster'::text assignment_source
    from matched_roster roster
    union all
    select home.employee_no, home.team_id, home.assignment_source
    from current_home_assignments home
    where not exists (
      select 1 from matched_roster roster
      where roster.employee_no = home.employee_no
    )
  ), unmatched_teams as materialized (
    select roster.team_key,
      (pg_catalog.array_agg(
        roster.team_name order by roster.source_row desc nulls last, roster.team_name
      ))[1] name,
      pg_catalog.count(distinct roster.employee_no)::integer member_count
    from roster_assignments roster
    left join canonical_teams canonical using (team_key)
    where canonical.team_id is null
    group by roster.team_key
  )
  select jsonb_build_object(
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', team.id,
        'name', team.name,
        'member_count', team.member_count
      ) order by team.name, team.id)
      from current_teams team
    ), '[]'::jsonb),
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'employee_no', assignment.employee_no,
        'team_id', assignment.team_id,
        'source', assignment.assignment_source
      ) order by assignment.employee_no)
      from current_assignments assignment
    ), '[]'::jsonb),
    'unmatched_team_names', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', unmatched.name,
        'member_count', unmatched.member_count
      ) order by unmatched.name)
      from unmatched_teams unmatched
    ), '[]'::jsonb),
    'roster_member_count', (select pg_catalog.count(*) from roster_assignments),
    'refreshed_at', (select pg_catalog.max(roster.refreshed_at) from roster_assignments roster)
  );
$$;

revoke all on function public.admin_scope_current_team_directory()
  from public, anon, authenticated;
grant execute on function public.admin_scope_current_team_directory()
  to service_role;

comment on function public.admin_scope_current_team_directory() is
  'Service-only current-team authority for backend account scopes. Team availability comes only from the current schedule roster; employee assignment uses schedule first and current home-roster presence second.';

-- Remove existing historical team grants only after proving that the durable
-- current schedule snapshot and its directory cache are complete and aligned.
-- An empty, partial or unmatched source aborts instead of mass-removing scope.
do $cleanup_stale_backend_team_scope$
declare
  v_directory jsonb;
  v_snapshot jsonb;
  v_snapshot_rows integer;
begin
  select snapshot.payload, snapshot.row_count
  into v_snapshot, v_snapshot_rows
  from public.report_sheet_snapshots snapshot
  where snapshot.source = '居家排班表/填表';

  if v_snapshot is null
     or jsonb_typeof(v_snapshot) <> 'array'
     or coalesce(v_snapshot_rows, 0) < 1
     or jsonb_array_length(v_snapshot) <> v_snapshot_rows
     or not public.report_employee_directory_cache_matches(v_snapshot) then
    raise exception 'current_schedule_team_scope_cleanup_prerequisite_failed';
  end if;

  v_directory := public.admin_scope_current_team_directory();
  if jsonb_array_length(coalesce(v_directory->'teams', '[]'::jsonb)) < 1
     or jsonb_array_length(coalesce(v_directory->'unmatched_team_names', '[]'::jsonb)) > 0 then
    raise exception 'current_schedule_team_directory_invalid';
  end if;

  delete from public.user_scope_teams scope_row
  where not exists (
    select 1
    from jsonb_array_elements(v_directory->'teams') current_team
    where (current_team->>'id')::uuid = scope_row.team_id
  );
end
$cleanup_stale_backend_team_scope$;

notify pgrst, 'reload schema';
commit;
