begin;

set local lock_timeout = '2s';
set local statement_timeout = '20s';

do $guard$
begin
  if to_regprocedure('public.admin_scope_effective_employee_ids(uuid)') is null
     or to_regprocedure('session_private.online_training_relationship_allows(uuid,uuid)') is null
     or to_regprocedure('session_private.online_training_assignment_targets(uuid)') is null
     or to_regprocedure('session_private.online_training_effective_employee_ids()') is null
     or to_regprocedure('public.online_training_employee_in_scope(uuid)') is null then
    raise exception 'online_training_manager_team_scope_prerequisite_missing';
  end if;
end
$guard$;

-- Team-scoped managers use the canonical backend scope that was saved for the
-- account. This preserves the selected-team hard ceiling and any optional
-- position narrowing. Self-scoped training actors keep the stable B/C/D
-- relationship rules.
create or replace function session_private.online_training_effective_employee_ids()
returns table(employee_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_data_scope text;
  v_role_code text;
begin
  if not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return;
  end if;

  select access.employee_id, access.data_scope, role.code
  into v_caller_employee_id, v_data_scope, v_role_code
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then return; end if;

  if v_role_code = 'founder'
     or v_data_scope in ('all', 'own_team', 'assigned', 'assigned_teams') then
    return query
    select scope.employee_id
    from public.admin_scope_effective_employee_ids(v_user_id) scope;
    return;
  end if;

  return query
  select allowed.employee_id
  from (
    select v_caller_employee_id employee_id
    where v_caller_employee_id is not null
    union
    select relation.learner_employee_id
    from session_private.online_training_roster_relationships relation
    where relation.learner_employee_id is not null
      and (
        relation.onsite_trainer_employee_id = v_caller_employee_id
        or relation.online_trainer_employee_id = v_caller_employee_id
        or (
          relation.online_leader_employee_id = v_caller_employee_id
          and relation.online_trainer_employee_id is not null
        )
      )
    union
    select relation.online_trainer_employee_id
    from session_private.online_training_roster_relationships relation
    where relation.online_trainer_employee_id is not null
      and relation.online_leader_employee_id = v_caller_employee_id
  ) allowed;
end;
$$;

revoke all on function session_private.online_training_effective_employee_ids()
  from public, anon, authenticated, service_role;

create or replace function public.online_training_employee_in_scope(
  p_employee_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_data_scope text;
  v_role_code text;
begin
  if p_employee_id is null
     or not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return false;
  end if;

  select access.employee_id, access.data_scope, role.code
  into v_caller_employee_id, v_data_scope, v_role_code
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then return false; end if;

  if v_role_code = 'founder'
     or v_data_scope in ('all', 'own_team', 'assigned', 'assigned_teams') then
    return exists (
      select 1
      from public.admin_scope_effective_employee_ids(v_user_id) scope
      where scope.employee_id = p_employee_id
    );
  end if;

  return session_private.online_training_relationship_allows(
    v_caller_employee_id,
    p_employee_id
  );
end;
$$;

revoke all on function public.online_training_employee_in_scope(uuid)
  from public, anon;
grant execute on function public.online_training_employee_in_scope(uuid)
  to authenticated, service_role;

-- Report subjects remain relationship-specific. For the signed-in own-team
-- or assigned-team manager, intersect those relationships with the canonical
-- account scope so no target can leak across the configured team boundary.
create or replace function session_private.online_training_assignment_targets(
  p_actor_employee_id uuid
)
returns table(target_employee_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_data_scope text;
begin
  select access.employee_id, access.data_scope
  into v_caller_employee_id, v_data_scope
  from public.user_access access
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if found
     and p_actor_employee_id = v_caller_employee_id
     and v_data_scope in ('own_team', 'assigned', 'assigned_teams') then
    return query
    select distinct assignment.target_employee_id
    from (
      select relation.learner_employee_id target_employee_id
      from session_private.online_training_roster_relationships relation
      where relation.onsite_trainer_employee_id = p_actor_employee_id
         or relation.online_trainer_employee_id = p_actor_employee_id

      union all

      select relation.online_trainer_employee_id target_employee_id
      from session_private.online_training_roster_relationships relation
      where relation.online_leader_employee_id = p_actor_employee_id
        and relation.online_trainer_employee_id is not null
    ) assignment
    join public.admin_scope_effective_employee_ids(v_user_id) scope
      on scope.employee_id = assignment.target_employee_id
    where assignment.target_employee_id is not null;
    return;
  end if;

  return query
  select distinct assignment.target_employee_id
  from (
    select relation.learner_employee_id target_employee_id
    from session_private.online_training_roster_relationships relation
    where relation.onsite_trainer_employee_id = p_actor_employee_id
       or relation.online_trainer_employee_id = p_actor_employee_id

    union all

    select relation.online_trainer_employee_id target_employee_id
    from session_private.online_training_roster_relationships relation
    where relation.online_leader_employee_id = p_actor_employee_id
      and relation.online_trainer_employee_id is not null
  ) assignment
  where p_actor_employee_id is not null
    and assignment.target_employee_id is not null;
end;
$$;

revoke all on function
  session_private.online_training_assignment_targets(uuid)
  from public, anon, authenticated, service_role;

comment on function public.online_training_employee_in_scope(uuid) is
  'Online-training scope: founder/all and configured own/assigned-team managers use canonical backend scope; self-scoped training actors use stable roster relationships.';
comment on function session_private.online_training_assignment_targets(uuid) is
  'Report targets: own/assigned-team managers use stable roster assignments intersected with canonical backend scope; self-scoped actors use stable assignments.';
comment on function public.online_training_is_assigned_member(uuid) is
  'Online-training report-subject helper: team-scoped managers use stable roster assignments inside canonical scope; self-scoped actors use stable assignments.';
comment on function public.online_training_save_report(jsonb,jsonb) is
  'Online-training mutation boundary: every member must be readable and belong to the caller stable roster assignment, constrained by canonical team scope when configured.';

do $verify$
declare
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'session_private.online_training_effective_employee_ids()'::regprocedure
  ) into v_definition;
  if pg_catalog.strpos(
       v_definition,
       $needle$v_data_scope in ('all', 'own_team', 'assigned', 'assigned_teams')$needle$
     ) = 0
     or pg_catalog.strpos(v_definition, 'admin_scope_effective_employee_ids(v_user_id)') = 0 then
    raise exception 'online_training_manager_effective_scope_verify_failed';
  end if;

  select pg_catalog.pg_get_functiondef(
    'session_private.online_training_assignment_targets(uuid)'::regprocedure
  ) into v_definition;
  if pg_catalog.strpos(
       v_definition,
       $needle$v_data_scope in ('own_team', 'assigned', 'assigned_teams')$needle$
     ) = 0
     or pg_catalog.strpos(v_definition, 'p_actor_employee_id = v_caller_employee_id') = 0
     or pg_catalog.strpos(v_definition, 'admin_scope_effective_employee_ids(v_user_id)') = 0 then
    raise exception 'online_training_manager_assignment_scope_verify_failed';
  end if;
end
$verify$;

commit;
