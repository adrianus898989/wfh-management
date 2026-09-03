begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $guard$
begin
  if to_regprocedure('security_private.login_admin_permission_allowed(uuid,text)') is null
     or to_regprocedure('public.login_password_lock_clear(uuid,uuid,text)') is null
     or to_regprocedure('scope_private.current_employee_scope_directory()') is null
     or to_regclass('public.user_scope_employees') is null
     or to_regclass('public.user_scope_team_filters') is null
     or to_regclass('public.user_scope_position_filters') is null
     or to_regclass('public.user_scope_employee_filters') is null
     or to_regclass('public.backend_role_assignment_rules') is null then
    raise exception 'login_password_unlock_scope_dependency_missing';
  end if;
end
$guard$;

-- Authorise a backend-account unlock against the same effective employee
-- scope and strict permission hierarchy used by the ordinary account page.
-- Recovery mode may remain more restrictive at its Edge boundary, but the
-- database must not reject a limited-scope administrator who was explicitly
-- granted unlock and can genuinely manage the target account.
create or replace function security_private.login_backend_unlock_allowed(
  p_actor_user_id uuid,
  p_target_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '1800ms'
as $function$
declare
  v_actor_employee_id uuid;
  v_actor_role_id uuid;
  v_actor_role_code text;
  v_actor_scope text;
  v_target_role_id uuid;
  v_target_role_code text;
  v_target_employee_id uuid;
  v_target_scope text;
  v_target_active boolean;
  v_current_assignments jsonb := '[]'::jsonb;
  v_actor_permission_ids uuid[] := '{}'::uuid[];
  v_target_permission_ids uuid[] := '{}'::uuid[];
  v_actor_has_wildcard boolean := false;
  v_subset boolean := false;
  v_strictly_lower boolean := false;
  v_explicitly_delegated boolean := false;
  v_target_has_override_expansion boolean := false;
begin
  if p_actor_user_id is null or p_target_user_id is null then return false; end if;

  select actor.employee_id, actor.role_id, actor_role.code, actor.data_scope
  into v_actor_employee_id, v_actor_role_id, v_actor_role_code, v_actor_scope
  from public.user_access actor
  join public.roles actor_role
    on actor_role.id = actor.role_id
   and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found then return false; end if;

  select
    target.role_id,
    target_role.code,
    target.employee_id,
    target.data_scope,
    target.active
  into
    v_target_role_id,
    v_target_role_code,
    v_target_employee_id,
    v_target_scope,
    v_target_active
  from public.user_access target
  join public.roles target_role
    on target_role.id = target.role_id
   and target_role.active = true
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = true
  limit 1;
  if not found then return false; end if;

  -- A Founder target is protected everywhere else in account administration:
  -- only that already-authenticated Founder may unlock itself. Founder may
  -- unlock every non-Founder backend account.
  if v_target_role_code = 'founder' then
    return v_actor_role_code = 'founder'
      and p_actor_user_id = p_target_user_id;
  end if;
  if v_actor_role_code = 'founder' then return true; end if;
  if v_target_employee_id is null then return false; end if;

  if not security_private.login_admin_permission_allowed(
    p_actor_user_id,
    'backend_account.unlock'
  ) then return false; end if;

  if v_actor_scope is distinct from 'all' then
    -- First preserve the canonical linked-employee boundary. `self` is
    -- resolved directly from user_access; only team-based scopes are stored
    -- in the materialised user_scope_employees table.
    if v_actor_scope = 'self' then
      if v_target_employee_id is distinct from v_actor_employee_id then return false; end if;
    elsif v_actor_scope in ('own_team', 'assigned_teams') then
      if not exists (
        select 1
        from public.user_scope_employees actor_scope
        where actor_scope.auth_user_id = p_actor_user_id
          and actor_scope.employee_id = v_target_employee_id
      ) then return false; end if;
    else
      return false;
    end if;

    -- Durable structure matters in addition to today's materialisation: an
    -- own-team grant follows its holder after a transfer, and assigned grants
    -- can outlive later team/position changes. This mirrors
    -- scopeStructureWithinCaller() in the ordinary account Edge endpoint.
    if v_target_scope = 'self' then
      if not (
        v_target_employee_id = v_actor_employee_id
        or (
          v_actor_scope = 'assigned_teams'
          and exists (
            select 1
            from public.user_scope_employee_filters actor_employee_filter
            where actor_employee_filter.auth_user_id = p_actor_user_id
              and actor_employee_filter.employee_id = v_target_employee_id
          )
        )
      ) then return false; end if;
    elsif v_target_scope = 'assigned_teams' then
      if v_actor_scope is distinct from 'assigned_teams' then return false; end if;

      -- Resolve the canonical roster directory once. Re-reading the source
      -- function for every selector would repeatedly scan the roster cache.
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'employee_id', current_assignment.employee_id,
          'current_team_id', current_assignment.current_team_id,
          'current_position_id', current_assignment.current_position_id
        )),
        '[]'::jsonb
      )
      into v_current_assignments
      from scope_private.current_employee_scope_directory() current_assignment;

      -- Assigned scope requires at least one current team, every selected
      -- position/employee must still belong to a selected current team, and
      -- the resulting current scope must not be empty.
      if not exists (
        select 1
        from public.user_scope_team_filters target_team
        where target_team.auth_user_id = p_target_user_id
      ) then return false; end if;
      if exists (
        select 1
        from public.user_scope_team_filters target_team
        where target_team.auth_user_id = p_target_user_id
          and not exists (
            select 1
            from jsonb_to_recordset(v_current_assignments) as current_assignment(
              employee_id uuid,
              current_team_id uuid,
              current_position_id uuid
            )
            where current_assignment.current_team_id = target_team.team_id
          )
      ) then return false; end if;
      if exists (
        select 1
        from public.user_scope_position_filters target_position
        where target_position.auth_user_id = p_target_user_id
          and not exists (
            select 1
            from jsonb_to_recordset(v_current_assignments) as current_assignment(
              employee_id uuid,
              current_team_id uuid,
              current_position_id uuid
            )
            join public.user_scope_team_filters target_team
              on target_team.auth_user_id = p_target_user_id
             and target_team.team_id = current_assignment.current_team_id
            where current_assignment.current_position_id = target_position.position_id
          )
      ) then return false; end if;
      if exists (
        select 1
        from public.user_scope_employee_filters target_employee
        where target_employee.auth_user_id = p_target_user_id
          and not exists (
            select 1
            from jsonb_to_recordset(v_current_assignments) as current_assignment(
              employee_id uuid,
              current_team_id uuid,
              current_position_id uuid
            )
            join public.user_scope_team_filters target_team
              on target_team.auth_user_id = p_target_user_id
             and target_team.team_id = current_assignment.current_team_id
            where current_assignment.employee_id = target_employee.employee_id
          )
      ) then return false; end if;
      if not exists (
        select 1
        from jsonb_to_recordset(v_current_assignments) as current_assignment(
          employee_id uuid,
          current_team_id uuid,
          current_position_id uuid
        )
        join public.user_scope_team_filters target_team
          on target_team.auth_user_id = p_target_user_id
         and target_team.team_id = current_assignment.current_team_id
        where not exists (
            select 1
            from public.user_scope_position_filters any_target_position
            where any_target_position.auth_user_id = p_target_user_id
          )
          or exists (
            select 1
            from public.user_scope_position_filters target_position
            where target_position.auth_user_id = p_target_user_id
              and target_position.position_id = current_assignment.current_position_id
          )
          or exists (
            select 1
            from public.user_scope_employee_filters target_employee
            where target_employee.auth_user_id = p_target_user_id
              and target_employee.employee_id = current_assignment.employee_id
          )
      ) then return false; end if;

      -- The target's persistent selectors must be structural subsets of the
      -- caller's selectors. If the caller narrows positions, the target must
      -- also narrow positions and may select only those same positions.
      if exists (
        select 1
        from public.user_scope_team_filters target_team
        where target_team.auth_user_id = p_target_user_id
          and not exists (
            select 1
            from public.user_scope_team_filters actor_team
            where actor_team.auth_user_id = p_actor_user_id
              and actor_team.team_id = target_team.team_id
          )
      ) then return false; end if;
      if exists (
        select 1
        from public.user_scope_employee_filters target_employee
        where target_employee.auth_user_id = p_target_user_id
          and not exists (
            select 1
            from public.user_scope_employee_filters actor_employee
            where actor_employee.auth_user_id = p_actor_user_id
              and actor_employee.employee_id = target_employee.employee_id
          )
      ) then return false; end if;
      if exists (
        select 1
        from public.user_scope_position_filters actor_position
        where actor_position.auth_user_id = p_actor_user_id
      ) then
        if not exists (
          select 1
          from public.user_scope_position_filters target_position
          where target_position.auth_user_id = p_target_user_id
        ) then return false; end if;
        if exists (
          select 1
          from public.user_scope_position_filters target_position
          where target_position.auth_user_id = p_target_user_id
            and not exists (
              select 1
              from public.user_scope_position_filters actor_position
              where actor_position.auth_user_id = p_actor_user_id
                and actor_position.position_id = target_position.position_id
            )
        ) then return false; end if;
      end if;
    else
      -- all, own_team and unknown scopes are not durable children of a
      -- limited caller.
      return false;
    end if;

    -- For active targets, the complete materialised set must also fit inside
    -- today's caller set. Inactive targets intentionally have no materialised
    -- rows and remain manageable after the durable checks above succeed.
    if v_target_active is true and exists (
      select 1
      from public.user_scope_employees target_scope
      where target_scope.auth_user_id = p_target_user_id
        and not exists (
          select 1
          from public.user_scope_employees actor_scope
          where actor_scope.auth_user_id = p_actor_user_id
            and actor_scope.employee_id = target_scope.employee_id
        )
    ) then return false; end if;
  end if;

  select coalesce(array_agg(effective.permission_id), '{}'::uuid[])
  into v_actor_permission_ids
  from (
    select role_permission.permission_id
    from public.role_permissions role_permission
    where role_permission.role_id = v_actor_role_id
    union
    select permission_override.permission_id
    from public.user_permission_overrides permission_override
    where permission_override.auth_user_id = p_actor_user_id
      and permission_override.allowed = true
    except
    select permission_override.permission_id
    from public.user_permission_overrides permission_override
    where permission_override.auth_user_id = p_actor_user_id
      and permission_override.allowed = false
  ) effective;

  select exists (
    select 1
    from unnest(v_actor_permission_ids) actor_permission(permission_id)
    join public.permissions permission on permission.id = actor_permission.permission_id
    where permission.code = '*'
  ) into v_actor_has_wildcard;
  if v_actor_has_wildcard then return true; end if;

  select coalesce(array_agg(effective.permission_id), '{}'::uuid[])
  into v_target_permission_ids
  from (
    select role_permission.permission_id
    from public.role_permissions role_permission
    where role_permission.role_id = v_target_role_id
    union
    select permission_override.permission_id
    from public.user_permission_overrides permission_override
    where permission_override.auth_user_id = p_target_user_id
      and permission_override.allowed = true
    except
    select permission_override.permission_id
    from public.user_permission_overrides permission_override
    where permission_override.auth_user_id = p_target_user_id
      and permission_override.allowed = false
  ) effective;

  select
    not exists (
      select 1
      from unnest(v_target_permission_ids) target_permission(permission_id)
      where not (target_permission.permission_id = any(v_actor_permission_ids))
    ),
    exists (
      select 1
      from unnest(v_actor_permission_ids) actor_permission(permission_id)
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
      select 1
      from unnest(v_target_permission_ids) target_permission(permission_id)
      where not exists (
        select 1
        from public.role_permissions base_permission
        where base_permission.role_id = v_target_role_id
          and base_permission.permission_id = target_permission.permission_id
      )
    )
  into v_subset, v_strictly_lower, v_explicitly_delegated,
    v_target_has_override_expansion;

  return (v_subset and v_strictly_lower)
    or (v_explicitly_delegated and not v_target_has_override_expansion);
