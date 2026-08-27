begin;

-- This is intentionally sensitive and receives no default role grant. Founder
-- access remains implicit through public.has_permission().
insert into public.permissions(code,name,category,sensitive)
values(
  'employee.management_risk.view',
  '人员分析 · 查看管理风险分析',
  'employee',
  true
)
on conflict(code) do update
set name=excluded.name,
    category=excluded.category,
    sensitive=excluded.sensitive;

-- Date-first event lookups keep the bounded (maximum 366 day) analysis from
-- scanning complete source histories. Organization fields are never indexed
-- here because they come only from the current authoritative roster snapshot.
create index if not exists report_employee_error_rows_risk_date_employee_idx
  on public.report_employee_error_rows(
    qc_date desc,
    public.employee_master_normalize_id(employee_no)
  )
  where qc_date is not null;

create index if not exists exam_sessions_risk_graded_date_employee_idx
  on public.exam_sessions(
    (coalesce(graded_at,submitted_at,started_at)),
    employee_id
  )
  where status='graded';

create index if not exists legacy_exam_sessions_risk_graded_date_employee_idx
  on public.legacy_exam_sessions(
    (coalesce(graded_at,submitted_at,started_at)),
    employee_id
  )
  where status='graded';

create index if not exists employee_attendance_risk_attendance_date_employee_idx
  on public.employee_attendance_records(
    event_date desc,
    employee_id,
    event_kind
  )
  where employee_id is not null
    and kind='attendance'
    and event_kind in ('absence','half_day')
    and coalesce(is_mirror,false)=false;

create index if not exists employee_attendance_risk_adjustment_date_employee_idx
  on public.employee_attendance_records(
    event_date desc,
    employee_id
  )
  where employee_id is not null
    and kind='adjustment'
    and coalesce(is_mirror,false)=false;

-- The score is an explainable signal only. It normalizes three event families
-- by current roster headcount and exam failures by graded attempts:
--   errors:     max 30 points, capped at 3 errors per employee
--   exams:      max 25 points, graded-exam failure rate
--   attendance: max 25 points, capped at 2 issues per employee
--   deductions: max 20 points, capped at 2 deductions per employee
create or replace function attendance_private.management_risk_score(
  p_employees integer,
  p_errors integer,
  p_exam_attempts integer,
  p_exam_failures integer,
  p_attendance_issues integer,
  p_deductions integer
)
returns numeric
language sql
immutable
parallel safe
set search_path=''
as $$
  select case when coalesce(p_employees,0)<=0 then 0::numeric else round(
    least(30::numeric,coalesce(p_errors,0)::numeric*10/p_employees)
    + case when coalesce(p_exam_attempts,0)>0
        then least(25::numeric,coalesce(p_exam_failures,0)::numeric*25/p_exam_attempts)
        else 0::numeric end
    + least(25::numeric,coalesce(p_attendance_issues,0)::numeric*12.5/p_employees)
    + least(20::numeric,coalesce(p_deductions,0)::numeric*10/p_employees),
    1
  ) end;
$$;

create or replace function attendance_private.management_risk_sample_flags(
  p_employees integer,
  p_exam_attempts integer,
  p_negative_events integer
)
returns jsonb
language sql
immutable
parallel safe
set search_path=''
as $$
  select coalesce(jsonb_agg(flag order by flag),'[]'::jsonb)
  from (
    values
      (case when coalesce(p_employees,0)<5 then 'low_headcount' end),
      (case when coalesce(p_exam_attempts,0) between 1 and 4 then 'low_exam_sample' end),
      (case when coalesce(p_negative_events,0) between 1 and 4 then 'low_event_sample' end)
  ) flags(flag)
  where flag is not null;
$$;

revoke all on function attendance_private.management_risk_score(integer,integer,integer,integer,integer,integer)
  from public,anon,authenticated;
revoke all on function attendance_private.management_risk_sample_flags(integer,integer,integer)
  from public,anon,authenticated;

