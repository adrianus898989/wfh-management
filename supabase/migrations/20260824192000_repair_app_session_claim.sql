-- Repair the production last-login-wins claim function.
--
-- The previously deployed definition qualified COALESCE as
-- pg_catalog.coalesce(...). COALESCE is PostgreSQL SQL syntax rather than a
-- schema function, so every admin/staff login failed before a lease could be
-- created.  A CASE expression avoids that invalid rewrite and keeps the
-- takeover atomic.

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

  -- Revoked/signed-out access tokens can remain cryptographically valid until
  -- expiry.  They must never be able to reclaim the application lease.
  if not exists (
    select 1
    from auth.sessions auth_session
    where auth_session.id = v_session_id
      and auth_session.user_id = v_user_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  -- A password-only JWT cannot create an admin lease when this account is
  -- configured for MFA.  This is enforced in the database, not only in React.
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

  -- Clean up every older Auth session for this user, including sessions left
  -- behind by a historical claim failure before a lease row was written.
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

revoke all on function session_private.app_session_claim(text)
  from public, anon, authenticated;
revoke all on function public.app_session_claim(text)
  from public, anon;
grant execute on function public.app_session_claim(text)
  to authenticated, service_role;

comment on function session_private.app_session_claim(text) is
  'Atomically makes the authenticated JWT session the sole current app session and revokes the previous auth session.';

-- Bootstrap only the current user's four entry flags before a browser lease
-- exists. user_access itself remains lease-protected by RLS. This narrow RPC
-- breaks the login bootstrap cycle without exposing roles, permissions,
-- employee scope, or any other user's data.
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
      'employee_portal_enabled', v_employee_portal_enabled,
      'active', v_active,
      'otp_required', v_otp_required
    )
  );
end;
$$;

create or replace function public.app_session_bootstrap_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select session_private.app_session_bootstrap_access();
$$;

-- An AAL1 token minted before MFA verification can share the same session_id
-- as the later AAL2 token. Validate AAL on every protected admin operation,
-- not only when the lease is first claimed.
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

revoke all on function session_private.app_session_bootstrap_access()
  from public, anon, authenticated;
revoke all on function public.app_session_bootstrap_access()
  from public, anon;
grant execute on function public.app_session_bootstrap_access()
  to authenticated, service_role;

revoke all on function session_private.current_app_session_is_valid(text)
  from public, anon;
grant execute on function session_private.current_app_session_is_valid(text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
