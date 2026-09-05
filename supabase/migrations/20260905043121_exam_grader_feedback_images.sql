begin;

-- Teacher feedback images use a separate private bucket from employee answer
-- images.  Only validated immutable Storage paths and metadata are persisted.
do $exam_feedback_image_prerequisites$
declare
  v_definition text;
begin
  if to_regprocedure(
    'public.admin_exam_grade_answer(uuid,text,numeric,text)'
  ) is null then
    raise exception 'admin_exam_grade_answer_prerequisite_missing';
  end if;

  if to_regprocedure(
    'public.admin_exam_grade_answer_audit_inner_v1(uuid,text,numeric,text)'
  ) is null then
    raise exception 'admin_exam_grade_answer_audit_inner_prerequisite_missing';
  end if;

  select pg_get_functiondef(
    'public.admin_exam_grade_answer_audit_inner_v1(uuid,text,numeric,text)'::regprocedure
  ) into v_definition;

  if strpos(v_definition, 'exam.grading.grade') = 0
     or strpos(v_definition, 'exam_employee_in_scope') = 0
     or strpos(v_definition, 'admin_exam_grade_answer_page_v1') = 0
     or strpos(v_definition, 'audit_logs') > 0 then
    raise exception 'admin_exam_grade_answer_audit_inner_prerequisite_changed';
  end if;

  select pg_get_functiondef(
    'public.admin_exam_grade_answer(uuid,text,numeric,text)'::regprocedure
  ) into v_definition;

  if strpos(v_definition, 'admin_exam_grade_answer_audit_inner_v1') = 0
     or strpos(v_definition, 'audit_logs') = 0 then
    raise exception 'admin_exam_grade_answer_prerequisite_changed';
  end if;
end
$exam_feedback_image_prerequisites$;

