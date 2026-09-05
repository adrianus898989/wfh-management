begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- These shape guards document the exact scalar semantics being folded into
-- one set-valued request context.  Abort safely if any permission contract has
-- changed instead of silently widening edit or review access.
do $prerequisite_guard$
declare
  v_search text;
  v_caller_trainer text;
  v_edit text;
  v_edit_granular text;
  v_review text;
  v_review_granular text;
begin
  if to_regprocedure(
       'public.online_training_search_reports(jsonb,integer,integer)'
     ) is null
     or to_regprocedure(
       'session_private.online_training_effective_employee_ids()'
     ) is null
     or to_regprocedure(
       'session_private.online_training_visible_published_report_ids(date,date)'
     ) is null
     or to_regprocedure(
       'public.online_training_caller_is_report_trainer(uuid)'
     ) is null
     or to_regprocedure(
       'public.online_training_can_edit_report(uuid)'
     ) is null
     or to_regprocedure(
       'public.online_training_can_edit_report_granular_v1(uuid)'
     ) is null
     or to_regprocedure(
       'public.online_training_can_review_report(uuid)'
     ) is null
     or to_regprocedure(
       'public.online_training_can_review_report_granular_v1(uuid)'
     ) is null then
    raise exception 'online_training_search_reports_set_permissions_prerequisite_missing';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ) into v_search;
  select pg_catalog.pg_get_functiondef(
    'public.online_training_caller_is_report_trainer(uuid)'::regprocedure
  ) into v_caller_trainer;
  select pg_catalog.pg_get_functiondef(
    'public.online_training_can_edit_report(uuid)'::regprocedure
  ) into v_edit;
  select pg_catalog.pg_get_functiondef(
    'public.online_training_can_edit_report_granular_v1(uuid)'::regprocedure
  ) into v_edit_granular;
  select pg_catalog.pg_get_functiondef(
    'public.online_training_can_review_report(uuid)'::regprocedure
  ) into v_review;
  select pg_catalog.pg_get_functiondef(
    'public.online_training_can_review_report_granular_v1(uuid)'::regprocedure
  ) into v_review_granular;

  if pg_catalog.strpos(
       v_search,
       'session_private.online_training_visible_published_report_ids('
     ) = 0 then
    raise exception 'online_training_search_reports_published_visibility_missing';
  end if;

  -- caller_is_report_trainer can only be true when at least one concrete
  -- member exists and no member falls outside the canonical employee scope.
  if pg_catalog.strpos(
       v_caller_trainer,
       'member.employee_id is not null'
     ) = 0
     or pg_catalog.strpos(
       v_caller_trainer,
       'and not public.online_training_employee_in_scope(member.employee_id)'
     ) = 0 then
    raise exception 'online_training_caller_trainer_implication_shape_changed';
  end if;

  if pg_catalog.strpos(
       v_edit,
       'online_training.report.submit'
     ) = 0
     or pg_catalog.strpos(v_edit, 'online_training.report.manage') = 0
     or pg_catalog.strpos(
       v_edit,
       'online_training_can_edit_report_granular_v1(p_report_id)'
     ) = 0
     or pg_catalog.strpos(
       v_edit,
       'online_training_can_view_report(p_report_id)'
     ) = 0
     or pg_catalog.strpos(
       v_edit_granular,
       'report.created_by = (select auth.uid())'
     ) = 0
     or pg_catalog.strpos(
       v_edit_granular,
       'online_training_employee_in_scope(report.author_employee_id)'
     ) = 0
     or pg_catalog.strpos(
       v_edit_granular,
       'online_training_employee_in_scope(member.employee_id)'
     ) = 0 then
    raise exception 'online_training_edit_permission_shape_changed';
  end if;

  if pg_catalog.strpos(v_review, 'online_training.report.review') = 0
     or pg_catalog.strpos(v_review, 'online_training.report.manage') = 0
     or pg_catalog.strpos(
       v_review,
       'online_training_can_review_report_granular_v1(p_report_id)'
     ) = 0
     or pg_catalog.strpos(
       v_review_granular,
       'online_training_can_view_report(p_report_id)'
     ) = 0
     or pg_catalog.strpos(
       v_review_granular,
       'online_training.report.review'
     ) = 0
     or pg_catalog.strpos(
       v_review_granular,
       'online_training.report.manage'
     ) = 0 then
    raise exception 'online_training_review_permission_shape_changed';
  end if;
