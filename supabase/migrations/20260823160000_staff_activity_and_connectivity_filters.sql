-- Compact connectivity filters, friendly recorder names, and employee-only
-- attendance/connectivity history for the staff workspace.

drop policy if exists connectivity_evidence_admin_read on storage.objects;
create policy connectivity_evidence_admin_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'connectivity-evidence'
    and (
      public.has_permission('employee.view')
      or exists (
        select 1
        from public.employee_connectivity_incidents c
        join public.user_access ua
          on ua.employee_id = c.employee_id
         and ua.auth_user_id = (select auth.uid())
         and ua.active
         and ua.employee_portal_enabled
        where c.attachments @> jsonb_build_array(jsonb_build_object('path', storage.objects.name))
      )
    )
  );

create or replace function employee_ops_private.admin_connectivity_home(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
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
  if not public.has_permission('employee.view') then raise exception 'permission_denied'; end if;
  if v_from is not null and v_to is not null and v_from > v_to then
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
    join public.employees e on e.id = c.employee_id
    left join public.teams t on t.id = e.team_id
    left join public.positions p on p.id = e.position_id
    left join public.user_access ua on ua.auth_user_id = c.recorded_by and ua.active
    left join auth.users u on u.id = c.recorded_by
    where (v_employee_no = '' or lower(e.employee_no) like '%'||v_employee_no||'%')
      and (v_employee_name = '' or lower(e.full_name) like '%'||v_employee_name||'%')
      and (v_team = '' or lower(coalesce(t.name,'')) = lower(v_team))
      and (v_position = '' or lower(coalesce(p.name,'')) = lower(v_position))
      and (v_type = '' or c.incident_type = v_type)
      and (v_status = '' or c.status = v_status)
      and (v_country = '' or lower(coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写')) = lower(v_country))
      and (v_from is null or c.incident_date >= v_from)
      and (v_to is null or c.incident_date <= v_to)
  ), country_daily as (
    select incident_date,employee_country,count(distinct employee_id)::integer employees
    from filtered
    group by incident_date,employee_country
  ), daily as (
    select
      f.incident_date,
      count(*)::integer total_records,
      count(distinct f.employee_id)::integer affected_employees,
      count(*) filter(where f.incident_type = 'power_outage')::integer power,
      count(*) filter(where f.incident_type = 'internet_outage')::integer internet,
      coalesce((
        select jsonb_agg(jsonb_build_object('name',d.employee_country,'employees',d.employees) order by d.employees desc,d.employee_country)
        from country_daily d where d.incident_date = f.incident_date
      ),'[]'::jsonb) countries
    from filtered f
    group by f.incident_date
  ), paged as (
    select * from filtered
    order by incident_date desc,id desc
    limit v_size offset (v_page-1)*v_size
  )
  select jsonb_build_object(
    'permissions',jsonb_build_object('create',public.has_permission('employee.edit')),
    'page',v_page,
    'page_size',v_size,
    'total',(select count(*) from filtered),
    'pages',greatest(1,ceil((select count(*) from filtered)::numeric/v_size)::integer),
    'summary',jsonb_build_object(
      'total',(select count(*) from filtered),
      'affected_employees',(select count(distinct employee_id) from filtered),
      'power',(select count(*) from filtered where incident_type = 'power_outage'),
      'internet',(select count(*) from filtered where incident_type = 'internet_outage')
    ),
    'country_options',coalesce((
      select jsonb_agg(x.name order by x.name)
      from (select distinct coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写') name from public.employees e) x
    ),'[]'::jsonb),
    'team_options',coalesce((select jsonb_agg(t.name order by t.name) from public.teams t where nullif(btrim(t.name),'') is not null),'[]'::jsonb),
    'position_options',coalesce((select jsonb_agg(p.name order by p.name) from public.positions p where nullif(btrim(p.name),'') is not null),'[]'::jsonb),
    'daily_stats',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.incident_date desc)
      from (select * from daily order by incident_date desc limit 31) x
    ),'[]'::jsonb),
    'rows',coalesce((select jsonb_agg(to_jsonb(x) order by x.incident_date desc,x.id desc) from paged x),'[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function employee_ops_private.admin_employee_connectivity_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('employee.view') then raise exception 'permission_denied'; end if;
  if not exists(select 1 from public.employees e where e.id = p_employee_id) then raise exception 'employee_not_found'; end if;
  return jsonb_build_object(
    'total',(select count(*) from public.employee_connectivity_incidents c where c.employee_id = p_employee_id),
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
        left join public.user_access ua on ua.auth_user_id = c.recorded_by and ua.active
        left join auth.users u on u.id = c.recorded_by
        where c.employee_id = p_employee_id
        order by c.incident_date desc,c.id desc
        limit 300
      ) x
    ),'[]'::jsonb)
  );
