begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Password verification and mutation happen at the trusted Edge boundary. These
-- helpers deliberately accept only server-derived Auth identities/session ids
-- and are executable only by service_role.
do $guard$
begin
  if to_regclass('auth.sessions') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.employees') is null
     or to_regclass('public.app_session_leases') is null
     or to_regclass('public.staff_ip_session_attestations') is null
     or to_regclass('public.audit_logs') is null
     or to_regclass('security_private.login_lockout_policy') is null
     or to_regclass('security_private.login_lock_states') is null
     or to_regprocedure('session_private.auth_session_matches_current_release(uuid,uuid)') is null
     or to_regprocedure('session_private.current_app_release_epoch()') is null
     or to_regprocedure('session_private.current_staff_ip_attestation_is_valid(uuid,uuid)') is null
     or to_regprocedure('public.login_password_attempt_status(uuid)') is null
     or to_regprocedure('public.login_password_failure_register(uuid,text)') is null
     or to_regprocedure('public.login_password_success_clear(uuid)') is null then
    raise exception 'staff_self_password_change_dependency_missing';
  end if;
end
$guard$;

create or replace function public.staff_password_change_preflight_v1(
  p_user_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '1800ms'
as $function$
declare
  v_employee_id uuid;
  v_must_change_password boolean;
  v_release_epoch bigint;
  v_locked_at timestamptz;
  v_lock_threshold smallint;
begin
  if p_user_id is null or p_session_id is null then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  if not session_private.auth_session_matches_current_release(
    p_user_id,
    p_session_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  v_release_epoch := session_private.current_app_release_epoch();
  if not exists (
    select 1
    from public.app_session_leases lease
    where lease.user_id = p_user_id
      and lease.session_id = p_session_id
      and lease.portal = 'staff'
      and lease.release_epoch = v_release_epoch
      and lease.lease_expires_at > statement_timestamp()
  ) then
    return jsonb_build_object('ok', false, 'reason', 'staff_session_not_current');
  end if;

  if not session_private.current_staff_ip_attestation_is_valid(
    p_user_id,
    p_session_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'ip_check_required');
  end if;

  select access.employee_id, coalesce(access.must_change_password, false)
  into v_employee_id, v_must_change_password
  from public.user_access access
  join public.roles role
    on role.id = access.role_id
   and role.active = true
   and lower(btrim(role.code)) = 'employee'
  join public.employees employee
    on employee.id = access.employee_id
   and lower(btrim(coalesce(employee.status::text, ''))) in ('active', 'probation')
  where access.auth_user_id = p_user_id
    and access.active = true
    and access.employee_portal_enabled = true
    and access.backend_enabled = false
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'staff_account_not_found');
  end if;

  select state.locked_at, coalesce(state.lock_threshold, policy.lock_threshold)
  into v_locked_at, v_lock_threshold
  from security_private.login_lockout_policy policy
  left join security_private.login_lock_states state
    on state.user_id = p_user_id
  where policy.singleton = true;

  if v_locked_at is not null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'account_locked',
      'lock_threshold', v_lock_threshold
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'employee_id', v_employee_id,
    'must_change_password', v_must_change_password,
    'lock_threshold', v_lock_threshold
  );
end;
$function$;

comment on function public.staff_password_change_preflight_v1(uuid, uuid) is
  'Service-only staff password-change gate: live Auth/app session, current release, staff IP, pure employee identity, and password-lock state.';