insert into storage.buckets(
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values(
  'exam-feedback-images',
  'exam-feedback-images',
  false,
  4194304,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict(id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.exam_answers
  add column if not exists grader_feedback_attachments jsonb
  not null default '[]'::jsonb;

do $exam_feedback_attachment_constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conname = 'exam_answers_grader_feedback_attachments_check'
      and constraint_row.conrelid = 'public.exam_answers'::regclass
  ) then
    alter table public.exam_answers
      add constraint exam_answers_grader_feedback_attachments_check
      check (
        case
          when jsonb_typeof(grader_feedback_attachments) = 'array'
            then jsonb_array_length(grader_feedback_attachments) <= 3
          else false
        end
      );
  end if;
end
$exam_feedback_attachment_constraint$;

create index if not exists exam_answers_grader_feedback_attachments_gin
on public.exam_answers
using gin(grader_feedback_attachments jsonb_path_ops)
where jsonb_array_length(grader_feedback_attachments) > 0;

create or replace function session_private.validate_exam_grader_feedback_attachments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item jsonb;
  v_path text;
  v_name text;
  v_type text;
  v_size numeric;
  v_file text;
  v_owner_id text;
  v_employee_id uuid;
  v_attachments_changed boolean;
  v_object record;
begin
  if not (
    case
      when jsonb_typeof(new.grader_feedback_attachments) = 'array'
        then jsonb_array_length(new.grader_feedback_attachments) <= 3
      else false
    end
  ) then
    raise exception 'exam_grader_feedback_attachments_invalid';
  end if;

  select session_row.employee_id
  into v_employee_id
  from public.exam_sessions session_row
  where session_row.id = new.session_id;

  if not found then
    raise exception 'exam_session_not_found';
  end if;

  if tg_op = 'INSERT' then
    v_attachments_changed :=
      jsonb_array_length(new.grader_feedback_attachments) > 0;
  else
    v_attachments_changed :=
      new.grader_feedback_attachments
        is distinct from old.grader_feedback_attachments;
  end if;

  if v_attachments_changed
     and (
       (select auth.uid()) is null
       or session_private.current_app_session_is_valid('admin') is not true
       or public.has_permission('exam.grading.grade') is not true
       or session_private.exam_employee_in_scope(v_employee_id) is not true
     ) then
    raise exception 'exam_grader_feedback_attachment_write_forbidden';
  end if;

  if jsonb_array_length(new.grader_feedback_attachments) = 0 then
    return new;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(new.grader_feedback_attachments) attachment(item)
    where jsonb_typeof(attachment.item) <> 'object'
      or not (attachment.item ?& array['path', 'name', 'size', 'type'])
      or (attachment.item - array['path', 'name', 'size', 'type']) <> '{}'::jsonb
      or jsonb_typeof(attachment.item->'path') <> 'string'
      or jsonb_typeof(attachment.item->'name') <> 'string'
      or jsonb_typeof(attachment.item->'size') <> 'number'
      or jsonb_typeof(attachment.item->'type') <> 'string'
      or length(attachment.item->>'path') > 200
      or length(attachment.item->>'name') > 512
      or length(attachment.item->>'type') > 64
  ) then
    raise exception 'exam_grader_feedback_attachment_shape_invalid';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'path', btrim(attachment.item->>'path'),
        'name', btrim(attachment.item->>'name'),
        'size', (attachment.item->>'size')::numeric,
        'type', lower(btrim(attachment.item->>'type'))
      )
      order by attachment.ordinality
    ),
    '[]'::jsonb
  )
  into new.grader_feedback_attachments
  from jsonb_array_elements(new.grader_feedback_attachments)
    with ordinality attachment(item, ordinality);

  if (
    select count(*) <> count(distinct item->>'path')
    from jsonb_array_elements(new.grader_feedback_attachments) attachment(item)
  ) then
    raise exception 'exam_grader_feedback_attachment_path_duplicate';
  end if;

  for v_item in
    select item
    from jsonb_array_elements(new.grader_feedback_attachments) attachment(item)
  loop
    v_path := v_item->>'path';
    v_name := v_item->>'name';
    v_type := v_item->>'type';
    v_size := (v_item->>'size')::numeric;
    v_file := split_part(v_path, '/', 4);
    v_owner_id := split_part(v_path, '/', 1);

    if v_name = ''
       or length(v_name) > 255
       or v_name ~ '[[:cntrl:]]'
       or v_size <> trunc(v_size)
       or v_size < 1
       or v_size > 4194304
       or v_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
       or cardinality(string_to_array(v_path, '/')) <> 4
       or v_owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or v_path <> pg_catalog.format(
         '%s/%s/%s/%s',
         v_owner_id,
         new.session_id,
         new.id,
         v_file
       )
       or v_file !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$'
       or (v_type = 'image/jpeg' and v_file !~ '\.(jpg|jpeg)$')
       or (v_type = 'image/png' and v_file !~ '\.png$')
       or (v_type = 'image/webp' and v_file !~ '\.webp$')
       or (v_type = 'image/gif' and v_file !~ '\.gif$') then
      raise exception 'exam_grader_feedback_attachment_metadata_invalid';
    end if;

    select
      object_row.owner_id,
      object_row.metadata->>'size' object_size,
      lower(object_row.metadata->>'mimetype') object_type
    into v_object
    from storage.objects object_row
    where object_row.bucket_id = 'exam-feedback-images'
      and object_row.name = v_path
    for key share;

    if not found
       or v_object.owner_id is null
       or v_object.owner_id <> v_owner_id
       or coalesce(v_object.object_size, '') <> trunc(v_size)::bigint::text
       or coalesce(v_object.object_type, '') <> v_type then
      raise exception 'exam_grader_feedback_attachment_object_invalid';
    end if;
  end loop;

  return new;
end;
$function$;

revoke all on function session_private.validate_exam_grader_feedback_attachments()
  from public, anon, authenticated, service_role;

drop trigger if exists exam_answers_validate_grader_feedback_attachments
on public.exam_answers;
create trigger exam_answers_validate_grader_feedback_attachments
before insert or update of id, session_id, grader_feedback_attachments
on public.exam_answers
for each row
execute function session_private.validate_exam_grader_feedback_attachments();

