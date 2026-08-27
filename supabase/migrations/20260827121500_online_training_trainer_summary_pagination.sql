begin;

do $trainer_summary_prerequisites$
declare
  v_view_gate text;
begin
  if to_regprocedure('public.online_training_can_view_module()') is null then
    raise exception 'online_training_trainer_summary_view_gate_missing';
  end if;
  select pg_get_functiondef(
    'public.online_training_can_view_module()'::regprocedure
  ) into v_view_gate;
  if position('online_training.report.view' in v_view_gate) = 0 then
    raise exception 'online_training_trainer_summary_view_gate_changed';
  end if;
end
$trainer_summary_prerequisites$;

-- The report-first Online Training landing page used to download every
-- employee page and every report page before grouping trainers in the browser.
-- Keep the same current-roster, historical-report and trainer-assignment scope,
-- but aggregate and paginate the trainer directory inside one guarded RPC.
create or replace function public.online_training_search_trainers(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 12
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
  v_requested_from date := nullif(p_filters->>'from', '')::date;
  v_requested_to date := nullif(p_filters->>'to', '')::date;
  v_business_today date := (current_timestamp at time zone 'Asia/Manila')::date;
  v_effective_from date;
  v_effective_to date;
  v_caller_employee_id uuid;
  v_is_founder boolean := false;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 12), 1), 50);
  v_pages integer := 1;
  v_total integer := 0;
  v_report_total integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_candidates jsonb := '[]'::jsonb;
  v_directory jsonb := '[]'::jsonb;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  -- This helper is the canonical online_training.report.view gate after the
  -- granular-permission migration. Do not replace it with a broad role check.
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  if v_requested_from is not null and v_requested_to is not null
     and v_requested_from > v_requested_to then
    raise exception '日期起不能晚于日期止';
  end if;

  v_effective_to := least(
    coalesce(v_requested_to, v_business_today),
    v_business_today
  );
  v_effective_from := case
    when v_requested_from is not null
      then least(v_requested_from, v_business_today)
    else date_trunc('month', v_effective_to)::date
  end;
  if v_effective_from > v_effective_to then
    raise exception '有效日期起不能晚于日期止';
  end if;

  v_is_founder := public.is_founder();
  select access.employee_id
  into v_caller_employee_id
  from public.user_access access
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  with source_rows as materialized (
    select roster.item
    from public.report_sheet_snapshots snapshot
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(snapshot.payload) = 'array'
        then snapshot.payload else '[]'::jsonb end
    ) roster(item)
    where snapshot.source = '居家排班表/填表'
  ), trainer_assignment_ids as materialized (
    select distinct employee.id employee_id
    from source_rows schedule_row
    join public.employees employee
      on lower(btrim(employee.employee_no)) =
         lower(btrim(schedule_row.item->>'employee_id'))
    where v_caller_employee_id is not null
      and employee.status in ('active', 'probation')
      and session_private.online_training_snapshot_employee_id(
        schedule_row.item->>'online_trainer'
      ) = v_caller_employee_id
  ), allowed_employee_ids as materialized (
    select employee.id employee_id
    from public.employees employee
    left join trainer_assignment_ids assignment
      on assignment.employee_id = employee.id
    where public.backend_employee_in_scope(employee.id)
      or assignment.employee_id is not null
  ), roster_people as materialized (
    select distinct on (employee.id)
      employee.id employee_id,
      employee.employee_no,
      coalesce(
        nullif(btrim(schedule_row.item->>'name'), ''),
        employee.full_name
      ) employee_name,
      coalesce(
        nullif(btrim(schedule_row.item->>'position'), ''),
        position.name,
        employee.schedule_position,
        ''
      ) position_name,
      coalesce(
        nullif(btrim(schedule_row.item->>'team'), ''),
        team.name,
        ''
      ) team_name,
      coalesce(
        nullif(btrim(schedule_row.item->>'group'), ''),
        employee.group_name,
        ''
      ) group_name,
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
    join allowed_employee_ids allowed
      on allowed.employee_id = employee.id
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    where employee.status in ('active', 'probation')
      and nullif(
        public.online_training_identity_key(
          schedule_row.item->>'online_trainer'
        ),
        ''
      ) is not null
      and (employee.hire_date is null or employee.hire_date <= v_effective_to)
      and (employee.resign_date is null or employee.resign_date >= v_effective_from)
    order by employee.id,
      case when coalesce(schedule_row.item->>'source_row', '') ~ '^\d+$'
        then (schedule_row.item->>'source_row')::integer end desc nulls last
  ), visible_reports as materialized (
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
      member.sort_order,
      employee.hire_date,
      employee.resign_date
    from visible_reports report
    join public.online_training_report_members member
      on member.report_id = report.id
    left join public.employees employee on employee.id = member.employee_id
    left join allowed_employee_ids allowed_member
      on allowed_member.employee_id = member.employee_id
    where member.employee_id is not null
      and (
        allowed_member.employee_id is not null
        or v_is_founder
        or report.caller_is_report_trainer
      )
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
      coalesce(roster.resign_date, history.resign_date) resign_date,
      roster.employee_id is not null is_current_roster,
      history.employee_id is not null has_history
    from roster_people roster
    full join report_people history using (employee_id)
  ), filtered_people as materialized (
    select
      candidate.*,
      public.online_training_identity_key(coalesce(
        nullif(btrim(candidate.trainer_name), ''),
        '未填写线上培训'
      )) trainer_key,
      greatest(
        v_effective_from,
        coalesce(candidate.hire_date, v_effective_from)
      ) period_from,
      least(
        v_effective_to,
        coalesce(candidate.resign_date, v_effective_to)
      ) period_to
    from candidate_people candidate
    where (
      (
        candidate.is_current_roster
        and (
          v_employee_no = ''
          or lower(candidate.employee_no) like '%' || v_employee_no || '%'
        )
        and (
          v_employee_name = ''
          or lower(candidate.employee_name) like '%' || v_employee_name || '%'
        )
        and (
          v_trainer = ''
          or lower(candidate.trainer_name) like '%' || v_trainer || '%'
        )
        and (v_team = '' or lower(btrim(candidate.team_name)) = v_team)
        and (v_group = '' or lower(btrim(candidate.group_name)) = v_group)
        and (v_position = '' or lower(btrim(candidate.position_name)) = v_position)
        and (v_shift = '' or lower(btrim(candidate.shift_name)) = v_shift)
        and (v_platform = '' or lower(btrim(candidate.platform)) = v_platform)
        and v_attendance = ''
        and v_keyword = ''
      )
      or (
        candidate.has_history
        and exists (
          select 1
          from visible_member_rows history_filter
          where history_filter.employee_id = candidate.employee_id
            and (
              v_employee_no = ''
              or lower(coalesce(history_filter.employee_no, ''))
                like '%' || v_employee_no || '%'
            )
            and (
              v_employee_name = ''
              or lower(coalesce(history_filter.employee_name, ''))
                like '%' || v_employee_name || '%'
            )
            and (
              v_trainer = ''
              or lower(concat_ws(' ',
                history_filter.author_name,
                history_filter.author_employee_no,
                history_filter.report_trainer_name,
                history_filter.trainer_name
              )) like '%' || v_trainer || '%'
            )
            and (
              v_team = ''
              or lower(btrim(coalesce(history_filter.team_name, ''))) = v_team
            )
            and (
              v_group = ''
              or lower(btrim(coalesce(history_filter.group_name, ''))) = v_group
            )
            and (
              v_position = ''
              or lower(btrim(coalesce(history_filter.position_name, ''))) = v_position
            )
            and (
              v_shift = ''
              or lower(btrim(coalesce(history_filter.shift_name, ''))) = v_shift
            )
            and (
              v_platform = ''
              or lower(btrim(coalesce(history_filter.platform, ''))) = v_platform
            )
            and (
              v_attendance = ''
              or lower(coalesce(history_filter.attendance_status, '')) = v_attendance
            )
            and (
              v_keyword = ''
              or lower(concat_ws(' ',
                history_filter.title,
                history_filter.report_platform,
                history_filter.course_type,
                history_filter.report_summary,
                history_filter.issues_summary,
                history_filter.next_plan,
                history_filter.status_note,
                history_filter.work_details,
                history_filter.performance,
                history_filter.issues,
                history_filter.follow_up,
                history_filter.metrics::text
              )) like '%' || v_keyword || '%'
            )
        )
      )
    )
  ), roster_summary as materialized (
    select
      person.trainer_key,
      (array_agg(
        coalesce(nullif(btrim(person.trainer_name), ''), '未填写线上培训')
        order by person.is_current_roster desc, person.trainer_name
      ))[1] trainer_name,
      count(distinct person.employee_id)::integer employee_count,
      coalesce(to_jsonb(array_agg(
        distinct nullif(btrim(person.team_name), '')
        order by nullif(btrim(person.team_name), '')
      ) filter (where nullif(btrim(person.team_name), '') is not null)), '[]'::jsonb) team_names,
      coalesce(to_jsonb(array_agg(
        distinct nullif(btrim(person.group_name), '')
        order by nullif(btrim(person.group_name), '')
      ) filter (where nullif(btrim(person.group_name), '') is not null)), '[]'::jsonb) group_names,
      coalesce(to_jsonb(array_agg(
        distinct nullif(btrim(person.position_name), '')
        order by nullif(btrim(person.position_name), '')
      ) filter (where nullif(btrim(person.position_name), '') is not null)), '[]'::jsonb) position_names,
      coalesce(to_jsonb(array_agg(
        distinct nullif(btrim(person.shift_name), '')
        order by nullif(btrim(person.shift_name), '')
      ) filter (where nullif(btrim(person.shift_name), '') is not null)), '[]'::jsonb) shift_names,
      coalesce(to_jsonb(array_agg(
        distinct nullif(btrim(person.platform), '')
        order by nullif(btrim(person.platform), '')
      ) filter (where nullif(btrim(person.platform), '') is not null)), '[]'::jsonb) platforms,
      min(person.period_from) period_from,
      max(person.period_to) period_to
    from filtered_people person
    group by person.trainer_key
  ), filtered_reports as materialized (
    select report.*
    from visible_reports report
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
    )
    and (
      (
        v_employee_no = '' and v_employee_name = '' and v_team = ''
        and v_group = '' and v_position = '' and v_shift = ''
        and v_platform = '' and v_attendance = ''
      )
      or exists (
        select 1
        from visible_member_rows member_filter
        where member_filter.report_id = report.id
          and (
            v_employee_no = ''
            or lower(coalesce(member_filter.employee_no, ''))
              like '%' || v_employee_no || '%'
          )
          and (
            v_employee_name = ''
            or lower(coalesce(member_filter.employee_name, ''))
              like '%' || v_employee_name || '%'
          )
          and (
            v_team = ''
            or lower(btrim(coalesce(member_filter.team_name, ''))) = v_team
          )
          and (
            v_group = ''
            or lower(btrim(coalesce(member_filter.group_name, ''))) = v_group
          )
          and (
            v_position = ''
            or lower(btrim(coalesce(member_filter.position_name, ''))) = v_position
          )
          and (
            v_shift = ''
            or lower(btrim(coalesce(member_filter.shift_name, ''))) = v_shift
          )
          and (
            v_platform = ''
            or lower(btrim(coalesce(member_filter.platform, ''))) = v_platform
          )
          and (
            v_attendance = ''
            or lower(coalesce(member_filter.attendance_status, '')) = v_attendance
          )
      )
    )
    and (
      v_keyword = ''
      or lower(concat_ws(' ',
        report.title,
        report.platform,
        report.shift_name,
        report.team_name,
        report.group_name,
        report.leader_name,
        report.trainer_name,
        report.course_type,
        report.report_summary,
        report.issues_summary,
        report.next_plan
      )) like '%' || v_keyword || '%'
      or exists (
        select 1
        from visible_member_rows keyword_member
        where keyword_member.report_id = report.id
          and lower(concat_ws(' ',
            keyword_member.employee_no,
            keyword_member.employee_name,
            keyword_member.position_name,
            keyword_member.team_name,
            keyword_member.group_name,
            keyword_member.shift_name,
            keyword_member.platform,
            keyword_member.status_note,
            keyword_member.work_details,
            keyword_member.performance,
            keyword_member.issues,
            keyword_member.follow_up,
            keyword_member.metrics::text
          )) like '%' || v_keyword || '%'
      )
    )
  ), report_trainer_base as materialized (
    select
      report.id report_id,
      report.report_date,
      report.created_at,
      report.author_name,
      report.author_employee_no,
      coalesce(
        nullif(btrim(report.trainer_name), ''),
        case when count(distinct public.online_training_identity_key(
          member.trainer_name
        )) filter (
          where nullif(public.online_training_identity_key(member.trainer_name), '')
            is not null
        ) = 1 then (
          array_agg(
            nullif(btrim(member.trainer_name), '')
            order by member.sort_order, member.employee_name
          ) filter (where nullif(btrim(member.trainer_name), '') is not null)
        )[1] end,
        nullif(btrim(report.author_name), ''),
        nullif(btrim(report.author_employee_no), ''),
        '未填写线上培训'
      ) trainer_name
    from filtered_reports report
    left join visible_member_rows member on member.report_id = report.id
    group by report.id, report.report_date, report.created_at,
      report.author_name, report.author_employee_no, report.trainer_name
  ), report_trainer_rows as materialized (
    select
      report.*,
      public.online_training_identity_key(report.trainer_name) trainer_key,
      case
        when public.online_training_identity_key(report.author_name)
          = public.online_training_identity_key(report.trainer_name)
        then coalesce(report.author_employee_no, '')
        else ''
      end trainer_employee_no
    from report_trainer_base report
  ), report_summary as materialized (
    select
      report.trainer_key,
      (array_agg(
        report.trainer_name
        order by report.report_date desc, report.created_at desc
      ))[1] trainer_name,
      coalesce((array_agg(
        nullif(btrim(report.trainer_employee_no), '')
        order by report.report_date desc, report.created_at desc
      ) filter (
        where nullif(btrim(report.trainer_employee_no), '') is not null
      ))[1], '') trainer_employee_no,
      count(distinct report.report_id)::integer report_count,
      count(distinct report.report_date)::integer recorded_days,
      count(*) filter (where member.attendance_status = 'normal')::integer normal_count,
      count(*) filter (where member.attendance_status = 'rest')::integer rest_count,
      count(*) filter (where member.attendance_status = 'leave')::integer leave_count,
      count(*) filter (where member.attendance_status = 'absent')::integer absent_count,
      count(*) filter (where member.attendance_status = 'transferred')::integer home_count,
      count(distinct coalesce(
        member.employee_id::text,
        nullif(btrim(member.employee_no), ''),
        nullif(btrim(member.employee_name), '')
      ))::integer report_employee_count,
      max(report.report_date) last_report_date
    from report_trainer_rows report
    left join visible_member_rows member on member.report_id = report.report_id
    group by report.trainer_key
  ), trainer_summary as materialized (
    select
      coalesce(roster.trainer_key, report.trainer_key) trainer_key,
      coalesce(roster.trainer_name, report.trainer_name, '未填写线上培训') trainer_name,
      coalesce(report.trainer_employee_no, '') trainer_employee_no,
      null::date trainer_hire_date,
      coalesce(report.report_count, 0)::integer report_count,
      coalesce(report.recorded_days, 0)::integer recorded_days,
      case
        when coalesce(roster.employee_count, 0) > 0 then roster.employee_count
        else coalesce(report.report_employee_count, 0)
      end::integer employee_count,
      report.last_report_date,
      coalesce(report.normal_count, 0)::integer normal_count,
      coalesce(report.rest_count, 0)::integer rest_count,
      coalesce(report.leave_count, 0)::integer leave_count,
      coalesce(report.absent_count, 0)::integer absent_count,
      coalesce(report.home_count, 0)::integer home_count,
      coalesce(roster.team_names, '[]'::jsonb) team_names,
      coalesce(roster.group_names, '[]'::jsonb) group_names,
      coalesce(roster.position_names, '[]'::jsonb) position_names,
      coalesce(roster.shift_names, '[]'::jsonb) shift_names,
      coalesce(roster.platforms, '[]'::jsonb) platforms,
      roster.period_from,
      roster.period_to
    from roster_summary roster
    full join report_summary report using (trainer_key)
  ), ordered as materialized (
    select
      trainer.*,
      row_number() over (
        order by trainer.last_report_date desc nulls last, trainer.trainer_name
      ) row_index,
      count(*) over () total_count,
      sum(trainer.report_count) over () all_report_count
    from trainer_summary trainer
  )
  select
    coalesce(max(ordered.total_count), 0)::integer,
    coalesce(max(ordered.all_report_count), 0)::integer,
    coalesce(jsonb_agg(
      to_jsonb(ordered) - 'row_index' - 'total_count' - 'all_report_count'
      order by ordered.row_index
    ) filter (
      where ordered.row_index > (
        least(
          v_page,
          greatest(1, ceil(ordered.total_count::numeric / v_page_size)::integer)
        ) - 1
      ) * v_page_size
      and ordered.row_index <= least(
        v_page,
        greatest(1, ceil(ordered.total_count::numeric / v_page_size)::integer)
      ) * v_page_size
    ), '[]'::jsonb)
  into v_total, v_report_total, v_rows
  from ordered;

  v_pages := greatest(1, ceil(v_total::numeric / v_page_size)::integer);
  v_page := least(v_page, v_pages);

  -- Resolve only the current page through the existing exact, unique and
  -- scope-filtered directory. This keeps lifecycle identity data bounded and
  -- never substitutes a trainee identity for a trainer.
  if jsonb_array_length(v_rows) > 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
      'trainer_key', page.item->>'trainer_key',
      'trainer_employee_no', coalesce(page.item->>'trainer_employee_no', ''),
      'trainer_name', coalesce(page.item->>'trainer_name', '')
    )), '[]'::jsonb)
    into v_candidates
    from jsonb_array_elements(v_rows) page(item);

    v_directory := public.online_training_resolve_trainer_identities(v_candidates);

    select coalesce(jsonb_agg(
      page.item || jsonb_build_object(
        'trainer_employee_no', coalesce(
          nullif(resolved.item->>'employee_no', ''),
          nullif(page.item->>'trainer_employee_no', ''),
          ''
        ),
        'trainer_hire_date', coalesce(
          nullif(resolved.item->>'hire_date', ''),
          nullif(page.item->>'trainer_hire_date', '')
        )
      )
      order by page.ordinality
    ), '[]'::jsonb)
    into v_rows
    from jsonb_array_elements(v_rows) with ordinality page(item, ordinality)
    left join lateral (
      select directory.item
      from jsonb_array_elements(v_directory) directory(item)
      where directory.item->>'trainer_key' = page.item->>'trainer_key'
      limit 1
    ) resolved on true;
  end if;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', v_pages,
    'report_total', v_report_total,
    'effective_from', v_effective_from,
    'effective_to', v_effective_to,
    'business_today', v_business_today
  );
end;
$$;

comment on function public.online_training_search_trainers(jsonb, integer, integer) is
  'Scope-safe server-side trainer identity, roster-size and daily-report aggregation with bounded pagination; returns no attachment paths or signed URLs.';

revoke all on function public.online_training_search_trainers(jsonb, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.online_training_search_trainers(jsonb, integer, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
