begin;

-- Every successful application release advances one server-owned generation.
-- Auth JWTs are stateless and can remain cryptographically valid after a
-- browser signs out, therefore both the Auth session creation time and the
-- application lease generation are checked inside the database.
create table if not exists session_private.app_release_state (
  singleton boolean primary key default true check (singleton),
  current_epoch bigint not null check (current_epoch > 0),
  release_id text not null check (btrim(release_id) <> '' and length(release_id) <= 200),
  activated_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);

revoke all on table session_private.app_release_state
  from public,anon,authenticated,service_role;

alter table public.app_session_leases
  add column if not exists release_epoch bigint not null default 0;

-- This block deliberately runs the bootstrap invalidation only when it creates
-- the singleton. Re-running the migration text therefore does not log every
-- user out again, while PostgreSQL's surrounding transaction still makes a
-- failed first application fully atomic.
do $release_epoch_bootstrap$
begin
  insert into session_private.app_release_state(
    singleton,current_epoch,release_id,activated_at,updated_at
  ) values (
    true,1,'release-epoch-bootstrap-20260827151000',clock_timestamp(),clock_timestamp()
  ) on conflict(singleton) do nothing;

  if found then
    delete from public.app_session_leases;
  end if;
end
$release_epoch_bootstrap$;

comment on table session_private.app_release_state is
  'Single server-owned application release generation. Advancing it invalidates every older Auth session and app lease.';
comment on column public.app_session_leases.release_epoch is
  'Release generation captured when the browser lease is claimed; it must equal app_release_state.current_epoch.';

create or replace function session_private.current_app_release_epoch()
returns bigint
language sql
stable
security definer
set search_path=''
as $$
  select state.current_epoch
  from session_private.app_release_state state
  where state.singleton=true;
$$;

create or replace function session_private.auth_session_matches_current_release(
  p_user_id uuid,
  p_session_id uuid
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1
    from auth.sessions auth_session
    cross join session_private.app_release_state state
    where state.singleton=true
      and auth_session.id=p_session_id
      and auth_session.user_id=p_user_id
      and auth_session.created_at>=state.activated_at
  );
$$;

revoke all on function session_private.current_app_release_epoch()
  from public,anon,authenticated,service_role;
revoke all on function session_private.auth_session_matches_current_release(uuid,uuid)
  from public,anon,authenticated,service_role;

-- Refuse to wrap a different session implementation silently. The current
-- implementation includes staff-status, MFA and admin-IP enforcement and all
-- of those checks must remain inside the retained delegates.
do $release_epoch_prerequisites$
declare
  v_definition text;
  v_claim regprocedure;
  v_heartbeat regprocedure;
  v_bootstrap regprocedure;
begin
  v_claim:=coalesce(
    to_regprocedure('session_private.app_session_claim_release_inner_v1(text)'),
    to_regprocedure('session_private.app_session_claim(text)')
  );
  select pg_get_functiondef(
    v_claim
  ) into v_definition;
  if strpos(v_definition,'current_app_session_identity')=0
     or strpos(v_definition,'staff_portal_account_exists')=0
     or strpos(v_definition,'current_admin_ip_attestation_is_valid')=0
     or strpos(v_definition,'auth.sessions')=0 then
    raise exception 'app_session_claim_release_prerequisite_changed';
  end if;

  v_heartbeat:=coalesce(
    to_regprocedure('session_private.app_session_heartbeat_release_inner_v1()'),
    to_regprocedure('session_private.app_session_heartbeat()')
  );
  select pg_get_functiondef(
    v_heartbeat
  ) into v_definition;
  if strpos(v_definition,'current_app_session_identity')=0
     or strpos(v_definition,'staff_portal_account_exists')=0
     or strpos(v_definition,'current_admin_ip_attestation_is_valid')=0
     or strpos(v_definition,'auth.sessions')=0 then
    raise exception 'app_session_heartbeat_release_prerequisite_changed';
  end if;

  v_bootstrap:=coalesce(
    to_regprocedure('session_private.app_session_bootstrap_access_release_inner_v1()'),
    to_regprocedure('session_private.app_session_bootstrap_access()')
  );
  select pg_get_functiondef(
    v_bootstrap
  ) into v_definition;
  if strpos(v_definition,'current_app_session_identity')=0
     or strpos(v_definition,'staff_portal_account_exists')=0
     or strpos(v_definition,'auth.sessions')=0 then
    raise exception 'app_session_bootstrap_release_prerequisite_changed';
  end if;

  select pg_get_functiondef(
    'session_private.current_app_session_is_valid(text)'::regprocedure
  ) into v_definition;
  if strpos(v_definition,'app_session_leases')=0
     or strpos(v_definition,'staff_portal_account_exists')=0
     or strpos(v_definition,'current_admin_ip_attestation_is_valid')=0
     or strpos(v_definition,'auth.sessions')=0 then
    raise exception 'current_app_session_release_prerequisite_changed';
  end if;
