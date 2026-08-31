begin;

set local lock_timeout = '2s';
set local statement_timeout = '20s';

do $guard$
begin
  if to_regprocedure('public.admin_scope_effective_employee_ids(uuid)') is null
     or to_regprocedure('session_private.online_training_relationship_allows(uuid,uuid)') is null
     or to_regprocedure('session_private.online_training_context_stable_relationship_inner_v1()') is null
     or to_regprocedure('public.online_training_context()') is null
     or to_regprocedure('public.online_training_search_people(jsonb,integer,integer)') is null
     or to_regprocedure('public.online_training_search_trainers(jsonb,integer,integer)') is null then
    raise exception 'online_training_set_scope_prerequisite_missing';
  end if;
end
$guard$;

-- Return the same employee set as online_training_employee_in_scope(), but do
-- the session, role and scope lookups once per request rather than once for
-- every roster row.  The function remains private and is only called from the
-- existing SECURITY DEFINER RPCs after their normal permission gate.
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

  if v_role_code = 'founder' or v_data_scope = 'all' then
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

-- The two paginated directories currently build allowed_employee_ids by
-- calling online_training_employee_in_scope() once for every employee. Replace
-- only that CTE and leave filters, summaries, paging and output JSON untouched.
do $patch_search_scope$
declare
  v_signature regprocedure;
  v_definition text;
  v_patched text;
  v_old constant text := $old$select employee.id employee_id
    from public.employees employee
    where public.online_training_employee_in_scope(employee.id)$old$;
  v_new constant text := $new$select scope.employee_id
    from session_private.online_training_effective_employee_ids() scope$new$;
begin
  foreach v_signature in array array[
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'online_training_search_scope_shape_changed: %', v_signature;
    end if;
    v_patched := pg_catalog.replace(v_definition, v_old, v_new);
    if v_patched = v_definition
       or pg_catalog.strpos(v_patched, 'online_training_employee_in_scope(employee.id)') > 0 then
      raise exception 'online_training_search_scope_patch_failed: %', v_signature;
    end if;
    execute v_patched;
  end loop;
end
$patch_search_scope$;

-- The legacy inner context is still responsible for access metadata and
-- filter options. Its trainer roster is immediately replaced by the stable-ID
-- outer function, so avoid resolving every trainer name a second time.
do $patch_context_inner$
declare
  v_signature constant regprocedure :=
    'session_private.online_training_context_stable_relationship_inner_v1()'::regprocedure;
  v_definition text;
  v_patched text;
  v_roster_start integer;
  v_manager_start integer;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if pg_catalog.strpos(v_definition, 'and public.backend_employee_in_scope(employee.id)') = 0 then
    raise exception 'online_training_context_inner_scope_shape_changed';
  end if;

  v_patched := pg_catalog.replace(
    v_definition,
    'and public.backend_employee_in_scope(employee.id)',
    $replacement$and employee.id in (
        select visible.employee_id
        from session_private.online_training_effective_employee_ids() visible
      )$replacement$
  );

  v_roster_start := pg_catalog.strpos(
    v_patched,
    $marker$coalesce((
      select jsonb_agg(jsonb_build_object($marker$
  );
  v_manager_start := pg_catalog.strpos(
    v_patched,
    $marker$coalesce((
      select jsonb_agg(option.value order by option.value)$marker$
  );
  if v_roster_start = 0 or v_manager_start <= v_roster_start then
    raise exception 'online_training_context_inner_roster_shape_changed';
  end if;

  v_patched := pg_catalog.substring(v_patched, 1, v_roster_start - 1)
    || $replacement$'[]'::jsonb,
    $replacement$
    || pg_catalog.substring(v_patched, v_manager_start);

  if pg_catalog.strpos(v_patched, 'online_training_snapshot_employee_id(scoped.online_trainer)') > 0
     or pg_catalog.strpos(v_patched, 'online_training_effective_employee_ids()') = 0 then
    raise exception 'online_training_context_inner_patch_failed';
  end if;
  execute v_patched;
end
$patch_context_inner$;

-- The stable-ID outer context also used the scalar permission helper for the
-- assignment roster and for every manager option. Use the same set-valued
-- scope source while preserving the existing relationship and JSON logic.
do $patch_context_outer$
declare
  v_signature constant regprocedure := 'public.online_training_context()'::regprocedure;
  v_definition text;
  v_patched text;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if pg_catalog.strpos(v_definition, 'where public.online_training_employee_in_scope(employee.id);') = 0
     or pg_catalog.strpos(v_definition, 'and public.online_training_employee_in_scope(actor.actor_employee_id)') = 0 then
    raise exception 'online_training_context_outer_scope_shape_changed';
  end if;

  v_patched := pg_catalog.replace(
    v_definition,
    'where public.online_training_employee_in_scope(employee.id);',
    $replacement$where employee.id in (
      select visible.employee_id
      from session_private.online_training_effective_employee_ids() visible
    );$replacement$
  );
  v_patched := pg_catalog.replace(
    v_patched,
    'and public.online_training_employee_in_scope(actor.actor_employee_id)',
    $replacement$and actor.actor_employee_id in (
        select visible.employee_id
        from session_private.online_training_effective_employee_ids() visible
      )$replacement$
  );

  if pg_catalog.strpos(v_patched, 'online_training_employee_in_scope(employee.id)') > 0
     or pg_catalog.strpos(v_patched, 'online_training_employee_in_scope(actor.actor_employee_id)') > 0 then
    raise exception 'online_training_context_outer_patch_failed';
  end if;
  execute v_patched;
end
$patch_context_outer$;

do $verify$
declare
  v_signature regprocedure;
  v_definition text;
begin
  foreach v_signature in array array[
    'session_private.online_training_context_stable_relationship_inner_v1()'::regprocedure,
    'public.online_training_context()'::regprocedure,
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
    if pg_catalog.strpos(v_definition, 'online_training_effective_employee_ids()') = 0 then
      raise exception 'online_training_set_scope_verify_failed: %', v_signature;
    end if;
  end loop;
end
$verify$;

commit;
