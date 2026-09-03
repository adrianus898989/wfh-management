-- Optional answer images for the employee exam workflow.  Objects stay private;
-- the database stores only their immutable paths and validated metadata.

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'exam-answer-images',
  'exam-answer-images',
  false,
  4194304,
  array['image/jpeg','image/png','image/webp','image/gif']
)
on conflict(id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create index if not exists exam_answers_attachments_gin
on public.exam_answers using gin(attachments jsonb_path_ops)
where jsonb_array_length(attachments)>0;

create or replace function public.exam_answer_storage_can_upload(p_name text)
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

  return exists(
    select 1
    from public.exam_staff_context() context_row
    where context_row.auth_user_id=v_user_id
      and context_row.employee_id=v_session.employee_id
  ) and exists(
    select 1
    from jsonb_array_elements(v_session.question_snapshot) question(item)
    where question.item->>'id'=v_question_id::text
  );
end;
$$;

create or replace function public.exam_answer_storage_can_view(p_name text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1
    from public.exam_answers answer
    join public.exam_sessions session_row on session_row.id=answer.session_id
    where jsonb_array_length(answer.attachments)>0
      and answer.attachments @> jsonb_build_array(jsonb_build_object('path',coalesce(p_name,'')))
      and (
        (
          session_private.current_app_session_is_valid('staff')
          and session_row.auth_user_id=(select auth.uid())
          and exists(
            select 1
            from public.exam_staff_context() context_row
            where context_row.auth_user_id=(select auth.uid())
              and context_row.employee_id=session_row.employee_id
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
              and session_row.status in ('submitted','grading')
            )
          )
        )
      )
  );
$$;

