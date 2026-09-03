-- The session-wide quota must use a session-wide lock: uploads to different
-- questions can otherwise observe the same total concurrently.

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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format('%s/%s',v_user_id,v_session_id),
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

revoke all on function session_private.exam_answer_storage_can_upload(text)
  from public, anon, authenticated;
grant execute on function session_private.exam_answer_storage_can_upload(text)
  to authenticated;

comment on function session_private.exam_answer_storage_can_upload(text) is
  'Private session-serialized Storage RLS guard with bounded per-question and whole-exam upload quotas.';

notify pgrst, 'reload schema';
