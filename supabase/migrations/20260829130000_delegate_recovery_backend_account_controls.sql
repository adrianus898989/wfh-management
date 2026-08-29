begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

create or replace function scope_private.recovery_backend_action_allowed(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_required_permission text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '1800ms'
as $$
declare
  v_actor_role_id uuid;
  v_actor_role_code text;
  v_actor_scope text;
  v_target_role_id uuid;
  v_target_role_code text;
  v_actor_permission_ids uuid[] := '{}'::uuid[];
  v_target_permission_ids uuid[] := '{}'::uuid[];
  v_actor_has_wildcard boolean := false;
  v_actor_has_required boolean := false;
  v_subset boolean := false;
  v_strictly_lower boolean := false;
  v_explicitly_delegated boolean := false;
  v_target_has_override_expansion boolean := false;
begin
  if p_actor_user_id is null or p_target_user_id is null
     or nullif(btrim(coalesce(p_required_permission, '')), '') is null then
    return false;
  end if;

  select actor.role_id, actor_role.code, actor.data_scope
  into v_actor_role_id, v_actor_role_code, v_actor_scope
  from public.user_access actor
  join public.roles actor_role on actor_role.id = actor.role_id and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found then return false; end if;

  select target.role_id, target_role.code
  into v_target_role_id, v_target_role_code
  from public.user_access target
  join public.roles target_role on target_role.id = target.role_id and target_role.active = true
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = true
  limit 1;
  if not found or v_target_role_code = 'founder' then return false; end if;

  if v_actor_role_code = 'founder' then return true; end if;

  -- Recovery delegation is intentionally limited to callers whose canonical
  -- account scope is all. This includes the currently permissioned Supervisor
  -- and custom administrative accounts while preventing an inactive target's
  -- empty materialized scope from bypassing a narrower caller boundary.
  if v_actor_scope is distinct from 'all' then return false; end if;

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
      select 1 from unnest(v_actor_permission_ids) item(permission_id)
      join public.permissions permission on permission.id = item.permission_id
      where permission.code = '*'
    ),
    exists (
      select 1 from unnest(v_actor_permission_ids) item(permission_id)
      join public.permissions permission on permission.id = item.permission_id
      where permission.code in ('*', p_required_permission)
    )
  into v_actor_has_wildcard, v_actor_has_required;
  if not v_actor_has_required then return false; end if;

  select coalesce(array_agg(effective.permission_id), '{}'::uuid[])
  into v_target_permission_ids
  from (
    select role_permission.permission_id
    from public.role_permissions role_permission
    where role_permission.role_id = v_target_role_id
    union
    select override.permission_id
    from public.user_permission_overrides override
    where override.auth_user_id = p_target_user_id and override.allowed = true
    except
    select override.permission_id
    from public.user_permission_overrides override
    where override.auth_user_id = p_target_user_id and override.allowed = false
  ) effective;

  select
    not exists (
      select 1 from unnest(v_target_permission_ids) target_permission(permission_id)
      where not (target_permission.permission_id = any(v_actor_permission_ids))
    ),
    exists (
      select 1 from unnest(v_actor_permission_ids) actor_permission(permission_id)
      where not (actor_permission.permission_id = any(v_target_permission_ids))
    ),
    exists (
      select 1
      from public.backend_role_assignment_rules assignment
      where assignment.grantor_role_id = v_actor_role_id
        and assignment.target_role_id = v_target_role_id
        and assignment.active = true
    ),
    exists (
      select 1 from unnest(v_target_permission_ids) target_permission(permission_id)
      where not exists (
        select 1
        from public.role_permissions base_permission
        where base_permission.role_id = v_target_role_id
          and base_permission.permission_id = target_permission.permission_id
      )
    )
  into v_subset, v_strictly_lower, v_explicitly_delegated, v_target_has_override_expansion;

  return (v_subset and v_strictly_lower)
    or (v_explicitly_delegated and not v_target_has_override_expansion);
end;
$$;

