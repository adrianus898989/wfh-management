-- Use synced legacy submissions as the source of truth for per-question results.
-- Legacy question snapshots do not include point maxima, so a positive awarded
-- score is reported as "scored" rather than guessed to be correct/partial.
create or replace view public.admin_exam_combined_sessions_v with (security_invoker=true) as
select s.id,s.employee_id,e.employee_no,e.full_name employee_name,a.title,a.team_name,a.position_name,
  s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,s.earned_score,s.total_score,s.percentage,s.passed,
  coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
  coalesce(ans.correct_count,0) correct_count,coalesce(ans.partial_count,0) partial_count,
  coalesce(ans.wrong_count,0) wrong_count,coalesce(ans.pending_count,0) pending_count,
  'current'::text source_system,'本系统'::text source_label,'matched'::text employee_match_status,false read_only,
  a.series_name,coalesce(ans.answer_count,0)>0 answer_detail_available,coalesce(ans.answer_count,0) answer_detail_count,
  coalesce(ans.scored_count,0) scored_answer_count,coalesce(ans.zero_score_count,0) zero_score_answer_count
from public.exam_sessions s
join public.employees e on e.id=s.employee_id
join public.exam_assignments a on a.id=s.assignment_id
left join public.user_access ua on ua.auth_user_id=s.graded_by
left join lateral(
  select count(*)::integer answer_count,
    count(*)filter(where x.grade_status='correct')::integer correct_count,
    count(*)filter(where x.grade_status='partial')::integer partial_count,
    count(*)filter(where x.grade_status='wrong')::integer wrong_count,
    count(*)filter(where x.grade_status is null)::integer pending_count,
    count(*)filter(where x.grade_status in('correct','partial'))::integer scored_count,
    count(*)filter(where x.grade_status='wrong')::integer zero_score_count
  from public.exam_answers x where x.session_id=s.id
)ans on true
union all
select l.id,l.employee_id,coalesce(e.employee_no,l.employee_no,'—'),coalesce(e.full_name,l.employee_name,'未匹配员工'),
  concat_ws(' · ',nullif(l.series_name,''),nullif(l.position_name,''))||' 考试',coalesce(t.name,'未匹配团队'),
  coalesce(p.name,l.position_name,'—'),l.attempt_no,l.status,l.started_at,l.submitted_at,l.graded_at,l.earned_score,
  l.total_score,l.percentage,l.passed,'旧系统',0,coalesce(ans.scored_count,0),coalesce(ans.zero_score_count,0),
  coalesce(ans.pending_count,0),'legacy','旧考试',l.employee_match_status,true,l.series_name,
  coalesce(ans.answer_count,0)>0,coalesce(ans.answer_count,0),coalesce(ans.scored_count,0),coalesce(ans.zero_score_count,0)
from public.legacy_exam_sessions l
left join public.employees e on e.id=l.employee_id
left join public.teams t on t.id=e.team_id
left join public.positions p on p.id=e.position_id
left join lateral(
  select count(*)::integer answer_count,
    count(*)filter(where a.awarded_score>0 and a.graded_at is not null)::integer scored_count,
    count(*)filter(where coalesce(a.awarded_score,0)=0 and a.graded_at is not null)::integer zero_score_count,
    count(*)filter(where a.graded_at is null)::integer pending_count
  from public.legacy_exam_answers a where a.legacy_session_id=l.id
)ans on true;

