-- A successful new sign-in becomes the only active application session.
-- The old browser keeps a cryptographically valid access token until its JWT
-- expires, so every protected RPC still checks app_session_leases. Removing the
-- old auth.sessions row also revokes its refresh token immediately; its next
-- heartbeat or protected request is rejected and the UI signs it out.

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
  -- COALESCE is SQL syntax, not a normal pg_catalog function.  Keep this as a
  -- CASE expression so SQL hardening/qualification tools cannot accidentally
  -- rewrite it to the invalid pg_catalog.coalesce(...).
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

  -- A password-only (AAL1) token cannot create an admin lease for an account
  -- that requires MFA.  Enforce this in PostgreSQL so callers cannot bypass
  -- the MFA screen by invoking the public RPC directly.
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

  -- Serialize takeovers so two nearly simultaneous logins cannot both remain.
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

  -- Failed historical claims can leave valid Auth sessions that never reached
  -- app_session_leases. Remove every other session for this user, not only the
  -- one referenced by the old lease, so the latest completed login is truly
  -- the sole browser. auth.refresh_tokens cascades with auth.sessions.
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

-- Browsers call only the public SECURITY DEFINER wrapper created by the base
-- session migration.  The private implementation must remain unreachable.
grant execute on function public.app_session_claim(text) to authenticated;

comment on function session_private.app_session_claim(text) is
  'Atomically makes the authenticated JWT session the sole current app session and revokes the previous auth session.';
