-- Show current and imported legacy exam attempts in the employee archive.
create or replace function public.admin_employee_exam_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_employee_no text;
  v_result jsonb;
begin
  if not public.exam_is_admin('exam.view') then raise exception '没有考试查看权限'; end if;

  select e.employee_no into v_employee_no from public.employees e where e.id=p_employee_id;
  if v_employee_no is null then raise exception '员工档案不存在'; end if;

  with history as materialized (
    select u.*
    from public.admin_exam_combined_sessions_v u
    where u.employee_id=p_employee_id
       or (u.source_system='legacy' and public.exam_norm(u.employee_no)=public.exam_norm(v_employee_no))
  )
  select jsonb_build_object(
    'employee',(select to_jsonb(x) from(
      select e.id,e.employee_no,e.full_name,t.name team_name,p.name position_name
      from public.employees e left join public.teams t on t.id=e.team_id left join public.positions p on p.id=e.position_id
      where e.id=p_employee_id
    )x),
    'summary',jsonb_build_object(
      'attempts',count(*),
      'graded',count(*) filter(where status='graded'),
      'passed',count(*) filter(where status='graded' and passed),
      'average',round(avg(percentage) filter(where status='graded'),1),
      'current_attempts',count(*) filter(where source_system='current'),
      'legacy_attempts',count(*) filter(where source_system='legacy'),
      'pending',count(*) filter(where status in('submitted','grading','in_progress'))
    ),
    'history',coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at desc) from(
      select id,title,attempt_no,status,started_at,submitted_at,graded_at,earned_score,total_score,percentage,passed,
        grader_name,correct_count,partial_count,wrong_count,pending_count,source_system,source_label,read_only,
        team_name,position_name,series_name
      from history order by started_at desc limit 200
    )x),'[]'::jsonb)
  ) into v_result
  from history;

  return coalesce(v_result,jsonb_build_object('summary',jsonb_build_object('attempts',0,'graded',0,'passed',0,'average',null,'current_attempts',0,'legacy_attempts',0,'pending',0),'history','[]'::jsonb));
end;
$$;

revoke all on function public.admin_employee_exam_history(uuid) from public,anon;
grant execute on function public.admin_employee_exam_history(uuid) to authenticated;
notify pgrst,'reload schema';