create or replace function public.admin_employee_management_risk(
  p_date_from date default null,
  p_date_to date default null,
  p_filters jsonb default '{}'::jsonb,
  p_top_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid:=(select auth.uid());
  v_today date:=(pg_catalog.now() at time zone 'Asia/Manila')::date;
  v_date_to date;
  v_date_from date;
  v_scope text;
  v_current_employee uuid;
  v_current_employee_no text;
  v_all boolean:=false;
  v_team text;
  v_group text;
  v_manager text;
  v_manager_role text;
  v_employee_search text;
  v_top_limit integer:=least(100,greatest(5,coalesce(p_top_limit,20)));
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('employee.management_risk.view') then
    raise exception 'permission_denied';
  end if;
  if p_filters is not null and pg_catalog.jsonb_typeof(p_filters)<>'object' then
    raise exception 'invalid_filters';
  end if;

  v_date_to:=coalesce(p_date_to,v_today);
  v_date_from:=coalesce(p_date_from,v_date_to-29);
  if v_date_from>v_date_to or v_date_to-v_date_from>365 then
    raise exception 'invalid_date_range';
  end if;

  v_team:=pg_catalog.left(pg_catalog.btrim(coalesce(p_filters->>'team','')),100);
  v_group:=pg_catalog.left(pg_catalog.btrim(coalesce(p_filters->>'group','')),100);
  v_manager:=pg_catalog.left(pg_catalog.btrim(coalesce(p_filters->>'manager','')),100);
  v_manager_role:=pg_catalog.lower(pg_catalog.left(
    pg_catalog.btrim(coalesce(p_filters->>'manager_role','')),40
  ));
  v_employee_search:=pg_catalog.lower(pg_catalog.left(
    pg_catalog.btrim(coalesce(p_filters->>'employee_search','')),100
  ));
  if v_manager_role<>'' and v_manager_role not in (
    'responsible','onsite_trainer','online_leader','online_trainer'
  ) then
    raise exception 'invalid_manager_role';
  end if;

  select access.data_scope,access.employee_id,employee.employee_no
  into v_scope,v_current_employee,v_current_employee_no
  from public.user_access access
  left join public.employees employee on employee.id=access.employee_id
  where access.auth_user_id=v_user_id
    and access.active=true
    and access.backend_enabled=true
  order by access.updated_at desc
  limit 1;
  if v_scope is null then raise exception 'permission_denied'; end if;
  v_all:=public.is_founder() or v_scope='all';

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
      or roster.employee_id=v_current_employee
      or (
        v_scope='own_team'
        and exists(
          select 1 from caller_roster caller
          where pg_catalog.lower(pg_catalog.btrim(caller.team_name))
               =pg_catalog.lower(pg_catalog.btrim(roster.team_name))
        )
      )
      or (
        v_scope='assigned_teams'
        and (
          exists(
            select 1 from public.user_scope_employees scoped_employee
            where scoped_employee.auth_user_id=v_user_id
              and scoped_employee.employee_id=roster.employee_id
          )
          or exists(
            select 1 from public.user_scope_teams scoped_team
            where scoped_team.auth_user_id=v_user_id
              and scoped_team.team_id=roster.roster_team_id
          )
        )
      )
  ), filtered_roster as materialized (
    select roster.*
    from authorized_roster roster
    where (
        v_team=''
        or pg_catalog.lower(coalesce(
          nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队'
        ))=pg_catalog.lower(v_team)
      )
      and (
        v_group=''
        or pg_catalog.lower(coalesce(
          nullif(pg_catalog.btrim(roster.group_name),''),'未分组'
        ))=pg_catalog.lower(v_group)
      )
      and (
        v_employee_search=''
        or pg_catalog.lower(coalesce(roster.employee_no,'')) like '%'||v_employee_search||'%'
        or pg_catalog.lower(coalesce(roster.full_name,'')) like '%'||v_employee_search||'%'
      )
      and (
        (v_manager='' and v_manager_role='')
        or case v_manager_role
          when 'responsible' then
            nullif(pg_catalog.btrim(roster.responsible),'') is not null
            and (v_manager='' or pg_catalog.lower(pg_catalog.btrim(roster.responsible))=pg_catalog.lower(v_manager))
          when 'onsite_trainer' then
            nullif(pg_catalog.btrim(roster.onsite_trainer),'') is not null
            and (v_manager='' or pg_catalog.lower(pg_catalog.btrim(roster.onsite_trainer))=pg_catalog.lower(v_manager))
          when 'online_leader' then
            nullif(pg_catalog.btrim(roster.online_leader),'') is not null
            and (v_manager='' or pg_catalog.lower(pg_catalog.btrim(roster.online_leader))=pg_catalog.lower(v_manager))
          when 'online_trainer' then
            nullif(pg_catalog.btrim(roster.online_trainer),'') is not null
            and (v_manager='' or pg_catalog.lower(pg_catalog.btrim(roster.online_trainer))=pg_catalog.lower(v_manager))
          else v_manager<>'' and (
            pg_catalog.lower(pg_catalog.btrim(coalesce(roster.responsible,'')))=pg_catalog.lower(v_manager)
            or pg_catalog.lower(pg_catalog.btrim(coalesce(roster.onsite_trainer,'')))=pg_catalog.lower(v_manager)
            or pg_catalog.lower(pg_catalog.btrim(coalesce(roster.online_leader,'')))=pg_catalog.lower(v_manager)
            or pg_catalog.lower(pg_catalog.btrim(coalesce(roster.online_trainer,'')))=pg_catalog.lower(v_manager)
          )
        end
      )
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
  ), current_exam_events as materialized (
    select
      'exam_current:'||session.id::text event_key,
      roster.identity_key,
      roster.employee_id,
      (coalesce(session.graded_at,session.submitted_at,session.started_at)
        at time zone 'Asia/Manila')::date event_date,
      'exam'::text event_class,
      'exam_assignment:'||assignment.id::text issue_code,
      pg_catalog.left(coalesce(nullif(pg_catalog.btrim(assignment.title),''),'未命名考试'),200) issue_label,
      not session.passed is_negative
    from public.exam_sessions session
    join filtered_roster roster on roster.employee_id=session.employee_id
    join public.exam_assignments assignment on assignment.id=session.assignment_id
    where session.status='graded'
      and session.passed is not null
      and coalesce(session.graded_at,session.submitted_at,session.started_at)
        >=(v_date_from::timestamp at time zone 'Asia/Manila')
      and coalesce(session.graded_at,session.submitted_at,session.started_at)
        <((v_date_to+1)::timestamp at time zone 'Asia/Manila')
  ), legacy_exam_mapped as materialized (
    select
      session.*,
      coalesce(session.employee_id,employee.id) resolved_employee_id
    from public.legacy_exam_sessions session
    left join public.employees employee
      on session.employee_id is null
     and public.employee_master_normalize_id(employee.employee_no)
       =public.employee_master_normalize_id(session.employee_no)
    where session.status='graded'
      and session.passed is not null
      and coalesce(session.graded_at,session.submitted_at,session.started_at)
        >=(v_date_from::timestamp at time zone 'Asia/Manila')
      and coalesce(session.graded_at,session.submitted_at,session.started_at)
        <((v_date_to+1)::timestamp at time zone 'Asia/Manila')
  ), legacy_exam_events as materialized (
    select
      'exam_legacy:'||session.id::text event_key,
      roster.identity_key,
      roster.employee_id,
      (coalesce(session.graded_at,session.submitted_at,session.started_at)
        at time zone 'Asia/Manila')::date event_date,
      'exam'::text event_class,
      'legacy_exam:'||pg_catalog.md5(coalesce(session.series_name,'')||'|'||coalesce(session.position_name,'')) issue_code,
      pg_catalog.left(coalesce(nullif(pg_catalog.btrim(pg_catalog.concat_ws(
        ' · ',session.series_name,session.position_name
      )),''),'旧系统考试'),200) issue_label,
      not session.passed is_negative
    from legacy_exam_mapped session
    join filtered_roster roster on roster.employee_id=session.resolved_employee_id
  ), attendance_events as materialized (
    select
      'attendance:'||record.id::text event_key,
      roster.identity_key,
      roster.employee_id,
      record.event_date,
      'attendance'::text event_class,
      coalesce(nullif(pg_catalog.btrim(record.event_kind),''),'attendance_issue') issue_code,
      case record.event_kind
        when 'absence' then '缺勤'
        when 'half_day' then '半天出勤'
        else '出勤异常'
      end issue_label,
      true is_negative
    from public.employee_attendance_records record
    join filtered_roster roster on roster.employee_id=record.employee_id
    where record.kind='attendance'
      and record.event_kind in ('absence','half_day')
      and record.event_date between v_date_from and v_date_to
      and coalesce(record.is_mirror,false)=false
  ), adjustment_events as materialized (
    select
      'adjustment:'||record.id::text event_key,
      roster.identity_key,
      roster.employee_id,
      record.event_date,
      case
        when record.event_kind='bonus' or record.amount>0 then 'bonus'
        when record.event_kind='deduction' or record.amount<0 then 'deduction'
        else 'adjustment_other'
      end event_class,
      coalesce(nullif(pg_catalog.btrim(record.event_kind),''),'adjustment') issue_code,
      pg_catalog.left(coalesce(
        nullif(pg_catalog.btrim(record.reason),''),
        case
          when record.event_kind='bonus' or record.amount>0 then '奖励'
          when record.event_kind='deduction' or record.amount<0 then '扣款'
          else '其他奖惩'
        end
      ),200) issue_label,
      (record.event_kind='deduction' or record.amount<0) is_negative
    from public.employee_attendance_records record
    join filtered_roster roster on roster.employee_id=record.employee_id
    where record.kind='adjustment'
      and record.event_date between v_date_from and v_date_to
      and coalesce(record.is_mirror,false)=false
  ), events as materialized (
    select * from error_events
    union all select * from current_exam_events
    union all select * from legacy_exam_events
    union all select * from attendance_events
    union all select * from adjustment_events
  ), employee_metrics_base as materialized (
    select
      roster.identity_key,
      roster.employee_id,
      roster.employee_no,
      roster.full_name,
      roster.team_name,
      roster.group_name,
      roster.position_name,
      roster.responsible,
      roster.onsite_trainer,
      roster.online_leader,
      roster.online_trainer,
      count(event.event_key)::integer sample_count,
      count(event.event_key) filter(where event.event_class='error')::integer error_events,
      count(event.event_key) filter(where event.event_class='exam')::integer graded_exams,
      count(event.event_key) filter(where event.event_class='exam' and event.is_negative)::integer exam_failures,
      count(event.event_key) filter(where event.event_class='attendance')::integer attendance_issues,
      count(event.event_key) filter(where event.event_class='deduction')::integer deductions,
      count(event.event_key) filter(where event.event_class='bonus')::integer bonuses,
      count(event.event_key) filter(where event.event_class='adjustment_other')::integer other_adjustments,
      count(event.event_key) filter(where event.is_negative)::integer negative_events,
      count(distinct event.event_date) filter(where event.is_negative)::integer issue_days
    from filtered_roster roster
    left join events event on event.identity_key=roster.identity_key
    group by roster.identity_key,roster.employee_id,roster.employee_no,
      roster.full_name,roster.team_name,roster.group_name,roster.position_name,
      roster.responsible,roster.onsite_trainer,roster.online_leader,roster.online_trainer
  ), employee_primary_issue as materialized (
    select ranked.identity_key,ranked.event_class,ranked.issue_label,ranked.event_count
    from (
      select
        event.identity_key,
        event.event_class,
        event.issue_label,
        count(*)::integer event_count,
        row_number() over(
          partition by event.identity_key
          order by count(*) desc,event.event_class,event.issue_label
        ) issue_rank
      from events event
      where event.is_negative
      group by event.identity_key,event.event_class,event.issue_label
    ) ranked
    where ranked.issue_rank=1
  ), employee_metrics as materialized (
    select
      metric.*,
      attendance_private.management_risk_score(
        1,metric.error_events,metric.graded_exams,metric.exam_failures,
        metric.attendance_issues,metric.deductions
      ) risk_score,
      primary_issue.event_class primary_issue_class,
      primary_issue.issue_label primary_issue,
      coalesce(primary_issue.event_count,0) primary_issue_count
    from employee_metrics_base metric
    left join employee_primary_issue primary_issue using(identity_key)
  ), summary_metrics as materialized (
    select
      count(*)::integer employees,
      count(*) filter(where metric.employee_id is not null)::integer matched_employees,
      count(*) filter(where metric.sample_count>0)::integer observed_employees,
      count(*) filter(where metric.negative_events>0)::integer affected_employees,
      count(*) filter(where metric.negative_events>=2 and metric.issue_days>=2)::integer repeat_employees,
      coalesce(sum(metric.sample_count),0)::integer sample_count,
      coalesce(sum(metric.error_events),0)::integer error_events,
      coalesce(sum(metric.graded_exams),0)::integer graded_exams,
      coalesce(sum(metric.exam_failures),0)::integer exam_failures,
      coalesce(sum(metric.attendance_issues),0)::integer attendance_issues,
      coalesce(sum(metric.deductions),0)::integer deductions,
      coalesce(sum(metric.bonuses),0)::integer bonuses,
      coalesce(sum(metric.other_adjustments),0)::integer other_adjustments,
      coalesce(sum(metric.negative_events),0)::integer negative_events,
      (select count(distinct event.event_date)::integer
       from events event where event.is_negative) issue_days
    from employee_metrics metric
  ), organization_memberships as materialized (
    select
      'team'::text dimension,
      coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队') dimension_key,
      coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队') team_name,
      null::text group_name,
      null::text manager_role,
      null::text manager_name,
      roster.identity_key
    from filtered_roster roster

    union all

    select
      'group'::text,
      coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队')||'|'||
        coalesce(nullif(pg_catalog.btrim(roster.group_name),''),'未分组'),
      coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队'),
      coalesce(nullif(pg_catalog.btrim(roster.group_name),''),'未分组'),
      null::text,
      null::text,
      roster.identity_key
    from filtered_roster roster

    union all

    select
      'manager'::text,
      coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队')||'|'||
        manager.manager_role||'|'||manager.manager_name,
      coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队'),
      nullif(pg_catalog.btrim(roster.group_name),''),
      manager.manager_role,
      manager.manager_name,
      roster.identity_key
    from filtered_roster roster
    cross join lateral(values
      ('responsible'::text,nullif(pg_catalog.btrim(roster.responsible),'')),
      ('onsite_trainer'::text,nullif(pg_catalog.btrim(roster.onsite_trainer),'')),
      ('online_leader'::text,nullif(pg_catalog.btrim(roster.online_leader),'')),
      ('online_trainer'::text,nullif(pg_catalog.btrim(roster.online_trainer),''))
    ) manager(manager_role,manager_name)
    where manager.manager_name is not null
      and (v_manager_role='' or manager.manager_role=v_manager_role)
      and (v_manager='' or pg_catalog.lower(manager.manager_name)=pg_catalog.lower(v_manager))
  ), organization_metrics_base as materialized (
    select
      membership.dimension,
      membership.dimension_key,
      membership.team_name,
      membership.group_name,
      membership.manager_role,
      membership.manager_name,
      count(*)::integer employees,
      count(*) filter(where metric.employee_id is not null)::integer matched_employees,
      count(*) filter(where metric.sample_count>0)::integer observed_employees,
      count(*) filter(where metric.negative_events>0)::integer affected_employees,
      coalesce(sum(metric.sample_count),0)::integer sample_count,
      coalesce(sum(metric.error_events),0)::integer error_events,
      coalesce(sum(metric.graded_exams),0)::integer graded_exams,
      coalesce(sum(metric.exam_failures),0)::integer exam_failures,
      coalesce(sum(metric.attendance_issues),0)::integer attendance_issues,
      coalesce(sum(metric.deductions),0)::integer deductions,
      coalesce(sum(metric.bonuses),0)::integer bonuses,
      coalesce(sum(metric.other_adjustments),0)::integer other_adjustments,
      coalesce(sum(metric.negative_events),0)::integer negative_events,
      coalesce(sum(metric.issue_days),0)::integer employee_issue_days
    from organization_memberships membership
    join employee_metrics metric on metric.identity_key=membership.identity_key
    group by membership.dimension,membership.dimension_key,membership.team_name,
      membership.group_name,membership.manager_role,membership.manager_name
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
  ), option_teams as materialized (
    select
      coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队') team_name,
      count(*)::integer employees
    from authorized_roster roster
    group by coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队')
  ), option_groups as materialized (
    select
      coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队') team_name,
      coalesce(nullif(pg_catalog.btrim(roster.group_name),''),'未分组') group_name,
      count(*)::integer employees
    from authorized_roster roster
    group by coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队'),
      coalesce(nullif(pg_catalog.btrim(roster.group_name),''),'未分组')
  ), option_managers as materialized (
    select
      coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队') team_name,
      nullif(pg_catalog.btrim(roster.group_name),'') group_name,
      manager.manager_role,
      manager.manager_name,
      count(*)::integer employees
    from authorized_roster roster
    cross join lateral(values
      ('responsible'::text,nullif(pg_catalog.btrim(roster.responsible),'')),
      ('onsite_trainer'::text,nullif(pg_catalog.btrim(roster.onsite_trainer),'')),
      ('online_leader'::text,nullif(pg_catalog.btrim(roster.online_leader),'')),
      ('online_trainer'::text,nullif(pg_catalog.btrim(roster.online_trainer),''))
    ) manager(manager_role,manager_name)
    where manager.manager_name is not null
    group by coalesce(nullif(pg_catalog.btrim(roster.team_name),''),'未分配团队'),
      nullif(pg_catalog.btrim(roster.group_name),''),
      manager.manager_role,manager.manager_name
  ), common_issues as materialized (
    select
      event.event_class,
      event.issue_code,
      event.issue_label,
      count(*)::integer event_count,
      count(distinct event.identity_key)::integer affected_employees,
      count(distinct event.event_date)::integer active_days
    from events event
    where event.is_negative
    group by event.event_class,event.issue_code,event.issue_label
  ), daily_series as materialized (
    select day::date event_date
    from pg_catalog.generate_series(v_date_from,v_date_to,interval '1 day') day
  ), daily_metrics as materialized (
    select
      series.event_date,
      count(event.event_key)::integer sample_count,
      count(event.event_key) filter(where event.event_class='error')::integer error_events,
      count(event.event_key) filter(where event.event_class='exam')::integer graded_exams,
      count(event.event_key) filter(where event.event_class='exam' and event.is_negative)::integer exam_failures,
      count(event.event_key) filter(where event.event_class='attendance')::integer attendance_issues,
      count(event.event_key) filter(where event.event_class='deduction')::integer deductions,
      count(event.event_key) filter(where event.event_class='bonus')::integer bonuses,
      count(event.event_key) filter(where event.is_negative)::integer negative_events
    from daily_series series
    left join events event on event.event_date=series.event_date
    group by series.event_date
  ), weekly_series as materialized (
    select week_start::date week_start
    from pg_catalog.generate_series(
      pg_catalog.date_trunc('week',v_date_from::timestamp),
      pg_catalog.date_trunc('week',v_date_to::timestamp),
      interval '1 week'
    ) week_start
  ), weekly_metrics as materialized (
    select
      series.week_start,
      least(series.week_start+6,v_date_to) week_end,
      count(event.event_key)::integer sample_count,
      count(event.event_key) filter(where event.event_class='error')::integer error_events,
      count(event.event_key) filter(where event.event_class='exam')::integer graded_exams,
      count(event.event_key) filter(where event.event_class='exam' and event.is_negative)::integer exam_failures,
      count(event.event_key) filter(where event.event_class='attendance')::integer attendance_issues,
      count(event.event_key) filter(where event.event_class='deduction')::integer deductions,
      count(event.event_key) filter(where event.event_class='bonus')::integer bonuses,
      count(event.event_key) filter(where event.is_negative)::integer negative_events
    from weekly_series series
    left join events event
      on event.event_date between series.week_start and least(series.week_start+6,v_date_to)
    group by series.week_start
  )
  select pg_catalog.jsonb_build_object(
    'generated_at',pg_catalog.now(),
    'period',pg_catalog.jsonb_build_object(
      'from',v_date_from,
      'to',v_date_to,
      'days',v_date_to-v_date_from+1,
      'timezone','Asia/Manila'
    ),
    'filters',pg_catalog.jsonb_build_object(
      'team',nullif(v_team,''),
      'group',nullif(v_group,''),
      'manager',nullif(v_manager,''),
      'manager_role',nullif(v_manager_role,''),
      'employee_search',nullif(v_employee_search,''),
      'top_limit',v_top_limit
    ),
    'scope',pg_catalog.jsonb_build_object(
      'data_scope',v_scope,
      'authorized_roster_employees',(select count(*) from authorized_roster),
      'filtered_roster_employees',(select count(*) from filtered_roster),
      'roster_employees',(select count(*) from filtered_roster),
      'matched_employees',(select count(*) from filtered_roster where employee_id is not null),
      'unmatched_roster_rows',(select count(*) from filtered_roster where employee_id is null),
      'roster_refreshed_at',(select max(refreshed_at) from authorized_roster)
    ),
    'options',pg_catalog.jsonb_build_object(
      'teams',coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',option.team_name,'team_name',option.team_name,'employees',option.employees
        ) order by option.team_name)
        from option_teams option
      ),'[]'::jsonb),
      'groups',coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',option.group_name,'team_name',option.team_name,
          'group_name',option.group_name,'employees',option.employees
        ) order by option.team_name,option.group_name)
        from option_groups option
      ),'[]'::jsonb),
      'managers',coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',option.manager_name,'team_name',option.team_name,'group_name',option.group_name,
          'manager_role',option.manager_role,'manager_name',option.manager_name,
          'employees',option.employees
        ) order by option.team_name,option.manager_role,option.manager_name,option.group_name)
        from option_managers option
      ),'[]'::jsonb)
    ),
    'methodology',pg_catalog.jsonb_build_object(
      'organization_source','attendance_private.current_schedule_roster',
      'organization_basis','current_authoritative_home_schedule_only',
      'event_sources',pg_catalog.jsonb_build_array(
        'report_employee_error_rows','exam_sessions','legacy_exam_sessions','employee_attendance_records'
      ),
      'attendance_issue_types',pg_catalog.jsonb_build_array('absence','half_day'),
      'score_formula',pg_catalog.jsonb_build_object(
        'error_points','min(30, errors_per_employee × 10)',
        'exam_points','min(25, graded_exam_failure_rate × 25)',
        'attendance_points','min(25, attendance_issues_per_employee × 12.5)',
        'deduction_points','min(20, deductions_per_employee × 10)',
        'maximum',100
      ),
      'minimum_sample_rules',pg_catalog.jsonb_build_object(
        'headcount_warning_below',5,
        'exam_warning_below_attempts',5,
        'event_warning_for_positive_events_below',5
      ),
      'min_sample_rules',pg_catalog.jsonb_build_object(
        'headcount_warning_below',5,
        'exam_warning_below_attempts',5,
        'event_warning_for_positive_events_below',5
      ),
      'repeat_employee_rule','at least 2 negative events across at least 2 distinct dates',
      'currency_notice','奖励与扣款只统计笔数；不同币种不会合并金额',
      'causality_notice','风险分仅是需要复核的相关信号，不证明管理不善或因果关系'
    ),
    'summary',(
      select pg_catalog.jsonb_build_object(
        'employees',summary.employees,
        'matched_employees',summary.matched_employees,
        'observed_employees',summary.observed_employees,
        'affected_employees',summary.affected_employees,
        'at_risk_employees',summary.affected_employees,
        'repeat_employees',summary.repeat_employees,
        'sample_count',summary.sample_count,
        'error_events',summary.error_events,
        'error_rate_per_100',round(summary.error_events::numeric*100/greatest(summary.employees,1),2),
        'graded_exams',summary.graded_exams,
        'exam_failures',summary.exam_failures,
        'exam_failure_rate_pct',round(summary.exam_failures::numeric*100/greatest(summary.graded_exams,1),2),
        'attendance_issues',summary.attendance_issues,
        'attendance_rate_per_100',round(summary.attendance_issues::numeric*100/greatest(summary.employees,1),2),
        'deductions',summary.deductions,
        'deduction_rate_per_100',round(summary.deductions::numeric*100/greatest(summary.employees,1),2),
        'bonuses',summary.bonuses,
        'bonus_rate_per_100',round(summary.bonuses::numeric*100/greatest(summary.employees,1),2),
        'other_adjustments',summary.other_adjustments,
        'negative_events',summary.negative_events,
        'issue_days',summary.issue_days,
        'risk_score',attendance_private.management_risk_score(
          summary.employees,summary.error_events,summary.graded_exams,summary.exam_failures,
          summary.attendance_issues,summary.deductions
        ),
        'sample_flags',attendance_private.management_risk_sample_flags(
          summary.employees,summary.graded_exams,summary.negative_events
        )
      ) from summary_metrics summary
    ),
    'organization',pg_catalog.jsonb_build_object(
      'teams',coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'team_name',metric.team_name,
          'employees',metric.employees,
          'matched_employees',metric.matched_employees,
          'observed_employees',metric.observed_employees,
          'affected_employees',metric.affected_employees,
          'sample_count',metric.sample_count,
          'error_events',metric.error_events,
          'error_rate_per_100',round(metric.error_events::numeric*100/greatest(metric.employees,1),2),
          'graded_exams',metric.graded_exams,
          'exam_failures',metric.exam_failures,
          'exam_failure_rate_pct',round(metric.exam_failures::numeric*100/greatest(metric.graded_exams,1),2),
          'attendance_issues',metric.attendance_issues,
          'attendance_rate_per_100',round(metric.attendance_issues::numeric*100/greatest(metric.employees,1),2),
          'deductions',metric.deductions,
          'deduction_rate_per_100',round(metric.deductions::numeric*100/greatest(metric.employees,1),2),
          'bonuses',metric.bonuses,
          'other_adjustments',metric.other_adjustments,
          'negative_events',metric.negative_events,
          'negative_rate_per_100',round(metric.negative_events::numeric*100/greatest(metric.employees,1),2),
          'risk_score',metric.risk_score,
          'risk_band',case when metric.risk_score>=70 then 'critical'
            when metric.risk_score>=45 then 'high'
            when metric.risk_score>=20 then 'attention' else 'stable' end,
          'sample_flags',metric.sample_flags
        ) order by metric.risk_score desc,metric.negative_events desc,metric.team_name)
        from organization_metrics metric where metric.dimension='team'
      ),'[]'::jsonb),
      'groups',coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'team_name',metric.team_name,'group_name',metric.group_name,
          'employees',metric.employees,'matched_employees',metric.matched_employees,
          'observed_employees',metric.observed_employees,
          'affected_employees',metric.affected_employees,'sample_count',metric.sample_count,
          'error_events',metric.error_events,
          'error_rate_per_100',round(metric.error_events::numeric*100/greatest(metric.employees,1),2),
          'graded_exams',metric.graded_exams,'exam_failures',metric.exam_failures,
          'exam_failure_rate_pct',round(metric.exam_failures::numeric*100/greatest(metric.graded_exams,1),2),
          'attendance_issues',metric.attendance_issues,
          'attendance_rate_per_100',round(metric.attendance_issues::numeric*100/greatest(metric.employees,1),2),
          'deductions',metric.deductions,
          'deduction_rate_per_100',round(metric.deductions::numeric*100/greatest(metric.employees,1),2),
          'bonuses',metric.bonuses,'other_adjustments',metric.other_adjustments,
          'negative_events',metric.negative_events,
          'negative_rate_per_100',round(metric.negative_events::numeric*100/greatest(metric.employees,1),2),
          'risk_score',metric.risk_score,
          'risk_band',case when metric.risk_score>=70 then 'critical'
            when metric.risk_score>=45 then 'high'
            when metric.risk_score>=20 then 'attention' else 'stable' end,
          'sample_flags',metric.sample_flags
        ) order by metric.risk_score desc,metric.negative_events desc,metric.team_name,metric.group_name)
        from organization_metrics metric where metric.dimension='group'
      ),'[]'::jsonb),
      'managers',coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'team_name',metric.team_name,'group_name',metric.group_name,
          'manager_role',metric.manager_role,'manager_name',metric.manager_name,
          'employees',metric.employees,'matched_employees',metric.matched_employees,
          'observed_employees',metric.observed_employees,
          'affected_employees',metric.affected_employees,'sample_count',metric.sample_count,
          'error_events',metric.error_events,
          'error_rate_per_100',round(metric.error_events::numeric*100/greatest(metric.employees,1),2),
          'graded_exams',metric.graded_exams,'exam_failures',metric.exam_failures,
          'exam_failure_rate_pct',round(metric.exam_failures::numeric*100/greatest(metric.graded_exams,1),2),
          'attendance_issues',metric.attendance_issues,
          'attendance_rate_per_100',round(metric.attendance_issues::numeric*100/greatest(metric.employees,1),2),
          'deductions',metric.deductions,
          'deduction_rate_per_100',round(metric.deductions::numeric*100/greatest(metric.employees,1),2),
          'bonuses',metric.bonuses,'other_adjustments',metric.other_adjustments,
          'negative_events',metric.negative_events,
          'negative_rate_per_100',round(metric.negative_events::numeric*100/greatest(metric.employees,1),2),
          'risk_score',metric.risk_score,
          'risk_band',case when metric.risk_score>=70 then 'critical'
            when metric.risk_score>=45 then 'high'
            when metric.risk_score>=20 then 'attention' else 'stable' end,
          'sample_flags',metric.sample_flags
        ) order by metric.risk_score desc,metric.negative_events desc,
          metric.team_name,metric.manager_role,metric.manager_name)
        from organization_metrics metric where metric.dimension='manager'
      ),'[]'::jsonb)
    ),
    'repeat_employees',coalesce((
      select pg_catalog.jsonb_agg(row.data order by row.risk_score desc,row.negative_events desc,row.employee_no)
      from (
        select
          metric.risk_score,
          metric.negative_events,
          metric.employee_no,
          pg_catalog.jsonb_build_object(
            'employee_id',metric.employee_id,
            'employee_no',metric.employee_no,
            'full_name',metric.full_name,
            'team_name',metric.team_name,
            'group_name',metric.group_name,
            'position_name',metric.position_name,
            'responsible',metric.responsible,
            'onsite_trainer',metric.onsite_trainer,
            'online_leader',metric.online_leader,
            'online_trainer',metric.online_trainer,
            'sample_count',metric.sample_count,
            'error_events',metric.error_events,
            'graded_exams',metric.graded_exams,
            'exam_failures',metric.exam_failures,
            'attendance_issues',metric.attendance_issues,
            'deductions',metric.deductions,
            'bonuses',metric.bonuses,
            'negative_events',metric.negative_events,
            'issue_days',metric.issue_days,
            'negative_events_per_30_days',round(
              metric.negative_events::numeric*30/greatest(v_date_to-v_date_from+1,1),2
            ),
            'primary_issue_class',metric.primary_issue_class,
            'primary_issue',metric.primary_issue,
            'primary_issue_count',metric.primary_issue_count,
            'risk_score',metric.risk_score,
            'repeat_flag',true,
            'sample_flags',case when metric.negative_events<5
              then pg_catalog.jsonb_build_array('low_event_sample') else '[]'::jsonb end
          ) data
        from employee_metrics metric
        where metric.employee_id is not null
          and metric.negative_events>=2
          and metric.issue_days>=2
        order by metric.risk_score desc,metric.negative_events desc,metric.employee_no
        limit v_top_limit
      ) row
    ),'[]'::jsonb),
    'common_issues',coalesce((
      select pg_catalog.jsonb_agg(row.data order by row.event_count desc,row.affected_employees desc,row.issue_label)
      from (
        select
          issue.event_count,
          issue.affected_employees,
          issue.issue_label,
          pg_catalog.jsonb_build_object(
            'event_class',issue.event_class,
            'category',issue.event_class,
            'category_label',case issue.event_class
              when 'error' then '员工错误'
              when 'exam' then '考试不及格'
              when 'attendance' then '出勤异常'
              when 'deduction' then '扣款' else '其他问题' end,
            'issue_code',issue.issue_code,
            'issue',issue.issue_label,
            'issue_label',issue.issue_label,
            'event_count',issue.event_count,
            'affected_employees',issue.affected_employees,
            'employee_count',issue.affected_employees,
            'active_days',issue.active_days,
            'rate_per_100_employees',round(
              issue.event_count::numeric*100/greatest((select employees from summary_metrics),1),2
            ),
            'share_of_negative_events_pct',round(
              issue.event_count::numeric*100/greatest((select negative_events from summary_metrics),1),2
            ),
            'sample_count',issue.event_count,
            'sample_flags',case when issue.event_count<5
              then pg_catalog.jsonb_build_array('low_event_sample') else '[]'::jsonb end
          ) data
        from common_issues issue
        order by issue.event_count desc,issue.affected_employees desc,issue.issue_label
        limit v_top_limit
      ) row
    ),'[]'::jsonb),
    'trend',pg_catalog.jsonb_build_object(
      'daily',coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'date',metric.event_date,
          'sample_count',metric.sample_count,
          'error_events',metric.error_events,
          'graded_exams',metric.graded_exams,
          'exam_failures',metric.exam_failures,
          'attendance_issues',metric.attendance_issues,
          'deductions',metric.deductions,
          'bonuses',metric.bonuses,
          'negative_events',metric.negative_events,
          'risk_score',attendance_private.management_risk_score(
            (select employees from summary_metrics),metric.error_events,metric.graded_exams,
            metric.exam_failures,metric.attendance_issues,metric.deductions
          ),
          'sample_flags',attendance_private.management_risk_sample_flags(
            (select employees from summary_metrics),metric.graded_exams,metric.negative_events
          )
        ) order by metric.event_date)
        from daily_metrics metric
      ),'[]'::jsonb),
      'weekly',coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'week_start',metric.week_start,
          'week_end',metric.week_end,
          'sample_count',metric.sample_count,
          'error_events',metric.error_events,
          'graded_exams',metric.graded_exams,
          'exam_failures',metric.exam_failures,
          'attendance_issues',metric.attendance_issues,
          'deductions',metric.deductions,
          'bonuses',metric.bonuses,
          'negative_events',metric.negative_events,
          'risk_score',attendance_private.management_risk_score(
            (select employees from summary_metrics),metric.error_events,metric.graded_exams,
            metric.exam_failures,metric.attendance_issues,metric.deductions
          ),
          'sample_flags',attendance_private.management_risk_sample_flags(
            (select employees from summary_metrics),metric.graded_exams,metric.negative_events
          )
        ) order by metric.week_start)
        from weekly_metrics metric
      ),'[]'::jsonb)
    )
  )
  into v_result
  from summary_metrics;

  return coalesce(v_result,'{}'::jsonb);
end;
$$;

comment on function public.admin_employee_management_risk(date,date,jsonb,integer) is
  'Current-session, sensitive-permission and current-roster-scope guarded management risk signals. Organization attribution always comes from attendance_private.current_schedule_roster(); scores are normalized review signals, not causal findings.';

revoke all on function public.admin_employee_management_risk(date,date,jsonb,integer)
  from public,anon,authenticated;
grant execute on function public.admin_employee_management_risk(date,date,jsonb,integer)
  to authenticated;

notify pgrst,'reload schema';

commit;
