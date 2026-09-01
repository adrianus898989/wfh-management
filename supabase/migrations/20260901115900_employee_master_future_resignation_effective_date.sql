begin;

-- A populated resignation date is a scheduled lifecycle change, not proof
-- that the employee has already left.  Keep future-dated rows in the active
-- path and only make the resignation effective on/after the source date.
--
-- The ingest also has a semantic-hash zero-write shortcut.  A date becoming
-- effective does not change the Google snapshot hash, so the shortcut must be
-- bypassed only while the stored employee state disagrees with the dated row.
-- This keeps ordinary identical snapshots zero-write while allowing one
-- reconciliation before the date (including recovery from the old bug) and
-- one reconciliation when the date becomes effective.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $migration$
declare
  v_definition text;
  v_old_same_hash text := $old$
  v_same_hash := v_previous_run_id is not null
    and v_previous_schedule_run_id = v_previous_run_id
    and coalesce(v_previous_snapshot_hash, '') = v_snapshot_hash;
$old$;
  v_new_same_hash text := $new$
  v_same_hash := v_previous_run_id is not null
    and v_previous_schedule_run_id = v_previous_run_id
    and coalesce(v_previous_snapshot_hash, '') = v_snapshot_hash
    and not exists (
      select 1
      from jsonb_array_elements(v_home_rows) item
      left join public.employees employee
        on public.employee_master_normalize_id(employee.employee_no) =
          public.employee_master_normalize_id(item->>'employee_id')
      cross join lateral (
        select nullif(item->>'resign_date', '')::date effective_date
      ) resignation
      where resignation.effective_date is not null
        and (
          (
            resignation.effective_date >
              (v_captured_at at time zone 'Asia/Manila')::date
            and (
              employee.id is null
              or employee.status is distinct from 'active'
              or employee.resign_date is not null
            )
          )
          or (
            resignation.effective_date <=
              (v_captured_at at time zone 'Asia/Manila')::date
            and employee.id is not null
            and (
              employee.status is distinct from 'resigned'
              or employee.resign_date is distinct from
                resignation.effective_date
            )
          )
        )
    );
$new$;
  v_old_effective_flag text := $old$
      nullif(item->>'resign_date', '')::date is not null
        or public.employee_master_has_explicit_resignation_marker(item->>'backend_accounts'),
$old$;
  v_new_effective_flag text := $new$
      case
        when nullif(item->>'resign_date', '')::date is not null then
          nullif(item->>'resign_date', '')::date <=
            (v_captured_at at time zone 'Asia/Manila')::date
        else public.employee_master_has_explicit_resignation_marker(item->>'backend_accounts')
      end,
$new$;
begin
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into v_definition
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'ingest_employee_master_snapshot_validated_v1'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid) =
      'p_payload jsonb';

  if v_definition is null then
    raise exception 'employee_master_validated_ingest_missing';
  end if;

  if pg_catalog.strpos(v_definition, v_new_same_hash) > 0
     and pg_catalog.strpos(v_definition, v_new_effective_flag) > 0 then
    return;
  end if;
  if pg_catalog.strpos(v_definition, v_new_same_hash) > 0
     or pg_catalog.strpos(v_definition, v_new_effective_flag) > 0 then
    raise exception 'employee_master_future_resignation_patch_partial';
  end if;
  if pg_catalog.strpos(v_definition, v_old_same_hash) = 0 then
    raise exception 'employee_master_same_hash_marker_missing';
  end if;
  if pg_catalog.strpos(v_definition, v_old_effective_flag) = 0 then
    raise exception 'employee_master_resignation_flag_marker_missing';
  end if;
  if length(v_definition) - length(pg_catalog.replace(
       v_definition, v_old_same_hash, ''
     )) <> length(v_old_same_hash) then
    raise exception 'employee_master_same_hash_marker_not_unique';
  end if;
  if length(v_definition) - length(pg_catalog.replace(
       v_definition, v_old_effective_flag, ''
     )) <> length(v_old_effective_flag) then
    raise exception 'employee_master_resignation_flag_marker_not_unique';
  end if;

  v_definition := pg_catalog.replace(
    v_definition, v_old_same_hash, v_new_same_hash
  );
  v_definition := pg_catalog.replace(
    v_definition, v_old_effective_flag, v_new_effective_flag
  );
  execute v_definition;
end;
$migration$;

revoke all on function
  public.ingest_employee_master_snapshot_validated_v1(jsonb)
  from public, anon, authenticated, service_role;

comment on function
  public.ingest_employee_master_snapshot_validated_v1(jsonb) is
  'Private atomic dual-source reconciliation. Future resignation dates stay active until effective; same-hash delivery reconciles only lifecycle date/state drift.';

do $verify$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.ingest_employee_master_snapshot_validated_v1(jsonb)'::regprocedure
  );
begin
  if pg_catalog.strpos(
       v_definition,
       'resignation.effective_date >' || pg_catalog.chr(10) ||
         '              (v_captured_at at time zone ''Asia/Manila'')::date'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'resignation.effective_date <=' || pg_catalog.chr(10) ||
         '              (v_captured_at at time zone ''Asia/Manila'')::date'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'employee.status is distinct from ''active'''
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'employee.status is distinct from ''resigned'''
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'then' || pg_catalog.chr(10) ||
         '          nullif(item->>''resign_date'', '''')::date <=' ||
         pg_catalog.chr(10) ||
         '            (v_captured_at at time zone ''Asia/Manila'')::date'
     ) = 0 then
    raise exception 'employee_master_future_resignation_patch_failed';
  end if;
end;
$verify$;

notify pgrst, 'reload schema';

commit;
