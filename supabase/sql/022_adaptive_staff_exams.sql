-- Automatic staff exams: strict employee scope, 14 questions / 100 points / 60 minutes.

create table if not exists public.exam_scope_mappings (
  id uuid primary key default gen_random_uuid(),
  employee_team text not null,
  employee_position text not null,
  work_pattern text,
  question_team text not null,
  question_position text not null,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.exam_scope_mappings enable row level security;
revoke all on table public.exam_scope_mappings from anon, authenticated;

create index if not exists exam_scope_mappings_lookup_idx
  on public.exam_scope_mappings (employee_team, employee_position, active, priority);

insert into public.exam_scope_mappings(
  employee_team, employee_position, work_pattern,
  question_team, question_position, priority
)
select 'AR印尼', '彩金', '(55five|mzplay)', 'AR 55FIVE-MZ', '彩金', 10
where not exists (
  select 1 from public.exam_scope_mappings
  where public.exam_norm(employee_team)=public.exam_norm('AR印尼')
    and public.exam_norm(employee_position)=public.exam_norm('彩金')
    and public.exam_norm(question_team)=public.exam_norm('AR 55FIVE-MZ')
    and public.exam_norm(question_position)=public.exam_norm('彩金')
);

create or replace function public.exam_resolve_staff_scope(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  e record;
  m record;
  v_question_team text;
  v_question_position text;
begin
  select e.id, e.employee_no, e.full_name, e.work_content, e.platform_scope,
         t.name as employee_team, p.name as employee_position
  into e
  from public.employees e
  left join public.teams t on t.id=e.team_id
  left join public.positions p on p.id=e.position_id
  where e.id=p_employee_id
    and e.status in ('active','probation')
  limit 1;

  if e.id is null then return null; end if;

  if exists (
    select 1 from public.exam_questions q
    where q.active
      and public.exam_norm(q.team_name)=public.exam_norm(e.employee_team)
      and public.exam_norm(q.position_name)=public.exam_norm(e.employee_position)
  ) then
    v_question_team:=e.employee_team;
    v_question_position:=e.employee_position;
  else
    select x.* into m
    from public.exam_scope_mappings x
    where x.active
      and public.exam_norm(x.employee_team)=public.exam_norm(e.employee_team)
      and public.exam_norm(x.employee_position)=public.exam_norm(e.employee_position)
      and (nullif(btrim(x.work_pattern),'') is null
        or concat_ws(' ',e.work_content,e.platform_scope) ~* x.work_pattern)
    order by x.priority, x.created_at
    limit 1;
    v_question_team:=m.question_team;
    v_question_position:=m.question_position;
  end if;

  return jsonb_build_object(
    'employee_id',e.id,
    'employee_no',e.employee_no,
    'employee_name',e.full_name,
    'employee_team',e.employee_team,
    'employee_position',e.employee_position,
    'question_team',v_question_team,
    'question_position',v_question_position
  );
end;
$$;

revoke all on function public.exam_resolve_staff_scope(uuid) from public, anon, authenticated;

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
      'id','adaptive',
      'title',concat(v_scope->>'employee_team',' · ',v_scope->>'employee_position',' 岗位考试'),
      'team_name',v_scope->>'employee_team',
      'position_name',v_scope->>'employee_position',
      'question_team',v_scope->>'question_team',
      'question_position',v_scope->>'question_position',
      'duration_minutes',60,
      'pass_score',60,
      'question_count',14,
      'total_score',100,
      'max_attempts',20,
      'attempts',v_attempts,
      'resume_session_id',v_resume,
      'recommended',true,
      'pool_ready',v_ready,
      'pool_counts',jsonb_build_object('5',v_five,'10',v_ten,'20',v_twenty)
    ));
  end if;

  return jsonb_build_object(
    'profile',to_jsonb(c),
    'scope',v_scope,
    'assignments',v_assignments,
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select s.id,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,
             s.earned_score,s.total_score,s.percentage,s.passed,s.grader_note
      from public.exam_sessions s
      join public.exam_assignments a on a.id=s.assignment_id
      where s.employee_id=c.employee_id
        and s.auth_user_id=auth.uid()
        and s.status<>'in_progress'
      order by s.started_at desc limit 100
    ) x)
  );
