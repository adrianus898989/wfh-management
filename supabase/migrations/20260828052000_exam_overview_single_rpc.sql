begin;

-- The function-local timeout settings below are defense-in-depth session
-- configuration only; they do not restart the timeout of the outer RPC
-- statement. Production must enforce its hard ceiling before function entry.
create schema if not exists exam_private;
revoke all on schema exam_private from public, anon, authenticated, service_role;

-- Every public overview endpoint enters through this private gate.  It checks
-- the live admin session and permission, resolves the current access record,
-- and materializes the canonical employee scope exactly once per RPC.
create or replace function exam_private.admin_exam_overview_scope()
returns table (
  user_id uuid,
  data_scope text,
  role_code text,
  linked_employee_id uuid,
  all_access boolean,
  allowed_employee_ids uuid[],
  scope_key text
)
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2s'
set lock_timeout = '500ms'
set jit = 'off'
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_data_scope text;
  v_role_code text;
  v_linked_employee_id uuid;
  v_access_updated_at timestamptz;
  v_all_access boolean;
  v_allowed_employee_ids uuid[] := array[]::uuid[];
  v_scope_key text;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('exam.overview.view') then
    raise exception 'permission_denied';
  end if;

  select access.data_scope, role.code, access.employee_id, access.updated_at
  into v_data_scope, v_role_code, v_linked_employee_id, v_access_updated_at
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;
  if not found then raise exception 'permission_denied'; end if;

  v_all_access := v_role_code = 'founder' or v_data_scope = 'all';
  if not v_all_access then
    select coalesce(array_agg(scope.employee_id order by scope.employee_id), array[]::uuid[])
    into v_allowed_employee_ids
    from public.admin_scope_effective_employee_ids(v_user_id) scope;
  end if;

  v_scope_key := pg_catalog.md5(pg_catalog.concat_ws(
    '|',
    v_user_id::text,
    v_role_code,
    v_data_scope,
    coalesce(v_linked_employee_id::text, ''),
    coalesce(v_access_updated_at::text, ''),
    pg_catalog.array_to_string(v_allowed_employee_ids, ',')
  ));

  return query select
    v_user_id,
    v_data_scope,
    v_role_code,
    v_linked_employee_id,
    v_all_access,
    v_allowed_employee_ids,
    v_scope_key;
end;
$$;

revoke all on function exam_private.admin_exam_overview_scope()
  from public, anon, authenticated, service_role;

comment on function exam_private.admin_exam_overview_scope() is
  'Private live-session, permission, access and canonical employee-scope gate for exam overview RPCs.';

-- Fast first paint: question/current/legacy counts, the bounded recent rows,
-- and sync state only. Historical analytics are intentionally separate RPCs.
create or replace function public.admin_exam_overview_home()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '4s'
set lock_timeout = '500ms'
set jit = 'off'
as $$
declare
  v_user_id uuid;
  v_scope text;
  v_role_code text;
  v_linked_employee_id uuid;
  v_all boolean := false;
  v_has_position_filters boolean := false;
  v_allowed_employee_ids uuid[] := array[]::uuid[];
  v_scope_key text;
  v_question_count integer := 0;
  v_recent_current_rows jsonb := '[]'::jsonb;
  v_recent_legacy_rows jsonb := '[]'::jsonb;
  v_recent_pool jsonb := '[]'::jsonb;
  v_recent_sessions jsonb := '[]'::jsonb;
  v_recent_legacy_sessions jsonb := '[]'::jsonb;
  v_counts_bundle jsonb := '{}'::jsonb;
  v_current_counts jsonb := '{}'::jsonb;
  v_legacy_counts jsonb := '{}'::jsonb;
  v_last_sync jsonb := '{}'::jsonb;
  v_legacy_sync jsonb := '{}'::jsonb;
  v_result jsonb;
