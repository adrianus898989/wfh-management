begin;

-- These are small indexes, but production API traffic always wins the lock.
-- A busy database rolls the whole migration back instead of queuing DDL.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $guard$
declare
  v_search text := pg_catalog.pg_get_functiondef(
    'public.admin_exam_sessions_search_v3(text,text,text,text,text,text,text,text,date,date,integer,integer)'::regprocedure
  );
  v_filters text := pg_catalog.pg_get_functiondef(
    'public.admin_exam_filter_options()'::regprocedure
  );
begin
  if pg_catalog.strpos(v_search, 'session_private.exam_employee_in_scope(u.employee_id)') = 0
     or pg_catalog.strpos(v_search, 'session_private.current_app_session_is_valid(''admin'')') = 0
     or pg_catalog.strpos(v_search, 'public.admin_exam_combined_sessions_v u') = 0
     or pg_catalog.strpos(v_search, 'public.has_permission(''exam.records.view'')') = 0
     or pg_catalog.strpos(v_search, 'public.has_permission(''exam.grading.view'')') = 0 then
    raise exception 'exam_search_per_row_scope_prerequisite_changed';
  end if;
  if pg_catalog.length(v_filters) - pg_catalog.length(pg_catalog.replace(
       v_filters, 'session_private.exam_employee_in_scope(u.employee_id)', ''
     )) <> 2 * pg_catalog.length('session_private.exam_employee_in_scope(u.employee_id)')
     or pg_catalog.strpos(v_filters, 'public.admin_exam_combined_sessions_v u') = 0 then
    raise exception 'exam_filter_per_row_scope_prerequisite_changed';
  end if;
end;
$guard$;

-- Default records/grading screens query a bounded date interval.  The old
-- `::date` predicate forced a scan of every wide legacy row; retain the same
-- session-time-zone day semantics below with half-open timestamptz ranges.
create index if not exists exam_sessions_admin_activity_idx
  on public.exam_sessions (
    (coalesce(submitted_at, started_at)) desc,
    employee_id,
    status
  );
create index if not exists legacy_exam_sessions_admin_activity_idx
  on public.legacy_exam_sessions (
    (coalesce(submitted_at, started_at)) desc,
    employee_id,
    status
  );

-- Filter options need only the linked employee plus the legacy position; do
-- not read the wide legacy payload columns or aggregate answer rows.
create index if not exists legacy_exam_sessions_filter_options_idx
  on public.legacy_exam_sessions (employee_id)
  include (position_name);