end;
$function$;

revoke all on function security_private.login_backend_unlock_allowed(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.login_backend_unlock_allowed(uuid, uuid)
  to service_role;

-- Replace the complete unlock function so this forward migration is stable
-- across fresh databases and cannot depend on comments or whitespace in the
-- preceding migration's pg_get_functiondef output.
create or replace function public.login_password_lock_clear(
  p_target_user_id uuid,
  p_actor_user_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
set statement_timeout = '2500ms'
as $function$
declare
  v_reason text := btrim(coalesce(p_reason, '后台人工解锁登录账号'));
  v_actor_employee_id uuid;
  v_actor_role_code text;
  v_actor_scope text;
  v_target_employee_id uuid;
  v_target_role_code text;
  v_target_backend_enabled boolean;
  v_target_staff_enabled boolean;
  v_required_permission text;
  v_failed_attempts smallint;
  v_state_threshold smallint;
  v_last_failed_at timestamptz;
  v_locked_at timestamptz;
  v_last_failure_portal text;
  v_current_threshold smallint;
  v_now timestamptz := clock_timestamp();
begin
  if p_target_user_id is null or p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'missing_login_unlock_identity';
  end if;
  if length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'login_unlock_reason_too_long';
  end if;

  select actor.employee_id, actor_role.code, actor.data_scope
  into v_actor_employee_id, v_actor_role_code, v_actor_scope
  from public.user_access actor
  join public.roles actor_role
    on actor_role.id = actor.role_id
   and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;

  select
    target.employee_id,
    target_role.code,
    target.backend_enabled,
    target.employee_portal_enabled
  into
    v_target_employee_id,
    v_target_role_code,
    v_target_backend_enabled,
    v_target_staff_enabled
  from public.user_access target
  join public.roles target_role
    on target_role.id = target.role_id
  where target.auth_user_id = p_target_user_id
  limit 1;
  if not found then
    raise exception using errcode = 'P0002', message = 'login_account_not_found';
  end if;

  if v_target_backend_enabled then
    v_required_permission := 'backend_account.unlock';
  elsif v_target_staff_enabled then
    v_required_permission := 'staff_account.unlock';
  else
    raise exception using errcode = '22023', message = 'login_portal_not_enabled';
  end if;

  if v_target_backend_enabled then
    if not security_private.login_backend_unlock_allowed(
      p_actor_user_id,
      p_target_user_id
    ) then
      raise exception using errcode = '42501', message = 'permission_or_scope_denied';
    end if;
  else
    -- Staff login unlocks use the canonical employee scope materialization.
    -- A permission alone never authorizes an out-of-scope employee.
    if not security_private.login_admin_permission_allowed(
      p_actor_user_id,
      'staff_account.unlock'
    ) or not (
      v_actor_role_code = 'founder'
      or v_actor_scope = 'all'
      or (
        v_actor_scope = 'self'
        and v_target_employee_id = v_actor_employee_id
      )
      or (
        v_actor_scope in ('own_team', 'assigned_teams')
        and exists (
          select 1
          from public.user_scope_employees scoped_employee
          where scoped_employee.auth_user_id = p_actor_user_id
            and scoped_employee.employee_id = v_target_employee_id
        )
      )
    ) then
      raise exception using errcode = '42501', message = 'permission_or_scope_denied';
    end if;
  end if;

  select policy.lock_threshold
  into strict v_current_threshold
  from security_private.login_lockout_policy policy
  where policy.singleton = true
  for share;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('login-password-lock:' || p_target_user_id::text, 0)
  );

  select
    state.failed_attempts,
    state.lock_threshold,
    state.last_failed_at,
    state.locked_at,
    state.last_failure_portal
  into
    v_failed_attempts,
    v_state_threshold,
    v_last_failed_at,
    v_locked_at,
    v_last_failure_portal
  from security_private.login_lock_states state
  where state.user_id = p_target_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'auth_user_id', p_target_user_id,
      'changed', false,
      'login_locked', false,
      'failed_attempts', 0,
      'lock_threshold', v_current_threshold,
      'locked_at', null,
      'last_failed_at', null,
      'last_failure_portal', null,
      'required_permission', v_required_permission
    );
  end if;
  if v_locked_at is null then
    return jsonb_build_object(
      'auth_user_id', p_target_user_id,
      'changed', false,
      'login_locked', false,
      'failed_attempts', v_failed_attempts,
      'lock_threshold', v_current_threshold,
      'locked_at', null,
      'last_failed_at', v_last_failed_at,
      'last_failure_portal', v_last_failure_portal,
      'required_permission', v_required_permission
    );
  end if;

  delete from security_private.login_lock_states state
  where state.user_id = p_target_user_id
    and state.locked_at = v_locked_at;
  if not found then
    raise exception using errcode = '40001', message = 'login_lock_changed_during_unlock';
  end if;

  insert into public.audit_logs(
    actor_user_id, employee_id, module, action, record_id,
    old_data, new_data, reason
  ) values (
    p_actor_user_id,
    v_actor_employee_id,
    'access_control',
    'login_account_unlock',
    p_target_user_id::text,
    jsonb_build_object(
      'target_employee_id', v_target_employee_id,
      'login_locked', true,
      'failed_attempts', v_failed_attempts,
      'lock_threshold', v_state_threshold,
      'locked_at', v_locked_at,
      'last_failed_at', v_last_failed_at,
      'last_failure_portal', v_last_failure_portal
    ),
    jsonb_build_object(
      'target_employee_id', v_target_employee_id,
      'login_locked', false,
      'failed_attempts', 0,
      'unlocked_at', v_now
    ),
    nullif(v_reason, '')
  );

  return jsonb_build_object(
    'auth_user_id', p_target_user_id,
    'changed', true,
    'login_locked', false,
    'failed_attempts', 0,
    'lock_threshold', v_current_threshold,
    'locked_at', null,
    'last_failed_at', null,
    'last_failure_portal', null,
    'previous_lock_threshold', v_state_threshold,
    'previous_locked_at', v_locked_at,
    'required_permission', v_required_permission,
    'unlocked_at', v_now
  );
end;
$function$;

revoke all on function public.login_password_lock_clear(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.login_password_lock_clear(uuid, uuid, text)
  to service_role;

comment on function security_private.login_backend_unlock_allowed(uuid, uuid) is
  'Service-only backend unlock boundary: exact permission, durable scope containment, current effective-scope containment and strict role hierarchy.';

notify pgrst, 'reload schema';

commit;