begin
  select
    scope.user_id,
    scope.data_scope,
    scope.role_code,
    scope.linked_employee_id,
    scope.all_access,
    scope.allowed_employee_ids,
    scope.scope_key
  into
    v_user_id,
    v_scope,
    v_role_code,
    v_linked_employee_id,
    v_all,
    v_allowed_employee_ids,
    v_scope_key
  from exam_private.admin_exam_overview_scope() scope;

  -- Question visibility intentionally ignores explicit employee exceptions.
  -- assigned_teams uses configured teams intersected with optional positions;
  -- own_team uses the linked employee's canonical current team, all positions.
  if v_all then
    select count(*)::integer
    into v_question_count
    from public.exam_questions question
    where question.active;
  else
    select exists (
      select 1
      from public.user_scope_position_filters filter
      where filter.auth_user_id = v_user_id
    ) into v_has_position_filters;

    with current_directory as materialized (
      select directory.*
      from scope_private.current_employee_scope_directory() directory
    ), question_scopes as materialized (
      select distinct
        public.exam_norm(team.name) team_key,
        case
          when v_scope = 'assigned_teams' and v_has_position_filters
            then public.exam_norm(position.name)
          else null
        end position_key
      from current_directory directory
      join public.teams team on team.id = directory.current_team_id
      left join public.positions position on position.id = directory.current_position_id
      where (
          v_scope = 'assigned_teams'
          and exists (
            select 1
            from public.user_scope_team_filters filter
            where filter.auth_user_id = v_user_id
              and filter.team_id = directory.current_team_id
          )
          and (
            not v_has_position_filters
            or exists (
              select 1
              from public.user_scope_position_filters filter
              where filter.auth_user_id = v_user_id
                and filter.position_id = directory.current_position_id
            )
          )
        )
        or (
          v_scope = 'own_team'
          and directory.employee_id = v_linked_employee_id
        )
    )
    select count(*)::integer
    into v_question_count
    from public.exam_questions question
    where question.active
      and exists (
        select 1
        from question_scopes scope
        where scope.team_key = public.exam_norm(question.team_name)
          and (
            scope.position_key is null
            or scope.position_key = public.exam_norm(question.position_name)
          )
      );
  end if;

  -- Full current-session JSON is bounded to 12 candidates before answer and
  -- grader enrichment.  Answer rows are grouped once for those candidates.
  with recent_current as materialized (
    select
      session.id,
      session.employee_id,
      session.graded_by,
      employee.employee_no,
      employee.full_name employee_name,
      assignment.title,
      assignment.team_name,
      assignment.position_name,
      assignment.series_name,
      session.attempt_no,
      session.status,
      session.started_at,
      session.submitted_at,
      session.graded_at,
      session.earned_score,
      session.total_score,
      session.percentage,
      session.passed,
      session.question_snapshot
    from public.exam_sessions session
    join public.employees employee on employee.id = session.employee_id
    join public.exam_assignments assignment on assignment.id = session.assignment_id
    where v_all
       or session.employee_id = any(v_allowed_employee_ids)
    order by session.started_at desc nulls last
    limit 12
  ), answer_counts as materialized (
    select
      answer.session_id,
      count(*)::integer answer_count,
      count(*) filter (where answer.grade_status = 'correct')::integer correct_count,
      count(*) filter (where answer.grade_status = 'partial')::integer partial_count,
      count(*) filter (where answer.grade_status = 'wrong')::integer wrong_count,
      count(*) filter (where answer.grade_status is null)::integer pending_count,
      count(*) filter (where answer.grade_status in ('correct', 'partial'))::integer scored_count,
      count(*) filter (where answer.grade_status = 'wrong')::integer zero_score_count
    from public.exam_answers answer
    join recent_current session on session.id = answer.session_id
    group by answer.session_id
  ), grader_names as materialized (
    select distinct on (access.auth_user_id)
      access.auth_user_id,
      btrim(access.login_username) login_username
    from public.user_access access
    join (
      select distinct session.graded_by auth_user_id
      from recent_current session
      where session.graded_by is not null
    ) target on target.auth_user_id = access.auth_user_id
    where nullif(btrim(access.login_username), '') is not null
      and strpos(btrim(access.login_username), '@') = 0
    order by access.auth_user_id, access.updated_at desc
  )
  select coalesce(jsonb_agg(to_jsonb(entry)), '[]'::jsonb)
  into v_recent_current_rows
  from (
    select
      session.id,
      session.employee_id,
      session.employee_no,
      session.employee_name,
      session.title,
      session.team_name,
      session.position_name,
      session.attempt_no,
      session.status,
      session.started_at,
      session.submitted_at,
      session.graded_at,
      session.earned_score,
      session.total_score,
      session.percentage,
      session.passed,
      case
        when session.graded_by is null then '—'
        else coalesce(nullif(grader.login_username, ''), '后台账号')
      end grader_name,
      coalesce(answer.correct_count, 0)::integer correct_count,
      coalesce(answer.partial_count, 0)::integer partial_count,
      coalesce(answer.wrong_count, 0)::integer wrong_count,
      coalesce(answer.pending_count, 0)::integer pending_count,
      'current'::text source_system,
      '本系统'::text source_label,
      'matched'::text employee_match_status,
      false read_only,
      session.series_name,
      coalesce(answer.answer_count, 0) > 0 answer_detail_available,
      coalesce(answer.answer_count, 0)::integer answer_detail_count,
      coalesce(answer.scored_count, 0)::integer scored_answer_count,
      coalesce(answer.zero_score_count, 0)::integer zero_score_answer_count,
      case
        when jsonb_typeof(session.question_snapshot) = 'array'
          then jsonb_array_length(session.question_snapshot)
        else coalesce(answer.answer_count, 0)
      end::integer total_question_count,
      greatest(
        case
          when jsonb_typeof(session.question_snapshot) = 'array'
            then jsonb_array_length(session.question_snapshot)
          else coalesce(answer.answer_count, 0)
        end - coalesce(answer.answer_count, 0),
        0
      )::integer unanswered_count,
      extract(epoch from (session.submitted_at - session.started_at)) duration_seconds
    from recent_current session
    left join answer_counts answer on answer.session_id = session.id
    left join grader_names grader on grader.auth_user_id = session.graded_by
  ) entry;

  -- Legacy full rows are likewise capped at 12.  This array is also the exact
  -- legacy.sessions payload; the combined top 12 is selected from both capped
  -- source arrays below.
  with recent_legacy as materialized (
    select
      session.id,
      session.employee_id,
      coalesce(employee.employee_no, session.employee_no, '—') employee_no,
      coalesce(employee.full_name, session.employee_name, '未匹配员工') employee_name,
      concat_ws(' · ', nullif(session.series_name, ''), nullif(session.position_name, '')) || ' 考试' title,
      coalesce(team.name, '未匹配团队') team_name,
      coalesce(position.name, session.position_name, '—') position_name,
      session.attempt_no,
      session.status,
      session.started_at,
      session.submitted_at,
      session.graded_at,
      session.earned_score,
      session.total_score,
      session.percentage,
      session.passed,
      session.employee_match_status,
      session.series_name,
      session.total_questions,
      session.question_ids
    from public.legacy_exam_sessions session
    left join public.employees employee on employee.id = session.employee_id
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    where v_all
       or session.employee_id = any(v_allowed_employee_ids)
    order by session.started_at desc nulls last
    limit 12
  ), answer_counts as materialized (
    select
      answer.legacy_session_id session_id,
      count(*)::integer answer_count,
      count(*) filter (where answer.grade_status = 'correct')::integer correct_count,
      count(*) filter (where answer.grade_status = 'partial')::integer partial_count,
      count(*) filter (where answer.grade_status = 'wrong')::integer wrong_count,
      count(*) filter (where answer.grade_status = 'pending')::integer pending_count,
      count(*) filter (where answer.grade_status in ('correct', 'partial'))::integer scored_count,
      count(*) filter (where answer.grade_status = 'wrong')::integer zero_score_count
    from public.legacy_exam_answers answer
    join recent_legacy session on session.id = answer.legacy_session_id
    group by answer.legacy_session_id
  )
  select coalesce(jsonb_agg(to_jsonb(entry)), '[]'::jsonb)
  into v_recent_legacy_rows
  from (
    select
      session.id,
      session.employee_id,
      session.employee_no,
      session.employee_name,
      session.title,
      session.team_name,
      session.position_name,
      session.attempt_no,
      session.status,
      session.started_at,
      session.submitted_at,
      session.graded_at,
      session.earned_score,
      session.total_score,
      session.percentage,
      session.passed,
      '旧系统'::text grader_name,
      coalesce(answer.correct_count, 0)::integer correct_count,
      coalesce(answer.partial_count, 0)::integer partial_count,
      coalesce(answer.wrong_count, 0)::integer wrong_count,
      coalesce(answer.pending_count, 0)::integer pending_count,
      'legacy'::text source_system,
      '旧考试'::text source_label,
      session.employee_match_status,
      true read_only,
      session.series_name,
      coalesce(answer.answer_count, 0) > 0 answer_detail_available,
      coalesce(answer.answer_count, 0)::integer answer_detail_count,
      coalesce(answer.scored_count, 0)::integer scored_answer_count,
      coalesce(answer.zero_score_count, 0)::integer zero_score_answer_count,
      coalesce(
        nullif(session.total_questions, 0),
        case when jsonb_typeof(session.question_ids) = 'array'
          then jsonb_array_length(session.question_ids) end,
        answer.answer_count,
        0
      )::integer total_question_count,
      greatest(
        coalesce(
          nullif(session.total_questions, 0),
          case when jsonb_typeof(session.question_ids) = 'array'
            then jsonb_array_length(session.question_ids) end,
          answer.answer_count,
          0
        ) - coalesce(answer.answer_count, 0),
        0
      )::integer unanswered_count,
      extract(epoch from (session.submitted_at - session.started_at)) duration_seconds
    from recent_legacy session
    left join answer_counts answer on answer.session_id = session.id
  ) entry;

  v_recent_pool := v_recent_current_rows || v_recent_legacy_rows;

  select coalesce(jsonb_agg(entry.row_data - 'duration_seconds' order by nullif(entry.row_data->>'started_at', '')::timestamptz desc nulls last), '[]'::jsonb)
  into v_recent_sessions
  from (
    select item.row_data
    from jsonb_array_elements(v_recent_pool) item(row_data)
    order by nullif(item.row_data->>'started_at', '')::timestamptz desc nulls last
    limit 12
  ) entry;

  select coalesce(jsonb_agg(item.row_data - 'duration_seconds' order by nullif(item.row_data->>'started_at', '')::timestamptz desc nulls last), '[]'::jsonb)
  into v_recent_legacy_sessions
  from jsonb_array_elements(v_recent_legacy_rows) item(row_data);

  -- First paint only needs narrow current/legacy counts. Answer totals and all
  -- historical scoring analysis live in the sequential analytics RPCs below.
  select jsonb_build_object(
    'current_counts', jsonb_build_object(
      'total_sessions', totals.current_total,
      'pending_grading', totals.current_pending,
      'completed', totals.current_completed
    ),
    'legacy_counts', jsonb_build_object(
      'total_sessions', totals.legacy_total,
      'pending_grading', totals.legacy_pending_grading,
      'in_progress', totals.legacy_in_progress,
      'completed', totals.legacy_completed,
      'matched', totals.legacy_matched,
      'unmatched', totals.legacy_unmatched
    )
  )
  into v_counts_bundle
  from (
    select
      count(*) filter (where fact.source_system = 'current')::integer current_total,
      count(*) filter (where fact.source_system = 'current' and fact.status in ('submitted', 'grading'))::integer current_pending,
      count(*) filter (where fact.source_system = 'current' and fact.status = 'graded')::integer current_completed,
      count(*) filter (where fact.source_system = 'legacy')::integer legacy_total,
      count(*) filter (where fact.source_system = 'legacy' and fact.status = 'submitted')::integer legacy_pending_grading,
      count(*) filter (where fact.source_system = 'legacy' and fact.status = 'in_progress')::integer legacy_in_progress,
      count(*) filter (where fact.source_system = 'legacy' and fact.status = 'graded')::integer legacy_completed,
      count(*) filter (where fact.source_system = 'legacy' and fact.employee_match_status = 'matched')::integer legacy_matched,
      count(*) filter (where fact.source_system = 'legacy' and fact.employee_match_status <> 'matched')::integer legacy_unmatched
    from (
      select
        'current'::text source_system,
        'matched'::text employee_match_status,
        session.status
      from public.exam_sessions session
      where v_all
         or session.employee_id = any(v_allowed_employee_ids)
      union all
      select
        'legacy'::text source_system,
        session.employee_match_status,
        session.status
      from public.legacy_exam_sessions session
      where v_all
         or session.employee_id = any(v_allowed_employee_ids)
    ) fact
  ) totals;

  v_current_counts := coalesce(v_counts_bundle->'current_counts', '{}'::jsonb);
  v_legacy_counts := coalesce(v_counts_bundle->'legacy_counts', '{}'::jsonb);
  select coalesce((
    select jsonb_build_object('status', sync_run.status)
    from public.exam_sync_runs sync_run
    order by sync_run.started_at desc
    limit 1
  ), '{}'::jsonb)
  into v_last_sync;

  select coalesce((
    select jsonb_build_object(
      'status', sync_state.status,
      'last_success_at', sync_state.last_success_at,
      'last_error', sync_state.last_error,
      'updated_at', sync_state.updated_at
    )
    from public.legacy_exam_sync_state sync_state
    order by sync_state.updated_at desc
    limit 1
  ), '{}'::jsonb)
  into v_legacy_sync;

  v_result := jsonb_build_object(
    '_scope_key', v_scope_key,
    'counts', jsonb_build_object(
      'questions', v_question_count,
      'total_sessions', coalesce((v_current_counts->>'total_sessions')::integer, 0) + coalesce((v_legacy_counts->>'total_sessions')::integer, 0),
      'pending_grading', coalesce((v_current_counts->>'pending_grading')::integer, 0) + coalesce((v_legacy_counts->>'pending_grading')::integer, 0),
      'completed', coalesce((v_current_counts->>'completed')::integer, 0) + coalesce((v_legacy_counts->>'completed')::integer, 0)
    ),
    'current_counts', v_current_counts,
    'sessions', v_recent_sessions,
    'last_sync', v_last_sync,
    'legacy', jsonb_build_object(
      'counts', v_legacy_counts,
      'sessions', v_recent_legacy_sessions,
      'sync_state', v_legacy_sync
    )
  );

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

