begin;

-- Keep the reviewed report shape and permissions, but remove two amplification
-- paths: a per-roster-row security function and duplicate raw error rows.
do $optimize_management_risk$
declare
  v_signature regprocedure :=
    'public.admin_employee_management_risk(date,date,jsonb,integer)'::regprocedure;
  v_definition text;
  v_old_scope text := $old$
  with roster_source as materialized (
    select * from attendance_private.current_schedule_roster()
  ), roster_joined as materialized (
    select
      roster.*,
      employee.id employee_id,
      team.id roster_team_id
    from roster_source roster
    left join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no)=roster.employee_no
    left join public.teams team
      on pg_catalog.lower(pg_catalog.btrim(team.name))
       =pg_catalog.lower(pg_catalog.btrim(roster.team_name))
  ), caller_roster as materialized (
    select roster.team_name
    from roster_joined roster
    where roster.employee_id=v_current_employee
      or (
        roster.employee_no is not null
        and roster.employee_no=public.employee_master_normalize_id(v_current_employee_no)
      )
    order by roster.source_row desc nulls last
    limit 1
  ), authorized_roster as materialized (
    select roster.*
    from roster_joined roster
    where v_all
      or public.backend_employee_in_scope(roster.employee_id)
  ), filtered_roster$old$;
  v_new_scope text := $new$
  with roster_source as materialized (
    select * from attendance_private.current_schedule_roster()
  ), roster_joined as materialized (
    select
      roster.*,
      employee.id employee_id,
      team.id roster_team_id
    from roster_source roster
    left join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no)=roster.employee_no
    left join public.teams team
      on pg_catalog.lower(pg_catalog.btrim(team.name))
       =pg_catalog.lower(pg_catalog.btrim(roster.team_name))
  ), authorized_employee_ids as materialized (
    select v_current_employee employee_id
    where not v_all
      and v_scope='self'
      and v_current_employee is not null

    union

    select scoped_employee.employee_id
    from public.user_scope_employees scoped_employee
    where not v_all
      and v_scope in ('own_team','assigned_teams')
      and scoped_employee.auth_user_id=v_user_id
  ), authorized_roster as materialized (
    select roster.*
    from roster_joined roster
    where v_all
      or exists(
        select 1
        from authorized_employee_ids allowed
        where allowed.employee_id=roster.employee_id
      )
  ), filtered_roster$new$;
  v_old_error text := $old$
  ), error_events as materialized (
    select
      'error:'||error.source_name||':'||error.source_row::text event_key,
      roster.identity_key,
      roster.employee_id,
      error.qc_date event_date,
      'error'::text event_class,
      pg_catalog.left(coalesce(nullif(pg_catalog.btrim(error.error_type),''),'unclassified_error'),200) issue_code,
      pg_catalog.left(coalesce(nullif(pg_catalog.btrim(error.error_type),''),'未分类错误'),200) issue_label,
      true is_negative
    from public.report_employee_error_rows error
    join filtered_roster roster
      on roster.employee_no=public.employee_master_normalize_id(error.employee_no)
    where error.qc_date between v_date_from and v_date_to
  ), current_exam_events as materialized ($old$;
  v_new_error text := $new$
  ), error_events as materialized (
    select
      'error:'||error.record_key event_key,
      roster.identity_key,
      roster.employee_id,
      error.qc_date event_date,
      'error'::text event_class,
      pg_catalog.left(coalesce(nullif(pg_catalog.btrim(error.error_type),''),'unclassified_error'),200) issue_code,
      pg_catalog.left(coalesce(nullif(pg_catalog.btrim(error.error_type),''),'未分类错误'),200) issue_label,
      true is_negative
    from public.report_employee_errors_v error
    join filtered_roster roster
      on roster.employee_no=public.employee_master_normalize_id(error.employee_no)
    where error.qc_date between v_date_from and v_date_to
  ), current_exam_events as materialized ($new$;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;

  if position(v_new_scope in v_definition)=0 then
    if position(v_old_scope in v_definition)=0 then
      raise exception 'management_risk_scope_shape_changed';
    end if;
    v_definition:=replace(v_definition,v_old_scope,v_new_scope);
  end if;

  if position(v_new_error in v_definition)=0 then
    if position(v_old_error in v_definition)=0 then
      raise exception 'management_risk_error_shape_changed';
    end if;
    v_definition:=replace(v_definition,v_old_error,v_new_error);
  end if;

  v_definition:=replace(
    v_definition,
    '''report_employee_error_rows'',''exam_sessions''',
    '''report_employee_errors_v'',''exam_sessions'''
  );
  execute v_definition;

  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if position('authorized_employee_ids as materialized' in v_definition)=0
     or position('public.backend_employee_in_scope(roster.employee_id)' in v_definition)>0
     or position('from public.report_employee_error_rows error' in v_definition)>0
     or position('from public.report_employee_errors_v error' in v_definition)=0 then
    raise exception 'management_risk_optimization_incomplete';
  end if;
end;
$optimize_management_risk$;

alter function public.admin_employee_management_risk(date,date,jsonb,integer)
  set statement_timeout='6s';
alter function public.admin_employee_management_risk(date,date,jsonb,integer)
  set lock_timeout='500ms';

comment on function public.admin_employee_management_risk(date,date,jsonb,integer) is
  'Sensitive management-risk analysis. Scope IDs are materialized once, canonical error rows prevent duplicate inflation, and runtime is bounded so it cannot consume the login connection budget.';

notify pgrst,'reload schema';

commit;
