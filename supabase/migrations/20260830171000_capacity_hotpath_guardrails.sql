begin;

-- These are in-place function replacements.  Do not wait behind a busy API
-- statement: the old definitions remain active if this migration cannot take
-- the short catalog locks immediately.
set local lock_timeout = '500ms';
set local statement_timeout = '15s';

do $verify_capacity_hotpath_prerequisites$
declare
  v_people text := pg_catalog.pg_get_functiondef(
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure
  );
  v_trainers text := pg_catalog.pg_get_functiondef(
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  );
  v_heartbeat text := pg_catalog.pg_get_functiondef(
    'session_private.app_session_heartbeat()'::regprocedure
  );
begin
  if pg_catalog.to_regclass(
       'session_private.online_training_roster_relationships'
     ) is null
     or pg_catalog.to_regclass(
       'public.report_employee_directory_cache'
     ) is null then
    raise exception 'stable_online_training_directory_missing';
  end if;

  if pg_catalog.strpos(v_people, 'report_sheet_snapshots') = 0
     or pg_catalog.strpos(v_trainers, 'report_sheet_snapshots') = 0
     or pg_catalog.strpos(
       v_people,
       'with source_rows as materialized ('
     ) = 0
     or pg_catalog.strpos(
       v_trainers,
       'with source_rows as materialized ('
     ) = 0 then
    raise exception 'online_training_directory_hotpath_shape_changed';
  end if;

  if pg_catalog.strpos(
       v_heartbeat,
       'app_session_heartbeat_release_inner_v1'
     ) = 0
     or pg_catalog.strpos(v_heartbeat, 'current_staff_ip_attestation_is_valid') = 0
     or pg_catalog.strpos(v_heartbeat, 'auth_session_matches_current_release') = 0 then
    raise exception 'app_session_heartbeat_guard_shape_changed';
  end if;
end;
$verify_capacity_hotpath_prerequisites$;

-- Both paginated online-training directories were rebuilding their live roster
-- from a JSON snapshot on every request.  The schedule sync already commits an
-- equivalent, ID-backed relationship snapshot and a normalized roster
-- directory atomically.  Replace only the current-roster CTE; report history,
-- filters, pagination, permission gates and response JSON remain unchanged.
do $install_relational_online_training_directories$
declare
  v_signature regprocedure;
  v_anchor text;
  v_definition text;
  v_patched text;
  v_start integer;
  v_anchor_start integer;
  v_old_block text;
  v_replacement constant text := $cte$with allowed_employee_ids as materialized (
    select employee.id employee_id
    from public.employees employee
    where public.online_training_employee_in_scope(employee.id)
  ), roster_people as materialized (
    select
      employee.id employee_id,
      employee.employee_no,
      coalesce(nullif(btrim(directory.full_name), ''), employee.full_name)
        employee_name,
      coalesce(
        nullif(btrim(directory.position_name), ''),
        position.name,
        employee.schedule_position,
        ''
      ) position_name,
      coalesce(nullif(btrim(directory.team_name), ''), team.name, '')
        team_name,
      coalesce(
        nullif(btrim(directory.group_name), ''),
        employee.group_name,
        ''
      ) group_name,
      coalesce(
        nullif(btrim(directory.shift_name), ''),
        employee.shift_name,
        employee.legacy_shift_name,
        ''
      ) shift_name,
      coalesce(
        nullif(btrim(directory.platform_name), ''),
        employee.platform_scope,
        ''
      ) platform,
      coalesce(
        nullif(btrim(directory.online_trainer), ''),
        employee.online_trainer,
        employee.trainer_name,
        ''
      ) trainer_name,
      employee.hire_date,
      employee.resign_date
    from session_private.online_training_roster_relationships relation
    join public.employees employee
      on employee.id = relation.learner_employee_id
    join public.report_employee_directory_cache directory
      on directory.source_kind = 'roster'
     and public.employee_master_normalize_id(directory.employee_no) =
       relation.learner_employee_no
    join allowed_employee_ids allowed
      on allowed.employee_id = employee.id
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    where employee.status in ('active', 'probation')
      and nullif(
        public.online_training_identity_key(directory.online_trainer),
        ''
      ) is not null
      and (employee.hire_date is null or employee.hire_date <= v_effective_to)
      and (employee.resign_date is null or employee.resign_date >= v_effective_from)
  ), $cte$;