end;
$$;

create or replace function public.staff_exam_start_adaptive()
returns jsonb
language plpgsql
security definer
set search_path=public,auth
as $$
declare
  c record;
  a public.exam_assignments;
  s public.exam_sessions;
  v_scope jsonb;
  v_questions jsonb;
  v_saved jsonb;
  v_total numeric:=0;
  v_count integer:=0;
  v_five integer:=0;
  v_ten integer:=0;
  v_twenty integer:=0;
  v_attempt integer:=0;
  v_title text;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  v_scope:=public.exam_resolve_staff_scope(c.employee_id);
  if nullif(v_scope->>'question_team','') is null
     or nullif(v_scope->>'question_position','') is null then
    raise exception '员工档案“% · %”尚未配置对应题库',c.team_name,c.position_name;
  end if;

  select count(*) filter(where q.points=5),
         count(*) filter(where q.points=10),
         count(*) filter(where q.points=20)
  into v_five,v_ten,v_twenty
  from public.exam_questions q
  where q.active
    and public.exam_norm(q.team_name)=public.exam_norm(v_scope->>'question_team')
    and public.exam_norm(q.position_name)=public.exam_norm(v_scope->>'question_position');

  if v_five<10 or v_ten<3 or v_twenty<1 then
    raise exception '对应题库不足14题/100分：5分题 %/10，10分题 %/3，20分题 %/1',v_five,v_ten,v_twenty;
  end if;

  perform pg_advisory_xact_lock(hashtext(concat('adaptive-exam:',c.employee_id::text)));

  select ses.* into s
  from public.exam_sessions ses
  join public.exam_assignments x on x.id=ses.assignment_id
  where ses.employee_id=c.employee_id
    and ses.auth_user_id=auth.uid()
    and ses.status='in_progress'
    and ses.expires_at>now()
    and public.exam_norm(x.team_name)=public.exam_norm(v_scope->>'question_team')
    and public.exam_norm(x.position_name)=public.exam_norm(v_scope->>'question_position')
  order by ses.started_at desc limit 1;

  if s.id is not null then
    select coalesce(jsonb_object_agg(question_id::text,answer_text),'{}'::jsonb)
    into v_saved from public.exam_answers where session_id=s.id;
    select * into a from public.exam_assignments where id=s.assignment_id;
    return to_jsonb(s)||jsonb_build_object(
      'saved_answers',coalesce(v_saved,'{}'::jsonb),'resumed',true,'title',a.title
    );
  end if;

  update public.exam_sessions s0 set status='expired',updated_at=now()
  where s0.employee_id=c.employee_id and s0.auth_user_id=auth.uid()
    and s0.status='in_progress' and s0.expires_at<=now();

  v_title:=concat(v_scope->>'employee_team',' · ',v_scope->>'employee_position',' 岗位考试');

  select * into a from public.exam_assignments x
  where x.employee_id is null
    and x.status='published'
    and public.exam_norm(x.team_name)=public.exam_norm(v_scope->>'question_team')
    and public.exam_norm(x.position_name)=public.exam_norm(v_scope->>'question_position')
    and x.duration_minutes=60
    and x.question_rules='{"5":10,"10":3,"20":1}'::jsonb
  order by x.created_at desc limit 1;

  if a.id is null then
    insert into public.exam_assignments(
      title,team_name,position_name,employee_id,duration_minutes,pass_score,
      question_rules,start_at,end_at,max_attempts,status,created_by,updated_by
    ) values(
      v_title,v_scope->>'question_team',v_scope->>'question_position',null,60,60,
      '{"5":10,"10":3,"20":1}'::jsonb,now(),null,20,'published',auth.uid(),auth.uid()
    ) returning * into a;
  end if;

  select count(*)+1 into v_attempt
  from public.exam_sessions s0
  where s0.assignment_id=a.id and s0.employee_id=c.employee_id and s0.status<>'expired';
  if v_attempt>a.max_attempts then raise exception '已达到考试次数上限'; end if;

  with ranked as (
    select q.*,row_number() over(partition by q.points order by random()) rn
    from public.exam_questions q
    where q.active
      and public.exam_norm(q.team_name)=public.exam_norm(v_scope->>'question_team')
      and public.exam_norm(q.position_name)=public.exam_norm(v_scope->>'question_position')
  ), selected as (
    select *,random() sort_key from ranked
    where (points=5 and rn<=10) or (points=10 and rn<=3) or (points=20 and rn<=1)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'external_key',external_key,'team_name',team_name,'position_name',position_name,
    'question_en',question_en,'question_zh',question_zh,'question_vi',question_vi,
    'points',points,'difficulty',difficulty,'image_urls',image_urls
  ) order by sort_key),'[]'::jsonb),coalesce(sum(points),0),count(*)
  into v_questions,v_total,v_count from selected;

  if v_count<>14 or v_total<>100 then
    raise exception '生成试卷失败：必须为14题、100分，当前为%题、%分',v_count,v_total;
  end if;

  insert into public.exam_sessions(
    assignment_id,employee_id,auth_user_id,attempt_no,question_snapshot,expires_at,total_score
  ) values(
    a.id,c.employee_id,auth.uid(),v_attempt,v_questions,now()+interval '60 minutes',100
  ) returning * into s;

  return to_jsonb(s)||jsonb_build_object(
    'saved_answers','{}'::jsonb,'resumed',false,'title',v_title
  );
