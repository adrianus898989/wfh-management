-- Exam workflow hardening: safe assignment lifecycle, resumable exams and stable grading snapshots.

alter table public.exam_assignments
  add column if not exists updated_by uuid references auth.users(id);

create index if not exists exam_sessions_resume_idx
  on public.exam_sessions(auth_user_id, assignment_id, status, expires_at desc);

create or replace function public.admin_exam_save_assignment(p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v public.exam_assignments; v_id uuid; v_status text;
begin
  if not public.exam_is_admin('exam.manage') then raise exception '没有考试管理权限'; end if;
  v_id:=nullif(p_data->>'id','')::uuid;
  v_status:=coalesce(nullif(p_data->>'status',''),'draft');
  if v_status not in ('draft','published','closed') then raise exception '考试状态不正确'; end if;
  if nullif(btrim(p_data->>'title'),'') is null then raise exception '请填写考试名称'; end if;
  if nullif(btrim(p_data->>'team_name'),'') is null or nullif(btrim(p_data->>'position_name'),'') is null then raise exception '请选择团队和岗位'; end if;
  if not exists(select 1 from public.exam_questions q where q.active and public.exam_norm(q.team_name)=public.exam_norm(p_data->>'team_name') and public.exam_norm(q.position_name)=public.exam_norm(p_data->>'position_name')) then
    raise exception '该团队与岗位没有可用题目';
  end if;
  if nullif(p_data->>'employee_id','') is not null and not exists(
    select 1 from public.employees e where e.id=(p_data->>'employee_id')::uuid and e.status='active' and e.resign_date is null
  ) then raise exception '指定员工不存在或已经离职'; end if;

  if v_id is null then
    insert into public.exam_assignments(title,team_name,position_name,employee_id,duration_minutes,pass_score,question_rules,start_at,end_at,max_attempts,status,created_by,updated_by)
    values(btrim(p_data->>'title'),btrim(p_data->>'team_name'),btrim(p_data->>'position_name'),nullif(p_data->>'employee_id','')::uuid,
      greatest(5,least(240,coalesce((p_data->>'duration_minutes')::int,60))),greatest(0,least(100,coalesce((p_data->>'pass_score')::numeric,60))),
      coalesce(p_data->'question_rules','{"5":10,"10":3,"20":1}'::jsonb),coalesce((p_data->>'start_at')::timestamptz,now()),nullif(p_data->>'end_at','')::timestamptz,
      greatest(1,least(20,coalesce((p_data->>'max_attempts')::int,1))),v_status,auth.uid(),auth.uid()) returning * into v;
  else
    update public.exam_assignments set title=btrim(p_data->>'title'),team_name=btrim(p_data->>'team_name'),position_name=btrim(p_data->>'position_name'),
      employee_id=nullif(p_data->>'employee_id','')::uuid,duration_minutes=greatest(5,least(240,coalesce((p_data->>'duration_minutes')::int,60))),
      pass_score=greatest(0,least(100,coalesce((p_data->>'pass_score')::numeric,60))),question_rules=coalesce(p_data->'question_rules',question_rules),
      start_at=coalesce((p_data->>'start_at')::timestamptz,start_at),end_at=nullif(p_data->>'end_at','')::timestamptz,
      max_attempts=greatest(1,least(20,coalesce((p_data->>'max_attempts')::int,1))),status=v_status,updated_at=now(),updated_by=auth.uid()
    where id=v_id returning * into v;
    if v.id is null then raise exception '考试不存在'; end if;
  end if;
  return to_jsonb(v);
end $$;

create or replace function public.admin_exam_delete_assignment(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v public.exam_assignments;
begin
  if not public.exam_is_admin('exam.manage') then raise exception '没有考试管理权限'; end if;
  if exists(select 1 from public.exam_sessions where assignment_id=p_assignment_id) then
    update public.exam_assignments set status='closed',updated_at=now(),updated_by=auth.uid() where id=p_assignment_id returning * into v;
  else
    delete from public.exam_assignments where id=p_assignment_id returning * into v;
  end if;
  if v.id is null then raise exception '考试不存在'; end if;
  return jsonb_build_object('id',v.id,'status',v.status,'removed',not exists(select 1 from public.exam_assignments where id=p_assignment_id));
end $$;

create or replace function public.admin_exam_employee_options(p_search text default '', p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
  if not public.exam_is_admin('exam.manage') then raise exception '没有考试管理权限'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.employee_no) from (
    select e.id,e.employee_no,e.full_name,t.name team_name,p.name position_name
    from public.employees e left join public.teams t on t.id=e.team_id left join public.positions p on p.id=e.position_id
    where e.status='active' and e.resign_date is null and (coalesce(p_search,'')='' or e.employee_no ilike '%'||p_search||'%' or e.full_name ilike '%'||p_search||'%')
    limit greatest(1,least(50,p_limit))
  ) x),'[]'::jsonb);
