-- Employee portal accounts are valid only while their linked employee remains
-- active or on probation.  Keep the Auth user and all historical records, but
-- reject new staff leases and revoke the current staff session on its next
-- bootstrap/heartbeat check.  Backend access is deliberately left untouched.

create or replace function session_private.staff_portal_account_exists(
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_access access
    join public.employees employee
      on employee.id = access.employee_id
    where access.auth_user_id = p_user_id
      and access.active = true
      and access.employee_portal_enabled = true
      and lower(btrim(coalesce(employee.status::text, ''))) in ('active', 'probation')
  );
$$;

revoke all on function session_private.staff_portal_account_exists(uuid)
  from public, anon, authenticated;
grant execute on function session_private.staff_portal_account_exists(uuid)
  to service_role;

comment on function session_private.staff_portal_account_exists(uuid) is
  'True only when the Auth user has enabled staff access linked to an active/probation employee.';

-- Close any stale staff session that existed before this migration.  Admin
-- leases are intentionally excluded, including on dual-role identities.
delete from auth.sessions auth_session
using public.app_session_leases lease, public.user_access access, public.employees employee
where lease.portal = 'staff'
  and lease.user_id = access.auth_user_id
  and access.employee_portal_enabled = true
  and employee.id = access.employee_id
  and lower(btrim(coalesce(employee.status::text, ''))) not in ('active', 'probation')
  and auth_session.id = lease.session_id
  and auth_session.user_id = lease.user_id;

delete from public.app_session_leases lease
using public.user_access access, public.employees employee
where lease.portal = 'staff'
  and lease.user_id = access.auth_user_id
  and access.employee_portal_enabled = true
  and employee.id = access.employee_id
  and lower(btrim(coalesce(employee.status::text, ''))) not in ('active', 'probation');

-- Existing historical/resigned staff-only accounts must stop passing the
-- login Edge Function's active-account check.  Keep employee_portal_enabled so
-- the existing explicit "restore portal" workflow can reactivate the same
-- account later.  Dual admin/staff identities keep backend access and are
-- still rejected by the employee-status checks below when entering staff.
update public.user_access access
set active = false,
    updated_at = clock_timestamp()
where access.employee_portal_enabled = true
  and access.backend_enabled = false
  and access.active = true
  and access.employee_id is not null
  and exists (
    select 1
    from public.employees employee
    where employee.id = access.employee_id
      and lower(btrim(coalesce(employee.status::text, ''))) not in ('active', 'probation')
  );

create or replace function session_private.disable_inactive_employee_portal_access()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if lower(btrim(coalesce(new.status::text, ''))) not in ('active', 'probation') then
    -- Revoke the currently leased staff browser immediately.  Access JWTs can
    -- remain cryptographically valid until expiry, therefore protected RPCs
    -- also re-check employee status on every request below.
    delete from auth.sessions auth_session
    using public.app_session_leases lease, public.user_access access
    where access.employee_id = new.id
      and access.employee_portal_enabled = true
      and lease.user_id = access.auth_user_id
      and lease.portal = 'staff'
      and auth_session.id = lease.session_id
      and auth_session.user_id = lease.user_id;

    delete from public.app_session_leases lease
    using public.user_access access
    where access.employee_id = new.id
      and access.employee_portal_enabled = true
      and lease.user_id = access.auth_user_id
      and lease.portal = 'staff';

    update public.user_access access
    set active = false,
        updated_at = clock_timestamp()
    where access.employee_id = new.id
      and access.employee_portal_enabled = true
      and access.backend_enabled = false
      and access.active = true;
  end if;
  return new;
end;
$$;

revoke all on function session_private.disable_inactive_employee_portal_access()
  from public, anon, authenticated;

drop trigger if exists employees_disable_inactive_portal_access
  on public.employees;
create trigger employees_disable_inactive_portal_access
after insert or update of status on public.employees
for each row
execute function session_private.disable_inactive_employee_portal_access();

