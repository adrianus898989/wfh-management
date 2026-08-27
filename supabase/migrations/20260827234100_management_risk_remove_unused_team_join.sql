begin;

-- Scope now comes from materialized employee IDs, so the old team-name join is
-- unused. Team names are not unique and that join could duplicate roster rows
-- if a historical/disabled team shares a name with an active team.
do $remove_management_risk_team_join$
declare
  v_signature regprocedure :=
    'public.admin_employee_management_risk(date,date,jsonb,integer)'::regprocedure;
  v_definition text;
  v_old text := $old$
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
  ), authorized_employee_ids as materialized ($old$;
  v_new text := $new$
  ), roster_joined as materialized (
    select
      roster.*,
      employee.id employee_id
    from roster_source roster
    left join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no)=roster.employee_no
  ), authorized_employee_ids as materialized ($new$;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition)=0 then
    if position(v_old in v_definition)=0 then
      raise exception 'management_risk_team_join_shape_changed';
    end if;
    v_definition:=replace(v_definition,v_old,v_new);
    execute v_definition;
  end if;

  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if position('team.id roster_team_id' in v_definition)>0
     or position('left join public.teams team' in v_definition)>0
     or position('authorized_employee_ids as materialized' in v_definition)=0 then
    raise exception 'management_risk_team_join_removal_incomplete';
  end if;
end;
$remove_management_risk_team_join$;

comment on function public.admin_employee_management_risk(date,date,jsonb,integer) is
  'Sensitive bounded management-risk analysis. Scope is a set join on canonical employee IDs, canonical errors prevent duplicate inflation, and unused team-name joins cannot multiply roster rows.';

commit;
