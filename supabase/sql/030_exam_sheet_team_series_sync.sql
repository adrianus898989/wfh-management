-- Treat Google Sheet columns as A=series/platform, B=position and K=actual team.
-- Rows without K are retained for history but are not eligible for new exams.

alter table public.exam_questions add column if not exists series_name text;
alter table public.exam_assignments add column if not exists series_name text;

create index if not exists idx_exam_questions_scope_series
  on public.exam_questions (public.exam_norm(team_name), public.exam_norm(position_name), public.exam_norm(series_name), points)
  where active;

create or replace function public.sync_exam_questions_from_sheet(p_rows jsonb, p_read_count integer default 0)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_row jsonb;
  v_existing uuid;
  v_inserted integer:=0;
  v_updated integer:=0;
  v_eligible integer:=coalesce(jsonb_array_length(coalesce(p_rows,'[]'::jsonb)),0);
  v_run_id bigint;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  perform pg_advisory_xact_lock(hashtext('exam-sheet-sync'));

  insert into public.exam_sync_runs(direction,status,read_count,details)
  values('sheet_to_db','running',greatest(coalesce(p_read_count,0),v_eligible),jsonb_build_object('eligible_rows',v_eligible,'team_column','K'))
  returning id into v_run_id;

  update public.exam_questions
  set active=false,updated_at=now()
  where source='google_sheet' and active;

  for v_row in select value from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    if nullif(btrim(v_row->>'team_name'),'') is null
       or nullif(btrim(v_row->>'series_name'),'') is null
       or nullif(btrim(v_row->>'position_name'),'') is null then
      continue;
    end if;

    select id into v_existing from public.exam_questions where external_key=v_row->>'external_key';

    insert into public.exam_questions(
      external_key,sheet_row,series_name,team_name,position_name,
      question_en,question_zh,question_vi,points,difficulty,image_urls,
      active,source,source_hash,revision,sheet_updated_at,synced_at,sync_status,updated_at
    ) values(
      v_row->>'external_key',(v_row->>'sheet_row')::integer,btrim(v_row->>'series_name'),btrim(v_row->>'team_name'),btrim(v_row->>'position_name'),
      coalesce(v_row->>'question_en',''),coalesce(v_row->>'question_zh',''),coalesce(v_row->>'question_vi',''),
      (v_row->>'points')::smallint,(v_row->>'difficulty')::smallint,coalesce(v_row->'image_urls','[]'::jsonb),
      true,'google_sheet',md5(v_row::text),1,now(),now(),'synced',now()
    )
    on conflict (external_key) do update set
      sheet_row=excluded.sheet_row,series_name=excluded.series_name,team_name=excluded.team_name,position_name=excluded.position_name,
      question_en=excluded.question_en,question_zh=excluded.question_zh,question_vi=excluded.question_vi,
      points=excluded.points,difficulty=excluded.difficulty,image_urls=excluded.image_urls,active=true,source='google_sheet',
      source_hash=excluded.source_hash,revision=public.exam_questions.revision+1,sheet_updated_at=now(),synced_at=now(),sync_status='synced',updated_at=now();

    if v_existing is null then v_inserted:=v_inserted+1; else v_updated:=v_updated+1; end if;
  end loop;

  update public.exam_sync_runs set status='success',inserted_count=v_inserted,updated_count=v_updated,
    skipped_count=greatest(coalesce(p_read_count,0)-v_eligible,0),completed_at=now(),
    details=details||jsonb_build_object('active_questions',v_eligible,'blank_team_rows',greatest(coalesce(p_read_count,0)-v_eligible,0))
  where id=v_run_id;

  return jsonb_build_object('run_id',v_run_id,'read',p_read_count,'eligible',v_eligible,'inserted',v_inserted,'updated',v_updated,'team_column','K');
exception when others then
  if v_run_id is not null then
    update public.exam_sync_runs set status='failed',error_count=1,completed_at=now(),details=details||jsonb_build_object('error',sqlerrm) where id=v_run_id;
  end if;
  raise;
end $$;

revoke all on function public.sync_exam_questions_from_sheet(jsonb,integer) from public,anon,authenticated;
grant execute on function public.sync_exam_questions_from_sheet(jsonb,integer) to service_role;

drop function if exists public.staff_exam_start_adaptive();