create or replace function public.exam_answer_storage_can_delete(
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

  -- The client first detaches an image through staff_exam_save_answer, then
  -- removes the object.  This also permits cleanup of a failed fresh upload.
  return not exists(
    select 1
    from public.exam_answers answer
    where jsonb_array_length(answer.attachments)>0
      and answer.attachments @> jsonb_build_array(jsonb_build_object('path',coalesce(p_name,'')))
  );
end;
$$;

revoke all on function public.exam_answer_storage_can_upload(text)
  from public,anon,authenticated;
revoke all on function public.exam_answer_storage_can_view(text)
  from public,anon,authenticated;
revoke all on function public.exam_answer_storage_can_delete(text,text)
  from public,anon,authenticated;
grant execute on function public.exam_answer_storage_can_upload(text)
  to authenticated;
grant execute on function public.exam_answer_storage_can_view(text)
  to authenticated;
grant execute on function public.exam_answer_storage_can_delete(text,text)
  to authenticated;

drop policy if exists exam_answer_images_upload on storage.objects;
create policy exam_answer_images_upload
on storage.objects for insert to authenticated
with check(
  bucket_id='exam-answer-images'
  and public.exam_answer_storage_can_upload(name)
);

drop policy if exists exam_answer_images_read on storage.objects;
create policy exam_answer_images_read
on storage.objects for select to authenticated
using(
  bucket_id='exam-answer-images'
  and public.exam_answer_storage_can_view(name)
);

drop policy if exists exam_answer_images_delete on storage.objects;
create policy exam_answer_images_delete
on storage.objects for delete to authenticated
using(
  bucket_id='exam-answer-images'
  and public.exam_answer_storage_can_delete(name,owner_id)
);

create or replace function public.validate_exam_answer_attachments()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_session public.exam_sessions;
  v_item jsonb;
  v_path text;
  v_name text;
  v_type text;
  v_size numeric;
  v_file text;
  v_object record;
begin
  if coalesce(jsonb_typeof(new.attachments),'')<>'array'
     or jsonb_array_length(new.attachments)>6 then
    raise exception 'exam_answer_attachments_invalid';
  end if;
  if jsonb_array_length(new.attachments)=0 then return new; end if;

  select session_row.* into v_session
  from public.exam_sessions session_row
  where session_row.id=new.session_id;
  if not found then raise exception 'exam_session_not_found'; end if;
  if not exists(
    select 1 from jsonb_array_elements(v_session.question_snapshot) question(item)
    where question.item->>'id'=new.question_id::text
  ) then
    raise exception 'exam_question_not_in_session';
  end if;
  if (
    select count(*)<>count(distinct item->>'path')
    from jsonb_array_elements(new.attachments) attachment(item)
  ) then
    raise exception 'exam_answer_attachment_path_duplicate';
  end if;

  for v_item in select item from jsonb_array_elements(new.attachments) attachment(item)
  loop
    if jsonb_typeof(v_item)<>'object'
       or not (v_item ?& array['path','name','size','type'])
       or (v_item - array['path','name','size','type'])<>'{}'::jsonb
       or jsonb_typeof(v_item->'path')<>'string'
       or jsonb_typeof(v_item->'name')<>'string'
       or jsonb_typeof(v_item->'size')<>'number'
       or jsonb_typeof(v_item->'type')<>'string' then
      raise exception 'exam_answer_attachment_shape_invalid';
    end if;

    v_path:=btrim(v_item->>'path');
    v_name:=btrim(v_item->>'name');
    v_type:=lower(btrim(v_item->>'type'));
    v_size:=(v_item->>'size')::numeric;
    v_file:=split_part(v_path,'/',4);

    if v_name='' or length(v_name)>255 or v_name~'[[:cntrl:]]'
       or v_size<>trunc(v_size) or v_size<1 or v_size>4194304
       or v_type not in ('image/jpeg','image/png','image/webp','image/gif')
       or cardinality(string_to_array(v_path,'/'))<>4
       or v_path<>format('%s/%s/%s/%s',v_session.auth_user_id,new.session_id,new.question_id,v_file)
       or v_file !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$'
       or (v_type='image/jpeg' and v_file !~ '\.(jpg|jpeg)$')
       or (v_type='image/png' and v_file !~ '\.png$')
       or (v_type='image/webp' and v_file !~ '\.webp$')
       or (v_type='image/gif' and v_file !~ '\.gif$') then
      raise exception 'exam_answer_attachment_metadata_invalid';
    end if;

    select object_row.owner_id,
      object_row.metadata->>'size' object_size,
      lower(object_row.metadata->>'mimetype') object_type
    into v_object
    from storage.objects object_row
    where object_row.bucket_id='exam-answer-images'
      and object_row.name=v_path;
    if not found
       or coalesce(v_object.owner_id,'')<>v_session.auth_user_id::text
       or coalesce(v_object.object_size,'')<>trunc(v_size)::bigint::text
       or coalesce(v_object.object_type,'')<>v_type then
      raise exception 'exam_answer_attachment_object_invalid';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.validate_exam_answer_attachments()
  from public,anon,authenticated;

drop trigger if exists exam_answers_validate_attachments on public.exam_answers;
create trigger exam_answers_validate_attachments
before insert or update of session_id,question_id,attachments on public.exam_answers
for each row execute function public.validate_exam_answer_attachments();

create or replace function public.staff_exam_save_answer(
  p_session_id uuid,
  p_question_id uuid,
  p_answer text,
  p_attachments jsonb default '[]'::jsonb
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
  v_attachments jsonb:=coalesce(p_attachments,'[]'::jsonb);
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
    and session_row.expires_at>now()
  for update;
  if not found then raise exception '考试已结束或无权操作'; end if;
  if not exists(
    select 1 from jsonb_array_elements(v_session.question_snapshot) question(item)
    where question.item->>'id'=p_question_id::text
  ) then raise exception '题目不属于本次考试'; end if;
  if coalesce(jsonb_typeof(v_attachments),'')<>'array' or jsonb_array_length(v_attachments)>6 then
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
    'path',attachment.item->>'path',
    'name',attachment.item->>'name',
    'size',(attachment.item->>'size')::bigint,
    'type',lower(attachment.item->>'type')
  ) order by attachment.ordinality),'[]'::jsonb)
  into v_attachments
  from jsonb_array_elements(v_attachments) with ordinality attachment(item,ordinality);

  insert into public.exam_answers(session_id,question_id,answer_text,attachments,saved_at)
  values(v_session.id,p_question_id,coalesce(p_answer,''),v_attachments,now())
  on conflict(session_id,question_id) do update set
    answer_text=excluded.answer_text,
    attachments=excluded.attachments,
    saved_at=now()
  returning * into v_answer;
  return to_jsonb(v_answer);
end;
$$;

