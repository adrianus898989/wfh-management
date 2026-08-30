begin;

do $test_attendance_history_identity_cache$
declare
  v_view_definition text := pg_catalog.pg_get_viewdef(
    'attendance_private.attendance_enriched_records'::regclass,
    true
  );
  v_helper_definition text := pg_catalog.pg_get_functiondef(
    'attendance_private.enrich_attendance_record_ids(uuid[])'::regprocedure
  );
  v_trigger_count integer;
begin
  if pg_catalog.strpos(
       v_view_definition,
       'attendance_private.historical_employee_directory_cache'
     ) = 0
     or pg_catalog.strpos(
       v_view_definition,
       'attendance_private.historical_employee_aliases_cache'
     ) = 0
     or pg_catalog.strpos(
       v_helper_definition,
       'attendance_private.historical_employee_directory_cache'
     ) = 0
     or pg_catalog.strpos(
       v_helper_definition,
       'attendance_private.historical_employee_aliases_cache'
     ) = 0 then
    raise exception 'attendance readers are not using the history caches';
  end if;

  if exists (
       select * from attendance_private.historical_employee_directory
       except
       select * from attendance_private.historical_employee_directory_cache
     )
     or exists (
       select * from attendance_private.historical_employee_directory_cache
       except
       select * from attendance_private.historical_employee_directory
     )
     or exists (
       select * from attendance_private.historical_employee_aliases
       except
       select * from attendance_private.historical_employee_aliases_cache
     )
     or exists (
       select * from attendance_private.historical_employee_aliases_cache
       except
       select * from attendance_private.historical_employee_aliases
     ) then
    raise exception 'attendance history cache differs from the canonical source';
  end if;

  select count(*)
  into v_trigger_count
  from pg_catalog.pg_trigger trigger_record
  where trigger_record.tgrelid =
      'public.employee_lifecycle_events'::regclass
    and not trigger_record.tgisinternal
    and trigger_record.tgenabled = 'O'
    and trigger_record.tgname in (
      'trg_attendance_history_cache_after_insert',
      'trg_attendance_history_cache_after_delete',
      'trg_attendance_history_cache_after_update'
    );
  if v_trigger_count <> 3 then
    raise exception 'attendance lifecycle cache triggers are incomplete';
  end if;

  if pg_catalog.has_table_privilege(
       'authenticated',
       'attendance_private.historical_employee_directory_cache',
       'select'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'attendance_private.historical_employee_aliases_cache',
       'select'
     ) then
    raise exception 'attendance history cache is directly exposed';
  end if;

  if not exists (
    select 1
    from information_schema.routines routine
    where routine.routine_schema = 'public'
      and routine.routine_name = 'admin_attendance_records_page'
  ) or not exists (
    select 1
    from information_schema.routines routine
    where routine.routine_schema = 'public'
      and routine.routine_name = 'admin_attendance_monthly_page'
  ) then
    raise exception 'public attendance page contract is missing';
  end if;
end;
$test_attendance_history_identity_cache$;

rollback;
