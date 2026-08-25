-- Close the remaining report-member and private attachment authorization gaps.
-- The public report writer stays API-compatible, while the previous writer is
-- moved behind a scope-validating wrapper that authenticated callers cannot
-- invoke directly.

alter function public.online_training_save_report(jsonb,jsonb)
  rename to online_training_save_report_scope_legacy;
alter function public.online_training_save_report_scope_legacy(jsonb,jsonb)
  set schema session_private;

revoke all on function session_private.online_training_save_report_scope_legacy(jsonb,jsonb)
  from public,anon,authenticated;

create or replace function public.online_training_save_report(
  p_report jsonb,
  p_members jsonb
)
returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_member jsonb;
  v_employee_id uuid;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if jsonb_typeof(p_report) is distinct from 'object'
     or jsonb_typeof(p_members) is distinct from 'array' then
    raise exception '报告数据格式不正确';
  end if;

  for v_member in select value from jsonb_array_elements(p_members)
  loop
    begin
      v_employee_id := nullif(btrim(v_member->>'employee_id'),'')::uuid;
    exception when invalid_text_representation then
      raise exception '报告成员缺少有效员工档案关联';
    end;

    if v_employee_id is null
       or not public.online_training_employee_in_scope(v_employee_id) then
      raise exception '报告中包含超出管理范围的员工';
    end if;
  end loop;

  return session_private.online_training_save_report_scope_legacy(
    p_report,
    p_members
  );
end;
$$;

