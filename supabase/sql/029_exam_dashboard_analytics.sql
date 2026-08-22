-- Fix recent-exam answer counts and add overview analytics from authoritative answer rows.

create or replace function public.admin_exam_dashboard(
  p_search text default '', p_team text default '', p_position text default '', p_page integer default 1, p_page_size integer default 30
) returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare v_rows jsonb; v_total bigint; v_page integer:=greatest(coalesce(p_page,1),1); v_size integer:=least(greatest(coalesce(p_page_size,30),1),100);
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限'; end if;
  select count(*) into v_total from public.exam_questions q where q.active
    and (btrim(p_team)='' or public.exam_norm(q.team_name)=public.exam_norm(p_team)) and (btrim(p_position)='' or public.exam_norm(q.position_name)=public.exam_norm(p_position))
    and (btrim(p_search)='' or q.external_key ilike '%'||p_search||'%' or q.question_zh ilike '%'||p_search||'%' or q.question_en ilike '%'||p_search||'%' or q.question_vi ilike '%'||p_search||'%');
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_rows from (
    select q.id,q.external_key,q.sheet_row,q.team_name,q.position_name,q.question_en,q.question_zh,q.question_vi,q.points,q.difficulty,q.image_urls,q.active,q.sync_status,q.updated_at
    from public.exam_questions q where q.active
      and (btrim(p_team)='' or public.exam_norm(q.team_name)=public.exam_norm(p_team)) and (btrim(p_position)='' or public.exam_norm(q.position_name)=public.exam_norm(p_position))
      and (btrim(p_search)='' or q.external_key ilike '%'||p_search||'%' or q.question_zh ilike '%'||p_search||'%' or q.question_en ilike '%'||p_search||'%' or q.question_vi ilike '%'||p_search||'%')
    order by q.team_name,q.position_name,q.sheet_row nulls last limit v_size offset (v_page-1)*v_size
  ) x;
  return jsonb_build_object(
    'counts',jsonb_build_object(
      'questions',(select count(*) from public.exam_questions where active),
      'assignments',(select count(*) from public.exam_assignments where status='published'),
      'total_sessions',(select count(*) from public.exam_sessions),
      'pending_grading',(select count(*) from public.exam_sessions where status in ('submitted','grading')),
      'completed',(select count(*) from public.exam_sessions where status='graded')),
    'teams',(select coalesce(jsonb_agg(name order by name),'[]'::jsonb) from (select distinct team_name name from public.exam_questions where active) a),
    'positions',(select coalesce(jsonb_agg(name order by name),'[]'::jsonb) from (select distinct position_name name from public.exam_questions where active) a),
    'questions',v_rows,'total',v_total,'page',v_page,'page_size',v_size,
    'assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc),'[]'::jsonb) from (
      select x.id,x.title,x.team_name,x.position_name,x.employee_id,e.employee_no,e.full_name employee_name,x.duration_minutes,x.pass_score,x.question_rules,x.start_at,x.end_at,x.max_attempts,x.status,x.created_at
      from public.exam_assignments x left join public.employees e on e.id=x.employee_id order by x.created_at desc limit 100
    ) a),
    'sessions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select s.id,s.employee_id,e.employee_no,e.full_name employee_name,a.title,a.team_name,a.position_name,s.attempt_no,s.status,s.started_at,s.submitted_at,s.earned_score,s.total_score,s.percentage,s.passed,
        count(ans.id) filter(where ans.grade_status='correct') correct_count,
        count(ans.id) filter(where ans.grade_status='partial') partial_count,
        count(ans.id) filter(where ans.grade_status='wrong') wrong_count,
        count(ans.id) filter(where ans.grade_status is null) pending_count
      from public.exam_sessions s join public.employees e on e.id=s.employee_id join public.exam_assignments a on a.id=s.assignment_id
      left join public.exam_answers ans on ans.session_id=s.id
      group by s.id,e.employee_no,e.full_name,a.title,a.team_name,a.position_name
      order by s.started_at desc limit 100
    ) x),
    'analytics',jsonb_build_object(
      'summary',(select jsonb_build_object(
        'total_attempts',count(*),'graded_attempts',count(*) filter(where s.status='graded'),
        'pass_count',count(*) filter(where s.status='graded' and s.passed),'fail_count',count(*) filter(where s.status='graded' and not s.passed),
        'avg_score',round(avg(s.percentage) filter(where s.status='graded'),1),
        'pass_rate',round(100.0*count(*) filter(where s.status='graded' and s.passed)/nullif(count(*) filter(where s.status='graded'),0),1),
        'avg_duration_seconds',round(avg(extract(epoch from (s.submitted_at-s.started_at))) filter(where s.submitted_at is not null and s.started_at is not null)),
        'correct_count',(select count(*) from public.exam_answers where grade_status='correct'),
        'partial_count',(select count(*) from public.exam_answers where grade_status='partial'),
        'wrong_count',(select count(*) from public.exam_answers where grade_status='wrong'),
        'pending_count',(select count(*) from public.exam_answers where grade_status is null)
      ) from public.exam_sessions s),
      'series',(select coalesce(jsonb_agg(to_jsonb(x) order by x.average desc,x.name),'[]'::jsonb) from (
        select coalesce(nullif(a.team_name,''),'未分类') name,round(avg(s.percentage),1) average,count(*) attempts
        from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id where s.status='graded'
        group by coalesce(nullif(a.team_name,''),'未分类')
      ) x),
      'positions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.average desc,x.name),'[]'::jsonb) from (
        select coalesce(nullif(a.position_name,''),'未分类') name,round(avg(s.percentage),1) average,count(*) attempts
        from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id where s.status='graded'
        group by coalesce(nullif(a.position_name,''),'未分类')
      ) x)
    ),
    'last_sync',(select to_jsonb(r) from public.exam_sync_runs r order by started_at desc limit 1)
  );
end $$;

revoke all on function public.admin_exam_dashboard(text,text,text,integer,integer) from public,anon;
grant execute on function public.admin_exam_dashboard(text,text,text,integer,integer) to authenticated;
