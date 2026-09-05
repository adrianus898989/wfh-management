begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The public scalar scope function is the canonical permission contract.  The
-- set-valued equivalent must keep the same founder/all/manager branches before
-- it can safely replace per-report permission calls.
do $prerequisite_guard$
declare
  v_scalar_scope text;
  v_set_scope text;
  v_canonical_scope constant text :=
    $shape$v_data_scope in ('all', 'own_team', 'assigned', 'assigned_teams')$shape$;
begin
  if to_regprocedure(
       'session_private.online_training_effective_employee_ids()'
     ) is null
     or to_regprocedure(
       'public.online_training_employee_in_scope(uuid)'
     ) is null
     or to_regprocedure(
       'public.online_training_search_people(jsonb,integer,integer)'
     ) is null
     or to_regprocedure(
       'public.online_training_search_trainers(jsonb,integer,integer)'
     ) is null
     or to_regprocedure(
       'public.online_training_search_reports(jsonb,integer,integer)'
     ) is null
     or to_regprocedure(
       'session_private.online_training_roster_actor_label(text,text)'
     ) is null
     or to_regprocedure(
       'public.employee_master_normalize_id(text)'
     ) is null
     or to_regprocedure(
       'session_private.online_training_roster_name_key(text)'
     ) is null then
    raise exception 'online_training_set_visibility_prerequisite_missing';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.online_training_employee_in_scope(uuid)'::regprocedure
  ) into v_scalar_scope;
  select pg_catalog.pg_get_functiondef(
    'session_private.online_training_effective_employee_ids()'::regprocedure
  ) into v_set_scope;

  if pg_catalog.strpos(v_scalar_scope, v_canonical_scope) = 0
     or pg_catalog.strpos(
       v_scalar_scope,
       'admin_scope_effective_employee_ids(v_user_id)'
     ) = 0
     or pg_catalog.strpos(v_set_scope, v_canonical_scope) = 0
     or pg_catalog.strpos(
       v_set_scope,
       'admin_scope_effective_employee_ids(v_user_id)'
     ) = 0 then
    raise exception 'online_training_canonical_scope_shape_changed';
  end if;
end
$prerequisite_guard$;

-- Report visibility groups members by report_id.  Keep both columns in this
-- order so the aggregation can be satisfied from one narrow index scan.
create index if not exists
  online_training_report_members_report_employee_idx
  on public.online_training_report_members (report_id, employee_id);

-- online_training_roster_actor_label() first resolves a current employee by
-- strict roster name and, when present, employee number.  Its prior indexes
-- used a different normalization function, forcing repeated employee scans.
create index if not exists employees_online_training_roster_actor_lookup_idx
  on public.employees (
    session_private.online_training_roster_name_key(full_name),
    public.employee_master_normalize_id(employee_no)
  )
  include (id, employee_no, full_name, hire_date)
  where status in ('active', 'probation');

comment on index
  public.online_training_report_members_report_employee_idx is
  'Covers set-based online-training report visibility by report and employee.';
comment on index public.employees_online_training_roster_actor_lookup_idx is
  'Covers strict current-roster actor label resolution without rescanning employees.';

-- This helper is deliberately limited to published reports.  Draft/manage
-- visibility has additional owner and manage-permission branches and remains
-- on the existing RPC path until it receives a separate reviewed rewrite.
create or replace function
  session_private.online_training_visible_published_report_ids(
    p_from date default null,
    p_to date default null
  )
