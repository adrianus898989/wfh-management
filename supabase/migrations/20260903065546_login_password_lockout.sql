begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Server-owned password failure state.  This is intentionally independent of
-- user_access.active: locking a credential must never change employment,
-- portal enablement, roles, or data scope.
do $guard$
begin
  if to_regclass('auth.users') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.permissions') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.user_permission_overrides') is null
     or to_regclass('public.user_scope_employees') is null
     or to_regclass('public.audit_logs') is null
     or to_regclass('public.app_session_leases') is null
     or to_regnamespace('session_private') is null
     or to_regprocedure('session_private.current_app_session_identity()') is null
     or to_regprocedure('session_private.auth_session_matches_current_release(uuid,uuid)') is null
     or to_regprocedure('session_private.portal_ip_enforcement_effective(text)') is null
     or to_regprocedure('session_private.current_staff_ip_attestation_is_valid(uuid,uuid)') is null
     or to_regprocedure('session_private.app_session_claim_release_inner_v1(text)') is null
     or to_regprocedure('public.admin_recovery_backend_action_allowed(uuid,uuid,text)') is null then
    raise exception 'login_password_lockout_dependency_missing';
  end if;
end
$guard$;

create schema if not exists security_private;

revoke all on schema security_private from public, anon, authenticated;
grant usage on schema security_private to service_role;

create table if not exists security_private.login_lockout_policy (
  singleton boolean primary key default true,
  lock_threshold smallint not null default 5,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint login_lockout_policy_singleton_check check (singleton),
  constraint login_lockout_policy_threshold_check
    check (lock_threshold between 3 and 99)
);

insert into security_private.login_lockout_policy(singleton, lock_threshold)
values (true, 5)
on conflict(singleton) do nothing;

create table if not exists security_private.login_lock_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_attempts smallint not null,
  lock_threshold smallint not null,
  last_failed_at timestamptz not null,
  locked_at timestamptz,
  last_failure_portal text not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint login_lock_states_attempts_check
    check (failed_attempts between 1 and 99),
  constraint login_lock_states_threshold_check
    check (lock_threshold between 3 and 99),
  constraint login_lock_states_portal_check
    check (last_failure_portal in ('admin', 'staff')),
  constraint login_lock_states_lock_consistency_check
    check (
      (locked_at is null and failed_attempts < lock_threshold)
      or (locked_at is not null and failed_attempts = lock_threshold)
    )
);

alter table security_private.login_lockout_policy enable row level security;
alter table security_private.login_lockout_policy force row level security;
alter table security_private.login_lock_states enable row level security;
alter table security_private.login_lock_states force row level security;

revoke all on table security_private.login_lockout_policy
  from public, anon, authenticated, service_role;
revoke all on table security_private.login_lock_states
  from public, anon, authenticated, service_role;
grant select, insert, update on table security_private.login_lockout_policy
  to service_role;
grant select, insert, update, delete on table security_private.login_lock_states
  to service_role;

comment on table security_private.login_lockout_policy is
  'Private singleton login policy. Password failures lock at lock_threshold (default 5; configurable 3-99).';
comment on table security_private.login_lock_states is
  'Private server-owned consecutive password failure state. Locked rows never expire and can be removed only by an authorised manual unlock.';

-- Sensitive actions are not granted to any non-Founder role here.  Founder
-- access is implicit; every other administrator must receive an exact grant in
-- the role editor.
insert into public.permissions(code, name, category, sensitive)
values
  ('staff_account.unlock', '解锁员工前端账号', 'user', true),
  ('backend_account.unlock', '解锁后台账号', 'account', true),
  ('backend_account.lockout_policy_manage', '设置登录错误锁定次数', 'account', true)
on conflict(code) do update
set name = excluded.name,
    category = excluded.category,
    sensitive = excluded.sensitive;

