-- Fail closed on partial schedule snapshots and apply the same current-session
-- and employee data scope rules used by employee, attendance and training pages.

alter function public.ingest_schedule_roster_snapshot(jsonb)
  rename to ingest_schedule_roster_snapshot_internal;

revoke all on function public.ingest_schedule_roster_snapshot_internal(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.ingest_schedule_roster_snapshot(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb := p_payload->'rows';
  v_trigger_kind text := btrim(coalesce(p_payload->>'trigger_kind', ''));
  v_new_count integer := 0;
  v_new_unique_ids integer := 0;
  v_old_unique_ids integer := 0;
  v_removed_ids integer := 0;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'invalid_schedule_snapshot');
  end if;

  v_new_count := jsonb_array_length(v_rows);
  select count(distinct upper(btrim(item->>'employee_id')))::integer
  into v_new_unique_ids
  from jsonb_array_elements(v_rows) item
  where nullif(btrim(item->>'employee_id'), '') is not null;

  -- Every authoritative roster row must have one unique employee ID. This
  -- catches formula-column outages and partial reads before any table changes.
  if v_new_count < 1 or v_new_unique_ids <> v_new_count then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'schedule_employee_ids_incomplete',
      'rows', v_new_count, 'unique_employee_ids', v_new_unique_ids);
  end if;

  with old_ids as (
    select distinct upper(btrim(item->>'employee_id')) employee_id
    from public.report_sheet_snapshots s
    cross join lateral jsonb_array_elements(s.payload) item
    where s.source = '居家排班表/填表'
      and nullif(btrim(item->>'employee_id'), '') is not null
  ), new_ids as (
    select distinct upper(btrim(item->>'employee_id')) employee_id
    from jsonb_array_elements(v_rows) item
  )
  select
    (select count(*)::integer from old_ids),
    (select count(*)::integer from old_ids o
      where not exists (select 1 from new_ids n where n.employee_id=o.employee_id))
  into v_old_unique_ids, v_removed_ids;

  -- Ordinary edit/reconcile pushes may not remove over 20% (or at least 50)
  -- of the existing roster. A deliberate large restructure remains possible
  -- only through the explicit manual reconciliation action.
  if v_trigger_kind <> 'manual'
    and v_old_unique_ids >= 100
    and v_removed_ids > greatest(50, floor(v_old_unique_ids * 0.20)::integer) then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'schedule_mass_delete_guard',
      'previous_employee_ids', v_old_unique_ids,
      'new_employee_ids', v_new_unique_ids,
      'removed_employee_ids', v_removed_ids);
  end if;

  return public.ingest_schedule_roster_snapshot_internal(p_payload);
end;
$$;

