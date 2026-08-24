-- A report attachment belongs to the trainer's whole report, not to an
-- individual employee.  Personal history mode returns member-only data and
-- never attributes shared screenshots to every member.

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
        - 'attachments'
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

comment on function public.online_training_list(text,date,date,uuid,integer,integer) is
  'Personal mode returns only the selected member and minimal report metadata; shared report attachments and group summaries are omitted.';

notify pgrst,'reload schema';
