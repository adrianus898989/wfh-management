-- Canonicalize attachment metadata in the database trigger itself.  This
-- prevents padded paths/names from validating against a trimmed object name
-- while being stored as a different JSON value.

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

  if exists(
    select 1
    from jsonb_array_elements(new.attachments) attachment(item)
    where jsonb_typeof(attachment.item)<>'object'
      or not (attachment.item ?& array['path','name','size','type'])
      or (attachment.item-array['path','name','size','type'])<>'{}'::jsonb
      or jsonb_typeof(attachment.item->'path')<>'string'
      or jsonb_typeof(attachment.item->'name')<>'string'
      or jsonb_typeof(attachment.item->'size')<>'number'
      or jsonb_typeof(attachment.item->'type')<>'string'
      or length(attachment.item->>'path')>200
      or length(attachment.item->>'name')>512
      or length(attachment.item->>'type')>64
  ) then
    raise exception 'exam_answer_attachment_shape_invalid';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'path',btrim(attachment.item->>'path'),
    'name',btrim(attachment.item->>'name'),
    'size',(attachment.item->>'size')::numeric,
    'type',lower(btrim(attachment.item->>'type'))
  ) order by attachment.ordinality),'[]'::jsonb)
  into new.attachments
  from jsonb_array_elements(new.attachments)
    with ordinality attachment(item,ordinality);

  if (
    select count(*)<>count(distinct item->>'path')
    from jsonb_array_elements(new.attachments) attachment(item)
  ) then
    raise exception 'exam_answer_attachment_path_duplicate';
  end if;

  for v_item in
    select item from jsonb_array_elements(new.attachments) attachment(item)
  loop
    v_path:=v_item->>'path';
    v_name:=v_item->>'name';
    v_type:=v_item->>'type';
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
  from public, anon, authenticated;

comment on function public.validate_exam_answer_attachments() is
  'Canonicalizes and validates bounded exam-answer image metadata against an owned private Storage object.';

notify pgrst, 'reload schema';
