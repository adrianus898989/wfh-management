-- Fine-grained correction/deletion for connectivity incidents and resilient
-- private evidence access. Deletion remains destructive and is audited.

insert into public.permissions(code,name,category,sensitive)
values
  ('connectivity.edit','编辑范围内停电 / 断网记录','connectivity',false),
  ('connectivity.delete','删除范围内停电 / 断网记录','connectivity',true)
on conflict(code) do update set
  name=excluded.name,
  category=excluded.category,
  sensitive=excluded.sensitive;

-- Existing roles that can create incidents retain correction access. The
-- sensitive delete permission is not granted to non-founder roles by default.
insert into public.role_permissions(role_id,permission_id)
select distinct current_permission.role_id,edit_permission.id
from public.role_permissions current_permission
join public.permissions create_permission
  on create_permission.id=current_permission.permission_id
 and create_permission.code='connectivity.create'
join public.permissions edit_permission
  on edit_permission.code='connectivity.edit'
on conflict do nothing;

create or replace function public.admin_connectivity_edit_employee_lookup(
  p_employee_no text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_key text := regexp_replace(upper(coalesce(btrim(p_employee_no),'')),'[^A-Z0-9]','','g');
  v_employee jsonb;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('connectivity.edit') then
    raise exception 'permission_denied';
  end if;
  if v_key='' then
    return jsonb_build_object('found',false,'employee',null);
  end if;

  select jsonb_build_object(
    'id',e.id,
    'employee_no',e.employee_no,
    'full_name',e.full_name,
    'status',e.status,
    'hire_date',e.hire_date,
    'country',coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写'),
    'team_name',t.name,
    'position_name',p.name
  )
  into v_employee
  from public.employees e
  left join public.teams t on t.id=e.team_id
  left join public.positions p on p.id=e.position_id
  where regexp_replace(upper(e.employee_no),'[^A-Z0-9]','','g')=v_key
    and public.can_manage_employee(e.id)
  order by case when e.status='active' then 0 else 1 end,
    e.updated_at desc nulls last,e.id
  limit 1;

  return jsonb_build_object('found',v_employee is not null,'employee',v_employee);
end;
$$;

create or replace function public.admin_connectivity_update(p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_id bigint := nullif(p_record->>'id','')::bigint;
  v_old public.employee_connectivity_incidents%rowtype;
  v_new public.employee_connectivity_incidents%rowtype;
  v_employee_id uuid;
  v_employee_no text := regexp_replace(upper(coalesce(btrim(p_record->>'employee_no'),'')),'[^A-Z0-9]','','g');
  v_full_name text;
  v_date date := nullif(p_record->>'incident_date','')::date;
  v_type text := coalesce(nullif(btrim(p_record->>'incident_type'),''),'internet_outage');
  v_status text := coalesce(nullif(btrim(p_record->>'status'),''),'reported');
  v_start time := nullif(p_record->>'started_at','')::time;
  v_end time := nullif(p_record->>'ended_at','')::time;
  v_start_ts timestamp;
  v_end_ts timestamp;
  v_duration integer;
  v_details text := nullif(btrim(p_record->>'details'),'');
  v_attachments jsonb := coalesce(p_record->'attachments','[]'::jsonb);
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('connectivity.edit') then
    raise exception 'permission_denied';
  end if;
  if v_id is null then raise exception 'connectivity_record_required'; end if;

  select * into v_old
  from public.employee_connectivity_incidents c
  where c.id=v_id
  for update;
  if not found then raise exception 'connectivity_record_not_found'; end if;
  if not public.can_manage_employee(v_old.employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  if v_employee_no='' then raise exception 'employee_id_required'; end if;
  if v_date is null or v_start is null or v_end is null then
    raise exception 'incident_time_required';
  end if;
  if v_type not in ('power_outage','internet_outage') then
    raise exception 'invalid_incident_type';
  end if;
  if v_status not in ('reported','verified','resolved','rejected') then
    raise exception 'invalid_status';
  end if;
  if v_details is not null and char_length(v_details)>3000 then
    raise exception 'details_too_long';
  end if;
  if jsonb_typeof(v_attachments)<>'array' then
    raise exception 'invalid_attachments';
  end if;
  if jsonb_array_length(v_attachments)>3 then
    raise exception 'invalid_attachments';
  end if;

  select e.id,e.full_name
  into v_employee_id,v_full_name
  from public.employees e
  where regexp_replace(upper(e.employee_no),'[^A-Z0-9]','','g')=v_employee_no
  order by case when e.status='active' then 0 else 1 end,
    e.updated_at desc nulls last,e.id
  limit 1;
  if v_employee_id is null then raise exception 'employee_not_found'; end if;
  if not public.can_manage_employee(v_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  if exists(
    select 1
    from jsonb_array_elements(v_attachments) attachment
    where btrim(coalesce(attachment->>'path',''))=''
      or coalesce(attachment->>'mime','') not in (
        'image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif',
        'video/mp4','video/quicktime','video/webm'
      )
      or char_length(coalesce(attachment->>'path',''))>1024
      or (
        not (
          coalesce(v_old.attachments,'[]'::jsonb)
            @> jsonb_build_array(jsonb_build_object('path',attachment->>'path'))
        )
        and (
          split_part(attachment->>'path','/',1)<>v_user::text
          or regexp_replace(upper(split_part(attachment->>'path','/',2)),'[^A-Z0-9]','','g')<>v_employee_no
        )
      )
  ) then
    raise exception 'invalid_attachments';
  end if;

  v_start_ts:=v_date+v_start;
  v_end_ts:=v_date+v_end;
  if v_end_ts<v_start_ts then v_end_ts:=v_end_ts+interval '1 day'; end if;
  v_duration:=ceil(extract(epoch from (v_end_ts-v_start_ts))/60.0)::integer;

  update public.employee_connectivity_incidents
  set employee_id=v_employee_id,
      incident_date=v_date,
      incident_type=v_type,
      started_at=v_start,
      ended_at=v_end,
      duration_minutes=v_duration,
      details=v_details,
      attachments=v_attachments,
      status=v_status,
      updated_at=clock_timestamp()
  where id=v_id
  returning * into v_new;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
  ) values(
    v_user,v_employee_id,'connectivity','update_incident',v_id::text,
    to_jsonb(v_old),to_jsonb(v_new),'管理员修正停电 / 断网记录'
  );

  return jsonb_build_object(
    'ok',true,
    'id',v_new.id,
    'employee_id',v_employee_id,
    'employee_no',v_employee_no,
    'full_name',v_full_name,
    'duration_minutes',v_duration,
    'attachments',v_new.attachments
  );
end;
$$;

create or replace function public.admin_connectivity_delete(p_incident_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_old public.employee_connectivity_incidents%rowtype;
  v_employee_no text;
  v_full_name text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('connectivity.delete') then
    raise exception 'permission_denied';
  end if;

  select * into v_old
  from public.employee_connectivity_incidents c
  where c.id=p_incident_id
  for update;
  if not found then raise exception 'connectivity_record_not_found'; end if;
  if not public.can_manage_employee(v_old.employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  select e.employee_no,e.full_name into v_employee_no,v_full_name
  from public.employees e where e.id=v_old.employee_id;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
  ) values(
    v_user,v_old.employee_id,'connectivity','delete_incident',v_old.id::text,
    to_jsonb(v_old)||jsonb_build_object(
      'employee_no',v_employee_no,
      'full_name',v_full_name
    ),null,'管理员确认删除停电 / 断网记录'
  );

  delete from public.employee_connectivity_incidents where id=v_old.id;

  return jsonb_build_object(
    'ok',true,
    'id',v_old.id,
    'employee_id',v_old.employee_id,
    'employee_no',v_employee_no,
    'full_name',v_full_name,
    'attachments',coalesce(v_old.attachments,'[]'::jsonb)
  );
end;
$$;

revoke all on function public.admin_connectivity_edit_employee_lookup(text)
  from public,anon,authenticated;
revoke all on function public.admin_connectivity_update(jsonb)
  from public,anon,authenticated;
revoke all on function public.admin_connectivity_delete(bigint)
  from public,anon,authenticated;
grant execute on function public.admin_connectivity_edit_employee_lookup(text)
  to authenticated;
grant execute on function public.admin_connectivity_update(jsonb)
  to authenticated;
grant execute on function public.admin_connectivity_delete(bigint)
  to authenticated;

-- Storage RLS is evaluated for the authenticated role, which intentionally
-- has neither USAGE on session_private nor EXECUTE on its validator. Expose a
-- boolean-only guarded wrapper instead of opening the private schema.
create or replace function public.connectivity_current_staff_session_is_valid()
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select session_private.current_app_session_is_valid('staff');
$$;
revoke all on function public.connectivity_current_staff_session_is_valid()
  from public,anon,authenticated;
grant execute on function public.connectivity_current_staff_session_is_valid()
  to authenticated;

-- Private-bucket reads use the incident row when possible. Edit/delete users
-- can also resolve scoped orphan objects by the employee key encoded in the
-- canonical path: actor_uuid/employee_no/date/file.
drop policy if exists connectivity_evidence_admin_read on storage.objects;
create policy connectivity_evidence_admin_read
on storage.objects for select to authenticated
using(
  bucket_id='connectivity-evidence'
  and (
    (
      public.has_permission('connectivity.view')
      and exists(
        select 1
        from public.employee_connectivity_incidents incident
        where incident.attachments @> jsonb_build_array(jsonb_build_object('path',storage.objects.name))
          and public.can_manage_employee(incident.employee_id)
      )
    )
    or (
      owner_id=(select auth.uid())::text
      and (
        public.has_permission('connectivity.create')
        or public.has_permission('connectivity.edit')
        or public.has_permission('connectivity.delete')
      )
      and exists(
        select 1
        from public.employees employee
        where regexp_replace(upper(employee.employee_no),'[^A-Z0-9]','','g')
          =regexp_replace(upper((storage.foldername(storage.objects.name))[2]),'[^A-Z0-9]','','g')
          and public.can_manage_employee(employee.id)
      )
    )
    or (
      (
        public.has_permission('connectivity.edit')
        or public.has_permission('connectivity.delete')
      )
      and exists(
        select 1
        from public.employees employee
        where regexp_replace(upper(employee.employee_no),'[^A-Z0-9]','','g')
          =regexp_replace(upper((storage.foldername(storage.objects.name))[2]),'[^A-Z0-9]','','g')
          and public.can_manage_employee(employee.id)
      )
    )
    or (
      public.connectivity_current_staff_session_is_valid()
      and exists(
        select 1
        from public.employee_connectivity_incidents incident
        join public.user_access access
          on access.employee_id=incident.employee_id
         and access.auth_user_id=(select auth.uid())
         and access.active
         and access.employee_portal_enabled
        where incident.attachments @> jsonb_build_array(jsonb_build_object('path',storage.objects.name))
      )
    )
  )
);

drop policy if exists connectivity_evidence_admin_insert on storage.objects;
create policy connectivity_evidence_admin_insert
on storage.objects for insert to authenticated
with check(
  bucket_id='connectivity-evidence'
  and (
    public.has_permission('connectivity.create')
    or public.has_permission('connectivity.edit')
  )
  and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists(
    select 1
    from public.employees employee
    where regexp_replace(upper(employee.employee_no),'[^A-Z0-9]','','g')
      =regexp_replace(upper((storage.foldername(storage.objects.name))[2]),'[^A-Z0-9]','','g')
      and public.can_manage_employee(employee.id)
  )
);

drop policy if exists connectivity_evidence_admin_delete on storage.objects;
create policy connectivity_evidence_admin_delete
on storage.objects for delete to authenticated
using(
  bucket_id='connectivity-evidence'
  and (
    (
      owner_id=(select auth.uid())::text
      and (
        public.has_permission('connectivity.create')
        or public.has_permission('connectivity.edit')
      )
      and exists(
        select 1
        from public.employees employee
        where regexp_replace(upper(employee.employee_no),'[^A-Z0-9]','','g')
          =regexp_replace(upper((storage.foldername(storage.objects.name))[2]),'[^A-Z0-9]','','g')
          and public.can_manage_employee(employee.id)
      )
    )
    or (
      (
        public.has_permission('connectivity.edit')
        or public.has_permission('connectivity.delete')
      )
      and exists(
        select 1
        from public.employees employee
        where regexp_replace(upper(employee.employee_no),'[^A-Z0-9]','','g')
          =regexp_replace(upper((storage.foldername(storage.objects.name))[2]),'[^A-Z0-9]','','g')
          and public.can_manage_employee(employee.id)
      )
    )
  )
);

comment on function public.admin_connectivity_update(jsonb) is
  'Updates one in-scope connectivity incident when connectivity.edit is granted.';
comment on function public.admin_connectivity_delete(bigint) is
  'Deletes and audits one in-scope connectivity incident when connectivity.delete is granted.';
comment on function public.connectivity_current_staff_session_is_valid() is
  'Boolean-only wrapper used by connectivity Storage RLS to enforce the current staff browser lease.';

notify pgrst,'reload schema';
