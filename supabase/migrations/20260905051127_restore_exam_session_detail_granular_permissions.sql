begin;

-- The feedback-image projection replaced this reader after granular page
-- permissions were introduced.  Restore the latest page-specific bridge while
-- preserving the new projection, current admin-session validation inside
-- has_permission(), and the existing employee-scope guard.
do $exam_session_detail_permission_recovery$
declare
  v_definition text;
begin
  if to_regprocedure('public.admin_exam_session_detail(uuid)') is null then
    raise exception 'admin_exam_session_detail_permission_recovery_prerequisite_missing';
  end if;

  select pg_get_functiondef(
    'public.admin_exam_session_detail(uuid)'::regprocedure
  )
  into v_definition;

  if strpos(v_definition, 'public.exam_is_admin(''exam.view'')') = 0
     or strpos(v_definition, 'public.exam_is_admin(''exam.grade'')') = 0
     or strpos(v_definition, 'grader_feedback_attachments') = 0
     or strpos(
       v_definition,
       'session_private.exam_employee_in_scope(v_employee_id)'
     ) = 0 then
    raise exception 'admin_exam_session_detail_permission_recovery_prerequisite_changed';
  end if;

  execute replace(
    replace(
      v_definition,
      'public.exam_is_admin(''exam.view'')',
      '(public.has_permission(''exam.records.view'') or public.has_permission(''employee.directory.view''))'
    ),
    'public.exam_is_admin(''exam.grade'')',
    'public.has_permission(''exam.grading.view'')'
  );
end
$exam_session_detail_permission_recovery$;

-- The grading page may preview reply images only while the attempt is in its
-- actionable queue.  Completed results remain visible through the records or
-- employee-directory permissions, not through grading-page access alone.
do $exam_feedback_storage_view_permission_recovery$
declare
  v_definition text;
  v_old_status_guard constant text :=
    'session_row.status in (''submitted'', ''grading'', ''graded'')';
begin
  if to_regprocedure(
    'session_private.exam_feedback_storage_can_view(text)'
  ) is null then
    raise exception 'exam_feedback_storage_view_permission_recovery_prerequisite_missing';
  end if;

  select pg_get_functiondef(
    'session_private.exam_feedback_storage_can_view(text)'::regprocedure
  )
  into v_definition;

  if strpos(v_definition, v_old_status_guard) = 0
     or strpos(
       v_definition,
       'session_private.current_app_session_is_valid(''admin'')'
     ) = 0
     or strpos(
       v_definition,
       'session_private.exam_employee_in_scope(session_row.employee_id)'
     ) = 0
     or strpos(
       v_definition,
       'public.has_permission(''exam.records.view'')'
     ) = 0
     or strpos(
       v_definition,
       'public.has_permission(''employee.directory.view'')'
     ) = 0
     or strpos(
       v_definition,
       'public.has_permission(''exam.grading.view'')'
     ) = 0 then
    raise exception 'exam_feedback_storage_view_permission_recovery_prerequisite_changed';
  end if;

  execute replace(
    v_definition,
    v_old_status_guard,
    'session_row.status in (''submitted'', ''grading'')'
  );
end
$exam_feedback_storage_view_permission_recovery$;

-- The canonical reader is an internal implementation detail.  Only the
-- page-specific SECURITY DEFINER wrappers may invoke it, so clients cannot
-- bypass their status checks or their projected-field whitelist.
revoke all on function public.admin_exam_session_detail(uuid)
  from public, anon, authenticated, service_role;

-- Storage RLS evaluates this private guard for signed-in clients.  Keep only
-- that minimum runtime grant; session_private is not an exposed API schema.
revoke all on function session_private.exam_feedback_storage_can_view(text)
  from public, anon, authenticated, service_role;
grant execute on function session_private.exam_feedback_storage_can_view(text)
  to authenticated;

-- Exact paths that become detached are recorded transactionally before the
-- client is asked to remove them from Storage.  Keeping this queue outside the
-- exposed API schemas makes cleanup durable without exposing attachment names
-- through the audit log or allowing clients to forge cleanup work.
create table if not exists session_private.exam_storage_cleanup_queue (
  id bigint generated always as identity primary key,
  bucket_id text not null
    check (bucket_id in ('exam-answer-images', 'exam-feedback-images')),
  object_name text not null,
  object_owner_id text not null,
  session_id uuid not null,
  employee_id uuid not null,
  source_action text not null
    check (source_action in ('delete_current_session', 'grade_feedback_replaced')),
  source_record_id text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (bucket_id, object_name)
);

create index if not exists exam_storage_cleanup_queue_session_idx
on session_private.exam_storage_cleanup_queue(session_id, created_at, id);

revoke all on table session_private.exam_storage_cleanup_queue
  from public, anon, authenticated, service_role;
revoke all on sequence session_private.exam_storage_cleanup_queue_id_seq
  from public, anon, authenticated, service_role;

