-- One application lease per Auth user. Supabase Auth itself permits multiple
-- sessions by default; this registry deliberately keeps the first live browser
-- session and rejects later sessions until logout or lease expiry.

create schema session_private;
revoke all on schema session_private from public, anon, authenticated;

create table public.app_session_leases (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id uuid not null unique,
  portal text not null check (portal in ('admin', 'staff')),
  claimed_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  lease_expires_at timestamptz not null,
  constraint app_session_lease_time_check
    check (lease_expires_at > last_seen_at)
);

comment on table public.app_session_leases is
  'Server-owned first-session-wins leases keyed by Supabase Auth user and JWT session_id.';
comment on column public.app_session_leases.session_id is
  'The required session_id claim from auth.jwt(); never accepted from client input.';
comment on column public.app_session_leases.lease_expires_at is
  'Server timestamp renewed by heartbeat; crashed browsers become reclaimable after five minutes.';

alter table public.app_session_leases enable row level security;
revoke all on table public.app_session_leases from public, anon, authenticated;

create or replace function session_private.current_app_session_identity()
returns table(user_id uuid, session_id uuid)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session_text text := nullif(btrim(coalesce((select auth.jwt()->>'session_id'), '')), '');
begin
  if v_user_id is null or v_session_text is null then
    raise exception using
      errcode = '28000',
      message = 'not_authenticated';
  end if;

  begin
    session_id := v_session_text::uuid;
  exception when invalid_text_representation then
    raise exception using
      errcode = '28000',
      message = 'invalid_session_claim';
  end;

  user_id := v_user_id;
  return next;
end;
$$;

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
  v_portal text := lower(btrim(coalesce(p_portal, '')));
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz := v_now + interval '5 minutes';
  v_existing public.app_session_leases%rowtype;
  v_existing_auth_live boolean := false;
  v_retry_after integer := 1;
begin
  select identity.user_id, identity.session_id
  into v_user_id, v_session_id
  from session_private.current_app_session_identity() identity;

  if v_portal not in ('admin', 'staff') then
    raise exception using
      errcode = '22023',
      message = 'invalid_portal';
  end if;

  -- A signed-out JWT can remain cryptographically valid until exp. Requiring
  -- the matching auth.sessions row prevents such a token reclaiming a lease.
  if not exists (
    select 1
    from auth.sessions auth_session
    where auth_session.id = v_session_id
      and auth_session.user_id = v_user_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'auth_session_missing');
  end if;

  -- Serialize claims per user so two simultaneous first logins cannot both win.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 20260824)
  );

  select lease.*
  into v_existing
  from public.app_session_leases lease
  where lease.user_id = v_user_id
  for update;

  if found and v_existing.session_id <> v_session_id then
    select exists (
      select 1
      from auth.sessions auth_session
      where auth_session.id = v_existing.session_id
        and auth_session.user_id = v_user_id
    ) into v_existing_auth_live;

    if v_existing.lease_expires_at > v_now and v_existing_auth_live then
      v_retry_after := greatest(
        1,
        ceil(extract(epoch from (v_existing.lease_expires_at - v_now)))::integer
      );
      return jsonb_build_object(
        'ok', false,
        'reason', 'active_elsewhere',
        'retry_after_seconds', v_retry_after
      );
    end if;
  end if;

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
      when v_existing.session_id = v_session_id then 'continued'
      else 'claimed'
    end,
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

  update public.app_session_leases lease
  set last_seen_at = v_now,
      lease_expires_at = v_expires_at
  where lease.user_id = v_user_id
    and lease.session_id = v_session_id
  returning true into v_updated;

  if not coalesce(v_updated, false) then
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

create or replace function session_private.app_session_release()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_released boolean := false;
begin
  select identity.user_id, identity.session_id
  into v_user_id, v_session_id
  from session_private.current_app_session_identity() identity;

  delete from public.app_session_leases lease
  where lease.user_id = v_user_id
    and lease.session_id = v_session_id
  returning true into v_released;

  return jsonb_build_object(
    'ok', true,
    'released', coalesce(v_released, false)
  );
end;
$$;

revoke all on function session_private.current_app_session_identity()
  from public, anon, authenticated;
revoke all on function session_private.app_session_claim(text)
  from public, anon, authenticated;
revoke all on function session_private.app_session_heartbeat()
  from public, anon, authenticated;
revoke all on function session_private.app_session_release()
  from public, anon, authenticated;

create or replace function public.app_session_claim(
  p_portal text default 'staff'
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select session_private.app_session_claim(p_portal);
$$;

create or replace function public.app_session_heartbeat()
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select session_private.app_session_heartbeat();
$$;

create or replace function public.app_session_release()
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select session_private.app_session_release();
$$;

revoke all on function public.app_session_claim(text)
  from public, anon, authenticated;
revoke all on function public.app_session_heartbeat()
  from public, anon, authenticated;
revoke all on function public.app_session_release()
  from public, anon, authenticated;

grant execute on function public.app_session_claim(text) to authenticated;
grant execute on function public.app_session_heartbeat() to authenticated;
grant execute on function public.app_session_release() to authenticated;
