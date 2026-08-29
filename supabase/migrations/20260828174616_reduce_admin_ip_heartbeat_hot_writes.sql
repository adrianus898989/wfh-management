begin;

-- Production-safe DDL guardrails: never queue behind a busy admin request and
-- never let this small compatibility migration become an application outage.
set local lock_timeout = '500ms';
set local statement_timeout = '10s';

-- The existing partial B-tree helps equality/order operations but does not
-- accelerate the <<= containment predicate used by every live IP check.
-- PostgreSQL's explicit GiST inet_ops class supports IPv4/IPv6 containment.
create index if not exists admin_ip_allowlist_entries_enabled_network_gist_idx
  on public.admin_ip_allowlist_entries
  using gist (ip_network inet_ops)
  where enabled = true;

-- Once the operator explicitly enables enforcement, an accidentally emptied
-- list is a deny-all state. The management RPC already refuses to enable an
-- empty list or remove the operator's last matching CIDR; owner-only recovery
-- remains available for out-of-band corruption. Treating zero rows as
-- disabled would silently reopen every admin surface.
create or replace function session_private.admin_ip_enforcement_effective()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select setting.enforced
    from public.admin_ip_allowlist_settings setting
    where setting.id = 1
  ), false);
$$;

create or replace function public.admin_ip_prelogin_check(
  p_client_ip text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_enforced boolean := false;
  v_enabled_count integer := 0;
  v_client_ip inet;
  v_match_id bigint;
begin
  select setting.enforced
  into v_enforced
  from public.admin_ip_allowlist_settings setting
  where setting.id = 1;

  select count(*)::integer
  into v_enabled_count
  from public.admin_ip_allowlist_entries entry
  where entry.enabled = true;

  begin
    v_client_ip := nullif(btrim(coalesce(p_client_ip, '')), '')::inet;
  exception when invalid_text_representation then
    v_client_ip := null;
  end;

  if v_client_ip is not null then
    select entry.id
    into v_match_id
    from public.admin_ip_allowlist_entries entry
    where entry.enabled = true
      and v_client_ip <<= entry.ip_network
    order by masklen(entry.ip_network) desc, entry.id
    limit 1;
  end if;

  if not coalesce(v_enforced, false) then
    return jsonb_build_object(
      'ok', true,
      'enforced', false,
      'effective', false,
      'reason', 'enforcement_disabled',
      'client_ip', case when v_client_ip is null then null else host(v_client_ip) end,
      'matched_entry_id', v_match_id,
      'enabled_count', v_enabled_count
    );
  end if;

  if v_enabled_count = 0 then
    return jsonb_build_object(
      'ok', false,
      'enforced', true,
      'effective', true,
      'reason', 'ip_not_allowed',
      'matched_entry_id', null,
      'enabled_count', 0
    );
  end if;

  if v_client_ip is null then
    return jsonb_build_object(
      'ok', false,
      'enforced', true,
      'effective', true,
      'reason', 'client_ip_unavailable',
      'enabled_count', v_enabled_count
    );
  end if;

  return jsonb_build_object(
    'ok', v_match_id is not null,
    'enforced', true,
    'effective', true,
    'reason', case when v_match_id is null then 'ip_not_allowed' else 'matched' end,
    'client_ip', host(v_client_ip),
    'matched_entry_id', v_match_id,
    'enabled_count', v_enabled_count
  );
end;
$$;

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
  v_existing_ip inet;
  v_existing_match_id bigint;
  v_existing_until timestamptz;
  v_attestation_refreshed boolean := false;
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
    return v_gate || jsonb_build_object(
      'session_attested', false,
      'attestation_refreshed', false
    );
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

  select
    attestation.ip_address,
    attestation.matched_entry_id,
    attestation.verified_until
  into
    v_existing_ip,
    v_existing_match_id,
    v_existing_until
  from public.admin_ip_session_attestations attestation
  where attestation.session_id = p_session_id
    and attestation.user_id = p_user_id;

  if v_existing_ip is distinct from v_client_ip
     or v_existing_match_id is distinct from v_match_id
     or v_existing_until is null
     or v_existing_until <= v_now + interval '2 minutes' then
    perform 1
    from auth.sessions auth_session
    where auth_session.id = p_session_id
      and auth_session.user_id = p_user_id
    for key share;
    if not found then
      return jsonb_build_object(
        'ok', false,
        'reason', 'auth_session_missing',
        'session_attested', false,
        'attestation_refreshed', false
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

    v_attestation_refreshed := true;
  end if;

  if v_source = 'login' and v_attestation_refreshed then
    update public.admin_ip_allowlist_entries entry
    set last_hit_at = v_now,
        last_hit_ip = v_client_ip,
        last_hit_user_id = p_user_id,
        hit_count = entry.hit_count + 1
    where entry.id = v_match_id;
  end if;

  return v_gate || jsonb_build_object(
    'session_attested', true,
    'attestation_refreshed', v_attestation_refreshed
  );
end;
$$;

comment on function public.admin_ip_session_attest(uuid, uuid, text, text) is
  'Checks the live gateway IP on every call, refreshes the per-session attestation only inside a two-minute reserve, and records shared allowlist hits only once per successful login.';

commit;