create or replace function session_private.exam_storage_cleanup_path_is_valid(
  p_name text,
  p_owner_id text,
  p_session_id uuid
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    cardinality(parsed.parts) = 4
    and parsed.parts[1] = coalesce(p_owner_id, '')
    and parsed.parts[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and parsed.parts[2] = p_session_id::text
    and parsed.parts[3] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and parsed.parts[4] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$',
    false
  )
  from (select string_to_array(coalesce(p_name, ''), '/') parts) parsed;
$function$;

revoke all on function session_private.exam_storage_cleanup_path_is_valid(text, text, uuid)
  from public, anon, authenticated, service_role;

-- Both the legacy four-argument grader and the image-aware five-argument
-- grader converge here.  Enforce one lock order and one score/state invariant
-- so a caller cannot bypass the UI by invoking the older RPC directly.
do $exam_grade_integrity_prerequisites$
declare
  v_definition text;
begin
  if to_regprocedure(
    'public.admin_exam_grade_answer_audit_inner_v1(uuid,text,numeric,text)'
  ) is null then
    raise exception 'admin_exam_grade_integrity_prerequisite_missing';
  end if;
  select pg_get_functiondef(
    'public.admin_exam_grade_answer_audit_inner_v1(uuid,text,numeric,text)'::regprocedure
  ) into v_definition;
  if strpos(v_definition, 'admin_exam_grade_answer_page_v1') = 0
     or strpos(v_definition, 'exam.grading.grade') = 0
     or strpos(v_definition, 'exam_employee_in_scope') = 0 then
    raise exception 'admin_exam_grade_integrity_prerequisite_changed';
  end if;
end
$exam_grade_integrity_prerequisites$;

alter function public.admin_exam_grade_answer_audit_inner_v1(
  uuid,
  text,
  numeric,
  text
)
rename to admin_exam_grade_answer_integrity_page_v1;

revoke all on function public.admin_exam_grade_answer_integrity_page_v1(
  uuid,
  text,
  numeric,
  text
)
from public, anon, authenticated, service_role;

create function public.admin_exam_grade_answer_audit_inner_v1(
  p_answer_id uuid,
  p_status text,
  p_score numeric,
  p_feedback text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1500ms'
as $function$
declare
  v_session_id uuid;
  v_locked_session_id uuid;
  v_employee_id uuid;
  v_session_status text;
  v_question_id uuid;
  v_points numeric;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if session_private.current_app_session_is_valid('admin') is not true then
    raise exception 'session_not_current';
  end if;
  if public.has_permission('exam.grading.grade') is not true then
    raise exception 'permission_denied';
  end if;

  -- Discover the parent without taking a row lock, then always lock parent
  -- session before child answer.  Session deletion follows the same order.
  select answer.session_id
  into v_session_id
  from public.exam_answers answer
  where answer.id = p_answer_id;
  if not found then raise exception 'answer_not_found'; end if;

  select
    session_row.employee_id,
    session_row.status
  into v_employee_id, v_session_status
  from public.exam_sessions session_row
  where session_row.id = v_session_id
  for update;
  if not found then raise exception 'answer_not_found'; end if;

  select answer.session_id, answer.question_id
  into v_locked_session_id, v_question_id
  from public.exam_answers answer
  where answer.id = p_answer_id
  for update;
  if not found or v_locked_session_id is distinct from v_session_id then
    raise exception 'answer_session_changed';
  end if;

  select nullif(question.item->>'points', '')::numeric
  into v_points
  from public.exam_sessions session_row
  cross join lateral jsonb_array_elements(session_row.question_snapshot) question(item)
  where session_row.id = v_session_id
    and question.item->>'id' = v_question_id::text
  limit 1;
  if session_private.exam_employee_in_scope(v_employee_id) is not true then
    raise exception 'employee_out_of_scope';
  end if;
  if v_session_status is null
     or v_session_status not in ('submitted', 'grading', 'graded') then
    raise exception 'session_not_available_for_grading';
  end if;
  if v_points is null or v_points < 0 then
    raise exception 'exam_question_points_invalid';
  end if;
  if p_status is null
     or p_status not in ('wrong', 'partial', 'correct')
     or p_score is null
     or p_score < 0
     or p_score > v_points
     or (p_status = 'wrong' and p_score <> 0)
     or (p_status = 'partial' and p_score <> v_points / 2)
     or (p_status = 'correct' and p_score <> v_points) then
    raise exception 'exam_grade_value_invalid';
  end if;

  return public.admin_exam_grade_answer_integrity_page_v1(
    p_answer_id,
    p_status,
    p_score,
    p_feedback
  );
end;
$function$;

revoke all on function public.admin_exam_grade_answer_audit_inner_v1(
  uuid,
  text,
  numeric,
  text
)
from public, anon, authenticated, service_role;

-- Return the recalculated session status without changing the grading RPC's
-- arguments or its established validation/audit implementation.  The admin
-- grading UI can then close a just-completed queue item instead of attempting
-- a reader that correctly accepts only submitted/grading sessions.
do $exam_feedback_grade_result_prerequisites$
declare
  v_definition text;
begin
  if to_regprocedure(
    'public.admin_exam_grade_answer_with_feedback_images(uuid,text,numeric,text,jsonb)'
  ) is null then
    raise exception 'admin_exam_grade_feedback_result_prerequisite_missing';
  end if;

  select pg_get_functiondef(
    'public.admin_exam_grade_answer_with_feedback_images(uuid,text,numeric,text,jsonb)'::regprocedure
  )
  into v_definition;

  if strpos(v_definition, 'admin_exam_grade_answer_audit_inner_v1') = 0
     or strpos(v_definition, 'insert into public.audit_logs') = 0
     or strpos(v_definition, 'return to_jsonb(v_answer)') = 0 then
    raise exception 'admin_exam_grade_feedback_result_prerequisite_changed';
  end if;
end
$exam_feedback_grade_result_prerequisites$;

alter function public.admin_exam_grade_answer_with_feedback_images(
  uuid,
  text,
  numeric,
  text,
  jsonb
)
rename to admin_exam_grade_answer_with_feedback_images_page_v1;

revoke all on function public.admin_exam_grade_answer_with_feedback_images_page_v1(
  uuid,
  text,
  numeric,
  text,
  jsonb
)
from public, anon, authenticated, service_role;

create function public.admin_exam_grade_answer_with_feedback_images(
  p_answer_id uuid,
  p_status text,
  p_score numeric,
  p_feedback text,
  p_feedback_images jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1500ms'
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_result jsonb;
  v_session_id uuid;
  v_employee_id uuid;
  v_existing_session_status text;
  v_session_status text;
  v_old_feedback_attachments jsonb := '[]'::jsonb;
  v_new_feedback_attachments jsonb := '[]'::jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated'; end if;
  if session_private.current_app_session_is_valid('admin') is not true then
    raise exception 'session_not_current';
  end if;
  if public.has_permission('exam.grading.grade') is not true then
    raise exception 'permission_denied';
  end if;

  -- Discover the parent without a lock, then use the same session -> answer
  -- order as deletion.  This avoids an answer/session deadlock while retaining
  -- an atomic old-minus-new attachment snapshot.
  select answer.session_id
  into v_session_id
  from public.exam_answers answer
  where answer.id = p_answer_id;
  if not found then raise exception 'answer_not_found'; end if;

  select session_row.employee_id, session_row.status
  into v_employee_id, v_existing_session_status
  from public.exam_sessions session_row
  where session_row.id = v_session_id
  for update;
  if not found then raise exception 'answer_not_found'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format('exam-feedback-images/%s', v_session_id),
      0
    )
  );

  select coalesce(answer.grader_feedback_attachments, '[]'::jsonb)
  into v_old_feedback_attachments
  from public.exam_answers answer
  where answer.id = p_answer_id
    and answer.session_id = v_session_id
  for update;
  if not found then raise exception 'answer_session_changed'; end if;
  if session_private.exam_employee_in_scope(v_employee_id) is not true then
    raise exception 'employee_out_of_scope';
  end if;
  if v_existing_session_status is null
     or v_existing_session_status not in ('submitted', 'grading', 'graded') then
    raise exception 'session_not_available_for_grading';
  end if;

  v_result := public.admin_exam_grade_answer_with_feedback_images_page_v1(
    p_answer_id,
    p_status,
    p_score,
    p_feedback,
    p_feedback_images
  );

  if nullif(v_result->>'session_id', '')::uuid is distinct from v_session_id then
    raise exception 'exam_grade_session_changed';
  end if;
  v_new_feedback_attachments := coalesce(
    v_result->'grader_feedback_attachments',
    '[]'::jsonb
  );

  -- A path can be re-attached by a later save (for example after a response
  -- retry).  Once it is present in the committed answer again it must no
  -- longer be eligible for asynchronous cleanup, and its stale outbox row
  -- must not live forever merely because the reference guard blocks delete.
  delete from session_private.exam_storage_cleanup_queue cleanup
  using jsonb_array_elements(v_new_feedback_attachments) new_attachment(item)
  where cleanup.bucket_id = 'exam-feedback-images'
    and cleanup.session_id = v_session_id
    and cleanup.source_action = 'grade_feedback_replaced'
    and cleanup.source_record_id = p_answer_id::text
    and cleanup.object_name = new_attachment.item->>'path';

  insert into session_private.exam_storage_cleanup_queue(
    bucket_id,
    object_name,
    object_owner_id,
    session_id,
    employee_id,
    source_action,
    source_record_id,
    created_by
  )
  select
    object_row.bucket_id,
    object_row.name,
    object_row.owner_id,
    v_session_id,
    v_employee_id,
    'grade_feedback_replaced',
    p_answer_id::text,
    v_actor
  from jsonb_array_elements(v_old_feedback_attachments) old_attachment(item)
  join storage.objects object_row
    on object_row.bucket_id = 'exam-feedback-images'
   and object_row.name = old_attachment.item->>'path'
  where jsonb_typeof(old_attachment.item) = 'object'
    and nullif(old_attachment.item->>'path', '') is not null
    and split_part(object_row.name, '/', 3) = p_answer_id::text
    and session_private.exam_storage_cleanup_path_is_valid(
      object_row.name,
      object_row.owner_id,
      v_session_id
    )
    and not exists (
      select 1
      from jsonb_array_elements(v_new_feedback_attachments) new_attachment(item)
      where new_attachment.item->>'path' = object_row.name
    )
  on conflict (bucket_id, object_name) do update
  set object_owner_id = excluded.object_owner_id,
      session_id = excluded.session_id,
      employee_id = excluded.employee_id,
      source_action = excluded.source_action,
      source_record_id = excluded.source_record_id,
      created_by = excluded.created_by,
      created_at = now();

  select session_row.status
  into v_session_status
  from public.exam_sessions session_row
  where session_row.id = v_session_id;

  if not found then
    raise exception 'exam_session_not_found_after_grading';
  end if;

  return coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'session_status',
    v_session_status
  );