create or replace function public.staff_exam_home()
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare c record; v_assignments jsonb:='[]'::jsonb;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.pool_ready desc,x.series_name),'[]'::jsonb) into v_assignments
  from (
    select 'adaptive' id, concat(q.series_name,' · ',c.team_name,' · ',c.position_name,' 岗位考试') title,
      c.team_name team_name,c.position_name position_name,q.series_name,
      60 duration_minutes,60 pass_score,14 question_count,100 total_score,20 max_attempts,
      coalesce((select count(*) from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id
        where s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status<>'expired'
          and public.exam_norm(a.team_name)=public.exam_norm(c.team_name)
          and public.exam_norm(a.position_name)=public.exam_norm(c.position_name)
          and public.exam_norm(a.series_name)=public.exam_norm(q.series_name)),0) attempts,
      (select s.id from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id
        where s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status='in_progress' and s.expires_at>now()
          and public.exam_norm(a.team_name)=public.exam_norm(c.team_name)
          and public.exam_norm(a.position_name)=public.exam_norm(c.position_name)
          and public.exam_norm(a.series_name)=public.exam_norm(q.series_name)
        order by s.started_at desc limit 1) resume_session_id,
      (count(*) filter(where q.points=5)>=10 and count(*) filter(where q.points=10)>=3 and count(*) filter(where q.points=20)>=1) pool_ready,
      jsonb_build_object('5',count(*) filter(where q.points=5),'10',count(*) filter(where q.points=10),'20',count(*) filter(where q.points=20)) pool_counts
    from public.exam_questions q
    where q.active and nullif(btrim(q.series_name),'') is not null
      and public.exam_norm(q.team_name)=public.exam_norm(c.team_name)
      and public.exam_norm(q.position_name)=public.exam_norm(c.position_name)
    group by q.series_name
  ) x;

  return jsonb_build_object(
    'profile',to_jsonb(c),'assignments',v_assignments,
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select s.id,a.title,a.series_name,s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,
        s.earned_score,s.total_score,s.percentage,s.passed,s.grader_note,
        coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
        count(ans.id) filter(where ans.grade_status='correct') correct_count,
        count(ans.id) filter(where ans.grade_status='partial') partial_count,
        count(ans.id) filter(where ans.grade_status='wrong') wrong_count,
        count(ans.id) filter(where ans.grade_status is null) pending_count
      from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id
      left join public.user_access ua on ua.auth_user_id=s.graded_by
      left join public.exam_answers ans on ans.session_id=s.id
      where s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status<>'in_progress'
      group by s.id,a.title,a.series_name,ua.login_username,ua.login_email
      order by s.started_at desc limit 100
    ) x)
  );
end $$;

