begin;

-- The people view is a roster view, not a report-members view.  Start with
-- employees who are currently assigned to an online trainer in the private
-- schedule snapshot, then LEFT JOIN the reports recorded in the requested
-- period.  Historical report members remain candidates so older periods keep
-- working even after the live roster changes.
create or replace function public.online_training_search_people(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no', '')));
  v_employee_name text := lower(btrim(coalesce(p_filters->>'employee_name', '')));
  v_trainer text := lower(btrim(coalesce(p_filters->>'trainer', '')));
  v_keyword text := lower(btrim(coalesce(p_filters->>'keyword', '')));
  v_team text := lower(btrim(coalesce(p_filters->>'team', '')));
  v_group text := lower(btrim(coalesce(p_filters->>'group', '')));
  v_position text := lower(btrim(coalesce(p_filters->>'position', '')));
  v_shift text := lower(btrim(coalesce(p_filters->>'shift', '')));
  v_platform text := lower(btrim(coalesce(p_filters->>'platform', '')));
  v_attendance text := lower(btrim(coalesce(p_filters->>'attendance', '')));
  v_date_from date := nullif(p_filters->>'from', '')::date;
  v_date_to date := nullif(p_filters->>'to', '')::date;
  v_month_start date := date_trunc('month', current_date)::date;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 50);
  v_total integer;
  v_rows jsonb;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  if v_date_from is not null and v_date_to is not null
     and v_date_from > v_date_to then
    raise exception '日期起不能晚于日期止';
  end if;

  with source_rows as materialized (
    select roster.item
    from public.report_sheet_snapshots snapshot
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(snapshot.payload) = 'array'
        then snapshot.payload else '[]'::jsonb end
    ) roster(item)
    where snapshot.source = '居家排班表/填表'
  ), roster_people as materialized (
    select distinct on (employee.id)
      employee.id employee_id,
      employee.employee_no,
      coalesce(nullif(btrim(schedule_row.item->>'name'), ''), employee.full_name) employee_name,
      coalesce(
        nullif(btrim(schedule_row.item->>'position'), ''),
        pos.name,
        employee.schedule_position,
        ''
      ) position_name,
      coalesce(nullif(btrim(schedule_row.item->>'team'), ''), team.name, '') team_name,
      coalesce(nullif(btrim(schedule_row.item->>'group'), ''), employee.group_name, '') group_name,
      coalesce(
        nullif(btrim(schedule_row.item->>'shift'), ''),
        employee.shift_name,
        employee.legacy_shift_name,
        ''
      ) shift_name,
      coalesce(
        nullif(btrim(schedule_row.item->>'platform'), ''),
        employee.platform_scope,
        ''
      ) platform,
      coalesce(
        nullif(btrim(schedule_row.item->>'online_trainer'), ''),
        employee.online_trainer,
        employee.trainer_name,
        ''
      ) trainer_name,
      employee.hire_date,
      employee.resign_date
    from source_rows schedule_row
    join public.employees employee
      on lower(btrim(employee.employee_no)) =
         lower(btrim(schedule_row.item->>'employee_id'))
    left join public.teams team on team.id = employee.team_id
    left join public.positions pos on pos.id = employee.position_id
    -- A current training assignment is the roster source. Keep probation and
    -- temporarily suspended employees visible with zero-report counts; only
    -- an explicit resignation removes the employee from the live roster.
    where coalesce(employee.status::text, 'active') <> 'resigned'
      and nullif(
        public.online_training_identity_key(schedule_row.item->>'online_trainer'),
        ''
      ) is not null
      and public.online_training_employee_in_scope(employee.id)
      and (
        v_date_to is null
        or employee.hire_date is null
        or employee.hire_date <= v_date_to
      )
      and (
        v_date_from is null
        or employee.resign_date is null
        or employee.resign_date >= v_date_from
      )
    order by employee.id,
      case when coalesce(schedule_row.item->>'source_row', '') ~ '^\d+$'
        then (schedule_row.item->>'source_row')::integer end desc nulls last
  ), visible_member_rows as materialized (
    select
      report.id report_id,
      report.report_date,
      report.created_at report_created_at,
      report.title,
      report.author_name,
      report.author_employee_no,
      report.trainer_name report_trainer_name,
      report.platform report_platform,
      report.course_type,
      report.report_summary,
      report.issues_summary,
      report.next_plan,
      member.employee_id,
      member.employee_no,
      member.employee_name,
      member.position_name,
      member.team_name,
      member.group_name,
      member.shift_name,
      member.platform,
      member.trainer_name,
      member.attendance_status,
      member.status_note,
      member.work_details,
      member.performance,
      member.issues,
      member.follow_up,
      member.metrics,
      employee.hire_date,
      employee.resign_date
    from public.online_training_report_members member
    join public.online_training_reports report on report.id = member.report_id
    left join public.employees employee on employee.id = member.employee_id
    where report.status = 'published'
      and member.employee_id is not null
      and public.online_training_can_view_report(report.id)
      and public.online_training_employee_in_scope(member.employee_id)
      and (v_date_from is null or report.report_date >= v_date_from)
      and (v_date_to is null or report.report_date <= v_date_to)
  ), report_people as materialized (
    select distinct on (history.employee_id)
      history.employee_id,
      history.employee_no,
      history.employee_name,
      history.position_name,
      history.team_name,
      history.group_name,
      history.shift_name,
      history.platform,
      coalesce(
        nullif(history.trainer_name, ''),
        nullif(history.report_trainer_name, ''),
        history.author_name,
        ''
      ) trainer_name,
      history.hire_date,
      history.resign_date
    from visible_member_rows history
    order by history.employee_id,
      history.report_date desc,
      history.report_created_at desc
  ), candidate_people as materialized (
    select
      coalesce(roster.employee_id, history.employee_id) employee_id,
      coalesce(nullif(roster.employee_no, ''), history.employee_no, '') employee_no,
      coalesce(nullif(roster.employee_name, ''), history.employee_name, '') employee_name,
      coalesce(nullif(roster.position_name, ''), history.position_name, '') position_name,
      coalesce(nullif(roster.team_name, ''), history.team_name, '') team_name,
      coalesce(nullif(roster.group_name, ''), history.group_name, '') group_name,
      coalesce(nullif(roster.shift_name, ''), history.shift_name, '') shift_name,
      coalesce(nullif(roster.platform, ''), history.platform, '') platform,
      coalesce(nullif(roster.trainer_name, ''), history.trainer_name, '') trainer_name,
      coalesce(roster.hire_date, history.hire_date) hire_date,
      coalesce(roster.resign_date, history.resign_date) resign_date
    from roster_people roster
    full join report_people history using (employee_id)
  ), person_rollup as materialized (
    select
      candidate.employee_id,
      candidate.employee_no,
      candidate.employee_name,
      candidate.position_name,
      candidate.team_name,
      candidate.group_name,
      candidate.shift_name,
      candidate.platform,
      candidate.trainer_name,
      count(distinct history.report_id)::integer report_count,
      count(distinct history.report_date)::integer recorded_days,
      count(distinct history.report_date)
        filter (where history.attendance_status = 'normal')::integer normal_count,
      count(distinct history.report_date)
        filter (where history.attendance_status = 'rest')::integer rest_count,
      count(distinct history.report_date)
        filter (where history.attendance_status = 'leave')::integer leave_count,
      count(distinct history.report_date)
        filter (where history.attendance_status = 'absent')::integer absent_count,
      count(distinct history.report_date)
        filter (where history.attendance_status = 'transferred')::integer home_count,
      count(distinct history.report_date)
        filter (where nullif(btrim(history.issues), '') is not null)::integer issue_count,
      max(history.report_date) last_report_date,
      greatest(
        coalesce(v_date_from, min(history.report_date), v_month_start),
        coalesce(
          candidate.hire_date,
          coalesce(v_date_from, min(history.report_date), v_month_start)
        )
      ) period_from,
      least(
        coalesce(v_date_to, max(history.report_date), current_date),
        coalesce(
          candidate.resign_date,
          coalesce(v_date_to, max(history.report_date), current_date)
        )
      ) period_to
    from candidate_people candidate
    left join visible_member_rows history
      on history.employee_id = candidate.employee_id
    where (v_employee_no = '' or lower(candidate.employee_no) like '%' || v_employee_no || '%')
      and (v_employee_name = '' or lower(candidate.employee_name) like '%' || v_employee_name || '%')
      and (v_trainer = '' or lower(candidate.trainer_name) like '%' || v_trainer || '%')
      and (v_team = '' or lower(btrim(candidate.team_name)) = v_team)
      and (v_group = '' or lower(btrim(candidate.group_name)) = v_group)
      and (v_position = '' or lower(btrim(candidate.position_name)) = v_position)
      and (v_shift = '' or lower(btrim(candidate.shift_name)) = v_shift)
      and (v_platform = '' or lower(btrim(candidate.platform)) = v_platform)
      and (
        v_attendance = ''
        or exists (
          select 1
          from visible_member_rows attendance
          where attendance.employee_id = candidate.employee_id
            and lower(coalesce(attendance.attendance_status, '')) = v_attendance
        )
      )
      and (
        v_keyword = ''
        or exists (
          select 1
          from visible_member_rows content
          where content.employee_id = candidate.employee_id
            and lower(concat_ws(' ',
              content.title,
              content.report_platform,
              content.course_type,
              content.report_summary,
              content.issues_summary,
              content.next_plan,
              content.status_note,
              content.work_details,
              content.performance,
              content.issues,
              content.follow_up,
              content.metrics::text
            )) like '%' || v_keyword || '%'
        )
      )
    group by
      candidate.employee_id,
      candidate.employee_no,
      candidate.employee_name,
      candidate.position_name,
      candidate.team_name,
      candidate.group_name,
      candidate.shift_name,
      candidate.platform,
      candidate.trainer_name,
      candidate.hire_date,
      candidate.resign_date
  ), people as materialized (
    select
      person.*,
      greatest((person.period_to - person.period_from) + 1, 0)::integer period_days,
      greatest(
        ((person.period_to - person.period_from) + 1) - person.recorded_days,
        0
      )::integer missing_days,
      to_char(person.period_from, 'YYYY-MM-DD') || ' – ' ||
        to_char(person.period_to, 'YYYY-MM-DD') period_label
    from person_rollup person
  )
  select
    (select count(*)::integer from people),
    coalesce((
      select jsonb_agg(to_jsonb(page_row)
        order by page_row.last_report_date desc nulls last, page_row.employee_name)
      from (
        select *
        from people
        order by last_report_date desc nulls last, employee_name
        offset (v_page - 1) * v_page_size
        limit v_page_size
      ) page_row
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer)
  );
end;
$$;

comment on function public.online_training_search_people(jsonb, integer, integer) is
  'Lists in-scope online-training roster employees, including zero-report staff, and left-joins visible daily reports for the selected period.';

revoke all on function public.online_training_search_people(jsonb, integer, integer)
  from public, anon, authenticated;
grant execute on function public.online_training_search_people(jsonb, integer, integer)
  to authenticated;

commit;
