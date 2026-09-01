begin;

set local lock_timeout = '2s';
set local statement_timeout = '20s';

-- Phase B resolves every home/schedule identity repeatedly. The resolver's
-- expressions already match two partial unique indexes, but PostgreSQL cannot
-- prove either partial-index predicate from the parameterized joins alone.
-- Make the predicates and the employees index expression explicit without
-- changing the resolver's fail-closed candidate semantics or privilege
-- boundary.
do $optimize_confirmed_employee_identity_resolver$
declare
  v_signature regprocedure :=
    'employee_private.resolve_confirmed_employee_id(text)'::regprocedure;
  v_definition text;
  v_patched_definition text;
  v_after_definition text;
  v_employee_join_old text := $employee_join_old$
    join public.employees employee
      on employee_private.employee_identity_key(employee.employee_no) =
        requested.employee_key
    where requested.employee_key is not null
$employee_join_old$;
  v_employee_join_new text := $employee_join_new$
    join public.employees employee
      on regexp_replace(
           upper(btrim(employee.employee_no)), '[^A-Z0-9]', '', 'g'
         ) = requested.employee_key
    where requested.employee_key is not null
      and nullif(
        regexp_replace(
          upper(btrim(employee.employee_no)), '[^A-Z0-9]', '', 'g'
        ),
        ''
      ) is not null
$employee_join_new$;
  v_ledger_join_old text := $ledger_join_old$
    join employee_private.employee_identity_merge_ledger ledger
      on employee_private.employee_identity_key(
           ledger.previous_employee_no
         ) = requested.employee_key
    where requested.employee_key is not null
$ledger_join_old$;
  v_ledger_join_new text := $ledger_join_new$
    join employee_private.employee_identity_merge_ledger ledger
      on employee_private.employee_identity_key(
           ledger.previous_employee_no
         ) = requested.employee_key
    where requested.employee_key is not null
      and employee_private.employee_identity_key(
            ledger.previous_employee_no
          ) <> ''
$ledger_join_new$;
  v_employee_index_expression_expected constant text :=
    'regexp_replace(upper(btrim(employee_no)), ''[^A-Z0-9]''::text, ''''::text, ''g''::text)';
  v_employee_index_predicate_expected constant text :=
    '(NULLIF(regexp_replace(upper(btrim(employee_no)), ''[^A-Z0-9]''::text, ''''::text, ''g''::text), ''''::text) IS NOT NULL)';
  v_ledger_index_expression_expected constant text :=
    'employee_private.employee_identity_key(previous_employee_no)';
  v_ledger_index_predicate_expected constant text :=
    '(employee_private.employee_identity_key(previous_employee_no) <> ''''::text)';
  v_acl_before aclitem[];
  v_owner_before oid;
  v_security_definer_before boolean;
  v_config_before text[];
  v_volatility_before "char";
  v_parallel_before "char";
  v_leakproof_before boolean;
  v_kind_before "char";
  v_return_type_before oid;
  v_comment_before text;
  v_acl_after aclitem[];
  v_owner_after oid;
  v_security_definer_after boolean;
  v_config_after text[];
  v_volatility_after "char";
  v_parallel_after "char";
  v_leakproof_after boolean;
  v_kind_after "char";
  v_return_type_after oid;
  v_comment_after text;
  v_probe_inputs text[];
  v_probe_before jsonb;
  v_probe_after jsonb;
