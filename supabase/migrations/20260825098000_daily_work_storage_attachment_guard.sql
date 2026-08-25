-- Keep daily-work media private without making Storage RLS query the protected
-- report table as the authenticated role.  Every helper returns only a boolean
-- and verifies exact attachment-path membership before granting access.

create or replace function public.daily_work_storage_is_attached_anywhere(
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1
    from public.daily_work_reports report
    where exists(
      select 1
      from jsonb_array_elements(
        case when jsonb_typeof(report.attachments)='array'
          then report.attachments else '[]'::jsonb end
      ) attachment
      where btrim(coalesce(attachment->>'path',''))=coalesce(p_name,'')
    )
  );
$$;

create or replace function public.daily_work_storage_can_upload(p_name text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select
    public.daily_work_is_active_backend()
    and split_part(coalesce(p_name,''),'/',1)=(select auth.uid())::text
    and public.has_permission('daily_work.submit');
$$;

create or replace function public.daily_work_storage_can_view(p_name text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select
    public.daily_work_is_active_backend()
    and exists(
      select 1
      from public.daily_work_reports report
      where public.daily_work_report_in_scope(
          report.created_by,
          report.author_employee_no
        )
        and exists(
          select 1
          from jsonb_array_elements(
            case when jsonb_typeof(report.attachments)='array'
              then report.attachments else '[]'::jsonb end
          ) attachment
          where btrim(coalesce(attachment->>'path',''))=coalesce(p_name,'')
        )
    );
$$;

create or replace function public.daily_work_storage_can_delete(
  p_name text,
  p_owner_id text
)
returns boolean
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if not public.daily_work_is_active_backend() then
    return false;
  end if;

  -- Minted by an AFTER UPDATE/DELETE trigger only for exact paths this caller
  -- just detached through an authorized daily-work row mutation.
  if session_private.storage_cleanup_grant_is_valid(
       'daily-work',p_name
     ) then
    return true;
  end if;

  -- Preserve failed-upload rollback, but only for the caller's own namespace
  -- while no report references that exact object path.
  if split_part(coalesce(p_name,''),'/',1)=v_user_id::text
     and coalesce(p_owner_id,'')=v_user_id::text
     and public.has_permission('daily_work.submit')
     and not public.daily_work_storage_is_attached_anywhere(p_name) then
    return true;
  end if;

  return exists(
    select 1
    from public.daily_work_reports report
    where (
        report.created_by=v_user_id
        or (
          public.has_permission('daily_work.manage')
          and public.daily_work_report_in_scope(
            report.created_by,
            report.author_employee_no
          )
        )
      )
      and exists(
        select 1
        from jsonb_array_elements(
          case when jsonb_typeof(report.attachments)='array'
            then report.attachments else '[]'::jsonb end
        ) attachment
        where btrim(coalesce(attachment->>'path',''))=coalesce(p_name,'')
      )
  );
end;
$$;

create or replace function session_private.grant_daily_work_detached_storage()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_old_attachments jsonb;
  v_new_attachments jsonb;
begin
  if (select auth.uid()) is null
     or not public.daily_work_is_active_backend() then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;

  v_old_attachments := case when jsonb_typeof(old.attachments)='array'
    then old.attachments else '[]'::jsonb end;
  v_new_attachments := case
    when tg_op='UPDATE' and jsonb_typeof(new.attachments)='array'
      then new.attachments
    else '[]'::jsonb
  end;

  insert into session_private.storage_cleanup_grants(
    bucket_id,object_name,user_id,expires_at
  )
  select
    'daily-work',
    btrim(old_attachment->>'path'),
    (select auth.uid()),
    clock_timestamp()+interval '10 minutes'
  from jsonb_array_elements(v_old_attachments) old_attachment
  where btrim(coalesce(old_attachment->>'path',''))<>''
    and not exists(
      select 1
      from jsonb_array_elements(v_new_attachments) new_attachment
      where btrim(coalesce(new_attachment->>'path',''))
        =btrim(coalesce(old_attachment->>'path',''))
    )
  on conflict(bucket_id,object_name,user_id)
  do update set expires_at=excluded.expires_at;

  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function session_private.grant_daily_work_detached_storage()
  from public,anon,authenticated;

drop trigger if exists daily_work_detached_storage_cleanup_grant
  on public.daily_work_reports;
create trigger daily_work_detached_storage_cleanup_grant
after update of attachments on public.daily_work_reports
for each row execute function session_private.grant_daily_work_detached_storage();

drop trigger if exists daily_work_deleted_storage_cleanup_grant
  on public.daily_work_reports;
create trigger daily_work_deleted_storage_cleanup_grant
after delete on public.daily_work_reports
for each row execute function session_private.grant_daily_work_detached_storage();

revoke all on function public.daily_work_storage_is_attached_anywhere(text)
  from public,anon,authenticated;
revoke all on function public.daily_work_storage_can_upload(text)
  from public,anon,authenticated;
revoke all on function public.daily_work_storage_can_view(text)
  from public,anon,authenticated;
revoke all on function public.daily_work_storage_can_delete(text,text)
  from public,anon,authenticated;
grant execute on function public.daily_work_storage_can_upload(text)
  to authenticated;
grant execute on function public.daily_work_storage_can_view(text)
  to authenticated;
grant execute on function public.daily_work_storage_can_delete(text,text)
  to authenticated;

drop policy if exists daily_work_storage_upload on storage.objects;
create policy daily_work_storage_upload
on storage.objects for insert to authenticated
with check(
  bucket_id='daily-work'
  and public.daily_work_storage_can_upload(name)
);

drop policy if exists daily_work_storage_read on storage.objects;
create policy daily_work_storage_read
on storage.objects for select to authenticated
using(
  bucket_id='daily-work'
  and public.daily_work_storage_can_view(name)
);

drop policy if exists daily_work_storage_delete on storage.objects;
create policy daily_work_storage_delete
on storage.objects for delete to authenticated
using(
  bucket_id='daily-work'
  and public.daily_work_storage_can_delete(name,owner_id)
);

comment on function public.daily_work_storage_can_upload(text) is
  'Boolean-only daily-work upload guard: active backend, submit permission, and caller-owned folder.';
comment on function public.daily_work_storage_can_view(text) is
  'Reads a private object only when its exact path is attached to a daily-work report in live scope.';
comment on function public.daily_work_storage_can_delete(text,text) is
  'Deletes an exact in-scope report attachment or the caller own unreferenced failed upload.';

notify pgrst,'reload schema';