revoke all on function public.admin_exam_overview_home()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_exam_overview_home()
  to authenticated, service_role;

comment on function public.admin_exam_overview_home() is
  'Fast exam overview first paint: bounded recent rows, counts, and sync state after a private canonical scope check.';

create or replace function public.admin_exam_overview_analytics_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
set lock_timeout = '500ms'
set jit = 'off'
as $$
declare
  v_all boolean;
  v_allowed_employee_ids uuid[] := array[]::uuid[];
  v_scope_key text;
  v_result jsonb;
begin
  select scope.all_access, scope.allowed_employee_ids, scope.scope_key
  into v_all, v_allowed_employee_ids, v_scope_key
  from exam_private.admin_exam_overview_scope() scope;

  with current_answer_totals as materialized (
    select
      count(*) filter (where answer.grade_status = 'correct')::integer correct_count,
      count(*) filter (where answer.grade_status = 'partial')::integer partial_count,
      count(*) filter (where answer.grade_status = 'wrong')::integer wrong_count,
      count(*) filter (where answer.grade_status is null)::integer pending_count
    from public.exam_answers answer
    join public.exam_sessions session on session.id = answer.session_id
    where v_all
       or session.employee_id = any(v_allowed_employee_ids)
  ), legacy_answer_totals as materialized (
    select
      count(distinct answer.legacy_session_id)::integer session_count,
      count(*)::integer answer_count,
      count(*) filter (where answer.grade_status = 'correct')::integer correct_count,
      count(*) filter (where answer.grade_status = 'partial')::integer partial_count,
      count(*) filter (where answer.grade_status = 'wrong')::integer wrong_count,
      count(*) filter (where answer.grade_status = 'pending')::integer pending_count,
      count(*) filter (where answer.grade_status in ('correct', 'partial'))::integer scored_count,
      count(*) filter (where answer.grade_status = 'wrong')::integer zero_score_count
    from public.legacy_exam_answers answer
    join public.legacy_exam_sessions session on session.id = answer.legacy_session_id
    where v_all
       or session.employee_id = any(v_allowed_employee_ids)
  ), facts as materialized (
    select
      'current'::text source_system,
      session.status,
      session.passed,
      session.percentage,
      extract(epoch from (session.submitted_at - session.started_at)) duration_seconds
    from public.exam_sessions session
    where v_all
       or session.employee_id = any(v_allowed_employee_ids)
    union all
    select
      'legacy'::text source_system,
      session.status,
      session.passed,
      session.percentage,
      extract(epoch from (session.submitted_at - session.started_at)) duration_seconds
    from public.legacy_exam_sessions session
    where v_all
       or session.employee_id = any(v_allowed_employee_ids)
  ), overall as materialized (
    select
      count(*)::integer total_attempts,
      count(*) filter (where source_system = 'current')::integer current_total,
      count(*) filter (where source_system = 'legacy')::integer legacy_total,
      count(*) filter (where source_system = 'legacy' and status in ('submitted', 'in_progress'))::integer legacy_pending,
      count(*) filter (where status = 'graded')::integer graded_attempts,
      count(*) filter (where status = 'graded' and passed)::integer pass_count,
      count(*) filter (where status = 'graded' and not passed)::integer fail_count,
      round(avg(percentage) filter (where status = 'graded'), 1) avg_score,
      round(100.0 * count(*) filter (where status = 'graded' and passed) / nullif(count(*) filter (where status = 'graded'), 0), 1) pass_rate,
      round(avg(duration_seconds) filter (where duration_seconds >= 0)) avg_duration_seconds,
      count(*) filter (where status = 'graded' and percentage >= 90)::integer excellent,
      count(*) filter (where status = 'graded' and percentage >= 80 and percentage < 90)::integer good,
      count(*) filter (where status = 'graded' and percentage >= 60 and percentage < 80)::integer passing,
      count(*) filter (where status = 'graded' and percentage < 60)::integer failing
    from facts
  ), by_source as materialized (
    select
      source_system,
      count(*)::integer attempts,
      count(*) filter (where status = 'graded')::integer graded,
      count(*) filter (where status in ('submitted', 'in_progress'))::integer pending,
      round(avg(percentage) filter (where status = 'graded'), 1) average
    from facts
    group by source_system
  )
  select jsonb_build_object(
    '_scope_key', v_scope_key,
    'summary', jsonb_build_object(
      'total_attempts', overall.total_attempts,
      'graded_attempts', overall.graded_attempts,
      'pass_count', overall.pass_count,
      'fail_count', overall.fail_count,
      'avg_score', overall.avg_score,
      'pass_rate', overall.pass_rate,
      'avg_duration_seconds', overall.avg_duration_seconds,
      'correct_count', current_answer.correct_count,
      'partial_count', current_answer.partial_count,
      'wrong_count', current_answer.wrong_count,
      'pending_count', current_answer.pending_count,
      'current_attempts', overall.current_total,
      'legacy_attempts', overall.legacy_total,
      'legacy_pending', overall.legacy_pending,
      'legacy_correct_count', legacy_answer.correct_count,
      'legacy_partial_count', legacy_answer.partial_count,
      'legacy_wrong_count', legacy_answer.wrong_count,
      'legacy_answer_pending_count', legacy_answer.pending_count,
      'answer_stats_scope', 'synced_detail',
      'legacy_answer_sessions', legacy_answer.session_count,
      'legacy_answer_count', legacy_answer.answer_count,
      'legacy_scored_count', legacy_answer.scored_count,
      'legacy_zero_score_count', legacy_answer.zero_score_count
    ),
    'score_bands', jsonb_build_object(
      'excellent', overall.excellent,
      'good', overall.good,
      'pass', overall.passing,
      'fail', overall.failing
    ),
    'sources', coalesce((
      select jsonb_agg(to_jsonb(metric) order by metric.source_system)
      from by_source metric
    ), '[]'::jsonb)
  )
  into v_result
  from overall
  cross join current_answer_totals current_answer
  cross join legacy_answer_totals legacy_answer;

  return coalesce(v_result, jsonb_build_object(
    '_scope_key', v_scope_key,
    'summary', '{}'::jsonb,
    'score_bands', '{}'::jsonb,
    'sources', '[]'::jsonb
  ));
