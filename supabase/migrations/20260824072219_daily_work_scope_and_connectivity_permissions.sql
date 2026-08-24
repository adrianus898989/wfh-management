-- Daily-work monthly summaries, canonical employee scope enforcement, and
-- dedicated connectivity permissions.  Every employee-detail entry point is
-- guarded server-side; the UI is not treated as a security boundary.

insert into public.permissions(code,name,category,sensitive)
values
  ('connectivity.view','查看范围内停电 / 断网记录','connectivity',false),
  ('connectivity.create','录入范围内停电 / 断网记录','connectivity',false)
on conflict(code) do update set
  name=excluded.name,
  category=excluded.category,
  sensitive=excluded.sensitive;

-- Preserve current access while making the two capabilities independently
-- configurable from the role editor.
insert into public.role_permissions(role_id,permission_id)
select distinct rp.role_id,target_permission.id
from public.role_permissions rp
join public.permissions source_permission
  on source_permission.id=rp.permission_id
 and source_permission.code='employee.view'
join public.permissions target_permission
  on target_permission.code='connectivity.view'
on conflict do nothing;

insert into public.role_permissions(role_id,permission_id)
select distinct rp.role_id,target_permission.id
from public.role_permissions rp
join public.permissions source_permission
  on source_permission.id=rp.permission_id
 and source_permission.code='employee.edit'
join public.permissions target_permission
  on target_permission.code='connectivity.create'
on conflict do nothing;

