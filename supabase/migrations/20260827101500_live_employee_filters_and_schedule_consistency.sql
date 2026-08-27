begin;

-- One covering lookup supports the only employee join made by the new roster
-- query.  The older RPC expanded/re-aggregated JSON twice and used an OR join;
-- this implementation reads the authoritative snapshot once and performs one
-- normalized employee-number join.
create index if not exists employees_schedule_employee_no_lookup_idx
  on public.employees (public.employee_master_normalize_id(employee_no))
  include (id, team_id, hire_date, status, employment_type)
  where nullif(btrim(employee_no), '') is not null;

-- Reports already count the private roster with this identity rule: employee
-- ID first and normalized name only while the ID cell is empty.  Keeping this
-- projection in one private helper makes schedule rows and diagnostics use the
-- same exact source/identity set as the report overview.
create or replace function attendance_private.current_schedule_roster()
returns table (
  identity_key text,
  source_row integer,
  employee_no text,
  full_name text,
  team_name text,
  group_name text,
  position_name text,
  country_name text,
  shift_raw text,
  platform_name text,
  responsible text,
  onsite_trainer text,
  online_leader text,
  online_trainer text,
  work_content text,
  refreshed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with normalized as (
    select
      case
        when nullif(public.employee_master_normalize_id(item->>'employee_id'), '') is not null
          then 'id:' || public.employee_master_normalize_id(item->>'employee_id')
        else 'name:' || lower(regexp_replace(translate(
          normalize(btrim(item->>'name'), NFKC),
          U&'\200B\200C\200D\2060\FEFF', ''
        ), '[[:space:]]+', ' ', 'g'))
      end identity_key,
      case when coalesce(item->>'source_row', '') ~ '^\d+$'
        then (item->>'source_row')::integer end source_row,
      nullif(public.employee_master_normalize_id(item->>'employee_id'), '') employee_no,
      nullif(btrim(item->>'name'), '') full_name,
      nullif(btrim(item->>'team'), '') team_name,
      nullif(btrim(item->>'group'), '') group_name,
      nullif(btrim(item->>'position'), '') position_name,
      nullif(btrim(item->>'country'), '') country_name,
      nullif(btrim(item->>'shift'), '') shift_raw,
      nullif(btrim(item->>'platform'), '') platform_name,
      nullif(btrim(item->>'responsible'), '') responsible,
      nullif(btrim(item->>'onsite_trainer'), '') onsite_trainer,
      nullif(btrim(item->>'online_leader'), '') online_leader,
      nullif(btrim(item->>'online_trainer'), '') online_trainer,
      nullif(btrim(item->>'work_content'), '') work_content,
      snapshot.synced_at refreshed_at
    from public.report_sheet_snapshots snapshot
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(snapshot.payload) = 'array'
        then snapshot.payload else '[]'::jsonb end
    ) item
    where snapshot.source = '居家排班表/填表'
      and nullif(btrim(item->>'name'), '') is not null
      and lower(btrim(item->>'name')) !~
        '(正在加载|loading|^#(ref!|n/a|value!|error!))'
  )
  select distinct on (normalized.identity_key)
    normalized.identity_key,
    normalized.source_row,
    normalized.employee_no,
    normalized.full_name,
    normalized.team_name,
    normalized.group_name,
    normalized.position_name,
    normalized.country_name,
    normalized.shift_raw,
    normalized.platform_name,
    normalized.responsible,
    normalized.onsite_trainer,
    normalized.online_leader,
    normalized.online_trainer,
    normalized.work_content,
    normalized.refreshed_at
  from normalized
  order by normalized.identity_key, normalized.source_row desc nulls last;
$$;

revoke all on function attendance_private.current_schedule_roster()
  from public, anon, authenticated;