create or replace function session_private.exam_feedback_storage_can_upload(
  p_name text
)
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

  select session_row.employee_id
  into v_employee_id
  from public.exam_answers answer
  join public.exam_sessions session_row
    on session_row.id = answer.session_id
  where answer.id = v_answer_id
    and answer.session_id = v_session_id;

  if not found
     or session_private.exam_employee_in_scope(v_employee_id) is not true then
    return false;
  end if;

  -- Serialize the whole exam namespace so uploads to different answers cannot
  -- race past the aggregate limit.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format('exam-feedback-images/%s', v_session_id),
      0
    )
  );

  select
    count(*) filter (
      where split_part(object_row.name, '/', 3) = v_answer_id::text
    ),
    count(*)
  into v_answer_object_count, v_session_object_count
  from storage.objects object_row
  where object_row.bucket_id = 'exam-feedback-images'
    and split_part(object_row.name, '/', 2) = v_session_id::text;

  -- Allow one complete three-image replacement to coexist with the currently
  -- referenced three images until the grading RPC commits and the client
  -- removes the detached originals.
  return v_answer_object_count < 6 and v_session_object_count < 70;
end;
$function$;

create or replace function session_private.exam_feedback_storage_can_view(
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.exam_answers answer
    join public.exam_sessions session_row
      on session_row.id = answer.session_id
    where jsonb_array_length(answer.grader_feedback_attachments) > 0
      and answer.grader_feedback_attachments @> jsonb_build_array(
        jsonb_build_object('path', coalesce(p_name, ''))
      )
      and (
        (
          session_private.current_app_session_is_valid('staff')
          and session_row.status <> 'in_progress'
          and exists (
            select 1
            from public.exam_staff_context() context_row
            where context_row.auth_user_id = (select auth.uid())
              and context_row.employee_id = session_row.employee_id
          )
        )
        or
        (
          session_private.current_app_session_is_valid('admin')
          and session_private.exam_employee_in_scope(session_row.employee_id)
          and (
            public.has_permission('exam.records.view')
            or public.has_permission('employee.directory.view')
            or (
              public.has_permission('exam.grading.view')
              and session_row.status in ('submitted', 'grading', 'graded')
            )
          )
        )
      )
  );
$function$;

create or replace function session_private.exam_feedback_storage_can_delete(
  p_name text,
  p_owner_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
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
     or coalesce(p_owner_id, '') <> v_parts[1]
     or v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[4] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$' then
    return false;
  end if;

  begin
    v_session_id := v_parts[2]::uuid;
    v_answer_id := v_parts[3]::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  -- The uploader can always clean up their own unreferenced object.  This
  -- remains possible after an exam/answer row is deleted and its metadata has
  -- cascaded away, without granting access to another administrator's files.
  if coalesce(p_owner_id, '') = v_user_id::text
     and not exists (
       select 1
       from public.exam_answers answer
       where jsonb_array_length(answer.grader_feedback_attachments) > 0
         and answer.grader_feedback_attachments @> jsonb_build_array(
           jsonb_build_object('path', coalesce(p_name, ''))
         )
     ) then
    return true;
  end if;

  select answer.graded_by, session_row.employee_id
  into v_graded_by, v_employee_id
  from public.exam_answers answer
  join public.exam_sessions session_row
    on session_row.id = answer.session_id
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

  -- A newly uploaded object is removable by its owner after a failed save.
  -- Once a replacement grade makes this admin the current grader, the same
  -- guard also permits cleanup of a prior grader's now-detached image.
  return not exists (
    select 1
    from public.exam_answers answer
    where jsonb_array_length(answer.grader_feedback_attachments) > 0
      and answer.grader_feedback_attachments @> jsonb_build_array(
        jsonb_build_object('path', coalesce(p_name, ''))
      )
  );
end;
$function$;

revoke all on function session_private.exam_feedback_storage_can_upload(text)
  from public, anon, authenticated, service_role;
revoke all on function session_private.exam_feedback_storage_can_view(text)
  from public, anon, authenticated, service_role;
revoke all on function session_private.exam_feedback_storage_can_delete(text, text)
  from public, anon, authenticated, service_role;

grant execute on function session_private.exam_feedback_storage_can_upload(text)
  to authenticated;
grant execute on function session_private.exam_feedback_storage_can_view(text)
  to authenticated;
grant execute on function session_private.exam_feedback_storage_can_delete(text, text)
  to authenticated;

drop policy if exists exam_feedback_images_upload on storage.objects;
create policy exam_feedback_images_upload
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'exam-feedback-images'
  and session_private.exam_feedback_storage_can_upload(name)
);

