-- The UI limits saved answers to six images, but Storage policies must also
-- bound direct API uploads.  Serialize each question namespace and allow two
-- temporary objects for retry/cleanup while keeping the whole session bounded.

create or replace function session_private.exam_answer_storage_can_upload(p_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_parts text[] := string_to_array(coalesce(p_name,''),'/');
  v_session_id uuid;
  v_question_id uuid;
  v_session public.exam_sessions;
  v_question_object_count integer;
  v_session_object_count integer;
begin
  if v_user_id is null
     or not session_private.current_app_session_is_valid('staff')
     or cardinality(v_parts)<>4
     or v_parts[1]<>v_user_id::text
     or v_parts[4] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$' then
    return false;
  end if;

  begin
    v_session_id:=v_parts[2]::uuid;
    v_question_id:=v_parts[3]::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  select session_row.* into v_session
  from public.exam_sessions session_row
  where session_row.id=v_session_id
    and session_row.auth_user_id=v_user_id
    and session_row.status='in_progress'
    and session_row.expires_at>now();
  if not found then return false; end if;

  if not exists(
    select 1
    from public.exam_staff_context() context_row
    where context_row.auth_user_id=v_user_id
      and context_row.employee_id=v_session.employee_id
  ) or not exists(
    select 1
    from jsonb_array_elements(v_session.question_snapshot) question(item)
    where question.item->>'id'=v_question_id::text
  ) then
    return false;
  end if;

  -- The lock makes concurrent direct uploads observe the preceding committed
  -- object before checking the quota, rather than racing past the same count.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format('%s/%s/%s',v_user_id,v_session_id,v_question_id),
      0
    )
  );

  select
    count(*) filter(where split_part(object_row.name,'/',3)=v_question_id::text),
    count(*)
  into v_question_object_count,v_session_object_count
  from storage.objects object_row
  where object_row.bucket_id='exam-answer-images'
    and object_row.owner_id=v_user_id::text
    and object_row.name like pg_catalog.format('%s/%s/%%',v_user_id,v_session_id);

  return v_question_object_count<8 and v_session_object_count<112;
end;
$$;

-- A request can cross the exam-expiry boundary after its object was accepted.
-- Keep a short cleanup window for the owner, but never permit deletion while
-- the object is still referenced by an answer.
create or replace function session_private.exam_answer_storage_can_delete(
  p_name text,
  p_owner_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_parts text[] := string_to_array(coalesce(p_name,''),'/');
  v_session_id uuid;
  v_question_id uuid;
  v_session public.exam_sessions;
begin
  if v_user_id is null
     or not session_private.current_app_session_is_valid('staff')
     or coalesce(p_owner_id,'')<>v_user_id::text
     or cardinality(v_parts)<>4
     or v_parts[1]<>v_user_id::text then
    return false;
  end if;

  begin
    v_session_id:=v_parts[2]::uuid;
    v_question_id:=v_parts[3]::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  select session_row.* into v_session
  from public.exam_sessions session_row
  where session_row.id=v_session_id
    and session_row.auth_user_id=v_user_id
    and session_row.expires_at>now()-interval '24 hours';
  if not found then return false; end if;

  if not exists(
    select 1
    from public.exam_staff_context() context_row
    where context_row.auth_user_id=v_user_id
      and context_row.employee_id=v_session.employee_id
  ) or not exists(
    select 1
    from jsonb_array_elements(v_session.question_snapshot) question(item)
    where question.item->>'id'=v_question_id::text
  ) then
    return false;
  end if;

  return not exists(
    select 1
    from public.exam_answers answer
    where jsonb_array_length(answer.attachments)>0
      and answer.attachments @> jsonb_build_array(jsonb_build_object('path',coalesce(p_name,'')))
  );
end;
$$;

revoke all on function session_private.exam_answer_storage_can_upload(text)
  from public, anon, authenticated;
revoke all on function session_private.exam_answer_storage_can_delete(text, text)
  from public, anon, authenticated;
grant execute on function session_private.exam_answer_storage_can_upload(text)
  to authenticated;
grant execute on function session_private.exam_answer_storage_can_delete(text, text)
  to authenticated;

comment on function session_private.exam_answer_storage_can_upload(text) is
  'Private serialized Storage RLS guard with bounded per-question and per-session upload quotas.';
comment on function session_private.exam_answer_storage_can_delete(text,text) is
  'Private Storage RLS guard for owner cleanup of unreferenced exam images through the expiry boundary.';

notify pgrst, 'reload schema';
