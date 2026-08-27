begin;

-- Keep the existing permission/session/scope implementations intact and add
-- transactional audit records around the three highest-risk exam mutations.
-- The renamed implementations remain private: callers can only reach the
-- audited public wrappers below.
do $exam_audit_prerequisites$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.admin_exam_delete_question(uuid)'::regprocedure
  ) into v_definition;
  if strpos(v_definition,'admin_exam_delete_question_page_v1')=0
     or strpos(v_definition,'exam.question_bank.delete')=0
     or strpos(v_definition,'exam_team_in_scope')=0 then
    raise exception 'admin_exam_delete_question_audit_prerequisite_changed';
  end if;

  select pg_get_functiondef(
    'public.admin_exam_delete_assignment(uuid)'::regprocedure
  ) into v_definition;
  if strpos(v_definition,'admin_exam_delete_assignment_page_v1')=0
     or strpos(v_definition,'exam.question_bank.delete')=0
     or strpos(v_definition,'exam_assignment_target_in_scope')=0 then
    raise exception 'admin_exam_delete_assignment_audit_prerequisite_changed';
  end if;

  select pg_get_functiondef(
    'public.admin_exam_grade_answer(uuid,text,numeric,text)'::regprocedure
  ) into v_definition;
  if strpos(v_definition,'admin_exam_grade_answer_page_v1')=0
     or strpos(v_definition,'exam.grading.grade')=0
     or strpos(v_definition,'exam_employee_in_scope')=0 then
    raise exception 'admin_exam_grade_answer_audit_prerequisite_changed';
  end if;
end
$exam_audit_prerequisites$;

alter function public.admin_exam_delete_question(uuid)
  rename to admin_exam_delete_question_audit_inner_v1;
alter function public.admin_exam_delete_assignment(uuid)
  rename to admin_exam_delete_assignment_audit_inner_v1;
alter function public.admin_exam_grade_answer(uuid,text,numeric,text)
  rename to admin_exam_grade_answer_audit_inner_v1;

revoke all on function public.admin_exam_delete_question_audit_inner_v1(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.admin_exam_delete_assignment_audit_inner_v1(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.admin_exam_grade_answer_audit_inner_v1(uuid,text,numeric,text)
  from public,anon,authenticated,service_role;

create function public.admin_exam_delete_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=(select auth.uid());
  v_result jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  -- The retained implementation performs the exact permission and team-scope
  -- checks before changing the row.
  v_result:=public.admin_exam_delete_question_audit_inner_v1(p_question_id);

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,new_data,reason
  ) values(
    v_actor,null,'exam_question_bank','delete_question',p_question_id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'id',v_result->>'id',
      'external_key',v_result->>'external_key',
      'team_name',v_result->>'team_name',
      'position_name',v_result->>'position_name',
      'active',v_result->'active',
      'revision',v_result->'revision'
    )),
    '删除考试题目 · '||coalesce(nullif(v_result->>'external_key',''),p_question_id::text)
  );

  return v_result;
end;
$$;

create function public.admin_exam_delete_assignment(p_assignment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=(select auth.uid());
  v_result jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  -- The retained implementation locks the assignment, checks old/new scope,
  -- and either closes or removes it according to its existing history rule.
  v_result:=public.admin_exam_delete_assignment_audit_inner_v1(p_assignment_id);

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,new_data,reason
  ) values(
    v_actor,null,'exam_question_bank','delete_assignment',p_assignment_id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'id',coalesce(v_result->>'id',p_assignment_id::text),
      'status',v_result->>'status',
      'removed',v_result->'removed'
    )),
    case when coalesce((v_result->>'removed')::boolean,false)
      then '删除考试任务 · '||p_assignment_id::text
      else '关闭已有作答记录的考试任务 · '||p_assignment_id::text
    end
  );

  return v_result;
end;
$$;

create function public.admin_exam_grade_answer(
  p_answer_id uuid,
  p_status text,
  p_score numeric,
  p_feedback text default ''
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=(select auth.uid());
  v_employee_id uuid;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  -- The retained implementation checks grading permission and employee scope,
  -- locks the answer/session and recalculates the session result.
  v_result:=public.admin_exam_grade_answer_audit_inner_v1(
    p_answer_id,p_status,p_score,p_feedback
  );

  select exam_session.employee_id into v_employee_id
  from public.exam_sessions exam_session
  where exam_session.id=nullif(v_result->>'session_id','')::uuid;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,new_data,reason
  ) values(
    v_actor,v_employee_id,'exam_grading','grade_answer',p_answer_id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'answer_id',coalesce(v_result->>'id',p_answer_id::text),
      'session_id',v_result->>'session_id',
      'grade_status',v_result->>'grade_status',
      'awarded_score',v_result->'awarded_score',
      'grader_feedback',v_result->>'grader_feedback',
      'graded_at',v_result->>'graded_at'
    )),
    '人工批改 · 状态 '||coalesce(nullif(v_result->>'grade_status',''),'—')
      ||' · 分数 '||coalesce(v_result->>'awarded_score','—')
  );

  return v_result;
end;
$$;

revoke all on function public.admin_exam_delete_question(uuid)
  from public,anon,authenticated;
revoke all on function public.admin_exam_delete_assignment(uuid)
  from public,anon,authenticated;
revoke all on function public.admin_exam_grade_answer(uuid,text,numeric,text)
  from public,anon,authenticated;

grant execute on function public.admin_exam_delete_question(uuid)
  to authenticated,service_role;
grant execute on function public.admin_exam_delete_assignment(uuid)
  to authenticated,service_role;
grant execute on function public.admin_exam_grade_answer(uuid,text,numeric,text)
  to authenticated,service_role;

comment on function public.admin_exam_delete_question(uuid) is
  'Audited wrapper around the existing permission- and team-scope-checked question delete.';
comment on function public.admin_exam_delete_assignment(uuid) is
  'Audited wrapper around the existing permission- and target-scope-checked assignment close/delete.';
comment on function public.admin_exam_grade_answer(uuid,text,numeric,text) is
  'Audited wrapper around the existing permission- and employee-scope-checked grading mutation.';

notify pgrst,'reload schema';
commit;
