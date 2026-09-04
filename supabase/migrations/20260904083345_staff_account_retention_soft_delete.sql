begin;

set local lock_timeout = '2s';
set local statement_timeout = '20s';

do $guard$
begin
  if to_regnamespace('scope_private') is null
     or to_regnamespace('session_private') is null
     or to_regnamespace('security_private') is null
     or to_regclass('auth.users') is null
     or to_regclass('auth.sessions') is null
     or to_regclass('storage.objects') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.permissions') is null
     or to_regclass('public.user_scope_employees') is null
     or to_regclass('public.employees') is null
     or to_regclass('public.exam_sessions') is null
     or to_regclass('public.exam_answers') is null
     or to_regclass('public.exam_questions') is null
     or to_regclass('public.exam_assignments') is null
     or to_regclass('public.admin_exam_combined_sessions_v') is null
     or to_regclass('public.employee_connectivity_incidents') is null
     or to_regclass('public.payout_change_requests') is null
     or to_regclass('public.employee_activation_codes') is null
     or to_regclass('public.app_session_leases') is null
     or to_regclass('public.staff_ip_session_attestations') is null
     or to_regclass('public.audit_logs') is null
     or to_regclass('scope_private.recovery_staff_account_delete_operations') is null
     or to_regprocedure('security_private.login_admin_permission_allowed(uuid,text)') is null
     or to_regprocedure('public.exam_staff_context()') is null
     or to_regprocedure('session_private.current_app_session_is_valid(text)') is null
     or to_regprocedure('session_private.exam_employee_in_scope(uuid)') is null
     or to_regprocedure('public.payment_change_current_staff_session_is_valid()') is null
     or to_regprocedure('public.payment_change_admin_can_read_object(text)') is null
     or to_regprocedure('public.admin_recovery_generate_activation_code_v2(uuid,uuid,text,text,text,timestamptz)') is null then
    raise exception 'staff_account_retention_dependency_missing';
  end if;
end
$guard$;

-- The application has long referenced this sensitive permission. Keep clean
-- database replays and production upgrades aligned without granting it to any
-- non-Founder role automatically.
insert into public.permissions(code, name, category, sensitive)
values ('user.password.reset', '重置员工登录密码', 'user', true)
on conflict(code) do update
set name = excluded.name,
    category = excluded.category,
    sensitive = excluded.sensitive;