create or replace function public.admin_exam_sessions_search_v3(
  p_employee_no text default '',
  p_employee_name text default '',
  p_exam text default '',
  p_team text default '',
  p_position text default '',
  p_status text default '',
  p_grader text default '',
  p_source text default '',
  p_date_from date default null,
  p_date_to date default null,
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
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_scope text := '';
  v_caller_employee_id uuid;
  v_role_code text := '';
  v_all boolean := false;
  v_result jsonb;
begin
  if not (
    public.has_permission('exam.records.view')
    or public.has_permission('exam.grading.view')
  ) then
    raise exception '没有考试查看权限';
  end if;
  if v_user_id is null
     or not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  select access.data_scope, access.employee_id, role.code
  into v_scope, v_caller_employee_id, v_role_code
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
    and role.active = true
  order by access.updated_at desc
  limit 1;
  if not found then raise exception 'session_not_current'; end if;
  v_all := v_role_code = 'founder' or v_scope = 'all';

  with filtered as materialized (
    select u.*
    from public.admin_exam_combined_sessions_v u
    where (
        v_all
        or (
          u.employee_id is not null
          and (
            (v_scope = 'self' and u.employee_id = v_caller_employee_id)
            or (
              v_scope in ('own_team', 'assigned_teams')
              and exists (
                select 1
                from public.user_scope_employees effective
                where effective.auth_user_id = v_user_id
                  and effective.employee_id = u.employee_id
              )
            )
          )
        )
      )
      and (btrim(coalesce(p_employee_no, '')) = ''
        or u.employee_no ilike '%' || btrim(p_employee_no) || '%')
      and (btrim(coalesce(p_employee_name, '')) = ''
        or u.employee_name ilike '%' || btrim(p_employee_name) || '%')
      and (btrim(coalesce(p_exam, '')) = ''
        or u.title ilike '%' || btrim(p_exam) || '%')
      and (btrim(coalesce(p_team, '')) = ''
        or public.exam_norm(u.team_name) = public.exam_norm(p_team))
      and (btrim(coalesce(p_position, '')) = ''
        or public.exam_norm(u.position_name) = public.exam_norm(p_position))
      and (
        btrim(coalesce(p_status, '')) = ''
        or (p_status = 'pending' and u.status in ('submitted', 'grading'))
        or u.status = p_status
      )
      and (btrim(coalesce(p_grader, '')) = ''
        or u.grader_name ilike '%' || btrim(p_grader) || '%')
      and (
        btrim(coalesce(p_source, '')) = ''
        or p_source = 'all'
        or u.source_system = p_source
      )
      and (
        p_date_from is null
        or coalesce(u.submitted_at, u.started_at) >= p_date_from::timestamptz
      )
      and (
        p_date_to is null
        or coalesce(u.submitted_at, u.started_at) < (p_date_to + 1)::timestamptz
      )
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(to_jsonb(page_row) - 'sort_at' order by page_row.sort_at desc)
      from (
        select candidate.*, coalesce(candidate.submitted_at, candidate.started_at) sort_at
        from filtered candidate
        order by coalesce(candidate.submitted_at, candidate.started_at) desc
        limit v_size offset (v_page - 1) * v_size
      ) page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'page', v_page,
    'page_size', v_size
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.admin_exam_filter_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_scope text := '';
  v_caller_employee_id uuid;
  v_role_code text := '';
  v_all boolean := false;
  v_result jsonb;
begin
  if v_user_id is null
     or not session_private.current_app_session_is_valid('admin')
     or not (
       public.has_permission('exam.records.view')
       or public.has_permission('exam.grading.view')
     ) then
    raise exception 'session_not_current';
  end if;

  select access.data_scope, access.employee_id, role.code
  into v_scope, v_caller_employee_id, v_role_code
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
    and role.active = true
  order by access.updated_at desc
  limit 1;
  if not found then raise exception 'session_not_current'; end if;
  v_all := v_role_code = 'founder' or v_scope = 'all';

  with scoped_values as materialized (
    select assignment.team_name, assignment.position_name
    from public.exam_sessions session
    join public.exam_assignments assignment on assignment.id = session.assignment_id
    where v_all
       or (
         session.employee_id is not null
         and (
           (v_scope = 'self' and session.employee_id = v_caller_employee_id)
           or (
             v_scope in ('own_team', 'assigned_teams')
             and exists (
               select 1 from public.user_scope_employees effective
               where effective.auth_user_id = v_user_id
                 and effective.employee_id = session.employee_id
             )
           )
         )
       )
    union all
    select
      coalesce(team.name, '未匹配团队') team_name,
      coalesce(position.name, legacy.position_name, '—') position_name
    from public.legacy_exam_sessions legacy
    left join public.employees employee on employee.id = legacy.employee_id
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    where v_all
       or (
         legacy.employee_id is not null
         and (
           (v_scope = 'self' and legacy.employee_id = v_caller_employee_id)
           or (
             v_scope in ('own_team', 'assigned_teams')
             and exists (
               select 1 from public.user_scope_employees effective
               where effective.auth_user_id = v_user_id
                 and effective.employee_id = legacy.employee_id
             )
           )
         )
       )
  )
  select jsonb_build_object(
    'teams', coalesce((
      select jsonb_agg(name order by name)
      from (
        select distinct btrim(value.team_name) name
        from scoped_values value
        where nullif(btrim(value.team_name), '') is not null
      ) names
    ), '[]'::jsonb),
    'positions', coalesce((
      select jsonb_agg(name order by name)
      from (
        select distinct btrim(value.position_name) name
        from scoped_values value
        where nullif(btrim(value.position_name), '') is not null
      ) names
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.admin_exam_sessions_search_v3(
  text,text,text,text,text,text,text,text,date,date,integer,integer
) from public, anon, authenticated, service_role;
revoke all on function public.admin_exam_filter_options()
  from public, anon, authenticated, service_role;

do $verify$
declare
  v_search text := pg_catalog.pg_get_functiondef(
    'public.admin_exam_sessions_search_v3(text,text,text,text,text,text,text,text,date,date,integer,integer)'::regprocedure
  );
  v_filters text := pg_catalog.pg_get_functiondef(
    'public.admin_exam_filter_options()'::regprocedure
  );
begin
  if pg_catalog.strpos(v_search, 'session_private.exam_employee_in_scope(') > 0
     or pg_catalog.strpos(v_filters, 'session_private.exam_employee_in_scope(') > 0
     or pg_catalog.strpos(v_search, 'public.user_scope_employees effective') = 0
     or pg_catalog.strpos(v_filters, 'public.user_scope_employees effective') = 0
     or pg_catalog.strpos(v_search, 'p_date_from::timestamptz') = 0
     or pg_catalog.strpos(v_search, '(p_date_to + 1)::timestamptz') = 0
     or pg_catalog.strpos(v_filters, 'public.admin_exam_combined_sessions_v') > 0
     or pg_catalog.strpos(v_search, 'session_private.current_app_session_is_valid(''admin'')') = 0
     or pg_catalog.strpos(v_filters, 'session_private.current_app_session_is_valid(''admin'')') = 0 then
    raise exception 'bounded_exam_admin_read_installation_failed';
  end if;
end;
$verify$;

analyze public.exam_sessions;
analyze public.legacy_exam_sessions;

notify pgrst, 'reload schema';
commit;
