-- Deleting a current-system session is intentionally separate from managing
-- questions, assignments, or grading. Legacy records are never eligible.

insert into public.permissions (code, name, category, sensitive)
values ('exam.delete', '考试 · 删除本系统考试记录', 'exam', true)
on conflict (code) do update
set name = excluded.name,
    category = excluded.category,
    sensitive = excluded.sensitive;

-- Founder is already all-permission by design. Do not grant this destructive
-- permission to any other role by default: assign it explicitly in 用户与权限.

create or replace function public.admin_exam_delete_current_session(
  p_session_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_session record;
  v_answer_count integer;
  v_expected_confirmation text;
begin
  if not public.exam_is_admin('exam.view')
     or not public.exam_is_admin('exam.delete') then
    raise exception '没有删除本系统考试记录权限';
  end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  -- This table is exclusively the new system. A legacy session ID is not
  -- accepted, so retained old-exam history can never be removed through UI.
  select
    s.id,
    s.employee_id,
    e.employee_no,
    e.full_name as employee_name,
    a.title,
    s.started_at,
    s.submitted_at,
    s.earned_score,
    s.total_score,
    s.percentage,
    s.status
  into v_session
  from public.exam_sessions s
  join public.employees e on e.id = s.employee_id
  join public.exam_assignments a on a.id = s.assignment_id
  where s.id = p_session_id
  for update of s;

  if not found then
    raise exception '本系统考试记录不存在，或该记录不允许删除';
  end if;
  if not session_private.exam_employee_in_scope(v_session.employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  -- Include the unique session prefix so two attempts by the same employee
  -- can never share the same confirmation phrase.
  v_expected_confirmation := '删除 ' || v_session.employee_no || ' ' || left(v_session.id::text, 8);
  if btrim(coalesce(p_confirmation, '')) <> v_expected_confirmation then
    raise exception '请准确输入“%”确认删除', v_expected_confirmation;
  end if;

  select count(*)::integer
  into v_answer_count
  from public.exam_answers
  where session_id = v_session.id;

  -- Keep a minimal, non-answer audit trail. The actual answer rows are removed
  -- by the existing ON DELETE CASCADE FK with their test session.
  insert into public.audit_logs (
    actor_user_id,
    employee_id,
    module,
    action,
    record_id,
    old_data,
    new_data,
    reason
  ) values (
    (select auth.uid()),
    v_session.employee_id,
    'exam',
    'delete_current_session',
    v_session.id::text,
    jsonb_build_object(
      'source_system', 'current',
      'employee_no', v_session.employee_no,
      'employee_name', v_session.employee_name,
      'title', v_session.title,
      'started_at', v_session.started_at,
      'submitted_at', v_session.submitted_at,
      'status', v_session.status,
      'earned_score', v_session.earned_score,
      'total_score', v_session.total_score,
      'percentage', v_session.percentage,
      'answer_count', v_answer_count
    ),
    null,
    '管理员确认删除本系统考试记录'
  );

  delete from public.exam_sessions
  where id = v_session.id;

  return jsonb_build_object(
    'ok', true,
    'deleted_session_id', v_session.id,
    'deleted_answer_count', v_answer_count
  );
end;
$$;

revoke all on function public.admin_exam_delete_current_session(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_exam_delete_current_session(uuid, text)
  to authenticated;

notify pgrst, 'reload schema';
