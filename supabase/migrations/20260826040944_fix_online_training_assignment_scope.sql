begin;

-- Trainer ownership is separate from authorship.  A Founder or manager may
-- submit a report on a trainer's behalf, so created_by/author_* must continue
-- to identify the real writer while these helpers resolve the trainer snapshot
-- independently.  Free-text aliases are accepted only when they identify one
-- and only one employee; duplicate names and cross-field collisions fail shut.
create or replace function session_private.online_training_snapshot_employee_id(
  p_value text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text := public.online_training_identity_key(p_value);
  v_candidate_count integer;
  v_employee_id uuid;
begin
  if nullif(v_key, '') is null then
    return null;
  end if;

  with candidates as materialized (
    select employee.id employee_id
    from public.employees employee
    where public.online_training_identity_key(employee.employee_no) = v_key
       or public.online_training_identity_key(employee.full_name) = v_key

    union

    select access.employee_id
    from public.user_access access
    where access.employee_id is not null
      and public.online_training_identity_key(access.login_username) = v_key
  )
  select count(*)::integer, min(candidate.employee_id::text)::uuid
  into v_candidate_count, v_employee_id
  from candidates candidate;

  if v_candidate_count <> 1 then
    return null;
  end if;
  return v_employee_id;
end;
$$;

create or replace function session_private.online_training_report_trainer_employee_id(
  p_report_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_snapshot_count integer;
  v_unresolved_count integer;
  v_employee_count integer;
  v_employee_id uuid;
begin
  if p_report_id is null then
    return null;
  end if;

  with snapshot_values as materialized (
    select report.trainer_name snapshot_value
    from public.online_training_reports report
    where report.id = p_report_id

    union all

    select member.trainer_name
    from public.online_training_report_members member
    where member.report_id = p_report_id
  ), resolved as materialized (
    select
      session_private.online_training_snapshot_employee_id(snapshot.snapshot_value)
        employee_id
    from snapshot_values snapshot
    where nullif(
      public.online_training_identity_key(snapshot.snapshot_value),
      ''
    ) is not null
  )
  select
    count(*)::integer,
    count(*) filter (where resolved.employee_id is null)::integer,
    count(distinct resolved.employee_id)::integer,
    min(resolved.employee_id::text)::uuid
  into
    v_snapshot_count,
    v_unresolved_count,
    v_employee_count,
    v_employee_id
  from resolved;

  if v_snapshot_count = 0
     or v_unresolved_count <> 0
     or v_employee_count <> 1 then
    return null;
  end if;
  return v_employee_id;
end;
$$;

revoke all on function
  session_private.online_training_snapshot_employee_id(text)
  from public, anon, authenticated;
revoke all on function
  session_private.online_training_report_trainer_employee_id(uuid)
  from public, anon, authenticated;

create index if not exists employees_online_training_employee_no_identity_idx
  on public.employees (
    public.online_training_identity_key(employee_no)
  );
create index if not exists employees_online_training_full_name_identity_idx
  on public.employees (
    public.online_training_identity_key(full_name)
  );
create index if not exists user_access_online_training_login_identity_idx
  on public.user_access (
    public.online_training_identity_key(login_username)
  )
  where employee_id is not null;

-- Restore the assignment-aware scope that was unintentionally replaced by the
-- generic same-team-and-position predicate.  The schedule value must resolve
-- uniquely to the linked caller before it grants access to a roster member.
create or replace function public.online_training_is_assigned_member(
  p_employee_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_employee_id uuid;
begin
  if p_employee_id is null
     or not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return false;
  end if;

  select access.employee_id
  into v_caller_employee_id
  from public.user_access access
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if v_caller_employee_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.employees employee
    join public.report_sheet_snapshots snapshot
      on snapshot.source = '居家排班表/填表'
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(snapshot.payload) = 'array'
        then snapshot.payload else '[]'::jsonb end
    ) roster(item)
    where employee.id = p_employee_id
      and employee.status in ('active', 'probation')
      and lower(btrim(employee.employee_no)) =
          lower(btrim(roster.item->>'employee_id'))
      and session_private.online_training_snapshot_employee_id(
        roster.item->>'online_trainer'
      ) = v_caller_employee_id
  );
end;
$$;

create or replace function public.online_training_employee_in_scope(
  p_employee_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_employee_id is null
     or not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return false;
  end if;

  return public.backend_employee_in_scope(p_employee_id)
    or public.online_training_is_assigned_member(p_employee_id);
end;
$$;

create or replace function public.online_training_caller_is_report_trainer(
  p_report_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_employee_id uuid;
begin
  if p_report_id is null
     or not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return false;
  end if;

  select access.employee_id
  into v_caller_employee_id
  from public.user_access access
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  return v_caller_employee_id is not null
    and session_private.online_training_report_trainer_employee_id(p_report_id)
      = v_caller_employee_id;
end;
$$;

create or replace function public.online_training_employee_history_in_scope(
  p_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_employee_id is not null
    and session_private.current_app_session_is_valid('admin')
    and public.online_training_can_view_module()
    and (
      public.online_training_employee_in_scope(p_employee_id)
      or exists (
        select 1
        from public.online_training_report_members member
        join public.online_training_reports report
          on report.id = member.report_id
        where member.employee_id = p_employee_id
          and report.status = 'published'
          and public.online_training_caller_is_report_trainer(report.id)
      )
    );
$$;

revoke all on function public.online_training_is_assigned_member(uuid)
  from public, anon;
revoke all on function public.online_training_employee_in_scope(uuid)
  from public, anon;
revoke all on function public.online_training_caller_is_report_trainer(uuid)
  from public, anon;
revoke all on function public.online_training_employee_history_in_scope(uuid)
  from public, anon;
grant execute on function public.online_training_is_assigned_member(uuid)
  to authenticated, service_role;
grant execute on function public.online_training_employee_in_scope(uuid)
  to authenticated, service_role;
grant execute on function public.online_training_caller_is_report_trainer(uuid)
  to authenticated, service_role;
grant execute on function public.online_training_employee_history_in_scope(uuid)
  to authenticated, service_role;

comment on function public.online_training_employee_in_scope(uuid) is
  'Training scope is generic backend scope plus a uniquely resolved current online-trainer assignment.';
comment on function public.online_training_caller_is_report_trainer(uuid) is
  'True only when every non-empty trainer snapshot on a report uniquely resolves to the linked caller employee.';

-- Keep the existing context payload/API, but make its personal roster obey the
-- same unique resolver as report visibility.  This prevents an ambiguous name
-- from appearing fillable in the UI only to be rejected by the save wrapper.
alter function public.online_training_context()
  rename to online_training_context_assignment_legacy;
alter function public.online_training_context_assignment_legacy()
  set schema session_private;
revoke all on function
  session_private.online_training_context_assignment_legacy()
  from public, anon, authenticated;

create or replace function public.online_training_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_context jsonb;
  v_caller_employee_id uuid;
  v_my_roster jsonb := '[]'::jsonb;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  v_context := session_private.online_training_context_assignment_legacy();
  select access.employee_id
  into v_caller_employee_id
  from public.user_access access
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if v_caller_employee_id is not null then
    select coalesce(jsonb_agg(roster.item), '[]'::jsonb)
    into v_my_roster
    from jsonb_array_elements(
      case when jsonb_typeof(v_context->'my_roster') = 'array'
        then v_context->'my_roster' else '[]'::jsonb end
    ) roster(item)
    where session_private.online_training_snapshot_employee_id(
      roster.item->>'online_trainer'
    ) = v_caller_employee_id;
  end if;

  return v_context || jsonb_build_object(
    'my_roster', v_my_roster,
    'auto_assignment',
      coalesce(v_context->'auto_assignment', '{}'::jsonb)
      || jsonb_build_object(
        'linked', v_caller_employee_id is not null,
        'matched', jsonb_array_length(v_my_roster) > 0,
        'member_count', jsonb_array_length(v_my_roster)
      )
  );
end;
$$;

revoke all on function public.online_training_context()
  from public, anon;
grant execute on function public.online_training_context()
  to authenticated;

create or replace function public.online_training_can_view_report(p_report_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_status text;
  v_author_employee_id uuid;
  v_can_manage boolean;
begin
  if not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return false;
  end if;

  select report.created_by, report.status, report.author_employee_id
  into v_created_by, v_status, v_author_employee_id
  from public.online_training_reports report
  where report.id = p_report_id;

  if not found then return false; end if;
  if public.is_founder() then return true; end if;

  v_can_manage := public.has_permission('online_training.manage');
  if v_status <> 'published'
     and v_created_by <> (select auth.uid())
     and not v_can_manage then
    return false;
  end if;

  if public.online_training_caller_is_report_trainer(p_report_id) then
    return true;
  end if;
  if public.online_training_employee_in_scope(v_author_employee_id) then
    return true;
  end if;

  return exists (
    select 1
    from public.online_training_report_members member
    where member.report_id = p_report_id
      and public.online_training_employee_in_scope(member.employee_id)
  );
end;
$$;

revoke all on function public.online_training_can_view_report(uuid)
  from public, anon;
grant execute on function public.online_training_can_view_report(uuid)
  to authenticated, service_role;

-- A uniquely identified historical trainer may read every member snapshot in
-- that report.  This changes SELECT only; edit/archive policies and
-- online_training_can_edit_report remain untouched.
drop policy if exists online_training_members_read
  on public.online_training_report_members;
create policy online_training_members_read
on public.online_training_report_members
for select
to authenticated
using (
  public.online_training_can_view_report(report_id)
  and (
    public.online_training_employee_in_scope(employee_id)
    or public.online_training_caller_is_report_trainer(report_id)
  )
);

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
  v_requested_from date := nullif(p_filters->>'from', '')::date;
  v_requested_to date := nullif(p_filters->>'to', '')::date;
  v_business_today date := (current_timestamp at time zone 'Asia/Manila')::date;
  v_effective_from date;
  v_effective_to date;
  v_caller_employee_id uuid;
  v_is_founder boolean := false;
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
      and (
        employee.hire_date is null
        or employee.hire_date <= v_effective_to
      )
      and (
        employee.resign_date is null
        or employee.resign_date >= v_effective_from
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
      and report.report_date between v_effective_from and v_effective_to
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
      candidate.is_current_roster,
      candidate.has_history,
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
        v_effective_from,
        coalesce(candidate.hire_date, v_effective_from)
      ) period_from,
      least(
        v_effective_to,
        coalesce(candidate.resign_date, v_effective_to)
      ) period_to
    from candidate_people candidate
    left join visible_member_rows history
      on history.employee_id = candidate.employee_id
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
      candidate.resign_date,
      candidate.is_current_roster,
      candidate.has_history
  ), people as materialized (
    select
      person.*,
      greatest((person.period_to - person.period_from) + 1, 0)::integer period_days,
      case
        when person.is_current_roster then greatest(
          ((person.period_to - person.period_from) + 1) - person.recorded_days,
          0
        )::integer
        else 0
      end missing_days,
      to_char(person.period_from, 'YYYY-MM-DD') || ' – ' ||
        to_char(person.period_to, 'YYYY-MM-DD') period_label
    from person_rollup person
  )
  select
    (select count(*)::integer from people),
    coalesce((
      select jsonb_agg(
        to_jsonb(page_row)
        order by page_row.last_report_date desc nulls last,
          page_row.employee_name
      )
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
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer),
    'effective_from', v_effective_from,
    'effective_to', v_effective_to,
    'business_today', v_business_today
  );
end;
$$;

comment on function public.online_training_search_people(jsonb, integer, integer) is
  'Lists current assigned people and uniquely claimed historical trainer snapshots without broadening other backend modules.';
revoke all on function public.online_training_search_people(jsonb, integer, integer)
  from public, anon;
grant execute on function public.online_training_search_people(jsonb, integer, integer)
  to authenticated;

create or replace function public.online_training_search_reports(
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
  v_date_from date := nullif(p_filters->>'from', '')::date;
  v_date_to date := nullif(p_filters->>'to', '')::date;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 12), 1), 50);
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

  with visible as materialized (
    select report.*
    from public.online_training_reports report
    where report.status = 'published'
      and public.online_training_can_view_report(report.id)
      and (v_date_from is null or report.report_date >= v_date_from)
      and (v_date_to is null or report.report_date <= v_date_to)
      and (
        v_trainer = ''
        or lower(concat_ws(' ',
          report.author_name,
          report.author_employee_no,
          report.trainer_name
        )) like '%' || v_trainer || '%'
        or exists (
          select 1
          from public.online_training_report_members trainer_member
          where trainer_member.report_id = report.id
            and (
              public.online_training_employee_in_scope(
                trainer_member.employee_id
              )
              or public.online_training_caller_is_report_trainer(report.id)
            )
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
          from public.online_training_report_members member_filter
          where member_filter.report_id = report.id
            and (
              public.online_training_employee_in_scope(member_filter.employee_id)
              or public.online_training_caller_is_report_trainer(report.id)
            )
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
          from public.online_training_report_members keyword_member
          where keyword_member.report_id = report.id
            and (
              public.online_training_employee_in_scope(keyword_member.employee_id)
              or public.online_training_caller_is_report_trainer(report.id)
            )
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
  )
  select
    (select count(*)::integer from visible),
    coalesce((
      select jsonb_agg(
        to_jsonb(page_report)
        || jsonb_build_object(
          'can_edit', public.online_training_can_edit_report(page_report.id),
          'can_review', public.online_training_can_review_report(page_report.id),
          'members', coalesce((
            select jsonb_agg(
              to_jsonb(member) order by member.sort_order, member.employee_name
            )
            from public.online_training_report_members member
            where member.report_id = page_report.id
              and (
                public.online_training_employee_in_scope(member.employee_id)
                or public.online_training_caller_is_report_trainer(page_report.id)
              )
          ), '[]'::jsonb)
        )
        order by page_report.report_date desc, page_report.created_at desc
      )
      from (
        select *
        from visible
        order by report_date desc, created_at desc
        offset (v_page - 1) * v_page_size
        limit v_page_size
      ) page_report
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

comment on function public.online_training_search_reports(jsonb, integer, integer) is
  'Lists live-scope reports plus historical reports whose trainer snapshots uniquely resolve to the linked caller.';
revoke all on function public.online_training_search_reports(jsonb, integer, integer)
  from public, anon;
grant execute on function public.online_training_search_reports(jsonb, integer, integer)
  to authenticated;

create or replace function public.online_training_list(
  p_query text default '',
  p_date_from date default null,
  p_date_to date default null,
  p_employee_id uuid default null,
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
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 12), 1), 50);
  v_total integer;
  v_rows jsonb;
  v_full_scope boolean := false;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  select public.is_founder() or exists (
    select 1
    from public.user_access access
    where access.auth_user_id = (select auth.uid())
      and access.active = true
      and access.backend_enabled = true
      and access.data_scope = 'all'
  ) into v_full_scope;
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  if p_employee_id is not null
     and not public.online_training_employee_history_in_scope(p_employee_id) then
    raise exception '无权查看该员工培训记录';
  end if;

  with visible as materialized (
    select report.*
    from public.online_training_reports report
    where report.status = 'published'
      and public.online_training_can_view_report(report.id)
      and (p_date_from is null or report.report_date >= p_date_from)
      and (p_date_to is null or report.report_date <= p_date_to)
      and exists (
        select 1
        from public.online_training_report_members scoped_member
        where scoped_member.report_id = report.id
          and (
            p_employee_id is null
            or scoped_member.employee_id = p_employee_id
          )
          and (
            public.online_training_employee_in_scope(scoped_member.employee_id)
            or public.online_training_caller_is_report_trainer(report.id)
          )
      )
      and (
        v_query = ''
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
        )) like '%' || v_query || '%'
        or exists (
          select 1
          from public.online_training_report_members member_filter
          where member_filter.report_id = report.id
            and (
              p_employee_id is null
              or member_filter.employee_id = p_employee_id
            )
            and (
              public.online_training_employee_in_scope(member_filter.employee_id)
              or public.online_training_caller_is_report_trainer(report.id)
            )
            and lower(concat_ws(' ',
              member_filter.employee_no,
              member_filter.employee_name,
              member_filter.position_name,
              member_filter.team_name,
              member_filter.group_name,
              member_filter.shift_name,
              member_filter.platform,
              member_filter.work_details,
              member_filter.performance,
              member_filter.issues,
              member_filter.follow_up
            )) like '%' || v_query || '%'
        )
      )
  )
  select count(*) into v_total from visible;

  with visible as materialized (
    select report.*
    from public.online_training_reports report
    where report.status = 'published'
      and public.online_training_can_view_report(report.id)
      and (p_date_from is null or report.report_date >= p_date_from)
      and (p_date_to is null or report.report_date <= p_date_to)
      and exists (
        select 1
        from public.online_training_report_members scoped_member
        where scoped_member.report_id = report.id
          and (
            p_employee_id is null
            or scoped_member.employee_id = p_employee_id
          )
          and (
            public.online_training_employee_in_scope(scoped_member.employee_id)
            or public.online_training_caller_is_report_trainer(report.id)
          )
      )
      and (
        v_query = ''
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
        )) like '%' || v_query || '%'
        or exists (
          select 1
          from public.online_training_report_members member_filter
          where member_filter.report_id = report.id
            and (
              p_employee_id is null
              or member_filter.employee_id = p_employee_id
            )
            and (
              public.online_training_employee_in_scope(member_filter.employee_id)
              or public.online_training_caller_is_report_trainer(report.id)
            )
            and lower(concat_ws(' ',
              member_filter.employee_no,
              member_filter.employee_name,
              member_filter.position_name,
              member_filter.team_name,
              member_filter.group_name,
              member_filter.shift_name,
              member_filter.platform,
              member_filter.work_details,
              member_filter.performance,
              member_filter.issues,
              member_filter.follow_up
            )) like '%' || v_query || '%'
        )
      )
    order by report.report_date desc, report.created_at desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select coalesce(jsonb_agg(
    (
      case
        when p_employee_id is null and v_full_scope then to_jsonb(report)
        else to_jsonb(report)
          - 'attachments'
          - 'report_summary'
          - 'issues_summary'
          - 'next_plan'
          - 'review_note'
      end
    )
    || jsonb_build_object(
      'can_edit', case
        when p_employee_id is null
          and (
            v_full_scope
            or not exists (
              select 1
              from public.online_training_report_members outside_member
              where outside_member.report_id = report.id
                and not public.online_training_employee_in_scope(
                  outside_member.employee_id
                )
            )
          )
        then public.online_training_can_edit_report(report.id)
        else false
      end,
      'can_review', case
        when p_employee_id is null
          and (
            v_full_scope
            or not exists (
              select 1
              from public.online_training_report_members outside_member
              where outside_member.report_id = report.id
                and not public.online_training_employee_in_scope(
                  outside_member.employee_id
                )
            )
          )
        then public.online_training_can_review_report(report.id)
        else false
      end,
      'members', coalesce((
        select jsonb_agg(
          to_jsonb(member) order by member.sort_order, member.employee_name
        )
        from public.online_training_report_members member
        where member.report_id = report.id
          and (p_employee_id is null or member.employee_id = p_employee_id)
          and (
            public.online_training_employee_in_scope(member.employee_id)
            or public.online_training_caller_is_report_trainer(report.id)
          )
      ), '[]'::jsonb)
    )
    order by report.report_date desc, report.created_at desc
  ), '[]'::jsonb)
  into v_rows
  from visible report;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer)
  );
end;
$$;

comment on function public.online_training_list(text, date, date, uuid, integer, integer) is
  'Employee history includes uniquely claimed trainer snapshots; edit/review flags retain the pre-existing live-scope gates.';
revoke all on function public.online_training_list(text, date, date, uuid, integer, integer)
  from public, anon;
grant execute on function public.online_training_list(text, date, date, uuid, integer, integer)
  to authenticated;

commit;
