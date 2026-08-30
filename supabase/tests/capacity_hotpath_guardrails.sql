begin;

do $test_capacity_hotpath_guardrails$
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
  if pg_catalog.strpos(v_people, 'report_sheet_snapshots') > 0
     or pg_catalog.strpos(v_trainers, 'report_sheet_snapshots') > 0 then
    raise exception 'training search still expands the schedule JSON snapshot';
  end if;
  if pg_catalog.strpos(
       v_people,
       'session_private.online_training_roster_relationships'
     ) = 0
     or pg_catalog.strpos(
       v_trainers,
       'session_private.online_training_roster_relationships'
     ) = 0 then
    raise exception 'training search is not using stable roster relationships';
  end if;
  if pg_catalog.strpos(v_heartbeat, 'interval ''135 seconds''') = 0
     or pg_catalog.strpos(
       v_heartbeat,
       '''heartbeat_interval_seconds'', 120'
     ) = 0
     or pg_catalog.strpos(v_heartbeat, 'current_admin_ip_attestation_is_valid') = 0
     or pg_catalog.strpos(v_heartbeat, 'current_staff_ip_attestation_is_valid') = 0 then
    raise exception 'heartbeat renewal guard is incomplete';
  end if;
  if pg_catalog.has_function_privilege(
       'authenticated',
       'session_private.app_session_heartbeat()',
       'execute'
     ) then
    raise exception 'private heartbeat became directly browser executable';
  end if;
end;
$test_capacity_hotpath_guardrails$;

rollback;