end;
$$;

create or replace function public.admin_exam_overview_analytics_dimensions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
set lock_timeout = '500ms'
set jit = 'off'
as $$
declare
  v_all boolean;
  v_allowed_employee_ids uuid[] := array[]::uuid[];
  v_scope_key text;
  v_result jsonb;
begin
  select scope.all_access, scope.allowed_employee_ids, scope.scope_key
  into v_all, v_allowed_employee_ids, v_scope_key
  from exam_private.admin_exam_overview_scope() scope;

  with session_dimensions as materialized (
    select
      assignment.series_name,
      assignment.position_name,
      assignment.team_name,
      session.percentage
    from public.exam_sessions session
    join public.exam_assignments assignment on assignment.id = session.assignment_id
    where (v_all
       or session.employee_id = any(v_allowed_employee_ids))
      and session.status = 'graded'
    union all
    select
      session.series_name,
      coalesce(position.name, session.position_name, '—') position_name,
      coalesce(team.name, '未匹配团队') team_name,
      session.percentage
    from public.legacy_exam_sessions session
    left join public.employees employee on employee.id = session.employee_id
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    where (v_all
       or session.employee_id = any(v_allowed_employee_ids))
      and session.status = 'graded'
  ), grouped as materialized (
    select
      dimension.kind,
      coalesce(nullif(dimension.name, ''), '未分类') name,
      round(avg(session.percentage), 1) average,
      count(*)::integer attempts
    from session_dimensions session
    cross join lateral (values
      ('series'::text, session.series_name),
      ('position'::text, session.position_name),
      ('team'::text, session.team_name)
    ) dimension(kind, name)
    group by dimension.kind, coalesce(nullif(dimension.name, ''), '未分类')
  )
  select jsonb_build_object(
    '_scope_key', v_scope_key,
    'series', coalesce(jsonb_agg(to_jsonb(metric) - 'kind' order by metric.average desc, metric.name) filter (where metric.kind = 'series'), '[]'::jsonb),
    'positions', coalesce(jsonb_agg(to_jsonb(metric) - 'kind' order by metric.average desc, metric.name) filter (where metric.kind = 'position'), '[]'::jsonb),
    'teams', coalesce(jsonb_agg(to_jsonb(metric) - 'kind' order by metric.average desc, metric.name) filter (where metric.kind = 'team'), '[]'::jsonb)
  )
  into v_result
  from grouped metric;

  return coalesce(v_result, jsonb_build_object(
    '_scope_key', v_scope_key,
    'series', '[]'::jsonb,
    'positions', '[]'::jsonb,
    'teams', '[]'::jsonb
  ));
