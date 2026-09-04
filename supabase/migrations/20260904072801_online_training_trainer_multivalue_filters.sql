begin;

set local lock_timeout = '2s';
set local statement_timeout = '20s';

do $prerequisite_guard$
begin
  if to_regprocedure(
       'session_private.online_training_filter_values(text)'
     ) is null
     or to_regprocedure(
       'session_private.online_training_roster_actor_label(text,text)'
     ) is null
     or to_regprocedure(
       'public.online_training_identity_key(text)'
     ) is null
     or to_regprocedure(
       'public.online_training_search_people(jsonb,integer,integer)'
     ) is null
     or to_regprocedure(
       'public.online_training_search_trainers(jsonb,integer,integer)'
     ) is null
     or to_regprocedure(
       'public.online_training_search_reports(jsonb,integer,integer)'
     ) is null then
    raise exception 'online_training_trainer_multivalue_prerequisite_missing';
  end if;
end
$prerequisite_guard$;

-- trainer_names uses the same bounded U+001F transport as the organisation
-- multi-selects. Canonicalisation stays in PostgreSQL so browser and database
-- Unicode/punctuation rules can never disagree. An invalid non-empty label is
-- rejected instead of becoming an empty (and therefore unfiltered) key set.
create or replace function session_private.online_training_trainer_filter_keys(
  p_encoded text
)
returns text[]
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_values text[] :=
    session_private.online_training_filter_values(p_encoded);
  v_keys text[];
begin
  if pg_catalog.cardinality(v_values) = 0 then
    return '{}'::text[];
  end if;
  if exists (
    select 1
    from pg_catalog.unnest(v_values) selected(value)
    where nullif(public.online_training_identity_key(selected.value), '') is null
  ) then
    raise exception using
      errcode = '22023',
      message = 'online_training_trainer_filter_identity_invalid';
  end if;

  select coalesce(
    pg_catalog.array_agg(normalized.trainer_key order by normalized.trainer_key),
    '{}'::text[]
  )
  into v_keys
  from (
    select distinct public.online_training_identity_key(selected.value)
      trainer_key
    from pg_catalog.unnest(v_values) selected(value)
  ) normalized;

  return v_keys;
end;
$$;

comment on function
  session_private.online_training_trainer_filter_keys(text) is
  'Decodes bounded U+001F trainer_names and returns distinct server-canonical trainer identity keys.';
revoke all on function
  session_private.online_training_trainer_filter_keys(text)
  from public, anon, authenticated, service_role;

-- Match the canonical report trainer used by online_training_search_trainers:
-- explicit report trainer, otherwise one unique visible member trainer,
-- otherwise author name/employee number. The roster label bridge keeps old
-- master-name reports on the same key as the current selector option.
create or replace function
  session_private.online_training_report_trainer_key(p_report_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select public.online_training_identity_key(
      session_private.online_training_roster_actor_label(
        coalesce(
          nullif(pg_catalog.btrim(report.trainer_name), ''),
          member_rollup.trainer_name,
          nullif(pg_catalog.btrim(report.author_name), ''),
          nullif(pg_catalog.btrim(report.author_employee_no), ''),
          '未填写线上培训'
        ),
        report.author_employee_no
      )
    )
    from public.online_training_reports report
    left join lateral (
      select case
        when count(distinct public.online_training_identity_key(
          member.trainer_name
        )) filter (
          where nullif(public.online_training_identity_key(
            member.trainer_name
          ), '') is not null
        ) = 1 then (
          pg_catalog.array_agg(
            nullif(pg_catalog.btrim(member.trainer_name), '')
            order by member.sort_order, member.employee_name
          ) filter (
            where nullif(pg_catalog.btrim(member.trainer_name), '') is not null
          )
        )[1]
      end trainer_name
      from public.online_training_report_members member
      where member.report_id = report.id
        and (
          public.online_training_employee_in_scope(member.employee_id)
          or public.online_training_caller_is_report_trainer(report.id)
        )
    ) member_rollup on true
    where report.id = p_report_id
      and report.status = 'published'
      and public.online_training_can_view_report(report.id)
  ), '');
$$;

comment on function
  session_private.online_training_report_trainer_key(uuid) is
  'Returns the scope-safe canonical trainer key for one visible published online-training report.';
revoke all on function
  session_private.online_training_report_trainer_key(uuid)
  from public, anon, authenticated, service_role;