create or replace function public.admin_recovery_backend_action_allowed(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_required_permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
set statement_timeout = '1800ms'
as $$
  select scope_private.recovery_backend_action_allowed(
    p_actor_user_id,
    p_target_user_id,
    p_required_permission
  );
$$;

create or replace function public.admin_recovery_backend_accounts_page(
  p_actor_user_id uuid,
  p_username_query text default '',
  p_employee_query text default '',
  p_context_query text default '',
  p_status text default 'all',
  p_page integer default 1
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2500ms'
as $$
declare
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 100000);
  v_page_size constant integer := 20;
  v_username text := lower(btrim(coalesce(p_username_query, '')));
  v_employee text := lower(btrim(coalesce(p_employee_query, '')));
  v_context text := lower(btrim(coalesce(p_context_query, '')));
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_actor_role_code text;
  v_actor_role_id uuid;
  v_actor_scope text;
  v_is_founder boolean := false;
  v_result jsonb;
begin
  select actor.role_id, actor_role.code, actor.data_scope
  into v_actor_role_id, v_actor_role_code, v_actor_scope
  from public.user_access actor
  join public.roles actor_role on actor_role.id = actor.role_id and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;
  v_is_founder := v_actor_role_code = 'founder';

  if not v_is_founder and v_actor_scope is distinct from 'all' then
    raise exception using errcode = '42501', message = 'recovery_scope_not_supported';
  end if;
  if not v_is_founder and not exists (
    select 1
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
    ) effective
    join public.permissions permission on permission.id = effective.permission_id
    where permission.code in ('*', 'backend_account.view')
  ) then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if length(v_username) > 64 or length(v_employee) > 64 or length(v_context) > 64 then
    raise exception using errcode = '22023', message = 'search_query_too_long';
  end if;
  if v_status not in ('all', 'active', 'inactive') then
    raise exception using errcode = '22023', message = 'invalid_account_status';
  end if;

  with visible as materialized (
    select
      access.auth_user_id,
      access.employee_id,
      access.role_id,
      access.login_username,
      access.otp_required,
      access.data_scope,
      access.active,
      access.created_at,
      access.account_created_by,
      role.code role_code,
      role.name role_name,
      employee.employee_no,
      employee.full_name,
      creator.auth_user_id creator_auth_user_id,
      creator.login_username creator_username
    from public.user_access access
    join public.roles role on role.id = access.role_id and role.active = true
    left join public.employees employee on employee.id = access.employee_id
    left join public.user_access creator on creator.auth_user_id = access.account_created_by
    where access.backend_enabled = true
      and (
        (v_is_founder and access.auth_user_id = p_actor_user_id)
        or scope_private.recovery_backend_action_allowed(
          p_actor_user_id,
          access.auth_user_id,
          'backend_account.view'
        )
      )
      and (v_status = 'all' or (v_status = 'active' and access.active) or (v_status = 'inactive' and not access.active))
      and (v_username = '' or lower(coalesce(access.login_username, '')) like '%' || v_username || '%')
      and (
        v_employee = ''
        or lower(coalesce(employee.employee_no, '')) like '%' || v_employee || '%'
        or lower(coalesce(employee.full_name, '')) like '%' || v_employee || '%'
      )
      and (
        v_context = ''
        or lower(role.name) like '%' || v_context || '%'
        or lower(role.code) like '%' || v_context || '%'
        or lower(coalesce(access.data_scope, '')) like '%' || v_context || '%'
        or lower(coalesce(creator.login_username, '')) like '%' || v_context || '%'
      )
  ), page_rows as (
    select *
    from visible
    order by created_at desc, auth_user_id desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from visible),
    'status', v_status,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'auth_user_id', page_row.auth_user_id,
        'employee_id', page_row.employee_id,
        'role_id', page_row.role_id,
        'login_username', page_row.login_username,
        'otp_required', page_row.otp_required,
        'data_scope', page_row.data_scope,
        'active', page_row.active,
        'created_at', page_row.created_at,
        'roles', jsonb_build_object(
          'id', page_row.role_id,
          'code', page_row.role_code,
          'name', page_row.role_name,
          'active', true
        ),
        'employee', case when page_row.employee_id is null then null else jsonb_build_object(
          'id', page_row.employee_id,
          'employee_no', page_row.employee_no,
          'full_name', page_row.full_name
        ) end,
        'account_created_by_label', case
          when page_row.account_created_by is null then '系统 / 历史导入'
          when page_row.creator_auth_user_id is null then '已删除账号'
          when v_is_founder or page_row.creator_auth_user_id = p_actor_user_id then
            coalesce(nullif(btrim(page_row.creator_username), ''), '后台账号')
          else '其他授权管理员'
        end
      ) order by page_row.created_at desc, page_row.auth_user_id desc)
      from page_rows page_row
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.admin_recovery_set_backend_account_control(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_control text,
  p_value boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '3500ms'
set lock_timeout = '1200ms'
as $$
declare
  v_actor_employee_id uuid;
  v_target_role_code text;
  v_old_active boolean;
  v_old_otp boolean;
  v_new_active boolean;
  v_new_otp boolean;
  v_required_permission text;
begin
  if p_actor_user_id is null or p_target_user_id is null or p_value is null then
    raise exception using errcode = '22023', message = 'invalid_account_control';
  end if;
  if p_control not in ('active', 'otp_required') then
    raise exception using errcode = '22023', message = 'unsupported_account_control';
  end if;
  v_required_permission := case when p_control = 'active' then 'account.disable' else 'account.otp_toggle' end;

  select actor.employee_id
  into v_actor_employee_id
  from public.user_access actor
  join public.roles actor_role on actor_role.id = actor.role_id and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found or not scope_private.recovery_backend_action_allowed(
    p_actor_user_id, p_target_user_id, v_required_permission
  ) then
    raise exception using errcode = '42501', message = 'permission_or_scope_denied';
  end if;

  select role.code, target.active, target.otp_required
  into v_target_role_code, v_old_active, v_old_otp
  from public.user_access target
  join public.roles role on role.id = target.role_id and role.active = true
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = true
  for update of target;
  if not found then
    raise exception using errcode = 'P0002', message = 'backend_account_not_found';
  end if;
  if v_target_role_code = 'founder' then
    raise exception using errcode = '42501', message = 'founder_target_protected';
  end if;
  if p_control = 'active' and not p_value and p_target_user_id = p_actor_user_id then
    raise exception using errcode = '22023', message = 'cannot_disable_current_account';
  end if;

  update public.user_access target
  set active = case when p_control = 'active' then p_value else target.active end,
      otp_required = case when p_control = 'otp_required' then p_value else target.otp_required end,
      updated_at = now()
  where target.auth_user_id = p_target_user_id
  returning target.active, target.otp_required into v_new_active, v_new_otp;

  if (p_control = 'active' and not p_value) or p_control = 'otp_required' then
    delete from public.app_session_leases lease where lease.user_id = p_target_user_id;
  end if;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, old_data, new_data, reason
  ) values (
    p_actor_user_id, v_actor_employee_id, 'access_control',
    case when p_control = 'active' then 'account_active_toggle' else 'otp_toggle' end,
    p_target_user_id::text,
    jsonb_build_object('active', v_old_active, 'otp_required', v_old_otp),
    jsonb_build_object('active', v_new_active, 'otp_required', v_new_otp),
    case when p_control = 'active'
      then format('稳定恢复模式设置后台账号 active=%s', p_value)
      else format('稳定恢复模式设置后台账号 otp_required=%s', p_value)
    end
  );

  return jsonb_build_object('auth_user_id', p_target_user_id, 'active', v_new_active, 'otp_required', v_new_otp);
