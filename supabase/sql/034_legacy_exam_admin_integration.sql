-- Unified admin read model for current and legacy exams.

create or replace view public.admin_exam_combined_sessions_v with (security_invoker=true) as
select s.id,s.employee_id,e.employee_no,e.full_name employee_name,a.title,a.team_name,a.position_name,
  s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,s.earned_score,s.total_score,s.percentage,s.passed,
  coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
  (select count(*) from public.exam_answers x where x.session_id=s.id and x.grade_status='correct')::integer correct_count,
  (select count(*) from public.exam_answers x where x.session_id=s.id and x.grade_status='partial')::integer partial_count,
  (select count(*) from public.exam_answers x where x.session_id=s.id and x.grade_status='wrong')::integer wrong_count,
  (select count(*) from public.exam_answers x where x.session_id=s.id and x.grade_status is null)::integer pending_count,
  'current'::text source_system,'本系统'::text source_label,'matched'::text employee_match_status,false read_only,
  a.series_name
from public.exam_sessions s join public.employees e on e.id=s.employee_id
join public.exam_assignments a on a.id=s.assignment_id left join public.user_access ua on ua.auth_user_id=s.graded_by
union all
select l.id,l.employee_id,coalesce(e.employee_no,l.employee_no,'—'),coalesce(e.full_name,l.employee_name,'未匹配员工'),
  concat_ws(' · ',nullif(l.series_name,''),nullif(l.position_name,''))||' 考试',coalesce(t.name,'未匹配团队'),
  coalesce(p.name,l.position_name,'—'),l.attempt_no,l.status,l.started_at,l.submitted_at,l.graded_at,l.earned_score,
  l.total_score,l.percentage,l.passed,'旧系统',coalesce(l.correct_count,0),0,
  greatest(coalesce(l.total_questions,0)-coalesce(l.correct_count,0),0),
  case when l.status in('submitted','in_progress') then coalesce(l.total_questions,0) else 0 end,
  'legacy','旧考试',l.employee_match_status,true,l.series_name
from public.legacy_exam_sessions l left join public.employees e on e.id=l.employee_id
left join public.teams t on t.id=e.team_id left join public.positions p on p.id=e.position_id;

revoke all on public.admin_exam_combined_sessions_v from public,anon,authenticated;

create or replace function public.admin_exam_sessions_search_v3(
  p_employee_no text default '',p_employee_name text default '',p_exam text default '',p_team text default '',
  p_position text default '',p_status text default '',p_grader text default '',p_source text default '',
  p_date_from date default null,p_date_to date default null,p_page integer default 1,p_page_size integer default 30
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_page integer:=greatest(coalesce(p_page,1),1);v_size integer:=least(greatest(coalesce(p_page_size,30),1),100);v_result jsonb;
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限';end if;
  with filtered as materialized(
    select * from public.admin_exam_combined_sessions_v u
    where (btrim(coalesce(p_employee_no,''))='' or u.employee_no ilike '%'||btrim(p_employee_no)||'%')
      and (btrim(coalesce(p_employee_name,''))='' or u.employee_name ilike '%'||btrim(p_employee_name)||'%')
      and (btrim(coalesce(p_exam,''))='' or u.title ilike '%'||btrim(p_exam)||'%')
      and (btrim(coalesce(p_team,''))='' or public.exam_norm(u.team_name)=public.exam_norm(p_team))
      and (btrim(coalesce(p_position,''))='' or public.exam_norm(u.position_name)=public.exam_norm(p_position))
      and (btrim(coalesce(p_status,''))='' or (p_status='pending' and u.status in('submitted','grading')) or u.status=p_status)
      and (btrim(coalesce(p_grader,''))='' or u.grader_name ilike '%'||btrim(p_grader)||'%')
      and (btrim(coalesce(p_source,''))='' or p_source='all' or u.source_system=p_source)
      and (p_date_from is null or coalesce(u.submitted_at,u.started_at)::date>=p_date_from)
      and (p_date_to is null or coalesce(u.submitted_at,u.started_at)::date<=p_date_to)
  )
  select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(x) order by x.sort_at desc) from(
    select f.*,coalesce(f.submitted_at,f.started_at) sort_at from filtered f order by coalesce(f.submitted_at,f.started_at) desc
    limit v_size offset(v_page-1)*v_size)x),'[]'::jsonb),'total',(select count(*) from filtered),'page',v_page,'page_size',v_size) into v_result;
  return v_result;
end $$;