end;
$function$;

revoke all on function public.admin_exam_grade_answer_with_feedback_images(
  uuid,
  text,
  numeric,
  text,
  jsonb
)
from public, anon, authenticated, service_role;
grant execute on function public.admin_exam_grade_answer_with_feedback_images(
  uuid,
  text,
  numeric,
  text,
  jsonb
)
to authenticated, service_role;

-- Storage uploads and destructive session cleanup share a session lock.  The
-- lock is acquired before validating rows, so an upload released after a
-- completed delete re-checks the database and is rejected rather than creating
-- a late orphan.
create or replace function session_private.exam_answer_storage_can_upload(p_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_session_id uuid;
  v_question_id uuid;
  v_session public.exam_sessions;
  v_question_object_count integer;
  v_session_object_count integer;
begin
  if v_user_id is null
     or session_private.current_app_session_is_valid('staff') is not true
     or cardinality(v_parts) <> 4
     or v_parts[1] <> v_user_id::text
     or v_parts[4] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$' then
    return false;
  end if;

  begin
    v_session_id := v_parts[2]::uuid;
    v_question_id := v_parts[3]::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if v_parts[2] <> v_session_id::text
     or v_parts[3] <> v_question_id::text then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format('exam-answer-images/%s', v_session_id),
      0
    )
  );

  select session_row.* into v_session
  from public.exam_sessions session_row
  where session_row.id = v_session_id
    and session_row.auth_user_id = v_user_id
    and session_row.status = 'in_progress'
    and session_row.expires_at > now();
  if not found then return false; end if;

  if not exists (
    select 1 from public.exam_staff_context() context_row
    where context_row.auth_user_id = v_user_id
      and context_row.employee_id = v_session.employee_id
  ) or not exists (
    select 1 from jsonb_array_elements(v_session.question_snapshot) question(item)
    where question.item->>'id' = v_question_id::text
  ) then
    return false;
  end if;

  select
    count(*) filter (where split_part(object_row.name, '/', 3) = v_question_id::text),
    count(*)
  into v_question_object_count, v_session_object_count
  from storage.objects object_row
  where object_row.bucket_id = 'exam-answer-images'
    and object_row.owner_id = v_user_id::text
    and object_row.name like pg_catalog.format('%s/%s/%%', v_user_id, v_session_id);

  return v_question_object_count < 8 and v_session_object_count < 112;