create or replace function session_private.app_session_claim(
  p_portal text default 'staff'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_portal text := lower(btrim(case when p_portal is null then '' else p_portal end));
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz := v_now + interval '5 minutes';
  v_existing public.app_session_leases%rowtype;
  v_had_existing boolean := false;
  v_replaced boolean := false;
  v_revoked_sessions integer := 0;
begin
  select identity.user_id, identity.session_id
  into v_user_id, v_session_id
  from session_private.current_app_session_identity() identity;

  if v_portal not in ('admin', 'staff') then
    raise exception using errcode = '22023', message = 'invalid_portal';
  end if;

  if not exists (
    select 1
    from auth.sessions auth_session
    where auth_session.id = v_session_id
      and auth_session.user_id = v_user_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  if v_portal = 'staff'
     and not session_private.staff_portal_account_exists(v_user_id) then
    -- Revoke only the candidate staff Auth session.  An unrelated backend
    -- lease for the same Auth user must not be touched.
    delete from public.app_session_leases lease
    where lease.user_id = v_user_id
      and lease.portal = 'staff';
    delete from auth.sessions auth_session
    where auth_session.id = v_session_id
      and auth_session.user_id = v_user_id;
    return jsonb_build_object('ok', false, 'reason', 'staff_account_not_found');
  end if;

  if v_portal = 'admin'
     and exists (
       select 1
       from public.user_access access
       where access.auth_user_id = v_user_id
         and access.active = true
         and access.backend_enabled = true
         and access.otp_required = true
     )
     and lower(btrim(
       case
         when (select auth.jwt() ->> 'aal') is null then ''
         else (select auth.jwt() ->> 'aal')
       end
     )) <> 'aal2' then
    return jsonb_build_object('ok', false, 'reason', 'mfa_required');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 20260824)
  );

  select lease.*
  into v_existing
  from public.app_session_leases lease
  where lease.user_id = v_user_id
  for update;

  v_had_existing := found;
  if v_had_existing and v_existing.session_id <> v_session_id then
    v_replaced := true;
  end if;

  delete from auth.sessions auth_session
  where auth_session.user_id = v_user_id
    and auth_session.id <> v_session_id;
  get diagnostics v_revoked_sessions = row_count;
  if v_revoked_sessions > 0 then v_replaced := true; end if;

  insert into public.app_session_leases as lease (
    user_id,
    session_id,
    portal,
    claimed_at,
    last_seen_at,
    lease_expires_at
  ) values (
    v_user_id,
    v_session_id,
    v_portal,
    v_now,
    v_now,
    v_expires_at
  )
  on conflict (user_id) do update
  set session_id = excluded.session_id,
      portal = excluded.portal,
      claimed_at = case
        when lease.session_id = excluded.session_id then lease.claimed_at
        else excluded.claimed_at
      end,
      last_seen_at = excluded.last_seen_at,
      lease_expires_at = excluded.lease_expires_at;

  return jsonb_build_object(
    'ok', true,
    'reason', case
      when v_replaced then 'replaced'
      when v_had_existing and v_existing.session_id = v_session_id then 'continued'
      else 'claimed'
    end,
    'replaced_previous_session', v_replaced,
    'lease_expires_at', v_expires_at,
    'heartbeat_interval_seconds', 60
  );
end;
$$;

create or replace function session_private.app_session_bootstrap_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_backend_enabled boolean;
  v_employee_portal_enabled boolean;
  v_active boolean;
  v_otp_required boolean;
  v_staff_account_exists boolean;
  v_current_portal text;