-- Supabase Storage deletion requires both SELECT and DELETE.  The delete
-- branch therefore exposes only the same narrowly authorized unreferenced
-- object needed for failed-upload and replacement cleanup.
drop policy if exists exam_feedback_images_read on storage.objects;
create policy exam_feedback_images_read
on storage.objects
for select
to authenticated
using (
  bucket_id = 'exam-feedback-images'
  and (
    session_private.exam_feedback_storage_can_view(name)
    or session_private.exam_feedback_storage_can_delete(name, owner_id)
  )
);

drop policy if exists exam_feedback_images_delete on storage.objects;
create policy exam_feedback_images_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'exam-feedback-images'
  and session_private.exam_feedback_storage_can_delete(name, owner_id)
);

-- Keep the existing four-parameter RPC unchanged.  The explicitly named
-- five-parameter endpoint calls the already permission-, scope-, lock- and
-- recalculation-protected inner implementation, then atomically persists the
-- feedback image metadata.  NULL preserves prior images; [] clears them.
create or replace function public.admin_exam_grade_answer_with_feedback_images(
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
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_answer public.exam_answers;
  v_employee_id uuid;
  v_image_count integer;
begin
  if v_actor is null then
    raise exception 'not_authenticated';
  end if;
  if session_private.current_app_session_is_valid('admin') is not true then
    raise exception 'session_not_current';
  end if;

  if p_feedback_images is not null
     and not (
       case
         when jsonb_typeof(p_feedback_images) = 'array'
           then jsonb_array_length(p_feedback_images) <= 3
         else false
       end
     ) then
    raise exception '批改回复图片最多上传3张';
  end if;

  -- This retained implementation performs the granular grading permission and
  -- employee-scope checks, locks the rows, writes grade fields, and recalculates
  -- the session result.  Any later image-validation error rolls it all back.
  perform public.admin_exam_grade_answer_audit_inner_v1(
    p_answer_id,
    p_status,
    p_score,
    p_feedback
  );

  if p_feedback_images is null then
    select answer.*
    into v_answer
    from public.exam_answers answer
    where answer.id = p_answer_id;
  else
    update public.exam_answers answer
    set grader_feedback_attachments = p_feedback_images
    where answer.id = p_answer_id
    returning answer.* into v_answer;
  end if;

  if not found then
    raise exception 'answer_not_found';
  end if;

  select session_row.employee_id
  into v_employee_id
  from public.exam_sessions session_row
  where session_row.id = v_answer.session_id;

  v_image_count := jsonb_array_length(v_answer.grader_feedback_attachments);

  -- Image paths and filenames are intentionally excluded from the audit log;
  -- only their count is recorded alongside the existing grading audit fields.
  insert into public.audit_logs(
    actor_user_id,
    employee_id,
    module,
    action,
    record_id,
    new_data,
    reason
  )
  values(
    v_actor,
    v_employee_id,
    'exam_grading',
    'grade_answer',
    p_answer_id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'answer_id', v_answer.id::text,
      'session_id', v_answer.session_id::text,
      'grade_status', v_answer.grade_status,
      'awarded_score', v_answer.awarded_score,
      'grader_feedback', v_answer.grader_feedback,
      'graded_at', v_answer.graded_at,
      'grader_feedback_attachment_count', v_image_count
    )),
    '人工批改 · 状态 ' || coalesce(nullif(v_answer.grade_status, ''), '—')
      || ' · 分数 ' || coalesce(v_answer.awarded_score::text, '—')
      || ' · 回复图片 ' || v_image_count::text
  );

  return to_jsonb(v_answer);
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

