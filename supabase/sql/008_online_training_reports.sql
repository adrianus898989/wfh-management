-- Structured online-training daily reports with roster-linked members and safe profile access.

insert into public.permissions (code, name, category, sensitive)
values
  ('online_training.view', '线上培训 · 查看范围内日报', 'online_training', false),
  ('online_training.submit', '线上培训 · 提交自己的日报', 'online_training', false),
  ('online_training.review', '线上培训 · 批注范围内日报', 'online_training', false),
  ('online_training.manage', '线上培训 · 管理全部日报', 'online_training', true)
on conflict (code) do update
set name = excluded.name,
    category = excluded.category,
    sensitive = excluded.sensitive;

insert into public.roles (code, name, backend_allowed, is_system, system_locked, active)
values ('senior_team_leader', '大组长', true, false, false, true)
on conflict (code) do update
set name = excluded.name,
    backend_allowed = true,
    active = true;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in ('online_training.view', 'online_training.submit')
where r.code in ('supervisor', 'team_leader', 'senior_team_leader', 'trainer')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'online_training.review'
where r.code in ('supervisor', 'team_leader', 'senior_team_leader')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in ('employee.view', 'team.view', 'schedule.view', 'report.view')
where r.code = 'senior_team_leader'
on conflict do nothing;

create table if not exists public.online_training_reports (
  id uuid primary key default gen_random_uuid(),
  report_date date not null default current_date,
  title text not null,
  platform text not null default '',
  shift_name text not null default '',
  team_name text not null default '',
  group_name text not null default '',
  leader_name text not null default '',
  trainer_name text not null default '',
  course_type text not null default '',
  report_summary text not null default '',
  issues_summary text not null default '',
  next_plan text not null default '',
  roster_source text not null default '居家排班表/填表',
  roster_synced_at timestamptz,
  attachments jsonb not null default '[]'::jsonb,
  status text not null default 'published'
    check (status in ('published', 'archived')),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'read', 'needs_changes')),
  review_note text not null default '',
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_by uuid not null,
  updated_by uuid,
  author_employee_id uuid references public.employees(id) on delete set null,
  author_name text not null default '',
  author_employee_no text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid,
  constraint online_training_title_check
    check (char_length(btrim(title)) between 2 and 160),
  constraint online_training_attachments_check
    check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 12)
);

create table if not exists public.online_training_report_members (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.online_training_reports(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,
  employee_no text not null,
  employee_name text not null,
  position_name text not null default '',
  team_name text not null default '',
  group_name text not null default '',
  shift_name text not null default '',
  platform text not null default '',
  leader_name text not null default '',
  trainer_name text not null default '',
  attendance_status text not null default 'normal'
    check (attendance_status in ('normal', 'rest', 'leave', 'absent', 'transferred')),
  status_note text not null default '',
  work_details text not null default '',
  performance text not null default '',
  issues text not null default '',
  follow_up text not null default '',
  metrics jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metrics) = 'object'),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_id, employee_no)
);

create index if not exists online_training_reports_date_idx
  on public.online_training_reports (report_date desc, created_at desc)
  where status = 'published';
create index if not exists online_training_reports_creator_idx
  on public.online_training_reports (created_by, report_date desc);
create index if not exists online_training_reports_author_employee_idx
  on public.online_training_reports (author_employee_id, report_date desc)
  where author_employee_id is not null;
create index if not exists online_training_members_employee_idx
  on public.online_training_report_members (employee_id, report_id);
create index if not exists online_training_members_employee_no_idx
  on public.online_training_report_members (upper(employee_no), report_id);
create index if not exists online_training_members_name_idx
  on public.online_training_report_members (lower(employee_name), report_id);

comment on table public.online_training_reports is
  'One published online-training daily report. Member details are normalized in online_training_report_members.';
comment on table public.online_training_report_members is
  'Roster snapshot and daily training detail for one employee. Sensitive employee data is intentionally excluded.';

create or replace function public.online_training_is_active_backend()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_access ua
    where ua.auth_user_id = (select auth.uid())
      and ua.active = true
      and ua.backend_enabled = true
  );
$$;

