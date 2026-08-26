-- Treat the employee ID as the cross-source identity key. The current-staff
-- source remains authoritative for the official name; schedule display-name
-- differences are preserved as reconciliation issues while live assignment
-- fields continue to sync.

do $migration$
declare
  v_definition text;
  v_strict_name_guard text := $guard$
    if exists (
      select 1
      from pg_temp.employee_master_home_stage home
      join pg_temp.employee_master_schedule_stage schedule
        on schedule.employee_no = home.employee_no
      where home.employee_no is not null
        and home.name_key <> schedule.name_key
    ) then
      raise exception using errcode = '22023', message = 'cross_source_name_mismatch';
    end if;
$guard$;
  v_strict_schedule_match text :=
    '(home.employee_no is not null and home.name_key = schedule.name_key)';
  v_id_schedule_match text := '(home.employee_no is not null)';
  v_schedule_projection text := $projection$
    select schedule.*,
      (home.employee_no is not null) home_active
$projection$;
  v_canonical_projection text := $projection$
    select schedule.*,
      (home.employee_no is not null) home_active,
      coalesce(home.full_name, schedule.full_name) canonical_name
$projection$;
  v_directory_name text := $$'name', schedule.full_name,$$;
  v_canonical_directory_name text := $$'name', schedule.canonical_name,$$;
begin
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into v_definition
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'ingest_employee_master_snapshot'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = 'p_payload jsonb';

  if v_definition is null then
    raise exception 'employee_master_ingest_function_missing';
  end if;
  if pg_catalog.strpos(v_definition, v_strict_name_guard) = 0 then
    raise exception 'employee_master_name_guard_marker_missing';
  end if;
  if pg_catalog.strpos(v_definition, v_strict_schedule_match) = 0 then
    raise exception 'employee_master_schedule_match_marker_missing';
  end if;
  if pg_catalog.strpos(v_definition, v_schedule_projection) = 0 then
    raise exception 'employee_master_schedule_projection_marker_missing';
  end if;
  if pg_catalog.strpos(v_definition, v_directory_name) = 0 then
    raise exception 'employee_master_directory_name_marker_missing';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_strict_name_guard, E'\n');
  v_definition := pg_catalog.replace(
    v_definition,
    v_strict_schedule_match,
    v_id_schedule_match
  );
  v_definition := pg_catalog.replace(
    v_definition,
    v_schedule_projection,
    v_canonical_projection
  );
  v_definition := pg_catalog.replace(
    v_definition,
    v_directory_name,
    v_canonical_directory_name
  );
  execute v_definition;
end;
$migration$;

revoke all on function public.ingest_employee_master_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_employee_master_snapshot(jsonb)
  to service_role;

comment on function public.ingest_employee_master_snapshot(jsonb) is
  'Service-only atomic dual-source employee master reconciliation. Employee ID joins sources; current-staff owns the official name; name drift is recorded for review.';

notify pgrst, 'reload schema';