create or replace function public.admin_exam_analytics_v3()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限';end if;
  with a as materialized(select *,extract(epoch from(submitted_at-started_at)) duration_seconds from public.admin_exam_combined_sessions_v)
  select jsonb_build_object(
    'summary',(select jsonb_build_object('total_attempts',count(*),'graded_attempts',count(*)filter(where status='graded'),
      'pass_count',count(*)filter(where status='graded' and passed),'fail_count',count(*)filter(where status='graded' and not passed),
      'avg_score',round(avg(percentage)filter(where status='graded'),1),'pass_rate',round(100.0*count(*)filter(where status='graded' and passed)/nullif(count(*)filter(where status='graded'),0),1),
      'avg_duration_seconds',round(avg(duration_seconds)filter(where duration_seconds>=0)),'correct_count',coalesce(sum(correct_count)filter(where source_system='current'),0),'partial_count',coalesce(sum(partial_count)filter(where source_system='current'),0),
      'wrong_count',coalesce(sum(wrong_count)filter(where source_system='current'),0),'pending_count',coalesce(sum(pending_count)filter(where source_system='current'),0),'answer_stats_scope','current','current_attempts',count(*)filter(where source_system='current'),
      'legacy_attempts',count(*)filter(where source_system='legacy'),'legacy_pending',count(*)filter(where source_system='legacy' and status in('submitted','in_progress')))from a),
    'series',(select coalesce(jsonb_agg(to_jsonb(x)order by average desc,name),'[]'::jsonb)from(select coalesce(nullif(series_name,''),'未分类')name,round(avg(percentage),1)average,count(*)attempts from a where status='graded'group by 1)x),
    'positions',(select coalesce(jsonb_agg(to_jsonb(x)order by average desc,name),'[]'::jsonb)from(select coalesce(nullif(position_name,''),'未分类')name,round(avg(percentage),1)average,count(*)attempts from a where status='graded'group by 1)x),
    'teams',(select coalesce(jsonb_agg(to_jsonb(x)order by average desc,name),'[]'::jsonb)from(select coalesce(nullif(team_name,''),'未分类')name,round(avg(percentage),1)average,count(*)attempts from a where status='graded'group by 1)x),
    'score_bands',(select jsonb_build_object('excellent',count(*)filter(where percentage>=90),'good',count(*)filter(where percentage>=80 and percentage<90),'pass',count(*)filter(where percentage>=60 and percentage<80),'fail',count(*)filter(where percentage<60))from a where status='graded'),
    'trend',(select coalesce(jsonb_agg(to_jsonb(x)order by trend_day),'[]'::jsonb)from(select submitted_at::date trend_day,round(avg(percentage),1)average,count(*)attempts from a where status='graded'and submitted_at>=current_date-interval'29 days'group by 1)x),
    'leaderboard',(select coalesce(jsonb_agg(to_jsonb(x)order by rank_no,employee_name),'[]'::jsonb)from(select dense_rank()over(order by avg(percentage)desc,max(percentage)desc,count(*)desc)rank_no,min(employee_id::text)::uuid employee_id,employee_no,max(employee_name)employee_name,coalesce(max(team_name),'—')team_name,count(*)attempts,round(avg(percentage),1)average_score,max(percentage)best_score,count(*)filter(where passed)pass_count,max(submitted_at)last_exam_at,count(*)filter(where source_system='legacy')legacy_attempts from a where status='graded'group by employee_no order by rank_no,employee_name)x),
    'sources',(select coalesce(jsonb_agg(to_jsonb(x)order by source_system),'[]'::jsonb)from(select source_system,count(*)attempts,count(*)filter(where status='graded')graded,count(*)filter(where status in('submitted','in_progress'))pending,round(avg(percentage)filter(where status='graded'),1)average from a group by source_system)x)
  )into v_result;return v_result;
end $$;

create or replace function public.admin_legacy_exam_overview()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限';end if;
  return jsonb_build_object('counts',jsonb_build_object('total_sessions',(select count(*)from public.legacy_exam_sessions),'pending_grading',(select count(*)from public.legacy_exam_sessions where status='submitted'),'in_progress',(select count(*)from public.legacy_exam_sessions where status='in_progress'),'completed',(select count(*)from public.legacy_exam_sessions where status='graded'),'matched',(select count(*)from public.legacy_exam_sessions where employee_match_status='matched'),'unmatched',(select count(*)from public.legacy_exam_sessions where employee_match_status<>'matched')),
    'sessions',(select coalesce(jsonb_agg(to_jsonb(x)order by x.started_at desc),'[]'::jsonb)from(select * from public.admin_exam_combined_sessions_v where source_system='legacy'order by started_at desc limit 12)x),
    'sync_state',(select to_jsonb(s)-'exporter_url'from public.legacy_exam_sync_state s order by updated_at desc limit 1));
end $$;

create or replace function public.admin_legacy_exam_session_detail(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限';end if;
  return jsonb_build_object('session',(select to_jsonb(x)from(select * from public.admin_exam_combined_sessions_v where id=p_session_id and source_system='legacy')x),
    'answers',(select coalesce(jsonb_agg(to_jsonb(x)order by x.answered_at,x.answer_id),'[]'::jsonb)from(select a.id answer_id,a.source_question_id question_id,
      coalesce(nullif(a.question_snapshot->>'question_zh',''),nullif(a.question_snapshot->>'question',''),'旧考试题目 · '||coalesce(a.source_question_id::text,'无题目ID'))question_zh,
      coalesce(a.question_snapshot->>'question_en','')question_en,coalesce(a.question_snapshot->>'question_vi','')question_vi,coalesce(a.question_points,0)points,
      a.answer_text,a.grade_status,a.awarded_score,a.feedback grader_feedback,a.attachments image_urls,a.feedback_images,a.answered_at,a.graded_at,'旧系统'grader_name,true read_only
      from public.legacy_exam_answers a where a.legacy_session_id=p_session_id)x));
end $$;

revoke all on function public.admin_exam_sessions_search_v3(text,text,text,text,text,text,text,text,date,date,integer,integer),public.admin_exam_analytics_v3(),public.admin_legacy_exam_overview(),public.admin_legacy_exam_session_detail(uuid) from public,anon;
grant execute on function public.admin_exam_sessions_search_v3(text,text,text,text,text,text,text,text,date,date,integer,integer),public.admin_exam_analytics_v3(),public.admin_legacy_exam_overview(),public.admin_legacy_exam_session_detail(uuid) to authenticated;
notify pgrst,'reload schema';
