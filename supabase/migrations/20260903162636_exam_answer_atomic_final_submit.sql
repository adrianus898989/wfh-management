-- Preserve known attachments when their metadata could not be restored, and
-- save the current question together with final submission in one transaction.

create or replace function public.staff_exam_save_answer(
  p_session_id uuid,
  p_question_id uuid,
  p_answer text,
  p_attachments jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_context record;
  v_session public.exam_sessions;
  v_answer public.exam_answers;
  v_attachments jsonb:=p_attachments;
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
  if not found then raise exception '考试已结束或无权操作'; end if;
  if not exists(
    select 1 from jsonb_array_elements(v_session.question_snapshot) question(item)
    where question.item->>'id'=p_question_id::text
  ) then raise exception '题目不属于本次考试'; end if;

  if v_attachments is not null then
    if coalesce(jsonb_typeof(v_attachments),'')<>'array'
       or jsonb_array_length(v_attachments)>6 then
      raise exception '答题图片最多上传6张';
    end if;
    if exists(
      select 1
      from jsonb_array_elements(v_attachments) attachment(item)
      where jsonb_typeof(attachment.item)<>'object'
        or jsonb_typeof(attachment.item->'path')<>'string'
        or jsonb_typeof(attachment.item->'name')<>'string'
        or jsonb_typeof(attachment.item->'size')<>'number'
        or jsonb_typeof(attachment.item->'type')<>'string'
    ) then raise exception '答题图片资料格式不正确'; end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'path',btrim(attachment.item->>'path'),
      'name',btrim(attachment.item->>'name'),
      'size',(attachment.item->>'size')::numeric,
      'type',lower(btrim(attachment.item->>'type'))
    ) order by attachment.ordinality),'[]'::jsonb)
    into v_attachments
    from jsonb_array_elements(v_attachments)
      with ordinality attachment(item,ordinality);
  end if;

  insert into public.exam_answers(session_id,question_id,answer_text,attachments,saved_at)
  values(v_session.id,p_question_id,coalesce(p_answer,''),coalesce(v_attachments,'[]'::jsonb),now())
  on conflict(session_id,question_id) do update set
    answer_text=excluded.answer_text,
    attachments=case
      when p_attachments is null then public.exam_answers.attachments
      else excluded.attachments
    end,
    saved_at=now()
  returning * into v_answer;
  return to_jsonb(v_answer);
end;
$$;

create or replace function public.staff_exam_submit_with_answer(
  p_session_id uuid,
  p_question_id uuid,
  p_answer text,
  p_attachments jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_context record;
  v_session public.exam_sessions;
  v_attachments jsonb:=p_attachments;
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
  if not exists(
    select 1 from jsonb_array_elements(v_session.question_snapshot) question(item)
    where question.item->>'id'=p_question_id::text
  ) then raise exception '题目不属于本次考试'; end if;

  if v_attachments is not null then
    if coalesce(jsonb_typeof(v_attachments),'')<>'array'
       or jsonb_array_length(v_attachments)>6 then
      raise exception '答题图片最多上传6张';
    end if;
    if exists(
      select 1
      from jsonb_array_elements(v_attachments) attachment(item)
      where jsonb_typeof(attachment.item)<>'object'
        or jsonb_typeof(attachment.item->'path')<>'string'
        or jsonb_typeof(attachment.item->'name')<>'string'
        or jsonb_typeof(attachment.item->'size')<>'number'
        or jsonb_typeof(attachment.item->'type')<>'string'
    ) then raise exception '答题图片资料格式不正确'; end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'path',btrim(attachment.item->>'path'),
      'name',btrim(attachment.item->>'name'),
      'size',(attachment.item->>'size')::numeric,
      'type',lower(btrim(attachment.item->>'type'))
    ) order by attachment.ordinality),'[]'::jsonb)
    into v_attachments
    from jsonb_array_elements(v_attachments)
      with ordinality attachment(item,ordinality);
  end if;

  insert into public.exam_answers(session_id,question_id,answer_text,attachments,saved_at)
  values(v_session.id,p_question_id,coalesce(p_answer,''),coalesce(v_attachments,'[]'::jsonb),now())
  on conflict(session_id,question_id) do update set
    answer_text=excluded.answer_text,
    attachments=case
      when p_attachments is null then public.exam_answers.attachments
      else excluded.attachments
    end,
    saved_at=now();

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

revoke all on function public.staff_exam_save_answer(uuid,uuid,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.staff_exam_submit_with_answer(uuid,uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.staff_exam_save_answer(uuid,uuid,text,jsonb)
  to authenticated;
grant execute on function public.staff_exam_submit_with_answer(uuid,uuid,text,jsonb)
  to authenticated;

comment on function public.staff_exam_save_answer(uuid,uuid,text,jsonb) is
  'Saves one current staff answer with a short expiry-boundary grace; null attachments preserve restored evidence.';
comment on function public.staff_exam_submit_with_answer(uuid,uuid,text,jsonb) is
  'Atomically saves the final current question and submits the owned staff exam with a short expiry-boundary grace.';

notify pgrst, 'reload schema';
