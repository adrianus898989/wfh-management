-- Disposable-database integration test. Every data mutation is rolled back.
begin;

insert into public.employees (
  id, employee_no, full_name, status, source_type, source_sheet
) values
  ('00000000-0000-4000-8000-000000000301', 'SR-LEADER', '__SR_LEADER__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000302', 'SR-TRAINER-A', '__SR_TRAINER_A__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000303', 'SR-TRAINER-B', '__SR_TRAINER_B__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000304', 'SR-LEARNER-A', '__SR_LEARNER_A__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000305', 'SR-LEARNER-B', '__SR_LEARNER_B__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000306', 'SR-OUTSIDER', '__SR_OUTSIDER__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000307', 'SR-DUPLICATE', '__SR_DUPLICATE__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000308', 'SR-NEW-LEARNER', '__SR_NEW_LEARNER__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000309', 'SR-ONSITE', '__SR_ONSITE__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000310', 'SR-RESPONSIBLE', '__SR_RESPONSIBLE__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000311', 'SR-ONSITE-LEARNER', '__SR_ONSITE_LEARNER__', 'active', 'schedule_temp', 'test'),
  ('00000000-0000-4000-8000-000000000312', 'SR-C-ONLY', '__SR_C_ONLY__', 'active', 'schedule_temp', 'test');

do $test$
declare
  v_leader constant uuid := '00000000-0000-4000-8000-000000000301';
  v_trainer_a constant uuid := '00000000-0000-4000-8000-000000000302';
  v_trainer_b constant uuid := '00000000-0000-4000-8000-000000000303';
  v_learner_a constant uuid := '00000000-0000-4000-8000-000000000304';
  v_learner_b constant uuid := '00000000-0000-4000-8000-000000000305';
  v_outsider constant uuid := '00000000-0000-4000-8000-000000000306';
  v_new_learner constant uuid := '00000000-0000-4000-8000-000000000308';
  v_onsite constant uuid := '00000000-0000-4000-8000-000000000309';
  v_responsible constant uuid := '00000000-0000-4000-8000-000000000310';
  v_onsite_learner constant uuid := '00000000-0000-4000-8000-000000000311';
  v_c_only constant uuid := '00000000-0000-4000-8000-000000000312';
  v_rows jsonb;
  v_definition text;
  v_healthy_count integer;
