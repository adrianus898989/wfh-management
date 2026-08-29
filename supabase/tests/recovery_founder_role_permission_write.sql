-- Run against a disposable database after every migration.  The production
-- recovery writer must stay service-only, Founder-rechecked, bounded and
-- atomic with its audit row.
begin;

set local search_path = pg_catalog;

do $contract$
declare
  v_function regprocedure :=
    'public.admin_recovery_save_role_permissions(uuid,uuid,uuid[])'::regprocedure;
  v_definition text := pg_get_functiondef(v_function);
  v_config text[] := (
    select coalesce(procedure.proconfig, '{}'::text[])
    from pg_proc procedure
    where procedure.oid = v_function
  );
begin
  if not ('statement_timeout=3500ms' = any(v_config))
     or not ('lock_timeout=1500ms' = any(v_config))
     or position('cardinality(v_input_ids) > 500' in v_definition) = 0 then
    raise exception 'recovery role permission writer lost a hard runtime or size bound';
  end if;

  if position('v_actor_role_code <> ''founder''' in v_definition) = 0
     or position('for no key update' in lower(v_definition)) = 0
     or position('v_target_role_code = ''founder''' in v_definition) = 0
     or position('v_target_system_locked' in v_definition) = 0
     or position('not v_target_active' in v_definition) = 0 then
    raise exception 'recovery role permission writer lost Founder or target-role guards';
  end if;

  if position('''adjustment.page.approve''' in v_definition) = 0
     or position('''role.manage''' in v_definition) = 0 then
    raise exception 'recovery role permission writer lost a hidden implementation permission';
  end if;

  if position('insert into public.role_permissions' in v_definition) = 0
     or position('delete from public.role_permissions' in v_definition) = 0
     or position('insert into public.audit_logs' in v_definition) = 0
     or position('''role_permissions_update''' in v_definition) = 0 then
    raise exception 'permission diff and audit must remain in one database function';
  end if;

  if position('public.employees' in v_definition) > 0
     or position('public.teams' in v_definition) > 0
     or position('public.positions' in v_definition) > 0
     or position('public.user_scope_employees' in v_definition) > 0
     or position('current_employee_scope_directory' in v_definition) > 0 then
    raise exception 'recovery role permission writer must not scan an employee or scope directory';
  end if;

  if has_function_privilege('anon', v_function, 'execute')
     or has_function_privilege('authenticated', v_function, 'execute')
     or not has_function_privilege('service_role', v_function, 'execute') then
    raise exception 'recovery role permission writer execute boundary changed';
  end if;

  if not exists (
    select 1
    from pg_proc procedure
    where procedure.oid = v_function
      and procedure.prosecdef
      and procedure.provolatile = 'v'
  ) then
    raise exception 'recovery role permission writer must remain a volatile security-definer function';
  end if;
end
$contract$;

do $non_founder_denied$
begin
  begin
    perform public.admin_recovery_save_role_permissions(
      '00000000-0000-4000-8000-00000000f901'::uuid,
      '00000000-0000-4000-8000-00000000f902'::uuid,
      '{}'::uuid[]
    );
    raise exception 'missing actor unexpectedly saved role permissions';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'founder_required' then
        raise;
      end if;
  end;
end
$non_founder_denied$;

-- If the disposable snapshot includes its normal Founder account, confirm an
-- unchanged save is idempotent and does not emit a misleading audit row.
do $idempotent$
declare
  v_actor uuid;
  v_target uuid;
  v_before bigint;
  v_after bigint;
  v_permission_ids uuid[];
  v_result jsonb;
begin
  select access.auth_user_id
  into v_actor
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.active
    and access.backend_enabled
    and role.active
    and role.code = 'founder'
  order by access.auth_user_id
  limit 1;

  select role.id
  into v_target
  from public.roles role
  where role.code <> 'founder'
    and role.active
    and not role.system_locked
  order by role.id
  limit 1;

  if v_actor is null or v_target is null then
    return;
  end if;

  select coalesce(array_agg(permission_id order by permission_id), '{}'::uuid[])
  into v_permission_ids
  from public.role_permissions
  where role_id = v_target;

  select count(*) into v_before
  from public.audit_logs audit
  where audit.actor_user_id = v_actor
    and audit.action = 'role_permissions_update'
    and audit.record_id = v_target::text;

  v_result := public.admin_recovery_save_role_permissions(v_actor, v_target, v_permission_ids);
  if coalesce((v_result ->> 'changed')::boolean, true) then
    -- Existing roles can contain hidden dependency grants, so this assertion is
    -- applicable only when the canonicalizer considered the input unchanged.
    return;
  end if;

  select count(*) into v_after
  from public.audit_logs audit
  where audit.actor_user_id = v_actor
    and audit.action = 'role_permissions_update'
    and audit.record_id = v_target::text;

  if v_after <> v_before then
    raise exception 'idempotent permission save wrote an audit row';
  end if;
end
$idempotent$;

rollback;