-- Add teacher feedback image metadata to the canonical current-session detail.
create or replace function public.admin_exam_session_detail(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_employee_id uuid;
begin
  if not public.exam_is_admin('exam.view')
     and not public.exam_is_admin('exam.grade') then
    raise exception '没有考试查看权限';
  end if;

  select session_row.employee_id
  into v_employee_id
  from public.exam_sessions session_row
  where session_row.id = p_session_id;

  if not found then
    raise exception '考试记录不存在';
  end if;
  if not session_private.exam_employee_in_scope(v_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  return jsonb_build_object(
    'session', (
      select to_jsonb(session_detail)
      from (
        select
          session_row.*,
          employee.employee_no,
          employee.full_name employee_name,
          assignment.title,
          assignment.team_name,
          assignment.position_name,
          assignment.pass_score,
          coalesce(
            nullif(grader.login_username, ''),
            nullif(grader.login_email, ''),
            '—'
          ) grader_name,
          count(answer.id) filter (
            where answer.grade_status = 'correct'
          ) correct_count,
          count(answer.id) filter (
            where answer.grade_status = 'partial'
          ) partial_count,
          count(answer.id) filter (
            where answer.grade_status = 'wrong'
          ) wrong_count,
          count(answer.id) filter (
            where answer.grade_status is null
          ) pending_count
        from public.exam_sessions session_row
        join public.employees employee
          on employee.id = session_row.employee_id
        join public.exam_assignments assignment
          on assignment.id = session_row.assignment_id
        left join public.user_access grader
          on grader.auth_user_id = session_row.graded_by
        left join public.exam_answers answer
          on answer.session_id = session_row.id
        where session_row.id = p_session_id
        group by
          session_row.id,
          employee.employee_no,
          employee.full_name,
          assignment.title,
          assignment.team_name,
          assignment.position_name,
          assignment.pass_score,
          grader.login_username,
          grader.login_email
      ) session_detail
    ),
    'answers', (
      select coalesce(
        jsonb_agg(to_jsonb(answer_detail) order by answer_detail.ordinality),
        '[]'::jsonb
      )
      from (
        select
          question.ordinality,
          question.item->>'id' question_id,
          question.item->>'external_key' external_key,
          question.item->>'question_en' question_en,
          question.item->>'question_zh' question_zh,
          question.item->>'question_vi' question_vi,
          (question.item->>'points')::numeric points,
          coalesce(question.item->'image_urls', '[]'::jsonb) image_urls,
          answer.id answer_id,
          coalesce(answer.answer_text, '') answer_text,
          coalesce(answer.attachments, '[]'::jsonb) attachments,
          coalesce(
            answer.grader_feedback_attachments,
            '[]'::jsonb
          ) grader_feedback_attachments,
          answer.grade_status,
          answer.awarded_score,
          answer.grader_feedback,
          answer.graded_at,
          coalesce(
            nullif(grader.login_username, ''),
            nullif(grader.login_email, ''),
            '—'
          ) grader_name
        from public.exam_sessions session_row
        cross join lateral jsonb_array_elements(session_row.question_snapshot)
          with ordinality question(item, ordinality)
        left join public.exam_answers answer
          on answer.session_id = session_row.id
          and answer.question_id = (question.item->>'id')::uuid
        left join public.user_access grader
          on grader.auth_user_id = answer.graded_by
        where session_row.id = p_session_id
      ) answer_detail
    )
  );
end;
$function$;

-- Keep project-specific RPCs on a strict JSON whitelist while passing the new
-- field through records, grading, and employee-directory detail wrappers.
create or replace function public.admin_exam_project_session_detail(
  p_result jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select jsonb_build_object(
    'session', jsonb_build_object(
      'source_system', p_result->'session'->'source_system',
      'source_label', p_result->'session'->'source_label',
      'id', p_result->'session'->'id',
      'employee_id', p_result->'session'->'employee_id',
      'employee_no', p_result->'session'->'employee_no',
      'employee_name', p_result->'session'->'employee_name',
      'team_name', p_result->'session'->'team_name',
      'position_name', p_result->'session'->'position_name',
      'title', p_result->'session'->'title',
      'attempt_no', p_result->'session'->'attempt_no',
      'status', p_result->'session'->'status',
      'pass_score', p_result->'session'->'pass_score',
      'started_at', p_result->'session'->'started_at',
      'submitted_at', p_result->'session'->'submitted_at',
      'graded_at', p_result->'session'->'graded_at',
      'earned_score', p_result->'session'->'earned_score',
      'total_score', p_result->'session'->'total_score',
      'percentage', p_result->'session'->'percentage',
      'passed', p_result->'session'->'passed',
      'answer_detail_count', coalesce(
        p_result->'session'->'answer_detail_count',
        to_jsonb(jsonb_array_length(coalesce(p_result->'answers', '[]'::jsonb)))
      ),
      'total_question_count', coalesce(
        p_result->'session'->'total_question_count',
        to_jsonb(jsonb_array_length(coalesce(p_result->'answers', '[]'::jsonb)))
      ),
      'unanswered_count', coalesce(
        p_result->'session'->'unanswered_count',
        '0'::jsonb
      ),
      'correct_count', p_result->'session'->'correct_count',
      'partial_count', p_result->'session'->'partial_count',
      'wrong_count', p_result->'session'->'wrong_count',
      'pending_count', p_result->'session'->'pending_count',
      'grader_name', p_result->'session'->'grader_name',
      'answer_detail_available', coalesce(
        p_result->'session'->'answer_detail_available',
        'true'::jsonb
      ),
      'read_only', coalesce(
        p_result->'session'->'read_only',
        'false'::jsonb
      )
    ),
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'answer_id', answer.item->'answer_id',
        'question_id', answer.item->'question_id',
        'ordinality', answer.item->'ordinality',
        'external_key', answer.item->'external_key',
        'question_zh', answer.item->'question_zh',
        'question_en', answer.item->'question_en',
        'question_vi', answer.item->'question_vi',
        'points', answer.item->'points',
        'image_urls', answer.item->'image_urls',
        'answer_text', answer.item->'answer_text',
        'attachments', answer.item->'attachments',
        'grader_feedback_attachments', coalesce(
          answer.item->'grader_feedback_attachments',
          '[]'::jsonb
        ),
        'grade_status', answer.item->'grade_status',
        'awarded_score', answer.item->'awarded_score',
        'grader_feedback', answer.item->'grader_feedback',
        'graded_at', answer.item->'graded_at',
        'grader_name', answer.item->'grader_name',
        'read_only', answer.item->'read_only'
      ))
      from jsonb_array_elements(
        coalesce(p_result->'answers', '[]'::jsonb)
      ) answer(item)
    ), '[]'::jsonb)
  );