begin
  select procedure.proacl, procedure.proowner, procedure.prosecdef,
    procedure.proconfig, procedure.provolatile, procedure.proparallel,
    procedure.proleakproof, procedure.prokind, procedure.prorettype,
    pg_catalog.obj_description(procedure.oid, 'pg_proc'),
    pg_catalog.pg_get_functiondef(procedure.oid)
  into v_acl_before, v_owner_before, v_security_definer_before,
    v_config_before, v_volatility_before, v_parallel_before,
    v_leakproof_before, v_kind_before, v_return_type_before,
    v_comment_before, v_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature;

  if v_definition is null
     or v_security_definer_before
     or v_volatility_before <> 's'
     or v_kind_before <> 'f'
     or v_return_type_before <> 'uuid'::regtype
     or v_config_before is distinct from array['search_path=""']::text[]
     or pg_catalog.strpos(v_definition, v_employee_join_new) > 0
     or pg_catalog.strpos(v_definition, v_ledger_join_new) > 0
     or (
       pg_catalog.length(v_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_definition, v_employee_join_old, ''
         ))
     ) / pg_catalog.length(v_employee_join_old) <> 1
     or (
       pg_catalog.length(v_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_definition, v_ledger_join_old, ''
         ))
     ) / pg_catalog.length(v_ledger_join_old) <> 1 then
    raise exception
      'confirmed_employee_identity_resolver_performance_marker_changed';
  end if;

  if exists (
       select 1
       from pg_catalog.aclexplode(
         coalesce(
           v_acl_before,
           pg_catalog.acldefault('f', v_owner_before)
         )
       ) privilege
       where privilege.grantee = 0
         and privilege.privilege_type = 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
          'anon', v_signature, 'EXECUTE'
        )
     or pg_catalog.has_function_privilege(
          'authenticated', v_signature, 'EXECUTE'
        )
     or pg_catalog.has_function_privilege(
          'service_role', v_signature, 'EXECUTE'
        ) then
    raise exception
      'confirmed_employee_identity_resolver_preflight_execute_boundary_changed';
  end if;

  if not exists (
       select 1
       from pg_catalog.pg_index index_row
       where index_row.indexrelid =
             'public.employees_employee_no_normalized_unique_idx'::regclass
         and index_row.indrelid = 'public.employees'::regclass
         and index_row.indisvalid
         and index_row.indisready
         and index_row.indisunique
         and pg_catalog.regexp_replace(
               coalesce(pg_catalog.pg_get_expr(
                 index_row.indexprs, index_row.indrelid
               ), ''),
               '[[:space:]]+', '', 'g'
             ) = pg_catalog.regexp_replace(
               v_employee_index_expression_expected,
               '[[:space:]]+', '', 'g'
             )
         and pg_catalog.regexp_replace(
               coalesce(pg_catalog.pg_get_expr(
                 index_row.indpred, index_row.indrelid
               ), ''),
               '[[:space:]]+', '', 'g'
             ) = pg_catalog.regexp_replace(
               v_employee_index_predicate_expected,
               '[[:space:]]+', '', 'g'
             )
     )
     or not exists (
       select 1
       from pg_catalog.pg_index index_row
       where index_row.indexrelid =
             'employee_private.employee_identity_merge_ledger_previous_identity_key_uidx'::regclass
         and index_row.indrelid =
             'employee_private.employee_identity_merge_ledger'::regclass
         and index_row.indisvalid
         and index_row.indisready
         and index_row.indisunique
         and pg_catalog.regexp_replace(
               coalesce(pg_catalog.pg_get_expr(
                 index_row.indexprs, index_row.indrelid
               ), ''),
               '[[:space:]]+', '', 'g'
             ) = pg_catalog.regexp_replace(
               v_ledger_index_expression_expected,
               '[[:space:]]+', '', 'g'
             )
         and pg_catalog.regexp_replace(
               coalesce(pg_catalog.pg_get_expr(
                 index_row.indpred, index_row.indrelid
               ), ''),
               '[[:space:]]+', '', 'g'
             ) = pg_catalog.regexp_replace(
               v_ledger_index_predicate_expected,
               '[[:space:]]+', '', 'g'
             )
     ) then
    raise exception 'confirmed_employee_identity_resolver_index_missing';
  end if;

  select array_agg(sample.employee_no order by sample.employee_no)
  into v_probe_inputs
  from (
    select employee.employee_no
    from public.employees employee
    order by employee.employee_no
    limit 16
  ) sample;

  select jsonb_agg(
    jsonb_build_object(
      'ordinality', probe.ordinality,
      'employee_no', probe.employee_no,
      'employee_id',
        employee_private.resolve_confirmed_employee_id(probe.employee_no)
    )
    order by probe.ordinality
  )
  into v_probe_before
  from unnest(coalesce(v_probe_inputs, array[]::text[]))
    with ordinality probe(employee_no, ordinality);

  v_patched_definition := pg_catalog.replace(
    pg_catalog.replace(
      v_definition, v_employee_join_old, v_employee_join_new
    ),
    v_ledger_join_old, v_ledger_join_new
  );

  if v_patched_definition = v_definition then
    raise exception
      'confirmed_employee_identity_resolver_performance_patch_empty';
  end if;

  execute v_patched_definition;

  select procedure.proacl, procedure.proowner, procedure.prosecdef,
    procedure.proconfig, procedure.provolatile, procedure.proparallel,
    procedure.proleakproof, procedure.prokind, procedure.prorettype,
    pg_catalog.obj_description(procedure.oid, 'pg_proc'),
    pg_catalog.pg_get_functiondef(procedure.oid)
  into v_acl_after, v_owner_after, v_security_definer_after,
    v_config_after, v_volatility_after, v_parallel_after,
    v_leakproof_after, v_kind_after, v_return_type_after,
    v_comment_after, v_after_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature;

  if v_acl_after is distinct from v_acl_before
     or v_owner_after is distinct from v_owner_before
     or v_security_definer_after is distinct from
          v_security_definer_before
     or v_config_after is distinct from v_config_before
     or v_volatility_after is distinct from v_volatility_before
     or v_parallel_after is distinct from v_parallel_before
     or v_leakproof_after is distinct from v_leakproof_before
     or v_kind_after is distinct from v_kind_before
     or v_return_type_after is distinct from v_return_type_before
     or v_comment_after is distinct from v_comment_before then
    raise exception
      'confirmed_employee_identity_resolver_privilege_boundary_changed';
  end if;

  if exists (
       select 1
       from pg_catalog.aclexplode(
         coalesce(
           v_acl_after,
           pg_catalog.acldefault('f', v_owner_after)
         )
       ) privilege
       where privilege.grantee = 0
         and privilege.privilege_type = 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
          'anon', v_signature, 'EXECUTE'
        )
     or pg_catalog.has_function_privilege(
          'authenticated', v_signature, 'EXECUTE'
        )
     or pg_catalog.has_function_privilege(
          'service_role', v_signature, 'EXECUTE'
        ) then
    raise exception
      'confirmed_employee_identity_resolver_postflight_execute_boundary_changed';
  end if;

  if (
       pg_catalog.length(v_after_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_after_definition, v_employee_join_new, ''
         ))
     ) / pg_catalog.length(v_employee_join_new) <> 1
     or (
       pg_catalog.length(v_after_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_after_definition, v_ledger_join_new, ''
         ))
     ) / pg_catalog.length(v_ledger_join_new) <> 1
     or pg_catalog.strpos(v_after_definition, v_employee_join_old) > 0
     or (
       pg_catalog.length(v_after_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_after_definition, v_ledger_join_old, ''
         ))
     ) / pg_catalog.length(v_ledger_join_old) <> 1 then
    raise exception
      'confirmed_employee_identity_resolver_performance_patch_partial';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'ordinality', probe.ordinality,
      'employee_no', probe.employee_no,
      'employee_id',
        employee_private.resolve_confirmed_employee_id(probe.employee_no)
    )
    order by probe.ordinality
  )
  into v_probe_after
  from unnest(coalesce(v_probe_inputs, array[]::text[]))
    with ordinality probe(employee_no, ordinality);

  if v_probe_after is distinct from v_probe_before then
    raise exception
      'confirmed_employee_identity_resolver_probe_semantics_changed';
  end if;
end;
$optimize_confirmed_employee_identity_resolver$;

commit;