revoke all on function public.ingest_schedule_roster_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_schedule_roster_snapshot(jsonb)
  to service_role;

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
  v_work_mode text := lower(btrim(coalesce(
    p_filters->>'work_mode', p_filters->>'source_group', '')));
  v_base jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('schedule.view') then raise exception 'permission_denied'; end if;
  if v_work_mode <> '' and v_work_mode not in ('home', 'onsite_to_home') then
    raise exception 'invalid_work_mode';
  end if;

  select ua.data_scope, ua.employee_id, e.employee_no, e.team_id, t.name
  into v_access_scope, v_current_employee, v_current_employee_no,
    v_current_team, v_current_team_name
  from public.user_access ua
  left join public.employees e on e.id=ua.employee_id
  left join public.teams t on t.id=e.team_id
  where ua.auth_user_id=v_user_id and ua.active=true and ua.backend_enabled=true
  order by ua.updated_at desc limit 1;
  v_all := public.is_founder() or v_access_scope='all';

  -- Work mode is a semantic grouping, not a literal employment_type value.
  v_base := attendance_private.admin_attendance_schedule(
    p_filters - 'work_mode' - 'source_group' - 'employment_type'
  );

  with source_rows as materialized (
    select item, ordinal
    from jsonb_array_elements(coalesce(v_base->'rows', '[]'::jsonb))
      with ordinality r(item, ordinal)
  ), identified as materialized (
    select r.item, r.ordinal, e.id employee_id, e.team_id,
      coalesce(t.name, r.item->>'team_name') team_name,
      upper(btrim(coalesce(e.employee_no, r.item->>'employee_no', ''))) employee_no
    from source_rows r
    left join public.employees e on
      e.id::text = nullif(r.item->>'employee_id', '')
      or upper(btrim(e.employee_no)) = upper(btrim(r.item->>'employee_no'))
    left join public.teams t on t.id=e.team_id
  ), allowed as materialized (
    select i.*
    from identified i
    where (
      v_all
      or i.employee_id=v_current_employee
      or (v_current_employee_no is not null
        and i.employee_no=upper(btrim(v_current_employee_no)))
      or (v_access_scope='own_team' and (
        i.team_id=v_current_team
        or (i.employee_id is null
          and public.exam_norm(i.team_name)=public.exam_norm(v_current_team_name))
      ))
      or (v_access_scope='assigned_teams' and (
        exists(select 1 from public.user_scope_employees se
          where se.auth_user_id=v_user_id and se.employee_id=i.employee_id)
        or exists(select 1 from public.user_scope_teams st
          where st.auth_user_id=v_user_id and st.team_id=i.team_id)
        or exists(select 1 from public.user_scope_teams st
          join public.teams stt on stt.id=st.team_id
          where st.auth_user_id=v_user_id
            and public.exam_norm(stt.name)=public.exam_norm(i.team_name))
      ))
    )
  ), mode_filtered as materialized (
    select a.*
    from allowed a
    where v_work_mode=''
      or (v_work_mode='onsite_to_home' and (
        lower(coalesce(a.item->>'employment_type', ''))='onsite_to_home'
        or public.exam_norm(a.item->>'employment_type') like '%现场转居家%'))
      or (v_work_mode='home' and not (
        lower(coalesce(a.item->>'employment_type', ''))='onsite_to_home'
        or public.exam_norm(a.item->>'employment_type') like '%现场转居家%'))
  )
  select coalesce(jsonb_agg(m.item order by m.ordinal), '[]'::jsonb)
  into v_rows from mode_filtered m;

  select v_base || jsonb_build_object(
    'total', jsonb_array_length(v_rows),
    'directory_total', jsonb_array_length(v_rows),
    'refreshed_at', (
      select max(nullif(item->>'refreshed_at', '')::timestamptz)
      from jsonb_array_elements(v_rows) item
    ),
    'summary', (
      select jsonb_build_object(
        'total', count(*),
        'day', count(*) filter(where item->>'shift_bucket'='day'),
        'mid', count(*) filter(where item->>'shift_bucket'='mid'),
        'night', count(*) filter(where item->>'shift_bucket'='night'),
        'other', count(*) filter(where coalesce(item->>'shift_bucket','other')='other'),
        'teams', count(distinct item->>'team_name')
          filter(where nullif(btrim(item->>'team_name'),'') is not null),
        'matched', count(*) filter(where coalesce((item->>'employee_matched')::boolean,false)),
        'unmatched', count(*) filter(where not coalesce((item->>'employee_matched')::boolean,false)),
        'active', count(*) filter(where lower(item->>'employee_status')='active'),
        'resigned', count(*) filter(where lower(item->>'employee_status')='resigned')
      ) from jsonb_array_elements(v_rows) item
    ),
    'options', jsonb_build_object(
      'teams', (select coalesce(jsonb_agg(v order by v),'[]'::jsonb)
        from (select distinct item->>'team_name' v from jsonb_array_elements(v_rows) item
          where nullif(btrim(item->>'team_name'),'') is not null) q),
      'groups', (select coalesce(jsonb_agg(v order by v),'[]'::jsonb)
        from (select distinct item->>'group_name' v from jsonb_array_elements(v_rows) item
          where nullif(btrim(item->>'group_name'),'') is not null) q),
      'shifts', (select coalesce(jsonb_agg(v order by v),'[]'::jsonb)
        from (select distinct item->>'shift_raw' v from jsonb_array_elements(v_rows) item
          where nullif(btrim(item->>'shift_raw'),'') is not null) q),
      'positions', (select coalesce(jsonb_agg(v order by v),'[]'::jsonb)
        from (select distinct item->>'position_name' v from jsonb_array_elements(v_rows) item
          where nullif(btrim(item->>'position_name'),'') is not null) q),
      'countries', (select coalesce(jsonb_agg(v order by v),'[]'::jsonb)
        from (select distinct item->>'country_name' v from jsonb_array_elements(v_rows) item
          where nullif(btrim(item->>'country_name'),'') is not null) q),
      'platforms', (select coalesce(jsonb_agg(v order by v),'[]'::jsonb)
        from (select distinct item->>'platform_name' v from jsonb_array_elements(v_rows) item
          where nullif(btrim(item->>'platform_name'),'') is not null) q),
      'employee_statuses', (select coalesce(jsonb_agg(v order by v),'[]'::jsonb)
        from (select distinct item->>'employee_status' v from jsonb_array_elements(v_rows) item
          where nullif(btrim(item->>'employee_status'),'') is not null) q),
      'employment_types', (select coalesce(jsonb_agg(v order by v),'[]'::jsonb)
        from (select distinct item->>'employment_type' v from jsonb_array_elements(v_rows) item
          where nullif(btrim(item->>'employment_type'),'') is not null) q),
      'managers', (select coalesce(jsonb_agg(v order by v),'[]'::jsonb)
        from (select distinct item->>'responsible' v from jsonb_array_elements(v_rows) item
          where nullif(btrim(item->>'responsible'),'') is not null) q),
      'work_modes', jsonb_build_array('home','onsite_to_home')
    ),
    'rows', v_rows
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function attendance_private.admin_attendance_schedule(jsonb)
  from public, anon, authenticated;
revoke all on function public.admin_attendance_schedule(jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_attendance_schedule(jsonb)
  to authenticated;

comment on function public.admin_attendance_schedule(jsonb) is
  'Current-session and employee-scope checked schedule roster; work mode is filtered semantically.';

notify pgrst, 'reload schema';
