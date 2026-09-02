begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $guard$
begin
  if to_regnamespace('scope_private') is null then
    raise exception 'scope_private_schema_missing';
  end if;
  if to_regclass('auth.users') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.permissions') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.user_permission_overrides') is null
     or to_regclass('public.user_scope_employees') is null
     or to_regclass('public.employees') is null
     or to_regclass('public.audit_logs') is null
     or to_regclass('public.app_session_leases') is null
     or to_regclass('storage.objects') is null then
    raise exception 'recovery_staff_delete_dependency_missing';
  end if;
end
$guard$;

-- This is an append-only operation ledger.  The Auth UUID deliberately has no
-- foreign key to auth.users: the prepared event must survive the hard delete
-- so a response-loss retry can prove what was authorized and finish auditing.
create table if not exists scope_private.recovery_staff_account_delete_operations (
  operation_id uuid not null,
  event_type text not null,
  actor_user_id uuid not null,
  actor_employee_id uuid,
  target_auth_user_id uuid not null,
  target_employee_id uuid not null,
  expected_login_email text not null,
  expected_employee_no text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (operation_id, event_type),
  constraint recovery_staff_account_delete_event_type_check
    check (event_type in ('prepared', 'finalized')),
  constraint recovery_staff_account_delete_email_check
    check (expected_login_email = lower(btrim(expected_login_email))
      and length(expected_login_email) between 3 and 320),
  constraint recovery_staff_account_delete_employee_no_check
    check (expected_employee_no = btrim(expected_employee_no)
      and length(expected_employee_no) between 1 and 80)
);

alter table scope_private.recovery_staff_account_delete_operations enable row level security;

create index if not exists recovery_staff_account_delete_operations_retry_idx
  on scope_private.recovery_staff_account_delete_operations
    (actor_user_id, target_auth_user_id, created_at desc)
  where event_type = 'prepared';

create or replace function scope_private.reject_recovery_staff_delete_operation_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'recovery_staff_delete_ledger_is_immutable';
end;
$$;

drop trigger if exists recovery_staff_account_delete_operations_immutable
  on scope_private.recovery_staff_account_delete_operations;
create trigger recovery_staff_account_delete_operations_immutable
before update or delete on scope_private.recovery_staff_account_delete_operations
for each row execute function scope_private.reject_recovery_staff_delete_operation_mutation();

revoke all on table scope_private.recovery_staff_account_delete_operations
  from public, anon, authenticated, service_role;