revoke all on function public.online_training_save_report(jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.online_training_save_report(jsonb,jsonb)
  to authenticated;

comment on function public.online_training_save_report(jsonb,jsonb) is
  'Scope-enforcing wrapper: every training-report member must remain inside the caller live employee scope, including callers with manage permission.';

-- Storage deletes happen after the report transaction commits.  When an
-- editor removes an attachment from somebody else's report, exact membership
-- no longer exists by the time Storage evaluates DELETE RLS.  Record a short,
-- server-issued cleanup grant in the same transaction that detaches the path.
-- The table is private and callers cannot mint grants themselves.
create table if not exists session_private.storage_cleanup_grants (
  bucket_id text not null,
  object_name text not null,
  user_id uuid not null,
  expires_at timestamptz not null,
  primary key(bucket_id,object_name,user_id)
);

create index if not exists storage_cleanup_grants_expiry_idx
  on session_private.storage_cleanup_grants(expires_at);

revoke all on table session_private.storage_cleanup_grants
  from public,anon,authenticated;

create or replace function session_private.storage_cleanup_grant_is_valid(
  p_bucket_id text,
  p_object_name text
)
returns boolean
language sql
volatile
security definer
set search_path=''
as $$
  select exists(
    select 1
    from session_private.storage_cleanup_grants grant_row
    where grant_row.bucket_id=coalesce(p_bucket_id,'')
      and grant_row.object_name=coalesce(p_object_name,'')
      and grant_row.user_id=(select auth.uid())
      and grant_row.expires_at>clock_timestamp()
  );
$$;

revoke all on function session_private.storage_cleanup_grant_is_valid(text,text)
  from public,anon,authenticated;

create or replace function session_private.grant_online_training_detached_storage()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if (select auth.uid()) is null
     or not session_private.current_app_session_is_valid('admin') then
    return new;
  end if;

  insert into session_private.storage_cleanup_grants(
    bucket_id,object_name,user_id,expires_at
  )
  select
    'online-training',
    btrim(old_attachment->>'path'),
    (select auth.uid()),
    clock_timestamp()+interval '10 minutes'
  from jsonb_array_elements(
    case when jsonb_typeof(old.attachments)='array'
      then old.attachments else '[]'::jsonb end
  ) old_attachment
  where btrim(coalesce(old_attachment->>'path',''))<>''
    and not exists(
      select 1
      from jsonb_array_elements(
        case when jsonb_typeof(new.attachments)='array'
          then new.attachments else '[]'::jsonb end
      ) new_attachment
      where btrim(coalesce(new_attachment->>'path',''))
        =btrim(coalesce(old_attachment->>'path',''))
    )
  on conflict(bucket_id,object_name,user_id)
  do update set expires_at=excluded.expires_at;

  return new;
end;
$$;

revoke all on function session_private.grant_online_training_detached_storage()
  from public,anon,authenticated;

drop trigger if exists online_training_detached_storage_cleanup_grant
  on public.online_training_reports;
create trigger online_training_detached_storage_cleanup_grant
after update of attachments on public.online_training_reports
for each row execute function session_private.grant_online_training_detached_storage();

-- A report UUID in the folder name is necessary but not sufficient.  Private
-- objects become readable/editable only after that exact path is attached to
-- the report row.  A submitter may still clean up their own orphaned upload.
create or replace function public.online_training_storage_is_report_attachment(
  p_name text,
  p_report_id uuid
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1
    from public.online_training_reports report
    where report.id=p_report_id
      and jsonb_typeof(coalesce(report.attachments,'[]'::jsonb))='array'
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

create or replace function public.online_training_storage_is_attached_anywhere(
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
    from public.online_training_reports report
    where jsonb_typeof(coalesce(report.attachments,'[]'::jsonb))='array'
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

revoke all on function public.online_training_storage_is_report_attachment(text,uuid)
  from public,anon,authenticated;
revoke all on function public.online_training_storage_is_attached_anywhere(text)
  from public,anon,authenticated;

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
  return public.online_training_storage_is_report_attachment(p_name,v_report_id)
    and public.online_training_can_view_report(v_report_id);
end;
$$;

create or replace function public.online_training_storage_can_delete(
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
  v_report_id uuid;
  v_owned_by_caller boolean :=
    split_part(coalesce(p_name,''),'/',1)=(select auth.uid())::text
    and coalesce(p_owner_id,'')=(select auth.uid())::text;
begin
  if not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;

  -- The owner may remove a failed/new upload only while no report references
  -- that exact path.  This keeps rollback possible without widening report
  -- attachment deletion.
  if v_owned_by_caller
     and (
       public.has_permission('online_training.submit')
       or public.has_permission('online_training.manage')
     )
     and not public.online_training_storage_is_attached_anywhere(p_name) then
    return true;
  end if;

  -- A grant is minted only by the report-row trigger for an exact path that
  -- this caller just detached through an authorized report edit.
  if session_private.storage_cleanup_grant_is_valid(
       'online-training',p_name
     ) then
    return true;
  end if;

  begin
    v_report_id := split_part(coalesce(p_name,''),'/',2)::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  return public.online_training_storage_is_report_attachment(p_name,v_report_id)
    and public.online_training_can_edit_report(v_report_id);
end;
$$;

revoke all on function public.online_training_storage_can_view(text)
  from public,anon,authenticated;
revoke all on function public.online_training_storage_can_delete(text,text)
  from public,anon,authenticated;
grant execute on function public.online_training_storage_can_view(text)
  to authenticated;
grant execute on function public.online_training_storage_can_delete(text,text)
  to authenticated;

comment on function public.online_training_storage_can_view(text) is
  'Allows private report-image reads only when the exact object path is attached to an in-scope report.';
comment on function public.online_training_storage_can_delete(text,text) is
  'Allows exact attached-path deletion for report editors, plus owner cleanup of an unreferenced upload.';

-- Enforce the connectivity object namespace at the table boundary so every
-- current and future insert/update path (not only today's RPCs) must encode the
-- record employee ID in folder segment two.
create or replace function employee_ops_private.enforce_connectivity_attachment_employee_path()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_employee_key text;
begin
  select regexp_replace(upper(employee.employee_no),'[^A-Z0-9]','','g')
  into v_employee_key
  from public.employees employee
  where employee.id=new.employee_id;

  if coalesce(v_employee_key,'')='' then
    raise exception 'employee_not_found';
  end if;
  if jsonb_typeof(coalesce(new.attachments,'[]'::jsonb))<>'array' then
    raise exception 'invalid_attachments';
  end if;
  if exists(
    select 1
    from jsonb_array_elements(coalesce(new.attachments,'[]'::jsonb)) attachment
    where btrim(coalesce(attachment->>'path',''))=''
      or regexp_replace(
        upper(split_part(coalesce(attachment->>'path',''),'/',2)),
        '[^A-Z0-9]','','g'
      )<>v_employee_key
  ) then
    raise exception 'invalid_attachment_employee_path';
  end if;

  return new;
end;
$$;

revoke all on function employee_ops_private.enforce_connectivity_attachment_employee_path()
  from public,anon,authenticated;

drop trigger if exists employee_connectivity_attachment_employee_guard
  on public.employee_connectivity_incidents;
create trigger employee_connectivity_attachment_employee_guard
before insert or update of employee_id,attachments
on public.employee_connectivity_incidents
for each row execute function employee_ops_private.enforce_connectivity_attachment_employee_path();

notify pgrst,'reload schema';
