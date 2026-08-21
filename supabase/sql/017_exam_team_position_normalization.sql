-- Google Sheet keeps spaces in names such as “AR 印度”, while employee teams use
-- “AR印度”. Match business labels safely without rewriting either source.
create or replace function public.exam_norm(p_value text)
returns text language sql immutable parallel safe set search_path=public as $$
  select lower(regexp_replace(coalesce(p_value,''),'[[:space:]]+','','g'));
$$;

drop policy if exists exam_staff_assignments on public.exam_assignments;
create policy exam_staff_assignments on public.exam_assignments for select to authenticated using (
  status='published' and start_at<=now() and (end_at is null or end_at>=now()) and exists(
    select 1 from public.exam_staff_context() c where (employee_id is null or employee_id=c.employee_id)
      and public.exam_norm(team_name)=public.exam_norm(c.team_name)
      and public.exam_norm(position_name)=public.exam_norm(c.position_name)
  )
);

create or replace function public.admin_exam_create_assignment(p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v exam_assignments;
begin
  if not public.exam_is_admin('exam.manage') then raise exception 'forbidden'; end if;
  if not exists(select 1 from exam_questions q where q.active and public.exam_norm(q.team_name)=public.exam_norm(p_data->>'team_name') and public.exam_norm(q.position_name)=public.exam_norm(p_data->>'position_name')) then raise exception '该团队与岗位没有可用题目'; end if;
  insert into exam_assignments(title,team_name,position_name,duration_minutes,pass_score,question_rules,start_at,end_at,max_attempts,status,created_by)
  values(btrim(p_data->>'title'),btrim(p_data->>'team_name'),btrim(p_data->>'position_name'),coalesce((p_data->>'duration_minutes')::int,60),coalesce((p_data->>'pass_score')::numeric,60),coalesce(p_data->'question_rules','{"5":10,"10":3,"20":1}'),coalesce((p_data->>'start_at')::timestamptz,now()),nullif(p_data->>'end_at','')::timestamptz,coalesce((p_data->>'max_attempts')::int,1),'published',auth.uid()) returning * into v;
  return to_jsonb(v);
end; $$;

create or replace function public.staff_exam_home()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare c record;
begin
  select * into c from public.exam_staff_context(); if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  return jsonb_build_object('profile',to_jsonb(c),
    'assignments',(select coalesce(jsonb_agg(to_jsonb(x) order by x.start_at desc),'[]') from (select a.id,a.title,a.team_name,a.position_name,a.duration_minutes,a.pass_score,a.start_at,a.end_at,a.max_attempts,(select count(*) from exam_sessions s where s.assignment_id=a.id and s.employee_id=c.employee_id) attempts from exam_assignments a where a.status='published' and a.start_at<=now() and (a.end_at is null or a.end_at>=now()) and (a.employee_id is null or a.employee_id=c.employee_id) and public.exam_norm(a.team_name)=public.exam_norm(c.team_name) and public.exam_norm(a.position_name)=public.exam_norm(c.position_name)) x),
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]') from (select s.id,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.earned_score,s.total_score,s.percentage,s.passed from exam_sessions s join exam_assignments a on a.id=s.assignment_id where s.employee_id=c.employee_id limit 100) x));
end; $$;

create or replace function public.staff_exam_start(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c record; a exam_assignments; v_attempt int; v_questions jsonb; v_total numeric; s exam_sessions; v_count int;
begin
  select * into c from public.exam_staff_context(); if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  select * into a from exam_assignments where id=p_assignment_id and status='published' and start_at<=now() and (end_at is null or end_at>=now()) and (employee_id is null or employee_id=c.employee_id) and public.exam_norm(team_name)=public.exam_norm(c.team_name) and public.exam_norm(position_name)=public.exam_norm(c.position_name); if a.id is null then raise exception '考试不可用或不属于你的团队岗位'; end if;
  select count(*)+1 into v_attempt from exam_sessions where assignment_id=a.id and employee_id=c.employee_id; if v_attempt>a.max_attempts then raise exception '已达到考试次数上限'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.points,q.external_key),'[]'),coalesce(sum(q.points),0),count(*) into v_questions,v_total,v_count from (
    select id,external_key,question_en,question_zh,question_vi,points,difficulty,image_urls from (
      select q.*,row_number() over(partition by q.points order by random()) rn from exam_questions q where q.active and public.exam_norm(q.team_name)=public.exam_norm(c.team_name) and public.exam_norm(q.position_name)=public.exam_norm(c.position_name)
    ) z where (points=5 and rn<=coalesce((a.question_rules->>'5')::int,10)) or (points=10 and rn<=coalesce((a.question_rules->>'10')::int,3)) or (points=20 and rn<=coalesce((a.question_rules->>'20')::int,1))
  ) q;
  if v_count=0 then raise exception '该团队岗位暂无题目'; end if;
  insert into exam_sessions(assignment_id,employee_id,auth_user_id,attempt_no,question_snapshot,expires_at,total_score) values(a.id,c.employee_id,auth.uid(),v_attempt,v_questions,now()+make_interval(mins=>a.duration_minutes),v_total) returning * into s;
  return to_jsonb(s);
end; $$;

revoke all on function public.exam_norm(text) from public;
grant execute on function public.exam_norm(text) to authenticated;
