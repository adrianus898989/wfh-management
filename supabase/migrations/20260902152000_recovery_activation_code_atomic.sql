begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $guard$
begin
  if to_regclass('public.employee_activation_codes') is null
     or to_regclass('public.employees') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.permissions') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.user_permission_overrides') is null
     or to_regclass('public.audit_logs') is null
     or to_regprocedure('public.employee_master_normalize_id(text)') is null
     or to_regprocedure('public.can_manage_employee(uuid)') is null
     or to_regprocedure('session_private.current_app_session_is_valid(text)') is null then
    raise exception 'recovery_activation_code_dependency_missing';
  end if;
end
$guard$;

create unique index if not exists employee_activation_codes_code_hash_unique_idx
  on public.employee_activation_codes (code_hash);

-- Production still had an older, unversioned plaintext-returning RPC.  The
-- recovery Edge path below is now the sole authenticated generator so every
-- request also passes the server-side IP gate and the second session check.
do $retire_legacy_rpc$
begin
  if to_regprocedure('public.generate_employee_activation_code(text,integer)') is not null then
    execute 'revoke all on function public.generate_employee_activation_code(text,integer) from public, anon, authenticated, service_role';
  end if;
end
$retire_legacy_rpc$;

create or replace function public.admin_recovery_generate_activation_code_v1(
  p_employee_no text,
  p_code_hash text,
  p_code_hint text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '3000ms'
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_employee_id uuid;
  v_actor_role_id uuid;
  v_actor_role_code text;
  v_exact_override boolean;
  v_wildcard_override boolean;
  v_has_exact_role_permission boolean := false;
  v_has_wildcard_role_permission boolean := false;
  v_has_permission boolean := false;
  v_normalized_employee_no text := public.employee_master_normalize_id(p_employee_no);
  v_employee_id uuid;
  v_employee_no text;
  v_employee_name text;
  v_now timestamptz := clock_timestamp();
begin
  if v_actor_user_id is null
     or not session_private.current_app_session_is_valid('admin') then
    raise exception using errcode = '42501', message = 'session_not_current';
  end if;

  if nullif(v_normalized_employee_no, '') is null
     or length(coalesce(p_employee_no, '')) > 80
     or coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_code_hint, '') !~ '^[A-Z0-9]{4}$'
     or p_expires_at is null
     or p_expires_at <= v_now
     or p_expires_at > v_now + interval '168 hours' then
    raise exception using errcode = '22023', message = 'invalid_activation_code_request';
  end if;

  select access.employee_id, access.role_id, role.code
  into v_actor_employee_id, v_actor_role_id, v_actor_role_code
  from public.user_access access
  join public.roles role
    on role.id = access.role_id
   and role.active = true
  where access.auth_user_id = v_actor_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;

  if v_actor_role_code = 'founder' then
    v_has_permission := true;
  else
    select permission_override.allowed
    into v_exact_override
    from public.user_permission_overrides permission_override
    join public.permissions permission
      on permission.id = permission_override.permission_id
     and permission.code = 'user.activation.generate'
    where permission_override.auth_user_id = v_actor_user_id
    limit 1;

    if found then
      v_has_permission := v_exact_override;
    else
      select exists (
        select 1
        from public.role_permissions role_permission
        join public.permissions permission
          on permission.id = role_permission.permission_id
        where role_permission.role_id = v_actor_role_id
          and permission.code = 'user.activation.generate'
      ) into v_has_exact_role_permission;

      if v_has_exact_role_permission then
        v_has_permission := true;
      else
        select permission_override.allowed
        into v_wildcard_override
        from public.user_permission_overrides permission_override
        join public.permissions permission
          on permission.id = permission_override.permission_id
         and permission.code = '*'
        where permission_override.auth_user_id = v_actor_user_id
        limit 1;

        if found then
          v_has_permission := v_wildcard_override;
        else
          select exists (
            select 1
            from public.role_permissions role_permission
            join public.permissions permission
              on permission.id = role_permission.permission_id
            where role_permission.role_id = v_actor_role_id
              and permission.code = '*'
          ) into v_has_wildcard_role_permission;
          v_has_permission := v_has_wildcard_role_permission;
        end if;
      end if;
    end if;
  end if;

  if not v_has_permission then
    raise exception using errcode = '42501', message = 'activation_code_permission_denied';
  end if;

  select employee.id, employee.employee_no, employee.full_name
  into v_employee_id, v_employee_no, v_employee_name
  from public.employees employee
  where public.employee_master_normalize_id(employee.employee_no) = v_normalized_employee_no
    and employee.status = 'active'
  for update of employee;

  if not found then
    raise exception using errcode = 'P0002', message = 'employee_not_found_or_inactive';
  end if;

  if not public.can_manage_employee(v_employee_id) then
    raise exception using errcode = '42501', message = 'employee_scope_denied';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'recovery_activation_code:' || v_employee_id::text,
    0
  ));

  if exists (
    select 1
    from public.user_access access
    where access.employee_id = v_employee_id
      and access.employee_portal_enabled = true
  ) then
    raise exception using errcode = '23505', message = 'staff_account_already_exists';
  end if;

  update public.employee_activation_codes activation
  set revoked_at = v_now
  where activation.employee_id = v_employee_id
    and activation.used_at is null
    and activation.revoked_at is null;

  insert into public.employee_activation_codes (
    employee_id,
    code_hash,
    code_hint,
    expires_at,
    created_by
  ) values (
    v_employee_id,
    p_code_hash,
    p_code_hint,
    p_expires_at,
    v_actor_user_id
  );

  insert into public.audit_logs (
    actor_user_id,
    employee_id,
    module,
    action,
    record_id,
    new_data,
    reason
  ) values (
    v_actor_user_id,
    v_actor_employee_id,
    'access_control',
    'activation_code_generate',
    v_employee_id::text,
    jsonb_build_object(
      'target_employee_id', v_employee_id,
      'target_employee_no', v_employee_no,
      'expires_at', p_expires_at,
      'recovery_mode', true
    ),
    format('稳定恢复模式生成员工激活码 employee=%s', v_employee_no)
  );

  return jsonb_build_object(
    'employee_id', v_employee_id,
    'employee_no', v_employee_no,
    'employee_name', v_employee_name,
    'expires_at', p_expires_at
  );
end;
$$;

revoke all on function public.admin_recovery_generate_activation_code_v1(text,text,text,timestamptz)
  from public, anon, service_role;
grant execute on function public.admin_recovery_generate_activation_code_v1(text,text,text,timestamptz)
  to authenticated;

comment on function public.admin_recovery_generate_activation_code_v1(text,text,text,timestamptz) is
  'Atomically authorizes, scopes, rotates and audits one staff activation code during bounded recovery mode; plaintext codes never enter Postgres.';

commit;