$function$;

-- Employees receive only stored metadata.  The client exchanges those paths
-- for short-lived signed URLs under the same private Storage read policy.
create or replace function public.staff_exam_result_detail(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_context record;
  v_source text;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  select * into v_context
  from public.exam_staff_context();

  if v_context.employee_id is null then
    raise exception '账号尚未关联员工档案';
  end if;

  select combined.source_system
  into v_source
  from public.admin_exam_combined_sessions_v combined
  where combined.id = p_session_id
    and combined.employee_id = v_context.employee_id
    and combined.status <> 'in_progress'
  order by case when combined.source_system = 'current' then 0 else 1 end
  limit 1;

  if v_source is null then
    raise exception '无权查看该考试结果';
  end if;

  if v_source = 'legacy' then
    return jsonb_build_object(
      'session', (
        select to_jsonb(legacy_session)
        from (
          select *
          from public.admin_exam_combined_sessions_v
          where id = p_session_id
            and employee_id = v_context.employee_id
            and source_system = 'legacy'
        ) legacy_session
      ),
      'answers', (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'question', jsonb_build_object(
                'id', answer.source_question_id,
                'question_zh', coalesce(
                  nullif(answer.question_snapshot->>'question_zh', ''),
                  nullif(answer.question_snapshot->>'question', '')
                ),
                'question_en', answer.question_snapshot->>'question_en',
                'question_vi', answer.question_snapshot->>'question_vi',
                'points', coalesce(answer.question_points, 0),
                'image_urls', coalesce(
                  answer.question_snapshot->'image_urls',
                  '[]'::jsonb
                ) || coalesce(answer.attachments, '[]'::jsonb)
                  || coalesce(answer.feedback_images, '[]'::jsonb)
              ),
              'answer_text', coalesce(answer.answer_text, ''),
              'awarded_score', answer.awarded_score,
              'grade_status', answer.grade_status,
              'grader_feedback', answer.feedback,
              'grader_feedback_attachments', '[]'::jsonb,
              'graded_at', answer.graded_at,
              'grader_name', '旧系统'
            )
            order by answer.answered_at, answer.id
          ),
          '[]'::jsonb
        )
        from public.legacy_exam_answers answer
        where answer.legacy_session_id = p_session_id
      )
    );
  end if;

  return jsonb_build_object(
    'session', (
      select to_jsonb(current_session)
      from (
        select *
        from public.admin_exam_combined_sessions_v
        where id = p_session_id
          and employee_id = v_context.employee_id
          and source_system = 'current'
      ) current_session
    ),
    'answers', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'question', question.item,
            'answer_text', coalesce(answer.answer_text, ''),
            'attachments', coalesce(answer.attachments, '[]'::jsonb),
            'awarded_score', answer.awarded_score,
            'grade_status', answer.grade_status,
            'grader_feedback', answer.grader_feedback,
            'grader_feedback_attachments', coalesce(
              answer.grader_feedback_attachments,
              '[]'::jsonb
            ),
            'graded_at', answer.graded_at,
            'grader_name', coalesce(
              nullif(grader.login_username, ''),
              nullif(grader.login_email, ''),
              '—'
            )
          )
          order by question.ordinality
        ),
        '[]'::jsonb
      )
      from public.exam_sessions session_row
      cross join lateral jsonb_array_elements(session_row.question_snapshot)
        with ordinality question(item, ordinality)
      left join public.exam_answers answer
        on answer.session_id = session_row.id
        and answer.question_id = (question.item->>'id')::uuid
      left join public.user_access grader
        on grader.auth_user_id = answer.graded_by
      where session_row.id = p_session_id
        and session_row.employee_id = v_context.employee_id
    )
  );
