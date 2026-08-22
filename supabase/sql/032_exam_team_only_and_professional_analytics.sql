-- Match staff exams by actual team only; staff chooses position and series.
drop function if exists public.staff_exam_start_adaptive(text);

create or replace function public.staff_exam_home()
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare c record; v_assignments jsonb:='[]'::jsonb;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.pool_ready desc,x.position_name,x.series_name),'[]'::jsonb) into v_assignments
  from (
    select 'adaptive' id,concat(q.series_name,' · ',q.position_name,' 考试') title,
      c.team_name team_name,q.position_name,q.series_name,60 duration_minutes,60 pass_score,14 question_count,100 total_score,20 max_attempts,
      coalesce((select count(*) from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id
        where s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status<>'expired'
          and public.exam_norm(a.team_name)=public.exam_norm(c.team_name)
          and public.exam_norm(a.position_name)=public.exam_norm(q.position_name)
          and public.exam_norm(a.series_name)=public.exam_norm(q.series_name)),0) attempts,
      (select s.id from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id
        where s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status='in_progress' and s.expires_at>now()
          and public.exam_norm(a.team_name)=public.exam_norm(c.team_name)
          and public.exam_norm(a.position_name)=public.exam_norm(q.position_name)
          and public.exam_norm(a.series_name)=public.exam_norm(q.series_name)
        order by s.started_at desc limit 1) resume_session_id,
      (count(*) filter(where q.points=5)>=10 and count(*) filter(where q.points=10)>=3 and count(*) filter(where q.points=20)>=1) pool_ready,
      jsonb_build_object('5',count(*) filter(where q.points=5),'10',count(*) filter(where q.points=10),'20',count(*) filter(where q.points=20)) pool_counts
    from public.exam_questions q
    where q.active and nullif(btrim(q.series_name),'') is not null
      and public.exam_norm(q.team_name)=public.exam_norm(c.team_name)
    group by q.position_name,q.series_name
  ) x;

  return jsonb_build_object(
    'profile',to_jsonb(c),'assignments',v_assignments,
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select s.id,a.title,a.series_name,a.position_name,s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,
        s.earned_score,s.total_score,s.percentage,s.passed,s.grader_note,
        coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
        count(ans.id) filter(where ans.grade_status='correct') correct_count,
        count(ans.id) filter(where ans.grade_status='partial') partial_count,
        count(ans.id) filter(where ans.grade_status='wrong') wrong_count,
        count(ans.id) filter(where ans.grade_status is null) pending_count
      from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id
      left join public.user_access ua on ua.auth_user_id=s.graded_by left join public.exam_answers ans on ans.session_id=s.id
      where s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status<>'in_progress'
      group by s.id,a.title,a.series_name,a.position_name,ua.login_username,ua.login_email
      order by s.started_at desc limit 100
    ) x)
  );
end $$;