-- Service-side authorisation helper.  Exact user overrides take precedence;
-- the wildcard override is consulted only when no exact override exists.
create or replace function security_private.login_admin_permission_allowed(
  p_actor_user_id uuid,
  p_permission_code text
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
set statement_timeout = '1500ms'
as $function$
declare
  v_role_id uuid;
  v_role_code text;
  v_override boolean;
begin
  if p_actor_user_id is null
     or nullif(btrim(coalesce(p_permission_code, '')), '') is null then
    return false;
  end if;

  select access.role_id, role.code
  into v_role_id, v_role_code
  from public.user_access access
  join public.roles role
    on role.id = access.role_id
   and role.active = true
  where access.auth_user_id = p_actor_user_id
    and access.active = true
    and access.backend_enabled = true
  limit 1;
  if not found then return false; end if;
  if v_role_code = 'founder' then return true; end if;

  select permission_override.allowed
  into v_override
  from public.user_permission_overrides permission_override
  join public.permissions permission
    on permission.id = permission_override.permission_id
   and permission.code = p_permission_code
  where permission_override.auth_user_id = p_actor_user_id
  limit 1;
  if found then return v_override; end if;

  select permission_override.allowed
  into v_override
  from public.user_permission_overrides permission_override
  join public.permissions permission
    on permission.id = permission_override.permission_id
   and permission.code = '*'
  where permission_override.auth_user_id = p_actor_user_id
  limit 1;
  if found then return v_override; end if;

  return exists (
    select 1
    from public.role_permissions role_permission
    join public.permissions permission
      on permission.id = role_permission.permission_id
    where role_permission.role_id = v_role_id
      and permission.code in ('*', p_permission_code)
  );
end;
$function$;

create or replace function public.login_password_lockout_policy_get()
returns jsonb
language sql
stable
security invoker
set search_path = ''
set statement_timeout = '1000ms'
as $function$
  select jsonb_build_object(
    'lock_threshold', policy.lock_threshold,
    'minimum_threshold', 3,
    'maximum_threshold', 99,
    'updated_at', policy.updated_at,
    'updated_by', policy.updated_by
  )
  from security_private.login_lockout_policy policy
  where policy.singleton = true;
$function$;

create or replace function public.login_password_lockout_policy_set(
  p_actor_user_id uuid,
  p_lock_threshold integer,
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
  v_new_threshold smallint;
  v_old_threshold smallint;
  v_actor_employee_id uuid;
  v_reason text := btrim(coalesce(p_reason, '后台调整登录错误锁定次数'));
  v_normalized integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  if p_lock_threshold is null or p_lock_threshold not between 3 and 99 then
    raise exception using errcode = '22023', message = 'lock_threshold_must_be_between_3_and_99';
  end if;
  if length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'lockout_policy_reason_too_long';
  end if;
  if not security_private.login_admin_permission_allowed(
    p_actor_user_id,
    'backend_account.lockout_policy_manage'
  ) then
    raise exception using errcode = '42501', message = 'lockout_policy_permission_denied';
  end if;

  v_new_threshold := p_lock_threshold::smallint;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('login-password-lockout-policy', 0)
  );

  select policy.lock_threshold
  into strict v_old_threshold
  from security_private.login_lockout_policy policy
  where policy.singleton = true
  for update;

  if v_old_threshold = v_new_threshold then
    return jsonb_build_object(
      'changed', false,
      'lock_threshold', v_old_threshold,
      'normalized_unlocked_accounts', 0
    );
  end if;

  update security_private.login_lockout_policy policy
  set lock_threshold = v_new_threshold,
      updated_at = v_now,
      updated_by = p_actor_user_id
  where policy.singleton = true;

  -- A policy change never retroactively locks accounts.  Existing unlocked
  -- streaks retain as much history as the new threshold permits; lowering the
  -- threshold clamps them to one remaining attempt.  Already locked rows keep
  -- the threshold that caused their lock and remain locked.
  update security_private.login_lock_states state
  set failed_attempts = least(
        state.failed_attempts,
        (v_new_threshold - 1)::smallint
      ),
      lock_threshold = v_new_threshold,
      updated_at = v_now
  where state.locked_at is null;
  get diagnostics v_normalized = row_count;

  select access.employee_id
  into v_actor_employee_id
  from public.user_access access
  where access.auth_user_id = p_actor_user_id
  limit 1;

  insert into public.audit_logs(
    actor_user_id, employee_id, module, action, record_id,
    old_data, new_data, reason
  ) values (
    p_actor_user_id,
    v_actor_employee_id,
    'access_control',
    'login_lockout_policy_update',
    'password_failure_threshold',
    jsonb_build_object('lock_threshold', v_old_threshold),
    jsonb_build_object(
      'lock_threshold', v_new_threshold,
      'normalized_unlocked_accounts', v_normalized
    ),
    nullif(v_reason, '')
  );

  return jsonb_build_object(
    'changed', true,
    'lock_threshold', v_new_threshold,
    'previous_lock_threshold', v_old_threshold,
    'normalized_unlocked_accounts', v_normalized,
    'updated_at', v_now
  );
end;
$function$;

create or replace function public.login_password_attempt_status(
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set statement_timeout = '1000ms'
as $function$
declare
  v_policy_threshold smallint;
  v_failed_attempts smallint;
  v_state_threshold smallint;
  v_last_failed_at timestamptz;
  v_locked_at timestamptz;
  v_last_failure_portal text;
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'missing_login_user_id';
  end if;

  select policy.lock_threshold
  into strict v_policy_threshold
  from security_private.login_lockout_policy policy
  where policy.singleton = true;

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
  where state.user_id = p_user_id;

  return jsonb_build_object(
    'auth_user_id', p_user_id,
    'login_locked', v_locked_at is not null,
    'failed_attempts', coalesce(v_failed_attempts, 0),
    'lock_threshold', case
      when v_locked_at is not null then v_state_threshold
      else v_policy_threshold
    end,
    'attempts_remaining', case
      when v_locked_at is not null then 0
      else greatest(v_policy_threshold::integer - coalesce(v_failed_attempts, 0), 0)
    end,
    'locked_at', v_locked_at,
    'last_failed_at', v_last_failed_at,
    'last_failure_portal', v_last_failure_portal
  );
end;
$function$;

create or replace function public.login_password_failure_register(
  p_user_id uuid,
  p_portal text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
set statement_timeout = '2500ms'
as $function$
declare
  v_portal text := lower(btrim(coalesce(p_portal, '')));
  v_threshold smallint;
  v_failed_attempts smallint;
  v_state_threshold smallint;
  v_last_failed_at timestamptz;
  v_locked_at timestamptz;
  v_last_failure_portal text;
  v_new_attempts smallint;
  v_now timestamptz := clock_timestamp();
  v_newly_locked boolean := false;
  v_target_employee_id uuid;
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'missing_login_user_id';
  end if;
  if v_portal not in ('admin', 'staff') then
    raise exception using errcode = '22023', message = 'invalid_login_portal';
  end if;

  -- Policy row first, then the account lock.  The setter uses the same order,
  -- preventing a deadlock while guaranteeing this attempt uses one threshold.
  select policy.lock_threshold
  into strict v_threshold
  from security_private.login_lockout_policy policy
  where policy.singleton = true
  for share;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('login-password-lock:' || p_user_id::text, 0)
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
  where state.user_id = p_user_id
  for update;

  if not found then
    insert into security_private.login_lock_states(
      user_id, failed_attempts, lock_threshold, last_failed_at,
      locked_at, last_failure_portal, updated_at
    ) values (
      p_user_id, 1, v_threshold, v_now,
      null, v_portal, v_now
    );
    v_failed_attempts := 1;
    v_state_threshold := v_threshold;
    v_last_failed_at := v_now;
    v_last_failure_portal := v_portal;
  elsif v_locked_at is null then
    v_new_attempts := least(
      v_threshold::integer,
      v_failed_attempts::integer + 1
    )::smallint;
    if v_new_attempts >= v_threshold then
      v_locked_at := v_now;
      v_newly_locked := true;
    end if;

    update security_private.login_lock_states state
    set failed_attempts = v_new_attempts,
        lock_threshold = v_threshold,
        last_failed_at = v_now,
        locked_at = v_locked_at,
        last_failure_portal = v_portal,
        updated_at = v_now
    where state.user_id = p_user_id;

    v_failed_attempts := v_new_attempts;
    v_state_threshold := v_threshold;
    v_last_failed_at := v_now;
    v_last_failure_portal := v_portal;
  end if;

  if v_newly_locked then
    select access.employee_id
    into v_target_employee_id
    from public.user_access access
    where access.auth_user_id = p_user_id
    limit 1;

    insert into public.audit_logs(
      actor_user_id, employee_id, module, action, record_id,
      old_data, new_data, reason
    ) values (
      null,
      v_target_employee_id,
      'auth',
      'login_account_locked',
      p_user_id::text,
      jsonb_build_object(
        'login_locked', false,
        'failed_attempts', v_failed_attempts - 1,
        'lock_threshold', v_state_threshold
      ),
      jsonb_build_object(
        'login_locked', true,
        'failed_attempts', v_failed_attempts,
        'lock_threshold', v_state_threshold,
        'locked_at', v_locked_at,
        'last_failure_portal', v_last_failure_portal
      ),
      format('连续输错密码 %s 次，系统自动锁定登录账号', v_state_threshold)
    );
  end if;

  return jsonb_build_object(
    'auth_user_id', p_user_id,
    'login_locked', v_locked_at is not null,
    'newly_locked', v_newly_locked,
    'failed_attempts', v_failed_attempts,
    'lock_threshold', v_state_threshold,
    'attempts_remaining', case
      when v_locked_at is not null then 0
      else greatest(v_state_threshold::integer - v_failed_attempts::integer, 0)
    end,
    'locked_at', v_locked_at,
    'last_failed_at', v_last_failed_at,
    'last_failure_portal', v_last_failure_portal
  );
end;
$function$;

create or replace function public.login_password_success_clear(
  p_user_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
set statement_timeout = '1800ms'
as $function$
declare
  v_threshold smallint;
  v_failed_attempts smallint;
  v_state_threshold smallint;
  v_locked_at timestamptz;
  v_last_failure_portal text;
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'missing_login_user_id';
  end if;

  select policy.lock_threshold
  into strict v_threshold
  from security_private.login_lockout_policy policy
  where policy.singleton = true
  for share;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('login-password-lock:' || p_user_id::text, 0)
  );

  select
    state.failed_attempts,
    state.lock_threshold,
    state.locked_at,
    state.last_failure_portal
  into
    v_failed_attempts,
    v_state_threshold,
    v_locked_at,
    v_last_failure_portal
  from security_private.login_lock_states state
  where state.user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'auth_user_id', p_user_id,
      'login_locked', false,
      'cleared', false,
      'failed_attempts', 0,
      'lock_threshold', v_threshold
    );
  end if;

  -- A successful password cannot unlock a row that another concurrent request
  -- has already locked.  Only the authorised manual unlock RPC may remove it.
  if v_locked_at is not null then
    return jsonb_build_object(
      'auth_user_id', p_user_id,
      'login_locked', true,
      'cleared', false,
      'failed_attempts', v_failed_attempts,
      'lock_threshold', v_state_threshold,
      'attempts_remaining', 0,
      'locked_at', v_locked_at,
      'last_failure_portal', v_last_failure_portal
    );
  end if;

  delete from security_private.login_lock_states state
  where state.user_id = p_user_id
    and state.locked_at is null;

  return jsonb_build_object(
    'auth_user_id', p_user_id,
    'login_locked', false,
    'cleared', true,
    'failed_attempts', 0,
    'lock_threshold', v_threshold,
    'attempts_remaining', v_threshold
  );
end;
$function$;

create or replace function public.login_password_lock_states(
  p_user_ids uuid[]
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set statement_timeout = '1500ms'
as $function$
declare
  v_result jsonb;
begin
  if p_user_ids is null or cardinality(p_user_ids) = 0 then
    return '[]'::jsonb;
  end if;
  if cardinality(p_user_ids) > 200
     or array_position(p_user_ids, null) is not null then
    raise exception using errcode = '22023', message = 'login_lock_state_batch_invalid';
  end if;

  with requested as (
    select item.user_id, min(item.ordinality) as first_ordinal
    from unnest(p_user_ids) with ordinality item(user_id, ordinality)
    group by item.user_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'auth_user_id', requested.user_id,
        'login_locked', state.locked_at is not null,
        'failed_attempts', coalesce(state.failed_attempts, 0),
        'lock_threshold', case
          when state.locked_at is not null then state.lock_threshold
          else policy.lock_threshold
        end,
        'attempts_remaining', case
          when state.locked_at is not null then 0
          else greatest(
            policy.lock_threshold::integer - coalesce(state.failed_attempts, 0),
            0
          )
        end,
        'locked_at', state.locked_at,
        'last_failed_at', state.last_failed_at,
        'last_failure_portal', state.last_failure_portal
      ) order by requested.first_ordinal
    ),
    '[]'::jsonb
  ) into v_result
  from requested
  cross join security_private.login_lockout_policy policy
  left join security_private.login_lock_states state
    on state.user_id = requested.user_id
  where policy.singleton = true;

  return v_result;
end;
$function$;

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
    -- Founder may unlock the already-authenticated Founder account itself.
    -- Every other backend target uses the same hierarchy, permission-subset,
    -- explicit-delegation and all-data-scope boundary as recovery controls.
    if not (
      v_actor_role_code = 'founder'
      or public.admin_recovery_backend_action_allowed(
        p_actor_user_id,
        p_target_user_id,
        'backend_account.unlock'
      )
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

  -- Clearing the private lock and writing the manual action are one
  -- transaction. If this audit insert fails, the lock deletion rolls back.
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

-- Preserve the current release/IP/session takeover behavior.  A locked user
-- with an already-current, unexpired lease may continue that browser session;
-- a newly created Auth session cannot claim its first app lease.
create or replace function session_private.app_session_claim(
  p_portal text default 'staff'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '1s'
as $function$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_portal text := lower(btrim(coalesce(p_portal, '')));
  v_epoch bigint;
  v_release_id text;
  v_result jsonb;
  v_updated boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('wfh-app-release', 20260827)
  );

  select identity.user_id, identity.session_id
  into v_user_id, v_session_id
  from session_private.current_app_session_identity() identity;

  select state.current_epoch, state.release_id
  into strict v_epoch, v_release_id
  from session_private.app_release_state state
  where state.singleton = true;

  if not session_private.auth_session_matches_current_release(v_user_id, v_session_id) then
    return jsonb_build_object(
      'ok', false, 'reason', 'release_updated', 'release_id', v_release_id
    );
  end if;

  if exists (
    select 1
    from security_private.login_lock_states login_lock
    where login_lock.user_id = v_user_id
      and login_lock.locked_at is not null
  ) and not exists (
    select 1
    from public.app_session_leases lease
    where lease.user_id = v_user_id
      and lease.session_id = v_session_id
      and lease.lease_expires_at > clock_timestamp()
  ) then
    return jsonb_build_object(
      'ok', false,
      'reason', 'account_locked',
      'login_locked', true
    );
  end if;

  if v_portal = 'staff'
     and session_private.portal_ip_enforcement_effective('staff')
     and not session_private.current_staff_ip_attestation_is_valid(v_user_id, v_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'ip_check_required');
  end if;

  v_result := session_private.app_session_claim_release_inner_v1(v_portal);
  if coalesce(v_result->>'ok', 'false') <> 'true' then return v_result; end if;

  update public.app_session_leases lease
  set release_epoch = v_epoch
  where lease.user_id = v_user_id
    and lease.session_id = v_session_id
  returning true into v_updated;
  if v_updated is not true then raise exception 'release_lease_missing'; end if;

  return v_result || jsonb_build_object(
    'release_epoch', v_epoch, 'release_id', v_release_id
  );
end;
$function$;

revoke all on function security_private.login_admin_permission_allowed(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function security_private.login_admin_permission_allowed(uuid, text)
  to service_role;

revoke all on function public.login_password_lockout_policy_get()
  from public, anon, authenticated, service_role;
grant execute on function public.login_password_lockout_policy_get()
  to service_role;

revoke all on function public.login_password_lockout_policy_set(uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.login_password_lockout_policy_set(uuid, integer, text)
  to service_role;

revoke all on function public.login_password_attempt_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.login_password_attempt_status(uuid)
  to service_role;

revoke all on function public.login_password_failure_register(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.login_password_failure_register(uuid, text)
  to service_role;

revoke all on function public.login_password_success_clear(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.login_password_success_clear(uuid)
  to service_role;

revoke all on function public.login_password_lock_states(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.login_password_lock_states(uuid[])
  to service_role;

revoke all on function public.login_password_lock_clear(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.login_password_lock_clear(uuid, uuid, text)
  to service_role;

revoke all on function session_private.app_session_claim(text)
  from public, anon, authenticated, service_role;

comment on function public.login_password_lockout_policy_get() is
  'Service-only reader for the configurable 3-99 consecutive password failure threshold.';
comment on function public.login_password_lockout_policy_set(uuid, integer, text) is
  'Service-only, permission-checked threshold writer with atomic audit. Policy changes never unlock existing locked accounts.';
comment on function public.login_password_attempt_status(uuid) is
  'Service-only single-account password failure/lock state reader.';
comment on function public.login_password_failure_register(uuid, text) is
  'Service-only atomic consecutive password failure recorder. Locks at the current configured threshold and never auto-expires.';
comment on function public.login_password_success_clear(uuid) is
  'Service-only successful-password reset. Clears only an unlocked streak and never clears a locked account.';
comment on function public.login_password_lock_states(uuid[]) is
  'Service-only bounded batch state reader (maximum 200 distinct-or-duplicate input IDs).';
comment on function public.login_password_lock_clear(uuid, uuid, text) is
  'Service-only permission-checked manual unlock. The lock deletion and audit insert are one transaction.';
comment on function session_private.app_session_claim(text) is
  'Claims or renews the current release lease after IP checks. Locked accounts may renew an existing unexpired lease but cannot claim a new one.';

notify pgrst, 'reload schema';

commit;