begin
  if session_private.online_training_roster_name_key('  Ana   Marie  ')
      <> 'ana marie' then
    raise exception 'strict roster key did not normalize case/whitespace';
  end if;
  if session_private.online_training_roster_name_key('Ana-Marie') =
      session_private.online_training_roster_name_key('Ana Marie') then
    raise exception 'strict roster key erased punctuation';
  end if;

  v_rows := jsonb_build_array(
    jsonb_build_object('source_row', 2, 'employee_id', 'SR-LEADER', 'name', '__SR_LEADER__'),
    jsonb_build_object('source_row', 3, 'employee_id', 'SR-TRAINER-A', 'name', '__SR_TRAINER_A__', 'online_leader', '__SR_LEADER__'),
    jsonb_build_object('source_row', 4, 'employee_id', 'SR-TRAINER-B', 'name', '__SR_TRAINER_B__', 'online_leader', '__SR_LEADER__'),
    jsonb_build_object('source_row', 5, 'employee_id', 'SR-LEARNER-A', 'name', '__SR_LEARNER_A__', 'online_leader', '__SR_LEADER__', 'online_trainer', '__SR_TRAINER_A__', 'team', 'TEAM-A', 'position', '客服'),
    jsonb_build_object('source_row', 6, 'employee_id', 'SR-LEARNER-B', 'name', '__SR_LEARNER_B__', 'online_leader', '__SR_LEADER__', 'online_trainer', '__SR_TRAINER_B__', 'team', 'TEAM-A', 'position', '客服'),
    jsonb_build_object('source_row', 7, 'employee_id', 'SR-OUTSIDER', 'name', '__SR_OUTSIDER__'),
    jsonb_build_object('source_row', 8, 'employee_id', 'SR-ONSITE', 'name', '__SR_ONSITE__'),
    jsonb_build_object('source_row', 9, 'employee_id', 'SR-RESPONSIBLE', 'name', '__SR_RESPONSIBLE__'),
    jsonb_build_object('source_row', 10, 'employee_id', 'SR-ONSITE-LEARNER', 'name', '__SR_ONSITE_LEARNER__', 'responsible', '__SR_RESPONSIBLE__', 'onsite_trainer', '__SR_ONSITE__', 'position', '普通客服'),
    jsonb_build_object('source_row', 11, 'employee_id', 'SR-C-ONLY', 'name', '__SR_C_ONLY__', 'online_leader', '__SR_LEADER__', 'online_trainer', '', 'position', '普通客服')
  );
  perform session_private.rebuild_online_training_roster_relationships(v_rows);

  if not session_private.online_training_relationship_allows(v_trainer_a, v_learner_a) then
    raise exception 'trainer did not receive its direct learner';
  end if;
  if session_private.online_training_relationship_allows(v_trainer_a, v_learner_b) then
    raise exception 'trainer received sibling trainer learner';
  end if;
  if session_private.online_training_relationship_allows(v_trainer_a, v_outsider) then
    raise exception 'trainer received unrelated employee';
  end if;
  if not session_private.online_training_relationship_allows(v_leader, v_trainer_a)
     or not session_private.online_training_relationship_allows(v_leader, v_trainer_b) then
    raise exception 'leader did not receive its subordinate online trainers';
  end if;
  if not session_private.online_training_relationship_allows(v_leader, v_learner_a)
     or not session_private.online_training_relationship_allows(v_leader, v_learner_b) then
    raise exception 'leader did not receive learners below its resolved trainers';
  end if;
  if session_private.online_training_relationship_allows(v_leader, v_c_only) then
    raise exception 'leader received a C-only learner without a resolved D trainer';
  end if;
  if not session_private.online_training_relationship_allows(
      v_onsite,
      v_onsite_learner
    ) then
    raise exception 'onsite trainer did not receive its direct employee';
  end if;
  if session_private.online_training_relationship_allows(
      v_responsible,
      v_onsite_learner
    ) then
    raise exception 'responsible column unexpectedly became a report permission edge';
  end if;
  if session_private.online_training_relationship_allows(v_outsider, v_learner_a) then
    raise exception 'unrelated employee crossed stable relationship boundary';
  end if;
  if not exists (
    select 1
    from session_private.online_training_assignment_targets(v_leader) target
    where target.target_employee_id = v_trainer_a
  ) or exists (
    select 1
    from session_private.online_training_assignment_targets(v_leader) target
    where target.target_employee_id in (v_learner_a, v_learner_b, v_c_only)
  ) then
    raise exception 'leader report subjects were not limited to its D trainers';
  end if;
  if not exists (
    select 1
    from session_private.online_training_assignment_targets(v_onsite) target
    where target.target_employee_id = v_onsite_learner
  ) then
    raise exception 'onsite trainer report subject did not follow B to G';
  end if;

  if not exists (
    select 1
    from session_private.online_training_roster_relationships relation
    where relation.learner_employee_id = v_learner_a
      and relation.online_trainer_employee_id = v_trainer_a
      and relation.online_leader_employee_id = v_leader
      and relation.learner_employee_no = 'SR-LEARNER-A'
  ) then
    raise exception 'C/D relationship was not persisted as stable UUIDs';
  end if;
  if not exists (
    select 1
    from session_private.online_training_roster_relationships relation
    where relation.learner_employee_id = v_onsite_learner
      and relation.responsible_employee_id = v_responsible
      and relation.onsite_trainer_employee_id = v_onsite
  ) then
    raise exception 'A/B relationship was not persisted as stable UUIDs';
  end if;

  select count(*)::integer
  into v_healthy_count
  from session_private.online_training_roster_relationships;
  begin
    perform session_private.rebuild_online_training_roster_relationships(
      '[]'::jsonb
    );
    raise exception 'empty relationship replacement unexpectedly succeeded';
  exception
    when sqlstate '22023' then null;
  end;
  if (select count(*) from session_private.online_training_roster_relationships)
      <> v_healthy_count then
    raise exception 'empty replacement erased the last healthy hierarchy';
  end if;
  begin
    perform session_private.rebuild_online_training_roster_relationships(
      jsonb_set(v_rows, '{0,name}', to_jsonb('正在加载'::text))
    );
    raise exception 'formula-loading relationship replacement unexpectedly succeeded';
  exception
    when sqlstate '22023' then null;
  end;
  if (select count(*) from session_private.online_training_roster_relationships)
      <> v_healthy_count then
    raise exception 'formula-loading replacement erased the last healthy hierarchy';
  end if;

  -- A new employee appears on the next accepted roster without any manual ACL
  -- write and becomes visible only through the matching trainer/leader chain.
  v_rows := v_rows || jsonb_build_array(
    jsonb_build_object('source_row', 12, 'employee_id', 'SR-NEW-LEARNER', 'name', '__SR_NEW_LEARNER__', 'online_leader', '__SR_LEADER__', 'online_trainer', '__SR_TRAINER_A__')
  );
  perform session_private.rebuild_online_training_roster_relationships(v_rows);
  if not session_private.online_training_relationship_allows(v_trainer_a, v_new_learner)
     or not session_private.online_training_relationship_allows(v_leader, v_new_learner) then
    raise exception 'new roster learner did not inherit stable hierarchy';
  end if;

  -- Rename and team/position transfer preserve the same UUID edge only when
  -- the authoritative manager row and C/D references agree in one snapshot.
  v_rows := jsonb_build_array(
    jsonb_build_object('source_row', 2, 'employee_id', 'SR-LEADER', 'name', '__SR_LEADER__'),
    jsonb_build_object('source_row', 3, 'employee_id', 'SR-TRAINER-A', 'name', '__SR_TRAINER_A_RENAMED__', 'online_leader', '__SR_LEADER__'),
    jsonb_build_object('source_row', 5, 'employee_id', 'SR-LEARNER-A', 'name', '__SR_LEARNER_A__', 'online_leader', '__SR_LEADER__', 'online_trainer', '__SR_TRAINER_A_RENAMED__', 'team', 'TEAM-B', 'position', '质检')
  );
  perform session_private.rebuild_online_training_roster_relationships(v_rows);
  if not session_private.online_training_relationship_allows(v_trainer_a, v_learner_a) then
    raise exception 'rename/transfer changed stable trainer UUID relationship';
  end if;

  -- Same exact current-roster name on two UUIDs is ambiguous and must fail
  -- closed rather than guessing by employee table order.
  v_rows := jsonb_build_array(
    jsonb_build_object('source_row', 2, 'employee_id', 'SR-LEADER', 'name', '__SR_LEADER__'),
    jsonb_build_object('source_row', 3, 'employee_id', 'SR-TRAINER-A', 'name', '__SR_DUPLICATE_NAME__'),
    jsonb_build_object('source_row', 4, 'employee_id', 'SR-DUPLICATE', 'name', '__SR_DUPLICATE_NAME__'),
    jsonb_build_object('source_row', 5, 'employee_id', 'SR-LEARNER-A', 'name', '__SR_LEARNER_A__', 'online_leader', '__SR_LEADER__', 'online_trainer', '__SR_DUPLICATE_NAME__')
  );
  perform session_private.rebuild_online_training_roster_relationships(v_rows);
  if exists (
    select 1
    from session_private.online_training_roster_relationships relation
    where relation.learner_employee_id = v_learner_a
      and relation.online_trainer_employee_id is not null
  ) then
    raise exception 'duplicate trainer name did not fail closed';
  end if;
  if session_private.online_training_relationship_allows(v_trainer_a, v_learner_a) then
    raise exception 'ambiguous trainer retained learner access';
  end if;
  if session_private.online_training_relationship_allows(v_leader, v_learner_a) then
    raise exception 'leader fell back to learner when D trainer was ambiguous';
  end if;

  -- Removing D revokes the trainer edge on that same rebuild; there is no stale
  -- name-derived fallback. C alone never grants access to G learners.
  v_rows := jsonb_build_array(
    jsonb_build_object('source_row', 2, 'employee_id', 'SR-LEADER', 'name', '__SR_LEADER__'),
    jsonb_build_object('source_row', 3, 'employee_id', 'SR-TRAINER-A', 'name', '__SR_TRAINER_A__', 'online_leader', '__SR_LEADER__'),
    jsonb_build_object('source_row', 5, 'employee_id', 'SR-LEARNER-A', 'name', '__SR_LEARNER_A__', 'online_leader', '__SR_LEADER__', 'online_trainer', '')
  );
  perform session_private.rebuild_online_training_roster_relationships(v_rows);
  if session_private.online_training_relationship_allows(v_trainer_a, v_learner_a) then
    raise exception 'removed online trainer retained stale learner access';
  end if;
  if session_private.online_training_relationship_allows(v_leader, v_learner_a)
     or session_private.online_training_relationship_allows(v_leader, v_trainer_a) then
    raise exception 'removed D retained a leader report target';
  end if;

  select pg_get_functiondef(
    'public.online_training_employee_in_scope(uuid)'::regprocedure
  ) into v_definition;
  if position('public.backend_employee_in_scope(p_employee_id)' in v_definition) = 0
     or position('session_private.online_training_relationship_allows' in v_definition) = 0
     or position('v_data_scope = ''all''' in v_definition) = 0 then
    raise exception 'public scope lost stable relationship or explicit full-scope ceiling';
  end if;
  if position(
    'or not public.backend_employee_in_scope(p_employee_id)'
    in v_definition
  ) <> 0 then
    raise exception 'self-scoped training actor is still blocked before roster relationship evaluation';
  end if;
  select pg_get_functiondef(
    'public.online_training_is_assigned_member(uuid)'::regprocedure
  ) into v_definition;
  if position('session_private.online_training_assignment_targets' in v_definition) = 0
     or position('backend_employee_in_scope' in v_definition) <> 0 then
    raise exception 'training assignment helper still intersects generic backend scope';
  end if;

  select pg_get_functiondef(
    'public.online_training_save_report(jsonb,jsonb)'::regprocedure
  ) into v_definition;
  if position('session_private.online_training_assignment_targets' in v_definition) = 0
     or position('public.online_training_employee_in_scope' in v_definition) = 0
     or position('v_data_scope <> ''all''' in v_definition) = 0 then
    raise exception 'report mutation boundary lost stable subject enforcement';
  end if;
  select pg_get_functiondef(
    'session_private.online_training_save_report_scope_legacy(jsonb,jsonb)'::regprocedure
  ) into v_definition;
  if position('未配置当前账号可填报的培训关系' in v_definition) = 0
     or position('session_private.online_training_assignment_targets' in v_definition) = 0 then
    raise exception 'retained report writer still rejects valid B or C subjects';
  end if;

  foreach v_definition in array array[
    pg_get_functiondef('public.online_training_search_people(jsonb,integer,integer)'::regprocedure),
    pg_get_functiondef('public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure)
  ] loop
    if position('public.online_training_employee_in_scope(employee.id)' in v_definition) = 0 then
      raise exception 'paginated online-training directory bypassed stable scope';
    end if;
  end loop;

  if has_table_privilege(
      'authenticated',
      'session_private.online_training_roster_relationships',
      'SELECT'
    ) then
    raise exception 'authenticated role can read private relationship table';
  end if;
  if has_function_privilege(
      'service_role',
      'session_private.rebuild_online_training_roster_relationships(jsonb)',
      'EXECUTE'
    ) then
    raise exception 'service role can bypass guarded sync wrapper';
  end if;
end;
$test$;

rollback;