end
$release_epoch_prerequisites$;

do $release_epoch_retain_delegates$
begin
  if to_regprocedure('session_private.app_session_claim_release_inner_v1(text)') is null then
    alter function session_private.app_session_claim(text)
      rename to app_session_claim_release_inner_v1;
  end if;
  if to_regprocedure('session_private.app_session_heartbeat_release_inner_v1()') is null then
    alter function session_private.app_session_heartbeat()
      rename to app_session_heartbeat_release_inner_v1;
  end if;
  if to_regprocedure('session_private.app_session_bootstrap_access_release_inner_v1()') is null then
    alter function session_private.app_session_bootstrap_access()
      rename to app_session_bootstrap_access_release_inner_v1;
  end if;
end
$release_epoch_retain_delegates$;

revoke all on function session_private.app_session_claim_release_inner_v1(text)
  from public,anon,authenticated,service_role;
revoke all on function session_private.app_session_heartbeat_release_inner_v1()
  from public,anon,authenticated,service_role;
revoke all on function session_private.app_session_bootstrap_access_release_inner_v1()
  from public,anon,authenticated,service_role;

create or replace function session_private.app_session_claim(
  p_portal text default 'staff'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_epoch bigint;
  v_release_id text;
  v_result jsonb;
  v_updated boolean:=false;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wfh-app-release',20260827)
  );

  select identity.user_id,identity.session_id
  into v_user_id,v_session_id
  from session_private.current_app_session_identity() identity;

  select state.current_epoch,state.release_id
  into strict v_epoch,v_release_id
  from session_private.app_release_state state
  where state.singleton=true;

  if not session_private.auth_session_matches_current_release(v_user_id,v_session_id) then
    return jsonb_build_object(
      'ok',false,'reason','release_updated','release_id',v_release_id
    );
  end if;

  v_result:=session_private.app_session_claim_release_inner_v1(p_portal);
  if coalesce(v_result->>'ok','false')<>'true' then return v_result; end if;

  update public.app_session_leases lease
  set release_epoch=v_epoch
  where lease.user_id=v_user_id
    and lease.session_id=v_session_id
  returning true into v_updated;
  if v_updated is not true then raise exception 'release_lease_missing'; end if;

  return v_result||jsonb_build_object(
    'release_epoch',v_epoch,'release_id',v_release_id
  );
end;
$$;

create or replace function session_private.app_session_heartbeat()
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_epoch bigint;
  v_release_id text;
  v_lease_epoch bigint;
begin
  select identity.user_id,identity.session_id
  into v_user_id,v_session_id
  from session_private.current_app_session_identity() identity;

  select state.current_epoch,state.release_id
  into strict v_epoch,v_release_id
  from session_private.app_release_state state
  where state.singleton=true;

  if not session_private.auth_session_matches_current_release(v_user_id,v_session_id) then
    return jsonb_build_object(
      'ok',false,'reason','release_updated','release_id',v_release_id
    );
  end if;

  select lease.release_epoch into v_lease_epoch
  from public.app_session_leases lease
  where lease.user_id=v_user_id
    and lease.session_id=v_session_id;

  if found and v_lease_epoch<>v_epoch then
    return jsonb_build_object(
      'ok',false,'reason','release_updated','release_id',v_release_id
    );
  end if;

  return session_private.app_session_heartbeat_release_inner_v1();
end;
$$;

create or replace function session_private.app_session_bootstrap_access()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_release_id text;
  v_result jsonb;
begin
  select identity.user_id,identity.session_id
  into v_user_id,v_session_id
  from session_private.current_app_session_identity() identity;

  select state.release_id into strict v_release_id
  from session_private.app_release_state state
  where state.singleton=true;

  if not session_private.auth_session_matches_current_release(v_user_id,v_session_id) then
    return jsonb_build_object(
      'ok',false,'reason','release_updated','release_id',v_release_id
    );
  end if;

  v_result:=session_private.app_session_bootstrap_access_release_inner_v1();
  return v_result||jsonb_build_object('release_id',v_release_id);
end;
$$;