begin
  select identity.user_id, identity.session_id
  into v_user_id, v_session_id
  from session_private.current_app_session_identity() identity;

  if not exists (
    select 1
    from auth.sessions auth_session
    where auth_session.id = v_session_id
      and auth_session.user_id = v_user_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  select lease.portal
  into v_current_portal
  from public.app_session_leases lease
  where lease.user_id = v_user_id
    and lease.session_id = v_session_id
  limit 1;

  v_staff_account_exists := session_private.staff_portal_account_exists(v_user_id);
  if v_current_portal = 'staff' and not v_staff_account_exists then
    return jsonb_build_object('ok', false, 'reason', 'staff_account_not_found');
  end if;

  select
    access.backend_enabled,
    access.employee_portal_enabled,
    access.active,
    access.otp_required
  into
    v_backend_enabled,
    v_employee_portal_enabled,
    v_active,
    v_otp_required
  from public.user_access access
  where access.auth_user_id = v_user_id
  order by access.updated_at desc
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'access_missing');
  end if;

  return jsonb_build_object(
    'ok', true,
    'access', jsonb_build_object(
      'backend_enabled', v_backend_enabled,
      'employee_portal_enabled', v_employee_portal_enabled and v_staff_account_exists,
      'staff_account_exists', v_staff_account_exists,
      'active', v_active,
      'otp_required', v_otp_required
    )
  );
end;
$$;

create or replace function session_private.app_session_heartbeat()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_portal text;
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz := v_now + interval '5 minutes';
  v_updated boolean := false;
begin
  select identity.user_id, identity.session_id
  into v_user_id, v_session_id
  from session_private.current_app_session_identity() identity;

  if not exists (
    select 1
    from auth.sessions auth_session
    where auth_session.id = v_session_id
      and auth_session.user_id = v_user_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  select lease.portal
  into v_portal
  from public.app_session_leases lease
  where lease.user_id = v_user_id
    and lease.session_id = v_session_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;

  if v_portal = 'staff'
     and not session_private.staff_portal_account_exists(v_user_id) then
    delete from public.app_session_leases lease
    where lease.user_id = v_user_id
      and lease.session_id = v_session_id;
    delete from auth.sessions auth_session
    where auth_session.id = v_session_id
      and auth_session.user_id = v_user_id;
    return jsonb_build_object('ok', false, 'reason', 'staff_account_not_found');
  end if;

  update public.app_session_leases lease
  set last_seen_at = v_now,
      lease_expires_at = v_expires_at
  where lease.user_id = v_user_id
    and lease.session_id = v_session_id
  returning true into v_updated;

  if v_updated is not true then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;

  return jsonb_build_object(
    'ok', true,
    'reason', 'renewed',
    'lease_expires_at', v_expires_at,
    'heartbeat_interval_seconds', 60
  );
end;
$$;

create or replace function session_private.current_app_session_is_valid(
  p_portal text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session_text text := nullif(btrim(
    case
      when (select auth.jwt() ->> 'session_id') is null then ''
      else (select auth.jwt() ->> 'session_id')
    end
  ), '');
  v_aal text := lower(btrim(
    case
      when (select auth.jwt() ->> 'aal') is null then ''
      else (select auth.jwt() ->> 'aal')
    end
  ));
  v_session_id uuid;
begin
  if v_user_id is null or v_session_text is null then return false; end if;
  begin
    v_session_id := v_session_text::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  return exists (
    select 1
    from public.app_session_leases lease
    join auth.sessions auth_session
      on auth_session.id = lease.session_id
     and auth_session.user_id = lease.user_id
    where lease.user_id = v_user_id
      and lease.session_id = v_session_id
      and lease.lease_expires_at > clock_timestamp()
      and (
        p_portal is null
        or lease.portal = lower(btrim(p_portal))
      )
      and (
        lease.portal <> 'staff'
        or session_private.staff_portal_account_exists(v_user_id)
      )
      and (
        lease.portal <> 'admin'
        or not exists (
          select 1
          from public.user_access access
          where access.auth_user_id = v_user_id
            and access.active = true
            and access.backend_enabled = true
            and access.otp_required = true
        )
        or v_aal = 'aal2'
      )
  );
end;
$$;

revoke all on function session_private.app_session_claim(text)
  from public, anon, authenticated;
revoke all on function session_private.app_session_bootstrap_access()
  from public, anon, authenticated;
revoke all on function session_private.app_session_heartbeat()
  from public, anon, authenticated;
revoke all on function session_private.current_app_session_is_valid(text)
  from public, anon;

grant execute on function session_private.current_app_session_is_valid(text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
