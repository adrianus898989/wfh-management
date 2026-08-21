-- Employee-selectable exam catalog and private result review.

drop policy if exists exam_staff_assignments on public.exam_assignments;
create policy exam_staff_assignments on public.exam_assignments for select to authenticated using (
  status='published' and start_at<=now() and (end_at is null or end_at>=now()) and exists(
    select 1 from public.exam_staff_context() c
    where (employee_id=c.employee_id)
       or (employee_id is null
           and public.exam_norm(team_name)=public.exam_norm(c.team_name)
           and public.exam_norm(position_name)=public.exam_norm(c.position_name))
  )
);

create or replace function public.staff_exam_home()
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare c record;
begin
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  return jsonb_build_object(
    'profile',to_jsonb(c),
    'assignments',(select coalesce(jsonb_agg(to_jsonb(x) order by x.recommended desc,x.start_at desc),'[]'::jsonb) from (
      select a.id,a.title,a.team_name,a.position_name,a.duration_minutes,a.pass_score,a.start_at,a.end_at,a.max_attempts,
        (a.employee_id is null and public.exam_norm(a.team_name)=public.exam_norm(c.team_name)
          and public.exam_norm(a.position_name)=public.exam_norm(c.position_name)) recommended,
        (select count(*) from public.exam_sessions s where s.assignment_id=a.id and s.employee_id=c.employee_id and s.status<>'in_progress') attempts,
        (select s.id from public.exam_sessions s where s.assignment_id=a.id and s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status='in_progress' and s.expires_at>now() order by s.started_at desc limit 1) resume_session_id
      from public.exam_assignments a
      where a.status='published' and a.start_at<=now() and (a.end_at is null or a.end_at>=now())
        and ((a.employee_id=c.employee_id)
          or (a.employee_id is null and public.exam_norm(a.team_name)=public.exam_norm(c.team_name)
            and public.exam_norm(a.position_name)=public.exam_norm(c.position_name)))
    ) x),
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select s.id,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.earned_score,s.total_score,s.percentage,s.passed,s.grader_note
      from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id
      where s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status<>'in_progress'
      order by s.started_at desc limit 100
    ) x)
  );
end $$;

create or replace function public.staff_exam_start(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare c record; a public.exam_assignments; v_attempt int; v_questions jsonb; v_total numeric; s public.exam_sessions; v_saved jsonb;
begin
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  select * into a from public.exam_assignments
  where id=p_assignment_id and status='published' and start_at<=now() and (end_at is null or end_at>=now())
    and ((employee_id=c.employee_id)
      or (employee_id is null and public.exam_norm(team_name)=public.exam_norm(c.team_name)
        and public.exam_norm(position_name)=public.exam_norm(c.position_name)));
  if a.id is null then raise exception '考试不可用或不属于你的考试范围'; end if;
  select * into s from public.exam_sessions
  where assignment_id=a.id and employee_id=c.employee_id and auth_user_id=auth.uid()
    and status='in_progress' and expires_at>now() order by started_at desc limit 1;
  if s.id is not null then
    select coalesce(jsonb_object_agg(question_id::text,answer_text),'{}'::jsonb) into v_saved
    from public.exam_answers where session_id=s.id;
    return to_jsonb(s)||jsonb_build_object('saved_answers',coalesce(v_saved,'{}'::jsonb),'resumed',true,'title',a.title);
  end if;
  update public.exam_sessions set status='expired',updated_at=now()
  where assignment_id=a.id and employee_id=c.employee_id and status='in_progress' and expires_at<=now();
  select count(*)+1 into v_attempt from public.exam_sessions
  where assignment_id=a.id and employee_id=c.employee_id and status<>'expired';
  if v_attempt>a.max_attempts then raise exception '已达到考试次数上限'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.points,x.external_key),'[]'::jsonb),coalesce(sum(x.points),0)
  into v_questions,v_total from (
    select id,external_key,team_name,position_name,question_en,question_zh,question_vi,points,difficulty,image_urls from (
      select q.*,row_number() over(partition by q.points order by random()) rn
      from public.exam_questions q where q.active
        and public.exam_norm(q.team_name)=public.exam_norm(a.team_name)
        and public.exam_norm(q.position_name)=public.exam_norm(a.position_name)
    ) q where rn<=coalesce((a.question_rules->>points::text)::int,0)
  ) x;
  if jsonb_array_length(v_questions)=0 then raise exception '该考试暂时没有可用题目'; end if;
  insert into public.exam_sessions(assignment_id,employee_id,auth_user_id,attempt_no,question_snapshot,expires_at,total_score)
  values(a.id,c.employee_id,auth.uid(),v_attempt,v_questions,now()+make_interval(mins=>a.duration_minutes),v_total)
  returning * into s;
  return to_jsonb(s)||jsonb_build_object('saved_answers','{}'::jsonb,'resumed',false,'title',a.title);
end $$;

create or replace function public.staff_exam_result_detail(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare c record; s public.exam_sessions;
begin
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  select * into s from public.exam_sessions
  where id=p_session_id and employee_id=c.employee_id and auth_user_id=auth.uid() and status<>'in_progress';
  if s.id is null then raise exception '无权查看该考试结果'; end if;
  return jsonb_build_object(
    'session',(select to_jsonb(x) from (
      select s.id,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.earned_score,s.total_score,s.percentage,s.passed,s.grader_note
      from public.exam_assignments a where a.id=s.assignment_id
    ) x),
    'answers',(select coalesce(jsonb_agg(jsonb_build_object(
      'question',q.item,'answer_text',coalesce(ans.answer_text,''),'awarded_score',ans.awarded_score,
      'grade_status',ans.grade_status,'grader_feedback',ans.grader_feedback
    ) order by q.ord),'[]'::jsonb)
    from jsonb_array_elements(s.question_snapshot) with ordinality q(item,ord)
    left join public.exam_answers ans on ans.session_id=s.id and ans.question_id=(q.item->>'id')::uuid)
  );
end $$;

revoke all on function public.staff_exam_result_detail(uuid) from public;
grant execute on function public.staff_exam_result_detail(uuid) to authenticated;
