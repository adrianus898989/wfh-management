-- Complete exam result audit trail and server-side record search.

create or replace function public.staff_exam_home()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,auth
as $$
declare
  c record;
  v_scope jsonb;
  v_five integer:=0;
  v_ten integer:=0;
  v_twenty integer:=0;
  v_attempts integer:=0;
  v_resume uuid;
  v_ready boolean:=false;
  v_assignments jsonb:='[]'::jsonb;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  v_scope:=public.exam_resolve_staff_scope(c.employee_id);
  if nullif(v_scope->>'question_team','') is not null
     and nullif(v_scope->>'question_position','') is not null then
    select count(*) filter(where q.points=5),
           count(*) filter(where q.points=10),
           count(*) filter(where q.points=20)
    into v_five,v_ten,v_twenty
    from public.exam_questions q
    where q.active
      and public.exam_norm(q.team_name)=public.exam_norm(v_scope->>'question_team')
      and public.exam_norm(q.position_name)=public.exam_norm(v_scope->>'question_position');

    v_ready:=v_five>=10 and v_ten>=3 and v_twenty>=1;

    select count(*) into v_attempts
    from public.exam_sessions s
    join public.exam_assignments a on a.id=s.assignment_id
    where s.employee_id=c.employee_id
      and s.auth_user_id=auth.uid()
      and public.exam_norm(a.team_name)=public.exam_norm(v_scope->>'question_team')
      and public.exam_norm(a.position_name)=public.exam_norm(v_scope->>'question_position')
      and s.status<>'expired';

    select s.id into v_resume
    from public.exam_sessions s
    join public.exam_assignments a on a.id=s.assignment_id
    where s.employee_id=c.employee_id
      and s.auth_user_id=auth.uid()
      and s.status='in_progress'
      and s.expires_at>now()
      and public.exam_norm(a.team_name)=public.exam_norm(v_scope->>'question_team')
      and public.exam_norm(a.position_name)=public.exam_norm(v_scope->>'question_position')
    order by s.started_at desc limit 1;

    v_assignments:=jsonb_build_array(jsonb_build_object(
      'id','adaptive','title',concat(v_scope->>'employee_team',' · ',v_scope->>'employee_position',' 岗位考试'),
      'team_name',v_scope->>'employee_team','position_name',v_scope->>'employee_position',
      'question_team',v_scope->>'question_team','question_position',v_scope->>'question_position',
      'duration_minutes',60,'pass_score',60,'question_count',14,'total_score',100,
      'max_attempts',20,'attempts',v_attempts,'resume_session_id',v_resume,
      'recommended',true,'pool_ready',v_ready,
      'pool_counts',jsonb_build_object('5',v_five,'10',v_ten,'20',v_twenty)
    ));
  end if;

  return jsonb_build_object(
    'profile',to_jsonb(c),'scope',v_scope,'assignments',v_assignments,
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select s.id,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,
             s.earned_score,s.total_score,s.percentage,s.passed,s.grader_note,
             coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
             count(ans.id) filter(where ans.grade_status='correct') correct_count,
             count(ans.id) filter(where ans.grade_status='partial') partial_count,
             count(ans.id) filter(where ans.grade_status='wrong') wrong_count,
             count(ans.id) filter(where ans.grade_status is null) pending_count
      from public.exam_sessions s
      join public.exam_assignments a on a.id=s.assignment_id
      left join public.user_access ua on ua.auth_user_id=s.graded_by
      left join public.exam_answers ans on ans.session_id=s.id
      where s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status<>'in_progress'
      group by s.id,a.title,ua.login_username,ua.login_email
      order by s.started_at desc limit 100
    ) x)
  );
end;
$$;

