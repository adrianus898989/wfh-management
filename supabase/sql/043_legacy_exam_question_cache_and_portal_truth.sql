-- Cache the legacy question bank server-side so imported answers can be shown
-- with their real question text, maximum points and grading result.
create table if not exists public.legacy_exam_questions(
  source_project_ref text not null,
  source_question_id uuid not null,
  question_en text,
  question_zh text,
  question_vi text,
  points numeric not null default 0,
  image_urls jsonb not null default '[]'::jsonb,
  series_name text,
  position_name text,
  difficulty text,
  source_payload jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  primary key(source_project_ref,source_question_id)
);

alter table public.legacy_exam_questions enable row level security;
revoke all on public.legacy_exam_questions from public,anon,authenticated;
grant all on public.legacy_exam_questions to service_role;

create or replace function public.exam_employee_no_key(p_value text)
returns text language sql immutable parallel safe set search_path='' as $$
  select lower(regexp_replace(coalesce(p_value,''),'[^a-zA-Z0-9]+','','g'))
$$;

revoke all on function public.exam_employee_no_key(text) from public,anon,authenticated;
grant execute on function public.exam_employee_no_key(text) to service_role;

create or replace function public.legacy_exam_refresh_employee_matches()
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  with employee_no_keys as materialized(
    select public.exam_employee_no_key(e.employee_no) match_key,count(distinct e.id) match_count,
      case when count(distinct e.id)=1 then min(e.id::text)::uuid end employee_id
    from public.employees e
    where nullif(public.exam_employee_no_key(e.employee_no),'') is not null
    group by 1
  ),employee_name_keys as materialized(
    select public.exam_norm(e.full_name) match_key,count(distinct e.id) match_count,
      case when count(distinct e.id)=1 then min(e.id::text)::uuid end employee_id
    from public.employees e
    where nullif(public.exam_norm(e.full_name),'') is not null
    group by 1
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
    left join employee_no_keys id_match on id_match.match_key=public.exam_employee_no_key(l.employee_no)
    left join name_matches name_match on name_match.id=l.id
  )
  update public.legacy_exam_sessions l
  set employee_id=m.employee_id,employee_match_status=m.match_status,
    synced_at=case when l.employee_id is distinct from m.employee_id or l.employee_match_status is distinct from m.match_status then now() else l.synced_at end
  from matched m where m.id=l.id;
  get diagnostics v_count=row_count;
  return v_count;
end $$;

create or replace function public.legacy_exam_match_employee_row()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_count integer;v_employee_id uuid;
begin
  select count(distinct e.id),case when count(distinct e.id)=1 then min(e.id::text)::uuid end
  into v_count,v_employee_id from public.employees e
  where nullif(public.exam_employee_no_key(new.employee_no),'') is not null
    and public.exam_employee_no_key(e.employee_no)=public.exam_employee_no_key(new.employee_no);
  if v_count=1 then new.employee_id:=v_employee_id;new.employee_match_status:='matched';return new;end if;
  if v_count>1 then new.employee_id:=null;new.employee_match_status:='ambiguous';return new;end if;
  select count(distinct e.id),case when count(distinct e.id)=1 then min(e.id::text)::uuid end
  into v_count,v_employee_id from public.employees e
  where public.exam_norm(e.full_name) in(nullif(public.exam_norm(new.employee_name),''),nullif(public.exam_norm(new.employee_no),''));
  new.employee_id:=case when v_count=1 then v_employee_id end;
  new.employee_match_status:=case when v_count=1 then 'matched' when v_count>1 then 'ambiguous' else 'unmatched' end;
  return new;
end $$;

revoke all on function public.legacy_exam_refresh_employee_matches(),public.legacy_exam_match_employee_row() from public,anon,authenticated;
grant execute on function public.legacy_exam_refresh_employee_matches() to service_role;

drop trigger if exists legacy_exam_match_employee_before_write on public.legacy_exam_sessions;
create trigger legacy_exam_match_employee_before_write
before insert or update of employee_no,employee_name,employee_id,employee_match_status
on public.legacy_exam_sessions for each row execute function public.legacy_exam_match_employee_row();

create or replace function public.legacy_exam_apply_question_snapshots()
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  update public.legacy_exam_answers a
  set question_snapshot=jsonb_strip_nulls(jsonb_build_object(
        'id',q.source_question_id,
        'question_en',q.question_en,'question_zh',q.question_zh,'question_vi',q.question_vi,
        'points',q.points,'score',q.points,'image_urls',q.image_urls,
        'series',q.series_name,'position',q.position_name,'difficulty',q.difficulty
      )),
      question_points=q.points,
      grade_status=case
        when a.graded_at is null then 'pending'
        when a.is_correct is true then 'correct'
        when a.is_correct is false and coalesce(a.awarded_score,0)>0 and q.points>0 and a.awarded_score<q.points then 'partial'
        when a.is_correct is false then 'wrong'
        when q.points>0 and coalesce(a.awarded_score,0)>=q.points then 'correct'
        when coalesce(a.awarded_score,0)>0 then 'partial'
        else 'wrong'
      end,
      synced_at=now()
  from public.legacy_exam_questions q
  where q.source_project_ref=a.source_project_ref
    and q.source_question_id=a.source_question_id
    and (a.question_snapshot is distinct from jsonb_strip_nulls(jsonb_build_object(
          'id',q.source_question_id,
          'question_en',q.question_en,'question_zh',q.question_zh,'question_vi',q.question_vi,
          'points',q.points,'score',q.points,'image_urls',q.image_urls,
          'series',q.series_name,'position',q.position_name,'difficulty',q.difficulty
        ))
      or a.question_points is distinct from q.points);
  get diagnostics v_count=row_count;
  return v_count;
