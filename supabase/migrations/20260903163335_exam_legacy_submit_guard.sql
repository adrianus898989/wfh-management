-- Keep the legacy one-argument submit RPC for older portal code, but apply the
-- same current-device, employee ownership and expiry-grace boundary as the
-- atomic final-answer endpoint.

create or replace function public.staff_exam_submit(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_context record;
  v_session public.exam_sessions;
begin
  if (select auth.uid()) is null
     or not session_private.current_app_session_is_valid('staff') then
    raise exception 'session_not_current';
  end if;
  select * into v_context from public.exam_staff_context();
  if v_context.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  select session_row.* into v_session
  from public.exam_sessions session_row
  where session_row.id=p_session_id
    and session_row.auth_user_id=(select auth.uid())
    and session_row.employee_id=v_context.employee_id
    and session_row.status='in_progress'
    and session_row.expires_at>now()-interval '30 seconds'
  for update;
  if not found then raise exception '考试无法提交'; end if;

  insert into public.exam_answers(session_id,question_id,answer_text,attachments,saved_at)
  select v_session.id,(question.item->>'id')::uuid,'','[]'::jsonb,now()
  from jsonb_array_elements(v_session.question_snapshot) question(item)
  on conflict(session_id,question_id) do nothing;

  update public.exam_sessions
  set status='submitted',submitted_at=now(),updated_at=now()
  where id=v_session.id
  returning * into v_session;
  return to_jsonb(v_session);
end;
$$;

revoke all on function public.staff_exam_submit(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_exam_submit(uuid)
  to authenticated;

comment on function public.staff_exam_submit(uuid) is
  'Compatibility submit endpoint constrained to the current staff lease, owned employee, and short expiry grace.';

notify pgrst, 'reload schema';