end;
$$;

create or replace function public.staff_exam_start(p_assignment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public,auth
as $$
begin
  return public.staff_exam_start_adaptive();
end;
$$;

create or replace function public.staff_portal_home()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,auth
as $$
declare
  c record;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  return jsonb_build_object(
    'profile',(select to_jsonb(x) from (
      select e.employee_no,e.full_name,e.country,e.nationality,e.employment_type,e.status,
             e.hire_date,e.group_name,e.platform_scope,e.work_content,e.shift_name,
             e.leader_name,e.trainer_name,e.person_in_charge,e.online_leader,e.online_trainer,
             t.name team_name,p.name position_name
      from public.employees e
      left join public.teams t on t.id=e.team_id
      left join public.positions p on p.id=e.position_id
      where e.id=c.employee_id
    ) x),
    'error_summary',coalesce((select to_jsonb(x) from (
      select month_error_count,last_30d_error_count,total_error_count,total_deduct,
             last_error_date,main_error_type,risk_level
      from public.employee_error_summary
      where upper(btrim(employee_no))=upper(btrim(c.employee_no))
      order by updated_at desc limit 1
    ) x),'{}'::jsonb),
    'recent_errors',(select coalesce(jsonb_agg(to_jsonb(x) order by x.qc_date desc nulls last),'[]'::jsonb) from (
      select qc_date,error_type,error_note,correct_action,score,qc_person,leader_review,qc_result,review_date
      from public.employee_error_audit
      where upper(btrim(employee_no))=upper(btrim(c.employee_no))
      order by qc_date desc nulls last, first_seen_at desc limit 12
    ) x),
    'exam_summary',(select jsonb_build_object(
      'total',count(*),
      'completed',count(*) filter(where status='graded'),
      'passed',count(*) filter(where status='graded' and passed),
      'average',coalesce(round(avg(percentage) filter(where status='graded'),1),0)
    ) from public.exam_sessions where employee_id=c.employee_id and auth_user_id=auth.uid())
  );
end;
$$;

-- Remove the incorrect employee-targeted India/payout sample from the active catalog.
update public.exam_sessions
set status='expired',updated_at=now()
where assignment_id='beb3b112-379b-4e0c-bd92-2bf43279c06c'::uuid
  and status='in_progress';

update public.exam_assignments
set status='closed',updated_at=now()
where id='beb3b112-379b-4e0c-bd92-2bf43279c06c'::uuid;

drop policy if exists exam_staff_assignments on public.exam_assignments;

revoke all on function public.staff_exam_home() from public, anon;
revoke all on function public.staff_exam_start_adaptive() from public, anon;
revoke all on function public.staff_exam_start(uuid) from public, anon;
revoke all on function public.staff_portal_home() from public, anon;
grant execute on function public.staff_exam_home() to authenticated;
grant execute on function public.staff_exam_start_adaptive() to authenticated;
grant execute on function public.staff_exam_start(uuid) to authenticated;
grant execute on function public.staff_portal_home() to authenticated;
