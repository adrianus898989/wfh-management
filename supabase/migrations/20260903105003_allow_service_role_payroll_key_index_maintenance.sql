begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The payroll identity indexes evaluate these immutable normalizers whenever a
-- service-role writer inserts an employee/lifecycle row or changes a value
-- covered by an index.  Both helpers remained postgres-only after the indexes
-- were added, so otherwise-authorized service writes first fail on
-- payroll_employee_no_key and would then fail on payroll_name_key.
--
-- Grant only the object-level EXECUTE privileges needed by stored index OIDs.
-- service_role intentionally retains no USAGE on internal, so it cannot name
-- or call these helpers directly. Browser roles retain no schema/function
-- access, and the amount parser remains unavailable to service_role.
do $guard$
declare
  v_employee_no_function oid :=
    to_regprocedure('internal.payroll_employee_no_key(text)');
  v_name_function oid := to_regprocedure('internal.payroll_name_key(text)');
  v_invalid integer;
begin
  if v_employee_no_function is null or v_name_function is null then
    raise exception using
      errcode = 'P0001',
      message = 'payroll_identity_key_dependency_missing';
  end if;

  select count(*)
  into v_invalid
  from pg_proc proc
  join pg_namespace namespace on namespace.oid = proc.pronamespace
  where proc.oid in (v_employee_no_function, v_name_function)
    and (
      namespace.nspname is distinct from 'internal'
      or proc.proname not in ('payroll_employee_no_key', 'payroll_name_key')
      or proc.prokind is distinct from 'f'
      or proc.provolatile is distinct from 'i'
      or proc.prosecdef
      or proc.prorettype is distinct from 'text'::regtype
      or pg_get_userbyid(proc.proowner) is distinct from 'postgres'
      or proc.proconfig is distinct from array['search_path=""']::text[]
      or pg_get_function_identity_arguments(proc.oid)
           is distinct from 'p_value text'
    );
  if v_invalid <> 0 then
    raise exception using
      errcode = 'P0001',
      message = 'payroll_identity_key_contract_mismatch',
      detail = format('invalid_functions=%s', v_invalid);
  end if;

  select count(*)
  into v_invalid
  from (
    values
      ('public'::text, 'employees'::text,
       'employees_payroll_employee_no_key_idx'::text,
       v_employee_no_function),
      ('public'::text, 'employee_lifecycle_events'::text,
       'employee_lifecycle_payroll_employee_no_key_idx'::text,
       v_employee_no_function),
      ('public'::text, 'employees'::text,
       'employees_payroll_name_key_idx'::text,
       v_name_function)
  ) expected(schema_name, table_name, index_name, function_oid)
  where not exists (
    select 1
    from pg_namespace index_namespace
    join pg_class index_relation
      on index_relation.relnamespace = index_namespace.oid
     and index_relation.relname = expected.index_name
     and index_relation.relkind = 'i'
    join pg_index index_state
      on index_state.indexrelid = index_relation.oid
     and index_state.indisvalid
     and index_state.indisready
    join pg_class indexed_table
      on indexed_table.oid = index_state.indrelid
     and indexed_table.relname = expected.table_name
    join pg_namespace table_namespace
      on table_namespace.oid = indexed_table.relnamespace
     and table_namespace.nspname = expected.schema_name
    where index_namespace.nspname = expected.schema_name
      and exists (
        select 1
        from pg_depend dependency
        where dependency.classid = 'pg_class'::regclass
          and dependency.objid = index_relation.oid
          and dependency.refclassid = 'pg_proc'::regclass
          and dependency.refobjid = expected.function_oid
      )
  );
  if v_invalid <> 0 then
    raise exception using
      errcode = 'P0001',
      message = 'payroll_identity_key_index_dependency_mismatch',
      detail = format('invalid_indexes=%s', v_invalid);
  end if;
end
$guard$;

revoke usage on schema internal
  from public, anon, authenticated, service_role;

revoke all on function internal.payroll_employee_no_key(text)
  from public, anon, authenticated;
revoke all on function internal.payroll_name_key(text)
  from public, anon, authenticated;
grant execute on function
  internal.payroll_employee_no_key(text),
  internal.payroll_name_key(text)
  to service_role;

-- Keep object access narrow: index maintenance never needs the amount parser.
revoke all on function internal.payroll_number(text) from service_role;

do $verify$
begin
  if has_schema_privilege('service_role', 'internal', 'USAGE')
     or not has_function_privilege(
          'service_role', 'internal.payroll_employee_no_key(text)', 'EXECUTE'
        )
     or not has_function_privilege(
          'service_role', 'internal.payroll_name_key(text)', 'EXECUTE'
        )
     or has_schema_privilege('anon', 'internal', 'USAGE')
     or has_schema_privilege('authenticated', 'internal', 'USAGE')
     or has_function_privilege(
          'anon', 'internal.payroll_employee_no_key(text)', 'EXECUTE'
        )
     or has_function_privilege(
          'authenticated', 'internal.payroll_employee_no_key(text)', 'EXECUTE'
        )
     or has_function_privilege(
          'anon', 'internal.payroll_name_key(text)', 'EXECUTE'
        )
     or has_function_privilege(
          'authenticated', 'internal.payroll_name_key(text)', 'EXECUTE'
        )
     or has_function_privilege(
          'service_role', 'internal.payroll_number(text)', 'EXECUTE'
        )
  then
    raise exception using
      errcode = 'P0001',
      message = 'payroll_identity_key_acl_verification_failed';
  end if;
end
$verify$;

comment on function internal.payroll_employee_no_key(text) is
  'Immutable employee-number normalizer. service_role has object-only EXECUTE for stored expression-index maintenance; internal schema USAGE and browser access remain denied.';

comment on function internal.payroll_name_key(text) is
  'Immutable employee-name normalizer. service_role has object-only EXECUTE for stored expression-index maintenance; internal schema USAGE and browser access remain denied.';

commit;