end;
$$;

create or replace function employee_ops_private.staff_activity_home()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text;
  v_result jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;

  select e.id,e.employee_no
  into v_employee_id,v_employee_no
  from public.user_access ua
  join public.employees e on e.id = ua.employee_id
  where ua.auth_user_id = v_user
    and ua.active
    and ua.employee_portal_enabled
  order by ua.updated_at desc
  limit 1;

  if v_employee_id is null then raise exception 'staff_profile_not_linked'; end if;

  with attendance_rows as materialized (
    select
      m.id,r.report_date,m.attendance_status,m.status_note,m.work_details,m.performance,
      m.issues,m.follow_up,m.shift_name,m.team_name,m.position_name,m.platform
    from public.online_training_report_members m
    join public.online_training_reports r on r.id = m.report_id
    where m.employee_id = v_employee_id
       or regexp_replace(upper(coalesce(m.employee_no,'')),'[^A-Z0-9]','','g') = regexp_replace(upper(v_employee_no),'[^A-Z0-9]','','g')
  ), connectivity_rows as materialized (
    select c.id,c.incident_date,c.incident_type,c.started_at,c.ended_at,c.duration_minutes,
      c.details,c.evidence_url,c.attachments,c.status,c.created_at
    from public.employee_connectivity_incidents c
    where c.employee_id = v_employee_id
  )
  select jsonb_build_object(
    'employee_no',v_employee_no,
    'attendance',jsonb_build_object(
      'total',(select count(*) from attendance_rows),
      'summary',jsonb_build_object(
        'normal',(select count(*) from attendance_rows where lower(coalesce(attendance_status,'')) = 'normal'),
        'rest',(select count(*) from attendance_rows where lower(coalesce(attendance_status,'')) = 'rest'),
        'absent',(select count(*) from attendance_rows where lower(coalesce(attendance_status,'')) = 'absent'),
        'leave',(select count(*) from attendance_rows where lower(coalesce(attendance_status,'')) in ('leave','vacation','holiday')),
        'month_absent',(select count(*) from attendance_rows where lower(coalesce(attendance_status,'')) = 'absent' and date_trunc('month',report_date) = date_trunc('month',current_date)),
        'month_leave',(select count(*) from attendance_rows where lower(coalesce(attendance_status,'')) in ('rest','leave','vacation','holiday') and date_trunc('month',report_date) = date_trunc('month',current_date))
      ),
      'rows',coalesce((
        select jsonb_agg(to_jsonb(x) order by x.report_date desc,x.id)
        from (select * from attendance_rows order by report_date desc,id limit 120) x
      ),'[]'::jsonb)
    ),
    'connectivity',jsonb_build_object(
      'total',(select count(*) from connectivity_rows),
      'power',(select count(*) from connectivity_rows where incident_type = 'power_outage'),
      'internet',(select count(*) from connectivity_rows where incident_type = 'internet_outage'),
      'rows',coalesce((
        select jsonb_agg(to_jsonb(x) order by x.incident_date desc,x.id desc)
        from (select * from connectivity_rows order by incident_date desc,id desc limit 120) x
      ),'[]'::jsonb)
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function employee_ops_private.admin_connectivity_home(jsonb) from public,anon,authenticated;
revoke all on function employee_ops_private.admin_employee_connectivity_history(uuid) from public,anon,authenticated;
revoke all on function employee_ops_private.staff_activity_home() from public,anon,authenticated;
grant execute on function employee_ops_private.admin_connectivity_home(jsonb) to authenticated;
grant execute on function employee_ops_private.admin_employee_connectivity_history(uuid) to authenticated;
grant execute on function employee_ops_private.staff_activity_home() to authenticated;

create or replace function public.staff_activity_home()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select employee_ops_private.staff_activity_home();
$$;

revoke all on function public.staff_activity_home() from public,anon,authenticated;
grant execute on function public.staff_activity_home() to authenticated;
comment on function public.staff_activity_home() is 'Returns only the authenticated employee own attendance and connectivity history.';