end
$prerequisite_guard$;

do $patch_search_reports$
declare
  v_signature constant regprocedure :=
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure;
  v_definition text;
  v_patched text;
  v_acl_before aclitem[];
  v_owner_before oid;
  v_index integer;
  v_hits integer;
  v_old_prefix constant text := $old_prefix$  with visible as materialized ($old_prefix$;
  v_new_prefix constant text := $new_prefix$  with allowed_employee_ids as materialized (
    select distinct scope.employee_id
    from session_private.online_training_effective_employee_ids() scope
    where scope.employee_id is not null
  ), permission_context as materialized (
    select
      (select auth.uid()) caller_user_id,
      coalesce(
        public.has_permission('online_training.report.submit'),
        false
      ) can_submit,
      coalesce(
        public.has_permission('online_training.report.manage'),
        false
      ) can_manage,
      coalesce(
        public.has_permission('online_training.report.review'),
        false
      ) can_review_permission
  ), visible as materialized ($new_prefix$;
  v_old_blocks text[] := array[
    $old_trainer_member$and (
                  public.online_training_employee_in_scope(
                    trainer_member.employee_id
                  )
                  or public.online_training_caller_is_report_trainer(report.id)
                )$old_trainer_member$,
    $old_member_filter$and (
              public.online_training_employee_in_scope(member_filter.employee_id)
              or public.online_training_caller_is_report_trainer(report.id)
            )$old_member_filter$,
    $old_keyword_member$and (
              public.online_training_employee_in_scope(keyword_member.employee_id)
              or public.online_training_caller_is_report_trainer(report.id)
            )$old_keyword_member$,
    $old_page_member$and (
                public.online_training_employee_in_scope(member.employee_id)
                or public.online_training_caller_is_report_trainer(page_report.id)
              )$old_page_member$
  ];
  v_new_blocks text[] := array[
    $new_trainer_member$and exists (
                  select 1
                  from allowed_employee_ids allowed
                  where allowed.employee_id = trainer_member.employee_id
                )$new_trainer_member$,
    $new_member_filter$and exists (
              select 1
              from allowed_employee_ids allowed
              where allowed.employee_id = member_filter.employee_id
            )$new_member_filter$,
    $new_keyword_member$and exists (
              select 1
              from allowed_employee_ids allowed
              where allowed.employee_id = keyword_member.employee_id
            )$new_keyword_member$,
    $new_page_member$and exists (
                select 1
                from allowed_employee_ids allowed
                where allowed.employee_id = member.employee_id
              )$new_page_member$
  ];
  v_old_permissions constant text := $old_permissions$          'can_edit', public.online_training_can_edit_report(page_report.id),
          'can_review', public.online_training_can_review_report(page_report.id),$old_permissions$;
  v_new_permissions constant text := $new_permissions$          'can_edit', (
            (permission.can_submit or permission.can_manage)
            and (
              coalesce(
                page_report.created_by = permission.caller_user_id,
                false
              )
              or permission.can_manage
            )
            and (
              exists (
                select 1
                from allowed_employee_ids allowed_author
                where allowed_author.employee_id =
                  page_report.author_employee_id
              )
              or exists (
                select 1
                from public.online_training_report_members editable_member
                join allowed_employee_ids editable_allowed
                  on editable_allowed.employee_id = editable_member.employee_id
                where editable_member.report_id = page_report.id
              )
            )
          ),
          'can_review', (
            permission.can_review_permission or permission.can_manage
          ),$new_permissions$;
  v_old_page_source constant text := $old_page_source$        limit v_page_size
      ) page_report$old_page_source$;
  v_new_page_source constant text := $new_page_source$        limit v_page_size
      ) page_report
      cross join permission_context permission$new_page_source$;
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
    raise exception 'online_training_search_reports_security_shape_changed';
  end if;

  v_hits := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(
      v_definition,
      v_old_prefix,
      ''
    ))
  ) / pg_catalog.length(v_old_prefix);
  if v_hits <> 1 then
    raise exception 'online_training_search_reports_prefix_shape_changed: %',
      v_hits;
  end if;
  v_patched := pg_catalog.replace(v_definition, v_old_prefix, v_new_prefix);

  for v_index in 1..pg_catalog.array_length(v_old_blocks, 1) loop
    v_hits := (
      pg_catalog.length(v_patched)
      - pg_catalog.length(pg_catalog.replace(
        v_patched,
        v_old_blocks[v_index],
        ''
      ))
    ) / pg_catalog.length(v_old_blocks[v_index]);
    if v_hits <> 1 then
      raise exception 'online_training_search_reports_member_shape_changed: %, %',
        v_index,
        v_hits;
    end if;
    v_patched := pg_catalog.replace(
      v_patched,
      v_old_blocks[v_index],
      v_new_blocks[v_index]
    );
  end loop;

  v_hits := (
    pg_catalog.length(v_patched)
    - pg_catalog.length(pg_catalog.replace(
      v_patched,
      v_old_permissions,
      ''
    ))
  ) / pg_catalog.length(v_old_permissions);
  if v_hits <> 1 then
    raise exception 'online_training_search_reports_permission_shape_changed: %',
      v_hits;
  end if;
  v_patched := pg_catalog.replace(
    v_patched,
    v_old_permissions,
    v_new_permissions
  );

  v_hits := (
    pg_catalog.length(v_patched)
    - pg_catalog.length(pg_catalog.replace(
      v_patched,
      v_old_page_source,
      ''
    ))
  ) / pg_catalog.length(v_old_page_source);
  if v_hits <> 1 then
    raise exception 'online_training_search_reports_page_shape_changed: %',
      v_hits;
  end if;
  v_patched := pg_catalog.replace(
    v_patched,
    v_old_page_source,
    v_new_page_source
  );

  if v_patched = v_definition
     or pg_catalog.strpos(
       v_patched,
       'public.online_training_employee_in_scope('
     ) > 0
     or pg_catalog.strpos(
       v_patched,
       'public.online_training_caller_is_report_trainer('
     ) > 0
     or pg_catalog.strpos(
       v_patched,
       'public.online_training_can_edit_report('
     ) > 0
     or pg_catalog.strpos(
       v_patched,
       'public.online_training_can_review_report('
     ) > 0 then
    raise exception 'online_training_search_reports_set_permissions_patch_failed';
  end if;

  execute v_patched;

  if (select procedure.proacl from pg_catalog.pg_proc procedure
      where procedure.oid = v_signature) is distinct from v_acl_before
     or (select procedure.proowner from pg_catalog.pg_proc procedure
         where procedure.oid = v_signature) is distinct from v_owner_before then
    raise exception 'online_training_search_reports_metadata_changed';
  end if;