create or replace function public.staff_password_change_finalize_v1(
  p_user_id uuid,
  p_app_session_id uuid,
  p_verified_session_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '5s'
as $function$
declare
  v_employee_id uuid;
  v_old_must_change_password boolean;
  v_release_epoch bigint;
  v_revoked_auth_sessions integer := 0;
  v_revoked_app_leases integer := 0;
  v_login_locked boolean := false;
  v_lock_threshold smallint;
  v_state_lock_threshold smallint;
begin
  if p_user_id is null
     or p_app_session_id is null
     or p_verified_session_id is null then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'staff-self-password-change:' || p_user_id::text,
      0
    )
  );

  -- Updating via the newly password-verified session may already have revoked
  -- the original browser Auth session. Bind finalization to the still-live
  -- verified session and separately to the original staff application lease.
  if not session_private.auth_session_matches_current_release(
    p_user_id,
    p_verified_session_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'verified_session_missing');
  end if;

  v_release_epoch := session_private.current_app_release_epoch();
  if not exists (
    select 1
    from public.app_session_leases lease
    where lease.user_id = p_user_id
      and lease.session_id = p_app_session_id
      and lease.portal = 'staff'
      and lease.release_epoch = v_release_epoch
      and lease.lease_expires_at > statement_timestamp()
  ) then
    return jsonb_build_object('ok', false, 'reason', 'staff_session_not_current');
  end if;

  if not session_private.current_staff_ip_attestation_is_valid(
    p_user_id,
    p_app_session_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'ip_check_required');
  end if;

  select access.employee_id, coalesce(access.must_change_password, false)
  into v_employee_id, v_old_must_change_password
  from public.user_access access
  join public.roles role
    on role.id = access.role_id
   and role.active = true
   and lower(btrim(role.code)) = 'employee'
  join public.employees employee
    on employee.id = access.employee_id
   and lower(btrim(coalesce(employee.status::text, ''))) in ('active', 'probation')
  where access.auth_user_id = p_user_id
    and access.active = true
    and access.employee_portal_enabled = true
    and access.backend_enabled = false
  limit 1
  for update of access;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'staff_account_not_found');
  end if;

  -- Match the lock-order used by login_password_failure_register/success_clear:
  -- policy row first, then the per-user advisory lock. This makes the audited
  -- lock status stable without deadlocking a concurrent policy update.
  select policy.lock_threshold
  into strict v_lock_threshold
  from security_private.login_lockout_policy policy
  where policy.singleton = true
  for share;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('login-password-lock:' || p_user_id::text, 0)
  );

  select state.locked_at is not null, state.lock_threshold
  into v_login_locked, v_state_lock_threshold
  from security_private.login_lock_states state
  where state.user_id = p_user_id;
  if not found then
    v_login_locked := false;
  elsif v_login_locked then
    v_lock_threshold := v_state_lock_threshold;
  end if;

  update public.user_access access
  set must_change_password = false,
      updated_at = clock_timestamp()
  where access.auth_user_id = p_user_id;

  delete from public.staff_ip_session_attestations attestation
  where attestation.user_id = p_user_id;

  delete from public.app_session_leases lease
  where lease.user_id = p_user_id;
  get diagnostics v_revoked_app_leases = row_count;

  insert into public.audit_logs(
    actor_user_id,
    employee_id,
    module,
    action,
    record_id,
    old_data,
    new_data,
    reason
  ) values (
    p_user_id,
    v_employee_id,
    'auth',
    'staff_self_password_change',
    p_user_id::text,
    jsonb_build_object('must_change_password', v_old_must_change_password),
    jsonb_build_object(
      'must_change_password', false,
      'all_sessions_revoked', true,
      'login_locked', v_login_locked
    ),
    '员工在前端验证当前密码后自行修改登录密码'
  );

  delete from auth.sessions auth_session
  where auth_session.user_id = p_user_id;
  get diagnostics v_revoked_auth_sessions = row_count;

  return jsonb_build_object(
    'ok', true,
    'login_locked', v_login_locked,
    'lock_threshold', v_lock_threshold,
    'revoked_auth_sessions', v_revoked_auth_sessions,
    'revoked_app_leases', v_revoked_app_leases
  );
end;
$function$;

comment on function public.staff_password_change_finalize_v1(uuid, uuid, uuid) is
  'Service-only atomic audit, forced-password flag clear, staff attestation cleanup, and all-session revocation after Auth password replacement. Password material is never accepted or audited.';

revoke all on function public.staff_password_change_preflight_v1(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_password_change_preflight_v1(uuid, uuid)
  to service_role;

revoke all on function public.staff_password_change_finalize_v1(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_password_change_finalize_v1(uuid, uuid, uuid)
  to service_role;

commit;
