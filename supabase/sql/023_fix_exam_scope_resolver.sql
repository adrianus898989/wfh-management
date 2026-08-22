-- Fix PL/pgSQL record/SQL alias collision in the adaptive exam scope resolver.

create or replace function public.exam_resolve_staff_scope(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  v_employee record;
  v_mapping record;
  v_question_team text;
  v_question_position text;
begin
  select emp.id, emp.employee_no, emp.full_name, emp.work_content, emp.platform_scope,
         team_row.name as employee_team, position_row.name as employee_position
  into v_employee
  from public.employees emp
  left join public.teams team_row on team_row.id=emp.team_id
  left join public.positions position_row on position_row.id=emp.position_id
  where emp.id=p_employee_id
    and emp.status in ('active','probation')
  limit 1;

  if v_employee.id is null then return null; end if;

  if exists (
    select 1 from public.exam_questions question_row
    where question_row.active
      and public.exam_norm(question_row.team_name)=public.exam_norm(v_employee.employee_team)
      and public.exam_norm(question_row.position_name)=public.exam_norm(v_employee.employee_position)
  ) then
    v_question_team:=v_employee.employee_team;
    v_question_position:=v_employee.employee_position;
  else
    select mapping_row.* into v_mapping
    from public.exam_scope_mappings mapping_row
    where mapping_row.active
      and public.exam_norm(mapping_row.employee_team)=public.exam_norm(v_employee.employee_team)
      and public.exam_norm(mapping_row.employee_position)=public.exam_norm(v_employee.employee_position)
      and (nullif(btrim(mapping_row.work_pattern),'') is null
        or concat_ws(' ',v_employee.work_content,v_employee.platform_scope) ~* mapping_row.work_pattern)
    order by mapping_row.priority, mapping_row.created_at
    limit 1;
    v_question_team:=v_mapping.question_team;
    v_question_position:=v_mapping.question_position;
  end if;

  return jsonb_build_object(
    'employee_id',v_employee.id,
    'employee_no',v_employee.employee_no,
    'employee_name',v_employee.full_name,
    'employee_team',v_employee.employee_team,
    'employee_position',v_employee.employee_position,
    'question_team',v_question_team,
    'question_position',v_question_position
  );
end;
$$;

revoke all on function public.exam_resolve_staff_scope(uuid) from public, anon, authenticated;
