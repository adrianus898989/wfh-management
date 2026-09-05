begin;

do $test_online_training_set_based_report_visibility$
declare
  v_helper text;
  v_people text;
  v_trainers text;
  v_reports text;
  v_scalar_scope text;
  v_set_scope text;
  v_member_index text;
  v_actor_index text;
  v_actor_call_count integer;
begin
  if to_regprocedure(
       'session_private.online_training_visible_published_report_ids(date,date)'
     ) is null then
    raise exception 'published report visibility helper is missing';
  end if;

  select pg_catalog.pg_get_functiondef(
    'session_private.online_training_visible_published_report_ids(date,date)'::regprocedure
  ) into v_helper;
  select pg_catalog.pg_get_functiondef(
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure
  ) into v_people;
  select pg_catalog.pg_get_functiondef(
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  ) into v_trainers;
  select pg_catalog.pg_get_functiondef(
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ) into v_reports;
  select pg_catalog.pg_get_functiondef(
    'public.online_training_employee_in_scope(uuid)'::regprocedure
  ) into v_scalar_scope;
  select pg_catalog.pg_get_functiondef(
    'session_private.online_training_effective_employee_ids()'::regprocedure
  ) into v_set_scope;

  if pg_catalog.strpos(
       v_scalar_scope,
       $shape$v_data_scope in ('all', 'own_team', 'assigned', 'assigned_teams')$shape$
     ) = 0
     or pg_catalog.strpos(
       v_set_scope,
       $shape$v_data_scope in ('all', 'own_team', 'assigned', 'assigned_teams')$shape$
     ) = 0
     or pg_catalog.strpos(
       v_scalar_scope,
       'admin_scope_effective_employee_ids(v_user_id)'
     ) = 0
     or pg_catalog.strpos(
       v_set_scope,
       'admin_scope_effective_employee_ids(v_user_id)'
     ) = 0 then
    raise exception 'scalar and set-valued canonical scopes diverged';
  end if;

  if pg_catalog.strpos(
       v_helper,
       'session_private.online_training_effective_employee_ids()'
     ) = 0
     or pg_catalog.strpos(v_helper, 'pg_catalog.bool_and') = 0
     or pg_catalog.strpos(v_helper, 'pg_catalog.bool_or') = 0
     or pg_catalog.strpos(v_helper, 'online_training_employee_in_scope') > 0
     or pg_catalog.strpos(v_helper, 'admin_scope_effective_employee_ids') > 0
     or pg_catalog.strpos(v_helper, 'online_training_relationship_allows') > 0 then
    raise exception 'published report helper does not preserve the canonical set boundary';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated',
       'session_private.online_training_visible_published_report_ids(date,date)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'session_private.online_training_visible_published_report_ids(date,date)',
       'execute'
     ) then
    raise exception 'published report visibility helper is browser executable';
  end if;

  if pg_catalog.strpos(
       v_people,
       'session_private.online_training_visible_published_report_ids('
     ) = 0
     or pg_catalog.strpos(
       v_trainers,
       'session_private.online_training_visible_published_report_ids('
     ) = 0
     or pg_catalog.strpos(
       v_reports,
       'session_private.online_training_visible_published_report_ids('
     ) = 0 then
    raise exception 'an online-training search RPC still lacks set visibility';
  end if;

  if pg_catalog.strpos(
       v_people,
       'public.online_training_can_view_report(report.id)'
     ) > 0
     or pg_catalog.strpos(
       v_trainers,
       'public.online_training_can_view_report(report.id)'
     ) > 0
     or pg_catalog.strpos(
       v_reports,
       'public.online_training_can_view_report(report.id)'
     ) > 0
     or pg_catalog.strpos(
       v_people,
       'public.online_training_caller_is_report_trainer(report.id)'
     ) > 0
     or pg_catalog.strpos(
       v_trainers,
       'public.online_training_caller_is_report_trainer(report.id)'
     ) > 0 then
    raise exception 'an unconditional per-report permission call remains';
  end if;

  v_actor_call_count := (
    pg_catalog.length(v_trainers)
    - pg_catalog.length(pg_catalog.replace(
      v_trainers,
      'session_private.online_training_roster_actor_label(',
      ''
    ))
  ) / pg_catalog.length(
    'session_private.online_training_roster_actor_label('
  );
  if v_actor_call_count <> 1
     or pg_catalog.strpos(v_trainers, 'actor_inputs as materialized') = 0
     or pg_catalog.strpos(
       v_trainers,
       'select distinct report.trainer_name, report.author_employee_no'
     ) = 0 then
    raise exception 'trainer actor labels are not deduplicated';
  end if;

  select pg_catalog.pg_get_indexdef(
    'public.online_training_report_members_report_employee_idx'::regclass
  ) into v_member_index;
  select pg_catalog.pg_get_indexdef(
    'public.employees_online_training_roster_actor_lookup_idx'::regclass
  ) into v_actor_index;
  if pg_catalog.strpos(v_member_index, '(report_id, employee_id)') = 0 then
    raise exception 'report member visibility index has the wrong column order';
  end if;
  if pg_catalog.strpos(v_actor_index, 'online_training_roster_name_key(full_name)') = 0
     or pg_catalog.strpos(v_actor_index, 'employee_master_normalize_id(employee_no)') = 0
     or pg_catalog.strpos(v_actor_index, 'INCLUDE (id, employee_no, full_name, hire_date)') = 0
     or pg_catalog.strpos(v_actor_index, 'active') = 0
     or pg_catalog.strpos(v_actor_index, 'probation') = 0 then
    raise exception 'roster actor resolver index is incomplete';
  end if;

  -- For a published report, the legacy caller-trainer branch implies both an
  -- allowed member and all members allowed.  This truth table proves that the
  -- set expression is identical after substituting that implication.
  if exists (
    select 1
    from (values
      (false, false, false, false),
      (false, false, false, true),
      (false, false, true, false),
      (false, false, true, true),
      (false, true, false, false),
      (false, true, false, true),
      (false, true, true, false),
      (false, true, true, true),
      (true, false, false, false),
      (true, false, false, true),
      (true, false, true, false),
      (true, false, true, true),
      (true, true, false, false),
      (true, true, false, true),
      (true, true, true, false),
      (true, true, true, true)
    ) scenario(founder, all_members_allowed, author_allowed, any_member_allowed)
    where (
      scenario.founder
      or (
        scenario.all_members_allowed
        and (
          (scenario.all_members_allowed and scenario.any_member_allowed)
          or scenario.author_allowed
          or scenario.any_member_allowed
        )
      )
    ) is distinct from (
      scenario.founder
      or (
        scenario.all_members_allowed
        and (scenario.author_allowed or scenario.any_member_allowed)
      )
    )
  ) then
    raise exception 'published report visibility truth table diverged';
  end if;
end;
$test_online_training_set_based_report_visibility$;

rollback;