begin
  foreach v_signature in array array[
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  ] loop
    v_anchor := case
      when v_signature =
        'public.online_training_search_people(jsonb,integer,integer)'::regprocedure
        then 'visible_member_rows as materialized ('
      else 'visible_reports as materialized ('
    end;

    select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
    v_start := pg_catalog.strpos(
      v_definition,
      'with source_rows as materialized ('
    );
    v_anchor_start := pg_catalog.strpos(v_definition, v_anchor);

    if v_start = 0 or v_anchor_start <= v_start then
      raise exception 'online_training_directory_patch_anchor_changed: %',
        v_signature;
    end if;

    v_old_block := pg_catalog.substring(
      v_definition,
      v_start,
      v_anchor_start - v_start
    );
    if pg_catalog.strpos(v_old_block, 'report_sheet_snapshots') = 0
       or pg_catalog.strpos(v_old_block, 'roster_people as materialized') = 0
       or pg_catalog.strpos(v_old_block, 'visible_') > 0 then
      raise exception 'online_training_directory_patch_boundary_changed: %',
        v_signature;
    end if;

    v_patched := pg_catalog.substring(v_definition, 1, v_start - 1)
      || v_replacement
      || pg_catalog.substring(v_definition, v_anchor_start);
    execute v_patched;

    if pg_catalog.strpos(
         pg_catalog.pg_get_functiondef(v_signature),
         'report_sheet_snapshots'
       ) > 0
       or pg_catalog.strpos(
         pg_catalog.pg_get_functiondef(v_signature),
         'session_private.online_training_roster_relationships'
       ) = 0 then
      raise exception 'online_training_relational_directory_install_failed: %',
        v_signature;
    end if;
  end loop;
end;
$install_relational_online_training_directories$;

-- The browser heartbeat is already two minutes and same-origin tabs are
-- coalesced.  A five-minute lease therefore needs a database write only inside
-- its final 135 seconds.  The skipped two-minute check still validates Auth,
-- release epoch, staff-account existence and both portal IP attestations.  A
-- renewal failure is retried by the existing browser verification backoff while
-- at least one minute remains on the lease.
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
  v_lease_expires_at timestamptz;
  v_result jsonb;
begin
  select identity.user_id, identity.session_id
  into v_user_id, v_session_id
  from session_private.current_app_session_identity() identity;

  select state.current_epoch, state.release_id
  into strict v_epoch, v_release_id
  from session_private.app_release_state state
  where state.singleton = true;

  if not session_private.auth_session_matches_current_release(
    v_user_id,
    v_session_id
  ) then
    return jsonb_build_object(
      'ok', false, 'reason', 'release_updated', 'release_id', v_release_id
    );
  end if;

  select lease.release_epoch, lease.portal, lease.lease_expires_at
  into v_lease_epoch, v_portal, v_lease_expires_at
  from public.app_session_leases lease
  where lease.user_id = v_user_id
    and lease.session_id = v_session_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;
  if v_lease_epoch <> v_epoch then
    return jsonb_build_object(
      'ok', false, 'reason', 'release_updated', 'release_id', v_release_id
    );
  end if;

  -- Preserve the inner function's immediate account deletion/revocation path.
  if v_portal = 'staff'
     and not session_private.staff_portal_account_exists(v_user_id) then
    v_result := session_private.app_session_heartbeat_release_inner_v1();
    return v_result || jsonb_build_object(
      'heartbeat_interval_seconds', 120,
      'lease_refreshed', false
    );
  end if;

  if v_portal = 'staff'
     and session_private.portal_ip_enforcement_effective('staff')
     and not session_private.current_staff_ip_attestation_is_valid(
       v_user_id,
       v_session_id
     ) then
    return jsonb_build_object('ok', false, 'reason', 'ip_check_required');
  end if;
  if v_portal = 'admin'
     and session_private.admin_ip_enforcement_effective()
     and not session_private.current_admin_ip_attestation_is_valid(
       v_user_id,
       v_session_id
     ) then
    return jsonb_build_object('ok', false, 'reason', 'ip_check_required');
  end if;

  if v_lease_expires_at > clock_timestamp() + interval '135 seconds' then
    return jsonb_build_object(
      'ok', true,
      'reason', 'lease_still_fresh',
      'lease_expires_at', v_lease_expires_at,
      'heartbeat_interval_seconds', 120,
      'lease_refreshed', false
    );
  end if;

  v_result := session_private.app_session_heartbeat_release_inner_v1();
  return v_result || jsonb_build_object(
    'heartbeat_interval_seconds', 120,
    'lease_refreshed', coalesce(v_result->>'reason', '') = 'renewed'
  );
end;
$$;

revoke all on function session_private.app_session_heartbeat()
  from public, anon, authenticated, service_role;

comment on function session_private.app_session_heartbeat() is
  'Release/IP/account guarded two-minute heartbeat; validates every call and writes the five-minute lease only inside its final 135 seconds.';

notify pgrst, 'reload schema';
commit;