create or replace function public.online_training_can_view_module()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.online_training_is_active_backend()
    and (
      public.has_permission('online_training.view')
      or public.has_permission('online_training.submit')
      or public.has_permission('online_training.review')
      or public.has_permission('online_training.manage')
    );
$$;

create or replace function public.online_training_employee_in_scope(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_scope text;
  v_caller_team_id uuid;
begin
  if p_employee_id is null or not public.online_training_can_view_module() then
    return false;
  end if;

  select ua.employee_id, ua.data_scope, e.team_id
  into v_caller_employee_id, v_scope, v_caller_team_id
  from public.user_access ua
  left join public.employees e on e.id = ua.employee_id
  where ua.auth_user_id = v_user_id
    and ua.active = true
    and ua.backend_enabled = true;

  if public.is_founder()
     or public.has_permission('online_training.manage')
     or v_scope = 'all' then
    return true;
  end if;

  if p_employee_id = v_caller_employee_id then
    return true;
  end if;

  if v_scope = 'assigned' then
    return exists (
      select 1
      from public.employees e
      where e.id = p_employee_id
        and (
          exists (
            select 1 from public.user_scope_employees se
            where se.auth_user_id = v_user_id and se.employee_id = e.id
          )
          or exists (
            select 1 from public.user_scope_teams st
            where st.auth_user_id = v_user_id and st.team_id = e.team_id
          )
        )
    );
  end if;

  if v_scope = 'own_team' and v_caller_team_id is not null then
    return exists (
      select 1 from public.employees e
      where e.id = p_employee_id and e.team_id = v_caller_team_id
    );
  end if;

  return false;
end;
$$;

create or replace function public.online_training_can_view_report(p_report_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_created_by uuid;
  v_status text;
begin
  if not public.online_training_can_view_module() then return false; end if;

  select r.created_by, r.status into v_created_by, v_status
  from public.online_training_reports r
  where r.id = p_report_id;

  if not found then return false; end if;

  if public.is_founder()
     or public.has_permission('online_training.manage')
     or v_created_by = (select auth.uid()) then
    return true;
  end if;

  if v_status <> 'published' then return false; end if;

  return exists (
    select 1
    from public.online_training_report_members m
    where m.report_id = p_report_id
      and public.online_training_employee_in_scope(m.employee_id)
  );
end;
$$;

create or replace function public.online_training_can_edit_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.online_training_is_active_backend()
    and exists (
      select 1 from public.online_training_reports r
      where r.id = p_report_id
        and (
          r.created_by = (select auth.uid())
          or public.has_permission('online_training.manage')
        )
    );
$$;

create or replace function public.online_training_can_review_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.online_training_can_view_report(p_report_id)
    and (
      public.has_permission('online_training.review')
      or public.has_permission('online_training.manage')
    );
$$;

create or replace function public.online_training_bootstrap()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text;
  v_employee_name text;
  v_login_username text;
  v_role_code text;
  v_scope text;
  v_team_id uuid;
  v_can_submit boolean;
  v_can_review boolean;
  v_can_manage boolean;
  v_roster jsonb;
  v_manager_options jsonb;
  v_synced_at timestamptz;
begin
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;

  select ua.employee_id, e.employee_no, e.full_name, ua.login_username,
         r.code, ua.data_scope, e.team_id
  into v_employee_id, v_employee_no, v_employee_name, v_login_username,
       v_role_code, v_scope, v_team_id
  from public.user_access ua
  join public.roles r on r.id = ua.role_id
  left join public.employees e on e.id = ua.employee_id
  where ua.auth_user_id = v_user_id
    and ua.active = true
    and ua.backend_enabled = true;

  v_can_submit := public.has_permission('online_training.submit')
                  or public.has_permission('online_training.manage');
  v_can_review := public.has_permission('online_training.review');
  v_can_manage := public.has_permission('online_training.manage');

  select s.synced_at into v_synced_at
  from public.report_sheet_snapshots s
  where s.source = '居家排班表/填表';

  with scoped as (
    select
      e.id,
      e.employee_no,
      e.full_name,
      e.status,
      coalesce(e.country, e.nationality, '') as country,
      coalesce(p.name, e.schedule_position, '') as position_name,
      coalesce(t.name, '') as team_name,
      coalesce(e.group_name, '') as group_name,
      coalesce(e.shift_name, e.legacy_shift_name, '') as shift_name,
      coalesce(e.platform_scope, '') as platform,
      coalesce(e.work_content, '') as work_content,
      coalesce(e.person_in_charge, e.leader_name, '') as responsible,
      coalesce(e.on_site_trainer, '') as onsite_trainer,
      coalesce(e.online_leader, '') as online_leader,
      coalesce(e.online_trainer, e.trainer_name, '') as online_trainer
    from public.employees e
    left join public.teams t on t.id = e.team_id
    left join public.positions p on p.id = e.position_id
    where e.status = 'active'
      and (
        public.is_founder()
        or v_can_manage
        or v_scope = 'all'
        or e.id = v_employee_id
        or (
          v_scope = 'assigned'
          and (
            exists (
              select 1 from public.user_scope_employees se
              where se.auth_user_id = v_user_id and se.employee_id = e.id
            )
            or exists (
              select 1 from public.user_scope_teams st
              where st.auth_user_id = v_user_id and st.team_id = e.team_id
            )
          )
        )
        or (v_scope = 'own_team' and v_team_id is not null and e.team_id = v_team_id)
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'employee_no', employee_no,
    'full_name', full_name,
    'status', status,
    'country', country,
    'position', position_name,
    'team', team_name,
    'group', group_name,
    'shift', shift_name,
    'platform', platform,
    'work_content', work_content,
    'responsible', responsible,
    'onsite_trainer', onsite_trainer,
    'online_leader', online_leader,
    'online_trainer', online_trainer
  ) order by team_name, group_name, position_name, full_name), '[]'::jsonb)
  into v_roster
  from scoped;

  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
  into v_manager_options
  from (
    select distinct btrim(manager_value) as value
    from jsonb_array_elements(v_roster) as roster_row(item)
    cross join lateral unnest(array[
      roster_row.item->>'responsible',
      roster_row.item->>'online_leader',
      roster_row.item->>'online_trainer'
    ]) as manager_values(manager_value)
    where nullif(btrim(manager_value), '') is not null
  ) managers;

  return jsonb_build_object(
    'access', jsonb_build_object(
      'user_id', v_user_id,
      'employee_id', v_employee_id,
      'employee_no', coalesce(v_employee_no, ''),
      'employee_name', coalesce(v_employee_name, ''),
      'login_username', coalesce(v_login_username, ''),
      'role_code', coalesce(v_role_code, ''),
      'data_scope', coalesce(v_scope, ''),
      'can_submit', v_can_submit,
      'can_review', v_can_review,
      'can_manage', v_can_manage,
      'is_founder', public.is_founder()
    ),
    'identity_aliases', to_jsonb(array_remove(array[
      nullif(v_employee_no, ''),
      nullif(v_employee_name, ''),
      nullif(v_login_username, '')
    ], null)),
    'roster', v_roster,
    'manager_options', v_manager_options,
    'roster_synced_at', v_synced_at
  );
end;
$$;

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
set search_path = public
as $$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 12), 1), 50);
  v_total integer;
  v_rows jsonb;
