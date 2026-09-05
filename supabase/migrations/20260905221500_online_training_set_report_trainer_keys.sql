begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $prerequisite_guard$
declare
  v_scalar_key text;
  v_search text;
begin
  if to_regprocedure(
       'session_private.online_training_visible_published_report_ids(date,date)'
     ) is null
     or to_regprocedure(
       'session_private.online_training_effective_employee_ids()'
     ) is null
     or to_regprocedure(
       'session_private.online_training_report_trainer_key(uuid)'
     ) is null
     or to_regprocedure(
       'session_private.online_training_roster_actor_label(text,text)'
     ) is null
     or to_regprocedure(
       'public.online_training_identity_key(text)'
     ) is null
     or to_regprocedure(
       'public.online_training_search_reports(jsonb,integer,integer)'
     ) is null then
    raise exception 'online_training_set_report_trainer_keys_prerequisite_missing';
  end if;

  select pg_catalog.pg_get_functiondef(
    'session_private.online_training_report_trainer_key(uuid)'::regprocedure
  ) into v_scalar_key;
  select pg_catalog.pg_get_functiondef(
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ) into v_search;

  -- The set implementation below is equivalent only while the scalar helper
  -- keeps this exact visible-member rule and fallback priority.
  if pg_catalog.strpos(
       v_scalar_key,
       'public.online_training_employee_in_scope(member.employee_id)'
     ) = 0
     or pg_catalog.strpos(
       v_scalar_key,
       'public.online_training_caller_is_report_trainer(report.id)'
     ) = 0
     or pg_catalog.strpos(
       v_scalar_key,
       'count(distinct public.online_training_identity_key('
     ) = 0
     or pg_catalog.strpos(
       v_scalar_key,
       'order by member.sort_order, member.employee_name'
     ) = 0
     or pg_catalog.strpos(
       v_scalar_key,
       $fallback$nullif(pg_catalog.btrim(report.trainer_name), ''),
          member_rollup.trainer_name,
          nullif(pg_catalog.btrim(report.author_name), ''),
          nullif(pg_catalog.btrim(report.author_employee_no), ''),
          '未填写线上培训'$fallback$
     ) = 0
     or pg_catalog.strpos(v_scalar_key, 'report.status = ''published''') = 0
     or pg_catalog.strpos(
       v_scalar_key,
       'public.online_training_can_view_report(report.id)'
     ) = 0 then
    raise exception 'online_training_scalar_report_trainer_key_shape_changed';
  end if;

  if pg_catalog.strpos(v_search, 'allowed_employee_ids as materialized') = 0
     or pg_catalog.strpos(v_search, 'permission_context as materialized') = 0
     or pg_catalog.strpos(
       v_search,
       'session_private.online_training_report_trainer_key(report.id)'
     ) = 0 then
    raise exception 'online_training_search_reports_trainer_key_shape_changed';
  end if;
end
$prerequisite_guard$;

-- Resolve every visible report key in one relational pass.  p_enabled lets the
-- caller skip all work when trainer_names is empty; manual trainer text does
-- not need canonical report keys.
create or replace function
  session_private.online_training_visible_report_trainer_keys(
    p_from date default null,
    p_to date default null,
    p_enabled boolean default true
  )