end $$;

create or replace function public.admin_exam_preview_questions(p_team text,p_position text,p_rules jsonb default '{"5":10,"10":3,"20":1}')
returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.points,x.external_key) from (
    select id,external_key,team_name,position_name,question_en,question_zh,question_vi,points,difficulty,image_urls
    from (
      select q.*,row_number() over(partition by q.points order by random()) rn
      from public.exam_questions q where q.active and public.exam_norm(q.team_name)=public.exam_norm(p_team) and public.exam_norm(q.position_name)=public.exam_norm(p_position)
    ) q where rn<=coalesce((p_rules->>points::text)::int,0)
  ) x),'[]'::jsonb);
end $$;

create or replace function public.staff_exam_home()
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare c record;
begin
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  return jsonb_build_object(
    'profile',to_jsonb(c),
    'assignments',(select coalesce(jsonb_agg(to_jsonb(x) order by x.start_at desc),'[]'::jsonb) from (
      select a.id,a.title,a.team_name,a.position_name,a.duration_minutes,a.pass_score,a.start_at,a.end_at,a.max_attempts,
        (select count(*) from public.exam_sessions s where s.assignment_id=a.id and s.employee_id=c.employee_id and s.status<>'in_progress') attempts,
        (select s.id from public.exam_sessions s where s.assignment_id=a.id and s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status='in_progress' and s.expires_at>now() order by s.started_at desc limit 1) resume_session_id
      from public.exam_assignments a where a.status='published' and a.start_at<=now() and (a.end_at is null or a.end_at>=now())
        and (a.employee_id is null or a.employee_id=c.employee_id) and public.exam_norm(a.team_name)=public.exam_norm(c.team_name) and public.exam_norm(a.position_name)=public.exam_norm(c.position_name)
    ) x),
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select s.id,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.earned_score,s.total_score,s.percentage,s.passed,s.grader_note
      from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id where s.employee_id=c.employee_id and s.status<>'in_progress' limit 100
    ) x)
  );
end $$;