returns table(report_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return;
  end if;

  if public.is_founder() then
    return query
    select report.id
    from public.online_training_reports report
    where report.status = 'published'
      and (p_from is null or report.report_date >= p_from)
      and (p_to is null or report.report_date <= p_to);
    return;
  end if;

  return query
  with allowed_employee_ids as materialized (
    select distinct scope.employee_id
    from session_private.online_training_effective_employee_ids() scope
    where scope.employee_id is not null
  ), candidate_reports as materialized (
    select report.id report_id, report.author_employee_id
    from public.online_training_reports report
    where report.status = 'published'
      and (p_from is null or report.report_date >= p_from)
      and (p_to is null or report.report_date <= p_to)
  ), access_rollup as materialized (
    select
      candidate.report_id,
      pg_catalog.bool_and(
        member.report_id is null
        or allowed_member.employee_id is not null
      ) all_members_allowed,
      pg_catalog.bool_or(
        member.report_id is not null
        and allowed_member.employee_id is not null
      ) any_member_allowed
    from candidate_reports candidate
    left join public.online_training_report_members member
      on member.report_id = candidate.report_id
    left join allowed_employee_ids allowed_member
      on allowed_member.employee_id = member.employee_id
    group by candidate.report_id
  )
  select candidate.report_id
  from candidate_reports candidate
  join access_rollup access
    on access.report_id = candidate.report_id
  left join allowed_employee_ids allowed_author
    on allowed_author.employee_id = candidate.author_employee_id
  where access.all_members_allowed
    and (
      allowed_author.employee_id is not null
      or access.any_member_allowed
    );
end;
$$;

comment on function
  session_private.online_training_visible_published_report_ids(date,date) is
  'Returns published reports visible under the canonical online-training employee scope, evaluating scope once per request.';
revoke all on function
  session_private.online_training_visible_published_report_ids(date,date)
  from public, anon, authenticated, service_role;

-- Replace only the published-report history source in the people directory.
-- Filters, rollups, paging, JSON shape and the existing founder branch stay
-- unchanged.  A non-founder report admitted by the helper has every non-null
-- member in the same canonical allowed set, so the old caller-trainer OR was
-- logically redundant after the report-wide all-members guard.
do $patch_search_people$
declare
  v_signature constant regprocedure :=
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure;
  v_definition text;
  v_patched text;
  v_old constant text := $old_people$    from public.online_training_report_members member
    join public.online_training_reports report on report.id = member.report_id
    left join public.employees employee on employee.id = member.employee_id
    left join allowed_employee_ids allowed_member
      on allowed_member.employee_id = member.employee_id
    where report.status = 'published'
      and member.employee_id is not null
      and public.online_training_can_view_report(report.id)
      and (
        allowed_member.employee_id is not null
        or v_is_founder
        or public.online_training_caller_is_report_trainer(report.id)
      )
      and report.report_date between v_effective_from and v_effective_to$old_people$;
  v_new constant text := $new_people$    from public.online_training_report_members member
    join public.online_training_reports report on report.id = member.report_id
    join session_private.online_training_visible_published_report_ids(
      v_effective_from,
      v_effective_to
    ) visible_report on visible_report.report_id = report.id
    left join public.employees employee on employee.id = member.employee_id
    left join allowed_employee_ids allowed_member
      on allowed_member.employee_id = member.employee_id
    where member.employee_id is not null
      and (
        allowed_member.employee_id is not null
        or v_is_founder
      )$new_people$;
  v_acl_before aclitem[];
  v_owner_before oid;
begin
  select procedure.proacl, procedure.proowner,
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

  if v_definition is null
     or pg_catalog.strpos(v_definition, v_old) = 0
     or pg_catalog.strpos(
       pg_catalog.substring(
         v_definition,
         pg_catalog.strpos(v_definition, v_old) + pg_catalog.length(v_old)
       ),
       v_old
     ) > 0 then
    raise exception 'online_training_search_people_visibility_shape_changed';
  end if;

  v_patched := pg_catalog.replace(v_definition, v_old, v_new);
  if v_patched = v_definition
     or pg_catalog.strpos(
       v_patched,
       'public.online_training_can_view_report(report.id)'
     ) > 0
     or pg_catalog.strpos(
       v_patched,
       'public.online_training_caller_is_report_trainer(report.id)'
     ) > 0 then
    raise exception 'online_training_search_people_visibility_patch_failed';
  end if;

  execute v_patched;

  if (select procedure.proacl from pg_catalog.pg_proc procedure
      where procedure.oid = v_signature) is distinct from v_acl_before
     or (select procedure.proowner from pg_catalog.pg_proc procedure
         where procedure.oid = v_signature) is distinct from v_owner_before then
    raise exception 'online_training_search_people_metadata_changed';
  end if;
end
$patch_search_people$;

-- Apply the same report-level visibility set to the trainer directory.  This
-- removes both nested per-report permission helpers from its hot path.
do $patch_search_trainers_visibility$
declare
  v_signature constant regprocedure :=
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure;
  v_definition text;
  v_patched text;
  v_old constant text := $old_trainers_visibility$  ), visible_reports as materialized (
    select
      report.id,
      report.report_date,
      report.created_at,
      report.title,
      report.author_name,
      report.author_employee_no,
      report.trainer_name,
      report.platform,
      report.shift_name,
      report.team_name,
      report.group_name,
      report.leader_name,
      report.course_type,
      report.report_summary,
      report.issues_summary,
      report.next_plan,
      public.online_training_caller_is_report_trainer(report.id)
        caller_is_report_trainer
    from public.online_training_reports report
    where report.status = 'published'
      and public.online_training_can_view_report(report.id)
      and report.report_date between v_effective_from and v_effective_to
  ), visible_member_rows as materialized (
$old_trainers_visibility$;
  v_new constant text := $new_trainers_visibility$  ), visible_reports as materialized (
    select
      report.id,
      report.report_date,
      report.created_at,
      report.title,
      report.author_name,
      report.author_employee_no,
      report.trainer_name,
      report.platform,
      report.shift_name,
      report.team_name,
      report.group_name,
      report.leader_name,
      report.course_type,
      report.report_summary,
      report.issues_summary,
      report.next_plan
    from public.online_training_reports report
    join session_private.online_training_visible_published_report_ids(
      v_effective_from,
      v_effective_to
    ) visible_report on visible_report.report_id = report.id
  ), visible_member_rows as materialized (
$new_trainers_visibility$;
  v_old_member_filter constant text := $old_member_filter$    where member.employee_id is not null
      and (
        allowed_member.employee_id is not null
        or v_is_founder
        or report.caller_is_report_trainer
      )$old_member_filter$;
  v_new_member_filter constant text := $new_member_filter$    where member.employee_id is not null
      and (
        allowed_member.employee_id is not null
        or v_is_founder
      )$new_member_filter$;
  v_acl_before aclitem[];
  v_owner_before oid;
begin
  select procedure.proacl, procedure.proowner,
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

  if v_definition is null
     or pg_catalog.strpos(v_definition, v_old) = 0
     or pg_catalog.strpos(v_definition, v_old_member_filter) = 0 then
    raise exception 'online_training_search_trainers_visibility_shape_changed';
  end if;

  v_patched := pg_catalog.replace(v_definition, v_old, v_new);
  v_patched := pg_catalog.replace(
    v_patched,
    v_old_member_filter,
    v_new_member_filter
  );

  if v_patched = v_definition
     or pg_catalog.strpos(
       v_patched,
       'public.online_training_can_view_report(report.id)'
     ) > 0
     or pg_catalog.strpos(
       v_patched,
       'public.online_training_caller_is_report_trainer(report.id)'
     ) > 0
     or pg_catalog.strpos(v_patched, 'report.caller_is_report_trainer') > 0 then
    raise exception 'online_training_search_trainers_visibility_patch_failed';
  end if;

  execute v_patched;

  if (select procedure.proacl from pg_catalog.pg_proc procedure
      where procedure.oid = v_signature) is distinct from v_acl_before
     or (select procedure.proowner from pg_catalog.pg_proc procedure
         where procedure.oid = v_signature) is distinct from v_owner_before then
    raise exception 'online_training_search_trainers_metadata_changed';
  end if;
end
$patch_search_trainers_visibility$;

-- Resolve the roster label once for each distinct (trainer name, author ID)
-- pair, then join the small result back to reports.  The production sample had
-- 173 reports but only 45 distinct inputs, so this preserves the exact label
-- semantics while removing 128 repeated resolver calls.
do $patch_search_trainers_actor_labels$
declare
  v_signature constant regprocedure :=
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure;
  v_definition text;
  v_patched text;
  v_old constant text := $old_trainer_rows$  ), report_trainer_rows as materialized (
    select
      report.*,
      public.online_training_identity_key(session_private.online_training_roster_actor_label(report.trainer_name, report.author_employee_no)) trainer_key,
      case
        when public.online_training_identity_key(report.author_name)
          = public.online_training_identity_key(report.trainer_name)
        then coalesce(report.author_employee_no, '')
        else ''
      end trainer_employee_no
    from report_trainer_base report
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
  ), report_summary as materialized ($old_trainer_rows$;
  v_new constant text := $new_trainer_rows$  ), actor_inputs as materialized (
    select distinct report.trainer_name, report.author_employee_no
    from report_trainer_base report
  ), actor_labels as materialized (
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
  ), report_trainer_rows as materialized (
    select
      report.*,
      actor.trainer_key,
      case
        when public.online_training_identity_key(report.author_name)
          = public.online_training_identity_key(report.trainer_name)
        then coalesce(report.author_employee_no, '')
        else ''
      end trainer_employee_no
    from report_trainer_base report
    join actor_labels actor
      on actor.trainer_name is not distinct from report.trainer_name
     and actor.author_employee_no is not distinct from report.author_employee_no
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
      or actor.trainer_key = any(v_trainer_keys)
    )
  ), report_summary as materialized ($new_trainer_rows$;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'online_training_search_trainers_actor_shape_changed';
  end if;

  v_patched := pg_catalog.replace(v_definition, v_old, v_new);
  if v_patched = v_definition
     or pg_catalog.strpos(v_patched, 'actor_inputs as materialized') = 0
     or pg_catalog.strpos(v_patched, 'actor_labels as materialized') = 0
     or (
       pg_catalog.length(v_patched)
       - pg_catalog.length(pg_catalog.replace(
         v_patched,
         'session_private.online_training_roster_actor_label(',
         ''
       ))
     ) / pg_catalog.length(
       'session_private.online_training_roster_actor_label('
     ) <> 1 then
    raise exception 'online_training_search_trainers_actor_patch_failed';
  end if;

  execute v_patched;
end
$patch_search_trainers_actor_labels$;

-- The report browser has the same published/date outer gate.  Replace only
-- that gate; its member/trainer scalar checks are conditional search branches
-- and remain unchanged for a later, separately reviewed optimization.
do $patch_search_reports_outer_visibility$
declare
  v_signature constant regprocedure :=
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure;
  v_definition text;
  v_patched text;
  v_old constant text := $old_reports_visibility$    from public.online_training_reports report
    where report.status = 'published'
      and public.online_training_can_view_report(report.id)
      and (v_date_from is null or report.report_date >= v_date_from)
      and (v_date_to is null or report.report_date <= v_date_to)$old_reports_visibility$;
  v_new constant text := $new_reports_visibility$    from public.online_training_reports report
    join session_private.online_training_visible_published_report_ids(
      v_date_from,
      v_date_to
    ) visible_report on visible_report.report_id = report.id
    where true$new_reports_visibility$;
  v_acl_before aclitem[];
  v_owner_before oid;
begin
  select procedure.proacl, procedure.proowner,
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

  if v_definition is null
     or pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'online_training_search_reports_visibility_shape_changed';
  end if;

  v_patched := pg_catalog.replace(v_definition, v_old, v_new);
  if v_patched = v_definition
     or pg_catalog.strpos(
       v_patched,
       'public.online_training_can_view_report(report.id)'
     ) > 0 then
    raise exception 'online_training_search_reports_visibility_patch_failed';
  end if;

  execute v_patched;

  if (select procedure.proacl from pg_catalog.pg_proc procedure
      where procedure.oid = v_signature) is distinct from v_acl_before
     or (select procedure.proowner from pg_catalog.pg_proc procedure
         where procedure.oid = v_signature) is distinct from v_owner_before then
    raise exception 'online_training_search_reports_metadata_changed';
  end if;
end
$patch_search_reports_outer_visibility$;

-- Guard the final definitions, including private ACLs and the exact canonical
-- scope shape. online_training_list is intentionally not rewritten here: its
-- detail payload and row-level behavior need a separate review.
do $verify$
declare
  v_signature regprocedure;
  v_definition text;
  v_scalar_scope text;
  v_set_scope text;
  v_actor_call_count integer;
begin
  foreach v_signature in array array[
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
    if pg_catalog.strpos(
         v_definition,
         'session_private.online_training_visible_published_report_ids('
       ) = 0
       or pg_catalog.strpos(
         v_definition,
         'public.online_training_can_view_report(report.id)'
       ) > 0
       or pg_catalog.strpos(
         v_definition,
         'public.online_training_caller_is_report_trainer(report.id)'
       ) > 0 then
      raise exception 'online_training_set_visibility_verify_failed: %',
        v_signature;
    end if;
  end loop;

  select pg_catalog.pg_get_functiondef(
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ) into v_definition;
  if pg_catalog.strpos(
       v_definition,
       'session_private.online_training_visible_published_report_ids('
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'public.online_training_can_view_report(report.id)'
     ) > 0 then
    raise exception 'online_training_search_reports_visibility_verify_failed';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  ) into v_definition;
  v_actor_call_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(
      v_definition,
      'session_private.online_training_roster_actor_label(',
      ''
    ))
  ) / pg_catalog.length(
    'session_private.online_training_roster_actor_label('
  );
  if v_actor_call_count <> 1
     or pg_catalog.strpos(v_definition, 'actor_inputs as materialized') = 0
     or pg_catalog.strpos(v_definition, 'select distinct report.trainer_name') = 0 then
    raise exception 'online_training_actor_label_dedup_verify_failed';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.online_training_employee_in_scope(uuid)'::regprocedure
  ) into v_scalar_scope;
  select pg_catalog.pg_get_functiondef(
    'session_private.online_training_effective_employee_ids()'::regprocedure
  ) into v_set_scope;
  if pg_catalog.strpos(
       v_scalar_scope,
       $shape$v_data_scope in ('all', 'own_team', 'assigned', 'assigned_teams')$shape$
     ) = 0
     or pg_catalog.strpos(
       v_set_scope,
       $shape$v_data_scope in ('all', 'own_team', 'assigned', 'assigned_teams')$shape$
     ) = 0 then
    raise exception 'online_training_scope_equivalence_verify_failed';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated',
       'session_private.online_training_visible_published_report_ids(date,date)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'session_private.online_training_visible_published_report_ids(date,date)',
       'execute'
     ) then
    raise exception 'online_training_visible_report_helper_acl_widened';
  end if;
end
$verify$;

commit;
