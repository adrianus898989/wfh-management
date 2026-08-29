begin;

-- This migration only installs the capability. Staff enforcement stays OFF
-- until an authorized admin has added at least one staff/both CIDR and then
-- explicitly enables it from the allowlist page.
set local lock_timeout = '500ms';
set local statement_timeout = '15s';

alter table public.admin_ip_allowlist_entries
  add column if not exists portal_scope text not null default 'admin';

do $scope_constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.admin_ip_allowlist_entries'::regclass
      and constraint_row.conname = 'admin_ip_allowlist_entries_portal_scope_check'
  ) then
    alter table public.admin_ip_allowlist_entries
      add constraint admin_ip_allowlist_entries_portal_scope_check
      check (portal_scope in ('admin', 'staff', 'both'));
  end if;
end
$scope_constraint$;

alter table public.admin_ip_allowlist_settings
  add column if not exists staff_enforced boolean not null default false,
  add column if not exists staff_updated_at timestamptz,
  add column if not exists staff_updated_by uuid references auth.users(id) on delete set null;

create index if not exists admin_ip_allowlist_entries_scope_enabled_idx
  on public.admin_ip_allowlist_entries (portal_scope, id)
  where enabled = true;
create index if not exists admin_ip_allowlist_settings_staff_updated_by_idx
  on public.admin_ip_allowlist_settings (staff_updated_by)
  where staff_updated_by is not null;

create table if not exists public.staff_ip_session_attestations (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ip_address inet not null,
  matched_entry_id bigint references public.admin_ip_allowlist_entries(id)
    on delete set null,
  source text not null,
  verified_at timestamptz not null,
  verified_until timestamptz not null,
  constraint staff_ip_session_attestations_source_check
    check (source in ('login', 'claim', 'heartbeat')),
  constraint staff_ip_session_attestations_freshness_check
    check (verified_until > verified_at)
);

create index if not exists staff_ip_session_attestations_user_idx
  on public.staff_ip_session_attestations (user_id);

alter table public.staff_ip_session_attestations enable row level security;
revoke all on table public.staff_ip_session_attestations
  from public, anon, authenticated;
grant select, insert, update, delete on table public.staff_ip_session_attestations
  to service_role;

comment on column public.admin_ip_allowlist_entries.portal_scope is
  'Portal coverage for this CIDR: admin, staff, or both. Existing rows are retained as admin-only.';
comment on column public.admin_ip_allowlist_settings.staff_enforced is
  'Explicit staff-portal enforcement switch. Defaults false so installing this migration cannot lock out staff.';
comment on table public.staff_ip_session_attestations is
  'Edge-attested staff client IP bound to an Auth session; never writable by browser roles.';

