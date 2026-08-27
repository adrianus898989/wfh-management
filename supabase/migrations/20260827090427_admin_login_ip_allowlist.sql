begin;

-- A dedicated, sensitive permission keeps the menu and the Edge Function in
-- sync. Founder remains implicitly authorized by public.has_permission().
insert into public.permissions (code, name, category, sensitive)
values (
  'account.ip_allowlist.manage',
  '后台账号 · 管理登录IP白名单',
  'account',
  true
)
on conflict (code) do update
set name = excluded.name,
    category = excluded.category,
    sensitive = excluded.sensitive;

-- Enforcement is deliberately off after migration. It can only become
-- effective when the explicit switch is on and at least one enabled network
-- exists. The second condition is the bootstrap safety rule that prevents an
-- empty list (including accidental out-of-band edits) from locking everyone
-- out of the backend.
create table public.admin_ip_allowlist_settings (
  id smallint primary key default 1,
  enforced boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint admin_ip_allowlist_settings_singleton_check check (id = 1)
);

insert into public.admin_ip_allowlist_settings (id, enforced)
values (1, false)
on conflict (id) do nothing;

create table public.admin_ip_allowlist_entries (
  id bigint generated always as identity primary key,
  ip_network cidr not null,
  label text not null,
  notes text not null default '',
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  last_hit_at timestamptz,
  last_hit_ip inet,
  last_hit_user_id uuid references auth.users(id) on delete set null,
  hit_count bigint not null default 0,
  constraint admin_ip_allowlist_entries_network_unique unique (ip_network),
  constraint admin_ip_allowlist_entries_label_check
    check (char_length(btrim(label)) between 1 and 80),
  constraint admin_ip_allowlist_entries_notes_check
    check (char_length(notes) <= 500),
  constraint admin_ip_allowlist_entries_hit_count_check
    check (hit_count >= 0)
);

-- An IP attestation can only be written by the service-role RPC after the Edge
-- runtime has read the hosted gateway-owned CF-Connecting-IP value. Browser input is
-- never accepted by a normal authenticated RPC.
create table public.admin_ip_session_attestations (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ip_address inet not null,
  matched_entry_id bigint references public.admin_ip_allowlist_entries(id)
    on delete set null,
  source text not null,
  verified_at timestamptz not null,
  verified_until timestamptz not null,
  constraint admin_ip_session_attestations_source_check
    check (source in ('login', 'claim', 'heartbeat', 'management')),
  constraint admin_ip_session_attestations_freshness_check
    check (verified_until > verified_at)
);

create index admin_ip_allowlist_entries_enabled_network_idx
  on public.admin_ip_allowlist_entries (ip_network)
  where enabled = true;
create index admin_ip_allowlist_entries_created_by_idx
  on public.admin_ip_allowlist_entries (created_by);
create index admin_ip_allowlist_entries_last_hit_user_idx
  on public.admin_ip_allowlist_entries (last_hit_user_id)
  where last_hit_user_id is not null;
create index admin_ip_session_attestations_user_idx
  on public.admin_ip_session_attestations (user_id);
create index admin_ip_allowlist_settings_updated_by_idx
  on public.admin_ip_allowlist_settings (updated_by)
  where updated_by is not null;

alter table public.admin_ip_allowlist_settings enable row level security;
alter table public.admin_ip_allowlist_entries enable row level security;
alter table public.admin_ip_session_attestations enable row level security;

revoke all on table public.admin_ip_allowlist_settings
  from public, anon, authenticated;
revoke all on table public.admin_ip_allowlist_entries
  from public, anon, authenticated;
revoke all on table public.admin_ip_session_attestations
  from public, anon, authenticated;
revoke all on sequence public.admin_ip_allowlist_entries_id_seq
  from public, anon, authenticated;

grant select, insert, update, delete on table public.admin_ip_allowlist_settings
  to service_role;
grant select, insert, update, delete on table public.admin_ip_allowlist_entries
  to service_role;
grant select, insert, update, delete on table public.admin_ip_session_attestations
  to service_role;
grant usage, select on sequence public.admin_ip_allowlist_entries_id_seq
  to service_role;

comment on table public.admin_ip_allowlist_settings is
  'Singleton switch for backend-login IP enforcement; disabled by default and ineffective while no enabled entry exists.';