begin
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;

  with visible as (
    select r.*
    from public.online_training_reports r
    where r.status = 'published'
      and public.online_training_can_view_report(r.id)
      and (p_date_from is null or r.report_date >= p_date_from)
      and (p_date_to is null or r.report_date <= p_date_to)
      and (
        p_employee_id is null
        or exists (
          select 1 from public.online_training_report_members m
          where m.report_id = r.id and m.employee_id = p_employee_id
        )
      )
      and (
        v_query = ''
        or lower(concat_ws(' ', r.title, r.platform, r.shift_name, r.team_name,
          r.group_name, r.leader_name, r.trainer_name, r.course_type,
          r.report_summary, r.issues_summary, r.next_plan)) like '%' || v_query || '%'
        or exists (
          select 1 from public.online_training_report_members m
          where m.report_id = r.id
            and (
              r.created_by = (select auth.uid())
              or public.has_permission('online_training.manage')
              or public.online_training_employee_in_scope(m.employee_id)
            )
            and lower(concat_ws(' ', m.employee_no, m.employee_name, m.position_name,
              m.team_name, m.group_name, m.shift_name, m.platform,
              m.work_details, m.performance, m.issues, m.follow_up)) like '%' || v_query || '%'
        )
      )
  )
  select count(*) into v_total from visible;

  with visible as (
    select r.*
    from public.online_training_reports r
    where r.status = 'published'
      and public.online_training_can_view_report(r.id)
      and (p_date_from is null or r.report_date >= p_date_from)
      and (p_date_to is null or r.report_date <= p_date_to)
      and (
        p_employee_id is null
        or exists (
          select 1 from public.online_training_report_members m
          where m.report_id = r.id and m.employee_id = p_employee_id
        )
      )
      and (
        v_query = ''
        or lower(concat_ws(' ', r.title, r.platform, r.shift_name, r.team_name,
          r.group_name, r.leader_name, r.trainer_name, r.course_type,
          r.report_summary, r.issues_summary, r.next_plan)) like '%' || v_query || '%'
        or exists (
          select 1 from public.online_training_report_members m
          where m.report_id = r.id
            and (
              r.created_by = (select auth.uid())
              or public.has_permission('online_training.manage')
              or public.online_training_employee_in_scope(m.employee_id)
            )
            and lower(concat_ws(' ', m.employee_no, m.employee_name, m.position_name,
              m.team_name, m.group_name, m.shift_name, m.platform,
              m.work_details, m.performance, m.issues, m.follow_up)) like '%' || v_query || '%'
        )
      )
    order by r.report_date desc, r.created_at desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select coalesce(jsonb_agg(
    to_jsonb(v)
    || jsonb_build_object(
      'can_edit', public.online_training_can_edit_report(v.id),
      'can_review', public.online_training_can_review_report(v.id),
      'members', coalesce((
        select jsonb_agg(to_jsonb(m) order by m.sort_order, m.employee_name)
        from public.online_training_report_members m
        where m.report_id = v.id
          and (
            v.created_by = (select auth.uid())
            or public.has_permission('online_training.manage')
            or public.online_training_employee_in_scope(m.employee_id)
          )
      ), '[]'::jsonb)
    )
    order by v.report_date desc, v.created_at desc
  ), '[]'::jsonb)
  into v_rows
  from visible v;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer)
  );
