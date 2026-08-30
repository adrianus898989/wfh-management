begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- The filter datalists still need every authorized team / group / manager
-- mapping, but the visible organization section is a ranking. Returning all
-- 872 manager metrics duplicated the complete manager options and made the
-- default payload exceed 1 MB. Rank the computed metrics once, then emit only
-- the requested top rows for the high-cardinality group and manager rankings.
do $bound_management_risk_rankings$
declare
  v_signature regprocedure :=
    'public.admin_employee_management_risk(date,date,jsonb,integer)'::regprocedure;
  v_definition text;
  v_old_metrics text := $old$
  ), organization_metrics as materialized (
    select
      metric.*,
      attendance_private.management_risk_score(
        metric.employees,metric.error_events,metric.graded_exams,metric.exam_failures,
        metric.attendance_issues,metric.deductions
      ) risk_score,
      attendance_private.management_risk_sample_flags(
        metric.employees,metric.graded_exams,metric.negative_events
      ) sample_flags
    from organization_metrics_base metric
  ), option_teams as materialized ($old$;
  v_new_metrics text := $new$
  ), organization_metrics as materialized (
    select
      scored.*,
      row_number() over(
        partition by scored.dimension
        order by scored.risk_score desc,scored.negative_events desc,
          scored.team_name,scored.group_name,scored.manager_role,scored.manager_name
      )::integer organization_rank
    from (
      select
        metric.*,
        attendance_private.management_risk_score(
          metric.employees,metric.error_events,metric.graded_exams,metric.exam_failures,
          metric.attendance_issues,metric.deductions
        ) risk_score,
        attendance_private.management_risk_sample_flags(
          metric.employees,metric.graded_exams,metric.negative_events
        ) sample_flags
      from organization_metrics_base metric
    ) scored
  ), option_teams as materialized ($new$;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;

  if position('organization_rank' in v_definition)=0 then
    if position(v_old_metrics in v_definition)=0 then
      raise exception 'management_risk_metrics_shape_changed';
    end if;
    v_definition:=replace(v_definition,v_old_metrics,v_new_metrics);
  end if;

  if position(
    'from organization_metrics metric where metric.dimension=''group'' and metric.organization_rank<=v_top_limit'
    in v_definition
  )=0 then
    if position(
      'from organization_metrics metric where metric.dimension=''group'''
      in v_definition
    )=0 then
      raise exception 'management_risk_group_ranking_shape_changed';
    end if;
    v_definition:=replace(
      v_definition,
      'from organization_metrics metric where metric.dimension=''group''',
      'from organization_metrics metric where metric.dimension=''group'' and metric.organization_rank<=v_top_limit'
    );
  end if;

  if position(
    'from organization_metrics metric where metric.dimension=''manager'' and metric.organization_rank<=v_top_limit'
    in v_definition
  )=0 then
    if position(
      'from organization_metrics metric where metric.dimension=''manager'''
      in v_definition
    )=0 then
      raise exception 'management_risk_manager_ranking_shape_changed';
    end if;
    v_definition:=replace(
      v_definition,
      'from organization_metrics metric where metric.dimension=''manager''',
      'from organization_metrics metric where metric.dimension=''manager'' and metric.organization_rank<=v_top_limit'
    );
  end if;

  execute v_definition;

  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if position('organization_rank' in v_definition)=0
     or position(
       'metric.dimension=''group'' and metric.organization_rank<=v_top_limit'
       in v_definition
     )=0
     or position(
       'metric.dimension=''manager'' and metric.organization_rank<=v_top_limit'
       in v_definition
     )=0
     or position('option_groups as materialized' in v_definition)=0
     or position('option_managers as materialized' in v_definition)=0 then
    raise exception 'management_risk_ranking_bound_incomplete';
  end if;
end;
$bound_management_risk_rankings$;

comment on function public.admin_employee_management_risk(date,date,jsonb,integer) is
  'Sensitive bounded management-risk analysis. Complete authorized filter options are retained, while high-cardinality group and manager ranking payloads honor p_top_limit.';

notify pgrst,'reload schema';

commit;