-- Patch only reviewed trainer-filter blocks. The public argument lists stay
-- unchanged: trainer remains the legacy manual contains query and
-- trainer_names is an optional U+001F string inside p_filters. Within the
-- trainer dimension manual and selected matches are OR; other dimensions keep
-- their existing AND behaviour.
do $patch_trainer_filters$
declare
  v_signature regprocedure;
  v_definition text;
  v_patched text;
  v_old_blocks text[];
  v_new_blocks text[];
  v_index integer;
  v_hits integer;
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
  v_old_declaration constant text :=
    'v_trainer text := lower(btrim(coalesce(p_filters->>''trainer'', '''')));';
  v_new_declaration constant text := $new_declaration$v_trainer text := lower(btrim(coalesce(p_filters->>'trainer', '')));
  v_trainer_keys text[] := session_private.online_training_trainer_filter_keys(
    p_filters->>'trainer_names'
  );$new_declaration$;
  v_old_current_person constant text := $old_current_person$and (
          v_trainer = ''
          or lower(candidate.trainer_name) like '%' || v_trainer || '%'
        )$old_current_person$;
  v_new_current_person constant text := $new_current_person$and (
          (
            v_trainer = ''
            and pg_catalog.cardinality(v_trainer_keys) = 0
          )
          or (
            v_trainer <> ''
            and lower(candidate.trainer_name) like '%' || v_trainer || '%'
          )
          or public.online_training_identity_key(candidate.trainer_name)
            = any(v_trainer_keys)
        )$new_current_person$;
  v_old_history_person constant text := $old_history_person$and (
              v_trainer = ''
              or lower(concat_ws(' ',
                history_filter.author_name,
                history_filter.author_employee_no,
                history_filter.report_trainer_name,
                history_filter.trainer_name
              )) like '%' || v_trainer || '%'
            )$old_history_person$;
  v_new_history_person constant text := $new_history_person$and (
              (
                v_trainer = ''
                and pg_catalog.cardinality(v_trainer_keys) = 0
              )
              or (
                v_trainer <> ''
                and lower(concat_ws(' ',
                  history_filter.author_name,
                  history_filter.author_employee_no,
                  history_filter.report_trainer_name,
                  history_filter.trainer_name
                )) like '%' || v_trainer || '%'
              )
              or public.online_training_identity_key(coalesce(
                nullif(btrim(history_filter.trainer_name), ''),
                nullif(btrim(history_filter.report_trainer_name), ''),
                nullif(btrim(history_filter.author_name), ''),
                nullif(btrim(history_filter.author_employee_no), '')
              )) = any(v_trainer_keys)
            )$new_history_person$;
  v_old_trainer_report_prefilter constant text := $old_trainer_report_prefilter$from visible_reports report
    where (
      v_trainer = ''
      or lower(concat_ws(' ',
        report.author_name,
        report.author_employee_no,
        report.trainer_name
      )) like '%' || v_trainer || '%'
      or exists (
        select 1
        from visible_member_rows trainer_member
        where trainer_member.report_id = report.id
          and lower(coalesce(trainer_member.trainer_name, ''))
            like '%' || v_trainer || '%'
      )
    )$old_trainer_report_prefilter$;
  v_new_trainer_report_prefilter constant text := $new_trainer_report_prefilter$from visible_reports report
    where (
      v_trainer = ''
      or pg_catalog.cardinality(v_trainer_keys) > 0
      or lower(concat_ws(' ',
        report.author_name,
        report.author_employee_no,
        report.trainer_name
      )) like '%' || v_trainer || '%'
      or exists (
        select 1
        from visible_member_rows trainer_member
        where trainer_member.report_id = report.id
          and lower(coalesce(trainer_member.trainer_name, ''))
            like '%' || v_trainer || '%'
      )
    )$new_trainer_report_prefilter$;
  v_old_report_trainer_rows_end constant text := $old_report_trainer_rows_end$from report_trainer_base report
  ), report_summary as materialized ($old_report_trainer_rows_end$;
  v_new_report_trainer_rows_end constant text := $new_report_trainer_rows_end$from report_trainer_base report
    where (
      (
        v_trainer = ''
        and pg_catalog.cardinality(v_trainer_keys) = 0
      )
      or (
        v_trainer <> ''
        and (
          lower(concat_ws(' ',
            report.author_name,
            report.author_employee_no,
            report.trainer_name
          )) like '%' || v_trainer || '%'
          or exists (
            select 1
            from visible_member_rows trainer_member
            where trainer_member.report_id = report.report_id
              and lower(coalesce(trainer_member.trainer_name, ''))
                like '%' || v_trainer || '%'
          )
        )
      )
      or public.online_training_identity_key(
        session_private.online_training_roster_actor_label(
          report.trainer_name,
          report.author_employee_no
        )
      ) = any(v_trainer_keys)
    )
  ), report_summary as materialized ($new_report_trainer_rows_end$;
  v_old_report_search_filter constant text := $old_report_search_filter$and (
        v_trainer = ''
        or lower(concat_ws(' ',
          report.author_name,
          report.author_employee_no,
          report.trainer_name
        )) like '%' || v_trainer || '%'
        or exists (
          select 1
          from public.online_training_report_members trainer_member
          where trainer_member.report_id = report.id
            and (
              public.online_training_employee_in_scope(
                trainer_member.employee_id
              )
              or public.online_training_caller_is_report_trainer(report.id)
            )
            and lower(coalesce(trainer_member.trainer_name, ''))
              like '%' || v_trainer || '%'
        )
      )$old_report_search_filter$;
  v_new_report_search_filter constant text := $new_report_search_filter$and (
        (
          v_trainer = ''
          and pg_catalog.cardinality(v_trainer_keys) = 0
        )
        or (
          v_trainer <> ''
          and (
            lower(concat_ws(' ',
              report.author_name,
              report.author_employee_no,
              report.trainer_name
            )) like '%' || v_trainer || '%'
            or exists (
              select 1
              from public.online_training_report_members trainer_member
              where trainer_member.report_id = report.id
                and (
                  public.online_training_employee_in_scope(
                    trainer_member.employee_id
                  )
                  or public.online_training_caller_is_report_trainer(report.id)
                )
                and lower(coalesce(trainer_member.trainer_name, ''))
                  like '%' || v_trainer || '%'
            )
          )
        )
        or session_private.online_training_report_trainer_key(report.id)
          = any(v_trainer_keys)
      )$new_report_search_filter$;
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
      raise exception 'online_training_trainer_filter_security_guard_changed: %',
        v_signature;
    end if;

    if v_signature =
       'public.online_training_search_people(jsonb,integer,integer)'::regprocedure
    then
      v_old_blocks := array[
        v_old_declaration,
        v_old_current_person,
        v_old_history_person
      ];
      v_new_blocks := array[
        v_new_declaration,
        v_new_current_person,
        v_new_history_person
      ];
    elsif v_signature =
       'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
    then
      v_old_blocks := array[
        v_old_declaration,
        v_old_current_person,
        v_old_history_person,
        v_old_trainer_report_prefilter,
        v_old_report_trainer_rows_end
      ];
      v_new_blocks := array[
        v_new_declaration,
        v_new_current_person,
        v_new_history_person,
        v_new_trainer_report_prefilter,
        v_new_report_trainer_rows_end
      ];
    else
      v_old_blocks := array[
        v_old_declaration,
        v_old_report_search_filter
      ];
      v_new_blocks := array[
        v_new_declaration,
        v_new_report_search_filter
      ];
    end if;

    v_patched := v_definition;
    for v_index in 1..pg_catalog.cardinality(v_old_blocks) loop
      v_hits := (
        pg_catalog.length(v_patched)
        - pg_catalog.length(pg_catalog.replace(
          v_patched,
          v_old_blocks[v_index],
          ''
        ))
      ) / pg_catalog.length(v_old_blocks[v_index]);
      if v_hits <> 1 then
        raise exception 'online_training_trainer_filter_shape_changed: % % %',
          v_signature, v_index, v_hits;
      end if;
      v_patched := pg_catalog.replace(
        v_patched,
        v_old_blocks[v_index],
        v_new_blocks[v_index]
      );
    end loop;

    if v_patched = v_definition
       or pg_catalog.strpos(v_patched, 'p_filters->>''trainer_names''') = 0
       or pg_catalog.strpos(
         v_patched,
         'online_training_trainer_filter_keys'
       ) = 0
       or pg_catalog.strpos(v_patched, '= any(v_trainer_keys)') = 0
       or pg_catalog.strpos(v_patched, 'v_trainer <> ''''') = 0 then
      raise exception 'online_training_trainer_filter_patch_incomplete: %',
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
      raise exception 'online_training_trainer_filter_boundary_changed: %',
        v_signature;
    end if;
  end loop;
end
$patch_trainer_filters$;

do $verify_trainer_filters$
declare
  v_signature regprocedure;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
    if (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(
        v_definition,
        'p_filters->>''trainer_names''',
        ''
      ))
    ) / pg_catalog.length('p_filters->>''trainer_names''') <> 1
       or pg_catalog.strpos(v_definition, 'v_trainer <> ''''') = 0
       or pg_catalog.strpos(v_definition, '= any(v_trainer_keys)') = 0
       or pg_catalog.strpos(
         v_definition,
         'session_private.current_app_session_is_valid(''admin'')'
       ) = 0
       or pg_catalog.strpos(
         v_definition,
         'public.online_training_can_view_module()'
       ) = 0 then
      raise exception 'online_training_trainer_filter_verify_failed: %',
        v_signature;
    end if;
  end loop;
end
$verify_trainer_filters$;

commit;
