-- Exam management record search with independent employee ID, name and exam filters.

create or replace function public.admin_exam_sessions_search_v2(
  p_employee_no text default '',
  p_employee_name text default '',
  p_exam text default '',
  p_team text default '',
  p_position text default '',
  p_status text default '',
  p_grader text default '',
  p_date_from date default null,
  p_date_to date default null,
  p_page integer default 1,
  p_page_size integer default 30
) returns jsonb
language plpgsql
stable
security definer
set search_path=public,auth
as $$
declare
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,30),1),100);
  v_total bigint;
  v_rows jsonb;
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限'; end if;

  with base as (
    select s.id,s.employee_id,e.employee_no,e.full_name employee_name,a.title,a.team_name,a.position_name,
           s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,s.earned_score,s.total_score,s.percentage,s.passed,
           coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
           count(ans.id) filter(where ans.grade_status='correct') correct_count,
           count(ans.id) filter(where ans.grade_status='partial') partial_count,
           count(ans.id) filter(where ans.grade_status='wrong') wrong_count,
           count(ans.id) filter(where ans.grade_status is null) pending_count
    from public.exam_sessions s
    join public.employees e on e.id=s.employee_id
    join public.exam_assignments a on a.id=s.assignment_id
    left join public.user_access ua on ua.auth_user_id=s.graded_by
    left join public.exam_answers ans on ans.session_id=s.id
    where (btrim(coalesce(p_employee_no,''))='' or e.employee_no ilike '%'||btrim(p_employee_no)||'%')
      and (btrim(coalesce(p_employee_name,''))='' or e.full_name ilike '%'||btrim(p_employee_name)||'%')
      and (btrim(coalesce(p_exam,''))='' or a.title ilike '%'||btrim(p_exam)||'%')
      and (btrim(coalesce(p_team,''))='' or public.exam_norm(a.team_name)=public.exam_norm(p_team))
      and (btrim(coalesce(p_position,''))='' or public.exam_norm(a.position_name)=public.exam_norm(p_position))
      and (btrim(coalesce(p_status,''))='' or (p_status='pending' and s.status in ('submitted','grading')) or s.status=p_status)
      and (btrim(coalesce(p_grader,''))='' or coalesce(ua.login_username,ua.login_email,'') ilike '%'||btrim(p_grader)||'%')
      and (p_date_from is null or coalesce(s.submitted_at,s.started_at)::date>=p_date_from)
      and (p_date_to is null or coalesce(s.submitted_at,s.started_at)::date<=p_date_to)
    group by s.id,e.employee_no,e.full_name,a.title,a.team_name,a.position_name,ua.login_username,ua.login_email
  )
  select count(*) into v_total from base;

  with base as (
    select s.id,s.employee_id,e.employee_no,e.full_name employee_name,a.title,a.team_name,a.position_name,
           s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,s.earned_score,s.total_score,s.percentage,s.passed,
           coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
           count(ans.id) filter(where ans.grade_status='correct') correct_count,
           count(ans.id) filter(where ans.grade_status='partial') partial_count,
           count(ans.id) filter(where ans.grade_status='wrong') wrong_count,
           count(ans.id) filter(where ans.grade_status is null) pending_count
    from public.exam_sessions s
    join public.employees e on e.id=s.employee_id
    join public.exam_assignments a on a.id=s.assignment_id
    left join public.user_access ua on ua.auth_user_id=s.graded_by
    left join public.exam_answers ans on ans.session_id=s.id
    where (btrim(coalesce(p_employee_no,''))='' or e.employee_no ilike '%'||btrim(p_employee_no)||'%')
      and (btrim(coalesce(p_employee_name,''))='' or e.full_name ilike '%'||btrim(p_employee_name)||'%')
      and (btrim(coalesce(p_exam,''))='' or a.title ilike '%'||btrim(p_exam)||'%')
      and (btrim(coalesce(p_team,''))='' or public.exam_norm(a.team_name)=public.exam_norm(p_team))
      and (btrim(coalesce(p_position,''))='' or public.exam_norm(a.position_name)=public.exam_norm(p_position))
      and (btrim(coalesce(p_status,''))='' or (p_status='pending' and s.status in ('submitted','grading')) or s.status=p_status)
      and (btrim(coalesce(p_grader,''))='' or coalesce(ua.login_username,ua.login_email,'') ilike '%'||btrim(p_grader)||'%')
      and (p_date_from is null or coalesce(s.submitted_at,s.started_at)::date>=p_date_from)
      and (p_date_to is null or coalesce(s.submitted_at,s.started_at)::date<=p_date_to)
    group by s.id,e.employee_no,e.full_name,a.title,a.team_name,a.position_name,ua.login_username,ua.login_email
  )
  select coalesce(jsonb_agg(to_jsonb(x) order by x.submitted_at desc nulls last,x.started_at desc),'[]'::jsonb)
  into v_rows
  from (
    select * from base
    order by submitted_at desc nulls last,started_at desc
    limit v_size offset (v_page-1)*v_size
  ) x;

  return jsonb_build_object('rows',v_rows,'total',v_total,'page',v_page,'page_size',v_size);
end;
$$;

revoke all on function public.admin_exam_sessions_search_v2(text,text,text,text,text,text,text,date,date,integer,integer) from public,anon;
grant execute on function public.admin_exam_sessions_search_v2(text,text,text,text,text,text,text,date,date,integer,integer) to authenticated;