comment on table public.admin_ip_allowlist_entries is
  'Service-owned IPv4/IPv6 CIDR networks allowed to authenticate and retain a backend session.';
comment on table public.admin_ip_session_attestations is
  'Edge-attested client IP bound to an Auth session; refreshed by admin heartbeats and never writable by browser roles.';

create or replace function session_private.admin_ip_enforcement_effective()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select setting.enforced
      and exists (
        select 1
        from public.admin_ip_allowlist_entries entry
        where entry.enabled = true
      )
    from public.admin_ip_allowlist_settings setting
    where setting.id = 1
  ), false);
$$;

create or replace function session_private.admin_ip_actor_can_manage(
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
    join public.roles role on role.id = access.role_id
    where access.auth_user_id = p_user_id
      and access.active = true
      and access.backend_enabled = true
      and (
        role.code = 'founder'
        or coalesce((
          select override.allowed
          from public.user_permission_overrides override
          join public.permissions permission
            on permission.id = override.permission_id
          where override.auth_user_id = p_user_id
            and permission.code = 'account.ip_allowlist.manage'
          limit 1
        ), exists (
          select 1
          from public.role_permissions role_permission
          join public.permissions permission
            on permission.id = role_permission.permission_id
          where role_permission.role_id = access.role_id
            and permission.code = 'account.ip_allowlist.manage'
        ))
      )
  );
$$;

