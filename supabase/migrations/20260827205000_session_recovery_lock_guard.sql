begin;

-- Normal claims only need to exclude a release advance. Shared claim locks
-- remain compatible with one another while the exclusive lock held by
-- app_release_advance still waits for every in-flight claim to finish.
create or replace function session_private.app_session_claim(
  p_portal text default 'staff'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
set lock_timeout='1s'
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_epoch bigint;
  v_release_id text;
  v_result jsonb;
  v_updated boolean:=false;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(
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

-- Heartbeats and IP attestations are retryable infrastructure checks. A hot
-- row must fail quickly instead of occupying a database connection until the
-- project-wide statement timeout. React keeps the verified session on these
-- transient 5xx responses and retries with exponential backoff.
alter function session_private.app_session_claim_release_inner_v1(text)
  set lock_timeout='1s';
alter function session_private.app_session_heartbeat()
  set lock_timeout='750ms';
alter function session_private.app_session_heartbeat_release_inner_v1()
  set lock_timeout='750ms';
alter function public.admin_ip_session_attest(uuid,uuid,text,text)
  set lock_timeout='750ms';

revoke all on function session_private.app_session_claim(text)
  from public,anon,authenticated,service_role;

commit;