end;
$$;

create or replace function public.admin_exam_overview_analytics_activity()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
set lock_timeout = '500ms'
set jit = 'off'
as $$
declare
  v_all boolean;
  v_allowed_employee_ids uuid[] := array[]::uuid[];
  v_scope_key text;
  v_result jsonb;
begin
  select scope.all_access, scope.allowed_employee_ids, scope.scope_key
  into v_all, v_allowed_employee_ids, v_scope_key
  from exam_private.admin_exam_overview_scope() scope;

  with activity_facts as materialized (
    select session.submitted_at, session.status, session.percentage, 'current'::text source_system
    from public.exam_sessions session
    where (v_all
       or session.employee_id = any(v_allowed_employee_ids))
      and session.submitted_at is not null
      and session.submitted_at >= current_date - interval '29 days'
    union all
    select session.submitted_at, session.status, session.percentage, 'legacy'::text source_system
    from public.legacy_exam_sessions session
    where (v_all
       or session.employee_id = any(v_allowed_employee_ids))
      and session.submitted_at is not null
      and session.submitted_at >= current_date - interval '29 days'
  ), days as materialized (
    select
      submitted_at::date activity_day,
      count(*)::integer submitted,
      count(*) filter (where status = 'graded')::integer graded,
      count(*) filter (where status in ('submitted', 'in_progress'))::integer pending,
      count(*) filter (where source_system = 'current')::integer current_submitted,
      count(*) filter (where source_system = 'legacy')::integer legacy_submitted,
      round(avg(percentage) filter (where status = 'graded'), 1) average_score
    from activity_facts
    group by submitted_at::date
  )
  select jsonb_build_object(
    '_scope_key', v_scope_key,
    'trend', coalesce(jsonb_agg(jsonb_build_object(
      'trend_day', day.activity_day,
      'average', day.average_score,
      'attempts', day.graded
    ) order by day.activity_day) filter (where day.graded > 0), '[]'::jsonb),
    'daily_activity', coalesce(jsonb_agg(jsonb_build_object(
      'activity_day', day.activity_day,
      'submitted', day.submitted,
      'graded', day.graded,
      'pending', day.pending,
      'current_submitted', day.current_submitted,
      'legacy_submitted', day.legacy_submitted,
      'average_score', day.average_score
    ) order by day.activity_day), '[]'::jsonb)
  )
  into v_result
  from days day;

  return coalesce(v_result, jsonb_build_object(
    '_scope_key', v_scope_key,
    'trend', '[]'::jsonb,
    'daily_activity', '[]'::jsonb
  ));