-- Replace the nested base -> JSON -> scoped JSON -> detailed JSON pipeline
-- with one relational pipeline.  Filters, scope, counts, options and rows now
-- share a single materialized authorized set, which removes the statement
-- timeout hotspot while preserving the response contract used by React.
create or replace function public.admin_attendance_schedule(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_access_scope text;
  v_current_employee uuid;
  v_current_employee_no text;
  v_current_team uuid;
  v_current_team_name text;
  v_all boolean := false;
  v_search text := lower(btrim(coalesce(p_filters->>'search', '')));
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no', '')));
  v_employee_name text := lower(btrim(coalesce(
    p_filters->>'employee_name', p_filters->>'full_name', '')));
  v_team text := btrim(coalesce(p_filters->>'team', ''));
  v_group text := btrim(coalesce(p_filters->>'group', p_filters->>'group_name', ''));
  v_position text := btrim(coalesce(p_filters->>'position', ''));
  v_shift text := btrim(coalesce(p_filters->>'shift', p_filters->>'shift_raw', ''));
  v_shift_bucket text := lower(btrim(coalesce(p_filters->>'shift_bucket', '')));
  v_country text := btrim(coalesce(p_filters->>'country', ''));
  v_platform text := btrim(coalesce(p_filters->>'platform', ''));
  v_manager text := lower(btrim(coalesce(
    p_filters->>'manager', p_filters->>'responsible', '')));
  v_employee_status text := lower(btrim(coalesce(p_filters->>'employee_status', '')));
  v_work_mode text := lower(btrim(coalesce(
    p_filters->>'work_mode', p_filters->>'source_group', '')));
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('schedule.view') then
    raise exception 'permission_denied';
  end if;
  if v_work_mode <> '' and v_work_mode not in ('home', 'onsite_to_home') then
    raise exception 'invalid_work_mode';
  end if;
  if v_shift_bucket <> '' and v_shift_bucket not in ('day', 'mid', 'night', 'other') then
    raise exception 'invalid_shift_bucket';
  end if;

  select access.data_scope, access.employee_id, employee.employee_no,
    employee.team_id, team.name
  into v_access_scope, v_current_employee, v_current_employee_no,
    v_current_team, v_current_team_name
  from public.user_access access
  left join public.employees employee on employee.id = access.employee_id
  left join public.teams team on team.id = employee.team_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if v_access_scope is null then raise exception 'permission_denied'; end if;
  v_all := public.is_founder() or v_access_scope = 'all';

  with source_rows as materialized (
    select * from attendance_private.current_schedule_roster()
  ), source_quality as materialized (
    select
      count(*)::integer current_count,
      greatest(
        count(*)::integer,
        coalesce((
          select max(run.schedule_roster_row_count)
          from public.employee_master_sync_runs run
          where run.status in ('success', 'unchanged')
            and run.captured_at >= clock_timestamp() - interval '7 days'
        ), 0)
      )::integer recent_good_peak
    from source_rows
  ), joined as materialized (
    select
      roster.*,
      employee.id employee_id,
      employee.team_id employee_team_id,
      employee.hire_date,
      coalesce(nullif(btrim(employee.status), ''), 'unmatched') employee_status,
      nullif(btrim(employee.employment_type), '') employment_type,
      employee.id is not null employee_matched,
      team.name employee_team_name
    from source_rows roster
    left join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no) = roster.employee_no
    left join public.teams team on team.id = employee.team_id
  ), classified as materialized (
    select
      joined.*,
      case
        when lower(coalesce(joined.shift_raw, '')) like '%白班%'
          or lower(coalesce(joined.shift_raw, '')) like '%day%' then 'day'
        when lower(coalesce(joined.shift_raw, '')) like '%中班%'
          or lower(coalesce(joined.shift_raw, '')) like '%mid%' then 'mid'
        when lower(coalesce(joined.shift_raw, '')) like '%夜班%'
          or lower(coalesce(joined.shift_raw, '')) like '%night%' then 'night'
        else 'other'
      end shift_bucket,
      regexp_match(coalesce(joined.shift_raw, ''),
        '([0-9]{1,2})[[:space:]]*[:：][[:space:]]*([0-5][0-9])') colon_time_parts,
      regexp_match(coalesce(joined.shift_raw, ''),
        '([0-9]{1,2})[[:space:]]*[点時时]') hour_time_parts
    from joined
  ), display_rows as materialized (
    select
      classified.*,
      case
        when classified.shift_bucket <> 'mid' then null
        when classified.colon_time_parts is not null
          and (classified.colon_time_parts)[1]::integer between 0 and 23
          then lpad((classified.colon_time_parts)[1], 2, '0')
            || ':' || (classified.colon_time_parts)[2]
        when classified.hour_time_parts is not null
          and (classified.hour_time_parts)[1]::integer between 0 and 23
          then lpad((classified.hour_time_parts)[1], 2, '0') || ':00'
        else null
      end shift_time
    from classified
  ), presented as materialized (
    select
      display_rows.*,
      case
        when display_rows.shift_bucket = 'mid' and display_rows.shift_time is not null
          then '中班 · ' || display_rows.shift_time
        when display_rows.shift_bucket = 'mid' then '中班'
        when display_rows.shift_bucket = 'day' then '白班'
        when display_rows.shift_bucket = 'night' then '夜班'
        else coalesce(display_rows.shift_raw, '未填写班次')
      end shift_display,
      case display_rows.shift_bucket
        when 'day' then 1 when 'mid' then 2 when 'night' then 3 else 4
      end shift_sort
    from display_rows
  ), scoped as materialized (
    select presented.*
    from presented
    where (
      v_all
      or presented.employee_id = v_current_employee
      or (nullif(btrim(v_current_employee_no), '') is not null
        and presented.employee_no = public.employee_master_normalize_id(v_current_employee_no))
      or (v_access_scope = 'own_team' and (
        presented.employee_team_id = v_current_team
        or (presented.employee_id is null
          and public.exam_norm(presented.team_name) = public.exam_norm(v_current_team_name))
      ))
      or (v_access_scope = 'assigned_teams' and (
        exists (
          select 1 from public.user_scope_employees employee_scope
          where employee_scope.auth_user_id = v_user_id
            and employee_scope.employee_id = presented.employee_id
        )
        or exists (
          select 1 from public.user_scope_teams team_scope
          where team_scope.auth_user_id = v_user_id
            and team_scope.team_id = presented.employee_team_id
        )
        or (presented.employee_id is null and exists (
          select 1
          from public.user_scope_teams team_scope
          join public.teams scoped_team on scoped_team.id = team_scope.team_id
          where team_scope.auth_user_id = v_user_id
            and public.exam_norm(scoped_team.name) = public.exam_norm(presented.team_name)
        ))
      ))
    )
    and (
      v_work_mode = ''
      or (v_work_mode = 'onsite_to_home' and (
        lower(coalesce(presented.employment_type, '')) = 'onsite_to_home'
        or public.exam_norm(presented.employment_type) like '%现场转居家%'
      ))
      or (v_work_mode = 'home' and not (
        lower(coalesce(presented.employment_type, '')) = 'onsite_to_home'
        or public.exam_norm(presented.employment_type) like '%现场转居家%'
      ))
    )
  ), filtered as materialized (
    select scoped.*
    from scoped
    where (v_employee_no = ''
        or lower(coalesce(scoped.employee_no, '')) like '%' || v_employee_no || '%')
      and (v_employee_name = ''
        or lower(coalesce(scoped.full_name, '')) like '%' || v_employee_name || '%')
      and (v_search = '' or position(v_search in lower(concat_ws(' ',
        scoped.employee_no, scoped.full_name, scoped.team_name, scoped.group_name,
        scoped.position_name, scoped.country_name, scoped.shift_raw,
        scoped.shift_display, scoped.platform_name, scoped.responsible,
        scoped.onsite_trainer, scoped.online_leader, scoped.online_trainer,
        scoped.employee_status, scoped.employment_type
      ))) > 0)
      and (v_team = '' or public.exam_norm(scoped.team_name) = public.exam_norm(v_team))
      and (v_group = '' or public.exam_norm(scoped.group_name) = public.exam_norm(v_group))
      and (v_position = '' or public.exam_norm(scoped.position_name) = public.exam_norm(v_position))
      and (v_shift = ''
        or public.exam_norm(scoped.shift_raw) = public.exam_norm(v_shift)
        or public.exam_norm(scoped.shift_display) = public.exam_norm(v_shift))
      and (v_shift_bucket = '' or scoped.shift_bucket = v_shift_bucket)
      and (v_country = '' or public.exam_norm(scoped.country_name) = public.exam_norm(v_country))
      and (v_platform = '' or public.exam_norm(scoped.platform_name) = public.exam_norm(v_platform))
      and (v_manager = '' or lower(concat_ws(' ', scoped.responsible,
        scoped.onsite_trainer, scoped.online_leader, scoped.online_trainer
      )) like '%' || v_manager || '%')
      and (v_employee_status = '' or lower(scoped.employee_status) = v_employee_status)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'directory_total', (select count(*) from scoped),
    'refreshed_at', (select max(scoped.refreshed_at) from scoped),
    'source_quality', (
      select jsonb_build_object(
        'current_count', quality.current_count,
        'recent_good_peak', quality.recent_good_peak,
        'healthy', quality.recent_good_peak = 0
          or quality.current_count * 100 >= quality.recent_good_peak * 95
      )
      from source_quality quality
    ),
    'summary', (
      select jsonb_build_object(
        'total', count(*),
        'day', count(*) filter (where filtered.shift_bucket = 'day'),
        'mid', count(*) filter (where filtered.shift_bucket = 'mid'),
        'night', count(*) filter (where filtered.shift_bucket = 'night'),
        'other', count(*) filter (where filtered.shift_bucket = 'other'),
        'teams', count(distinct filtered.team_name)
          filter (where nullif(btrim(filtered.team_name), '') is not null),
        'groups', count(distinct filtered.group_name)
          filter (where nullif(btrim(filtered.group_name), '') is not null),
        'matched', count(*) filter (where filtered.employee_matched),
        'unmatched', count(*) filter (where not filtered.employee_matched),
        'active', count(*) filter (where lower(filtered.employee_status) = 'active'),
        'resigned', count(*) filter (where lower(filtered.employee_status) = 'resigned')
      ) from filtered
    ),
    'identity_issues', jsonb_build_object(
      'missing_employee_id', coalesce((
        select jsonb_agg(jsonb_build_object(
          'identity_key', scoped.identity_key,
          'source_row', scoped.source_row,
          'full_name', scoped.full_name,
          'team_name', scoped.team_name,
          'group_name', scoped.group_name,
          'shift_raw', scoped.shift_raw
        ) order by scoped.source_row nulls last, scoped.identity_key)
        from scoped
        where scoped.employee_no is null
      ), '[]'::jsonb),
      'unmatched_employee', coalesce((
        select jsonb_agg(jsonb_build_object(
          'identity_key', scoped.identity_key,
          'source_row', scoped.source_row,
          'employee_no', scoped.employee_no,
          'full_name', scoped.full_name,
          'team_name', scoped.team_name
        ) order by scoped.source_row nulls last, scoped.identity_key)
        from scoped
        where not scoped.employee_matched
      ), '[]'::jsonb)
    ),
    'options', jsonb_build_object(
      'teams', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        from (select distinct team_name value from scoped
          where nullif(btrim(team_name), '') is not null) option_rows),
      'groups', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        from (select distinct group_name value from scoped
          where nullif(btrim(group_name), '') is not null) option_rows),
      'positions', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        from (select distinct position_name value from scoped
          where nullif(btrim(position_name), '') is not null) option_rows),
      'shifts', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        from (select distinct shift_raw value from scoped
          where nullif(btrim(shift_raw), '') is not null) option_rows),
      'countries', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        from (select distinct country_name value from scoped
          where nullif(btrim(country_name), '') is not null) option_rows),
      'platforms', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        from (select distinct platform_name value from scoped
          where nullif(btrim(platform_name), '') is not null) option_rows),
      'employee_statuses', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        from (select distinct employee_status value from scoped
          where nullif(btrim(employee_status), '') is not null) option_rows),
      'employment_types', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        from (select distinct employment_type value from scoped
          where nullif(btrim(employment_type), '') is not null) option_rows),
      'managers', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        from (
          select distinct manager_value value
          from scoped
          cross join lateral unnest(array[
            scoped.responsible, scoped.onsite_trainer,
            scoped.online_leader, scoped.online_trainer
          ]) manager_value
          where nullif(btrim(manager_value), '') is not null
        ) option_rows),
      'shift_buckets', jsonb_build_array('day', 'mid', 'night', 'other'),
      'work_modes', jsonb_build_array('home', 'onsite_to_home')
    ),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'identity_key', filtered.identity_key,
        'employee_id', filtered.employee_id,
        'employee_no', filtered.employee_no,
        'full_name', filtered.full_name,
        'hire_date', filtered.hire_date,
        'employee_status', filtered.employee_status,
        'employment_type', filtered.employment_type,
        'employee_matched', filtered.employee_matched,
        'team_name', filtered.team_name,
        'group_name', filtered.group_name,
        'position_name', filtered.position_name,
        'country_name', filtered.country_name,
        'shift_raw', filtered.shift_raw,
        'shift_bucket', filtered.shift_bucket,
        'shift_time', filtered.shift_time,
        'shift_display', filtered.shift_display,
        'platform_name', filtered.platform_name,
        'responsible', filtered.responsible,
        'onsite_trainer', filtered.onsite_trainer,
        'online_leader', filtered.online_leader,
        'online_trainer', filtered.online_trainer,
        'source_row', filtered.source_row,
        'refreshed_at', filtered.refreshed_at
      ) order by filtered.source_row nulls last, filtered.identity_key)
      from filtered
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_attendance_schedule(jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_attendance_schedule(jsonb)
  to authenticated;

comment on function public.admin_attendance_schedule(jsonb) is
  'Single-pass, current-session/data-scope checked schedule query over the authoritative roster identity set.';

-- This service-only diagnostic makes a count discrepancy actionable in one
-- call: it lists the exact source row/name/ID present only in the authoritative
-- report snapshot or only in the legacy ID-backed directory cache.
create or replace function public.schedule_roster_identity_diagnostics()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with expected as materialized (
    select * from attendance_private.current_schedule_roster()
  ), cached as materialized (
    select
      'id:' || public.employee_master_normalize_id(cache.employee_no) identity_key,
      cache.source_row,
      cache.employee_no,
      cache.full_name
    from public.report_employee_directory_cache cache
    where cache.source_kind = 'roster'
      and nullif(public.employee_master_normalize_id(cache.employee_no), '') is not null
  ), only_expected as materialized (
    select expected.*
    from expected
    left join cached using (identity_key)
    where cached.identity_key is null
  ), only_cached as materialized (
    select cached.*
    from cached
    left join expected using (identity_key)
    where expected.identity_key is null
  )
  select jsonb_build_object(
    'snapshot_identity_total', (select count(*) from expected),
    'report_overview_people', (select count(*) from expected),
    'schedule_expected_people', (select count(*) from expected),
    'legacy_directory_total', (select count(*) from cached),
    'legacy_directory_delta',
      (select count(*) from expected) - (select count(*) from cached),
    'only_in_snapshot', coalesce((
      select jsonb_agg(jsonb_build_object(
        'identity_key', row.identity_key,
        'source_row', row.source_row,
        'employee_no', row.employee_no,
        'full_name', row.full_name,
        'reason', case when row.employee_no is null
          then 'missing_employee_id' else 'missing_from_legacy_directory' end
      ) order by row.source_row nulls last, row.identity_key)
      from only_expected row
    ), '[]'::jsonb),
    'only_in_legacy_directory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'identity_key', row.identity_key,
        'source_row', row.source_row,
        'employee_no', row.employee_no,
        'full_name', row.full_name,
        'reason', 'not_in_authoritative_snapshot'
      ) order by row.source_row nulls last, row.identity_key)
      from only_cached row
    ), '[]'::jsonb),
    'aligned', not exists (select 1 from only_expected)
      and not exists (select 1 from only_cached)
  );