revoke all on function public.staff_exam_save_answer(uuid,uuid,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.staff_exam_save_answer(uuid,uuid,text,jsonb)
  to authenticated;

create or replace function public.staff_exam_answer_attachments(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_context record;
begin
  if (select auth.uid()) is null
     or not session_private.current_app_session_is_valid('staff') then
    raise exception 'session_not_current';
  end if;
  select * into v_context from public.exam_staff_context();
  if v_context.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;
  if not exists(
    select 1 from public.exam_sessions session_row
    where session_row.id=p_session_id
      and session_row.auth_user_id=(select auth.uid())
      and session_row.employee_id=v_context.employee_id
  ) then raise exception '无权查看该考试附件'; end if;

  return coalesce((
    select jsonb_object_agg(answer.question_id::text,answer.attachments)
    from public.exam_answers answer
    where answer.session_id=p_session_id
      and jsonb_array_length(answer.attachments)>0
  ),'{}'::jsonb);
end;
$$;

revoke all on function public.staff_exam_answer_attachments(uuid)
  from public,anon,authenticated;
grant execute on function public.staff_exam_answer_attachments(uuid)
  to authenticated;

-- Include current-system answer attachments in the employee's completed-result
-- response.  Legacy answer images keep their existing merged representation.
create or replace function public.staff_exam_result_detail(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare c record; v_source text;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  select u.source_system into v_source
  from public.admin_exam_combined_sessions_v u
  where u.id=p_session_id and u.employee_id=c.employee_id and u.status<>'in_progress'
  order by case when u.source_system='current' then 0 else 1 end limit 1;
  if v_source is null then raise exception '无权查看该考试结果'; end if;

  if v_source='legacy' then
    return jsonb_build_object(
      'session',(select to_jsonb(x) from (
        select * from public.admin_exam_combined_sessions_v
        where id=p_session_id and employee_id=c.employee_id and source_system='legacy'
      ) x),
      'answers',(select coalesce(jsonb_agg(jsonb_build_object(
        'question',jsonb_build_object(
          'id',a.source_question_id,'question_zh',coalesce(nullif(a.question_snapshot->>'question_zh',''),nullif(a.question_snapshot->>'question','')),
          'question_en',a.question_snapshot->>'question_en','question_vi',a.question_snapshot->>'question_vi',
          'points',coalesce(a.question_points,0),
          'image_urls',coalesce(a.question_snapshot->'image_urls','[]'::jsonb)||coalesce(a.attachments,'[]'::jsonb)||coalesce(a.feedback_images,'[]'::jsonb)
        ),
        'answer_text',coalesce(a.answer_text,''),'awarded_score',a.awarded_score,'grade_status',a.grade_status,
        'grader_feedback',a.feedback,'graded_at',a.graded_at,'grader_name','旧系统'
      ) order by a.answered_at,a.id),'[]'::jsonb)
      from public.legacy_exam_answers a where a.legacy_session_id=p_session_id)
    );
  end if;

  return jsonb_build_object(
    'session',(select to_jsonb(x) from (
      select * from public.admin_exam_combined_sessions_v
      where id=p_session_id and employee_id=c.employee_id and source_system='current'
    ) x),
    'answers',(select coalesce(jsonb_agg(jsonb_build_object(
      'question',q.item,'answer_text',coalesce(ans.answer_text,''),
      'attachments',coalesce(ans.attachments,'[]'::jsonb),
      'awarded_score',ans.awarded_score,'grade_status',ans.grade_status,
      'grader_feedback',ans.grader_feedback,'graded_at',ans.graded_at,
      'grader_name',coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—')
    ) order by q.ord),'[]'::jsonb)
    from public.exam_sessions s
    cross join lateral jsonb_array_elements(s.question_snapshot) with ordinality q(item,ord)
    left join public.exam_answers ans on ans.session_id=s.id and ans.question_id=(q.item->>'id')::uuid
    left join public.user_access ua on ua.auth_user_id=ans.graded_by
    where s.id=p_session_id and s.employee_id=c.employee_id)
  );
end;
$$;

revoke all on function public.staff_exam_result_detail(uuid)
  from public,anon,authenticated;
grant execute on function public.staff_exam_result_detail(uuid)
  to authenticated;

comment on function public.exam_answer_storage_can_upload(text) is
  'Boolean-only Storage RLS guard for answer images in the current employee exam session.';
comment on function public.exam_answer_storage_can_view(text) is
  'Allows a referenced answer image only to its employee or an in-scope authorized reviewer.';
comment on function public.exam_answer_storage_can_delete(text,text) is
  'Allows the employee to remove only an unreferenced object from their current in-progress exam.';
comment on function public.staff_exam_answer_attachments(uuid) is
  'Returns private attachment metadata for one exam owned by the current staff session; never returns a public URL.';

notify pgrst,'reload schema';