-- An Auth soft delete keeps the old UUID as an immutable ownership anchor.
-- Only objects that are already bound to a durable employee business record
-- are safe to retain. Any unknown bucket, mismatched employee/path or orphaned
-- upload keeps deletion fail-closed.
create or replace function scope_private.recovery_staff_storage_is_safely_retained(
  p_target_auth_user_id uuid,
  p_target_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
set statement_timeout = '2500ms'
as $function$
  select p_target_auth_user_id is not null
    and p_target_employee_id is not null
    and not exists (
      select 1
      from storage.objects stored
      where (
        stored.owner_id = p_target_auth_user_id::text
        or stored.owner = p_target_auth_user_id
      )
      and not (
        split_part(stored.name, '/', 1) = p_target_auth_user_id::text
        and (
          (
            stored.bucket_id = 'exam-answer-images'
            and exists (
              select 1
              from public.exam_answers answer
              join public.exam_sessions session_row
                on session_row.id = answer.session_id
              where session_row.employee_id = p_target_employee_id
                and session_row.auth_user_id = p_target_auth_user_id
                and split_part(stored.name, '/', 2) = session_row.id::text
                and split_part(stored.name, '/', 3) = answer.question_id::text
                and answer.attachments @> jsonb_build_array(
                  jsonb_build_object('path', stored.name)
                )
            )
          )
          or
          (
            stored.bucket_id = 'connectivity-evidence'
            and exists (
              select 1
              from public.employee_connectivity_incidents incident
              where incident.employee_id = p_target_employee_id
                and incident.attachments @> jsonb_build_array(
                  jsonb_build_object('path', stored.name)
                )
            )
          )
          or
          (
            stored.bucket_id = 'payment-change-proof'
            and exists (
              select 1
              from public.payout_change_requests request
              where request.employee_id = p_target_employee_id
                and split_part(stored.name, '/', 2) = request.id::text
                and stored.name in (
                  request.identity_proof_path,
                  request.payment_proof_path
                )
            )
          )
        )
      )
    );
$function$;

revoke all on function scope_private.recovery_staff_storage_is_safely_retained(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Service-only, side-effect-free password preflight. Edge invokes this twice:
-- once before reading Auth and again immediately before changing the password.
create or replace function public.admin_recovery_prepare_staff_password_reset_v1(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_expected_login_email text,
  p_expected_employee_no text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '3000ms'
as $function$
declare
  v_expected_email text := lower(btrim(coalesce(p_expected_login_email, '')));
  v_expected_employee_no text := btrim(coalesce(p_expected_employee_no, ''));
  v_actor_employee_id uuid;
  v_actor_role_code text;
  v_actor_scope text;
  v_target_employee_id uuid;
  v_target_email text;
  v_target_employee_no text;
  v_auth_email text;
begin
  if p_actor_user_id is null or p_target_user_id is null
     or p_actor_user_id = p_target_user_id then
    raise exception using errcode = '22023', message = 'invalid_recovery_staff_password_identity';
  end if;
  if v_expected_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or length(v_expected_email) > 320
     or v_expected_employee_no = ''
     or length(v_expected_employee_no) > 80 then
    raise exception using errcode = '22023', message = 'invalid_recovery_staff_password_expectation';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'recovery_staff_password_reset:' || p_target_user_id::text,
    0
  ));

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
  if not found
     or not security_private.login_admin_permission_allowed(
       p_actor_user_id, 'staff_account.view'
     )
     or not security_private.login_admin_permission_allowed(
       p_actor_user_id, 'user.password.reset'
     ) then
    raise exception using errcode = '42501', message = 'staff_password_reset_permission_denied';
  end if;

  select
    target.employee_id,
    lower(btrim(target.login_email)),
    btrim(employee.employee_no),
    lower(btrim(auth_user.email))
  into
    v_target_employee_id,
    v_target_email,
    v_target_employee_no,
    v_auth_email
  from public.user_access target
  join public.roles target_role
    on target_role.id = target.role_id
   and target_role.active = true
   and target_role.code = 'employee'
  join public.employees employee
    on employee.id = target.employee_id
  join auth.users auth_user
    on auth_user.id = target.auth_user_id
   and auth_user.deleted_at is null
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = false
    and target.employee_portal_enabled = true
  for update of target;
  if not found then
    raise exception using errcode = 'P0002', message = 'pure_staff_account_not_found';
  end if;

  if v_target_email is distinct from v_expected_email
     or v_auth_email is distinct from v_expected_email
     or v_target_employee_no is distinct from v_expected_employee_no then
    raise exception using errcode = '40001', message = 'staff_account_identity_changed';
  end if;

  if not (
    v_actor_role_code = 'founder'
    or v_actor_scope = 'all'
    or (v_actor_scope = 'self' and v_target_employee_id = v_actor_employee_id)
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
    raise exception using errcode = '42501', message = 'staff_password_reset_scope_denied';
  end if;

  return jsonb_build_object(
    'target_auth_user_id', p_target_user_id,
    'target_employee_id', v_target_employee_id,
    'login_email', v_target_email,
    'employee_no', v_target_employee_no,
    'prepared_at', clock_timestamp()
  );
end;
$function$;

create or replace function public.admin_recovery_finalize_staff_password_reset_v1(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_expected_login_email text,
  p_expected_employee_no text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '3500ms'
as $function$
declare
  v_prepared jsonb;
  v_target_employee_id uuid;
  v_actor_employee_id uuid;
  v_reset_at timestamptz := clock_timestamp();
begin
  v_prepared := public.admin_recovery_prepare_staff_password_reset_v1(
    p_actor_user_id,
    p_target_user_id,
    p_expected_login_email,
    p_expected_employee_no
  );
  v_target_employee_id := (v_prepared->>'target_employee_id')::uuid;

  select actor.employee_id
  into v_actor_employee_id
  from public.user_access actor
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;

  update public.user_access target
  set must_change_password = false,
      password_reset_at = v_reset_at,
      updated_at = v_reset_at
  where target.auth_user_id = p_target_user_id
    and target.employee_id = v_target_employee_id
    and target.backend_enabled = false
    and target.employee_portal_enabled = true
    and lower(btrim(target.login_email)) = lower(btrim(p_expected_login_email));
  if not found then
    raise exception using errcode = '40001', message = 'staff_account_changed_during_password_finalize';
  end if;

  delete from public.app_session_leases lease
  where lease.user_id = p_target_user_id;
  delete from public.staff_ip_session_attestations attestation
  where attestation.user_id = p_target_user_id;
  delete from auth.sessions auth_session
  where auth_session.user_id = p_target_user_id;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id,
    old_data, new_data, reason
  ) values (
    p_actor_user_id,
    v_actor_employee_id,
    'access_control',
    'password_reset',
    p_target_user_id::text,
    null,
    jsonb_build_object(
      'account_kind', 'staff',
      'target_employee_id', v_target_employee_id,
      'employee_no', btrim(p_expected_employee_no),
      'must_change_password', false,
      'password_reset_at', v_reset_at,
      'recovery_mode', true
    ),
    format(
      '稳定恢复模式重置员工前端账号密码 %s',
      btrim(p_expected_employee_no)
    )
  );

  return jsonb_build_object(
    'auth_user_id', p_target_user_id,
    'target_employee_id', v_target_employee_id,
    'employee_no', btrim(p_expected_employee_no),
    'must_change_password', false,
    'password_reset_at', v_reset_at,
    'finalized', true
  );
end;
$function$;

-- Best-effort safety net for an Auth password mutation whose database
-- finalizer is delayed. It is deliberately idempotent and requires the exact
-- pure-staff identity before revoking sessions; only service_role may call it.
create or replace function public.admin_recovery_revoke_staff_sessions_v1(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_expected_login_email text,
  p_expected_employee_no text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '3000ms'
as $function$
declare
  v_expected_email text := lower(btrim(coalesce(p_expected_login_email, '')));
  v_expected_employee_no text := btrim(coalesce(p_expected_employee_no, ''));
  v_target_employee_id uuid;
begin
  if p_actor_user_id is null or p_target_user_id is null
     or p_actor_user_id = p_target_user_id
     or v_expected_email = '' or v_expected_employee_no = '' then
    raise exception using errcode = '22023', message = 'invalid_recovery_staff_session_revoke';
  end if;

  -- This function is intentionally service-only and does not repeat mutable
  -- actor authorization: the Edge has already completed two preflights and a
  -- password mutation. Revocation must still succeed if that authorization
  -- changes during the finalizer window.
  select target.employee_id
  into v_target_employee_id
  from public.user_access target
  join public.roles target_role
    on target_role.id = target.role_id
   and target_role.active = true
   and target_role.code = 'employee'
  join public.employees employee
    on employee.id = target.employee_id
  join auth.users auth_user
    on auth_user.id = target.auth_user_id
   and auth_user.deleted_at is null
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = false
    and target.employee_portal_enabled = true
    and lower(btrim(target.login_email)) = v_expected_email
    and lower(btrim(auth_user.email)) = v_expected_email
    and btrim(employee.employee_no) = v_expected_employee_no
  for update of target;
  if not found then
    raise exception using errcode = 'P0002', message = 'pure_staff_account_not_found';
  end if;

  delete from public.app_session_leases lease
  where lease.user_id = p_target_user_id;
  delete from public.staff_ip_session_attestations attestation
  where attestation.user_id = p_target_user_id;
  delete from auth.sessions auth_session
  where auth_session.user_id = p_target_user_id;

  return jsonb_build_object(
    'auth_user_id', p_target_user_id,
    'target_employee_id', v_target_employee_id,
    'sessions_revoked', true
  );
end;
$function$;

revoke all on function public.admin_recovery_prepare_staff_password_reset_v1(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_prepare_staff_password_reset_v1(uuid, uuid, text, text)
  to service_role;
revoke all on function public.admin_recovery_finalize_staff_password_reset_v1(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_finalize_staff_password_reset_v1(uuid, uuid, text, text)
  to service_role;
revoke all on function public.admin_recovery_revoke_staff_sessions_v1(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_revoke_staff_sessions_v1(uuid, uuid, text, text)
  to service_role;

-- Supersede the hard-delete preflight without changing its public signature.
-- A prepared operation now accepts only durable, employee-bound evidence and
-- recognises a soft-deleted Auth tombstone during response-loss reconciliation.
create or replace function public.admin_recovery_prepare_staff_account_delete_v1(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_expected_login_email text,
  p_expected_employee_no text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '3000ms'
as $function$
declare
  v_expected_email text := lower(btrim(coalesce(p_expected_login_email, '')));
  v_expected_employee_no text := btrim(coalesce(p_expected_employee_no, ''));
  v_actor_employee_id uuid;
  v_actor_role_code text;
  v_actor_scope text;
  v_target_employee_id uuid;
  v_target_email text;
  v_target_employee_no text;
  v_auth_email text;
  v_operation_id uuid;
  v_expires_at timestamptz;
  v_prepared_at timestamptz;
begin
  if p_actor_user_id is null or p_target_user_id is null
     or p_actor_user_id = p_target_user_id then
    raise exception using errcode = '22023', message = 'invalid_recovery_staff_delete_identity';
  end if;
  if v_expected_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or length(v_expected_email) > 320
     or v_expected_employee_no = ''
     or length(v_expected_employee_no) > 80 then
    raise exception using errcode = '22023', message = 'invalid_recovery_staff_delete_expectation';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'recovery_staff_account_delete:' || p_target_user_id::text,
    0
  ));

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
  if not found
     or not security_private.login_admin_permission_allowed(
       p_actor_user_id, 'staff_account.view'
     )
     or not security_private.login_admin_permission_allowed(
       p_actor_user_id, 'user.account.delete'
     ) then
    raise exception using errcode = '42501', message = 'staff_account_delete_permission_denied';
  end if;

  select
    target.employee_id,
    lower(btrim(target.login_email)),
    btrim(employee.employee_no),
    lower(btrim(auth_user.email))
  into
    v_target_employee_id,
    v_target_email,
    v_target_employee_no,
    v_auth_email
  from public.user_access target
  join public.roles target_role
    on target_role.id = target.role_id
   and target_role.active = true
   and target_role.code = 'employee'
  join public.employees employee
    on employee.id = target.employee_id
  join auth.users auth_user
    on auth_user.id = target.auth_user_id
   and auth_user.deleted_at is null
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = false
    and target.employee_portal_enabled = true
  for update of target;

  if not found then
    -- The Auth soft delete or a legacy hard delete may have committed while an
    -- HTTP/finalizer response was lost. Reuse only an exact prepared event. A
    -- remaining access row must be the exact disabled pure-staff row prepared
    -- by this operation; a completed retry may already have removed it.
    select prepared.operation_id, prepared.target_employee_id,
           prepared.expires_at, prepared.created_at
    into v_operation_id, v_target_employee_id, v_expires_at, v_prepared_at
    from scope_private.recovery_staff_account_delete_operations prepared
    where prepared.event_type = 'prepared'
      and prepared.actor_user_id = p_actor_user_id
      and prepared.target_auth_user_id = p_target_user_id
      and prepared.expected_login_email = v_expected_email
      and prepared.expected_employee_no = v_expected_employee_no
    order by prepared.created_at desc
    limit 1;

    if found
       and (
         v_actor_role_code = 'founder'
         or v_actor_scope = 'all'
         or (v_actor_scope = 'self' and v_target_employee_id = v_actor_employee_id)
         or (
           v_actor_scope in ('own_team', 'assigned_teams')
           and exists (
             select 1
             from public.user_scope_employees scoped_employee
             where scoped_employee.auth_user_id = p_actor_user_id
               and scoped_employee.employee_id = v_target_employee_id
           )
         )
       )
       and not exists (
         select 1 from auth.users auth_user
         where auth_user.id = p_target_user_id
           and auth_user.deleted_at is null
       )
       and (
         not exists (
           select 1 from public.user_access access
           where access.auth_user_id = p_target_user_id
         )
         or exists (
           select 1
           from public.user_access access
           join public.roles target_role
             on target_role.id = access.role_id
            and target_role.code = 'employee'
           join public.employees employee
             on employee.id = access.employee_id
           where access.auth_user_id = p_target_user_id
             and access.employee_id = v_target_employee_id
             and access.backend_enabled = false
             and access.employee_portal_enabled = true
             and access.active = false
             and lower(btrim(access.login_email)) = v_expected_email
             and btrim(employee.employee_no) = v_expected_employee_no
         )
       )
       and scope_private.recovery_staff_storage_is_safely_retained(
         p_target_user_id, v_target_employee_id
       ) then
      return jsonb_build_object(
        'operation_id', v_operation_id,
        'target_auth_user_id', p_target_user_id,
        'target_employee_id', v_target_employee_id,
        'login_email', v_expected_email,
        'employee_no', v_expected_employee_no,
        'prepared_at', v_prepared_at,
        'expires_at', v_expires_at,
        'reconcile_only', true
      );
    end if;

    raise exception using errcode = 'P0002', message = 'pure_staff_account_not_found';
  end if;

  if v_target_email is distinct from v_expected_email
     or v_auth_email is distinct from v_expected_email
     or v_target_employee_no is distinct from v_expected_employee_no then
    raise exception using errcode = '40001', message = 'staff_account_identity_changed';
  end if;

  if not (
    v_actor_role_code = 'founder'
    or v_actor_scope = 'all'
    or (v_actor_scope = 'self' and v_target_employee_id = v_actor_employee_id)
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
    raise exception using errcode = '42501', message = 'staff_account_delete_scope_denied';
  end if;

  if not scope_private.recovery_staff_storage_is_safely_retained(
    p_target_user_id, v_target_employee_id
  ) then
    raise exception using errcode = '55000', message = 'staff_account_owns_unretained_storage_objects';
  end if;

  select prepared.operation_id, prepared.expires_at, prepared.created_at
  into v_operation_id, v_expires_at, v_prepared_at
  from scope_private.recovery_staff_account_delete_operations prepared
  where prepared.event_type = 'prepared'
    and prepared.actor_user_id = p_actor_user_id
    and prepared.target_auth_user_id = p_target_user_id
    and prepared.target_employee_id = v_target_employee_id
    and prepared.expected_login_email = v_expected_email
    and prepared.expected_employee_no = v_expected_employee_no
    and not exists (
      select 1
      from scope_private.recovery_staff_account_delete_operations finalized
      where finalized.operation_id = prepared.operation_id
        and finalized.event_type = 'finalized'
    )
  order by prepared.created_at desc
  limit 1;

  if not found then
    v_operation_id := gen_random_uuid();
    v_prepared_at := clock_timestamp();
    -- Recovery is permanently idempotent. The ledger column is retained for
    -- compatibility with existing production rows, but expiry is not an
    -- authorization boundary; every retry rechecks current permission/scope.
    v_expires_at := 'infinity'::timestamptz;
    insert into scope_private.recovery_staff_account_delete_operations (
      operation_id, event_type, actor_user_id, actor_employee_id,
      target_auth_user_id, target_employee_id,
      expected_login_email, expected_employee_no, expires_at, created_at
    ) values (
      v_operation_id, 'prepared', p_actor_user_id, v_actor_employee_id,
      p_target_user_id, v_target_employee_id,
      v_expected_email, v_expected_employee_no, v_expires_at, v_prepared_at
    );
  end if;

  update public.user_access target
  set active = false,
      updated_at = now()
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = false
    and target.employee_portal_enabled = true
    and target.employee_id = v_target_employee_id;
  if not found then
    raise exception using errcode = '40001', message = 'staff_account_changed_during_delete_prepare';
  end if;

  delete from public.app_session_leases lease
  where lease.user_id = p_target_user_id;
  delete from public.staff_ip_session_attestations attestation
  where attestation.user_id = p_target_user_id;
  delete from auth.sessions auth_session
  where auth_session.user_id = p_target_user_id;

  return jsonb_build_object(
    'operation_id', v_operation_id,
    'target_auth_user_id', p_target_user_id,
    'target_employee_id', v_target_employee_id,
    'login_email', v_expected_email,
    'employee_no', v_expected_employee_no,
    'prepared_at', v_prepared_at,
    'expires_at', v_expires_at,
    'reconcile_only', false
  );
end;
$function$;

-- Finalization is the database authority for a potentially ambiguous Auth API
-- response. A soft-deleted tombstone (or a legacy already-absent Auth row) is
-- terminal; a live Auth row is not. Employee history and referenced files stay.
create or replace function public.admin_recovery_finalize_staff_account_delete_v1(
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_target_user_id uuid,
  p_expected_login_email text,
  p_expected_employee_no text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '3500ms'
as $function$
declare
  v_expected_email text := lower(btrim(coalesce(p_expected_login_email, '')));
  v_expected_employee_no text := btrim(coalesce(p_expected_employee_no, ''));
  v_actor_employee_id uuid;
  v_current_actor_employee_id uuid;
  v_current_actor_role_code text;
  v_current_actor_scope text;
  v_target_employee_id uuid;
  v_expires_at timestamptz;
  v_prepared_at timestamptz;
  v_finalized_at timestamptz;
  v_auth_row_exists boolean;
  v_auth_soft_deleted boolean;
  v_access_exists boolean;
  v_already_finalized boolean;
  v_removed_access_rows integer := 0;
  v_expired_sessions integer := 0;
  v_revoked_activation_codes integer := 0;
  v_inserted integer := 0;
begin
  if p_actor_user_id is null or p_operation_id is null or p_target_user_id is null
     or v_expected_email = '' or v_expected_employee_no = '' then
    raise exception using errcode = '22023', message = 'invalid_recovery_staff_delete_finalize';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'recovery_staff_account_delete:' || p_target_user_id::text,
    0
  ));

  select prepared.actor_employee_id, prepared.target_employee_id,
         prepared.expires_at, prepared.created_at
  into v_actor_employee_id, v_target_employee_id, v_expires_at, v_prepared_at
  from scope_private.recovery_staff_account_delete_operations prepared
  where prepared.operation_id = p_operation_id
    and prepared.event_type = 'prepared'
    and prepared.actor_user_id = p_actor_user_id
    and prepared.target_auth_user_id = p_target_user_id
    and prepared.expected_login_email = v_expected_email
    and prepared.expected_employee_no = v_expected_employee_no
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'staff_account_delete_operation_not_found';
  end if;

  -- Permanent retries are never permanent authorization. Re-evaluate the
  -- actor's live backend role, exact permissions and employee scope on every
  -- finalization attempt, including an already-finalized idempotent retry.
  select actor.employee_id, actor_role.code, actor.data_scope
  into v_current_actor_employee_id, v_current_actor_role_code, v_current_actor_scope
  from public.user_access actor
  join public.roles actor_role
    on actor_role.id = actor.role_id
   and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found
     or v_current_actor_employee_id is distinct from v_actor_employee_id
     or not security_private.login_admin_permission_allowed(
       p_actor_user_id, 'staff_account.view'
     )
     or not security_private.login_admin_permission_allowed(
       p_actor_user_id, 'user.account.delete'
     ) then
    raise exception using errcode = '42501', message = 'staff_account_delete_permission_denied';
  end if;
  if not (
    v_current_actor_role_code = 'founder'
    or v_current_actor_scope = 'all'
    or (
      v_current_actor_scope = 'self'
      and v_target_employee_id = v_current_actor_employee_id
    )
    or (
      v_current_actor_scope in ('own_team', 'assigned_teams')
      and exists (
        select 1
        from public.user_scope_employees scoped_employee
        where scoped_employee.auth_user_id = p_actor_user_id
          and scoped_employee.employee_id = v_target_employee_id
      )
    )
  ) then
    raise exception using errcode = '42501', message = 'staff_account_delete_scope_denied';
  end if;

  select
    exists (
      select 1 from auth.users auth_user
      where auth_user.id = p_target_user_id
    ),
    exists (
      select 1 from auth.users auth_user
      where auth_user.id = p_target_user_id
        and auth_user.deleted_at is not null
    )
  into v_auth_row_exists, v_auth_soft_deleted;
  if v_auth_row_exists and not v_auth_soft_deleted then
    raise exception using errcode = '55000', message = 'staff_auth_identity_still_active';
  end if;

  if not scope_private.recovery_staff_storage_is_safely_retained(
    p_target_user_id, v_target_employee_id
  ) then
    raise exception using errcode = '55000', message = 'staff_account_owns_unretained_storage_objects';
  end if;

  select exists (
    select 1
    from scope_private.recovery_staff_account_delete_operations finalized
    where finalized.operation_id = p_operation_id
      and finalized.event_type = 'finalized'
  ) into v_already_finalized;
  select exists (
    select 1 from public.user_access access
    where access.auth_user_id = p_target_user_id
  ) into v_access_exists;

  if v_access_exists then
    perform 1
    from public.user_access access
    join public.roles target_role
      on target_role.id = access.role_id
     and target_role.code = 'employee'
    join public.employees employee
      on employee.id = access.employee_id
    where access.auth_user_id = p_target_user_id
      and access.employee_id = v_target_employee_id
      and access.backend_enabled = false
      and access.employee_portal_enabled = true
      and access.active = false
      and lower(btrim(access.login_email)) = v_expected_email
      and btrim(employee.employee_no) = v_expected_employee_no
    for update of access;
    if not found then
      raise exception using errcode = '40001', message = 'staff_access_row_changed_before_finalize';
    end if;
  elsif v_auth_row_exists and not v_already_finalized then
    -- Soft delete never cascades user_access. Its unexplained absence therefore
    -- cannot be accepted as a fresh successful operation.
    raise exception using errcode = '55000', message = 'staff_access_row_missing_before_finalize';
  end if;

  update public.exam_sessions session_row
  set status = 'expired',
      updated_at = clock_timestamp()
  where session_row.auth_user_id = p_target_user_id
    and session_row.employee_id = v_target_employee_id
    and session_row.status = 'in_progress';
  get diagnostics v_expired_sessions = row_count;

  delete from public.app_session_leases lease
  where lease.user_id = p_target_user_id;
  delete from public.staff_ip_session_attestations attestation
  where attestation.user_id = p_target_user_id;
  delete from auth.sessions auth_session
  where auth_session.user_id = p_target_user_id;

  update public.employee_activation_codes activation
  set revoked_at = clock_timestamp()
  where activation.employee_id = v_target_employee_id
    and activation.used_at is null
    and activation.revoked_at is null;
  get diagnostics v_revoked_activation_codes = row_count;

  if v_access_exists then
    delete from public.user_access target
    using public.roles target_role, public.employees employee
    where target.auth_user_id = p_target_user_id
      and target.employee_id = v_target_employee_id
      and target.backend_enabled = false
      and target.employee_portal_enabled = true
      and target.active = false
      and lower(btrim(target.login_email)) = v_expected_email
      and target_role.id = target.role_id
      and target_role.code = 'employee'
      and employee.id = target.employee_id
      and btrim(employee.employee_no) = v_expected_employee_no;
    get diagnostics v_removed_access_rows = row_count;
    if v_removed_access_rows <> 1 then
      raise exception using errcode = '40001', message = 'staff_access_row_changed_during_finalize';
    end if;
  end if;

  v_finalized_at := clock_timestamp();
  insert into scope_private.recovery_staff_account_delete_operations (
    operation_id, event_type, actor_user_id, actor_employee_id,
    target_auth_user_id, target_employee_id,
    expected_login_email, expected_employee_no, expires_at, created_at
  ) values (
    p_operation_id, 'finalized', p_actor_user_id, v_actor_employee_id,
    p_target_user_id, v_target_employee_id,
    v_expected_email, v_expected_employee_no, v_expires_at, v_finalized_at
  ) on conflict (operation_id, event_type) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    insert into public.audit_logs (
      actor_user_id, employee_id, module, action, record_id,
      old_data, new_data, reason
    ) values (
      p_actor_user_id,
      v_actor_employee_id,
      'access_control',
      'account_delete',
      p_target_user_id::text,
      jsonb_build_object(
        'account_kind', 'staff',
        'employee_id', v_target_employee_id,
        'employee_no', v_expected_employee_no,
        'login_email', v_expected_email
      ),
      jsonb_build_object(
        'auth_identity_deleted', true,
        'auth_identity_soft_deleted', v_auth_soft_deleted,
        'legacy_hard_delete_reconciled', not v_auth_row_exists,
        'staff_access_removed', true,
        'employee_profile_retained', true,
        'exam_history_retained', true,
        'referenced_employee_files_retained', true,
        'unused_activation_codes_revoked', v_revoked_activation_codes,
        'expired_in_progress_exam_sessions', v_expired_sessions,
        'recovery_mode', true,
        'operation_id', p_operation_id
      ),
      format(
        '稳定恢复模式删除员工前端登录身份并保留员工业务记录 %s / %s',
        v_expected_employee_no,
        v_expected_email
      )
    );
  else
    select finalized.created_at
    into v_finalized_at
    from scope_private.recovery_staff_account_delete_operations finalized
    where finalized.operation_id = p_operation_id
      and finalized.event_type = 'finalized';
  end if;

  return jsonb_build_object(
    'operation_id', p_operation_id,
    'target_auth_user_id', p_target_user_id,
    'target_employee_id', v_target_employee_id,
    'login_email', v_expected_email,
    'employee_no', v_expected_employee_no,
    'prepared_at', v_prepared_at,
    'finalized_at', v_finalized_at,
    'already_finalized', v_inserted = 0,
    'auth_identity_soft_deleted', v_auth_soft_deleted,
    'employee_profile_retained', true,
    'exam_history_retained', true,
    'referenced_employee_files_retained', true,
    'unused_activation_codes_revoked', v_revoked_activation_codes,
    'expired_in_progress_exam_sessions', v_expired_sessions
  );
end;
$function$;

revoke all on function public.admin_recovery_prepare_staff_account_delete_v1(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_prepare_staff_account_delete_v1(uuid, uuid, text, text)
  to service_role;
revoke all on function public.admin_recovery_finalize_staff_account_delete_v1(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_finalize_staff_account_delete_v1(uuid, uuid, uuid, text, text)
  to service_role;

-- A replacement login is a new Auth UUID, but the employee is the same durable
-- subject. Referenced historical answer images therefore follow employee_id for
-- reads; upload and delete policies remain bound to the current Auth/session.
create or replace function session_private.exam_answer_storage_can_view(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.exam_answers answer
    join public.exam_sessions session_row
      on session_row.id = answer.session_id
    where jsonb_array_length(answer.attachments) > 0
      and answer.attachments @> jsonb_build_array(
        jsonb_build_object('path', coalesce(p_name, ''))
      )
      and (
        (
          session_private.current_app_session_is_valid('staff')
          and exists (
            select 1
            from public.exam_staff_context() context_row
            where context_row.auth_user_id = (select auth.uid())
              and context_row.employee_id = session_row.employee_id
          )
        )
        or
        (
          session_private.current_app_session_is_valid('admin')
          and session_private.exam_employee_in_scope(session_row.employee_id)
          and (
            public.has_permission('exam.records.view')
            or public.has_permission('employee.directory.view')
            or (
              public.has_permission('exam.grading.view')
              and session_row.status in ('submitted', 'grading')
            )
          )
        )
      )
  );
$function$;

revoke all on function session_private.exam_answer_storage_can_view(text)
  from public, anon, authenticated;
grant execute on function session_private.exam_answer_storage_can_view(text)
  to authenticated;

-- Keep the existing catalogue and current-login resume boundary. Only the
-- attempt count follows the durable employee identity across re-registration.
create or replace function public.staff_exam_home()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  c record;
  v_assignments jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  select * into c from public.exam_staff_context();
  if c.employee_id is null then
    raise exception '账号尚未关联在职员工档案';
  end if;

  select coalesce(
    jsonb_agg(
      to_jsonb(x)
      order by x.pool_ready desc, x.team_name, x.series_name, x.position_name
    ),
    '[]'::jsonb
  )
  into v_assignments
  from (
    select
      'open'::text as id,
      concat(q.team_name, ' · ', q.series_name, ' · ', q.position_name, ' 考试') as title,
      q.team_name,
      q.position_name,
      q.series_name,
      60 as duration_minutes,
      60 as pass_score,
      14 as question_count,
      100 as total_score,
      20 as max_attempts,
      coalesce((
        select count(*)
        from public.exam_sessions session_row
        join public.exam_assignments assignment
          on assignment.id = session_row.assignment_id
        where session_row.employee_id = c.employee_id
          and session_row.status <> 'expired'
          and public.exam_norm(assignment.team_name) = public.exam_norm(q.team_name)
          and public.exam_norm(assignment.position_name) = public.exam_norm(q.position_name)
          and public.exam_norm(assignment.series_name) = public.exam_norm(q.series_name)
      ), 0) as attempts,
      (
        select session_row.id
        from public.exam_sessions session_row
        join public.exam_assignments assignment
          on assignment.id = session_row.assignment_id
        where session_row.employee_id = c.employee_id
          and session_row.auth_user_id = auth.uid()
          and session_row.status = 'in_progress'
          and session_row.expires_at > now()
          and public.exam_norm(assignment.team_name) = public.exam_norm(q.team_name)
          and public.exam_norm(assignment.position_name) = public.exam_norm(q.position_name)
          and public.exam_norm(assignment.series_name) = public.exam_norm(q.series_name)
        order by session_row.started_at desc
        limit 1
      ) as resume_session_id,
      (
        count(*) filter (where q.points = 5) >= 10
        and count(*) filter (where q.points = 10) >= 3
        and count(*) filter (where q.points = 20) >= 1
      ) as pool_ready,
      jsonb_build_object(
        '5', count(*) filter (where q.points = 5),
        '10', count(*) filter (where q.points = 10),
        '20', count(*) filter (where q.points = 20)
      ) as pool_counts
    from public.exam_questions q
    where q.active
      and nullif(btrim(q.team_name), '') is not null
      and nullif(btrim(q.position_name), '') is not null
      and nullif(btrim(q.series_name), '') is not null
    group by q.team_name, q.position_name, q.series_name
  ) x;

  return jsonb_build_object(
    'profile', to_jsonb(c),
    'assignments', v_assignments,
    'history', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.started_at desc),
        '[]'::jsonb
      )
      from (
        select
          id,
          title,
          attempt_no,
          status,
          started_at,
          submitted_at,
          graded_at,
          earned_score,
          total_score,
          percentage,
          passed,
          grader_name,
          correct_count,
          partial_count,
          wrong_count,
          pending_count,
          source_system,
          source_label,
          answer_detail_available,
          answer_detail_count,
          total_question_count,
          unanswered_count
        from public.admin_exam_combined_sessions_v
        where employee_id = c.employee_id
          and status <> 'in_progress'
        order by started_at desc
        limit 100
      ) x
    )
  );
end;
$function$;

revoke all on function public.staff_exam_home()
  from public, anon;
grant execute on function public.staff_exam_home()
  to authenticated;

-- Connectivity evidence already authorises current staff by the durable
-- incident.employee_id. Payout proof previously used only Storage owner_id, so
-- add the equivalent employee-bound retained-history branch.
create or replace function session_private.payment_change_staff_can_read_retained_proof(
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select session_private.current_app_session_is_valid('staff')
    and exists (
      select 1
      from public.payout_change_requests request
      cross join public.exam_staff_context() context_row
      where context_row.auth_user_id = (select auth.uid())
        and context_row.employee_id = request.employee_id
        and (
          request.identity_proof_path = coalesce(p_name, '')
          or request.payment_proof_path = coalesce(p_name, '')
        )
    );
$function$;

revoke all on function session_private.payment_change_staff_can_read_retained_proof(text)
  from public, anon, authenticated;
grant execute on function session_private.payment_change_staff_can_read_retained_proof(text)
  to authenticated;

drop policy if exists payment_change_proof_read on storage.objects;
create policy payment_change_proof_read
on storage.objects
for select
to authenticated
using (
  bucket_id = 'payment-change-proof'
  and (
    (
      owner_id = (select auth.uid())::text
      and split_part(name, '/', 1) = (select auth.uid())::text
      and public.payment_change_current_staff_session_is_valid()
    )
    or session_private.payment_change_staff_can_read_retained_proof(name)
    or public.payment_change_admin_can_read_object(name)
  )
);

-- Keep recovery activation generation aligned with the portal's existing
-- active/probation login rule. Patch the deployed v2 body only when its exact
-- scalar status predicate and security configuration match the known version.
do $activation_status_patch$
declare
  v_signature regprocedure :=
    'public.admin_recovery_generate_activation_code_v2(uuid,uuid,text,text,text,timestamptz)'::regprocedure;
  v_definition text;
  v_pattern constant text := $regex$employee[.]status[[:space:]]*=[[:space:]]*'active'(::text)?$regex$;
  v_match_count integer;
begin
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into v_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature
    and procedure.prosecdef = true
    and procedure.provolatile = 'v'
    and procedure.proconfig @> array['search_path=""']::text[];

  if v_definition is null then
    raise exception 'recovery_activation_v2_security_contract_mismatch';
  end if;
  v_match_count := pg_catalog.regexp_count(v_definition, v_pattern);
  if v_match_count <> 1 then
    raise exception 'recovery_activation_v2_status_patch_count_mismatch:%', v_match_count;
  end if;

  v_definition := pg_catalog.regexp_replace(
    v_definition,
    v_pattern,
    $replacement$employee.status in ('active', 'probation')$replacement$,
    'g'
  );
  execute v_definition;
end
$activation_status_patch$;

revoke all on function public.admin_recovery_generate_activation_code_v2(uuid, uuid, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_generate_activation_code_v2(uuid, uuid, text, text, text, timestamptz)
  to service_role;

comment on function scope_private.recovery_staff_storage_is_safely_retained(uuid, uuid) is
  'Fail-closed ownership audit: allows only old-Auth-prefixed Storage objects formally referenced by the same employee exam, connectivity incident or payout-change request.';
comment on table scope_private.recovery_staff_account_delete_operations is
  'Append-only recovery ledger for employee-login soft deletion. Prepared/finalized events retain the old Auth UUID as the ownership anchor while employee history and referenced files remain.';
comment on function public.admin_recovery_prepare_staff_account_delete_v1(uuid, uuid, text, text) is
  'Service-only soft-delete preflight with exact permission, scope and identity checks; retained employee-bound evidence is allowed and every other owned object fails closed.';
comment on function public.admin_recovery_finalize_staff_account_delete_v1(uuid, uuid, uuid, text, text) is
  'Service-only idempotent soft-delete finalizer: requires deleted Auth state, expires in-progress exams, removes only the exact staff access row and retains employee history/files.';
comment on function public.admin_recovery_prepare_staff_password_reset_v1(uuid, uuid, text, text) is
  'Service-only, side-effect-free exact staff password-reset preflight for double checking immediately around the Auth mutation.';
comment on function public.admin_recovery_finalize_staff_password_reset_v1(uuid, uuid, text, text) is
  'Service-only staff password-reset finalizer: records the reset, revokes sessions and writes a password-free audit without forcing another password change.';
comment on function public.admin_recovery_revoke_staff_sessions_v1(uuid, uuid, text, text) is
  'Service-only idempotent safety net that rechecks the exact pure-staff identity before revoking target sessions after an uncertain or incomplete password-reset outcome.';
comment on function public.admin_recovery_generate_activation_code_v2(uuid, uuid, text, text, text, timestamptz) is
  'Service-only atomic activation-code rotation for active or probationary employees after exact session, permission and employee-scope checks.';
comment on function session_private.exam_answer_storage_can_view(text) is
  'Private Storage RLS guard: referenced answer images follow employee identity for staff history; admin scope remains permission-bound.';
comment on function session_private.payment_change_staff_can_read_retained_proof(text) is
  'Private Storage RLS guard for a current staff account reading payout-change proof retained under an earlier Auth UUID for the same employee.';

notify pgrst, 'reload schema';

commit;