end
$patch_search_reports$;

do $verify$
declare
  v_definition text;
  v_permission_calls integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ) into v_definition;

  if pg_catalog.strpos(v_definition, 'allowed_employee_ids as materialized') = 0
     or pg_catalog.strpos(v_definition, 'permission_context as materialized') = 0
     or pg_catalog.strpos(
       v_definition,
       'session_private.online_training_effective_employee_ids()'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'cross join permission_context permission'
     ) = 0
     or pg_catalog.strpos(v_definition, 'editable_allowed.employee_id') = 0 then
    raise exception 'online_training_search_reports_set_context_verify_failed';
  end if;

  if pg_catalog.strpos(
       v_definition,
       'public.online_training_employee_in_scope('
     ) > 0
     or pg_catalog.strpos(
       v_definition,
       'public.online_training_caller_is_report_trainer('
     ) > 0
     or pg_catalog.strpos(
       v_definition,
       'public.online_training_can_edit_report('
     ) > 0
     or pg_catalog.strpos(
       v_definition,
       'public.online_training_can_review_report('
     ) > 0 then
    raise exception 'online_training_search_reports_scalar_permission_remains';
  end if;

  v_permission_calls := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(
      v_definition,
      'public.has_permission(',
      ''
    ))
  ) / pg_catalog.length('public.has_permission(');
  if v_permission_calls <> 3 then
    raise exception 'online_training_search_reports_permission_context_not_once: %',
      v_permission_calls;
  end if;

  if pg_catalog.strpos(
       v_definition,
       'page_report.created_by = permission.caller_user_id'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'page_report.author_employee_id'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'permission.can_review_permission or permission.can_manage'
     ) = 0 then
    raise exception 'online_training_search_reports_permission_formula_changed';
  end if;
end
$verify$;

commit;