end;
$$;

create or replace function public.online_training_people_search(
  p_query text default '',
  p_date_from date default null,
  p_date_to date default null,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 50);
  v_total integer;
  v_rows jsonb;
begin
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;

  with people as (
    select
      m.employee_id,
      (array_agg(m.employee_no order by r.report_date desc, r.created_at desc))[1] as employee_no,
      (array_agg(m.employee_name order by r.report_date desc, r.created_at desc))[1] as employee_name,
      (array_agg(m.position_name order by r.report_date desc, r.created_at desc))[1] as position_name,
      (array_agg(m.team_name order by r.report_date desc, r.created_at desc))[1] as team_name,
      (array_agg(m.group_name order by r.report_date desc, r.created_at desc))[1] as group_name,
      (array_agg(m.shift_name order by r.report_date desc, r.created_at desc))[1] as shift_name,
      count(distinct r.id)::integer as report_count,
      count(*) filter (where m.attendance_status = 'normal')::integer as normal_count,
      count(*) filter (where m.attendance_status = 'leave')::integer as leave_count,
      count(*) filter (where m.attendance_status = 'rest')::integer as rest_count,
      count(*) filter (where m.attendance_status = 'absent')::integer as absent_count,
      count(*) filter (where m.attendance_status = 'transferred')::integer as home_count,
      count(*) filter (where nullif(btrim(m.issues), '') is not null)::integer as issue_count,
      max(r.report_date) as last_report_date
    from public.online_training_report_members m
    join public.online_training_reports r on r.id = m.report_id
    where r.status = 'published'
      and public.online_training_can_view_report(r.id)
      and public.online_training_employee_in_scope(m.employee_id)
      and (p_date_from is null or r.report_date >= p_date_from)
      and (p_date_to is null or r.report_date <= p_date_to)
      and (
        v_query = ''
        or lower(m.employee_no) like '%' || v_query || '%'
        or lower(m.employee_name) like '%' || v_query || '%'
      )
    group by m.employee_id
  )
  select count(*) into v_total from people;

  with people as (
    select
      m.employee_id,
      (array_agg(m.employee_no order by r.report_date desc, r.created_at desc))[1] as employee_no,
      (array_agg(m.employee_name order by r.report_date desc, r.created_at desc))[1] as employee_name,
      (array_agg(m.position_name order by r.report_date desc, r.created_at desc))[1] as position_name,
      (array_agg(m.team_name order by r.report_date desc, r.created_at desc))[1] as team_name,
      (array_agg(m.group_name order by r.report_date desc, r.created_at desc))[1] as group_name,
      (array_agg(m.shift_name order by r.report_date desc, r.created_at desc))[1] as shift_name,
      count(distinct r.id)::integer as report_count,
      count(*) filter (where m.attendance_status = 'normal')::integer as normal_count,
      count(*) filter (where m.attendance_status = 'leave')::integer as leave_count,
      count(*) filter (where m.attendance_status = 'rest')::integer as rest_count,
      count(*) filter (where m.attendance_status = 'absent')::integer as absent_count,
      count(*) filter (where m.attendance_status = 'transferred')::integer as home_count,
      count(*) filter (where nullif(btrim(m.issues), '') is not null)::integer as issue_count,
      max(r.report_date) as last_report_date
    from public.online_training_report_members m
    join public.online_training_reports r on r.id = m.report_id
    where r.status = 'published'
      and public.online_training_can_view_report(r.id)
      and public.online_training_employee_in_scope(m.employee_id)
      and (p_date_from is null or r.report_date >= p_date_from)
      and (p_date_to is null or r.report_date <= p_date_to)
      and (
        v_query = ''
        or lower(m.employee_no) like '%' || v_query || '%'
        or lower(m.employee_name) like '%' || v_query || '%'
      )
    group by m.employee_id
    order by max(r.report_date) desc, employee_name
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select coalesce(jsonb_agg(to_jsonb(p) order by p.last_report_date desc, p.employee_name), '[]'::jsonb)
  into v_rows
  from people p;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer)
  );
