-- Match legacy sessions by exact employee ID first, then by a unique exact name.
create or replace function public.legacy_exam_refresh_employee_matches()
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  with employee_no_keys as materialized(
    select public.exam_norm(e.employee_no) match_key,count(distinct e.id) match_count,
      case when count(distinct e.id)=1 then min(e.id::text)::uuid end employee_id
    from public.employees e where nullif(public.exam_norm(e.employee_no),'') is not null group by 1
  ),employee_name_keys as materialized(
    select public.exam_norm(e.full_name) match_key,count(distinct e.id) match_count,
      case when count(distinct e.id)=1 then min(e.id::text)::uuid end employee_id
    from public.employees e where nullif(public.exam_norm(e.full_name),'') is not null group by 1
  ),name_candidates as(
    select l.id,n.match_count,n.employee_id from public.legacy_exam_sessions l
    join employee_name_keys n on n.match_key=public.exam_norm(l.employee_name)
    where nullif(public.exam_norm(l.employee_name),'') is not null
    union all
    select l.id,n.match_count,n.employee_id from public.legacy_exam_sessions l
    join employee_name_keys n on n.match_key=public.exam_norm(l.employee_no)
    where nullif(public.exam_norm(l.employee_no),'') is not null
  ),name_matches as(
    select id,case when bool_or(match_count>1) then 2 else count(distinct employee_id) end match_count,
      case when not bool_or(match_count>1) and count(distinct employee_id)=1 then min(employee_id::text)::uuid end employee_id
    from name_candidates group by id
  ),matched as(
    select l.id,
      case when id_match.match_count=1 then id_match.employee_id
        when coalesce(id_match.match_count,0)=0 and name_match.match_count=1 then name_match.employee_id end employee_id,
      case when id_match.match_count=1 then 'matched' when id_match.match_count>1 then 'ambiguous'
        when name_match.match_count=1 then 'matched' when name_match.match_count>1 then 'ambiguous' else 'unmatched' end match_status
    from public.legacy_exam_sessions l
    left join employee_no_keys id_match on id_match.match_key=public.exam_norm(l.employee_no)
    left join name_matches name_match on name_match.id=l.id
  )
  update public.legacy_exam_sessions l set employee_id=m.employee_id,employee_match_status=m.match_status,
    synced_at=case when l.employee_id is distinct from m.employee_id or l.employee_match_status is distinct from m.match_status then now() else l.synced_at end
  from matched m where m.id=l.id;
  get diagnostics v_count=row_count;return v_count;
end $$;

revoke all on function public.legacy_exam_refresh_employee_matches() from public,anon,authenticated;
grant execute on function public.legacy_exam_refresh_employee_matches() to service_role;

-- Legacy records do not consistently contain reliable per-question verdicts,
-- so answer-quality counters below intentionally cover current-system records only.
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

revoke all on function public.admin_exam_analytics_v3() from public,anon;
grant execute on function public.admin_exam_analytics_v3() to authenticated;
notify pgrst,'reload schema';