end $$;

revoke all on function public.legacy_exam_apply_question_snapshots() from public,anon,authenticated;
grant execute on function public.legacy_exam_apply_question_snapshots() to service_role;

create or replace view public.admin_exam_combined_sessions_v with (security_invoker=true) as
select s.id,s.employee_id,e.employee_no,e.full_name employee_name,a.title,a.team_name,a.position_name,
  s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,s.earned_score,s.total_score,s.percentage,s.passed,
  coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
  coalesce(ans.correct_count,0) correct_count,coalesce(ans.partial_count,0) partial_count,
  coalesce(ans.wrong_count,0) wrong_count,coalesce(ans.pending_count,0) pending_count,
  'current'::text source_system,'本系统'::text source_label,'matched'::text employee_match_status,false read_only,
  a.series_name,coalesce(ans.answer_count,0)>0 answer_detail_available,coalesce(ans.answer_count,0) answer_detail_count,
  coalesce(ans.scored_count,0) scored_answer_count,coalesce(ans.zero_score_count,0) zero_score_answer_count,
  (case when jsonb_typeof(s.question_snapshot)='array' then jsonb_array_length(s.question_snapshot) else coalesce(ans.answer_count,0) end)::integer total_question_count,
  greatest((case when jsonb_typeof(s.question_snapshot)='array' then jsonb_array_length(s.question_snapshot) else coalesce(ans.answer_count,0) end)-coalesce(ans.answer_count,0),0)::integer unanswered_count
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
  l.total_score,l.percentage,l.passed,'旧系统',coalesce(ans.correct_count,0),coalesce(ans.partial_count,0),
  coalesce(ans.wrong_count,0),coalesce(ans.pending_count,0),'legacy','旧考试',l.employee_match_status,true,l.series_name,
  coalesce(ans.answer_count,0)>0,coalesce(ans.answer_count,0),coalesce(ans.scored_count,0),coalesce(ans.wrong_count,0),
  coalesce(nullif(l.total_questions,0),jsonb_array_length(l.question_ids),ans.answer_count,0)::integer,
  greatest(coalesce(nullif(l.total_questions,0),jsonb_array_length(l.question_ids),ans.answer_count,0)-coalesce(ans.answer_count,0),0)::integer
from public.legacy_exam_sessions l
left join public.employees e on e.id=l.employee_id
left join public.teams t on t.id=e.team_id
left join public.positions p on p.id=e.position_id
left join lateral(
  select count(*)::integer answer_count,
    count(*)filter(where a.grade_status='correct')::integer correct_count,
    count(*)filter(where a.grade_status='partial')::integer partial_count,
    count(*)filter(where a.grade_status='wrong')::integer wrong_count,
    count(*)filter(where a.grade_status='pending')::integer pending_count,
    count(*)filter(where a.grade_status in('correct','partial'))::integer scored_count
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

create or replace function public.admin_legacy_exam_session_detail(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限';end if;
  return jsonb_build_object(
    'session',(select to_jsonb(x)from(select * from public.admin_exam_combined_sessions_v where id=p_session_id and source_system='legacy')x),
    'answers',(select coalesce(jsonb_agg(to_jsonb(x)order by x.answered_at,x.answer_id),'[]'::jsonb)from(
      select a.id answer_id,a.source_question_id question_id,
        coalesce(nullif(a.question_snapshot->>'question_zh',''),nullif(a.question_snapshot->>'question',''),'旧考试题目 · '||coalesce(a.source_question_id::text,'无题目ID'))question_zh,
        coalesce(a.question_snapshot->>'question_en','')question_en,
        coalesce(a.question_snapshot->>'question_vi','')question_vi,
        coalesce(a.question_points,0)points,a.answer_text,a.grade_status,a.awarded_score,
        a.feedback grader_feedback,
        coalesce(a.question_snapshot->'image_urls','[]'::jsonb)||coalesce(a.attachments,'[]'::jsonb)||coalesce(a.feedback_images,'[]'::jsonb) image_urls,
        a.answered_at,a.graded_at,'旧系统'grader_name,true read_only
      from public.legacy_exam_answers a where a.legacy_session_id=p_session_id
    )x)
  );
end $$;

revoke all on function public.admin_legacy_exam_session_detail(uuid) from public,anon;
grant execute on function public.admin_legacy_exam_session_detail(uuid) to authenticated;

select public.legacy_exam_refresh_employee_matches();
select public.legacy_exam_apply_question_snapshots();
notify pgrst,'reload schema';