end;
$$;

create or replace function public.admin_exam_overview_analytics_leaderboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
set lock_timeout = '500ms'
set jit = 'off'
as $$
declare
  v_all boolean;
  v_allowed_employee_ids uuid[] := array[]::uuid[];
  v_scope_key text;
  v_result jsonb;
begin
  select scope.all_access, scope.allowed_employee_ids, scope.scope_key
  into v_all, v_allowed_employee_ids, v_scope_key
  from exam_private.admin_exam_overview_scope() scope;

  with leaderboard_facts as materialized (
    select
      session.employee_id,
      employee.employee_no,
      employee.full_name employee_name,
      assignment.team_name,
      session.percentage,
      session.passed,
      session.submitted_at,
      'current'::text source_system
    from public.exam_sessions session
    join public.employees employee on employee.id = session.employee_id
    join public.exam_assignments assignment on assignment.id = session.assignment_id
    where (v_all
       or session.employee_id = any(v_allowed_employee_ids))
      and session.status = 'graded'
    union all
    select
      session.employee_id,
      coalesce(employee.employee_no, session.employee_no, '—') employee_no,
      coalesce(employee.full_name, session.employee_name, '未匹配员工') employee_name,
      coalesce(team.name, '未匹配团队') team_name,
      session.percentage,
      session.passed,
      session.submitted_at,
      'legacy'::text source_system
    from public.legacy_exam_sessions session
    left join public.employees employee on employee.id = session.employee_id
    left join public.teams team on team.id = employee.team_id
    where (v_all
       or session.employee_id = any(v_allowed_employee_ids))
      and session.status = 'graded'
  )
  select jsonb_build_object(
    '_scope_key', v_scope_key,
    'leaderboard', coalesce(jsonb_agg(to_jsonb(metric) order by metric.rank_no, metric.employee_name), '[]'::jsonb)
  )
  into v_result
  from (
    select
      dense_rank() over (
        order by avg(fact.percentage) desc, max(fact.percentage) desc, count(*) desc
      ) rank_no,
      min(fact.employee_id::text)::uuid employee_id,
      fact.employee_no,
      max(fact.employee_name) employee_name,
      coalesce(max(fact.team_name), '—') team_name,
      count(*)::integer attempts,
      round(avg(fact.percentage), 1) average_score,
      max(fact.percentage) best_score,
      count(*) filter (where fact.passed)::integer pass_count,
      max(fact.submitted_at) last_exam_at,
      count(*) filter (where fact.source_system = 'legacy')::integer legacy_attempts
    from leaderboard_facts fact
    group by fact.employee_no
  ) metric;

  return coalesce(v_result, jsonb_build_object(
    '_scope_key', v_scope_key,
    'leaderboard', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.admin_exam_overview_analytics_summary()
  from public, anon, authenticated, service_role;
revoke all on function public.admin_exam_overview_analytics_dimensions()
  from public, anon, authenticated, service_role;
revoke all on function public.admin_exam_overview_analytics_activity()
  from public, anon, authenticated, service_role;
revoke all on function public.admin_exam_overview_analytics_leaderboard()
  from public, anon, authenticated, service_role;

grant execute on function public.admin_exam_overview_analytics_summary()
  to authenticated, service_role;
grant execute on function public.admin_exam_overview_analytics_dimensions()
  to authenticated, service_role;
grant execute on function public.admin_exam_overview_analytics_activity()
  to authenticated, service_role;
grant execute on function public.admin_exam_overview_analytics_leaderboard()
  to authenticated, service_role;

comment on function public.admin_exam_overview_analytics_summary() is
  'Scoped exam summary, answer truth, score bands and source metrics.';
comment on function public.admin_exam_overview_analytics_dimensions() is
  'Scoped exam series, position and team metrics.';
comment on function public.admin_exam_overview_analytics_activity() is
  'Scoped 30-day exam trend and daily activity metrics.';
comment on function public.admin_exam_overview_analytics_leaderboard() is
  'Scoped exam leaderboard metrics.';

notify pgrst, 'reload schema';

commit;