revoke all on public.admin_exam_combined_sessions_v from public,anon,authenticated;

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
      'avg_duration_seconds',round(avg(duration_seconds)filter(where duration_seconds>=0)),
      'correct_count',coalesce(sum(correct_count)filter(where source_system='current'),0),
      'partial_count',coalesce(sum(partial_count)filter(where source_system='current'),0),
      'wrong_count',coalesce(sum(wrong_count)filter(where source_system='current'),0),
      'pending_count',coalesce(sum(pending_count)filter(where source_system='current'),0),
      'answer_stats_scope','synced_detail','current_attempts',count(*)filter(where source_system='current'),
      'legacy_attempts',count(*)filter(where source_system='legacy'),
      'legacy_pending',count(*)filter(where source_system='legacy' and status in('submitted','in_progress')),
      'legacy_answer_sessions',count(*)filter(where source_system='legacy' and answer_detail_available),
      'legacy_answer_count',coalesce(sum(answer_detail_count)filter(where source_system='legacy'),0),
      'legacy_scored_count',coalesce(sum(scored_answer_count)filter(where source_system='legacy'),0),
      'legacy_zero_score_count',coalesce(sum(zero_score_answer_count)filter(where source_system='legacy'),0),
      'legacy_answer_pending_count',coalesce(sum(pending_count)filter(where source_system='legacy'),0))from a),
    'series',(select coalesce(jsonb_agg(to_jsonb(x)order by average desc,name),'[]'::jsonb)from(select coalesce(nullif(series_name,''),'未分类')name,round(avg(percentage),1)average,count(*)attempts from a where status='graded'group by 1)x),
    'positions',(select coalesce(jsonb_agg(to_jsonb(x)order by average desc,name),'[]'::jsonb)from(select coalesce(nullif(position_name,''),'未分类')name,round(avg(percentage),1)average,count(*)attempts from a where status='graded'group by 1)x),
    'teams',(select coalesce(jsonb_agg(to_jsonb(x)order by average desc,name),'[]'::jsonb)from(select coalesce(nullif(team_name,''),'未分类')name,round(avg(percentage),1)average,count(*)attempts from a where status='graded'group by 1)x),
    'score_bands',(select jsonb_build_object('excellent',count(*)filter(where percentage>=90),'good',count(*)filter(where percentage>=80 and percentage<90),'pass',count(*)filter(where percentage>=60 and percentage<80),'fail',count(*)filter(where percentage<60))from a where status='graded'),
    'trend',(select coalesce(jsonb_agg(to_jsonb(x)order by trend_day),'[]'::jsonb)from(select submitted_at::date trend_day,round(avg(percentage),1)average,count(*)attempts from a where status='graded'and submitted_at>=current_date-interval'29 days'group by 1)x),
    'daily_activity',(select coalesce(jsonb_agg(to_jsonb(x)order by activity_day),'[]'::jsonb)from(
      select submitted_at::date activity_day,count(*) submitted,
        count(*)filter(where status='graded') graded,
        count(*)filter(where status in('submitted','in_progress')) pending,
        count(*)filter(where source_system='current') current_submitted,
        count(*)filter(where source_system='legacy') legacy_submitted,
        round(avg(percentage)filter(where status='graded'),1) average_score
      from a where submitted_at is not null and submitted_at>=current_date-interval'29 days' group by 1
    )x),
    'leaderboard',(select coalesce(jsonb_agg(to_jsonb(x)order by rank_no,employee_name),'[]'::jsonb)from(select dense_rank()over(order by avg(percentage)desc,max(percentage)desc,count(*)desc)rank_no,min(employee_id::text)::uuid employee_id,employee_no,max(employee_name)employee_name,coalesce(max(team_name),'—')team_name,count(*)attempts,round(avg(percentage),1)average_score,max(percentage)best_score,count(*)filter(where passed)pass_count,max(submitted_at)last_exam_at,count(*)filter(where source_system='legacy')legacy_attempts from a where status='graded'group by employee_no order by rank_no,employee_name)x),
    'sources',(select coalesce(jsonb_agg(to_jsonb(x)order by source_system),'[]'::jsonb)from(select source_system,count(*)attempts,count(*)filter(where status='graded')graded,count(*)filter(where status in('submitted','in_progress'))pending,round(avg(percentage)filter(where status='graded'),1)average from a group by source_system)x)
  )into v_result;return v_result;
end $$;

revoke all on function public.admin_exam_analytics_v3() from public,anon;
grant execute on function public.admin_exam_analytics_v3() to authenticated;
notify pgrst,'reload schema';