create or replace function session_private.current_admin_ip_attestation_is_valid(
  p_user_id uuid,
  p_session_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not session_private.admin_ip_enforcement_effective() then true
    else exists (
      select 1
      from public.admin_ip_session_attestations attestation
      join public.admin_ip_allowlist_entries entry
        on entry.id = attestation.matched_entry_id
       and entry.enabled = true
       and attestation.ip_address <<= entry.ip_network
      where attestation.user_id = p_user_id
        and attestation.session_id = p_session_id
        and attestation.verified_until > statement_timestamp()
    )
  end;
$$;

revoke all on function session_private.admin_ip_enforcement_effective()
  from public, anon, authenticated, service_role;
revoke all on function session_private.admin_ip_actor_can_manage(uuid)
  from public, anon, authenticated, service_role;
revoke all on function session_private.current_admin_ip_attestation_is_valid(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Pre-login gate. It performs no account lookup and does not record a hit, so
-- an unauthenticated caller cannot inflate an entry's usage audit fields.
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
      'ok', true,
      'enforced', true,
      'effective', false,
      'reason', 'bootstrap_no_entries',
      'client_ip', case when v_client_ip is null then null else host(v_client_ip) end,
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

-- Bind a gateway-observed address to one real Auth session. Its five-minute
-- freshness matches the existing lease window: one transient Edge failure does
-- not revoke a session, while a direct database heartbeat cannot renew forever
-- after the browser has moved to an unverified network.
-- An explicit non-match removes both the app lease and the Auth session, so a
-- switched network cannot keep using service-role Edge Functions with an old
-- lease. Missing proxy metadata is treated as a retryable infrastructure
-- failure and never destroys an already-valid session.
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

-- All mutations run in one transaction and re-check that the current Edge IP
-- remains covered. To replace a current network, add the new network first;
-- the API will not allow an edit/delete that strands the operator.
create or replace function public.admin_ip_allowlist_mutate(
  p_actor_id uuid,
  p_session_id uuid,
  p_client_ip text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_client_ip inet;
  v_network cidr;
  v_label text;
  v_notes text;
  v_enabled boolean;
  v_enforced boolean;
  v_requested_enforced boolean;
  v_id bigint;
  v_match_id bigint;
  v_enabled_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if not session_private.admin_ip_actor_can_manage(p_actor_id) then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if not exists (
    select 1
    from public.app_session_leases lease
    join auth.sessions auth_session
      on auth_session.id = lease.session_id
     and auth_session.user_id = lease.user_id
    where lease.user_id = p_actor_id
      and lease.session_id = p_session_id
      and lease.portal = 'admin'
      and lease.lease_expires_at > v_now
  ) then
    raise exception using errcode = '28000', message = 'session_not_current';
  end if;

  begin
    v_client_ip := nullif(btrim(coalesce(p_client_ip, '')), '')::inet;
  exception when invalid_text_representation then
    v_client_ip := null;
  end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('admin-ip-allowlist', 20260827)
  );

  select setting.enforced
  into v_enforced
  from public.admin_ip_allowlist_settings setting
  where setting.id = 1
  for update;

  if session_private.admin_ip_enforcement_effective() then
    if v_client_ip is null
       or not exists (
         select 1
         from public.admin_ip_session_attestations attestation
         join public.admin_ip_allowlist_entries entry
           on entry.id = attestation.matched_entry_id
          and entry.enabled = true
          and attestation.ip_address <<= entry.ip_network
         where attestation.user_id = p_actor_id
           and attestation.session_id = p_session_id
           and attestation.ip_address = v_client_ip
       ) then
      raise exception using errcode = '28000', message = 'ip_session_not_verified';
    end if;
  end if;

  if v_action in ('create', 'update') then
    begin
      v_network := nullif(btrim(v_payload->>'ip_network'), '')::cidr;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid_ip_network';
    end;
    if v_network is null then
      raise exception using errcode = '22023', message = 'ip_network_required';
    end if;
    v_label := btrim(coalesce(v_payload->>'label', ''));
    v_notes := btrim(coalesce(v_payload->>'notes', ''));
    if char_length(v_label) not between 1 and 80 then
      raise exception using errcode = '22023', message = 'invalid_label';
    end if;
    if char_length(v_notes) > 500 then
      raise exception using errcode = '22023', message = 'notes_too_long';
    end if;
    begin
      v_enabled := coalesce((v_payload->>'enabled')::boolean, true);
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid_enabled';
    end;
  end if;

  if v_action = 'create' then
    begin
      insert into public.admin_ip_allowlist_entries (
        ip_network, label, notes, enabled, created_by, updated_by
      ) values (
        v_network, v_label, v_notes, v_enabled, p_actor_id, p_actor_id
      ) returning id into v_id;
    exception when unique_violation then
      raise exception using errcode = '23505', message = 'network_already_exists';
    end;
  elsif v_action = 'update' then
    begin
      v_id := (v_payload->>'id')::bigint;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid_entry_id';
    end;
    begin
      update public.admin_ip_allowlist_entries entry
      set ip_network = v_network,
          label = v_label,
          notes = v_notes,
          enabled = v_enabled,
          updated_by = p_actor_id,
          updated_at = v_now
      where entry.id = v_id;
    exception when unique_violation then
      raise exception using errcode = '23505', message = 'network_already_exists';
    end;
    if not found then
      raise exception using errcode = 'P0002', message = 'entry_not_found';
    end if;
  elsif v_action = 'set_enabled' then
    begin
      v_id := (v_payload->>'id')::bigint;
      v_enabled := (v_payload->>'enabled')::boolean;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid_entry_update';
    end;
    if v_id is null or v_enabled is null then
      raise exception using errcode = '22023', message = 'invalid_entry_update';
    end if;
    update public.admin_ip_allowlist_entries entry
    set enabled = v_enabled,
        updated_by = p_actor_id,
        updated_at = v_now
    where entry.id = v_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'entry_not_found';
    end if;
  elsif v_action = 'delete' then
    begin
      v_id := (v_payload->>'id')::bigint;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid_entry_id';
    end;
    delete from public.admin_ip_allowlist_entries entry
    where entry.id = v_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'entry_not_found';
    end if;
  elsif v_action = 'set_enforced' then
    begin
      v_requested_enforced := (v_payload->>'enforced')::boolean;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid_enforced';
    end;
    if v_requested_enforced is null then
      raise exception using errcode = '22023', message = 'invalid_enforced';
    end if;

    if v_requested_enforced then
      select count(*)::integer
      into v_enabled_count
      from public.admin_ip_allowlist_entries entry
      where entry.enabled = true;
      if v_enabled_count = 0 then
        raise exception using errcode = '22023', message = 'cannot_enable_without_entries';
      end if;
      if v_client_ip is null then
        raise exception using errcode = '22023', message = 'client_ip_unavailable';
      end if;
      select entry.id
      into v_match_id
      from public.admin_ip_allowlist_entries entry
      where entry.enabled = true
        and v_client_ip <<= entry.ip_network
      order by masklen(entry.ip_network) desc, entry.id
      limit 1;
      if v_match_id is null then
        raise exception using errcode = '42501', message = 'current_ip_not_allowed';
      end if;
    end if;

    update public.admin_ip_allowlist_settings setting
    set enforced = v_requested_enforced,
        updated_by = p_actor_id,
        updated_at = v_now
    where setting.id = 1;
    v_enforced := v_requested_enforced;

    if v_requested_enforced then
      insert into public.admin_ip_session_attestations as attestation (
        session_id, user_id, ip_address, matched_entry_id,
        source, verified_at, verified_until
      ) values (
        p_session_id, p_actor_id, v_client_ip, v_match_id,
        'management', v_now, v_now + interval '5 minutes'
      )
      on conflict (session_id) do update
      set user_id = excluded.user_id,
          ip_address = excluded.ip_address,
          matched_entry_id = excluded.matched_entry_id,
          source = excluded.source,
          verified_at = excluded.verified_at,
          verified_until = excluded.verified_until;

      -- Existing admin browsers have not proven their current IP. Remove all
      -- except the operator enabling enforcement; they may log in again from
      -- an allowed network. Staff leases are deliberately excluded.
      delete from auth.sessions auth_session
      using public.app_session_leases lease
      where lease.portal = 'admin'
        and lease.user_id <> p_actor_id
        and auth_session.id = lease.session_id
        and auth_session.user_id = lease.user_id;
      delete from public.app_session_leases lease
      where lease.portal = 'admin'
        and lease.user_id <> p_actor_id;
    else
      delete from public.admin_ip_session_attestations;
    end if;
  else
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;

  -- Entry mutations may not silently disable effective enforcement or strand
  -- the caller. Turn the explicit switch off first if the last entry must be
  -- removed.
  if v_action in ('create', 'update', 'set_enabled', 'delete')
     and coalesce(v_enforced, false) then
    select count(*)::integer
    into v_enabled_count
    from public.admin_ip_allowlist_entries entry
    where entry.enabled = true;
    if v_enabled_count = 0 then
      raise exception using errcode = '22023', message = 'last_enabled_entry';
    end if;
    if v_client_ip is null then
      raise exception using errcode = '22023', message = 'client_ip_unavailable';
    end if;
    select entry.id
    into v_match_id
    from public.admin_ip_allowlist_entries entry
    where entry.enabled = true
      and v_client_ip <<= entry.ip_network
    order by masklen(entry.ip_network) desc, entry.id
    limit 1;
    if v_match_id is null then
      raise exception using errcode = '42501', message = 'current_ip_would_be_denied';
    end if;

    insert into public.admin_ip_session_attestations as attestation (
      session_id, user_id, ip_address, matched_entry_id,
      source, verified_at, verified_until
    ) values (
      p_session_id, p_actor_id, v_client_ip, v_match_id,
      'management', v_now, v_now + interval '5 minutes'
    )
    on conflict (session_id) do update
    set user_id = excluded.user_id,
        ip_address = excluded.ip_address,
        matched_entry_id = excluded.matched_entry_id,
        source = excluded.source,
        verified_at = excluded.verified_at,
        verified_until = excluded.verified_until;
  end if;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, reason
  )
  select
    p_actor_id,
    access.employee_id,
    'access_control',
    'admin_ip_allowlist_' || v_action,
    case
      when v_action = 'set_enforced'
        then '后台登录IP白名单开关=' || coalesce(v_requested_enforced::text, '')
      else '后台登录IP白名单条目=' || coalesce(v_id::text, '')
    end
  from public.user_access access
  where access.auth_user_id = p_actor_id
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'action', v_action,
    'id', v_id,
    'enforced', v_enforced
  );