create or replace function public.staff_exam_start_adaptive(p_series text)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare
  c record; a public.exam_assignments; s public.exam_sessions; v_questions jsonb; v_saved jsonb;
  v_total numeric:=0; v_count integer:=0; v_five integer:=0; v_ten integer:=0; v_twenty integer:=0; v_attempt integer:=0; v_title text;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if nullif(btrim(p_series),'') is null then raise exception '请选择盘口'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  select count(*) filter(where q.points=5),count(*) filter(where q.points=10),count(*) filter(where q.points=20)
  into v_five,v_ten,v_twenty from public.exam_questions q
  where q.active and public.exam_norm(q.team_name)=public.exam_norm(c.team_name)
    and public.exam_norm(q.position_name)=public.exam_norm(c.position_name)
    and public.exam_norm(q.series_name)=public.exam_norm(p_series);
  if v_five<10 or v_ten<3 or v_twenty<1 then
    raise exception '该盘口题库不足14题/100分：5分题 %/10，10分题 %/3，20分题 %/1',v_five,v_ten,v_twenty;
  end if;

  perform pg_advisory_xact_lock(hashtext(concat('adaptive-exam:',c.employee_id::text,':',public.exam_norm(p_series))));
  select ses.* into s from public.exam_sessions ses join public.exam_assignments x on x.id=ses.assignment_id
  where ses.employee_id=c.employee_id and ses.auth_user_id=auth.uid() and ses.status='in_progress' and ses.expires_at>now()
    and public.exam_norm(x.team_name)=public.exam_norm(c.team_name) and public.exam_norm(x.position_name)=public.exam_norm(c.position_name)
    and public.exam_norm(x.series_name)=public.exam_norm(p_series) order by ses.started_at desc limit 1;
  if s.id is not null then
    select coalesce(jsonb_object_agg(question_id::text,answer_text),'{}'::jsonb) into v_saved from public.exam_answers where session_id=s.id;
    select * into a from public.exam_assignments where id=s.assignment_id;
    return to_jsonb(s)||jsonb_build_object('saved_answers',coalesce(v_saved,'{}'::jsonb),'resumed',true,'title',a.title);
  end if;

  update public.exam_sessions s0 set status='expired',updated_at=now()
  where s0.employee_id=c.employee_id and s0.auth_user_id=auth.uid() and s0.status='in_progress' and s0.expires_at<=now();
  v_title:=concat(btrim(p_series),' · ',c.team_name,' · ',c.position_name,' 岗位考试');
  select * into a from public.exam_assignments x where x.employee_id is null and x.status='published'
    and public.exam_norm(x.team_name)=public.exam_norm(c.team_name) and public.exam_norm(x.position_name)=public.exam_norm(c.position_name)
    and public.exam_norm(x.series_name)=public.exam_norm(p_series) and x.duration_minutes=60
    and x.question_rules='{"5":10,"10":3,"20":1}'::jsonb order by x.created_at desc limit 1;
  if a.id is null then
    insert into public.exam_assignments(title,team_name,position_name,series_name,employee_id,duration_minutes,pass_score,question_rules,start_at,end_at,max_attempts,status,created_by,updated_by)
    values(v_title,c.team_name,c.position_name,btrim(p_series),null,60,60,'{"5":10,"10":3,"20":1}'::jsonb,now(),null,20,'published',auth.uid(),auth.uid()) returning * into a;
  end if;
  select count(*)+1 into v_attempt from public.exam_sessions s0 where s0.assignment_id=a.id and s0.employee_id=c.employee_id and s0.status<>'expired';
  if v_attempt>a.max_attempts then raise exception '已达到考试次数上限'; end if;

  with ranked as (
    select q.*,row_number() over(partition by q.points order by random()) rn from public.exam_questions q
    where q.active and public.exam_norm(q.team_name)=public.exam_norm(c.team_name)
      and public.exam_norm(q.position_name)=public.exam_norm(c.position_name) and public.exam_norm(q.series_name)=public.exam_norm(p_series)
  ), selected as (
    select *,random() sort_key from ranked where (points=5 and rn<=10) or (points=10 and rn<=3) or (points=20 and rn<=1)
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'external_key',external_key,'series_name',series_name,'team_name',team_name,'position_name',position_name,
    'question_en',question_en,'question_zh',question_zh,'question_vi',question_vi,'points',points,'difficulty',difficulty,'image_urls',image_urls) order by sort_key),'[]'::jsonb),
    coalesce(sum(points),0),count(*) into v_questions,v_total,v_count from selected;
  if v_count<>14 or v_total<>100 then raise exception '生成试卷失败：必须为14题、100分，当前为%题、%分',v_count,v_total; end if;
  insert into public.exam_sessions(assignment_id,employee_id,auth_user_id,attempt_no,question_snapshot,expires_at,total_score)
  values(a.id,c.employee_id,auth.uid(),v_attempt,v_questions,now()+interval '60 minutes',100) returning * into s;
  return to_jsonb(s)||jsonb_build_object('saved_answers','{}'::jsonb,'resumed',false,'title',v_title);
end $$;

revoke all on function public.staff_exam_home() from public,anon;
revoke all on function public.staff_exam_start_adaptive(text) from public,anon;
grant execute on function public.staff_exam_home() to authenticated;
grant execute on function public.staff_exam_start_adaptive(text) to authenticated;