-- Replace this function in-place instead of renaming it. It is referenced by
-- stored RLS policy expressions and many protected RPCs; preserving its OID
-- guarantees that every existing dependency receives the release check.
create or replace function session_private.current_app_session_is_valid(
  p_portal text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid:=(select auth.uid());
  v_session_text text:=nullif(btrim(case
    when (select auth.jwt()->>'session_id') is null then ''
    else (select auth.jwt()->>'session_id')
  end),'');
  v_aal text:=lower(btrim(case
    when (select auth.jwt()->>'aal') is null then ''
    else (select auth.jwt()->>'aal')
  end));
  v_session_id uuid;
begin
  if v_user_id is null or v_session_text is null then return false; end if;
  begin
    v_session_id:=v_session_text::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  return exists(
    select 1
    from public.app_session_leases lease
    join auth.sessions auth_session
      on auth_session.id=lease.session_id
     and auth_session.user_id=lease.user_id
    cross join session_private.app_release_state state
    where state.singleton=true
      and lease.user_id=v_user_id
      and lease.session_id=v_session_id
      and lease.lease_expires_at>clock_timestamp()
      and lease.release_epoch=state.current_epoch
      and auth_session.created_at>=state.activated_at
      and (p_portal is null or lease.portal=lower(btrim(p_portal)))
      and (
        lease.portal<>'staff'
        or session_private.staff_portal_account_exists(v_user_id)
      )
      and (
        lease.portal<>'admin'
        or session_private.current_admin_ip_attestation_is_valid(v_user_id,v_session_id)
      )
      and (
        lease.portal<>'admin'
        or not exists(
          select 1 from public.user_access access
          where access.auth_user_id=v_user_id
            and access.active=true
            and access.backend_enabled=true
            and access.otp_required=true
        )
        or v_aal='aal2'
      )
  );
end;
$$;

-- Recreate the public dispatchers after renaming the retained private
-- functions, so dependency rewriting can never leave a public bypass to an
-- unguarded pre-release delegate.
create or replace function public.app_session_claim(
  p_portal text default 'staff'
)
returns jsonb
language sql
volatile
security definer
set search_path=''
as $$
  select session_private.app_session_claim(p_portal);
$$;

create or replace function public.app_session_heartbeat()
returns jsonb
language sql
volatile
security definer
set search_path=''
as $$
  select session_private.app_session_heartbeat();
$$;

create or replace function public.app_session_bootstrap_access()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select session_private.app_session_bootstrap_access();
$$;

-- Idempotent deployment hook. Only the service role used by the protected
-- GitHub deployment job may advance the release. Deleting every lease makes
-- service-role Edge checks fail immediately; the Auth-session timestamp check
-- prevents the same old JWT from claiming the new generation again.
create or replace function public.app_release_advance(p_release_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
set lock_timeout='5s'
as $$
declare
  v_release_id text:=left(btrim(coalesce(p_release_id,'')),200);
  v_state session_private.app_release_state%rowtype;
  v_revoked_leases integer:=0;
begin
  if v_release_id='' then raise exception 'release_id_required'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wfh-app-release',20260827)
  );

  select state.* into strict v_state
  from session_private.app_release_state state
  where state.singleton=true
  for update;

  if v_state.release_id=v_release_id then
    return jsonb_build_object(
      'ok',true,
      'advanced',false,
      'release_id',v_state.release_id,
      'release_epoch',v_state.current_epoch,
      'activated_at',v_state.activated_at,
      'revoked_leases',0
    );
  end if;

  update session_private.app_release_state state
  set current_epoch=state.current_epoch+1,
      release_id=v_release_id,
      activated_at=clock_timestamp(),
      updated_at=clock_timestamp()
  where state.singleton=true
  returning state.* into strict v_state;

  delete from public.app_session_leases;
  get diagnostics v_revoked_leases=row_count;

  return jsonb_build_object(
    'ok',true,
    'advanced',true,
    'release_id',v_state.release_id,
    'release_epoch',v_state.current_epoch,
    'activated_at',v_state.activated_at,
    'revoked_leases',v_revoked_leases
  );
end;
$$;

revoke all on function session_private.app_session_claim(text)
  from public,anon,authenticated,service_role;
revoke all on function session_private.app_session_heartbeat()
  from public,anon,authenticated,service_role;
revoke all on function session_private.app_session_bootstrap_access()
  from public,anon,authenticated,service_role;
revoke all on function session_private.current_app_session_is_valid(text)
  from public,anon;

revoke all on function public.app_session_claim(text)
  from public,anon,authenticated;
revoke all on function public.app_session_heartbeat()
  from public,anon,authenticated;
revoke all on function public.app_session_bootstrap_access()
  from public,anon,authenticated;
revoke all on function public.app_release_advance(text)
  from public,anon,authenticated,service_role;

grant execute on function session_private.current_app_session_is_valid(text)
  to authenticated,service_role;
grant execute on function public.app_session_claim(text)
  to authenticated,service_role;
grant execute on function public.app_session_heartbeat()
  to authenticated,service_role;
grant execute on function public.app_session_bootstrap_access()
  to authenticated,service_role;
grant execute on function public.app_release_advance(text)
  to service_role;

comment on function public.app_release_advance(text) is
  'Service-role-only idempotent deployment hook. Advances the application release generation and invalidates every browser lease.';

notify pgrst,'reload schema';

commit;