end;
$$;

revoke all on function public.admin_ip_prelogin_check(text)
  from public, anon, authenticated;
revoke all on function public.admin_ip_session_attest(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.admin_ip_allowlist_mutate(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_ip_prelogin_check(text)
  to service_role;
grant execute on function public.admin_ip_session_attest(uuid, uuid, text, text)
  to service_role;
grant execute on function public.admin_ip_allowlist_mutate(uuid, uuid, text, text, jsonb)
  to service_role;

-- Break-glass recovery for a Founder who cannot reach any allowed network.
-- It is intentionally unavailable to anon/authenticated/service_role and can
-- only be run by the database owner in Supabase SQL Editor with the exact
-- confirmation phrase documented in the admin page/README.
create or replace function session_private.founder_recover_admin_ip_allowlist(
  p_confirmation text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_confirmation <> 'DISABLE ADMIN IP ALLOWLIST' then
    raise exception using errcode = '22023', message = 'confirmation_required';
  end if;

  update public.admin_ip_allowlist_settings setting
  set enforced = false,
      updated_at = clock_timestamp(),
      updated_by = null
  where setting.id = 1;
  delete from public.admin_ip_session_attestations;

  return jsonb_build_object(
    'ok', true,
    'enforced', false,
    'reason', 'founder_break_glass_recovery'
  );
end;
$$;

comment on function session_private.founder_recover_admin_ip_allowlist(text) is
  'SQL-owner-only break-glass switch-off for backend IP allowlist lockout.';
revoke all on function session_private.founder_recover_admin_ip_allowlist(text)
  from public, anon, authenticated, service_role;

-- Replace the latest session implementations without changing staff behavior.
-- A new admin lease requires an Edge-created attestation, which prevents a
-- browser from bypassing admin-login with a direct Auth API call. The normal
-- five-minute lease lifetime is preserved. A failed Edge heartbeat never
-- revokes the session, but it also cannot refresh the IP attestation or lease.
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
    select 1 from auth.sessions auth_session
    where auth_session.id = v_session_id
      and auth_session.user_id = v_user_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  if v_portal = 'staff'
     and not session_private.staff_portal_account_exists(v_user_id) then
    delete from public.app_session_leases lease
    where lease.user_id = v_user_id and lease.portal = 'staff';
    delete from auth.sessions auth_session
    where auth_session.id = v_session_id and auth_session.user_id = v_user_id;
    return jsonb_build_object('ok', false, 'reason', 'staff_account_not_found');
  end if;

  if v_portal = 'admin'
     and session_private.admin_ip_enforcement_effective() then
    if not session_private.current_admin_ip_attestation_is_valid(v_user_id, v_session_id) then
      return jsonb_build_object('ok', false, 'reason', 'ip_check_required');
    end if;
  end if;

  if v_portal = 'admin'
     and exists (
       select 1 from public.user_access access
       where access.auth_user_id = v_user_id
         and access.active = true
         and access.backend_enabled = true
         and access.otp_required = true
     )
     and lower(btrim(case
       when (select auth.jwt() ->> 'aal') is null then ''
       else (select auth.jwt() ->> 'aal')
     end)) <> 'aal2' then
    return jsonb_build_object('ok', false, 'reason', 'mfa_required');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 20260824)
  );

  select lease.* into v_existing
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
    user_id, session_id, portal, claimed_at, last_seen_at, lease_expires_at
  ) values (
    v_user_id, v_session_id, v_portal, v_now, v_now, v_expires_at
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
    select 1 from auth.sessions auth_session
    where auth_session.id = v_session_id
      and auth_session.user_id = v_user_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  select lease.portal into v_portal
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
    where lease.user_id = v_user_id and lease.session_id = v_session_id;
    delete from auth.sessions auth_session
    where auth_session.id = v_session_id and auth_session.user_id = v_user_id;
    return jsonb_build_object('ok', false, 'reason', 'staff_account_not_found');
  end if;

  if v_portal = 'admin'
     and session_private.admin_ip_enforcement_effective() then
    if not session_private.current_admin_ip_attestation_is_valid(v_user_id, v_session_id) then
      return jsonb_build_object('ok', false, 'reason', 'ip_check_required');
    end if;
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
  v_session_text text := nullif(btrim(case
    when (select auth.jwt() ->> 'session_id') is null then ''
    else (select auth.jwt() ->> 'session_id')
  end), '');
  v_aal text := lower(btrim(case
    when (select auth.jwt() ->> 'aal') is null then ''
    else (select auth.jwt() ->> 'aal')
  end));
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
      and (p_portal is null or lease.portal = lower(btrim(p_portal)))
      and (
        lease.portal <> 'staff'
        or session_private.staff_portal_account_exists(v_user_id)
      )
      and (
        lease.portal <> 'admin'
        or session_private.current_admin_ip_attestation_is_valid(v_user_id, v_session_id)
      )
      and (
        lease.portal <> 'admin'
        or not exists (
          select 1 from public.user_access access
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
revoke all on function session_private.app_session_heartbeat()
  from public, anon, authenticated;
revoke all on function session_private.current_app_session_is_valid(text)
  from public, anon;
grant execute on function session_private.current_app_session_is_valid(text)
  to authenticated, service_role;
grant execute on function public.app_session_claim(text)
  to authenticated, service_role;
grant execute on function public.app_session_heartbeat()
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