create or replace function public.staff_exam_start_adaptive(p_series text,p_position text)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare
  c record; a public.exam_assignments; s public.exam_sessions; v_questions jsonb; v_saved jsonb;
  v_total numeric:=0; v_count integer:=0; v_five integer:=0; v_ten integer:=0; v_twenty integer:=0; v_attempt integer:=0; v_title text;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if nullif(btrim(p_series),'') is null or nullif(btrim(p_position),'') is null then raise exception '请选择岗位和盘口'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;
  select count(*) filter(where q.points=5),count(*) filter(where q.points=10),count(*) filter(where q.points=20)
  into v_five,v_ten,v_twenty from public.exam_questions q where q.active
    and public.exam_norm(q.team_name)=public.exam_norm(c.team_name)
    and public.exam_norm(q.position_name)=public.exam_norm(p_position)
    and public.exam_norm(q.series_name)=public.exam_norm(p_series);
  if v_five<10 or v_ten<3 or v_twenty<1 then raise exception '该岗位与盘口题库不足14题/100分：5分题 %/10，10分题 %/3，20分题 %/1',v_five,v_ten,v_twenty; end if;

  perform pg_advisory_xact_lock(hashtext(concat('adaptive-exam:',c.employee_id::text,':',public.exam_norm(p_position),':',public.exam_norm(p_series))));
  select ses.* into s from public.exam_sessions ses join public.exam_assignments x on x.id=ses.assignment_id
  where ses.employee_id=c.employee_id and ses.auth_user_id=auth.uid() and ses.status='in_progress' and ses.expires_at>now()
    and public.exam_norm(x.team_name)=public.exam_norm(c.team_name) and public.exam_norm(x.position_name)=public.exam_norm(p_position)
    and public.exam_norm(x.series_name)=public.exam_norm(p_series) order by ses.started_at desc limit 1;
  if s.id is not null then
    select coalesce(jsonb_object_agg(question_id::text,answer_text),'{}'::jsonb) into v_saved from public.exam_answers where session_id=s.id;
    select * into a from public.exam_assignments where id=s.assignment_id;
    return to_jsonb(s)||jsonb_build_object('saved_answers',coalesce(v_saved,'{}'::jsonb),'resumed',true,'title',a.title);
  end if;
  update public.exam_sessions s0 set status='expired',updated_at=now() where s0.employee_id=c.employee_id and s0.auth_user_id=auth.uid() and s0.status='in_progress' and s0.expires_at<=now();
  v_title:=concat(btrim(p_series),' · ',btrim(p_position),' 考试');
  select * into a from public.exam_assignments x where x.employee_id is null and x.status='published'
    and public.exam_norm(x.team_name)=public.exam_norm(c.team_name) and public.exam_norm(x.position_name)=public.exam_norm(p_position)
    and public.exam_norm(x.series_name)=public.exam_norm(p_series) and x.duration_minutes=60
    and x.question_rules='{"5":10,"10":3,"20":1}'::jsonb order by x.created_at desc limit 1;
  if a.id is null then
    insert into public.exam_assignments(title,team_name,position_name,series_name,employee_id,duration_minutes,pass_score,question_rules,start_at,end_at,max_attempts,status,created_by,updated_by)
    values(v_title,c.team_name,btrim(p_position),btrim(p_series),null,60,60,'{"5":10,"10":3,"20":1}'::jsonb,now(),null,20,'published',auth.uid(),auth.uid()) returning * into a;
  end if;
  select count(*)+1 into v_attempt from public.exam_sessions s0 where s0.assignment_id=a.id and s0.employee_id=c.employee_id and s0.status<>'expired';
  if v_attempt>a.max_attempts then raise exception '已达到考试次数上限'; end if;
  with ranked as (
    select q.*,row_number() over(partition by q.points order by random()) rn from public.exam_questions q where q.active
      and public.exam_norm(q.team_name)=public.exam_norm(c.team_name) and public.exam_norm(q.position_name)=public.exam_norm(p_position)
      and public.exam_norm(q.series_name)=public.exam_norm(p_series)
  ),selected as(select *,random() sort_key from ranked where(points=5 and rn<=10)or(points=10 and rn<=3)or(points=20 and rn<=1))
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'external_key',external_key,'series_name',series_name,'team_name',team_name,'position_name',position_name,
    'question_en',question_en,'question_zh',question_zh,'question_vi',question_vi,'points',points,'difficulty',difficulty,'image_urls',image_urls) order by sort_key),'[]'::jsonb),coalesce(sum(points),0),count(*)
  into v_questions,v_total,v_count from selected;
  if v_count<>14 or v_total<>100 then raise exception '生成试卷失败：必须为14题、100分，当前为%题、%分',v_count,v_total; end if;
  insert into public.exam_sessions(assignment_id,employee_id,auth_user_id,attempt_no,question_snapshot,expires_at,total_score)
  values(a.id,c.employee_id,auth.uid(),v_attempt,v_questions,now()+interval '60 minutes',100) returning * into s;
  return to_jsonb(s)||jsonb_build_object('saved_answers','{}'::jsonb,'resumed',false,'title',v_title);
end $$;

