begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('scope_private.recovery_backend_action_allowed(uuid,uuid,text)') is null then
    raise exception 'recovery_backend_action_allowed_missing';
  end if;
  if to_regprocedure('public.admin_save_account_access_scope(uuid,uuid,uuid,text,uuid[],uuid[],uuid[])') is null then
    raise exception 'admin_save_account_access_scope_missing';
  end if;
  if to_regclass('public.backend_role_assignment_rules') is null then
    raise exception 'backend_role_assignment_rules_missing';
  end if;
end;
$$;

create or replace function public.admin_recovery_update_backend_account(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_employee_id uuid,
  p_role_id uuid,
  p_data_scope text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '4500ms'
set lock_timeout = '1500ms'
as $$
declare
  v_actor_employee_id uuid;
  v_actor_role_id uuid;
  v_actor_role_code text;
  v_actor_scope text;
  v_target_employee_id uuid;
  v_target_role_id uuid;
  v_target_role_code text;
  v_target_scope text;
  v_new_role_code text;
  v_actor_permission_ids uuid[] := '{}'::uuid[];
  v_new_role_permission_ids uuid[] := '{}'::uuid[];
  v_new_target_permission_ids uuid[] := '{}'::uuid[];
  v_team_ids uuid[] := '{}'::uuid[];
  v_position_ids uuid[] := '{}'::uuid[];
  v_employee_ids uuid[] := '{}'::uuid[];
  v_actor_has_wildcard boolean := false;
  v_actor_has_edit boolean := false;
  v_actor_has_scope_manage boolean := false;
  v_subset boolean := false;
  v_strictly_lower boolean := false;
  v_explicitly_delegated boolean := false;
  v_target_has_override_expansion boolean := false;
  v_preserve_assigned boolean := false;
  v_role_changed boolean := false;
  v_scope_changed boolean := false;
  v_session_revoked boolean := false;
  v_saved jsonb;
begin
  if p_actor_user_id is null or p_target_user_id is null or p_role_id is null
     or p_data_scope is null then
    raise exception using errcode = '22023', message = 'invalid_account_edit';
  end if;
  if p_actor_user_id = p_target_user_id then
    raise exception using errcode = '22023', message = 'cannot_edit_current_account';
  end if;
  if p_data_scope not in ('all', 'self', 'own_team', 'assigned_teams') then
    raise exception using errcode = '22023', message = 'invalid_account_scope';
  end if;

  -- Serialize both identities before any authorization decision. The Edge
  -- preflight is advisory; this transaction is the final authority.
  perform 1
  from public.user_access access
  where access.auth_user_id in (p_actor_user_id, p_target_user_id)
  order by access.auth_user_id
  for update;

  select actor.employee_id, actor.role_id, actor_role.code, actor.data_scope
  into v_actor_employee_id, v_actor_role_id, v_actor_role_code, v_actor_scope
  from public.user_access actor
  join public.roles actor_role on actor_role.id = actor.role_id and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;

  select target.employee_id, target.role_id, target_role.code, target.data_scope
  into v_target_employee_id, v_target_role_id, v_target_role_code, v_target_scope
  from public.user_access target
  join public.roles target_role on target_role.id = target.role_id and target_role.active = true
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = true
  limit 1;
  if not found then
    raise exception using errcode = 'P0002', message = 'backend_account_not_found';
  end if;
  if v_target_role_code = 'founder' then
    raise exception using errcode = '42501', message = 'founder_target_protected';
  end if;
  if v_target_employee_id is distinct from p_employee_id then
    raise exception using errcode = '22023', message = 'employee_relink_temporarily_paused';
  end if;

  select role.code
  into v_new_role_code
  from public.roles role
  where role.id = p_role_id
    and role.active = true
    and role.code not in ('founder', 'employee')
  limit 1;
  if not found then
    raise exception using errcode = '22023', message = 'role_not_available';
  end if;

  select coalesce(array_agg(effective.permission_id), '{}'::uuid[])
  into v_actor_permission_ids
  from (
    select role_permission.permission_id
    from public.role_permissions role_permission
    where role_permission.role_id = v_actor_role_id
    union
    select override.permission_id
    from public.user_permission_overrides override
    where override.auth_user_id = p_actor_user_id and override.allowed = true
    except
    select override.permission_id
    from public.user_permission_overrides override
    where override.auth_user_id = p_actor_user_id and override.allowed = false
  ) effective;

  select
    exists (
      select 1
      from unnest(v_actor_permission_ids) item(permission_id)
      join public.permissions permission on permission.id = item.permission_id
      where permission.code = '*'
    ),
    exists (
      select 1
      from unnest(v_actor_permission_ids) item(permission_id)
      join public.permissions permission on permission.id = item.permission_id
      where permission.code in ('*', 'account.edit')
    ),
    exists (
      select 1
      from unnest(v_actor_permission_ids) item(permission_id)
      join public.permissions permission on permission.id = item.permission_id
      where permission.code in ('*', 'scope.manage')
    )
  into v_actor_has_wildcard, v_actor_has_edit, v_actor_has_scope_manage;

  if not v_actor_has_edit
     or not scope_private.recovery_backend_action_allowed(
       p_actor_user_id, p_target_user_id, 'account.edit'
     ) then
    raise exception using errcode = '42501', message = 'permission_or_scope_denied';
  end if;

  select coalesce(array_agg(role_permission.permission_id), '{}'::uuid[])
  into v_new_role_permission_ids
  from public.role_permissions role_permission
  where role_permission.role_id = p_role_id;

  select coalesce(array_agg(effective.permission_id), '{}'::uuid[])
  into v_new_target_permission_ids
  from (
    select role_permission.permission_id
    from public.role_permissions role_permission
    where role_permission.role_id = p_role_id
    union
    select override.permission_id
    from public.user_permission_overrides override
    where override.auth_user_id = p_target_user_id and override.allowed = true
    except
    select override.permission_id
    from public.user_permission_overrides override
    where override.auth_user_id = p_target_user_id and override.allowed = false
  ) effective;

  if v_actor_role_code <> 'founder' and not v_actor_has_wildcard then
    select
      not exists (
        select 1
        from unnest(v_new_target_permission_ids) target_permission(permission_id)
        where not (target_permission.permission_id = any(v_actor_permission_ids))
      ),
      exists (
        select 1
        from unnest(v_actor_permission_ids) actor_permission(permission_id)
        where not (actor_permission.permission_id = any(v_new_target_permission_ids))
      ),
      exists (
        select 1
        from public.backend_role_assignment_rules assignment
        where assignment.grantor_role_id = v_actor_role_id
          and assignment.target_role_id = p_role_id
          and assignment.active = true
      ),
      exists (
        select 1
        from unnest(v_new_target_permission_ids) target_permission(permission_id)
        where not (target_permission.permission_id = any(v_new_role_permission_ids))
      )
    into v_subset, v_strictly_lower, v_explicitly_delegated, v_target_has_override_expansion;

    if not ((v_subset and v_strictly_lower)
      or (v_explicitly_delegated and not v_target_has_override_expansion)) then
      raise exception using errcode = '42501', message = 'role_not_assignable';
    end if;
  end if;

  v_role_changed := v_target_role_id is distinct from p_role_id;
  v_scope_changed := v_target_scope is distinct from p_data_scope;
  v_preserve_assigned := v_target_scope = 'assigned_teams'
    and p_data_scope = 'assigned_teams';

  if v_scope_changed and not v_actor_has_scope_manage then
    raise exception using errcode = '42501', message = 'scope_manage_required';
  end if;
  if p_data_scope in ('self', 'own_team') and p_employee_id is null then
    raise exception using errcode = '22023', message = 'employee_required';
  end if;
  if p_data_scope in ('self', 'own_team') and not exists (
    select 1
    from public.employees employee
    where employee.id = p_employee_id
      and employee.status = 'active'
  ) then
    raise exception using errcode = '22023', message = 'linked_employee_not_active';
  end if;
  if v_actor_role_code = 'founder' then
    if p_data_scope not in ('all', 'self', 'own_team') and not v_preserve_assigned then
      raise exception using errcode = '42501', message = 'recovery_scope_not_delegable';
    end if;
  else
    if v_actor_scope is distinct from 'all'
       or (p_data_scope not in ('self', 'own_team') and not v_preserve_assigned) then
      raise exception using errcode = '42501', message = 'recovery_scope_not_delegable';
    end if;
  end if;

  if v_preserve_assigned then
    select coalesce(array_agg(filter.team_id order by filter.team_id), '{}'::uuid[])
    into v_team_ids
    from public.user_scope_team_filters filter
    where filter.auth_user_id = p_target_user_id;
    select coalesce(array_agg(filter.position_id order by filter.position_id), '{}'::uuid[])
    into v_position_ids
    from public.user_scope_position_filters filter
    where filter.auth_user_id = p_target_user_id;
    select coalesce(array_agg(filter.employee_id order by filter.employee_id), '{}'::uuid[])
    into v_employee_ids
    from public.user_scope_employee_filters filter
    where filter.auth_user_id = p_target_user_id;
    if cardinality(v_team_ids) = 0 then
      raise exception using errcode = '22023', message = 'assigned_scope_boundary_missing';
    end if;
  end if;

  v_saved := public.admin_save_account_access_scope(
    p_target_user_id,
    p_employee_id,
    p_role_id,
    p_data_scope,
    case when v_preserve_assigned then v_team_ids else '{}'::uuid[] end,
    case when v_preserve_assigned then v_position_ids else '{}'::uuid[] end,
    case when v_preserve_assigned then v_employee_ids else '{}'::uuid[] end
  );

  if v_role_changed or v_scope_changed then
    delete from public.app_session_leases lease
    where lease.user_id = p_target_user_id;
    delete from auth.sessions auth_session
    where auth_session.user_id = p_target_user_id;
    v_session_revoked := true;
  end if;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, old_data, new_data, reason
  ) values (
    p_actor_user_id,
    v_actor_employee_id,
    'access_control',
    'backend_account_update',
    p_target_user_id::text,
    jsonb_build_object(
      'role_id', v_target_role_id,
      'role_code', v_target_role_code,
      'data_scope', v_target_scope,
      'linked_employee_id', v_target_employee_id
    ),
    jsonb_build_object(
      'role_id', p_role_id,
      'role_code', v_new_role_code,
      'data_scope', p_data_scope,
      'linked_employee_id', p_employee_id,
      'session_revoked', v_session_revoked,
      'recovery_mode', true
    ),
    format(
      '稳定恢复模式编辑后台账号 role=%s data_scope=%s linked_employee=%s',
      v_new_role_code,
      p_data_scope,
      coalesce(p_employee_id::text, 'none')
    )
  );

  return coalesce(v_saved, '{}'::jsonb) || jsonb_build_object(
    'auth_user_id', p_target_user_id,
    'employee_id', p_employee_id,
    'role_id', p_role_id,
    'role_code', v_new_role_code,
    'data_scope', p_data_scope,
    'session_revoked', v_session_revoked
  );
end;
$$;

revoke all on function public.admin_recovery_update_backend_account(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_update_backend_account(
  uuid, uuid, uuid, uuid, text
) to service_role;

comment on function public.admin_recovery_update_backend_account(
  uuid, uuid, uuid, uuid, text
) is
  'Service-only atomic recovery editor for backend role/scope changes. Rechecks exact delegation, preserves existing assigned boundaries, audits, and revokes changed authorization sessions in one transaction.';

notify pgrst, 'reload schema';

commit;