create or replace function public.staff_exam_start(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare c record; a public.exam_assignments; v_attempt int; v_questions jsonb; v_total numeric; s public.exam_sessions; v_saved jsonb;
begin
  select * into c from public.exam_staff_context(); if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  select * into a from public.exam_assignments where id=p_assignment_id and status='published' and start_at<=now() and (end_at is null or end_at>=now())
    and (employee_id is null or employee_id=c.employee_id) and public.exam_norm(team_name)=public.exam_norm(c.team_name) and public.exam_norm(position_name)=public.exam_norm(c.position_name);
  if a.id is null then raise exception '考试不可用或不属于你的团队岗位'; end if;
  select * into s from public.exam_sessions where assignment_id=a.id and employee_id=c.employee_id and auth_user_id=auth.uid() and status='in_progress' and expires_at>now() order by started_at desc limit 1;
  if s.id is not null then
    select coalesce(jsonb_object_agg(question_id::text,answer_text),'{}'::jsonb) into v_saved from public.exam_answers where session_id=s.id;
    return to_jsonb(s)||jsonb_build_object('saved_answers',coalesce(v_saved,'{}'::jsonb),'resumed',true,'title',a.title);
  end if;
  update public.exam_sessions set status='expired',updated_at=now() where assignment_id=a.id and employee_id=c.employee_id and status='in_progress' and expires_at<=now();
  select count(*)+1 into v_attempt from public.exam_sessions where assignment_id=a.id and employee_id=c.employee_id and status<>'expired';
  if v_attempt>a.max_attempts then raise exception '已达到考试次数上限'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.points,x.external_key),'[]'::jsonb),coalesce(sum(x.points),0) into v_questions,v_total from (
    select id,external_key,team_name,position_name,question_en,question_zh,question_vi,points,difficulty,image_urls from (
      select q.*,row_number() over(partition by q.points order by random()) rn from public.exam_questions q
      where q.active and public.exam_norm(q.team_name)=public.exam_norm(a.team_name) and public.exam_norm(q.position_name)=public.exam_norm(a.position_name)
    ) q where rn<=coalesce((a.question_rules->>points::text)::int,0)
  ) x;
  if jsonb_array_length(v_questions)=0 then raise exception '该考试暂时没有可用题目'; end if;
  insert into public.exam_sessions(assignment_id,employee_id,auth_user_id,attempt_no,question_snapshot,expires_at,total_score)
    values(a.id,c.employee_id,auth.uid(),v_attempt,v_questions,now()+make_interval(mins=>a.duration_minutes),v_total) returning * into s;
  return to_jsonb(s)||jsonb_build_object('saved_answers','{}'::jsonb,'resumed',false,'title',a.title);
end $$;

