begin;

-- Preserve the currently deployed permission, target-scope and validation
-- implementations, while making the corresponding audit record part of the
-- same transaction as each business mutation.
do $remaining_crud_audit_prerequisites$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.admin_exam_save_question(jsonb)'::regprocedure
  ) into v_definition;
  if strpos(v_definition,'admin_exam_save_question_page_v1')=0
     or strpos(v_definition,'exam.question_bank.manage')=0
     or strpos(v_definition,'exam_team_in_scope')=0 then
    raise exception 'admin_exam_save_question_audit_prerequisite_changed';
  end if;

  select pg_get_functiondef(
    'public.admin_exam_create_assignment(jsonb)'::regprocedure
  ) into v_definition;
  if strpos(v_definition,'admin_exam_create_assignment_page_v1')=0
     or strpos(v_definition,'exam.question_bank.manage')=0
     or strpos(v_definition,'exam_assignment_target_in_scope')=0 then
    raise exception 'admin_exam_create_assignment_audit_prerequisite_changed';
  end if;

  select pg_get_functiondef(
    'public.admin_exam_create_assignment_page_v1(jsonb)'::regprocedure
  ) into v_definition;
  if strpos(v_definition,'exam_assignments')=0
     or strpos(v_definition,'return to_jsonb')=0 then
    raise exception 'admin_exam_create_assignment_result_prerequisite_changed';
  end if;

  select pg_get_functiondef(
    'public.admin_exam_save_assignment(jsonb)'::regprocedure
  ) into v_definition;
  if strpos(v_definition,'admin_exam_save_assignment_page_v1')=0
     or strpos(v_definition,'exam.question_bank.manage')=0
     or strpos(v_definition,'exam_assignment_target_in_scope')=0 then
    raise exception 'admin_exam_save_assignment_audit_prerequisite_changed';
  end if;

  select pg_get_functiondef(
    'public.admin_connectivity_create(jsonb)'::regprocedure
  ) into v_definition;
  if strpos(v_definition,'employee_ops_private.admin_connectivity_create')=0
     or strpos(v_definition,'current_app_session_is_valid(''admin'')')=0
     or strpos(v_definition,'connectivity.create')=0 then
    raise exception 'admin_connectivity_create_audit_prerequisite_changed';
  end if;

  select pg_get_functiondef(
    'employee_ops_private.admin_connectivity_create(jsonb)'::regprocedure
  ) into v_definition;
  if strpos(v_definition,'public.can_manage_employee')=0
     or strpos(v_definition,'employee_connectivity_incidents')=0
     or strpos(v_definition,'''id'',v_id')=0
     or strpos(v_definition,'''employee_id'',v_employee_id')=0
     or strpos(v_definition,'''employee_no'',v_employee_no')=0
     or strpos(v_definition,'''duration_minutes'',v_duration')=0 then
    raise exception 'admin_connectivity_create_result_prerequisite_changed';
  end if;
end
$remaining_crud_audit_prerequisites$;

alter function public.admin_exam_save_question(jsonb)
  rename to admin_exam_save_question_audit_inner_v1;
alter function public.admin_exam_create_assignment(jsonb)
  rename to admin_exam_create_assignment_audit_inner_v1;
alter function public.admin_exam_save_assignment(jsonb)
  rename to admin_exam_save_assignment_audit_inner_v1;
alter function public.admin_connectivity_create(jsonb)
  rename to admin_connectivity_create_audit_inner_v1;

revoke all on function public.admin_exam_save_question_audit_inner_v1(jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.admin_exam_create_assignment_audit_inner_v1(jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.admin_exam_save_assignment_audit_inner_v1(jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.admin_connectivity_create_audit_inner_v1(jsonb)
  from public,anon,authenticated,service_role;

create function public.admin_exam_save_question(p_question jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=(select auth.uid());
  v_is_update boolean:=nullif(btrim(p_question->>'id'),'') is not null;
  v_record_id text;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  -- The retained implementation performs the granular manage permission,
  -- previous-team scope, new-team scope and row-lock checks.
  v_result:=public.admin_exam_save_question_audit_inner_v1(p_question);
  v_record_id:=nullif(v_result->>'id','');
  if v_record_id is null then raise exception 'audit_result_invalid'; end if;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,new_data,reason
  ) values(
    v_actor,null,'exam',
    case when v_is_update then 'update_question' else 'create_question' end,
    v_record_id,
    jsonb_strip_nulls(jsonb_build_object(
      'id',v_record_id,
      'external_key',v_result->>'external_key',
      'team_name',v_result->>'team_name',
      'position_name',v_result->>'position_name',
      'points',v_result->'points',
      'difficulty',v_result->'difficulty',
      'active',v_result->'active',
      'revision',v_result->'revision',
      'sync_status',v_result->>'sync_status'
    )),
    case when v_is_update then '编辑考试题目 · ' else '新增考试题目 · ' end
      ||coalesce(nullif(v_result->>'external_key',''),v_record_id)
  );

  return v_result;
end;
$$;

create function public.admin_exam_create_assignment(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=(select auth.uid());
  v_employee_id uuid;
  v_record_id text;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  -- Retain the legacy create endpoint's granular manage permission and
  -- assignment-target scope guard so it cannot bypass the audited save path.
  v_result:=public.admin_exam_create_assignment_audit_inner_v1(p_data);
  v_record_id:=nullif(v_result->>'id','');
  if v_record_id is null then raise exception 'audit_result_invalid'; end if;
  v_employee_id:=nullif(v_result->>'employee_id','')::uuid;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,new_data,reason
  ) values(
    v_actor,v_employee_id,'exam','create_assignment',v_record_id,
    jsonb_strip_nulls(jsonb_build_object(
      'id',v_record_id,
      'title',v_result->>'title',
      'team_name',v_result->>'team_name',
      'position_name',v_result->>'position_name',
      'employee_id',v_result->>'employee_id',
      'duration_minutes',v_result->'duration_minutes',
      'pass_score',v_result->'pass_score',
      'start_at',v_result->>'start_at',
      'end_at',v_result->>'end_at',
      'max_attempts',v_result->'max_attempts',
      'status',v_result->>'status'
    )),
    '新增考试任务 · '||coalesce(nullif(v_result->>'title',''),v_record_id)
  );

  return v_result;
end;
$$;

create function public.admin_exam_save_assignment(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=(select auth.uid());
  v_employee_id uuid;
  v_is_update boolean:=nullif(btrim(p_data->>'id'),'') is not null;
  v_record_id text;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  -- The retained implementation performs the granular manage permission,
  -- previous-target scope, new-target scope and row-lock checks.
  v_result:=public.admin_exam_save_assignment_audit_inner_v1(p_data);
  v_record_id:=nullif(v_result->>'id','');
  if v_record_id is null then raise exception 'audit_result_invalid'; end if;
  v_employee_id:=nullif(v_result->>'employee_id','')::uuid;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,new_data,reason
  ) values(
    v_actor,v_employee_id,'exam',
    case when v_is_update then 'update_assignment' else 'create_assignment' end,
    v_record_id,
    jsonb_strip_nulls(jsonb_build_object(
      'id',v_record_id,
      'title',v_result->>'title',
      'team_name',v_result->>'team_name',
      'position_name',v_result->>'position_name',
      'employee_id',v_result->>'employee_id',
      'duration_minutes',v_result->'duration_minutes',
      'pass_score',v_result->'pass_score',
      'start_at',v_result->>'start_at',
      'end_at',v_result->>'end_at',
      'max_attempts',v_result->'max_attempts',
      'status',v_result->>'status'
    )),
    case when v_is_update then '编辑考试任务 · ' else '新增考试任务 · ' end
      ||coalesce(nullif(v_result->>'title',''),v_record_id)
  );

  return v_result;
end;
$$;

create function public.admin_connectivity_create(p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=(select auth.uid());
  v_employee_id uuid;
  v_record_id text;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  -- The retained public and private implementations preserve the create
  -- permission, employee-scope, incident validation and attachment guards.
  v_result:=public.admin_connectivity_create_audit_inner_v1(p_record);
  v_record_id:=nullif(v_result->>'id','');
  if v_record_id is null then raise exception 'audit_result_invalid'; end if;
  v_employee_id:=nullif(v_result->>'employee_id','')::uuid;
  if v_employee_id is null then raise exception 'audit_result_invalid'; end if;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,new_data,reason
  ) values(
    v_actor,v_employee_id,'connectivity','create_incident',v_record_id,
    jsonb_strip_nulls(jsonb_build_object(
      'id',v_record_id,
      'employee_id',v_result->>'employee_id',
      'employee_no',v_result->>'employee_no',
      'incident_date',p_record->>'incident_date',
      'incident_type',p_record->>'incident_type',
      'started_at',p_record->>'started_at',
      'ended_at',p_record->>'ended_at',
      'duration_minutes',v_result->'duration_minutes'
    )),
    '新增停电/断网记录 · '
      ||coalesce(nullif(v_result->>'employee_no',''),'—')
      ||' · '||coalesce(nullif(p_record->>'incident_date',''),'—')
  );

  return v_result;
end;
$$;

revoke all on function public.admin_exam_save_question(jsonb)
  from public,anon,authenticated;
revoke all on function public.admin_exam_create_assignment(jsonb)
  from public,anon,authenticated;
revoke all on function public.admin_exam_save_assignment(jsonb)
  from public,anon,authenticated;
revoke all on function public.admin_connectivity_create(jsonb)
  from public,anon,authenticated;

grant execute on function public.admin_exam_save_question(jsonb)
  to authenticated,service_role;
grant execute on function public.admin_exam_create_assignment(jsonb)
  to authenticated,service_role;
grant execute on function public.admin_exam_save_assignment(jsonb)
  to authenticated,service_role;
grant execute on function public.admin_connectivity_create(jsonb)
  to authenticated,service_role;

comment on function public.admin_exam_save_question(jsonb) is
  'Audited wrapper around the existing permission- and team-scope-checked question save.';
comment on function public.admin_exam_create_assignment(jsonb) is
  'Audited wrapper around the legacy permission- and target-scope-checked assignment create.';
comment on function public.admin_exam_save_assignment(jsonb) is
  'Audited wrapper around the existing permission- and target-scope-checked assignment save.';
comment on function public.admin_connectivity_create(jsonb) is
  'Audited wrapper around the existing permission-, validation- and employee-scope-checked connectivity create.';

notify pgrst,'reload schema';
commit;