returns table(report_id uuid, trainer_key text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(p_enabled, false) then
    return;
  end if;
  if not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return;
  end if;

  return query
  with allowed_employee_ids as materialized (
    select distinct scope.employee_id
    from session_private.online_training_effective_employee_ids() scope
    where scope.employee_id is not null
  ), visible_reports as materialized (
    select
      report.id report_id,
      report.trainer_name,
      report.author_name,
      report.author_employee_no
    from public.online_training_reports report
    join session_private.online_training_visible_published_report_ids(
      p_from,
      p_to
    ) visible on visible.report_id = report.id
  ), visible_members as materialized (
    select
      member.report_id,
      member.trainer_name,
      member.sort_order,
      member.employee_name
    from visible_reports report
    join public.online_training_report_members member
      on member.report_id = report.report_id
    join allowed_employee_ids allowed
      on allowed.employee_id = member.employee_id
  ), member_rollup as materialized (
    select
      report.report_id,
      case
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
      end member_trainer_name
    from visible_reports report
    left join visible_members member
      on member.report_id = report.report_id
    group by report.report_id
  ), report_inputs as materialized (
    select
      report.report_id,
      report.author_employee_no,
      coalesce(
        nullif(pg_catalog.btrim(report.trainer_name), ''),
        member.member_trainer_name,
        nullif(pg_catalog.btrim(report.author_name), ''),
        nullif(pg_catalog.btrim(report.author_employee_no), ''),
        '未填写线上培训'
      ) trainer_name
    from visible_reports report
    join member_rollup member
      on member.report_id = report.report_id
  ), actor_inputs as materialized (
    select distinct input.trainer_name, input.author_employee_no
    from report_inputs input
  ), actor_keys as materialized (
    select
      actor.trainer_name,
      actor.author_employee_no,
      public.online_training_identity_key(
        session_private.online_training_roster_actor_label(
          actor.trainer_name,
          actor.author_employee_no
        )
      ) trainer_key
    from actor_inputs actor
  )
  select
    input.report_id,
    coalesce(actor.trainer_key, '') trainer_key
  from report_inputs input
  join actor_keys actor
    on actor.trainer_name is not distinct from input.trainer_name
   and actor.author_employee_no is not distinct from input.author_employee_no;
end;
$$;

comment on function
  session_private.online_training_visible_report_trainer_keys(
    date,
    date,
    boolean
  ) is
  'Returns canonical trainer keys for visible published reports with one member rollup and one actor-label lookup per distinct input; disabled calls return immediately.';
revoke all on function
  session_private.online_training_visible_report_trainer_keys(date,date,boolean)
  from public, anon, authenticated, service_role;

do $patch_search_reports$
declare
  v_signature constant regprocedure :=
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure;
  v_definition text;
  v_patched text;
  v_acl_before aclitem[];
  v_owner_before oid;
  v_hits integer;
  v_old_context constant text := $old_context$      ) can_review_permission
  ), visible as materialized ($old_context$;
  v_new_context constant text := $new_context$      ) can_review_permission
  ), report_trainer_keys as materialized (
    select trainer.report_id, trainer.trainer_key
    from session_private.online_training_visible_report_trainer_keys(
      v_date_from,
      v_date_to,
      pg_catalog.cardinality(v_trainer_keys) > 0
    ) trainer
  ), visible as materialized ($new_context$;
  v_old_visible_join constant text := $old_visible_join$    ) visible_report on visible_report.report_id = report.id
    where true$old_visible_join$;
  v_new_visible_join constant text := $new_visible_join$    ) visible_report on visible_report.report_id = report.id
    left join report_trainer_keys report_trainer
      on report_trainer.report_id = report.id
    where true$new_visible_join$;
  v_old_key_filter constant text := $old_key_filter$or session_private.online_training_report_trainer_key(report.id)
          = any(v_trainer_keys)$old_key_filter$;
  v_new_key_filter constant text := $new_key_filter$or report_trainer.trainer_key = any(v_trainer_keys)$new_key_filter$;
