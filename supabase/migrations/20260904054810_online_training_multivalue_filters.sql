begin;

set local lock_timeout = '2s';
set local statement_timeout = '20s';

do $prerequisite_guard$
begin
  if to_regnamespace('session_private') is null
     or to_regprocedure(
       'public.online_training_search_people(jsonb,integer,integer)'
     ) is null
     or to_regprocedure(
       'public.online_training_search_trainers(jsonb,integer,integer)'
     ) is null
     or to_regprocedure(
       'public.online_training_search_reports(jsonb,integer,integer)'
     ) is null then
    raise exception 'online_training_multivalue_filter_prerequisite_missing';
  end if;
end
$prerequisite_guard$;

-- Multi-select values travel inside the existing JSON string fields, separated
-- by ASCII Unit Separator (U+001F). Unlike commas, slashes or display glyphs,
-- this delimiter cannot collide with normal team/position labels. A legacy
-- scalar is therefore exactly the one-element form of the same protocol.
create or replace function session_private.online_training_filter_values(
  p_encoded text
)
returns text[]
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_encoded text := coalesce(p_encoded, '');
  v_parts text[];
  v_values text[];
begin
  if v_encoded = '' then
    return '{}'::text[];
  end if;
  if pg_catalog.octet_length(v_encoded) > 262144 then
    raise exception using
      errcode = '22023',
      message = 'online_training_filter_encoding_too_large';
  end if;

  v_parts := pg_catalog.string_to_array(v_encoded, pg_catalog.chr(31));
  if pg_catalog.cardinality(v_parts) > 100
     or exists (
       select 1
       from pg_catalog.unnest(v_parts) part(value)
       where pg_catalog.btrim(part.value) = ''
          or pg_catalog.char_length(pg_catalog.btrim(part.value)) > 512
     ) then
    raise exception using
      errcode = '22023',
      message = 'online_training_filter_encoding_invalid';
  end if;

  select coalesce(
    pg_catalog.array_agg(normalized.value order by normalized.value),
    '{}'::text[]
  )
  into v_values
  from (
    select distinct pg_catalog.lower(pg_catalog.btrim(part.value)) value
    from pg_catalog.unnest(v_parts) part(value)
  ) normalized;

  return v_values;
end;
$$;

comment on function session_private.online_training_filter_values(text) is
  'Decodes bounded U+001F-separated online-training filter values; a scalar remains one value.';
revoke all on function session_private.online_training_filter_values(text)
  from public, anon, authenticated, service_role;

-- Keep each deployed RPC body and signature intact. Only the five reviewed
-- exact-match filters become normalized arrays. Exact occurrence counts make
-- this migration abort before CREATE OR REPLACE if a deployed body has drifted.
do $patch_multivalue_filters$
declare
  v_signature regprocedure;
  v_definition text;
  v_patched text;
  v_filter_name text;
  v_old_declaration text;
  v_new_declaration text;
  v_old_empty text;
  v_new_empty text;
  v_old_match text;
  v_new_match text;
  v_hits integer;
  v_expected_empty integer;
  v_expected_match integer;
  v_acl_before aclitem[];
  v_owner_before oid;
  v_security_definer_before boolean;
  v_config_before text[];
  v_volatility_before text;
  v_parallel_before text;
  v_comment_before text;
  v_acl_after aclitem[];
  v_owner_after oid;
  v_security_definer_after boolean;
  v_config_after text[];
  v_volatility_after text;
  v_parallel_after text;
  v_comment_after text;