end;
$function$;

create or replace function session_private.exam_feedback_storage_can_upload(p_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_session_id uuid;
  v_answer_id uuid;
  v_employee_id uuid;
  v_answer_object_count integer;
  v_session_object_count integer;
begin
  if v_user_id is null
     or session_private.current_app_session_is_valid('admin') is not true
     or public.has_permission('exam.grading.grade') is not true
     or cardinality(v_parts) <> 4
     or v_parts[1] <> v_user_id::text
     or v_parts[4] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$' then
    return false;
  end if;

  begin
    v_session_id := v_parts[2]::uuid;
    v_answer_id := v_parts[3]::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if v_parts[2] <> v_session_id::text
     or v_parts[3] <> v_answer_id::text then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format('exam-feedback-images/%s', v_session_id),
      0
    )
  );

  select session_row.employee_id
  into v_employee_id
  from public.exam_answers answer
  join public.exam_sessions session_row on session_row.id = answer.session_id
  where answer.id = v_answer_id
    and answer.session_id = v_session_id
    and session_row.status in ('submitted', 'grading', 'graded');

  if not found
     or session_private.exam_employee_in_scope(v_employee_id) is not true then
    return false;
  end if;

  select
    count(*) filter (where split_part(object_row.name, '/', 3) = v_answer_id::text),
    count(*)
  into v_answer_object_count, v_session_object_count
  from storage.objects object_row
  where object_row.bucket_id = 'exam-feedback-images'
    and split_part(object_row.name, '/', 2) = v_session_id::text;

  -- Three referenced images and one complete three-image replacement may
  -- coexist until the grading transaction commits and queues the old set.
  return v_answer_object_count < 6 and v_session_object_count < 70;
end;
$function$;

revoke all on function session_private.exam_answer_storage_can_upload(text)
  from public, anon, authenticated, service_role;
revoke all on function session_private.exam_feedback_storage_can_upload(text)
  from public, anon, authenticated, service_role;
grant execute on function session_private.exam_answer_storage_can_upload(text)
  to authenticated;
grant execute on function session_private.exam_feedback_storage_can_upload(text)
  to authenticated;

-- Storage DELETE must serialize with grading before it decides that a reply
-- image is detached.  Without this lock, one request can re-attach a queued
-- path while another request deletes the same object from an older snapshot.
create or replace function session_private.exam_feedback_storage_can_delete(
  p_name text,
  p_owner_id text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '1500ms'
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_session_id uuid;
  v_answer_id uuid;
  v_graded_by uuid;
  v_employee_id uuid;
begin
  if v_user_id is null
     or session_private.current_app_session_is_valid('admin') is not true
     or public.has_permission('exam.grading.grade') is not true
     or cardinality(v_parts) <> 4
     or coalesce(p_owner_id, '') <> v_parts[1] then
    return false;
  end if;

  begin
    v_session_id := v_parts[2]::uuid;
    v_answer_id := v_parts[3]::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if v_parts[2] <> v_session_id::text
     or v_parts[3] <> v_answer_id::text
     or session_private.exam_storage_cleanup_path_is_valid(
       p_name,
       p_owner_id,
       v_session_id
     ) is not true then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format('exam-feedback-images/%s', v_session_id),
      0
    )
  );

  -- VOLATILE makes these post-lock reads use a fresh command snapshot.  The
  -- uploader may remove its own failed, unreferenced upload even after the
  -- answer was deleted, but never an object that grading just re-attached.
  if coalesce(p_owner_id, '') = v_user_id::text
     and not exists (
       select 1
       from public.exam_answers answer
       where coalesce(answer.grader_feedback_attachments, '[]'::jsonb) @>
         jsonb_build_array(jsonb_build_object('path', p_name))
     ) then
    return true;
  end if;

  select answer.graded_by, session_row.employee_id
  into v_graded_by, v_employee_id
  from public.exam_answers answer
  join public.exam_sessions session_row on session_row.id = answer.session_id
  where answer.id = v_answer_id
    and answer.session_id = v_session_id;

  if not found
     or session_private.exam_employee_in_scope(v_employee_id) is not true
     or (
       coalesce(p_owner_id, '') <> v_user_id::text
       and v_graded_by is distinct from v_user_id
     ) then
    return false;
  end if;

  return not exists (
    select 1
    from public.exam_answers answer
    where coalesce(answer.grader_feedback_attachments, '[]'::jsonb) @>
      jsonb_build_array(jsonb_build_object('path', p_name))
  );
end;
$function$;

revoke all on function session_private.exam_feedback_storage_can_delete(text, text)
  from public, anon, authenticated, service_role;
grant execute on function session_private.exam_feedback_storage_can_delete(text, text)
  to authenticated;

