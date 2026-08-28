begin;

-- A browser can sign out (or be signed out after a release change) between the
-- first auth.sessions existence check and the attestation upsert. Revalidate
-- and hold the parent session row immediately before inserting the FK child so
-- that this normal logout race returns auth_session_missing instead of a 409
-- from PostgREST and a misleading 503 from admin-ip-guard.
create or replace function public.admin_ip_session_attest(
  p_user_id uuid,
  p_session_id uuid,
  p_client_ip text,
  p_source text default 'heartbeat'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '750ms'
as $$
declare
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_gate jsonb;
  v_client_ip inet;
  v_match_id bigint;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_session_id is null then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;
  if v_source not in ('login', 'claim', 'heartbeat', 'management') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_source');
  end if;

  if not exists (
    select 1
    from auth.sessions auth_session
    where auth_session.id = p_session_id
      and auth_session.user_id = p_user_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  if not exists (
    select 1
    from public.user_access access
    where access.auth_user_id = p_user_id
      and access.active = true
      and access.backend_enabled = true
  ) then
    return jsonb_build_object('ok', false, 'reason', 'account_unavailable');
  end if;

  v_gate := public.admin_ip_prelogin_check(p_client_ip);
  if coalesce((v_gate->>'effective')::boolean, false) = false then
    delete from public.admin_ip_session_attestations attestation
    where attestation.session_id = p_session_id;
    return v_gate || jsonb_build_object('session_attested', false);
  end if;

  if coalesce((v_gate->>'ok')::boolean, false) = false then
    if v_gate->>'reason' = 'ip_not_allowed' then
      delete from public.admin_ip_session_attestations attestation
      where attestation.session_id = p_session_id;
      delete from public.app_session_leases lease
      where lease.user_id = p_user_id
        and lease.session_id = p_session_id
        and lease.portal = 'admin';
      delete from auth.sessions auth_session
      where auth_session.id = p_session_id
        and auth_session.user_id = p_user_id;
      return v_gate || jsonb_build_object('session_revoked', true);
    end if;
    return v_gate || jsonb_build_object('session_revoked', false);
  end if;

  v_client_ip := (v_gate->>'client_ip')::inet;
  v_match_id := (v_gate->>'matched_entry_id')::bigint;

  -- Lock only the allowed-session write path and only immediately before the
  -- child write. If logout already won, NOT FOUND produces a normal auth result;
  -- if this statement wins, the FK parent remains valid through the upsert.
  perform 1
  from auth.sessions auth_session
  where auth_session.id = p_session_id
    and auth_session.user_id = p_user_id
  for key share;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'reason', 'auth_session_missing',
      'session_attested', false
    );
  end if;

  insert into public.admin_ip_session_attestations as attestation (
    session_id,
    user_id,
    ip_address,
    matched_entry_id,
    source,
    verified_at,
    verified_until
  ) values (
    p_session_id,
    p_user_id,
    v_client_ip,
    v_match_id,
    v_source,
    v_now,
    v_now + interval '5 minutes'
  )
  on conflict (session_id) do update
  set user_id = excluded.user_id,
      ip_address = excluded.ip_address,
      matched_entry_id = excluded.matched_entry_id,
      source = excluded.source,
      verified_at = excluded.verified_at,
      verified_until = excluded.verified_until;

  update public.admin_ip_allowlist_entries entry
  set last_hit_at = v_now,
      last_hit_ip = v_client_ip,
      last_hit_user_id = p_user_id,
      hit_count = entry.hit_count + 1
  where entry.id = v_match_id;

  return v_gate || jsonb_build_object('session_attested', true);
end;
$$;

comment on function public.admin_ip_session_attest(uuid, uuid, text, text) is
  'Binds a gateway-observed IP to an existing Auth session; re-locks the parent session before the FK child write so concurrent logout returns auth_session_missing instead of an infrastructure error.';

commit;
