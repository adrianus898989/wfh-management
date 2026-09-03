-- Supabase Storage deletion requires both SELECT and DELETE permission.  Once
-- the employee detaches an image from the answer, retain SELECT only for the
-- same narrowly scoped object that the delete guard already permits.  This
-- makes failed-upload cleanup and explicit removal work without widening
-- reviewer access to unreferenced files.

drop policy if exists exam_answer_images_read on storage.objects;
create policy exam_answer_images_read
on storage.objects
for select
to authenticated
using (
  bucket_id = 'exam-answer-images'
  and (
    session_private.exam_answer_storage_can_view(name)
    or session_private.exam_answer_storage_can_delete(name, owner_id)
  )
);

notify pgrst, 'reload schema';