end;
$function$;

revoke all on function public.admin_exam_project_session_detail(jsonb)
  from public, anon, authenticated;
revoke all on function public.admin_exam_session_detail(uuid)
  from public, anon, authenticated;
revoke all on function public.staff_exam_result_detail(uuid)
  from public, anon, authenticated;

grant execute on function public.admin_exam_session_detail(uuid)
  to authenticated;
grant execute on function public.staff_exam_result_detail(uuid)
  to authenticated;

comment on column public.exam_answers.grader_feedback_attachments is
  'Validated private Storage metadata for up to three teacher feedback images.';
comment on function session_private.validate_exam_grader_feedback_attachments() is
  'Canonicalizes and validates teacher feedback image metadata against private Storage objects.';
comment on function session_private.exam_feedback_storage_can_upload(text) is
  'Private admin grading Storage guard with employee scope and serialized per-answer/per-session quotas.';
comment on function session_private.exam_feedback_storage_can_view(text) is
  'Private Storage guard for referenced teacher feedback images visible to the employee or an in-scope reviewer.';
comment on function session_private.exam_feedback_storage_can_delete(text, text) is
  'Private Storage guard for cleanup of unreferenced teacher feedback images by their owner or current grader.';
comment on function public.admin_exam_grade_answer_with_feedback_images(
  uuid,
  text,
  numeric,
  text,
  jsonb
) is
  'Audited five-parameter grading RPC; NULL preserves feedback images and an empty array clears them.';

notify pgrst, 'reload schema';

commit;
