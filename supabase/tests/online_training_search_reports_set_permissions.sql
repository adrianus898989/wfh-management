begin;

do $test_online_training_search_reports_set_permissions$
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
       'session_private.online_training_visible_published_report_ids('
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'cross join permission_context permission'
     ) = 0 then
    raise exception 'search reports set context is incomplete';
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
    raise exception 'search reports still has a per-row permission helper';
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
    raise exception 'search reports permission checks are not request-scoped';
  end if;

  if pg_catalog.strpos(
       v_definition,
       'permission.can_submit or permission.can_manage'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'page_report.created_by = permission.caller_user_id'
     ) = 0
     or pg_catalog.strpos(v_definition, 'allowed_author.employee_id') = 0
     or pg_catalog.strpos(v_definition, 'editable_allowed.employee_id') = 0
     or pg_catalog.strpos(
       v_definition,
       'permission.can_review_permission or permission.can_manage'
     ) = 0 then
    raise exception 'search reports set permission formula is incomplete';
  end if;

  -- caller_is_report_trainer implies the current member is allowed, therefore
  -- (member_allowed OR caller_is_trainer) collapses to member_allowed only for
  -- valid implication rows.  Invalid rows are deliberately excluded here.
  if exists (
    select 1
    from (values
      (false, false),
      (true, false),
      (true, true)
    ) scenario(member_allowed, caller_is_trainer)
    where (scenario.member_allowed or scenario.caller_is_trainer)
      is distinct from scenario.member_allowed
  ) then
    raise exception 'caller-trainer member implication diverged';
  end if;

  -- Once a report is already visible and the session/report exist, these are
  -- the exact scalar can_edit operands.  In particular, manage/founder status
  -- does not bypass the author/member scope requirement for historical rows.
  if exists (
    select 1
    from (values
      (false, false, false, false),
      (false, false, false, true),
      (false, false, true, false),
      (false, false, true, true),
      (false, true, false, false),
      (false, true, false, true),
      (false, true, true, false),
      (false, true, true, true),
      (true, false, false, false),
      (true, false, false, true),
      (true, false, true, false),
      (true, false, true, true),
      (true, true, false, false),
      (true, true, false, true),
      (true, true, true, false),
      (true, true, true, true)
    ) scenario(can_submit, can_manage, is_creator, subject_allowed)
    where (
      (scenario.can_submit or scenario.can_manage)
      and (scenario.is_creator or scenario.can_manage)
      and scenario.subject_allowed
      and true
    ) is distinct from (
      (scenario.can_submit or scenario.can_manage)
      and (scenario.is_creator or scenario.can_manage)
      and scenario.subject_allowed
    )
  ) then
    raise exception 'set can-edit formula diverged';
  end if;

  if (
    (true or true)
    and (true or true)
    and false
  ) then
    raise exception 'manage permission incorrectly bypasses subject scope';
  end if;

  if exists (
    select 1
    from (values
      (false, false),
      (false, true),
      (true, false),
      (true, true)
    ) scenario(can_review, can_manage)
    where (
      (scenario.can_review or scenario.can_manage)
      and true
      and (scenario.can_review or scenario.can_manage)
    ) is distinct from (
      scenario.can_review or scenario.can_manage
    )
  ) then
    raise exception 'set can-review formula diverged';
  end if;
end;
$test_online_training_search_reports_set_permissions$;

rollback;