end;
$$;

create or replace function public.admin_recovery_finalize_backend_auth_control(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '3500ms'
set lock_timeout = '1200ms'
as $$
declare
  v_actor_employee_id uuid;
  v_target_role_code text;
  v_required_permission text;
begin
  if p_actor_user_id is null or p_target_user_id is null
     or p_action not in ('password_reset', 'mfa_reset') then
    raise exception using errcode = '22023', message = 'invalid_backend_auth_control';
  end if;
  v_required_permission := case when p_action = 'password_reset'
    then 'account.reset_password' else 'backend_account.mfa_reset' end;

  select actor.employee_id
  into v_actor_employee_id
  from public.user_access actor
  join public.roles actor_role on actor_role.id = actor.role_id and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found or not scope_private.recovery_backend_action_allowed(
    p_actor_user_id, p_target_user_id, v_required_permission
  ) then
    raise exception using errcode = '42501', message = 'permission_or_scope_denied';
  end if;

  select role.code
  into v_target_role_code
  from public.user_access target
  join public.roles role on role.id = target.role_id and role.active = true
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = true
  for update of target;
  if not found then
    raise exception using errcode = 'P0002', message = 'backend_account_not_found';
  end if;
  if v_target_role_code = 'founder' then
    raise exception using errcode = '42501', message = 'founder_target_protected';
  end if;

  if p_action = 'password_reset' then
    update public.user_access target
    set must_change_password = true, password_reset_at = now(), updated_at = now()
    where target.auth_user_id = p_target_user_id;
  end if;
  delete from public.app_session_leases lease where lease.user_id = p_target_user_id;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, new_data, reason
  ) values (
    p_actor_user_id, v_actor_employee_id, 'access_control', p_action,
    p_target_user_id::text, jsonb_build_object('recovery_mode', true),
    case when p_action = 'password_reset'
      then '稳定恢复模式重置后台账号密码并要求下次登录改密'
      else '稳定恢复模式重置后台账号 OTP/MFA'
    end
  );
  return jsonb_build_object('auth_user_id', p_target_user_id, 'action', p_action, 'finalized', true);
end;
$$;

revoke all on function scope_private.recovery_backend_action_allowed(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_recovery_backend_action_allowed(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_backend_action_allowed(uuid, uuid, text)
  to service_role;
revoke all on function public.admin_recovery_backend_accounts_page(uuid, text, text, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_backend_accounts_page(uuid, text, text, text, text, integer)
  to service_role;

revoke all on function public.admin_recovery_set_backend_account_control(uuid, uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_set_backend_account_control(uuid, uuid, text, boolean)
  to service_role;
revoke all on function public.admin_recovery_finalize_backend_auth_control(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_finalize_backend_auth_control(uuid, uuid, text)
  to service_role;

comment on function scope_private.recovery_backend_action_allowed(uuid, uuid, text) is
  'Private recovery authorization: exact action permission plus role delegation; non-Founder callers must have canonical all-data scope.';
comment on function public.admin_recovery_backend_action_allowed(uuid, uuid, text) is
  'Service-only preflight for recovery Auth mutations; the database remains the authorization authority.';
comment on function public.admin_recovery_backend_accounts_page(uuid, text, text, text, text, integer) is
  'Recovery-safe account list for Founder or all-scope delegated administrators, with complete server-side status/search paging.';

notify pgrst, 'reload schema';

commit;
