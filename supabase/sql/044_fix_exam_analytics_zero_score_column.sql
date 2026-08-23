-- Keep the analytics RPC aligned with admin_exam_combined_sessions_v.
-- The view exposes zero_score_answer_count; the previous RPC referenced the
-- internal lateral alias zero_score_count, which is not part of the view API.

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
      'legacy_correct_count',coalesce(sum(correct_count)filter(where source_system='legacy'),0),
      'legacy_partial_count',coalesce(sum(partial_count)filter(where source_system='legacy'),0),
      'legacy_wrong_count',coalesce(sum(wrong_count)filter(where source_system='legacy'),0),
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
  )into v_result;
  return v_result;
end $$;

revoke all on function public.admin_exam_analytics_v3() from public,anon;
grant execute on function public.admin_exam_analytics_v3() to authenticated;

notify pgrst, 'reload schema';
