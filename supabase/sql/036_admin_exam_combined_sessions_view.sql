-- Shared read model used by employee archives and exam reporting.
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