begin
  select
    procedure.proacl,
    procedure.proowner,
    pg_catalog.pg_get_functiondef(procedure.oid)
  into v_acl_before, v_owner_before, v_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature
    and procedure.prosecdef
    and procedure.provolatile = 's'
    and coalesce(
      procedure.proconfig @> array['search_path=""']::text[],
      false
    );

  if v_definition is null then
    raise exception 'online_training_search_reports_key_security_shape_changed';
  end if;

  foreach v_hits in array array[
    (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(
        v_definition,
        v_old_context,
        ''
      ))
    ) / pg_catalog.length(v_old_context),
    (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(
        v_definition,
        v_old_visible_join,
        ''
      ))
    ) / pg_catalog.length(v_old_visible_join),
    (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(
        v_definition,
        v_old_key_filter,
        ''
      ))
    ) / pg_catalog.length(v_old_key_filter)
  ] loop
    if v_hits <> 1 then
      raise exception 'online_training_search_reports_key_shape_changed: %',
        v_hits;
    end if;
  end loop;

  v_patched := pg_catalog.replace(v_definition, v_old_context, v_new_context);
  v_patched := pg_catalog.replace(
    v_patched,
    v_old_visible_join,
    v_new_visible_join
  );
  v_patched := pg_catalog.replace(
    v_patched,
    v_old_key_filter,
    v_new_key_filter
  );

  if v_patched = v_definition
     or pg_catalog.strpos(
       v_patched,
       'session_private.online_training_report_trainer_key(report.id)'
     ) > 0
     or pg_catalog.strpos(v_patched, 'report_trainer_keys as materialized') = 0
     or pg_catalog.strpos(
       v_patched,
       'pg_catalog.cardinality(v_trainer_keys) > 0'
     ) = 0 then
    raise exception 'online_training_search_reports_set_key_patch_failed';
  end if;

  execute v_patched;

  if (select procedure.proacl from pg_catalog.pg_proc procedure
      where procedure.oid = v_signature) is distinct from v_acl_before
     or (select procedure.proowner from pg_catalog.pg_proc procedure
         where procedure.oid = v_signature) is distinct from v_owner_before then
    raise exception 'online_training_search_reports_key_metadata_changed';
  end if;
end
$patch_search_reports$;

do $verify$
declare
  v_search text;
  v_set_key text;
  v_actor_calls integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ) into v_search;
  select pg_catalog.pg_get_functiondef(
    'session_private.online_training_visible_report_trainer_keys(date,date,boolean)'::regprocedure
  ) into v_set_key;

  if pg_catalog.strpos(v_search, 'report_trainer_keys as materialized') = 0
     or pg_catalog.strpos(
       v_search,
       'session_private.online_training_visible_report_trainer_keys('
     ) = 0
     or pg_catalog.strpos(v_search, 'report_trainer.trainer_key') = 0
     or pg_catalog.strpos(
       v_search,
       'session_private.online_training_report_trainer_key(report.id)'
     ) > 0 then
    raise exception 'online_training_search_reports_set_key_verify_failed';
  end if;

  if pg_catalog.strpos(v_set_key, 'if not coalesce(p_enabled, false)') = 0
     or pg_catalog.strpos(
       v_set_key,
       'session_private.online_training_visible_published_report_ids('
     ) = 0
     or pg_catalog.strpos(v_set_key, 'allowed_employee_ids as materialized') = 0
     or pg_catalog.strpos(v_set_key, 'member_rollup as materialized') = 0
     or pg_catalog.strpos(v_set_key, 'actor_inputs as materialized') = 0
     or pg_catalog.strpos(v_set_key, 'actor_keys as materialized') = 0 then
    raise exception 'online_training_visible_report_trainer_keys_verify_failed';
  end if;

  v_actor_calls := (
    pg_catalog.length(v_set_key)
    - pg_catalog.length(pg_catalog.replace(
      v_set_key,
      'session_private.online_training_roster_actor_label(',
      ''
    ))
  ) / pg_catalog.length(
    'session_private.online_training_roster_actor_label('
  );
  if v_actor_calls <> 1 then
    raise exception 'online_training_set_report_actor_not_deduplicated: %',
      v_actor_calls;
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated',
       'session_private.online_training_visible_report_trainer_keys(date,date,boolean)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'session_private.online_training_visible_report_trainer_keys(date,date,boolean)',
       'execute'
     ) then
    raise exception 'online_training_visible_report_trainer_keys_acl_widened';
  end if;
end
$verify$;

commit;
