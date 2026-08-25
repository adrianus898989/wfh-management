begin;

-- Homepage and personnel analysis are independently grantable pages.
insert into public.permissions (code, name, category, sensitive)
values
  ('dashboard.view', '首页 · 查看后台首页', 'dashboard', false),
  ('employee.analytics.view', '员工管理 · 查看人员分析', 'employee', false)
on conflict (code) do update
set name = excluded.name,
    category = excluded.category,
    sensitive = excluded.sensitive;

-- Existing backend roles keep their current homepage access by default; the
-- role editor can revoke it later. Personnel analysis follows the historical
-- employee.view default and explicit per-user overrides.
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code = 'dashboard.view'
where role.active = true
  and role.backend_allowed = true
  and role.code <> 'employee'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select existing.role_id, analytics.id
from public.role_permissions existing
join public.permissions employee_view
  on employee_view.id = existing.permission_id
 and employee_view.code = 'employee.view'
join public.permissions analytics
  on analytics.code = 'employee.analytics.view'
on conflict do nothing;

insert into public.user_permission_overrides (auth_user_id, permission_id, allowed)
select existing.auth_user_id, analytics.id, existing.allowed
from public.user_permission_overrides existing
join public.permissions employee_view
  on employee_view.id = existing.permission_id
 and employee_view.code = 'employee.view'
join public.permissions analytics
  on analytics.code = 'employee.analytics.view'
on conflict (auth_user_id, permission_id) do nothing;

-- A backend identity linked to an employee follows that employee's live
-- organization. It must not retain an old hand-maintained all/assigned scope
-- after the employee changes team or position.
create or replace function public.enforce_linked_backend_own_team()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role_code text;
begin
  if new.backend_enabled = true and new.employee_id is not null then
    select role.code into v_role_code
    from public.roles role
    where role.id = new.role_id;

    if coalesce(v_role_code, '') <> 'founder' then
      new.data_scope := 'own_team';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_linked_backend_own_team()
  from public, anon, authenticated;

drop trigger if exists enforce_linked_backend_own_team_trigger
  on public.user_access;
create trigger enforce_linked_backend_own_team_trigger
before insert or update of employee_id, role_id, backend_enabled, data_scope
on public.user_access
for each row execute function public.enforce_linked_backend_own_team();

update public.user_access access
set data_scope = 'own_team',
    updated_at = now()
from public.roles role
where role.id = access.role_id
  and access.backend_enabled = true
  and access.employee_id is not null
  and role.code <> 'founder'
  and access.data_scope <> 'own_team';

