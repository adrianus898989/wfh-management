begin;

-- 线上培训日报只保留：正常上班、公休、请假、缺席、回家。
-- 内部值沿用既有字段，避免破坏已部署接口：rest=公休，transferred=回家。
update public.online_training_report_members
set attendance_status = 'rest', status_note = ''
where attendance_status = 'not_applicable';

alter table public.online_training_report_members
  drop constraint if exists online_training_report_members_attendance_status_check;

alter table public.online_training_report_members
  add constraint online_training_report_members_attendance_status_check
  check (attendance_status in ('normal', 'rest', 'leave', 'absent', 'transferred'));

alter table public.online_training_report_members
  drop constraint if exists online_training_report_members_status_reason_check;

alter table public.online_training_report_members
  add constraint online_training_report_members_status_reason_check
  check (
    attendance_status not in ('leave', 'absent', 'transferred')
    or nullif(btrim(status_note), '') is not null
  );

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
      count(*) filter (where m.attendance_status = 'rest')::integer as rest_count,
      count(*) filter (where m.attendance_status = 'leave')::integer as leave_count,
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
      count(*) filter (where m.attendance_status = 'rest')::integer as rest_count,
      count(*) filter (where m.attendance_status = 'leave')::integer as leave_count,
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
  select coalesce(
    jsonb_agg(to_jsonb(p) order by p.last_report_date desc, p.employee_name),
    '[]'::jsonb
  )
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

commit;