create or replace function public.staff_exam_result_detail(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,auth
as $$
declare c record; s public.exam_sessions;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  select * into s from public.exam_sessions
  where id=p_session_id and employee_id=c.employee_id and auth_user_id=auth.uid() and status<>'in_progress';
  if s.id is null then raise exception '无权查看该考试结果'; end if;
  return jsonb_build_object(
    'session',(select to_jsonb(x) from (
      select s.id,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,
             s.earned_score,s.total_score,s.percentage,s.passed,s.grader_note,
             coalesce((select coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''))
                       from public.user_access ua where ua.auth_user_id=s.graded_by limit 1),'—') grader_name,
             (select count(*) from public.exam_answers z where z.session_id=s.id and z.grade_status='correct') correct_count,
             (select count(*) from public.exam_answers z where z.session_id=s.id and z.grade_status='partial') partial_count,
             (select count(*) from public.exam_answers z where z.session_id=s.id and z.grade_status='wrong') wrong_count,
             (select count(*) from public.exam_answers z where z.session_id=s.id and z.grade_status is null) pending_count
      from public.exam_assignments a where a.id=s.assignment_id
    ) x),
    'answers',(select coalesce(jsonb_agg(jsonb_build_object(
      'question',q.item,'answer_text',coalesce(ans.answer_text,''),'awarded_score',ans.awarded_score,
      'grade_status',ans.grade_status,'grader_feedback',ans.grader_feedback,
      'graded_at',ans.graded_at,'grader_name',coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—')
    ) order by q.ord),'[]'::jsonb)
    from jsonb_array_elements(s.question_snapshot) with ordinality q(item,ord)
    left join public.exam_answers ans on ans.session_id=s.id and ans.question_id=(q.item->>'id')::uuid
    left join public.user_access ua on ua.auth_user_id=ans.graded_by)
  );
end;
$$;

create or replace function public.admin_exam_session_detail(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public,auth
as $$
begin
  if not public.exam_is_admin('exam.view') and not public.exam_is_admin('exam.grade') then raise exception '没有考试查看权限'; end if;
  return jsonb_build_object(
    'session',(select to_jsonb(x) from (
      select s.*,e.employee_no,e.full_name employee_name,a.title,a.team_name,a.position_name,a.pass_score,
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
      where s.id=p_session_id
      group by s.id,e.employee_no,e.full_name,a.title,a.team_name,a.position_name,a.pass_score,ua.login_username,ua.login_email
    ) x),
    'answers',(select coalesce(jsonb_agg(to_jsonb(x) order by x.ordinality),'[]'::jsonb) from (
      select j.ordinality,j.item->>'id' question_id,j.item->>'external_key' external_key,
        j.item->>'question_en' question_en,j.item->>'question_zh' question_zh,j.item->>'question_vi' question_vi,
        (j.item->>'points')::numeric points,coalesce(j.item->'image_urls','[]'::jsonb) image_urls,
        ans.id answer_id,coalesce(ans.answer_text,'') answer_text,coalesce(ans.attachments,'[]'::jsonb) attachments,
        ans.grade_status,ans.awarded_score,ans.grader_feedback,ans.graded_at,
        coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name
      from public.exam_sessions s cross join lateral jsonb_array_elements(s.question_snapshot) with ordinality j(item,ordinality)
      left join public.exam_answers ans on ans.session_id=s.id and ans.question_id=(j.item->>'id')::uuid
      left join public.user_access ua on ua.auth_user_id=ans.graded_by
      where s.id=p_session_id
    ) x)
  );
end;
$$;

create or replace function public.admin_employee_exam_history(p_employee_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public,auth
as $$
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限'; end if;
  return jsonb_build_object(
    'employee',(select to_jsonb(x) from (select e.id,e.employee_no,e.full_name,t.name team_name,p.name position_name from public.employees e left join public.teams t on t.id=e.team_id left join public.positions p on p.id=e.position_id where e.id=p_employee_id) x),
    'summary',(select jsonb_build_object('attempts',count(*),'graded',count(*) filter(where status='graded'),'passed',count(*) filter(where passed),'average',round(avg(percentage) filter(where status='graded'),1)) from public.exam_sessions where employee_id=p_employee_id),
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select s.id,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,s.earned_score,s.total_score,s.percentage,s.passed,
             coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
             count(ans.id) filter(where ans.grade_status='correct') correct_count,
             count(ans.id) filter(where ans.grade_status='partial') partial_count,
             count(ans.id) filter(where ans.grade_status='wrong') wrong_count,
             count(ans.id) filter(where ans.grade_status is null) pending_count
      from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id
      left join public.user_access ua on ua.auth_user_id=s.graded_by
      left join public.exam_answers ans on ans.session_id=s.id
      where s.employee_id=p_employee_id
      group by s.id,a.title,ua.login_username,ua.login_email
      order by s.started_at desc limit 100
    ) x)
  );