revoke all on function public.staff_exam_home() from public,anon;
revoke all on function public.staff_exam_start_adaptive(text,text) from public,anon;
grant execute on function public.staff_exam_home() to authenticated;
grant execute on function public.staff_exam_start_adaptive(text,text) to authenticated;

create or replace function public.admin_exam_analytics_v2()
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限'; end if;
  return jsonb_build_object(
    'summary',(select jsonb_build_object(
      'total_attempts',count(*),'graded_attempts',count(*) filter(where status='graded'),
      'pass_count',count(*) filter(where status='graded' and passed),'fail_count',count(*) filter(where status='graded' and not passed),
      'avg_score',round(avg(percentage) filter(where status='graded'),1),
      'pass_rate',round(100.0*count(*) filter(where status='graded' and passed)/nullif(count(*) filter(where status='graded'),0),1),
      'avg_duration_seconds',round(avg(extract(epoch from(submitted_at-started_at))) filter(where submitted_at is not null and started_at is not null)),
      'correct_count',(select count(*) from public.exam_answers where grade_status='correct'),
      'partial_count',(select count(*) from public.exam_answers where grade_status='partial'),
      'wrong_count',(select count(*) from public.exam_answers where grade_status='wrong'),
      'pending_count',(select count(*) from public.exam_answers where grade_status is null)
    ) from public.exam_sessions),
    'series',(select coalesce(jsonb_agg(to_jsonb(x) order by average desc,name),'[]'::jsonb) from(
      select coalesce(nullif(a.series_name,''),nullif(a.team_name,''),'未分类') name,round(avg(s.percentage),1) average,count(*) attempts
      from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id where s.status='graded'
      group by coalesce(nullif(a.series_name,''),nullif(a.team_name,''),'未分类'))x),
    'positions',(select coalesce(jsonb_agg(to_jsonb(x) order by average desc,name),'[]'::jsonb) from(
      select coalesce(nullif(a.position_name,''),'未分类') name,round(avg(s.percentage),1) average,count(*) attempts
      from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id where s.status='graded'
      group by coalesce(nullif(a.position_name,''),'未分类'))x),
    'teams',(select coalesce(jsonb_agg(to_jsonb(x) order by average desc,name),'[]'::jsonb) from(
      select coalesce(nullif(a.team_name,''),'未分类') name,round(avg(s.percentage),1) average,count(*) attempts
      from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id where s.status='graded'
      group by coalesce(nullif(a.team_name,''),'未分类'))x),
    'score_bands',(select jsonb_build_object(
      'excellent',count(*) filter(where percentage>=90),'good',count(*) filter(where percentage>=80 and percentage<90),
      'pass',count(*) filter(where percentage>=60 and percentage<80),'fail',count(*) filter(where percentage<60))
      from public.exam_sessions where status='graded'),
    'trend',(select coalesce(jsonb_agg(to_jsonb(x) order by trend_day),'[]'::jsonb) from(
      select submitted_at::date trend_day,round(avg(percentage),1) average,count(*) attempts
      from public.exam_sessions where status='graded' and submitted_at>=current_date-interval '29 days'
      group by submitted_at::date)x),
    'leaderboard',(select coalesce(jsonb_agg(to_jsonb(x) order by rank_no,employee_name),'[]'::jsonb) from(
      select dense_rank() over(order by avg(s.percentage) desc,max(s.percentage) desc,count(*) desc) rank_no,
        e.id employee_id,e.employee_no,e.full_name employee_name,
        coalesce(max(a.team_name),'—') team_name,count(*) attempts,round(avg(s.percentage),1) average_score,
        max(s.percentage) best_score,count(*) filter(where s.passed) pass_count,max(s.submitted_at) last_exam_at
      from public.exam_sessions s join public.employees e on e.id=s.employee_id join public.exam_assignments a on a.id=s.assignment_id
      where s.status='graded' group by e.id,e.employee_no,e.full_name order by rank_no,employee_name limit 100)x)
  );
end $$;

revoke all on function public.admin_exam_analytics_v2() from public,anon;
grant execute on function public.admin_exam_analytics_v2() to authenticated;
