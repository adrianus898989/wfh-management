-- The canonical employee table also owns a source_row column.  The two
-- canonicalization queries below already alias JSON ordinality as `source`,
-- so leaving the ORDER BY unqualified becomes ambiguous as soon as the
-- canonical employee is joined.  Patch only the two expected functions and
-- fail closed if their deployed shape is no longer the one reviewed here.
do $fix_confirmed_identity_source_row_ambiguity$
declare
  v_signature regprocedure;
  v_definition text;
  v_patched_definition text;
  v_old_count integer;
  v_owner oid;
  v_acl aclitem[];
  v_security_definer boolean;
  v_config text[];
begin
  foreach v_signature in array array[
    'public.refresh_schedule_report_snapshot_after_master_sync()'::regprocedure,
    'public.ingest_schedule_roster_snapshot(jsonb)'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(procedure.oid),
      procedure.proowner, procedure.proacl, procedure.prosecdef,
      procedure.proconfig
    into v_definition, v_owner, v_acl, v_security_definer, v_config
    from pg_catalog.pg_proc procedure
    where procedure.oid = v_signature::oid;

    if v_definition is null then
      raise exception 'confirmed_identity_source_row_function_missing:%',
        v_signature::text;
    end if;

    if pg_catalog.strpos(
         v_definition,
         'order by source.source_row'
       ) > 0 then
      if pg_catalog.strpos(v_definition, 'order by source_row') > 0 then
        raise exception
          'confirmed_identity_source_row_patch_partial:%',
          v_signature::text;
      end if;
      continue;
    end if;

    v_old_count := (
      pg_catalog.length(v_definition) -
      pg_catalog.length(pg_catalog.replace(
        v_definition, 'order by source_row', ''
      ))
    ) / pg_catalog.length('order by source_row');

    if v_old_count <> 1
       or pg_catalog.strpos(
            v_definition,
            'with ordinality source(item, source_row)'
          ) = 0
       or pg_catalog.strpos(
            v_definition,
            'employee_identity_merge_ledger ledger'
          ) = 0
       or pg_catalog.strpos(
            v_definition,
            'public.employees canonical'
          ) = 0 then
      raise exception 'confirmed_identity_source_row_shape_changed:%:%',
        v_signature::text, v_old_count;
    end if;

    v_patched_definition := pg_catalog.replace(
      v_definition,
      'order by source_row',
      'order by source.source_row'
    );
    execute v_patched_definition;

    if exists (
      select 1
      from pg_catalog.pg_proc procedure
      where procedure.oid = v_signature::oid
        and (
          procedure.proowner is distinct from v_owner
          or procedure.proacl is distinct from v_acl
          or procedure.prosecdef is distinct from v_security_definer
          or procedure.proconfig is distinct from v_config
          or pg_catalog.strpos(
               pg_catalog.pg_get_functiondef(procedure.oid),
               'order by source.source_row'
             ) = 0
          or pg_catalog.strpos(
               pg_catalog.pg_get_functiondef(procedure.oid),
               'order by source_row'
             ) > 0
        )
    ) then
      raise exception 'confirmed_identity_source_row_patch_invalid:%',
        v_signature::text;
    end if;
  end loop;
end;
$fix_confirmed_identity_source_row_ambiguity$;