$$;

revoke all on function public.schedule_roster_identity_diagnostics()
  from public, anon, authenticated;
grant execute on function public.schedule_roster_identity_diagnostics()
  to service_role;

-- A:M columns are already normalized to these four role fields by both Edge
-- parsers.  Keep every detailed field and also maintain the two legacy summary
-- columns rendered by the employee archive.  Online role wins for the summary
-- when both online and onsite values are present; no stale value survives an
-- intentionally cleared source cell.
create or replace function public.sync_schedule_employee_assignments(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_schedule_assignment_rows';
  end if;

  with assignments as materialized (
    select distinct on (public.employee_master_normalize_id(item->>'employee_id'))
      public.employee_master_normalize_id(item->>'employee_id') employee_no,
      nullif(btrim(item->>'responsible'), '') responsible,
      nullif(btrim(item->>'onsite_trainer'), '') onsite_trainer,
      nullif(btrim(item->>'online_leader'), '') online_leader,
      nullif(btrim(item->>'online_trainer'), '') online_trainer
    from jsonb_array_elements(p_rows) item
    where nullif(public.employee_master_normalize_id(item->>'employee_id'), '') is not null
    order by public.employee_master_normalize_id(item->>'employee_id'),
      case when coalesce(item->>'source_row', '') ~ '^\d+$'
        then (item->>'source_row')::integer end desc nulls last
  ), desired as materialized (
    select
      assignments.*,
      coalesce(assignments.online_leader, assignments.responsible) leader_name,
      coalesce(assignments.online_trainer, assignments.onsite_trainer) trainer_name
    from assignments
  )
  update public.employees employee
  set person_in_charge = desired.responsible,
      on_site_trainer = desired.onsite_trainer,
      online_leader = desired.online_leader,
      online_trainer = desired.online_trainer,
      leader_name = desired.leader_name,
      trainer_name = desired.trainer_name,
      updated_at = clock_timestamp()
  from desired
  where public.employee_master_normalize_id(employee.employee_no) = desired.employee_no
    and employee.status in ('active', 'probation', 'suspended')
    and coalesce(employee.source_type, '') <> 'google_deleted'
    and row(
      employee.person_in_charge, employee.on_site_trainer,
      employee.online_leader, employee.online_trainer,
      employee.leader_name, employee.trainer_name
    ) is distinct from row(
      desired.responsible, desired.onsite_trainer,
      desired.online_leader, desired.online_trainer,
      desired.leader_name, desired.trainer_name
    );
  get diagnostics v_updated = row_count;

  return jsonb_build_object('updated', v_updated);
end;
$$;

revoke all on function public.sync_schedule_employee_assignments(jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_schedule_employee_assignments(jsonb)
  to service_role;

-- Preserve the complete existing validation/removal guard as a private stage,
-- then add assignment propagation only after that stage accepted the snapshot.
alter function public.ingest_schedule_roster_snapshot(jsonb)
  rename to ingest_schedule_roster_snapshot_guarded_v1;
revoke all on function public.ingest_schedule_roster_snapshot_guarded_v1(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.ingest_schedule_roster_snapshot(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_assignment_result jsonb := jsonb_build_object('updated', 0);
begin
  v_result := public.ingest_schedule_roster_snapshot_guarded_v1(p_payload);
  if coalesce((v_result->>'ok')::boolean, false) then
    v_assignment_result := public.sync_schedule_employee_assignments(p_payload->'rows');
  end if;
  return v_result || jsonb_build_object(
    'employee_assignments_updated', coalesce((v_assignment_result->>'updated')::integer, 0)
  );
end;
$$;

revoke all on function public.ingest_schedule_roster_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_schedule_roster_snapshot(jsonb)
  to service_role;

create or replace function public.refresh_schedule_assignments_after_master_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if new.status <> 'success' then return new; end if;
  select snapshot.payload into v_payload
  from public.employee_master_source_snapshots snapshot
  where snapshot.source_key = 'home_schedule_roster_current'
    and snapshot.run_id = new.id;
  if v_payload is not null and jsonb_typeof(v_payload) = 'array' then
    perform public.sync_schedule_employee_assignments(v_payload);
  end if;
  return new;
end;
$$;

revoke all on function public.refresh_schedule_assignments_after_master_sync()
  from public, anon, authenticated, service_role;

drop trigger if exists employee_master_refresh_schedule_assignments
  on public.employee_master_sync_runs;
create trigger employee_master_refresh_schedule_assignments
after update of status on public.employee_master_sync_runs
for each row
when (new.status = 'success')
execute function public.refresh_schedule_assignments_after_master_sync();

-- Repair current employee assignment summaries (including CS000441 from its
-- current online leader/trainer fields) when the migration is applied; an absent source
-- is a no-op and cannot block deployment.
do $$
declare
  v_payload jsonb;
  v_synced_at timestamptz;
  v_schedule_count integer := 0;
  v_recent_good_peak integer := 0;
  v_loading_rows integer := 0;
  v_missing_id_rows integer := 0;
begin
  select snapshot.payload, snapshot.synced_at into v_payload, v_synced_at
  from public.report_sheet_snapshots snapshot
  where snapshot.source = '居家排班表/填表'
  order by snapshot.synced_at desc
  limit 1;
  if v_payload is not null and jsonb_typeof(v_payload) = 'array' then
    v_schedule_count := jsonb_array_length(v_payload);
    select
      count(*) filter (where lower(btrim(coalesce(item->>'name', ''))) ~
        '(正在加载|loading|^#(ref!|n/a|value!|error!))'),
      count(*) filter (where nullif(public.employee_master_normalize_id(item->>'employee_id'), '') is null)
    into v_loading_rows, v_missing_id_rows
    from jsonb_array_elements(v_payload) item;
  end if;
  select coalesce(max(run.schedule_roster_row_count), 0)
  into v_recent_good_peak
  from public.employee_master_sync_runs run
  where run.status in ('success', 'unchanged')
    and run.captured_at >= clock_timestamp() - interval '7 days';
  -- Never let deployment replay an old cached roster over newer employee
  -- assignments or accept a transient Google formula/loading state. A later
  -- accepted complete sync invokes the same propagation path.
  if v_payload is not null
    and jsonb_typeof(v_payload) = 'array'
    and v_synced_at >= clock_timestamp() - interval '24 hours'
    and v_loading_rows = 0
    and v_missing_id_rows <= greatest(5, floor(v_schedule_count * 0.01)::integer)
    and (v_recent_good_peak = 0
      or v_schedule_count * 100 >= v_recent_good_peak * 95) then
    perform public.sync_schedule_employee_assignments(v_payload);
  end if;
end;
$$;

comment on function public.sync_schedule_employee_assignments(jsonb) is
  'Propagates current Google schedule responsible/trainer/leader fields to matched current employee profiles.';
comment on function public.schedule_roster_identity_diagnostics() is
  'Service-only set difference between the authoritative report roster identity set and the legacy ID-only cache.';

notify pgrst, 'reload schema';

commit;