end;
$$;

create or replace function public.admin_exam_sessions_search(
  p_search text default '', p_team text default '', p_position text default '', p_status text default '',
  p_grader text default '', p_date_from date default null, p_date_to date default null,
  p_page integer default 1, p_page_size integer default 30
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
    from public.exam_sessions s join public.employees e on e.id=s.employee_id join public.exam_assignments a on a.id=s.assignment_id
    left join public.user_access ua on ua.auth_user_id=s.graded_by
    left join public.exam_answers ans on ans.session_id=s.id
    where (btrim(coalesce(p_team,''))='' or public.exam_norm(a.team_name)=public.exam_norm(p_team))
      and (btrim(coalesce(p_position,''))='' or public.exam_norm(a.position_name)=public.exam_norm(p_position))
      and (btrim(coalesce(p_status,''))='' or (p_status='pending' and s.status in ('submitted','grading')) or s.status=p_status)
      and (btrim(coalesce(p_grader,''))='' or coalesce(ua.login_username,ua.login_email,'') ilike '%'||p_grader||'%')
      and (p_date_from is null or coalesce(s.submitted_at,s.started_at)::date>=p_date_from)
      and (p_date_to is null or coalesce(s.submitted_at,s.started_at)::date<=p_date_to)
      and (btrim(coalesce(p_search,''))='' or e.employee_no ilike '%'||p_search||'%' or e.full_name ilike '%'||p_search||'%' or a.title ilike '%'||p_search||'%')
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
    from public.exam_sessions s join public.employees e on e.id=s.employee_id join public.exam_assignments a on a.id=s.assignment_id
    left join public.user_access ua on ua.auth_user_id=s.graded_by
    left join public.exam_answers ans on ans.session_id=s.id
    where (btrim(coalesce(p_team,''))='' or public.exam_norm(a.team_name)=public.exam_norm(p_team))
      and (btrim(coalesce(p_position,''))='' or public.exam_norm(a.position_name)=public.exam_norm(p_position))
      and (btrim(coalesce(p_status,''))='' or (p_status='pending' and s.status in ('submitted','grading')) or s.status=p_status)
      and (btrim(coalesce(p_grader,''))='' or coalesce(ua.login_username,ua.login_email,'') ilike '%'||p_grader||'%')
      and (p_date_from is null or coalesce(s.submitted_at,s.started_at)::date>=p_date_from)
      and (p_date_to is null or coalesce(s.submitted_at,s.started_at)::date<=p_date_to)
      and (btrim(coalesce(p_search,''))='' or e.employee_no ilike '%'||p_search||'%' or e.full_name ilike '%'||p_search||'%' or a.title ilike '%'||p_search||'%')
    group by s.id,e.employee_no,e.full_name,a.title,a.team_name,a.position_name,ua.login_username,ua.login_email
  )
  select coalesce(jsonb_agg(to_jsonb(x) order by x.submitted_at desc nulls last,x.started_at desc),'[]'::jsonb)
  into v_rows from (select * from base order by submitted_at desc nulls last,started_at desc limit v_size offset (v_page-1)*v_size) x;

  return jsonb_build_object('rows',v_rows,'total',v_total,'page',v_page,'page_size',v_size);
end;
$$;

revoke all on function public.staff_exam_home() from public,anon;
revoke all on function public.staff_exam_result_detail(uuid) from public,anon;
revoke all on function public.admin_exam_session_detail(uuid) from public,anon;
revoke all on function public.admin_employee_exam_history(uuid) from public,anon;
revoke all on function public.admin_exam_sessions_search(text,text,text,text,text,date,date,integer,integer) from public,anon;
grant execute on function public.staff_exam_home(),public.staff_exam_result_detail(uuid) to authenticated;
grant execute on function public.admin_exam_session_detail(uuid),public.admin_employee_exam_history(uuid),public.admin_exam_sessions_search(text,text,text,text,text,date,date,integer,integer) to authenticated;