begin
  foreach v_signature in array array[
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ] loop
    select
      procedure.proacl,
      procedure.proowner,
      procedure.prosecdef,
      procedure.proconfig,
      procedure.provolatile::text,
      procedure.proparallel::text,
      pg_catalog.obj_description(procedure.oid, 'pg_proc'),
      pg_catalog.pg_get_functiondef(procedure.oid)
    into
      v_acl_before,
      v_owner_before,
      v_security_definer_before,
      v_config_before,
      v_volatility_before,
      v_parallel_before,
      v_comment_before,
      v_definition
    from pg_catalog.pg_proc procedure
    where procedure.oid = v_signature;

    if not v_security_definer_before
       or not coalesce(
         v_config_before @> array['search_path=""']::text[],
         false
       )
       or pg_catalog.strpos(
         v_definition,
         'session_private.current_app_session_is_valid(''admin'')'
       ) = 0
       or pg_catalog.strpos(
         v_definition,
         'public.online_training_can_view_module()'
       ) = 0 then
      raise exception 'online_training_multivalue_security_guard_changed: %',
        v_signature;
    end if;

    if v_signature =
       'public.online_training_search_people(jsonb,integer,integer)'::regprocedure
    then
      v_expected_empty := 2;
      v_expected_match := 2;
    elsif v_signature =
       'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
    then
      v_expected_empty := 4;
      v_expected_match := 3;
    else
      v_expected_empty := 2;
      v_expected_match := 1;
    end if;

    v_patched := v_definition;
    foreach v_filter_name in array array[
      'team', 'group', 'position', 'shift', 'platform'
    ] loop
      v_old_declaration := pg_catalog.format(
        'v_%1$s text := lower(btrim(coalesce(p_filters->>''%1$s'', '''')));',
        v_filter_name
      );
      v_new_declaration := pg_catalog.format(
        'v_%1$s text[] := session_private.online_training_filter_values(p_filters->>''%1$s'');',
        v_filter_name
      );
      v_old_empty := pg_catalog.format('v_%s = ''''', v_filter_name);
      v_new_empty := pg_catalog.format(
        'pg_catalog.cardinality(v_%s) = 0',
        v_filter_name
      );
      v_old_match := pg_catalog.format('= v_%s', v_filter_name);
      v_new_match := pg_catalog.format('= any(v_%s)', v_filter_name);

      v_hits := (
        pg_catalog.length(v_patched)
        - pg_catalog.length(pg_catalog.replace(
          v_patched,
          v_old_declaration,
          ''
        ))
      ) / pg_catalog.length(v_old_declaration);
      if v_hits <> 1 then
        raise exception
          'online_training_multivalue_declaration_shape_changed: % % %',
          v_signature, v_filter_name, v_hits;
      end if;

      v_hits := (
        pg_catalog.length(v_patched)
        - pg_catalog.length(pg_catalog.replace(v_patched, v_old_empty, ''))
      ) / pg_catalog.length(v_old_empty);
      if v_hits <> v_expected_empty then
        raise exception 'online_training_multivalue_empty_shape_changed: % % %',
          v_signature, v_filter_name, v_hits;
      end if;

      v_hits := (
        pg_catalog.length(v_patched)
        - pg_catalog.length(pg_catalog.replace(v_patched, v_old_match, ''))
      ) / pg_catalog.length(v_old_match);
      if v_hits <> v_expected_match then
        raise exception 'online_training_multivalue_match_shape_changed: % % %',
          v_signature, v_filter_name, v_hits;
      end if;

      v_patched := pg_catalog.replace(
        v_patched,
        v_old_declaration,
        v_new_declaration
      );
      v_patched := pg_catalog.replace(v_patched, v_old_match, v_new_match);
      v_patched := pg_catalog.replace(v_patched, v_old_empty, v_new_empty);
    end loop;

    if v_patched = v_definition
       or pg_catalog.strpos(
         v_patched,
         'session_private.online_training_filter_values'
       ) = 0
       or pg_catalog.strpos(v_patched, ' = any(v_team)') = 0
       or pg_catalog.strpos(
         v_patched,
         'pg_catalog.cardinality(v_team) = 0'
       ) = 0 then
      raise exception 'online_training_multivalue_patch_incomplete: %',
        v_signature;
    end if;

    execute v_patched;

    select
      procedure.proacl,
      procedure.proowner,
      procedure.prosecdef,
      procedure.proconfig,
      procedure.provolatile::text,
      procedure.proparallel::text,
      pg_catalog.obj_description(procedure.oid, 'pg_proc')
    into
      v_acl_after,
      v_owner_after,
      v_security_definer_after,
      v_config_after,
      v_volatility_after,
      v_parallel_after,
      v_comment_after
    from pg_catalog.pg_proc procedure
    where procedure.oid = v_signature;

    if v_acl_after is distinct from v_acl_before
       or v_owner_after is distinct from v_owner_before
       or v_security_definer_after is distinct from v_security_definer_before
       or v_config_after is distinct from v_config_before
       or v_volatility_after is distinct from v_volatility_before
       or v_parallel_after is distinct from v_parallel_before
       or v_comment_after is distinct from v_comment_before then
      raise exception 'online_training_multivalue_function_boundary_changed: %',
        v_signature;
    end if;
  end loop;
end
$patch_multivalue_filters$;

do $verify_multivalue_filters$
declare
  v_signature regprocedure;
  v_definition text;
  v_filter_name text;
  v_expected_empty integer;
  v_expected_match integer;
  v_hits integer;
begin
  foreach v_signature in array array[
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(v_signature) into v_definition;

    if v_signature =
       'public.online_training_search_people(jsonb,integer,integer)'::regprocedure
    then
      v_expected_empty := 2;
      v_expected_match := 2;
    elsif v_signature =
       'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
    then
      v_expected_empty := 4;
      v_expected_match := 3;
    else
      v_expected_empty := 2;
      v_expected_match := 1;
    end if;

    foreach v_filter_name in array array[
      'team', 'group', 'position', 'shift', 'platform'
    ] loop
      v_hits := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(
          v_definition,
          pg_catalog.format(
            'v_%1$s text[] := session_private.online_training_filter_values(p_filters->>''%1$s'');',
            v_filter_name
          ),
          ''
        ))
      ) / pg_catalog.length(pg_catalog.format(
        'v_%1$s text[] := session_private.online_training_filter_values(p_filters->>''%1$s'');',
        v_filter_name
      ));
      if v_hits <> 1 then
        raise exception 'online_training_multivalue_declaration_verify_failed: % %',
          v_signature, v_filter_name;
      end if;

      v_hits := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(
          v_definition,
          pg_catalog.format(
            'pg_catalog.cardinality(v_%s) = 0',
            v_filter_name
          ),
          ''
        ))
      ) / pg_catalog.length(pg_catalog.format(
        'pg_catalog.cardinality(v_%s) = 0',
        v_filter_name
      ));
      if v_hits <> v_expected_empty then
        raise exception 'online_training_multivalue_empty_verify_failed: % % %',
          v_signature, v_filter_name, v_hits;
      end if;

      v_hits := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(
          v_definition,
          pg_catalog.format('= any(v_%s)', v_filter_name),
          ''
        ))
      ) / pg_catalog.length(pg_catalog.format(
        '= any(v_%s)',
        v_filter_name
      ));
      if v_hits <> v_expected_match then
        raise exception 'online_training_multivalue_match_verify_failed: % % %',
          v_signature, v_filter_name, v_hits;
      end if;
    end loop;
  end loop;
end
$verify_multivalue_filters$;

commit;