end;
$$;

create or replace function public.online_training_employee_profile(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.online_training_can_view_module()
     or not public.online_training_employee_in_scope(p_employee_id) then
    raise exception '无权查看该员工基础档案';
  end if;

  select jsonb_build_object(
    'id', e.id,
    'employee_no', e.employee_no,
    'full_name', e.full_name,
    'status', e.status,
    'country', coalesce(e.country, e.nationality, ''),
    'employment_type', coalesce(e.employment_type, ''),
    'hire_date', e.hire_date,
    'team', coalesce(t.name, ''),
    'position', coalesce(p.name, e.schedule_position, ''),
    'group', coalesce(e.group_name, ''),
    'shift', coalesce(e.shift_name, e.legacy_shift_name, ''),
    'platform', coalesce(e.platform_scope, ''),
    'work_content', coalesce(e.work_content, ''),
    'responsible', coalesce(e.person_in_charge, e.leader_name, ''),
    'onsite_trainer', coalesce(e.on_site_trainer, ''),
    'online_leader', coalesce(e.online_leader, ''),
    'online_trainer', coalesce(e.online_trainer, e.trainer_name, ''),
    'sensitive_fields_hidden', true
  )
  into v_result
  from public.employees e
  left join public.teams t on t.id = e.team_id
  left join public.positions p on p.id = e.position_id
  where e.id = p_employee_id;

  if v_result is null then raise exception '员工档案不存在'; end if;
  return v_result;
end;
$$;

create or replace function public.online_training_save_report(p_report jsonb, p_members jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_report_id uuid;
  v_existing public.online_training_reports;
  v_author_employee_id uuid;
  v_author_name text;
  v_author_employee_no text;
  v_report_date date;
  v_title text;
  v_attachments jsonb;
  v_roster_synced_at timestamptz;
  v_member jsonb;
  v_employee public.employees;
  v_employee_position text;
  v_employee_team text;
  v_attendance text;
  v_member_count integer := 0;
begin
  if not public.online_training_is_active_backend()
     or not (
       public.has_permission('online_training.submit')
       or public.has_permission('online_training.manage')
     ) then
    raise exception '当前账号没有线上培训提交权限';
  end if;

  if jsonb_typeof(p_report) <> 'object' or jsonb_typeof(p_members) <> 'array' then
    raise exception '报告数据格式不正确';
  end if;

  if jsonb_array_length(p_members) = 0 then
    raise exception '请从居家排班表载入至少一名员工';
  end if;

  v_report_id := coalesce(nullif(p_report->>'id', '')::uuid, gen_random_uuid());
  v_report_date := coalesce(nullif(p_report->>'report_date', '')::date, current_date);
  v_title := btrim(coalesce(nullif(p_report->>'title', ''), '线上培训日报 · ' || v_report_date::text));
  v_attachments := coalesce(p_report->'attachments', '[]'::jsonb);

  if char_length(v_title) < 2 or char_length(v_title) > 160 then
    raise exception '报告标题长度不正确';
  end if;
  if jsonb_typeof(v_attachments) <> 'array' or jsonb_array_length(v_attachments) > 12 then
    raise exception '每份报告最多上传12张截图';
  end if;

  select * into v_existing
  from public.online_training_reports
  where id = v_report_id;

  if found and not public.online_training_can_edit_report(v_report_id) then
    raise exception '无权编辑该报告';
  end if;

  select ua.employee_id,
         coalesce(nullif(btrim(e.full_name), ''), nullif(btrim(ua.login_username), ''), '后台用户'),
         coalesce(nullif(btrim(e.employee_no), ''), '')
  into v_author_employee_id, v_author_name, v_author_employee_no
  from public.user_access ua
  left join public.employees e on e.id = ua.employee_id
  where ua.auth_user_id = v_user_id;

  select synced_at into v_roster_synced_at
  from public.report_sheet_snapshots
  where source = '居家排班表/填表';

  if v_existing.id is null then
    insert into public.online_training_reports (
      id, report_date, title, platform, shift_name, team_name, group_name,
      leader_name, trainer_name, course_type, report_summary, issues_summary,
      next_plan, roster_synced_at, attachments, status, created_by, updated_by,
      author_employee_id, author_name, author_employee_no
    ) values (
      v_report_id, v_report_date, v_title,
      btrim(coalesce(p_report->>'platform', '')),
      btrim(coalesce(p_report->>'shift_name', '')),
      btrim(coalesce(p_report->>'team_name', '')),
      btrim(coalesce(p_report->>'group_name', '')),
      btrim(coalesce(p_report->>'leader_name', '')),
      btrim(coalesce(p_report->>'trainer_name', '')),
      btrim(coalesce(p_report->>'course_type', '')),
      btrim(coalesce(p_report->>'report_summary', '')),
      btrim(coalesce(p_report->>'issues_summary', '')),
      btrim(coalesce(p_report->>'next_plan', '')),
      v_roster_synced_at, v_attachments, 'published', v_user_id, v_user_id,
      v_author_employee_id, coalesce(v_author_name, '后台用户'), coalesce(v_author_employee_no, '')
    );
  else
    update public.online_training_reports
    set report_date = v_report_date,
        title = v_title,
        platform = btrim(coalesce(p_report->>'platform', '')),
        shift_name = btrim(coalesce(p_report->>'shift_name', '')),
        team_name = btrim(coalesce(p_report->>'team_name', '')),
        group_name = btrim(coalesce(p_report->>'group_name', '')),
        leader_name = btrim(coalesce(p_report->>'leader_name', '')),
        trainer_name = btrim(coalesce(p_report->>'trainer_name', '')),
        course_type = btrim(coalesce(p_report->>'course_type', '')),
        report_summary = btrim(coalesce(p_report->>'report_summary', '')),
        issues_summary = btrim(coalesce(p_report->>'issues_summary', '')),
        next_plan = btrim(coalesce(p_report->>'next_plan', '')),
        roster_synced_at = coalesce(v_roster_synced_at, roster_synced_at),
        attachments = v_attachments,
        status = 'published',
        updated_by = v_user_id,
        updated_at = now(),
        archived_at = null,
        archived_by = null
    where id = v_report_id;

    delete from public.online_training_report_members where report_id = v_report_id;
  end if;

  for v_member in select value from jsonb_array_elements(p_members)
  loop
    if nullif(v_member->>'employee_id', '') is null then
      raise exception '报告成员缺少员工档案关联';
    end if;

    select * into v_employee
    from public.employees
    where id = (v_member->>'employee_id')::uuid and status = 'active';

    if not found then raise exception '报告成员不存在或已离职'; end if;
    if not public.online_training_employee_in_scope(v_employee.id)
       and not public.has_permission('online_training.manage') then
      raise exception '报告中包含超出管理范围的员工';
    end if;

    v_attendance := coalesce(nullif(v_member->>'attendance_status', ''), 'normal');
    if v_attendance not in ('normal', 'rest', 'leave', 'absent', 'transferred') then
      raise exception '员工当日状态不正确';
    end if;

    if v_attendance = 'normal'
       and nullif(btrim(concat_ws('', v_member->>'work_details', v_member->>'performance',
         v_member->>'issues', v_member->>'follow_up')), '') is null then
      raise exception '% 的正常上班记录尚未填写', v_employee.employee_no;
    end if;

    if v_attendance in ('leave', 'absent', 'transferred')
       and nullif(btrim(coalesce(v_member->>'status_note', '')), '') is null then
      raise exception '% 的状态需要填写批注', v_employee.employee_no;
    end if;

    select coalesce(p.name, v_employee.schedule_position, ''), coalesce(t.name, '')
    into v_employee_position, v_employee_team
    from public.employees e
    left join public.positions p on p.id = e.position_id
    left join public.teams t on t.id = e.team_id
    where e.id = v_employee.id;

    insert into public.online_training_report_members (
      report_id, employee_id, employee_no, employee_name, position_name,
      team_name, group_name, shift_name, platform, leader_name, trainer_name,
      attendance_status, status_note, work_details, performance, issues,
      follow_up, metrics, sort_order
    ) values (
      v_report_id, v_employee.id, v_employee.employee_no, v_employee.full_name,
      coalesce(v_employee_position, ''), coalesce(v_employee_team, ''),
      coalesce(v_employee.group_name, ''),
      coalesce(v_employee.shift_name, v_employee.legacy_shift_name, ''),
      coalesce(v_employee.platform_scope, ''),
      coalesce(v_employee.person_in_charge, v_employee.leader_name, ''),
      coalesce(v_employee.online_trainer, v_employee.trainer_name, ''),
      v_attendance,
      btrim(coalesce(v_member->>'status_note', '')),
      btrim(coalesce(v_member->>'work_details', '')),
      btrim(coalesce(v_member->>'performance', '')),
      btrim(coalesce(v_member->>'issues', '')),
      btrim(coalesce(v_member->>'follow_up', '')),
      case when jsonb_typeof(coalesce(v_member->'metrics', '{}'::jsonb)) = 'object'
           then coalesce(v_member->'metrics', '{}'::jsonb) else '{}'::jsonb end,
      v_member_count
    );
    v_member_count := v_member_count + 1;
  end loop;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, reason
  ) values (
    v_user_id, v_author_employee_id, 'online_training',
    case when v_existing.id is null then 'create' else 'update' end,
    v_report_id::text,
    v_report_date::text || ' · ' || v_title || ' · ' || v_member_count::text || '人'
  );

  return v_report_id;
end;
$$;

create or replace function public.online_training_archive_report(p_report_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author_employee_id uuid;
begin
  if not public.online_training_can_edit_report(p_report_id) then
    raise exception '无权删除该报告';
  end if;

  select employee_id into v_author_employee_id
  from public.user_access where auth_user_id = (select auth.uid());

  update public.online_training_reports
  set status = 'archived', archived_at = now(), archived_by = (select auth.uid()),
      updated_at = now(), updated_by = (select auth.uid())
  where id = p_report_id;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, reason
  ) values (
    (select auth.uid()), v_author_employee_id, 'online_training', 'archive',
    p_report_id::text, '归档删除线上培训日报'
  );

  return true;
end;
$$;

create or replace function public.online_training_review_report(
  p_report_id uuid,
  p_status text,
  p_note text default ''
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := btrim(coalesce(p_status, ''));
  v_employee_id uuid;
begin
  if v_status not in ('read', 'needs_changes') then
    raise exception '批注状态不正确';
  end if;
  if not public.online_training_can_review_report(p_report_id) then
    raise exception '无权批注该报告';
  end if;

  select employee_id into v_employee_id
  from public.user_access where auth_user_id = (select auth.uid());

  update public.online_training_reports
  set review_status = v_status,
      review_note = btrim(coalesce(p_note, '')),
      reviewed_by = (select auth.uid()),
      reviewed_at = now(),
      updated_at = now()
  where id = p_report_id and status = 'published';

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, reason
  ) values (
    (select auth.uid()), v_employee_id, 'online_training', 'review',
    p_report_id::text, v_status || ' · ' || btrim(coalesce(p_note, ''))
  );

  return true;
end;
$$;

revoke all on function public.online_training_is_active_backend() from public;
revoke all on function public.online_training_can_view_module() from public;
revoke all on function public.online_training_employee_in_scope(uuid) from public;
revoke all on function public.online_training_can_view_report(uuid) from public;
revoke all on function public.online_training_can_edit_report(uuid) from public;
revoke all on function public.online_training_can_review_report(uuid) from public;
revoke all on function public.online_training_bootstrap() from public;
revoke all on function public.online_training_list(text,date,date,uuid,integer,integer) from public;
revoke all on function public.online_training_people_search(text,date,date,integer,integer) from public;
revoke all on function public.online_training_employee_profile(uuid) from public;
revoke all on function public.online_training_save_report(jsonb,jsonb) from public;
revoke all on function public.online_training_archive_report(uuid) from public;
revoke all on function public.online_training_review_report(uuid,text,text) from public;

grant execute on function public.online_training_is_active_backend() to authenticated;
grant execute on function public.online_training_can_view_module() to authenticated;
grant execute on function public.online_training_employee_in_scope(uuid) to authenticated;
grant execute on function public.online_training_can_view_report(uuid) to authenticated;
grant execute on function public.online_training_can_edit_report(uuid) to authenticated;
grant execute on function public.online_training_can_review_report(uuid) to authenticated;
grant execute on function public.online_training_bootstrap() to authenticated;
grant execute on function public.online_training_list(text,date,date,uuid,integer,integer) to authenticated;
grant execute on function public.online_training_people_search(text,date,date,integer,integer) to authenticated;
grant execute on function public.online_training_employee_profile(uuid) to authenticated;
grant execute on function public.online_training_save_report(jsonb,jsonb) to authenticated;
grant execute on function public.online_training_archive_report(uuid) to authenticated;
grant execute on function public.online_training_review_report(uuid,text,text) to authenticated;

grant select on public.online_training_reports to authenticated;
grant select on public.online_training_report_members to authenticated;
revoke insert, update, delete on public.online_training_reports from authenticated;
revoke insert, update, delete on public.online_training_report_members from authenticated;

alter table public.online_training_reports enable row level security;
alter table public.online_training_report_members enable row level security;

drop policy if exists online_training_reports_read on public.online_training_reports;
create policy online_training_reports_read
on public.online_training_reports
for select to authenticated
using (public.online_training_can_view_report(id));

drop policy if exists online_training_members_read on public.online_training_report_members;
create policy online_training_members_read
on public.online_training_report_members
for select to authenticated
using (
  public.online_training_can_view_report(report_id)
  and (
    public.online_training_employee_in_scope(employee_id)
    or exists (
      select 1 from public.online_training_reports r
      where r.id = report_id and r.created_by = (select auth.uid())
    )
    or public.has_permission('online_training.manage')
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'online-training', 'online-training', false, 10485760,
  array['image/jpeg','image/png','image/webp','image/gif']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists online_training_storage_upload on storage.objects;
create policy online_training_storage_upload
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'online-training'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (
    public.has_permission('online_training.submit')
    or public.has_permission('online_training.manage')
  )
);

drop policy if exists online_training_storage_read on storage.objects;
create policy online_training_storage_read
on storage.objects
for select to authenticated
using (
  bucket_id = 'online-training'
  and case
    when coalesce((storage.foldername(name))[2], '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then public.online_training_can_view_report(((storage.foldername(name))[2])::uuid)
    else false
  end
);

drop policy if exists online_training_storage_delete on storage.objects;
create policy online_training_storage_delete
on storage.objects
for delete to authenticated
using (
  bucket_id = 'online-training'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or public.has_permission('online_training.manage')
  )
);