create or replace function public.admin_exam_dashboard(
  p_search text default '', p_team text default '', p_position text default '', p_page integer default 1, p_page_size integer default 30
) returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare v_rows jsonb; v_total bigint; v_page integer:=greatest(coalesce(p_page,1),1); v_size integer:=least(greatest(coalesce(p_page_size,30),1),100);
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限'; end if;
  select count(*) into v_total from public.exam_questions q where q.active
    and (btrim(p_team)='' or public.exam_norm(q.team_name)=public.exam_norm(p_team)) and (btrim(p_position)='' or public.exam_norm(q.position_name)=public.exam_norm(p_position))
    and (btrim(p_search)='' or q.external_key ilike '%'||p_search||'%' or q.series_name ilike '%'||p_search||'%' or q.question_zh ilike '%'||p_search||'%' or q.question_en ilike '%'||p_search||'%' or q.question_vi ilike '%'||p_search||'%');
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_rows from (
    select q.id,q.external_key,q.sheet_row,q.series_name,q.team_name,q.position_name,q.question_en,q.question_zh,q.question_vi,q.points,q.difficulty,q.image_urls,q.active,q.sync_status,q.updated_at
    from public.exam_questions q where q.active
      and (btrim(p_team)='' or public.exam_norm(q.team_name)=public.exam_norm(p_team)) and (btrim(p_position)='' or public.exam_norm(q.position_name)=public.exam_norm(p_position))
      and (btrim(p_search)='' or q.external_key ilike '%'||p_search||'%' or q.series_name ilike '%'||p_search||'%' or q.question_zh ilike '%'||p_search||'%' or q.question_en ilike '%'||p_search||'%' or q.question_vi ilike '%'||p_search||'%')
    order by q.team_name,q.position_name,q.series_name,q.sheet_row nulls last limit v_size offset (v_page-1)*v_size
  ) x;
  return jsonb_build_object(
    'counts',jsonb_build_object('questions',(select count(*) from public.exam_questions where active),'assignments',(select count(*) from public.exam_assignments where status='published'),'total_sessions',(select count(*) from public.exam_sessions),'pending_grading',(select count(*) from public.exam_sessions where status in ('submitted','grading')),'completed',(select count(*) from public.exam_sessions where status='graded')),
    'teams',(select coalesce(jsonb_agg(name order by name),'[]'::jsonb) from (select distinct team_name name from public.exam_questions where active) a),
    'series',(select coalesce(jsonb_agg(name order by name),'[]'::jsonb) from (select distinct series_name name from public.exam_questions where active and nullif(btrim(series_name),'') is not null) a),
    'positions',(select coalesce(jsonb_agg(name order by name),'[]'::jsonb) from (select distinct position_name name from public.exam_questions where active) a),
    'questions',v_rows,'total',v_total,'page',v_page,'page_size',v_size,
    'assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc),'[]'::jsonb) from (select x.id,x.title,x.series_name,x.team_name,x.position_name,x.employee_id,e.employee_no,e.full_name employee_name,x.duration_minutes,x.pass_score,x.question_rules,x.start_at,x.end_at,x.max_attempts,x.status,x.created_at from public.exam_assignments x left join public.employees e on e.id=x.employee_id order by x.created_at desc limit 100) a),
    'sessions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select s.id,s.employee_id,e.employee_no,e.full_name employee_name,a.title,a.series_name,a.team_name,a.position_name,s.attempt_no,s.status,s.started_at,s.submitted_at,s.earned_score,s.total_score,s.percentage,s.passed,
        count(ans.id) filter(where ans.grade_status='correct') correct_count,count(ans.id) filter(where ans.grade_status='partial') partial_count,count(ans.id) filter(where ans.grade_status='wrong') wrong_count,count(ans.id) filter(where ans.grade_status is null) pending_count
      from public.exam_sessions s join public.employees e on e.id=s.employee_id join public.exam_assignments a on a.id=s.assignment_id left join public.exam_answers ans on ans.session_id=s.id
      group by s.id,e.employee_no,e.full_name,a.title,a.series_name,a.team_name,a.position_name order by s.started_at desc limit 100) x),
    'analytics',jsonb_build_object(
      'summary',(select jsonb_build_object('total_attempts',count(*),'graded_attempts',count(*) filter(where s.status='graded'),'pass_count',count(*) filter(where s.status='graded' and s.passed),'fail_count',count(*) filter(where s.status='graded' and not s.passed),'avg_score',round(avg(s.percentage) filter(where s.status='graded'),1),'pass_rate',round(100.0*count(*) filter(where s.status='graded' and s.passed)/nullif(count(*) filter(where s.status='graded'),0),1),'avg_duration_seconds',round(avg(extract(epoch from (s.submitted_at-s.started_at))) filter(where s.submitted_at is not null and s.started_at is not null)),'correct_count',(select count(*) from public.exam_answers where grade_status='correct'),'partial_count',(select count(*) from public.exam_answers where grade_status='partial'),'wrong_count',(select count(*) from public.exam_answers where grade_status='wrong'),'pending_count',(select count(*) from public.exam_answers where grade_status is null)) from public.exam_sessions s),
      'series',(select coalesce(jsonb_agg(to_jsonb(x) order by x.average desc,x.name),'[]'::jsonb) from (select coalesce(nullif(a.series_name,''),nullif(a.team_name,''),'未分类') name,round(avg(s.percentage),1) average,count(*) attempts from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id where s.status='graded' group by coalesce(nullif(a.series_name,''),nullif(a.team_name,''),'未分类')) x),
      'positions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.average desc,x.name),'[]'::jsonb) from (select coalesce(nullif(a.position_name,''),'未分类') name,round(avg(s.percentage),1) average,count(*) attempts from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id where s.status='graded' group by coalesce(nullif(a.position_name,''),'未分类')) x)),
    'last_sync',(select to_jsonb(r) from public.exam_sync_runs r order by started_at desc limit 1));
end $$;

revoke all on function public.admin_exam_dashboard(text,text,text,integer,integer) from public,anon;
grant execute on function public.admin_exam_dashboard(text,text,text,integer,integer) to authenticated;