-- Central backend scope predicate. Linked accounts see themselves plus people
-- with the same team and the same position; group_name deliberately does not
-- participate, so the same position is visible across groups. Missing team or
-- position data falls back to self-only rather than broadening access.
create or replace function public.backend_employee_in_scope(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_scope text;
  v_role_code text;
  v_caller_team_id uuid;
  v_caller_position_id uuid;
begin
  if p_employee_id is null
     or not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;

  select access.employee_id,
         access.data_scope,
         role.code,
         employee.team_id,
         employee.position_id
  into v_caller_employee_id,
       v_scope,
       v_role_code,
       v_caller_team_id,
       v_caller_position_id
  from public.user_access access
  join public.roles role on role.id = access.role_id
  left join public.employees employee on employee.id = access.employee_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then return false; end if;
  if v_role_code = 'founder' then return true; end if;
  if p_employee_id = v_caller_employee_id then return true; end if;

  if v_caller_employee_id is not null then
    if v_caller_team_id is null or v_caller_position_id is null then
      return false;
    end if;
    return exists (
      select 1
      from public.employees target
      where target.id = p_employee_id
        and target.team_id = v_caller_team_id
        and target.position_id = v_caller_position_id
    );
  end if;

  if v_scope = 'all' then return true; end if;
  if v_scope = 'assigned_teams' then
    return exists (
      select 1
      from public.employees target
      where target.id = p_employee_id
        and (
          exists (
            select 1 from public.user_scope_employees scoped_employee
            where scoped_employee.auth_user_id = v_user_id
              and scoped_employee.employee_id = target.id
          )
          or exists (
            select 1 from public.user_scope_teams scoped_team
            where scoped_team.auth_user_id = v_user_id
              and scoped_team.team_id = target.team_id
          )
        )
    );
  end if;
  return false;
end;
$$;

comment on function public.backend_employee_in_scope(uuid) is
  'Current admin lease scope: linked users are self plus same team and position across groups; unlinked founder/all/assigned scopes retain their configured behavior.';
revoke all on function public.backend_employee_in_scope(uuid)
  from public, anon;
grant execute on function public.backend_employee_in_scope(uuid)
  to authenticated, service_role;

create or replace function public.online_training_employee_in_scope(p_employee_id uuid)
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

  return public.backend_employee_in_scope(p_employee_id);
end;
$$;

revoke all on function public.online_training_employee_in_scope(uuid)
  from public, anon;
grant execute on function public.online_training_employee_in_scope(uuid)
  to authenticated, service_role;

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

create or replace function public.online_training_can_edit_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select session_private.current_app_session_is_valid('admin')
    and exists (
      select 1
      from public.online_training_reports report
      where report.id = p_report_id
        and (
          report.created_by = (select auth.uid())
          or public.has_permission('online_training.manage')
        )
        and (
          public.online_training_employee_in_scope(report.author_employee_id)
          or exists (
            select 1
            from public.online_training_report_members member
            where member.report_id = report.id
              and public.online_training_employee_in_scope(member.employee_id)
          )
        )
    );
$$;

revoke all on function public.online_training_can_view_report(uuid)
  from public, anon;
revoke all on function public.online_training_can_edit_report(uuid)
  from public, anon;
grant execute on function public.online_training_can_view_report(uuid)
  to authenticated, service_role;
grant execute on function public.online_training_can_edit_report(uuid)
  to authenticated, service_role;

-- RLS must apply the employee predicate to every returned member row. A
-- manage permission changes available actions, not the caller's data scope.
drop policy if exists online_training_members_read
  on public.online_training_report_members;
create policy online_training_members_read
on public.online_training_report_members
for select
to authenticated
using (
  public.online_training_can_view_report(report_id)
  and public.online_training_employee_in_scope(employee_id)
);

-- Owners may delete their temporary uploads. Managers may delete another
-- report's object only when that report is inside their live organization
-- scope; knowing a storage path is never enough to cross that boundary.
drop policy if exists online_training_storage_delete on storage.objects;
create policy online_training_storage_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'online-training'
  and session_private.current_app_session_is_valid('admin')
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or case
      when coalesce((storage.foldername(name))[2], '')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then public.online_training_can_edit_report(
        ((storage.foldername(name))[2])::uuid
      )
      else false
    end
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
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_scope text;
  v_caller_team_id uuid;
  v_caller_position_id uuid;
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

  -- The business day is Manila time.  Future input is clamped to today.  If
  -- only an end date is supplied, use the start of that end date's month;
  -- otherwise the natural defaults are the current month start through today.
  v_effective_to := least(coalesce(v_requested_to, v_business_today), v_business_today);
  v_effective_from := case
    when v_requested_from is not null
      then least(v_requested_from, v_business_today)
    else date_trunc('month', v_effective_to)::date
  end;
  if v_effective_from > v_effective_to then
    raise exception '有效日期起不能晚于有效日期止';
  end if;

  select
    access.employee_id,
    access.data_scope,
    employee.team_id,
    employee.position_id
  into
    v_caller_employee_id,
    v_scope,
    v_caller_team_id,
    v_caller_position_id
  from public.user_access access
  left join public.employees employee on employee.id = access.employee_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then
    raise exception '当前账号没有有效后台权限';
  end if;
  v_is_founder := public.is_founder();

  with source_rows as materialized (
    select roster.item
    from public.report_sheet_snapshots snapshot
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(snapshot.payload) = 'array'
        then snapshot.payload else '[]'::jsonb end
    ) roster(item)
    where snapshot.source = '居家排班表/填表'
  ), allowed_employee_ids as materialized (
    select employee.id employee_id
    from public.employees employee
    where public.backend_employee_in_scope(employee.id)
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
    join allowed_employee_ids allowed
      on allowed.employee_id = employee.id
    left join public.teams team on team.id = employee.team_id
    left join public.positions pos on pos.id = employee.position_id
    -- Only active and probation employees are currently expected to submit a
    -- training daily report. Suspended/resigned people remain history-only.
    where employee.status in ('active', 'probation')
      and nullif(
        public.online_training_identity_key(schedule_row.item->>'online_trainer'),
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
      and (
        allowed_member.employee_id is not null
        or v_is_founder
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
      -- Current roster values and every visible historical member snapshot
      -- are independent match sources. A recent reassignment is searchable
      -- immediately, while an older trainer/organization remains searchable.
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
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer),
    'effective_from', v_effective_from,
    'effective_to', v_effective_to,
    'business_today', v_business_today
  );
end;
$$;

comment on function public.online_training_search_people(jsonb, integer, integer) is
  'Lists zero-report and historical training people while enforcing same-team and same-position scope across groups for linked backend accounts.';
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
  if v_date_from is not null and v_date_to is not null and v_date_from > v_date_to then
    raise exception '日期起不能晚于日期止';
  end if;

  with visible as materialized (
    select r.*
    from public.online_training_reports r
    where r.status = 'published'
      and public.online_training_can_view_report(r.id)
      and (v_date_from is null or r.report_date >= v_date_from)
      and (v_date_to is null or r.report_date <= v_date_to)
      and (
        v_trainer = ''
        or lower(concat_ws(' ', r.author_name, r.author_employee_no, r.trainer_name)) like '%' || v_trainer || '%'
        or exists (
          select 1 from public.online_training_report_members tm
          where tm.report_id = r.id
            and public.online_training_employee_in_scope(tm.employee_id)
            and lower(coalesce(tm.trainer_name, '')) like '%' || v_trainer || '%'
        )
      )
      and (
        (v_employee_no = '' and v_employee_name = '' and v_team = '' and v_group = ''
          and v_position = '' and v_shift = '' and v_platform = '' and v_attendance = '')
        or exists (
          select 1
          from public.online_training_report_members m
          where m.report_id = r.id
            and public.online_training_employee_in_scope(m.employee_id)
            and (v_employee_no = '' or lower(coalesce(m.employee_no, '')) like '%' || v_employee_no || '%')
            and (v_employee_name = '' or lower(coalesce(m.employee_name, '')) like '%' || v_employee_name || '%')
            and (v_team = '' or lower(btrim(coalesce(m.team_name, ''))) = v_team)
            and (v_group = '' or lower(btrim(coalesce(m.group_name, ''))) = v_group)
            and (v_position = '' or lower(btrim(coalesce(m.position_name, ''))) = v_position)
            and (v_shift = '' or lower(btrim(coalesce(m.shift_name, ''))) = v_shift)
            and (v_platform = '' or lower(btrim(coalesce(m.platform, ''))) = v_platform)
            and (v_attendance = '' or lower(coalesce(m.attendance_status, '')) = v_attendance)
        )
      )
      and (
        v_keyword = ''
        or lower(concat_ws(' ', r.title, r.platform, r.shift_name, r.team_name, r.group_name,
          r.leader_name, r.trainer_name, r.course_type, r.report_summary, r.issues_summary, r.next_plan))
          like '%' || v_keyword || '%'
        or exists (
          select 1
          from public.online_training_report_members km
          where km.report_id = r.id
            and public.online_training_employee_in_scope(km.employee_id)
            and lower(concat_ws(' ', km.employee_no, km.employee_name, km.position_name,
              km.team_name, km.group_name, km.shift_name, km.platform, km.status_note,
              km.work_details, km.performance, km.issues, km.follow_up, km.metrics::text))
              like '%' || v_keyword || '%'
        )
      )
  )
  select
    (select count(*)::integer from visible),
    coalesce((
      select jsonb_agg(
        to_jsonb(v)
        || jsonb_build_object(
          'can_edit', public.online_training_can_edit_report(v.id),
          'can_review', public.online_training_can_review_report(v.id),
          'members', coalesce((
            select jsonb_agg(to_jsonb(m) order by m.sort_order, m.employee_name)
            from public.online_training_report_members m
            where m.report_id = v.id
              and public.online_training_employee_in_scope(m.employee_id)
          ), '[]'::jsonb)
        )
        order by v.report_date desc, v.created_at desc
      )
      from (
        select * from visible
        order by report_date desc, created_at desc
        offset (v_page - 1) * v_page_size
        limit v_page_size
      ) v
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
  'Lists training reports and members within the caller live same-team and same-position scope across groups.';
revoke all on function public.online_training_search_reports(jsonb, integer, integer)
  from public, anon;
grant execute on function public.online_training_search_reports(jsonb, integer, integer)
  to authenticated;


-- Daily-work visibility uses the report author employee (with creator linkage
-- as the primary identity) and therefore follows the same live organization
-- scope even when a linked account changes groups.
create or replace function public.daily_work_report_in_scope(
  p_created_by uuid,
  p_author_employee_no text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_target_employee_id uuid;
begin
  if not public.daily_work_is_active_backend() then return false; end if;
  if p_created_by = v_user_id then return true; end if;
  if public.is_founder() then return true; end if;

  select coalesce(creator_access.employee_id, author_employee.id)
  into v_target_employee_id
  from (select 1) seed
  left join public.user_access creator_access
    on creator_access.auth_user_id = p_created_by
  left join public.employees author_employee
    on lower(btrim(author_employee.employee_no)) = lower(btrim(coalesce(p_author_employee_no, '')))
  order by creator_access.updated_at desc nulls last
  limit 1;

  if v_target_employee_id is not null then
    return public.backend_employee_in_scope(v_target_employee_id);
  end if;

  -- Legacy reports without an author identity remain visible only to an
  -- unlinked account that explicitly has organization-wide scope.
  return exists (
    select 1
    from public.user_access access
    where access.auth_user_id = v_user_id
      and access.active = true
      and access.backend_enabled = true
      and access.employee_id is null
      and access.data_scope = 'all'
  );
end;
$$;

revoke all on function public.daily_work_report_in_scope(uuid, text)
  from public, anon;
grant execute on function public.daily_work_report_in_scope(uuid, text)
  to authenticated, service_role;

drop policy if exists daily_work_read_all_backend on public.daily_work_reports;
create policy daily_work_read_all_backend
on public.daily_work_reports
for select
to authenticated
using (
  public.daily_work_report_in_scope(created_by, author_employee_no)
);

drop policy if exists daily_work_update_owner_or_manager on public.daily_work_reports;
create policy daily_work_update_owner_or_manager
on public.daily_work_reports
for update
to authenticated
using (
  public.daily_work_is_active_backend()
  and (
    created_by = (select auth.uid())
    or (
      public.has_permission('daily_work.manage')
      and public.daily_work_report_in_scope(created_by, author_employee_no)
    )
  )
)
with check (
  public.daily_work_is_active_backend()
  and (
    created_by = (select auth.uid())
    or (
      public.has_permission('daily_work.manage')
      and public.daily_work_report_in_scope(created_by, author_employee_no)
    )
  )
);

-- A report owner may edit the report body, but must never be able to move an
-- existing report to another account or employee by crafting a direct API
-- request.  Those two columns are the identity inputs used by the scope
-- policies above, so keep them immutable after insert.
create or replace function public.daily_work_preserve_report_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by
    or new.author_employee_no is distinct from old.author_employee_no
  then
    raise exception 'daily_work_report_identity_immutable';
  end if;

  return new;
end;
$$;

revoke all on function public.daily_work_preserve_report_identity()
  from public, anon, authenticated;

drop trigger if exists daily_work_preserve_report_identity
  on public.daily_work_reports;
create trigger daily_work_preserve_report_identity
before update of created_by, author_employee_no
on public.daily_work_reports
for each row
execute function public.daily_work_preserve_report_identity();

drop policy if exists daily_work_delete_owner_or_manager on public.daily_work_reports;
create policy daily_work_delete_owner_or_manager
on public.daily_work_reports
for delete
to authenticated
using (
  public.daily_work_is_active_backend()
  and (
    created_by = (select auth.uid())
    or (
      public.has_permission('daily_work.manage')
      and public.daily_work_report_in_scope(created_by, author_employee_no)
    )
  )
);

drop policy if exists daily_work_storage_read on storage.objects;
create policy daily_work_storage_read
on storage.objects
for select
to authenticated
using (
  bucket_id = 'daily-work'
  and public.daily_work_is_active_backend()
  and (
    owner_id = (select auth.uid())::text
    or exists (
      select 1
      from public.daily_work_reports report,
           jsonb_array_elements(
             case when jsonb_typeof(report.attachments) = 'array'
               then report.attachments else '[]'::jsonb end
           ) attachment
      where attachment->>'path' = storage.objects.name
        and public.daily_work_report_in_scope(
          report.created_by,
          report.author_employee_no
        )
    )
  )
);

drop policy if exists daily_work_storage_delete on storage.objects;
create policy daily_work_storage_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'daily-work'
  and public.daily_work_is_active_backend()
  and (
    owner_id = (select auth.uid())::text
    or (
      public.has_permission('daily_work.manage')
      and exists (
        select 1
        from public.daily_work_reports report,
             jsonb_array_elements(
               case when jsonb_typeof(report.attachments) = 'array'
                 then report.attachments else '[]'::jsonb end
             ) attachment
        where attachment->>'path' = storage.objects.name
          and public.daily_work_report_in_scope(
            report.created_by,
            report.author_employee_no
          )
      )
    )
  )
);

commit;
