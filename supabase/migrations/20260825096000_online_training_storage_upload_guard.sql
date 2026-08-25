-- Storage policies are evaluated as `authenticated`.  Keep the employee and
-- report tables private by exposing only narrow, boolean security-definer
-- checks to the storage schema.

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'online-training',
  'online-training',
  false,
  4194304,
  array['image/jpeg','image/png','image/webp','image/gif']
)
on conflict(id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.online_training_storage_can_upload(p_name text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select
    session_private.current_app_session_is_valid('admin')
    and split_part(coalesce(p_name,''),'/',1)=(select auth.uid())::text
    and (
      public.has_permission('online_training.submit')
      or public.has_permission('online_training.manage')
    );
$$;

create or replace function public.online_training_storage_can_view(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_report_id uuid;
begin
  if not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;
  begin
    v_report_id := split_part(coalesce(p_name,''),'/',2)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return public.online_training_can_view_report(v_report_id);
end;
$$;

create or replace function public.online_training_storage_can_delete(
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
  v_report_id uuid;
begin
  if not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;

  -- Allow only the object owner to clean up a failed upload before its report
  -- exists.  The UUID namespace check prevents deleting another user's draft.
  if split_part(coalesce(p_name,''),'/',1)=(select auth.uid())::text
     and coalesce(p_owner_id,'')=(select auth.uid())::text
     and (
       public.has_permission('online_training.submit')
       or public.has_permission('online_training.manage')
     ) then
    return true;
  end if;

  begin
    v_report_id := split_part(coalesce(p_name,''),'/',2)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  -- Managers can remove an attachment created by another submitter, but only
  -- when the report itself remains editable inside their current live scope.
  return public.online_training_can_edit_report(v_report_id);
end;
$$;

revoke all on function public.online_training_storage_can_upload(text)
  from public,anon,authenticated;
revoke all on function public.online_training_storage_can_view(text)
  from public,anon,authenticated;
revoke all on function public.online_training_storage_can_delete(text,text)
  from public,anon,authenticated;
grant execute on function public.online_training_storage_can_upload(text)
  to authenticated;
grant execute on function public.online_training_storage_can_view(text)
  to authenticated;
grant execute on function public.online_training_storage_can_delete(text,text)
  to authenticated;

drop policy if exists online_training_storage_upload on storage.objects;
create policy online_training_storage_upload
on storage.objects for insert to authenticated
with check(
  bucket_id='online-training'
  and public.online_training_storage_can_upload(name)
);

drop policy if exists online_training_storage_read on storage.objects;
create policy online_training_storage_read
on storage.objects for select to authenticated
using(
  bucket_id='online-training'
  and public.online_training_storage_can_view(name)
);

drop policy if exists online_training_storage_delete on storage.objects;
create policy online_training_storage_delete
on storage.objects for delete to authenticated
using(
  bucket_id='online-training'
  and public.online_training_storage_can_delete(name,owner_id)
);

comment on function public.online_training_storage_can_upload(text) is
  'Boolean-only Storage RLS guard for online-training uploads; does not expose or query employee rows.';
comment on function public.online_training_storage_can_view(text) is
  'Boolean-only Storage RLS guard for report attachments inside the caller organization scope.';
comment on function public.online_training_storage_can_delete(text,text) is
  'Boolean-only Storage RLS guard for failed-upload cleanup and in-scope report attachment deletion.';

notify pgrst,'reload schema';
