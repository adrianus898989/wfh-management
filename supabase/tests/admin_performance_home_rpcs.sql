-- Run after all migrations in a disposable database.  This static catalog
-- guard verifies that the high-volume home endpoints remain bounded and do
-- not regress to row-by-row authorization checks.
begin;

set local search_path = pg_catalog;

do $performance_home_rpcs$
declare
  v_exam regprocedure := 'public.admin_exam_overview_home()'::regprocedure;
  v_exam_summary regprocedure := 'public.admin_exam_overview_analytics_summary()'::regprocedure;
  v_exam_dimensions regprocedure := 'public.admin_exam_overview_analytics_dimensions()'::regprocedure;
  v_exam_activity regprocedure := 'public.admin_exam_overview_analytics_activity()'::regprocedure;
  v_exam_leaderboard regprocedure := 'public.admin_exam_overview_analytics_leaderboard()'::regprocedure;
  v_exam_scope regprocedure := 'exam_private.admin_exam_overview_scope()'::regprocedure;
  v_connectivity regprocedure := 'public.admin_connectivity_home(jsonb)'::regprocedure;
  v_exam_definition text := lower(pg_get_functiondef(v_exam));
  v_exam_summary_definition text := lower(pg_get_functiondef(v_exam_summary));
  v_exam_dimensions_definition text := lower(pg_get_functiondef(v_exam_dimensions));
  v_exam_activity_definition text := lower(pg_get_functiondef(v_exam_activity));
  v_exam_leaderboard_definition text := lower(pg_get_functiondef(v_exam_leaderboard));
  v_exam_scope_definition text := lower(pg_get_functiondef(v_exam_scope));
  v_connectivity_definition text := lower(pg_get_functiondef(v_connectivity));
begin
  if position('admin_scope_effective_employee_ids(v_user_id)' in v_exam_scope_definition) = 0
     or position('current_app_session_is_valid(''admin'')' in v_exam_scope_definition) = 0
     or position('has_permission(''exam.overview.view'')' in v_exam_scope_definition) = 0
     or position('scope_key text' in v_exam_scope_definition) = 0
     or position('admin_exam_overview_scope()' in v_exam_definition) = 0
     or position('current_employee_scope_directory()' in v_exam_definition) = 0
     or position('user_scope_team_filters' in v_exam_definition) = 0
     or position('user_scope_position_filters' in v_exam_definition) = 0
     or position('recent_current as materialized' in v_exam_definition) = 0
     or position('recent_legacy as materialized' in v_exam_definition) = 0
     or position('into v_recent_current_rows' in v_exam_definition) = 0
     or position('into v_recent_legacy_rows' in v_exam_definition) = 0
     or position('v_counts_bundle' in v_exam_definition) = 0
     or position('current_answer_totals as materialized' in v_exam_summary_definition) = 0
     or position('legacy_answer_totals as materialized' in v_exam_summary_definition) = 0
     or position('session_dimensions as materialized' in v_exam_dimensions_definition) = 0
     or position('activity_facts as materialized' in v_exam_activity_definition) = 0
     or position('leaderboard_facts as materialized' in v_exam_leaderboard_definition) = 0 then
    raise exception 'exam overview split lost a bounded set-based fragment';
  end if;

  if position('exam_employee_in_scope' in v_exam_definition || v_exam_summary_definition || v_exam_dimensions_definition || v_exam_activity_definition || v_exam_leaderboard_definition) > 0
     or position('can_manage_employee' in v_exam_definition || v_exam_summary_definition || v_exam_dimensions_definition || v_exam_activity_definition || v_exam_leaderboard_definition) > 0
     or position('scoped_sessions as materialized' in v_exam_definition) > 0
     or position('cross join analytics_summary' in v_exam_definition) > 0
     or position('v_current_sessions' in v_exam_definition) > 0
     or position('v_legacy_sessions' in v_exam_definition) > 0 then
    raise exception 'exam overview regressed to per-row authorization';
  end if;

  if position('current_answer_totals' in v_exam_definition) > 0
     or position('session_dimensions' in v_exam_definition) > 0
     or position('activity_facts' in v_exam_definition) > 0
     or position('leaderboard_facts' in v_exam_definition) > 0 then
    raise exception 'exam first-paint RPC regained historical analytics planning';
  end if;

  if position('admin_scope_effective_employee_ids(v_user_id)' in v_connectivity_definition) = 0
     or position('scoped_employees as materialized' in v_connectivity_definition) = 0
     or position('can_manage_employee' in v_connectivity_definition) > 0 then
    raise exception 'connectivity home lost its reusable employee scope set';
  end if;

  if not has_function_privilege('authenticated', v_exam, 'execute')
     or has_function_privilege('anon', v_exam, 'execute')
     or not has_function_privilege('authenticated', v_exam_summary, 'execute')
     or not has_function_privilege('authenticated', v_exam_dimensions, 'execute')
     or not has_function_privilege('authenticated', v_exam_activity, 'execute')
     or not has_function_privilege('authenticated', v_exam_leaderboard, 'execute')
     or has_function_privilege('anon', v_exam_summary, 'execute')
     or has_function_privilege('anon', v_exam_dimensions, 'execute')
     or has_function_privilege('anon', v_exam_activity, 'execute')
     or has_function_privilege('anon', v_exam_leaderboard, 'execute')
     or has_function_privilege('authenticated', v_exam_scope, 'execute')
     or has_schema_privilege('authenticated', 'exam_private', 'usage')
     or not has_function_privilege('authenticated', v_connectivity, 'execute')
     or has_function_privilege('anon', v_connectivity, 'execute') then
    raise exception 'home RPC execute privileges changed';
  end if;

  if not exists (
    select 1
    from pg_proc procedure
    where procedure.oid = v_exam
      and procedure.prosecdef
      and procedure.provolatile = 's'
  ) or not exists (
    select 1
    from pg_proc procedure
    where procedure.oid = any (array[v_exam_summary::oid, v_exam_dimensions::oid, v_exam_activity::oid, v_exam_leaderboard::oid])
      and procedure.prosecdef
      and procedure.provolatile = 's'
    having count(*) = 4
  ) or not exists (
    select 1
    from pg_proc procedure
    where procedure.oid = v_connectivity
      and procedure.prosecdef
      and procedure.provolatile = 's'
  ) then
    raise exception 'home RPC volatility or security-definer boundary changed';
  end if;

  if not exists (
    select 1
    from pg_indexes index_entry
    where index_entry.schemaname = 'public'
      and index_entry.indexname = 'employee_connectivity_incident_date_idx'
  ) then
    raise exception 'connectivity date/order index is missing';
  end if;
end;
$performance_home_rpcs$;

rollback;