create or replace function public.can_manage_employee(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_scope text;
  v_current_employee uuid;
  v_current_team uuid;
  v_target_team uuid;
begin
  if v_user_id is null or p_employee_id is null then return false; end if;

  if public.is_founder() then return true; end if;

  select ua.data_scope,ua.employee_id,e.team_id
  into v_scope,v_current_employee,v_current_team
  from public.user_access ua
  left join public.employees e on e.id=ua.employee_id
  where ua.auth_user_id=v_user_id
    and ua.active=true
    and ua.backend_enabled=true
  order by ua.updated_at desc
  limit 1;

  if v_scope is null then return false; end if;
  if v_scope='all' then return true; end if;
  if p_employee_id=v_current_employee then return true; end if;
  if v_scope='self' then return false; end if;

  select e.team_id into v_target_team
  from public.employees e
  where e.id=p_employee_id;
  if not found then return false; end if;

  if v_scope='own_team' then
    return v_current_team is not null and v_current_team=v_target_team;
  end if;

  if v_scope='assigned_teams' then
    return exists(
      select 1
      from public.user_scope_employees se
      where se.auth_user_id=v_user_id
        and se.employee_id=p_employee_id
    ) or exists(
      select 1
      from public.user_scope_teams st
      where st.auth_user_id=v_user_id
        and st.team_id=v_target_team
    );
  end if;

  return false;
end;
$$;

revoke all on function public.can_manage_employee(uuid) from public,anon;
grant execute on function public.can_manage_employee(uuid) to authenticated,service_role;

create or replace function public.online_training_employee_in_scope(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path=''
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

  select ua.employee_id,ua.data_scope,e.team_id
  into v_caller_employee_id,v_scope,v_caller_team_id
  from public.user_access ua
  left join public.employees e on e.id=ua.employee_id
  where ua.auth_user_id=v_user_id
    and ua.active=true
    and ua.backend_enabled=true
  order by ua.updated_at desc
  limit 1;

  if public.is_founder() or v_scope='all' then
    return true;
  end if;

  if p_employee_id=v_caller_employee_id
     or public.online_training_is_assigned_member(p_employee_id) then
    return true;
  end if;

  if v_scope='assigned_teams' then
    return exists(
      select 1
      from public.employees e
      where e.id=p_employee_id
        and (
          exists(
            select 1 from public.user_scope_employees se
            where se.auth_user_id=v_user_id and se.employee_id=e.id
          )
          or exists(
            select 1 from public.user_scope_teams st
            where st.auth_user_id=v_user_id and st.team_id=e.team_id
          )
        )
    );
  end if;

  if v_scope='own_team' and v_caller_team_id is not null then
    return exists(
      select 1 from public.employees e
      where e.id=p_employee_id and e.team_id=v_caller_team_id
    );
  end if;

  return false;
end;
$$;

revoke all on function public.online_training_employee_in_scope(uuid) from public,anon;
grant execute on function public.online_training_employee_in_scope(uuid) to authenticated,service_role;

create or replace function public.online_training_search_people(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no','')));
  v_employee_name text := lower(btrim(coalesce(p_filters->>'employee_name','')));
  v_trainer text := lower(btrim(coalesce(p_filters->>'trainer','')));
  v_keyword text := lower(btrim(coalesce(p_filters->>'keyword','')));
  v_team text := lower(btrim(coalesce(p_filters->>'team','')));
  v_group text := lower(btrim(coalesce(p_filters->>'group','')));
  v_position text := lower(btrim(coalesce(p_filters->>'position','')));
  v_shift text := lower(btrim(coalesce(p_filters->>'shift','')));
  v_platform text := lower(btrim(coalesce(p_filters->>'platform','')));
  v_attendance text := lower(btrim(coalesce(p_filters->>'attendance','')));
  v_date_from date := nullif(p_filters->>'from','')::date;
  v_date_to date := nullif(p_filters->>'to','')::date;
  v_page integer := greatest(coalesce(p_page,1),1);
  v_page_size integer := least(greatest(coalesce(p_page_size,20),1),50);
  v_total integer;
  v_rows jsonb;
begin
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  if v_date_from is not null and v_date_to is not null and v_date_from>v_date_to then
    raise exception '日期起不能晚于日期止';
  end if;

  with person_rollup as materialized (
    select
      m.employee_id,
      (array_agg(m.employee_no order by r.report_date desc,r.created_at desc))[1] employee_no,
      (array_agg(m.employee_name order by r.report_date desc,r.created_at desc))[1] employee_name,
      (array_agg(m.position_name order by r.report_date desc,r.created_at desc))[1] position_name,
      (array_agg(m.team_name order by r.report_date desc,r.created_at desc))[1] team_name,
      (array_agg(m.group_name order by r.report_date desc,r.created_at desc))[1] group_name,
      (array_agg(m.shift_name order by r.report_date desc,r.created_at desc))[1] shift_name,
      (array_agg(m.platform order by r.report_date desc,r.created_at desc))[1] platform,
      (array_agg(coalesce(nullif(m.trainer_name,''),nullif(r.trainer_name,''),r.author_name)
        order by r.report_date desc,r.created_at desc))[1] trainer_name,
      count(distinct r.id)::integer report_count,
      count(distinct r.report_date)::integer recorded_days,
      count(distinct r.report_date) filter(where m.attendance_status='normal')::integer normal_count,
      count(distinct r.report_date) filter(where m.attendance_status='rest')::integer rest_count,
      count(distinct r.report_date) filter(where m.attendance_status='leave')::integer leave_count,
      count(distinct r.report_date) filter(where m.attendance_status='absent')::integer absent_count,
      count(distinct r.report_date) filter(where m.attendance_status='transferred')::integer home_count,
      count(distinct r.report_date) filter(where nullif(btrim(m.issues),'') is not null)::integer issue_count,
      coalesce(sum(jsonb_array_length(coalesce(r.attachments,'[]'::jsonb))),0)::integer screenshot_count,
      max(r.report_date) last_report_date,
      greatest(
        coalesce(v_date_from,min(r.report_date)),
        coalesce(e.hire_date,coalesce(v_date_from,min(r.report_date)))
      ) period_from,
      least(
        coalesce(v_date_to,max(r.report_date)),
        coalesce(e.resign_date,coalesce(v_date_to,max(r.report_date)))
      ) period_to
    from public.online_training_report_members m
    join public.online_training_reports r on r.id=m.report_id
    left join public.employees e on e.id=m.employee_id
    where r.status='published'
      and public.online_training_can_view_report(r.id)
      and public.online_training_employee_in_scope(m.employee_id)
      and (v_date_from is null or r.report_date>=v_date_from)
      and (v_date_to is null or r.report_date<=v_date_to)
      and (v_employee_no='' or lower(coalesce(m.employee_no,'')) like '%'||v_employee_no||'%')
      and (v_employee_name='' or lower(coalesce(m.employee_name,'')) like '%'||v_employee_name||'%')
      and (v_trainer='' or lower(concat_ws(' ',r.author_name,r.author_employee_no,r.trainer_name,m.trainer_name)) like '%'||v_trainer||'%')
      and (v_team='' or lower(btrim(coalesce(m.team_name,'')))=v_team)
      and (v_group='' or lower(btrim(coalesce(m.group_name,'')))=v_group)
      and (v_position='' or lower(btrim(coalesce(m.position_name,'')))=v_position)
      and (v_shift='' or lower(btrim(coalesce(m.shift_name,'')))=v_shift)
      and (v_platform='' or lower(btrim(coalesce(m.platform,'')))=v_platform)
      and (v_attendance='' or lower(coalesce(m.attendance_status,''))=v_attendance)
      and (
        v_keyword=''
        or lower(concat_ws(' ',r.title,r.platform,r.course_type,r.report_summary,
          r.issues_summary,r.next_plan,m.status_note,m.work_details,m.performance,
          m.issues,m.follow_up,m.metrics::text)) like '%'||v_keyword||'%'
      )
    group by m.employee_id,e.hire_date,e.resign_date
  ), people as materialized (
    select
      p.*,
      greatest((p.period_to-p.period_from)+1,0)::integer period_days,
      greatest(((p.period_to-p.period_from)+1)-p.recorded_days,0)::integer missing_days,
      to_char(p.period_from,'YYYY-MM-DD')||' – '||to_char(p.period_to,'YYYY-MM-DD') period_label
    from person_rollup p
  )
  select
    (select count(*)::integer from people),
    coalesce((
      select jsonb_agg(to_jsonb(p) order by p.last_report_date desc,p.employee_name)
      from (
        select * from people
        order by last_report_date desc,employee_name
        offset (v_page-1)*v_page_size
        limit v_page_size
      ) p
    ),'[]'::jsonb)
  into v_total,v_rows;

  return jsonb_build_object(
    'rows',v_rows,
    'total',v_total,
    'page',v_page,
    'page_size',v_page_size,
    'pages',greatest(1,ceil(v_total::numeric/v_page_size)::integer)
  );
end;
$$;

revoke all on function public.online_training_search_people(jsonb,integer,integer) from public,anon;
grant execute on function public.online_training_search_people(jsonb,integer,integer) to authenticated;

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
set search_path=''
as $$
declare
  v_query text := lower(btrim(coalesce(p_query,'')));
  v_page integer := greatest(coalesce(p_page,1),1);
  v_page_size integer := least(greatest(coalesce(p_page_size,12),1),50);
  v_total integer;
  v_rows jsonb;
begin
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  if p_employee_id is not null
     and not public.online_training_employee_in_scope(p_employee_id) then
    raise exception '无权查看该员工培训记录';
  end if;

  with visible as (
    select r.*
    from public.online_training_reports r
    where r.status='published'
      and public.online_training_can_view_report(r.id)
      and (p_date_from is null or r.report_date>=p_date_from)
      and (p_date_to is null or r.report_date<=p_date_to)
      and (
        p_employee_id is null
        or exists(
          select 1 from public.online_training_report_members m
          where m.report_id=r.id and m.employee_id=p_employee_id
        )
      )
      and (
        v_query=''
        or lower(concat_ws(' ',r.title,r.platform,r.shift_name,r.team_name,
          r.group_name,r.leader_name,r.trainer_name,r.course_type,
          r.report_summary,r.issues_summary,r.next_plan)) like '%'||v_query||'%'
        or exists(
          select 1 from public.online_training_report_members m
          where m.report_id=r.id
            and (p_employee_id is null or m.employee_id=p_employee_id)
            and (
              r.created_by=(select auth.uid())
              or public.has_permission('online_training.manage')
              or public.online_training_employee_in_scope(m.employee_id)
            )
            and lower(concat_ws(' ',m.employee_no,m.employee_name,m.position_name,
              m.team_name,m.group_name,m.shift_name,m.platform,
              m.work_details,m.performance,m.issues,m.follow_up)) like '%'||v_query||'%'
        )
      )
  )
  select count(*) into v_total from visible;

  with visible as (
    select r.*
    from public.online_training_reports r
    where r.status='published'
      and public.online_training_can_view_report(r.id)
      and (p_date_from is null or r.report_date>=p_date_from)
      and (p_date_to is null or r.report_date<=p_date_to)
      and (
        p_employee_id is null
        or exists(
          select 1 from public.online_training_report_members m
          where m.report_id=r.id and m.employee_id=p_employee_id
        )
      )
      and (
        v_query=''
        or lower(concat_ws(' ',r.title,r.platform,r.shift_name,r.team_name,
          r.group_name,r.leader_name,r.trainer_name,r.course_type,
          r.report_summary,r.issues_summary,r.next_plan)) like '%'||v_query||'%'
        or exists(
          select 1 from public.online_training_report_members m
          where m.report_id=r.id
            and (p_employee_id is null or m.employee_id=p_employee_id)
            and (
              r.created_by=(select auth.uid())
              or public.has_permission('online_training.manage')
              or public.online_training_employee_in_scope(m.employee_id)
            )
            and lower(concat_ws(' ',m.employee_no,m.employee_name,m.position_name,
              m.team_name,m.group_name,m.shift_name,m.platform,
              m.work_details,m.performance,m.issues,m.follow_up)) like '%'||v_query||'%'
        )
      )
    order by r.report_date desc,r.created_at desc
    offset (v_page-1)*v_page_size
    limit v_page_size
  )
  select coalesce(jsonb_agg(
    (case
      when p_employee_id is null then to_jsonb(v)
      else to_jsonb(v)
        - 'report_summary'
        - 'issues_summary'
        - 'next_plan'
        - 'review_note'
    end)
    || jsonb_build_object(
      'can_edit',case when p_employee_id is null then public.online_training_can_edit_report(v.id) else false end,
      'can_review',case when p_employee_id is null then public.online_training_can_review_report(v.id) else false end,
      'members',coalesce((
        select jsonb_agg(to_jsonb(m) order by m.sort_order,m.employee_name)
        from public.online_training_report_members m
        where m.report_id=v.id
          and (p_employee_id is null or m.employee_id=p_employee_id)
          and (
            v.created_by=(select auth.uid())
            or public.has_permission('online_training.manage')
            or public.online_training_employee_in_scope(m.employee_id)
          )
      ),'[]'::jsonb)
    )
    order by v.report_date desc,v.created_at desc
  ),'[]'::jsonb)
  into v_rows
  from visible v;

  return jsonb_build_object(
    'rows',v_rows,
    'total',v_total,
    'page',v_page,
    'page_size',v_page_size,
    'pages',greatest(1,ceil(v_total::numeric/v_page_size)::integer)
  );
end;
$$;

revoke all on function public.online_training_list(text,date,date,uuid,integer,integer) from public,anon;
grant execute on function public.online_training_list(text,date,date,uuid,integer,integer) to authenticated;

create or replace function public.online_training_employee_profile(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_result jsonb;
begin
  if not public.has_permission('employee.view') then
    raise exception '没有员工档案查看权限';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception '无权查看负责范围外的员工档案';
  end if;
  if not public.online_training_can_view_module()
     or not public.online_training_employee_in_scope(p_employee_id) then
    raise exception '无权从线上培训模块查看该员工档案';
  end if;

  select jsonb_build_object(
    'id',e.id,
    'employee_no',e.employee_no,
    'full_name',e.full_name,
    'status',e.status,
    'country',coalesce(e.country,e.nationality,''),
    'employment_type',coalesce(e.employment_type,''),
    'hire_date',e.hire_date,
    'team',coalesce(t.name,''),
    'position',coalesce(p.name,e.schedule_position,''),
    'group',coalesce(e.group_name,''),
    'shift',coalesce(e.shift_name,e.legacy_shift_name,''),
    'platform',coalesce(e.platform_scope,''),
    'work_content',coalesce(e.work_content,''),
    'responsible',coalesce(e.person_in_charge,e.leader_name,''),
    'onsite_trainer',coalesce(e.on_site_trainer,''),
    'online_leader',coalesce(e.online_leader,''),
    'online_trainer',coalesce(e.online_trainer,e.trainer_name,''),
    'sensitive_fields_hidden',true
  ) into v_result
  from public.employees e
  left join public.teams t on t.id=e.team_id
  left join public.positions p on p.id=e.position_id
  where e.id=p_employee_id;

  if v_result is null then raise exception '员工档案不存在'; end if;
  return v_result;
end;
$$;

revoke all on function public.online_training_employee_profile(uuid) from public,anon;
grant execute on function public.online_training_employee_profile(uuid) to authenticated;

create or replace function employee_ops_private.admin_connectivity_home(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_page integer := greatest(coalesce(nullif(p_filters->>'page','')::integer,1),1);
  v_size integer := least(greatest(coalesce(nullif(p_filters->>'page_size','')::integer,30),1),100);
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no','')));
  v_employee_name text := lower(btrim(coalesce(p_filters->>'employee_name','')));
  v_team text := btrim(coalesce(p_filters->>'team',''));
  v_position text := btrim(coalesce(p_filters->>'position',''));
  v_type text := btrim(coalesce(p_filters->>'incident_type',''));
  v_status text := btrim(coalesce(p_filters->>'status',''));
  v_country text := btrim(coalesce(p_filters->>'country',''));
  v_from date := nullif(p_filters->>'date_from','')::date;
  v_to date := nullif(p_filters->>'date_to','')::date;
  v_result jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('connectivity.view') then raise exception 'permission_denied'; end if;
  if v_from is not null and v_to is not null and v_from>v_to then
    select v_to,v_from into v_from,v_to;
  end if;

  with filtered as materialized (
    select
      c.id,c.employee_id,c.incident_date,c.incident_type,c.started_at,c.ended_at,
      c.duration_minutes,c.details,c.evidence_url,c.attachments,c.status,c.created_at,
      e.employee_no,e.full_name,e.hire_date,e.status employee_status,
      coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写') employee_country,
      t.name team_name,p.name position_name,
      coalesce(
        nullif(btrim(ua.login_username),''),
        nullif(btrim(u.raw_user_meta_data->>'username'),''),
        nullif(btrim(u.raw_user_meta_data->>'full_name'),''),
        nullif(split_part(coalesce(u.email,''),'@',1),''),
        u.id::text
      ) recorded_by_name
    from public.employee_connectivity_incidents c
    join public.employees e on e.id=c.employee_id
    left join public.teams t on t.id=e.team_id
    left join public.positions p on p.id=e.position_id
    left join public.user_access ua on ua.auth_user_id=c.recorded_by and ua.active
    left join auth.users u on u.id=c.recorded_by
    where public.can_manage_employee(e.id)
      and (v_employee_no='' or lower(e.employee_no) like '%'||v_employee_no||'%')
      and (v_employee_name='' or lower(e.full_name) like '%'||v_employee_name||'%')
      and (v_team='' or lower(coalesce(t.name,''))=lower(v_team))
      and (v_position='' or lower(coalesce(p.name,''))=lower(v_position))
      and (v_type='' or c.incident_type=v_type)
      and (v_status='' or c.status=v_status)
      and (v_country='' or lower(coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写'))=lower(v_country))
      and (v_from is null or c.incident_date>=v_from)
      and (v_to is null or c.incident_date<=v_to)
  ), country_daily as (
    select incident_date,employee_country,count(distinct employee_id)::integer employees
    from filtered
    group by incident_date,employee_country
  ), daily as (
    select
      f.incident_date,
      count(*)::integer total_records,
      count(distinct f.employee_id)::integer affected_employees,
      count(*) filter(where f.incident_type='power_outage')::integer power,
      count(*) filter(where f.incident_type='internet_outage')::integer internet,
      coalesce((
        select jsonb_agg(jsonb_build_object('name',d.employee_country,'employees',d.employees)
          order by d.employees desc,d.employee_country)
        from country_daily d where d.incident_date=f.incident_date
      ),'[]'::jsonb) countries
    from filtered f
    group by f.incident_date
  ), paged as (
    select * from filtered
    order by incident_date desc,id desc
    limit v_size offset (v_page-1)*v_size
  )
  select jsonb_build_object(
    'permissions',jsonb_build_object('create',public.has_permission('connectivity.create')),
    'page',v_page,
    'page_size',v_size,
    'total',(select count(*) from filtered),
    'pages',greatest(1,ceil((select count(*) from filtered)::numeric/v_size)::integer),
    'summary',jsonb_build_object(
      'total',(select count(*) from filtered),
      'affected_employees',(select count(distinct employee_id) from filtered),
      'power',(select count(*) from filtered where incident_type='power_outage'),
      'internet',(select count(*) from filtered where incident_type='internet_outage')
    ),
    'country_options',coalesce((
      select jsonb_agg(x.name order by x.name)
      from (
        select distinct coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写') name
        from public.employees e
        where public.can_manage_employee(e.id)
      ) x
    ),'[]'::jsonb),
    'team_options',coalesce((
      select jsonb_agg(x.name order by x.name)
      from (
        select distinct t.name
        from public.employees e
        join public.teams t on t.id=e.team_id
        where public.can_manage_employee(e.id) and nullif(btrim(t.name),'') is not null
      ) x
    ),'[]'::jsonb),
    'position_options',coalesce((
      select jsonb_agg(x.name order by x.name)
      from (
        select distinct p.name
        from public.employees e
        join public.positions p on p.id=e.position_id
        where public.can_manage_employee(e.id) and nullif(btrim(p.name),'') is not null
      ) x
    ),'[]'::jsonb),
    'daily_stats',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.incident_date desc)
      from (select * from daily order by incident_date desc limit 31) x
    ),'[]'::jsonb),
    'rows',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.incident_date desc,x.id desc) from paged x
    ),'[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function employee_ops_private.admin_connectivity_employee_lookup(p_employee_no text)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_key text := regexp_replace(upper(coalesce(btrim(p_employee_no),'')),'[^A-Z0-9]','','g');
  v_employee jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('connectivity.create') then raise exception 'permission_denied'; end if;
  if v_key='' then return jsonb_build_object('found',false,'employee',null); end if;

  select jsonb_build_object(
    'id',e.id,
    'employee_no',e.employee_no,
    'full_name',e.full_name,
    'status',e.status,
    'hire_date',e.hire_date,
    'country',coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写'),
    'team_name',t.name,
    'position_name',p.name
  ) into v_employee
  from public.employees e
  left join public.teams t on t.id=e.team_id
  left join public.positions p on p.id=e.position_id
  where regexp_replace(upper(e.employee_no),'[^A-Z0-9]','','g')=v_key
    and public.can_manage_employee(e.id)
  order by case when e.status='active' then 0 else 1 end,e.updated_at desc nulls last,e.id
  limit 1;

  return jsonb_build_object('found',v_employee is not null,'employee',v_employee);
end;
$$;

create or replace function employee_ops_private.admin_connectivity_create(p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text := regexp_replace(upper(coalesce(btrim(p_record->>'employee_no'),'')),'[^A-Z0-9]','','g');
  v_date date := nullif(p_record->>'incident_date','')::date;
  v_type text := coalesce(nullif(btrim(p_record->>'incident_type'),''),'internet_outage');
  v_start time := nullif(p_record->>'started_at','')::time;
  v_end time := nullif(p_record->>'ended_at','')::time;
  v_start_ts timestamp;
  v_end_ts timestamp;
  v_duration integer;
  v_attachments jsonb := coalesce(p_record->'attachments','[]'::jsonb);
  v_id bigint;
  v_full_name text;
  v_hire_date date;
  v_country text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('connectivity.create') then raise exception 'permission_denied'; end if;
  if v_employee_no='' then raise exception 'employee_id_required'; end if;
  if v_date is null or v_start is null or v_end is null then raise exception 'incident_time_required'; end if;
  if v_type not in ('power_outage','internet_outage') then raise exception 'invalid_incident_type'; end if;
  if jsonb_typeof(v_attachments)<>'array' or jsonb_array_length(v_attachments)>3 then raise exception 'invalid_attachments'; end if;
  if exists(
    select 1 from jsonb_array_elements(v_attachments) a
    where btrim(coalesce(a->>'path',''))=''
      or split_part(a->>'path','/',1)<>v_user::text
      or not (coalesce(a->>'mime','') like 'image/%' or coalesce(a->>'mime','') like 'video/%')
  ) then raise exception 'invalid_attachments'; end if;

  select e.id,e.full_name,e.hire_date,
    coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写')
  into v_employee_id,v_full_name,v_hire_date,v_country
  from public.employees e
  where regexp_replace(upper(e.employee_no),'[^A-Z0-9]','','g')=v_employee_no
  order by case when e.status='active' then 0 else 1 end,e.updated_at desc
  limit 1;
  if v_employee_id is null then raise exception 'employee_not_found'; end if;
  if not public.can_manage_employee(v_employee_id) then raise exception 'employee_out_of_scope'; end if;

  v_start_ts:=v_date+v_start;
  v_end_ts:=v_date+v_end;
  if v_end_ts<v_start_ts then v_end_ts:=v_end_ts+interval '1 day'; end if;
  v_duration:=ceil(extract(epoch from (v_end_ts-v_start_ts))/60.0)::integer;

  insert into public.employee_connectivity_incidents(
    employee_id,incident_date,incident_type,started_at,ended_at,duration_minutes,
    work_impact,details,evidence_url,attachments,status,recorded_by
  ) values(
    v_employee_id,v_date,v_type,v_start,v_end,v_duration,
    'absent',nullif(btrim(p_record->>'details'),''),null,v_attachments,'reported',v_user
  ) returning id into v_id;

  return jsonb_build_object(
    'id',v_id,
    'employee_id',v_employee_id,
    'employee_no',v_employee_no,
    'full_name',v_full_name,
    'hire_date',v_hire_date,
    'employee_country',v_country,
    'duration_minutes',v_duration
  );
end;
$$;

create or replace function employee_ops_private.admin_employee_connectivity_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('employee.view') then raise exception 'permission_denied'; end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  if not exists(select 1 from public.employees e where e.id=p_employee_id) then raise exception 'employee_not_found'; end if;

  return jsonb_build_object(
    'total',(select count(*) from public.employee_connectivity_incidents c where c.employee_id=p_employee_id),
    'rows',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.incident_date desc,x.id desc)
      from (
        select c.id,c.incident_date,c.incident_type,c.started_at,c.ended_at,c.duration_minutes,
          c.details,c.evidence_url,c.attachments,c.status,c.created_at,
          coalesce(
            nullif(btrim(ua.login_username),''),
            nullif(btrim(u.raw_user_meta_data->>'username'),''),
            nullif(btrim(u.raw_user_meta_data->>'full_name'),''),
            nullif(split_part(coalesce(u.email,''),'@',1),''),
            u.id::text
          ) recorded_by_name
        from public.employee_connectivity_incidents c
        left join public.user_access ua on ua.auth_user_id=c.recorded_by and ua.active
        left join auth.users u on u.id=c.recorded_by
        where c.employee_id=p_employee_id
        order by c.incident_date desc,c.id desc
        limit 300
      ) x
    ),'[]'::jsonb)
  );
end;
$$;

revoke all on function employee_ops_private.admin_connectivity_home(jsonb) from public,anon,authenticated;
revoke all on function employee_ops_private.admin_connectivity_employee_lookup(text) from public,anon,authenticated;
revoke all on function employee_ops_private.admin_connectivity_create(jsonb) from public,anon,authenticated;
revoke all on function employee_ops_private.admin_employee_connectivity_history(uuid) from public,anon,authenticated;
grant execute on function employee_ops_private.admin_connectivity_home(jsonb) to authenticated;
grant execute on function employee_ops_private.admin_connectivity_employee_lookup(text) to authenticated;
grant execute on function employee_ops_private.admin_connectivity_create(jsonb) to authenticated;
grant execute on function employee_ops_private.admin_employee_connectivity_history(uuid) to authenticated;

drop policy if exists connectivity_evidence_admin_read on storage.objects;
create policy connectivity_evidence_admin_read
on storage.objects for select to authenticated
using(
  bucket_id='connectivity-evidence'
  and (
    (
      public.has_permission('connectivity.view')
      and exists(
        select 1
        from public.employee_connectivity_incidents c
        where c.attachments @> jsonb_build_array(jsonb_build_object('path',storage.objects.name))
          and public.can_manage_employee(c.employee_id)
      )
    )
    or exists(
      select 1
      from public.employee_connectivity_incidents c
      join public.user_access ua
        on ua.employee_id=c.employee_id
       and ua.auth_user_id=(select auth.uid())
       and ua.active
       and ua.employee_portal_enabled
      where c.attachments @> jsonb_build_array(jsonb_build_object('path',storage.objects.name))
    )
  )
);

drop policy if exists connectivity_evidence_admin_insert on storage.objects;
create policy connectivity_evidence_admin_insert
on storage.objects for insert to authenticated
with check(
  bucket_id='connectivity-evidence'
  and public.has_permission('connectivity.create')
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

drop policy if exists connectivity_evidence_admin_delete on storage.objects;
create policy connectivity_evidence_admin_delete
on storage.objects for delete to authenticated
using(
  bucket_id='connectivity-evidence'
  and public.has_permission('connectivity.create')
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

-- Every employee drawer tab has an exposed entry point.  Guard each entry
-- before delegating to its existing private implementation.
create or replace function public.admin_employee_profile_summary(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
begin
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return employee_ops_private.admin_employee_profile_summary(p_employee_id);
end;
$$;

create or replace function public.admin_employee_connectivity_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
begin
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return employee_ops_private.admin_employee_connectivity_history(p_employee_id);
end;
$$;

create or replace function public.admin_employee_payroll_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
begin
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return payroll_private.admin_employee_payroll_history(p_employee_id);
end;
$$;

create or replace function public.admin_employee_attendance_history(
  p_employee_id uuid,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
begin
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return attendance_private.admin_employee_attendance_history(p_employee_id,p_page,p_page_size);
end;
$$;

create or replace function public.admin_employee_adjustment_history(
  p_employee_id uuid,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
begin
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return attendance_private.admin_employee_adjustment_history(p_employee_id,p_page,p_page_size);
end;
$$;

create or replace function public.admin_employee_error_history(
  p_employee_id uuid,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_employee_no text;
  v_page integer := greatest(coalesce(p_page,1),1);
  v_size integer := least(greatest(coalesce(p_page_size,30),1),100);
  v_total bigint := 0;
begin
  if not (
    public.has_permission('employee.view')
    or public.has_permission('report.view')
    or public.exam_is_admin('exam.view')
  ) then
    raise exception '没有员工档案查看权限';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  select upper(btrim(e.employee_no)) into v_employee_no
  from public.employees e where e.id=p_employee_id;
  if v_employee_no is null then raise exception '员工档案不存在'; end if;

  select count(*) into v_total
  from public.report_employee_errors_v e
  where e.employee_no=v_employee_no;

  return jsonb_build_object(
    'page',v_page,
    'page_size',v_size,
    'total',v_total,
    'pages',greatest(1,ceil(v_total::numeric/v_size)::integer),
    'rows',(
      select coalesce(jsonb_agg(to_jsonb(x) order by x.qc_date desc nulls last,x.source_row desc nulls last),'[]'::jsonb)
      from (
        select record_key,source_row,qc_date,error_type,error_note,correct_action,score,qc_person,
          leader_review,qc_result,review_date,member_order,amount,synced_at
        from public.report_employee_errors_v
        where employee_no=v_employee_no
        order by qc_date desc nulls last,source_row desc nulls last
        limit v_size offset (v_page-1)*v_size
      ) x
    )
  );
end;
$$;

create or replace function public.admin_employee_exam_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_employee_no text;
  v_result jsonb;
begin
  if not (
    public.has_permission('employee.view')
    or public.exam_is_admin('exam.view')
  ) then
    raise exception '没有员工档案查看权限';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  select e.employee_no into v_employee_no
  from public.employees e where e.id=p_employee_id;
  if v_employee_no is null then raise exception '员工档案不存在'; end if;

  with history as materialized (
    select u.*
    from public.admin_exam_combined_sessions_v u
    where u.employee_id=p_employee_id
       or (
         u.source_system='legacy'
         and public.exam_employee_no_key(u.employee_no)=public.exam_employee_no_key(v_employee_no)
       )
  )
  select jsonb_build_object(
    'employee',(
      select to_jsonb(x)
      from (
        select e.id,e.employee_no,e.full_name,t.name team_name,p.name position_name
        from public.employees e
        left join public.teams t on t.id=e.team_id
        left join public.positions p on p.id=e.position_id
        where e.id=p_employee_id
      ) x
    ),
    'summary',jsonb_build_object(
      'attempts',count(*),
      'graded',count(*) filter(where status='graded'),
      'passed',count(*) filter(where status='graded' and passed),
      'average',round(avg(percentage) filter(where status='graded'),1),
      'current_attempts',count(*) filter(where source_system='current'),
      'legacy_attempts',count(*) filter(where source_system='legacy'),
      'pending',count(*) filter(where status in('submitted','grading','in_progress'))
    ),
    'history',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.started_at desc)
      from (
        select id,title,attempt_no,status,started_at,submitted_at,graded_at,
          earned_score,total_score,percentage,passed,grader_name,correct_count,
          partial_count,wrong_count,pending_count,source_system,source_label,
          read_only,team_name,position_name,series_name,answer_detail_available,
          answer_detail_count,scored_answer_count,zero_score_answer_count,
          total_question_count,unanswered_count
        from history
        order by started_at desc
        limit 200
      ) x
    ),'[]'::jsonb)
  ) into v_result
  from history;

  return coalesce(v_result,jsonb_build_object(
    'summary',jsonb_build_object(
      'attempts',0,'graded',0,'passed',0,'average',null,
      'current_attempts',0,'legacy_attempts',0,'pending',0
    ),
    'history','[]'::jsonb
  ));
end;
$$;

revoke all on function public.admin_employee_profile_summary(uuid) from public,anon,authenticated;
revoke all on function public.admin_employee_connectivity_history(uuid) from public,anon,authenticated;
revoke all on function public.admin_employee_payroll_history(uuid) from public,anon,authenticated;
revoke all on function public.admin_employee_attendance_history(uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.admin_employee_adjustment_history(uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.admin_employee_error_history(uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.admin_employee_exam_history(uuid) from public,anon,authenticated;
grant execute on function public.admin_employee_profile_summary(uuid) to authenticated;
grant execute on function public.admin_employee_connectivity_history(uuid) to authenticated;
grant execute on function public.admin_employee_payroll_history(uuid) to authenticated;
grant execute on function public.admin_employee_attendance_history(uuid,integer,integer) to authenticated;
grant execute on function public.admin_employee_adjustment_history(uuid,integer,integer) to authenticated;
grant execute on function public.admin_employee_error_history(uuid,integer,integer) to authenticated;
grant execute on function public.admin_employee_exam_history(uuid) to authenticated;

comment on function public.can_manage_employee(uuid) is
  'Canonical backend employee scope: all, self, own_team, or assigned_teams via user_scope_teams/user_scope_employees.';
comment on function public.online_training_list(text,date,date,uuid,integer,integer) is
  'When p_employee_id is supplied, rows.members contains that employee only; report-level attachments remain available.';
comment on function public.online_training_search_people(jsonb,integer,integer) is
  'Range-scoped employee daily-work summary, adjusted to each employee hire/resignation interval.';

notify pgrst,'reload schema';