create or replace function public.staff_exam_submit(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare s public.exam_sessions;
begin
  select * into s from public.exam_sessions where id=p_session_id and auth_user_id=auth.uid() and status='in_progress' for update;
  if s.id is null then raise exception '考试无法提交'; end if;
  insert into public.exam_answers(session_id,question_id,answer_text,attachments)
  select s.id,(j->>'id')::uuid,'','[]'::jsonb from jsonb_array_elements(s.question_snapshot) j
  on conflict(session_id,question_id) do nothing;
  update public.exam_sessions set status='submitted',submitted_at=now(),updated_at=now() where id=s.id returning * into s;
  return to_jsonb(s);
end $$;

create or replace function public.admin_exam_session_detail(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
  if not public.exam_is_admin('exam.grade') then raise exception '没有考试批改权限'; end if;
  return jsonb_build_object(
    'session',(select to_jsonb(x) from (select s.*,e.employee_no,e.full_name employee_name,a.title,a.pass_score from public.exam_sessions s join public.employees e on e.id=s.employee_id join public.exam_assignments a on a.id=s.assignment_id where s.id=p_session_id) x),
    'answers',(select coalesce(jsonb_agg(to_jsonb(x) order by x.ordinality),'[]'::jsonb) from (
      select j.ordinality,j.item->>'id' question_id,j.item->>'external_key' external_key,j.item->>'question_en' question_en,j.item->>'question_zh' question_zh,j.item->>'question_vi' question_vi,
        (j.item->>'points')::numeric points,coalesce(j.item->'image_urls','[]'::jsonb) image_urls,ans.id answer_id,coalesce(ans.answer_text,'') answer_text,
        coalesce(ans.attachments,'[]'::jsonb) attachments,ans.grade_status,ans.awarded_score,ans.grader_feedback
      from public.exam_sessions s cross join lateral jsonb_array_elements(s.question_snapshot) with ordinality j(item,ordinality)
      left join public.exam_answers ans on ans.session_id=s.id and ans.question_id=(j.item->>'id')::uuid where s.id=p_session_id
    ) x)
  );
end $$;

create or replace function public.admin_employee_exam_history(p_employee_id uuid)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限'; end if;
  return jsonb_build_object('summary',(select jsonb_build_object('attempts',count(*),'graded',count(*) filter(where status='graded'),'passed',count(*) filter(where passed),'average',round(avg(percentage) filter(where status='graded'),1)) from public.exam_sessions where employee_id=p_employee_id),
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (select s.id,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.percentage,s.passed from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id where s.employee_id=p_employee_id limit 100) x));
end $$;

create or replace function public.admin_exam_dashboard(
  p_search text default '', p_team text default '', p_position text default '', p_page integer default 1, p_page_size integer default 30
) returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare v_rows jsonb; v_total bigint; v_page integer:=greatest(coalesce(p_page,1),1); v_size integer:=least(greatest(coalesce(p_page_size,30),1),100);
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限'; end if;
  select count(*) into v_total from public.exam_questions q where q.active
    and (btrim(p_team)='' or public.exam_norm(q.team_name)=public.exam_norm(p_team)) and (btrim(p_position)='' or public.exam_norm(q.position_name)=public.exam_norm(p_position))
    and (btrim(p_search)='' or q.external_key ilike '%'||p_search||'%' or q.question_zh ilike '%'||p_search||'%' or q.question_en ilike '%'||p_search||'%' or q.question_vi ilike '%'||p_search||'%');
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_rows from (
    select q.id,q.external_key,q.sheet_row,q.team_name,q.position_name,q.question_en,q.question_zh,q.question_vi,q.points,q.difficulty,q.image_urls,q.active,q.sync_status,q.updated_at
    from public.exam_questions q where q.active
      and (btrim(p_team)='' or public.exam_norm(q.team_name)=public.exam_norm(p_team)) and (btrim(p_position)='' or public.exam_norm(q.position_name)=public.exam_norm(p_position))
      and (btrim(p_search)='' or q.external_key ilike '%'||p_search||'%' or q.question_zh ilike '%'||p_search||'%' or q.question_en ilike '%'||p_search||'%' or q.question_vi ilike '%'||p_search||'%')
    order by q.team_name,q.position_name,q.sheet_row nulls last limit v_size offset (v_page-1)*v_size
  ) x;
  return jsonb_build_object(
    'counts',jsonb_build_object('questions',(select count(*) from public.exam_questions where active),'assignments',(select count(*) from public.exam_assignments where status='published'),'pending_grading',(select count(*) from public.exam_sessions where status in ('submitted','grading')),'completed',(select count(*) from public.exam_sessions where status='graded')),
    'teams',(select coalesce(jsonb_agg(name order by name),'[]'::jsonb) from (select distinct team_name name from public.exam_questions where active) a),
    'positions',(select coalesce(jsonb_agg(name order by name),'[]'::jsonb) from (select distinct position_name name from public.exam_questions where active) a),
    'questions',v_rows,'total',v_total,'page',v_page,'page_size',v_size,
    'assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc),'[]'::jsonb) from (
      select x.id,x.title,x.team_name,x.position_name,x.employee_id,e.employee_no,e.full_name employee_name,x.duration_minutes,x.pass_score,x.question_rules,x.start_at,x.end_at,x.max_attempts,x.status,x.created_at
      from public.exam_assignments x left join public.employees e on e.id=x.employee_id order by x.created_at desc limit 100
    ) a),
    'sessions',(select coalesce(jsonb_agg(to_jsonb(s) order by s.submitted_at desc nulls last),'[]'::jsonb) from (select s.id,e.employee_no,e.full_name employee_name,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.earned_score,s.total_score,s.percentage,s.passed from public.exam_sessions s join public.employees e on e.id=s.employee_id join public.exam_assignments a on a.id=s.assignment_id order by s.started_at desc limit 100) s),
    'last_sync',(select to_jsonb(r) from public.exam_sync_runs r order by started_at desc limit 1)
  );
end $$;

revoke all on function public.admin_exam_save_assignment(jsonb),public.admin_exam_delete_assignment(uuid),public.admin_exam_employee_options(text,integer),public.admin_exam_preview_questions(text,text,jsonb),public.admin_employee_exam_history(uuid) from public;
grant execute on function public.admin_exam_save_assignment(jsonb),public.admin_exam_delete_assignment(uuid),public.admin_exam_employee_options(text,integer),public.admin_exam_preview_questions(text,text,jsonb),public.admin_employee_exam_history(uuid) to authenticated;