create or replace function session_private.portal_ip_enforcement_effective(
  p_portal text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case lower(btrim(coalesce(p_portal, '')))
    when 'admin' then coalesce(setting.enforced, false)
    when 'staff' then coalesce(setting.staff_enforced, false)
    else false
  end
  from public.admin_ip_allowlist_settings setting
  where setting.id = 1;
$$;

create or replace function session_private.admin_ip_enforcement_effective()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select session_private.portal_ip_enforcement_effective('admin');
$$;

create or replace function public.portal_ip_prelogin_check(
  p_portal text,
  p_client_ip text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_portal text := lower(btrim(coalesce(p_portal, '')));
  v_enforced boolean := false;
  v_enabled_count integer := 0;
  v_client_ip inet;
  v_match_id bigint;
begin
  if v_portal not in ('admin', 'staff') then
    return jsonb_build_object(
      'ok', false,
      'enforced', false,
      'effective', false,
      'reason', 'invalid_portal',
      'enabled_count', 0
    );
  end if;

  v_enforced := session_private.portal_ip_enforcement_effective(v_portal);

  select count(*)::integer
  into v_enabled_count
  from public.admin_ip_allowlist_entries entry
  where entry.enabled = true
    and (
      entry.portal_scope = 'both'
      or entry.portal_scope = v_portal
    );

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
      and (entry.portal_scope = 'both' or entry.portal_scope = v_portal)
      and v_client_ip <<= entry.ip_network
    order by masklen(entry.ip_network) desc, entry.id
    limit 1;
  end if;

  if not v_enforced then
    return jsonb_build_object(
      'ok', true,
      'portal', v_portal,
      'enforced', false,
      'effective', false,
      'reason', 'enforcement_disabled',
      'client_ip', case when v_client_ip is null then null else host(v_client_ip) end,
      'matched_entry_id', v_match_id,
      'enabled_count', v_enabled_count
    );
  end if;

  -- Once explicitly enabled, an empty portal-specific list is deny-all. This
  -- avoids silently reopening access after an accidental out-of-band delete.
  if v_enabled_count = 0 then
    return jsonb_build_object(
      'ok', false,
      'portal', v_portal,
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
      'portal', v_portal,
      'enforced', true,
      'effective', true,
      'reason', 'client_ip_unavailable',
      'enabled_count', v_enabled_count
    );
  end if;

  return jsonb_build_object(
    'ok', v_match_id is not null,
    'portal', v_portal,
    'enforced', true,
    'effective', true,
    'reason', case when v_match_id is null then 'ip_not_allowed' else 'matched' end,
    'client_ip', host(v_client_ip),
    'matched_entry_id', v_match_id,
    'enabled_count', v_enabled_count
  );
end;
$$;

-- Compatibility wrapper for existing admin Edge Functions and recovery code.
create or replace function public.admin_ip_prelogin_check(
  p_client_ip text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.portal_ip_prelogin_check('admin', p_client_ip);
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
    when not session_private.portal_ip_enforcement_effective('admin') then true
    else exists (
      select 1
      from public.admin_ip_session_attestations attestation
      join public.admin_ip_allowlist_entries entry
        on entry.id = attestation.matched_entry_id
       and entry.enabled = true
       and entry.portal_scope in ('admin', 'both')
       and attestation.ip_address <<= entry.ip_network
      where attestation.user_id = p_user_id
        and attestation.session_id = p_session_id
        and attestation.verified_until > statement_timestamp()
    )
  end;
$$;

create or replace function session_private.current_staff_ip_attestation_is_valid(
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
    when not session_private.portal_ip_enforcement_effective('staff') then true
    else exists (
      select 1
      from public.staff_ip_session_attestations attestation
      join public.admin_ip_allowlist_entries entry
        on entry.id = attestation.matched_entry_id
       and entry.enabled = true
       and entry.portal_scope in ('staff', 'both')
       and attestation.ip_address <<= entry.ip_network
      where attestation.user_id = p_user_id
        and attestation.session_id = p_session_id
        and attestation.verified_until > statement_timestamp()
    )
  end;
$$;

create or replace function public.staff_ip_session_attest(
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
  if v_source not in ('login', 'claim', 'heartbeat') then
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

  if not session_private.staff_portal_account_exists(p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'staff_account_not_found');
  end if;

  v_gate := public.portal_ip_prelogin_check('staff', p_client_ip);
  if coalesce((v_gate->>'effective')::boolean, false) = false then
    delete from public.staff_ip_session_attestations attestation
    where attestation.session_id = p_session_id;
    return v_gate || jsonb_build_object(
      'session_attested', false,
      'attestation_refreshed', false
    );
  end if;

  if coalesce((v_gate->>'ok')::boolean, false) = false then
    if v_gate->>'reason' = 'ip_not_allowed' then
      delete from public.staff_ip_session_attestations attestation
      where attestation.session_id = p_session_id;
      delete from public.app_session_leases lease
      where lease.user_id = p_user_id
        and lease.session_id = p_session_id
        and lease.portal = 'staff';
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
  from public.staff_ip_session_attestations attestation
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

    insert into public.staff_ip_session_attestations as attestation (
      session_id, user_id, ip_address, matched_entry_id,
      source, verified_at, verified_until
    ) values (
      p_session_id, p_user_id, v_client_ip, v_match_id,
      v_source, v_now, v_now + interval '5 minutes'
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

-- One serialized management API covers both portal switches and entry scopes.
-- Existing admin-only mutation RPC remains available for rollback compatibility,
-- while the updated Edge Function calls this new API.
create or replace function public.portal_ip_allowlist_mutate(
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
set lock_timeout = '750ms'
as $$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_client_ip inet;
  v_network cidr;
  v_label text;
  v_notes text;
  v_enabled boolean;
  v_scope text;
  v_portal text;
  v_requested_enforced boolean;
  v_admin_enforced boolean := false;
  v_staff_enforced boolean := false;
  v_id bigint;
  v_admin_match_id bigint;
  v_admin_count integer := 0;
  v_staff_count integer := 0;
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

  if session_private.portal_ip_enforcement_effective('admin') then
    if v_client_ip is null
       or not exists (
         select 1
         from public.admin_ip_session_attestations attestation
         join public.admin_ip_allowlist_entries entry
           on entry.id = attestation.matched_entry_id
          and entry.enabled = true
          and entry.portal_scope in ('admin', 'both')
          and attestation.ip_address <<= entry.ip_network
         where attestation.user_id = p_actor_id
           and attestation.session_id = p_session_id
           and attestation.ip_address = v_client_ip
           and attestation.verified_until > v_now
       ) then
      raise exception using errcode = '28000', message = 'ip_session_not_verified';
    end if;
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('portal-ip-allowlist', 20260829)
  ) then
    raise exception using errcode = '55P03', message = 'configuration_busy';
  end if;

  select setting.enforced, setting.staff_enforced
  into v_admin_enforced, v_staff_enforced
  from public.admin_ip_allowlist_settings setting
  where setting.id = 1
  for update;

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
    v_scope := lower(btrim(coalesce(v_payload->>'portal_scope', 'admin')));
    if v_scope not in ('admin', 'staff', 'both') then
      raise exception using errcode = '22023', message = 'invalid_portal_scope';
    end if;
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
        ip_network, label, notes, enabled, portal_scope, created_by, updated_by
      ) values (
        v_network, v_label, v_notes, v_enabled, v_scope, p_actor_id, p_actor_id
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
          portal_scope = v_scope,
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
    v_portal := lower(btrim(coalesce(v_payload->>'portal', '')));
    if v_portal not in ('admin', 'staff') then
      raise exception using errcode = '22023', message = 'invalid_portal';
    end if;
    begin
      v_requested_enforced := (v_payload->>'enforced')::boolean;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid_enforced';
    end;
    if v_requested_enforced is null then
      raise exception using errcode = '22023', message = 'invalid_enforced';
    end if;

    if v_requested_enforced then
      -- Both portals rely on the same hosted gateway metadata. Do not allow a
      -- policy to be activated while that trust signal is unavailable: doing
      -- so would make every subsequent preflight fail closed immediately.
      if v_client_ip is null then
        raise exception using errcode = '22023', message = 'client_ip_unavailable';
      end if;

      select (count(*) filter (where entry.portal_scope in ('admin', 'both')))::integer,
             (count(*) filter (where entry.portal_scope in ('staff', 'both')))::integer
      into v_admin_count, v_staff_count
      from public.admin_ip_allowlist_entries entry
      where entry.enabled = true;

      if v_portal = 'admin' then
        if v_admin_count = 0 then
          raise exception using errcode = '22023', message = 'cannot_enable_without_admin_entries';
        end if;
        select entry.id
        into v_admin_match_id
        from public.admin_ip_allowlist_entries entry
        where entry.enabled = true
          and entry.portal_scope in ('admin', 'both')
          and v_client_ip <<= entry.ip_network
        order by masklen(entry.ip_network) desc, entry.id
        limit 1;
        if v_admin_match_id is null then
          raise exception using errcode = '42501', message = 'current_ip_not_allowed';
        end if;
      elsif v_staff_count = 0 then
        raise exception using errcode = '22023', message = 'cannot_enable_without_staff_entries';
      end if;
    end if;

    if v_portal = 'admin' then
      update public.admin_ip_allowlist_settings setting
      set enforced = v_requested_enforced,
          updated_by = p_actor_id,
          updated_at = v_now
      where setting.id = 1;
      v_admin_enforced := v_requested_enforced;

      if v_requested_enforced then
        insert into public.admin_ip_session_attestations as attestation (
          session_id, user_id, ip_address, matched_entry_id,
          source, verified_at, verified_until
        ) values (
          p_session_id, p_actor_id, v_client_ip, v_admin_match_id,
          'management', v_now, v_now + interval '5 minutes'
        )
        on conflict (session_id) do update
        set user_id = excluded.user_id,
            ip_address = excluded.ip_address,
            matched_entry_id = excluded.matched_entry_id,
            source = excluded.source,
            verified_at = excluded.verified_at,
            verified_until = excluded.verified_until;

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
      update public.admin_ip_allowlist_settings setting
      set staff_enforced = v_requested_enforced,
          staff_updated_by = p_actor_id,
          staff_updated_at = v_now
      where setting.id = 1;
      v_staff_enforced := v_requested_enforced;

      -- Existing staff sessions have not proven their current gateway IP.
      -- Revoke them on explicit activation; admin leases are not touched.
      if v_requested_enforced then
        delete from auth.sessions auth_session
        using public.app_session_leases lease
        where lease.portal = 'staff'
          and auth_session.id = lease.session_id
          and auth_session.user_id = lease.user_id;
        delete from public.app_session_leases lease
        where lease.portal = 'staff';
      end if;
      delete from public.staff_ip_session_attestations;
    end if;
  else
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;

  if v_action in ('create', 'update', 'set_enabled', 'delete') then
    select (count(*) filter (where entry.portal_scope in ('admin', 'both')))::integer,
           (count(*) filter (where entry.portal_scope in ('staff', 'both')))::integer
    into v_admin_count, v_staff_count
    from public.admin_ip_allowlist_entries entry
    where entry.enabled = true;

    if v_admin_enforced then
      if v_admin_count = 0 then
        raise exception using errcode = '22023', message = 'last_enabled_admin_entry';
      end if;
      if v_client_ip is null then
        raise exception using errcode = '22023', message = 'client_ip_unavailable';
      end if;
      select entry.id
      into v_admin_match_id
      from public.admin_ip_allowlist_entries entry
      where entry.enabled = true
        and entry.portal_scope in ('admin', 'both')
        and v_client_ip <<= entry.ip_network
      order by masklen(entry.ip_network) desc, entry.id
      limit 1;
      if v_admin_match_id is null then
        raise exception using errcode = '42501', message = 'current_ip_would_be_denied';
      end if;

      insert into public.admin_ip_session_attestations as attestation (
        session_id, user_id, ip_address, matched_entry_id,
        source, verified_at, verified_until
      ) values (
        p_session_id, p_actor_id, v_client_ip, v_admin_match_id,
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

    if v_staff_enforced and v_staff_count = 0 then
      raise exception using errcode = '22023', message = 'last_enabled_staff_entry';
    end if;

    delete from public.admin_ip_session_attestations attestation
    where not exists (
      select 1
      from public.admin_ip_allowlist_entries entry
      where entry.id = attestation.matched_entry_id
        and entry.enabled = true
        and entry.portal_scope in ('admin', 'both')
        and attestation.ip_address <<= entry.ip_network
    );
    delete from public.staff_ip_session_attestations attestation
    where not exists (
      select 1
      from public.admin_ip_allowlist_entries entry
      where entry.id = attestation.matched_entry_id
        and entry.enabled = true
        and entry.portal_scope in ('staff', 'both')
        and attestation.ip_address <<= entry.ip_network
    );
  end if;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, reason
  )
  select
    p_actor_id,
    access.employee_id,
    'access_control',
    'portal_ip_allowlist_' || v_action,
    case
      when v_action = 'set_enforced'
        then coalesce(v_portal, '') || '白名单开关=' || coalesce(v_requested_enforced::text, '')
      else '登录IP白名单条目=' || coalesce(v_id::text, '')
    end
  from public.user_access access
  where access.auth_user_id = p_actor_id
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'action', v_action,
    'id', v_id,
    'portal', v_portal,
    'admin_enforced', v_admin_enforced,
    'staff_enforced', v_staff_enforced
  );
end;
$$;

-- Preserve all release-epoch checks while requiring an Edge-created staff IP
-- attestation before a direct Auth client can claim or renew a staff lease.
create or replace function session_private.app_session_claim(
  p_portal text default 'staff'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '1s'
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_portal text := lower(btrim(coalesce(p_portal, '')));
  v_epoch bigint;
  v_release_id text;
  v_result jsonb;
  v_updated boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('wfh-app-release', 20260827)
  );

  select identity.user_id, identity.session_id
  into v_user_id, v_session_id
  from session_private.current_app_session_identity() identity;

  select state.current_epoch, state.release_id
  into strict v_epoch, v_release_id
  from session_private.app_release_state state
  where state.singleton = true;

  if not session_private.auth_session_matches_current_release(v_user_id, v_session_id) then
    return jsonb_build_object(
      'ok', false, 'reason', 'release_updated', 'release_id', v_release_id
    );
  end if;

  if v_portal = 'staff'
     and session_private.portal_ip_enforcement_effective('staff')
     and not session_private.current_staff_ip_attestation_is_valid(v_user_id, v_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'ip_check_required');
  end if;

  v_result := session_private.app_session_claim_release_inner_v1(v_portal);
  if coalesce(v_result->>'ok', 'false') <> 'true' then return v_result; end if;

  update public.app_session_leases lease
  set release_epoch = v_epoch
  where lease.user_id = v_user_id
    and lease.session_id = v_session_id
  returning true into v_updated;
  if v_updated is not true then raise exception 'release_lease_missing'; end if;

  return v_result || jsonb_build_object(
    'release_epoch', v_epoch, 'release_id', v_release_id
  );
end;
$$;

create or replace function session_private.app_session_heartbeat()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '750ms'
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_epoch bigint;
  v_release_id text;
  v_lease_epoch bigint;
  v_portal text;
begin
  select identity.user_id, identity.session_id
  into v_user_id, v_session_id
  from session_private.current_app_session_identity() identity;

  select state.current_epoch, state.release_id
  into strict v_epoch, v_release_id
  from session_private.app_release_state state
  where state.singleton = true;

  if not session_private.auth_session_matches_current_release(v_user_id, v_session_id) then
    return jsonb_build_object(
      'ok', false, 'reason', 'release_updated', 'release_id', v_release_id
    );
  end if;

  select lease.release_epoch, lease.portal
  into v_lease_epoch, v_portal
  from public.app_session_leases lease
  where lease.user_id = v_user_id
    and lease.session_id = v_session_id;

  if found and v_lease_epoch <> v_epoch then
    return jsonb_build_object(
      'ok', false, 'reason', 'release_updated', 'release_id', v_release_id
    );
  end if;

  if v_portal = 'staff'
     and session_private.portal_ip_enforcement_effective('staff')
     and not session_private.current_staff_ip_attestation_is_valid(v_user_id, v_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'ip_check_required');
  end if;

  return session_private.app_session_heartbeat_release_inner_v1();
end;
$$;

-- Replace in place: RLS policies and protected RPCs depend on this OID.
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
    when (select auth.jwt()->>'session_id') is null then ''
    else (select auth.jwt()->>'session_id')
  end), '');
  v_aal text := lower(btrim(case
    when (select auth.jwt()->>'aal') is null then ''
    else (select auth.jwt()->>'aal')
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
    cross join session_private.app_release_state state
    where state.singleton = true
      and lease.user_id = v_user_id
      and lease.session_id = v_session_id
      and lease.lease_expires_at > clock_timestamp()
      and lease.release_epoch = state.current_epoch
      and auth_session.created_at >= state.activated_at
      and (p_portal is null or lease.portal = lower(btrim(p_portal)))
      and (
        lease.portal <> 'staff'
        or session_private.staff_portal_account_exists(v_user_id)
      )
      and (
        lease.portal <> 'staff'
        or session_private.current_staff_ip_attestation_is_valid(v_user_id, v_session_id)
      )
      and (
        lease.portal <> 'admin'
        or session_private.current_admin_ip_attestation_is_valid(v_user_id, v_session_id)
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

create or replace function session_private.founder_recover_staff_ip_allowlist(
  p_confirmation text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_confirmation <> 'DISABLE STAFF IP ALLOWLIST' then
    raise exception using errcode = '22023', message = 'confirmation_required';
  end if;

  update public.admin_ip_allowlist_settings setting
  set staff_enforced = false,
      staff_updated_at = clock_timestamp(),
      staff_updated_by = null
  where setting.id = 1;
  delete from public.staff_ip_session_attestations;

  return jsonb_build_object(
    'ok', true,
    'staff_enforced', false,
    'reason', 'founder_break_glass_recovery'
  );
end;
$$;

revoke all on function session_private.portal_ip_enforcement_effective(text)
  from public, anon, authenticated, service_role;
revoke all on function session_private.admin_ip_enforcement_effective()
  from public, anon, authenticated, service_role;
revoke all on function session_private.current_admin_ip_attestation_is_valid(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function session_private.current_staff_ip_attestation_is_valid(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function session_private.app_session_claim(text)
  from public, anon, authenticated, service_role;
revoke all on function session_private.app_session_heartbeat()
  from public, anon, authenticated, service_role;
revoke all on function session_private.current_app_session_is_valid(text)
  from public, anon;
grant execute on function session_private.current_app_session_is_valid(text)
  to authenticated, service_role;

revoke all on function public.portal_ip_prelogin_check(text, text)
  from public, anon, authenticated;
revoke all on function public.admin_ip_prelogin_check(text)
  from public, anon, authenticated;
revoke all on function public.staff_ip_session_attest(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.portal_ip_allowlist_mutate(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.portal_ip_prelogin_check(text, text)
  to service_role;
grant execute on function public.admin_ip_prelogin_check(text)
  to service_role;
grant execute on function public.staff_ip_session_attest(uuid, uuid, text, text)
  to service_role;
grant execute on function public.portal_ip_allowlist_mutate(uuid, uuid, text, text, jsonb)
  to service_role;

revoke all on function session_private.founder_recover_staff_ip_allowlist(text)
  from public, anon, authenticated, service_role;

comment on function public.portal_ip_prelogin_check(text, text) is
  'Service-only pre-auth gate for admin/staff; accepts only the Edge-observed gateway IP.';
comment on function public.staff_ip_session_attest(uuid, uuid, text, text) is
  'Binds the hosted gateway-observed IP to one active staff Auth session for five minutes.';
comment on function public.portal_ip_allowlist_mutate(uuid, uuid, text, text, jsonb) is
  'Serialized admin management API for scoped admin/staff/both IP networks and explicit per-portal switches.';
comment on function session_private.founder_recover_staff_ip_allowlist(text) is
  'SQL-owner-only break-glass switch-off for staff IP allowlist lockout.';

notify pgrst, 'reload schema';

commit;