create or replace function session_private.exam_session_storage_cleanup_paths(
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3500ms'
as $function$
declare
  v_answer_paths text[] := array[]::text[];
  v_feedback_paths text[] := array[]::text[];
begin
  select coalesce(array_agg(candidate.name order by candidate.name), array[]::text[])
  into v_answer_paths
  from (
    select object_row.name
    from storage.objects object_row
    where object_row.bucket_id = 'exam-answer-images'
      and session_private.exam_storage_cleanup_path_is_valid(
        object_row.name,
        object_row.owner_id,
        p_session_id
      )
    order by object_row.name
    limit 113
  ) candidate;

  select coalesce(array_agg(candidate.name order by candidate.name), array[]::text[])
  into v_feedback_paths
  from (
    select object_row.name
    from storage.objects object_row
    where object_row.bucket_id = 'exam-feedback-images'
      and session_private.exam_storage_cleanup_path_is_valid(
        object_row.name,
        object_row.owner_id,
        p_session_id
      )
    order by object_row.name
    limit 71
  ) candidate;

  if cardinality(v_answer_paths) > 112
     or cardinality(v_feedback_paths) > 70 then
    raise exception 'exam_storage_cleanup_limit_exceeded';
  end if;

  return jsonb_build_object(
    'exam-answer-images', to_jsonb(v_answer_paths),
    'exam-feedback-images', to_jsonb(v_feedback_paths)
  );
end;
$function$;

-- Return only exact queued objects that still exist and are no longer
-- referenced by an answer.  Per-response caps keep Storage.remove requests
-- bounded; a later pass drains any remaining batch.
create or replace function session_private.exam_queued_storage_cleanup_paths(
  p_session_id uuid,
  p_allow_session_delete boolean,
  p_allow_feedback_replacement boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3500ms'
as $function$
declare
  v_answer_paths text[] := array[]::text[];
  v_feedback_paths text[] := array[]::text[];
begin
  select coalesce(array_agg(candidate.name order by candidate.name), array[]::text[])
  into v_answer_paths
  from (
    select object_row.name
    from session_private.exam_storage_cleanup_queue cleanup
    join storage.objects object_row
      on object_row.bucket_id = cleanup.bucket_id
     and object_row.name = cleanup.object_name
     and object_row.owner_id = cleanup.object_owner_id
    where cleanup.session_id = p_session_id
      and cleanup.bucket_id = 'exam-answer-images'
      and p_allow_session_delete
      and cleanup.source_action = 'delete_current_session'
      and session_private.exam_employee_in_scope(cleanup.employee_id)
      and not exists (
        select 1 from public.exam_sessions session_row
        where session_row.id = p_session_id
      )
      and exists (
        select 1
        from public.audit_logs audit
        where audit.module = 'exam'
          and audit.action = 'delete_current_session'
          and audit.record_id = p_session_id::text
          and audit.employee_id = cleanup.employee_id
          and audit.old_data->>'source_system' = 'current'
      )
      and session_private.exam_storage_cleanup_path_is_valid(
        object_row.name,
        object_row.owner_id,
        p_session_id
      )
      and not exists (
        select 1
        from public.exam_answers answer
        where coalesce(answer.attachments, '[]'::jsonb) @> jsonb_build_array(
          jsonb_build_object('path', object_row.name)
        )
           or coalesce(answer.grader_feedback_attachments, '[]'::jsonb) @>
             jsonb_build_array(jsonb_build_object('path', object_row.name))
      )
    order by object_row.name
    limit 112
  ) candidate;

  select coalesce(array_agg(candidate.name order by candidate.name), array[]::text[])
  into v_feedback_paths
  from (
    select object_row.name
    from session_private.exam_storage_cleanup_queue cleanup
    join storage.objects object_row
      on object_row.bucket_id = cleanup.bucket_id
     and object_row.name = cleanup.object_name
     and object_row.owner_id = cleanup.object_owner_id
    where cleanup.session_id = p_session_id
      and cleanup.bucket_id = 'exam-feedback-images'
      and (
        (
          p_allow_session_delete
          and cleanup.source_action = 'delete_current_session'
          and not exists (
            select 1 from public.exam_sessions session_row
            where session_row.id = p_session_id
          )
          and exists (
            select 1
            from public.audit_logs audit
            where audit.module = 'exam'
              and audit.action = 'delete_current_session'
              and audit.record_id = p_session_id::text
              and audit.employee_id = cleanup.employee_id
              and audit.old_data->>'source_system' = 'current'
          )
        )
        or (
          p_allow_feedback_replacement
          and cleanup.source_action = 'grade_feedback_replaced'
        )
      )
      and session_private.exam_employee_in_scope(cleanup.employee_id)
      and session_private.exam_storage_cleanup_path_is_valid(
        object_row.name,
        object_row.owner_id,
        p_session_id
      )
      and not exists (
        select 1
        from public.exam_answers answer
        where coalesce(answer.attachments, '[]'::jsonb) @> jsonb_build_array(
          jsonb_build_object('path', object_row.name)
        )
           or coalesce(answer.grader_feedback_attachments, '[]'::jsonb) @>
             jsonb_build_array(jsonb_build_object('path', object_row.name))
      )
    order by object_row.name
    limit 70
  ) candidate;

  return jsonb_build_object(
    'exam-answer-images', to_jsonb(v_answer_paths),
    'exam-feedback-images', to_jsonb(v_feedback_paths)
  );
end;
$function$;

revoke all on function session_private.exam_storage_cleanup_path_is_valid(text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function session_private.exam_session_storage_cleanup_paths(uuid)
  from public, anon, authenticated, service_role;
revoke all on function session_private.exam_queued_storage_cleanup_paths(uuid, boolean, boolean)
  from public, anon, authenticated, service_role;

-- Deleting the database rows must not strand answer or teacher-feedback
-- images. Preserve the existing RPC signature, snapshot both locked private
-- namespaces, then delegate the established transactional delete and audit to
-- page_v1.
do $exam_session_delete_storage_cleanup_prerequisites$
declare
  v_page_definition text;
  v_wrapper_definition text;
begin
  if to_regprocedure('storage.allow_any_operation(text[])') is null
     or to_regprocedure('public.admin_exam_delete_current_session(uuid,text)') is null
     or to_regprocedure(
       'public.admin_exam_delete_current_session_page_v1(uuid,text)'
     ) is null then
    raise exception 'admin_exam_delete_storage_cleanup_prerequisite_missing';
  end if;

  select pg_get_functiondef(
    'public.admin_exam_delete_current_session(uuid,text)'::regprocedure
  ) into v_wrapper_definition;
  select pg_get_functiondef(
    'public.admin_exam_delete_current_session_page_v1(uuid,text)'::regprocedure
  ) into v_page_definition;

  if strpos(v_wrapper_definition, 'exam.records.delete') = 0
     or strpos(v_wrapper_definition, 'admin_exam_delete_current_session_page_v1') = 0
     or strpos(v_page_definition, 'session_private.current_app_session_is_valid(''admin'')') = 0
     or strpos(v_page_definition, 'session_private.exam_employee_in_scope(v_session.employee_id)') = 0
     or strpos(v_page_definition, '''delete_current_session''') = 0
     or strpos(v_page_definition, 'insert into public.audit_logs') = 0
     or strpos(v_page_definition, 'delete from public.exam_sessions') = 0 then
    raise exception 'admin_exam_delete_storage_cleanup_prerequisite_changed';
  end if;
end
$exam_session_delete_storage_cleanup_prerequisites$;

create or replace function public.admin_exam_delete_current_session(
  p_session_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '3500ms'
set lock_timeout = '1500ms'
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_employee_id uuid;
  v_storage_cleanup jsonb;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated'; end if;
  if session_private.current_app_session_is_valid('admin') is not true then
    raise exception 'session_not_current';
  end if;
  if public.has_permission('exam.records.delete') is not true then
    raise exception 'permission_denied';
  end if;

  select session_row.employee_id
  into v_employee_id
  from public.exam_sessions session_row
  where session_row.id = p_session_id
  for update;
  if not found then
    raise exception '本系统考试记录不存在，或该记录不允许删除';
  end if;
  if session_private.exam_employee_in_scope(v_employee_id) is not true then
    raise exception 'employee_out_of_scope';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format('exam-answer-images/%s', p_session_id),
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format('exam-feedback-images/%s', p_session_id),
      0
    )
  );

  v_storage_cleanup := session_private.exam_session_storage_cleanup_paths(
    p_session_id
  );

  insert into session_private.exam_storage_cleanup_queue(
    bucket_id,
    object_name,
    object_owner_id,
    session_id,
    employee_id,
    source_action,
    source_record_id,
    created_by
  )
  select
    object_row.bucket_id,
    object_row.name,
    object_row.owner_id,
    p_session_id,
    v_employee_id,
    'delete_current_session',
    p_session_id::text,
    v_actor
  from (
    select 'exam-answer-images'::text bucket_id, path.value object_name
    from jsonb_array_elements_text(
      v_storage_cleanup->'exam-answer-images'
    ) path(value)
    union all
    select 'exam-feedback-images'::text, path.value
    from jsonb_array_elements_text(
      v_storage_cleanup->'exam-feedback-images'
    ) path(value)
  ) cleanup_path
  join storage.objects object_row
    on object_row.bucket_id = cleanup_path.bucket_id
   and object_row.name = cleanup_path.object_name
  where session_private.exam_storage_cleanup_path_is_valid(
    object_row.name,
    object_row.owner_id,
    p_session_id
  )
  on conflict (bucket_id, object_name) do update
  set object_owner_id = excluded.object_owner_id,
      session_id = excluded.session_id,
      employee_id = excluded.employee_id,
      source_action = excluded.source_action,
      source_record_id = excluded.source_record_id,
      created_by = excluded.created_by,
      created_at = now();

  v_result := public.admin_exam_delete_current_session_page_v1(
    p_session_id,
    p_confirmation
  );

  return coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'storage_cleanup',
    v_storage_cleanup
  );
end;
$function$;

revoke all on function public.admin_exam_delete_current_session(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_exam_delete_current_session(uuid, text)
  to authenticated, service_role;

-- Storage.remove requires both SELECT and DELETE. The SELECT policy is also
-- clamped to Storage's delete/delete_many preflight, so the audit never grants
-- ordinary object listing or download access.
create or replace function session_private.exam_storage_queue_can_cleanup(
  p_bucket_id text,
  p_name text,
  p_owner_id text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '1500ms'
as $function$
declare
  v_session_id uuid;
begin
  if (select auth.uid()) is null
     or session_private.current_app_session_is_valid('admin') is not true
     or coalesce(p_bucket_id, '') not in ('exam-answer-images', 'exam-feedback-images')
     or coalesce(p_name, '') !~ '^[^/]+/[0-9a-f-]+/[^/]+/[^/]+$' then
    return false;
  end if;

  begin
    v_session_id := split_part(p_name, '/', 2)::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  if (p_bucket_id = 'exam-answer-images'
      and public.has_permission('exam.records.delete') is not true)
     or (p_bucket_id = 'exam-feedback-images'
      and public.has_permission('exam.records.delete') is not true
      and public.has_permission('exam.grading.grade') is not true) then
    return false;
  end if;

  if session_private.exam_storage_cleanup_path_is_valid(
       p_name,
       p_owner_id,
       v_session_id
     ) is not true
     then
    return false;
  end if;

  if p_bucket_id = 'exam-feedback-images' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        pg_catalog.format('exam-feedback-images/%s', v_session_id),
        0
      )
    );
  end if;

  -- Re-evaluate references after the namespace lock.  As a VOLATILE function
  -- this read can observe a grading transaction that committed while the
  -- Storage DELETE statement was waiting for that lock.
  if exists (
       select 1
       from public.exam_answers answer
       where (
         jsonb_array_length(answer.attachments) > 0
         and answer.attachments @> jsonb_build_array(
           jsonb_build_object('path', p_name)
         )
       ) or (
         jsonb_array_length(answer.grader_feedback_attachments) > 0
         and answer.grader_feedback_attachments @> jsonb_build_array(
           jsonb_build_object('path', p_name)
         )
       )
     ) then
    return false;
  end if;

  return exists (
    select 1
    from session_private.exam_storage_cleanup_queue cleanup
    where cleanup.bucket_id = p_bucket_id
      and cleanup.object_name = p_name
      and cleanup.object_owner_id = coalesce(p_owner_id, '')
      and cleanup.session_id = v_session_id
      and session_private.exam_employee_in_scope(cleanup.employee_id)
      and (
        (
          cleanup.source_action = 'delete_current_session'
          and public.has_permission('exam.records.delete')
          and not exists (
            select 1 from public.exam_sessions session_row
            where session_row.id = v_session_id
          )
          and exists (
            select 1
            from public.audit_logs audit
            where audit.module = 'exam'
              and audit.action = 'delete_current_session'
              and audit.record_id = v_session_id::text
              and audit.employee_id = cleanup.employee_id
              and audit.old_data->>'source_system' = 'current'
          )
        )
        or (
          cleanup.source_action = 'grade_feedback_replaced'
          and cleanup.bucket_id = 'exam-feedback-images'
          and cleanup.source_record_id = split_part(p_name, '/', 3)
          and public.has_permission('exam.grading.grade')
        )
      )
  );
end;
$function$;

revoke all on function session_private.exam_storage_queue_can_cleanup(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function session_private.exam_storage_queue_can_cleanup(text, text, text)
  to authenticated;

create index if not exists audit_logs_exam_deleted_session_cleanup_idx
on public.audit_logs(record_id, employee_id)
where module = 'exam'
  and action = 'delete_current_session'
  and old_data->>'source_system' = 'current';

-- Existing failed-upload cleanup also needs SELECT for Storage.remove, but it
-- must never turn into a normal list/download/sign permission.
drop policy if exists exam_answer_images_read on storage.objects;
create policy exam_answer_images_read
on storage.objects for select to authenticated
using (
  bucket_id = 'exam-answer-images'
  and (
    session_private.exam_answer_storage_can_view(name)
    or (
      storage.allow_any_operation(
        array['storage.object.delete', 'storage.object.delete_many']
      )
      and session_private.exam_answer_storage_can_delete(name, owner_id)
    )
  )
);

drop policy if exists exam_feedback_images_read on storage.objects;
create policy exam_feedback_images_read
on storage.objects for select to authenticated
using (
  bucket_id = 'exam-feedback-images'
  and (
    session_private.exam_feedback_storage_can_view(name)
    or (
      storage.allow_any_operation(
        array['storage.object.delete', 'storage.object.delete_many']
      )
      and session_private.exam_feedback_storage_can_delete(name, owner_id)
    )
  )
);

drop policy if exists exam_deleted_session_storage_cleanup_read on storage.objects;
create policy exam_deleted_session_storage_cleanup_read
on storage.objects as permissive for select to authenticated
using (
  bucket_id in ('exam-answer-images', 'exam-feedback-images')
  and storage.allow_any_operation(
    array['storage.object.delete', 'storage.object.delete_many']
  )
  and session_private.exam_storage_queue_can_cleanup(
    bucket_id,
    name,
    owner_id
  )
);

drop policy if exists exam_deleted_session_storage_cleanup_delete on storage.objects;
create policy exam_deleted_session_storage_cleanup_delete
on storage.objects as permissive for delete to authenticated
using (
  bucket_id in ('exam-answer-images', 'exam-feedback-images')
  and session_private.exam_storage_queue_can_cleanup(
    bucket_id,
    name,
    owner_id
  )
);

-- A lost HTTP response does not imply that the transactional database delete
-- failed. This read-only endpoint proves the audit and returns bounded paths
-- still present for an authorized cleanup retry.
create or replace function public.admin_exam_deleted_session_storage_cleanup(
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3500ms'
as $function$
declare
  v_employee_id uuid;
  v_storage_cleanup jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if session_private.current_app_session_is_valid('admin') is not true then
    raise exception 'session_not_current';
  end if;
  if public.has_permission('exam.records.delete') is not true then
    raise exception 'permission_denied';
  end if;
  if exists (
    select 1 from public.exam_sessions session_row
    where session_row.id = p_session_id
  ) then
    raise exception 'exam_session_not_deleted';
  end if;

  select audit.employee_id
  into v_employee_id
  from public.audit_logs audit
  where audit.module = 'exam'
    and audit.action = 'delete_current_session'
    and audit.record_id = p_session_id::text
    and audit.employee_id is not null
    and audit.old_data->>'source_system' = 'current'
  order by audit.created_at desc, audit.id desc
  limit 1;
  if not found then raise exception 'deleted_exam_audit_not_found'; end if;
  if session_private.exam_employee_in_scope(v_employee_id) is not true then
    raise exception 'employee_out_of_scope';
  end if;

  v_storage_cleanup := session_private.exam_queued_storage_cleanup_paths(
    p_session_id,
    true,
    false
  );
  return jsonb_build_object(
    'ok', true,
    'deleted_session_id', p_session_id,
    'storage_cleanup', v_storage_cleanup
  );
end;
$function$;

revoke all on function public.admin_exam_deleted_session_storage_cleanup(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_exam_deleted_session_storage_cleanup(uuid)
  to authenticated;

-- Generic queue rescan for both deleted-session attachments and detached
-- feedback replacements.  Unlike the delete-recovery endpoint, this also
-- supports a still-live graded session.
create or replace function public.admin_exam_storage_cleanup_status(
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3500ms'
as $function$
declare
  v_can_delete boolean;
  v_can_grade boolean;
  v_storage_cleanup jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if session_private.current_app_session_is_valid('admin') is not true then
    raise exception 'session_not_current';
  end if;
  v_can_delete := public.has_permission('exam.records.delete');
  v_can_grade := public.has_permission('exam.grading.grade');
  if v_can_delete is not true and v_can_grade is not true then
    raise exception 'permission_denied';
  end if;

  v_storage_cleanup := session_private.exam_queued_storage_cleanup_paths(
    p_session_id,
    v_can_delete,
    v_can_grade
  );
  return jsonb_build_object(
    'ok', true,
    'deleted_session_id', p_session_id,
    'storage_cleanup', v_storage_cleanup
  );
end;
$function$;

revoke all on function public.admin_exam_storage_cleanup_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_exam_storage_cleanup_status(uuid)
  to authenticated;

-- Remove bounded queue metadata whose Storage object is already gone.  The
-- same permission, scope and deletion-audit conditions used for cleanup are
-- rechecked, so this acknowledgement cannot erase another scope's work.
create or replace function public.admin_exam_prune_storage_cleanup(
  p_limit integer default 200
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '3500ms'
set lock_timeout = '1500ms'
as $function$
declare
  v_can_delete boolean;
  v_can_grade boolean;
  v_limit integer := coalesce(p_limit, 200);
  v_pruned integer := 0;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if session_private.current_app_session_is_valid('admin') is not true then
    raise exception 'session_not_current';
  end if;
  if v_limit < 1 or v_limit > 500 then
    raise exception 'invalid_cleanup_prune_limit';
  end if;
  v_can_delete := public.has_permission('exam.records.delete');
  v_can_grade := public.has_permission('exam.grading.grade');
  if v_can_delete is not true and v_can_grade is not true then
    raise exception 'permission_denied';
  end if;

  with removable as materialized (
    select cleanup.id
    from session_private.exam_storage_cleanup_queue cleanup
    where session_private.exam_employee_in_scope(cleanup.employee_id)
      and not exists (
        select 1
        from storage.objects object_row
        where object_row.bucket_id = cleanup.bucket_id
          and object_row.name = cleanup.object_name
          and object_row.owner_id = cleanup.object_owner_id
      )
      and (
        (
          v_can_delete
          and cleanup.source_action = 'delete_current_session'
          and not exists (
            select 1 from public.exam_sessions session_row
            where session_row.id = cleanup.session_id
          )
          and exists (
            select 1
            from public.audit_logs audit
            where audit.module = 'exam'
              and audit.action = 'delete_current_session'
              and audit.record_id = cleanup.session_id::text
              and audit.employee_id = cleanup.employee_id
              and audit.old_data->>'source_system' = 'current'
          )
        )
        or (
          v_can_grade
          and cleanup.source_action = 'grade_feedback_replaced'
        )
      )
    order by cleanup.id
    limit v_limit
    for update skip locked
  ), deleted as (
    delete from session_private.exam_storage_cleanup_queue cleanup
    using removable
    where cleanup.id = removable.id
    returning cleanup.id
  )
  select count(*)::integer into v_pruned from deleted;

  return jsonb_build_object('ok', true, 'pruned', v_pruned);
end;
$function$;

revoke all on function public.admin_exam_prune_storage_cleanup(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_exam_prune_storage_cleanup(integer)
  to authenticated;

-- Durable recovery entrypoint used when a browser closes, a Storage response
-- is lost, or an old feedback image cannot be removed immediately.  It returns
-- at most twenty scoped sessions and never mutates the queue or Storage.
create or replace function public.admin_exam_pending_storage_cleanup(
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3500ms'
as $function$
declare
  v_can_delete boolean;
  v_can_grade boolean;
  v_limit integer := coalesce(p_limit, 20);
  v_count integer := 0;
  v_has_more boolean := false;
  v_cleanup jsonb;
  v_items jsonb := '[]'::jsonb;
  v_candidate record;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if session_private.current_app_session_is_valid('admin') is not true then
    raise exception 'session_not_current';
  end if;
  if v_limit < 1 or v_limit > 20 then
    raise exception 'invalid_cleanup_limit';
  end if;

  v_can_delete := public.has_permission('exam.records.delete');
  v_can_grade := public.has_permission('exam.grading.grade');
  if v_can_delete is not true and v_can_grade is not true then
    raise exception 'permission_denied';
  end if;

  for v_candidate in
    select
      cleanup.session_id,
      max(cleanup.created_at) last_enqueued_at
    from session_private.exam_storage_cleanup_queue cleanup
    join storage.objects object_row
      on object_row.bucket_id = cleanup.bucket_id
     and object_row.name = cleanup.object_name
     and object_row.owner_id = cleanup.object_owner_id
    where session_private.exam_employee_in_scope(cleanup.employee_id)
      and session_private.exam_storage_cleanup_path_is_valid(
        object_row.name,
        object_row.owner_id,
        cleanup.session_id
      )
      and not exists (
        select 1
        from public.exam_answers answer
        where coalesce(answer.attachments, '[]'::jsonb) @>
          jsonb_build_array(jsonb_build_object('path', object_row.name))
           or coalesce(answer.grader_feedback_attachments, '[]'::jsonb) @>
             jsonb_build_array(jsonb_build_object('path', object_row.name))
      )
      and (
        (
          v_can_delete
          and cleanup.source_action = 'delete_current_session'
          and not exists (
            select 1 from public.exam_sessions session_row
            where session_row.id = cleanup.session_id
          )
          and exists (
            select 1
            from public.audit_logs audit
            where audit.module = 'exam'
              and audit.action = 'delete_current_session'
              and audit.record_id = cleanup.session_id::text
              and audit.employee_id = cleanup.employee_id
              and audit.old_data->>'source_system' = 'current'
          )
        )
        or (
          v_can_grade
          and cleanup.source_action = 'grade_feedback_replaced'
          and cleanup.bucket_id = 'exam-feedback-images'
          and cleanup.source_record_id = split_part(object_row.name, '/', 3)
        )
      )
    group by cleanup.session_id
    order by max(cleanup.created_at), cleanup.session_id
    limit v_limit + 1
  loop
    if v_count >= v_limit then
      v_has_more := true;
      exit;
    end if;

    v_cleanup := session_private.exam_queued_storage_cleanup_paths(
      v_candidate.session_id,
      v_can_delete,
      v_can_grade
    );
    if jsonb_array_length(v_cleanup->'exam-answer-images') = 0
       and jsonb_array_length(v_cleanup->'exam-feedback-images') = 0 then
      continue;
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'ok', true,
      'deleted_session_id', v_candidate.session_id,
      'storage_cleanup', v_cleanup
    ));
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'items', v_items,
    'has_more', v_has_more
  );
end;
$function$;

revoke all on function public.admin_exam_pending_storage_cleanup(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_exam_pending_storage_cleanup(integer)
  to authenticated;

comment on function session_private.exam_storage_queue_can_cleanup(text, text, text) is
  'Private delete-operation-only Storage RLS guard bound to an exact queued path, owner, scope and source permission.';
comment on function public.admin_exam_deleted_session_storage_cleanup(uuid) is
  'Read-only retry endpoint listing bounded answer and feedback objects left after an audited exam deletion.';
comment on function public.admin_exam_storage_cleanup_status(uuid) is
  'Read-only scoped rescan for exact queued exam Storage objects, including live feedback replacements.';
comment on function public.admin_exam_prune_storage_cleanup(integer) is
  'Bounded scoped acknowledgement for queued exam objects that Storage has already removed.';
comment on function public.admin_exam_pending_storage_cleanup(integer) is
  'Read-only bounded queue reader for durable cleanup of deleted-session and replaced-feedback Storage objects.';

notify pgrst, 'reload schema';

commit;
