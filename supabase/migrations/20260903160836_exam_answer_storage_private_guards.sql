-- Keep Storage policy helpers outside the API-exposed public schema.  The
-- policies continue to call them by OID, while authenticated clients cannot
-- discover or invoke them as public RPC endpoints.

alter function public.exam_answer_storage_can_upload(text)
  set schema session_private;

alter function public.exam_answer_storage_can_view(text)
  set schema session_private;

alter function public.exam_answer_storage_can_delete(text, text)
  set schema session_private;

drop policy if exists exam_answer_images_upload on storage.objects;
create policy exam_answer_images_upload
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'exam-answer-images'
  and session_private.exam_answer_storage_can_upload(name)
);

drop policy if exists exam_answer_images_read on storage.objects;
create policy exam_answer_images_read
on storage.objects
for select
to authenticated
using (
  bucket_id = 'exam-answer-images'
  and session_private.exam_answer_storage_can_view(name)
);

drop policy if exists exam_answer_images_delete on storage.objects;
create policy exam_answer_images_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'exam-answer-images'
  and session_private.exam_answer_storage_can_delete(name, owner_id)
);

revoke all on function session_private.exam_answer_storage_can_upload(text)
  from public, anon, authenticated;
revoke all on function session_private.exam_answer_storage_can_view(text)
  from public, anon, authenticated;
revoke all on function session_private.exam_answer_storage_can_delete(text, text)
  from public, anon, authenticated;

grant execute on function session_private.exam_answer_storage_can_upload(text)
  to authenticated;
grant execute on function session_private.exam_answer_storage_can_view(text)
  to authenticated;
grant execute on function session_private.exam_answer_storage_can_delete(text, text)
  to authenticated;

comment on function session_private.exam_answer_storage_can_upload(text) is
  'Private Storage RLS guard for staff exam-answer image uploads.';
comment on function session_private.exam_answer_storage_can_view(text) is
  'Private Storage RLS guard for scoped staff/admin exam-answer image reads.';
comment on function session_private.exam_answer_storage_can_delete(text, text) is
  'Private Storage RLS guard for deleting an unreferenced image from an active owned exam session.';

notify pgrst, 'reload schema';