revoke all on function scope_private.reject_recovery_staff_delete_operation_mutation()
  from public, anon, authenticated, service_role;

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
as $$
declare
  v_expected_email text := lower(btrim(coalesce(p_expected_login_email, '')));
  v_expected_employee_no text := btrim(coalesce(p_expected_employee_no, ''));
  v_actor_employee_id uuid;
  v_actor_role_id uuid;
  v_actor_role_code text;
  v_actor_scope text;
  v_exact_override boolean;
  v_wildcard_override boolean;
  v_has_permission boolean := false;
  v_required_permission text;
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
  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;

  if v_actor_role_code <> 'founder' then
    foreach v_required_permission in array array['staff_account.view', 'user.account.delete'] loop
      v_exact_override := null;
      v_wildcard_override := null;
      v_has_permission := false;

      select permission_override.allowed
      into v_exact_override
      from public.user_permission_overrides permission_override
      join public.permissions permission
        on permission.id = permission_override.permission_id
       and permission.code = v_required_permission
      where permission_override.auth_user_id = p_actor_user_id
      limit 1;

      if found then
        v_has_permission := v_exact_override;
      else
        select permission_override.allowed
        into v_wildcard_override
        from public.user_permission_overrides permission_override
        join public.permissions permission
          on permission.id = permission_override.permission_id
         and permission.code = '*'
        where permission_override.auth_user_id = p_actor_user_id
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
              and permission.code in ('*', v_required_permission)
          ) into v_has_permission;
        end if;
      end if;

      if not v_has_permission then
        raise exception using errcode = '42501', message = 'staff_account_delete_permission_denied';
      end if;
    end loop;
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
  join public.employees employee on employee.id = target.employee_id
  join auth.users auth_user on auth_user.id = target.auth_user_id
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = false
    and target.employee_portal_enabled = true
  for update of target;

  if not found then
    -- Auth deletion may have committed while its HTTP response or the finalizer
    -- response was lost.  Reuse only an exact, still-unfinalized prepared event,
    -- and only when both Auth and access rows are already absent.
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
       and not exists (select 1 from auth.users where id = p_target_user_id)
       and not exists (select 1 from public.user_access where auth_user_id = p_target_user_id)
       and not exists (
         select 1 from storage.objects stored
         where stored.owner_id = p_target_user_id::text
            or stored.owner = p_target_user_id
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

  if exists (
    select 1
    from storage.objects stored
    where stored.owner_id = p_target_user_id::text
       or stored.owner = p_target_user_id
  ) then
    raise exception using errcode = '55000', message = 'staff_account_owns_storage_objects';
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
    v_expires_at := v_prepared_at + interval '15 minutes';
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

  -- Prepare is deliberately fail-closed.  Once the exact delete has been
  -- authorized and recorded, prevent new staff sessions and revoke every
  -- current lease/session before Edge touches the external Auth API.
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
$$;

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
set statement_timeout = '3000ms'
as $$
declare
  v_expected_email text := lower(btrim(coalesce(p_expected_login_email, '')));
  v_expected_employee_no text := btrim(coalesce(p_expected_employee_no, ''));
  v_actor_employee_id uuid;
  v_target_employee_id uuid;
  v_expires_at timestamptz;
  v_prepared_at timestamptz;
  v_finalized_at timestamptz;
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

  -- A finalizer never assumes the Auth mutation succeeded.  Both the Auth row
  -- and its cascaded access row must be gone before the append-only completion
  -- event and account_delete audit are written.
  if exists (select 1 from auth.users auth_user where auth_user.id = p_target_user_id) then
    raise exception using errcode = '55000', message = 'staff_auth_identity_still_exists';
  end if;
  if exists (select 1 from public.user_access access where access.auth_user_id = p_target_user_id) then
    raise exception using errcode = '55000', message = 'staff_access_row_still_exists';
  end if;
  if exists (
    select 1
    from storage.objects stored
    where stored.owner_id = p_target_user_id::text
       or stored.owner = p_target_user_id
  ) then
    raise exception using errcode = '55000', message = 'staff_account_owns_storage_objects';
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
        'employee_profile_retained', true,
        'recovery_mode', true,
        'operation_id', p_operation_id
      ),
      format('稳定恢复模式删除员工前端登录账号 %s / %s', v_expected_employee_no, v_expected_email)
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
    'employee_profile_retained', true
  );
end;
$$;

revoke all on function public.admin_recovery_prepare_staff_account_delete_v1(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_prepare_staff_account_delete_v1(uuid, uuid, text, text)
  to service_role;

revoke all on function public.admin_recovery_finalize_staff_account_delete_v1(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_finalize_staff_account_delete_v1(uuid, uuid, uuid, text, text)
  to service_role;

comment on table scope_private.recovery_staff_account_delete_operations is
  'Append-only prepare/finalize ledger for recovery-mode staff Auth hard deletion. Target Auth UUIDs intentionally have no FK so reconciliation survives deletion.';
comment on function public.admin_recovery_prepare_staff_account_delete_v1(uuid, uuid, text, text) is
  'Service-only recovery preflight: exact effective delete permission, staff-only identity, employee scope, Auth/email/employee-number match, and zero owned Storage objects.';
comment on function public.admin_recovery_finalize_staff_account_delete_v1(uuid, uuid, uuid, text, text) is
  'Service-only idempotent finalizer. Requires Auth and access absence, appends immutable completion, and atomically writes account_delete audit.';

notify pgrst, 'reload schema';

commit;
