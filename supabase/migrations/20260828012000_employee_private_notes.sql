begin;

-- These permissions are intentionally not granted to any non-Founder role.
-- Founder access remains implicit through public.has_permission(); future
-- access must be delegated explicitly in the role/account permission editor.
insert into public.permissions(code,name,category,sensitive)
values
  ('employee.private_note.view','员工档案 · 查看内部备注','employee',true),
  ('employee.private_note.manage','员工档案 · 新增、修改及归档内部备注','employee',true)
on conflict(code) do update set
  name=excluded.name,category=excluded.category,sensitive=excluded.sensitive;

create schema if not exists employee_private;
revoke all on schema employee_private from public,anon,authenticated,service_role;

create table if not exists employee_private.employee_notes (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  note_text text not null,
  category text not null default 'general',
  incident_date date,
  version integer not null default 1,
  created_by uuid not null,
  created_by_username text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_by uuid not null,
  updated_by_username text not null,
  updated_at timestamptz not null default clock_timestamp(),
  archived_by uuid,
  archived_by_username text,
  archived_at timestamptz,
  constraint employee_private_note_text_length_check check (
    char_length(btrim(note_text)) between 1 and 2000
  ),
  constraint employee_private_note_category_check check (
    category in ('general','identity','integrity','conduct','payment','other')
  ),
  constraint employee_private_note_version_check check (version > 0)
);

create table if not exists employee_private.employee_note_revisions (
  id bigint generated always as identity primary key,
  note_id uuid not null references employee_private.employee_notes(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  version integer not null,
  note_text text not null,
  category text not null,
  incident_date date,
  action text not null,
  changed_by uuid not null,
  changed_by_username text not null,
  changed_at timestamptz not null default clock_timestamp(),
  constraint employee_private_note_revision_action_check check (
    action in ('create','update','archive')
  ),
  constraint employee_private_note_revision_unique unique(note_id,version)
);

create index if not exists employee_private_notes_employee_active_idx
  on employee_private.employee_notes(employee_id,updated_at desc,id)
  where archived_at is null;
create index if not exists employee_private_note_revisions_note_idx
  on employee_private.employee_note_revisions(note_id,version desc);

alter table employee_private.employee_notes enable row level security;
alter table employee_private.employee_note_revisions enable row level security;
revoke all on table employee_private.employee_notes,
  employee_private.employee_note_revisions
  from public,anon,authenticated,service_role;
revoke all on all sequences in schema employee_private
  from public,anon,authenticated,service_role;

comment on table employee_private.employee_notes is
  'Restricted internal employee notes. Browser access is only through scoped, permission-checked RPCs; records are archived rather than deleted.';
comment on table employee_private.employee_note_revisions is
  'Append-only private body revisions for internal employee notes. Public audit_logs receive metadata only.';

create or replace function employee_private.current_note_actor_username()
returns text
language sql
stable
security definer
set search_path=''
as $$
  select coalesce((
    select case
      when strpos(btrim(coalesce(access.login_username,'')),'@') = 0
        then nullif(btrim(access.login_username),'')
      else null
    end
    from public.user_access access
    where access.auth_user_id=(select auth.uid())
      and access.active=true
      and access.backend_enabled=true
    order by access.updated_at desc
    limit 1
  ),'后台账号');
$$;

create or replace function employee_private.note_audit_metadata(
  p_note_id uuid,
  p_category text,
  p_note_text text,
  p_version integer,
  p_archived boolean default false
)
returns jsonb
language sql
immutable
set search_path=''
as $$
  select jsonb_build_object(
    'note_id',p_note_id,
    'category',p_category,
    'content_length',char_length(coalesce(p_note_text,'')),
    'version',p_version,
    'archived',coalesce(p_archived,false)
  );
$$;

revoke all on function employee_private.current_note_actor_username(),
  employee_private.note_audit_metadata(uuid,text,text,integer,boolean)
  from public,anon,authenticated,service_role;

create or replace function public.admin_employee_private_notes(
  p_employee_id uuid,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,20),1),100);
  v_total bigint;
  v_rows jsonb;
  v_manage boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  v_manage:=public.has_permission('employee.private_note.manage');
  if not (v_manage or public.has_permission('employee.private_note.view')) then
    raise exception 'permission_denied';
  end if;
  if p_employee_id is null then raise exception 'employee_required'; end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  select count(*) into v_total
  from employee_private.employee_notes note
  where note.employee_id=p_employee_id and note.archived_at is null;

  select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.updated_at desc,row_data.id),'[]'::jsonb)
  into v_rows
  from (
    select
      note.id,note.employee_id,note.note_text,note.category,note.incident_date,
      note.version,note.created_by_username,note.created_at,
      note.updated_by_username,note.updated_at
    from employee_private.employee_notes note
    where note.employee_id=p_employee_id and note.archived_at is null
    order by note.updated_at desc,note.id
    limit v_size offset (v_page-1)*v_size
  ) row_data;

  return jsonb_build_object(
    'rows',v_rows,'total',v_total,'page',v_page,'page_size',v_size,
    'pages',greatest(ceil(v_total::numeric/v_size)::integer,1),
    'permissions',jsonb_build_object('manage',v_manage)
  );
end;
$$;

create or replace function public.admin_employee_private_note_create(
  p_employee_id uuid,
  p_note text,
  p_category text default 'general',
  p_incident_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid:=(select auth.uid());
  v_actor text;
  v_note text:=btrim(coalesce(p_note,''));
  v_category text:=lower(btrim(coalesce(p_category,'general')));
  v_record employee_private.employee_notes%rowtype;
  v_metadata jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('employee.private_note.manage') then
    raise exception 'permission_denied';
  end if;
  if p_employee_id is null then raise exception 'employee_required'; end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  if char_length(v_note) not between 1 and 2000 then
    raise exception 'invalid_private_note';
  end if;
  if v_category not in ('general','identity','integrity','conduct','payment','other') then
    raise exception 'invalid_private_note_category';
  end if;

  v_actor:=employee_private.current_note_actor_username();
  insert into employee_private.employee_notes(
    employee_id,note_text,category,incident_date,
    created_by,created_by_username,updated_by,updated_by_username
  ) values(
    p_employee_id,v_note,v_category,p_incident_date,
    v_user,v_actor,v_user,v_actor
  ) returning * into v_record;

  insert into employee_private.employee_note_revisions(
    note_id,employee_id,version,note_text,category,incident_date,
    action,changed_by,changed_by_username
  ) values(
    v_record.id,v_record.employee_id,v_record.version,v_record.note_text,
    v_record.category,v_record.incident_date,'create',v_user,v_actor
  );

  v_metadata:=employee_private.note_audit_metadata(
    v_record.id,v_record.category,v_record.note_text,v_record.version,false
  );
  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,new_data,reason
  ) values(
    v_user,p_employee_id,'employee_private_note','create_private_note',
    v_record.id::text,v_metadata,'新增员工内部备注（审计不保存正文）'
  );

  return jsonb_build_object('ok',true,'note',jsonb_build_object(
    'id',v_record.id,'employee_id',v_record.employee_id,
    'note_text',v_record.note_text,'category',v_record.category,
    'incident_date',v_record.incident_date,'version',v_record.version,
    'created_by_username',v_record.created_by_username,'created_at',v_record.created_at,
    'updated_by_username',v_record.updated_by_username,'updated_at',v_record.updated_at
  ));
end;
$$;

create or replace function public.admin_employee_private_note_update(
  p_note_id uuid,
  p_expected_version integer,
  p_note text,
  p_category text,
  p_incident_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid:=(select auth.uid());
  v_actor text;
  v_note text:=btrim(coalesce(p_note,''));
  v_category text:=lower(btrim(coalesce(p_category,'')));
  v_old employee_private.employee_notes%rowtype;
  v_new employee_private.employee_notes%rowtype;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('employee.private_note.manage') then
    raise exception 'permission_denied';
  end if;
  if p_note_id is null or coalesce(p_expected_version,0)<1 then
    raise exception 'private_note_version_required';
  end if;
  if char_length(v_note) not between 1 and 2000 then
    raise exception 'invalid_private_note';
  end if;
  if v_category not in ('general','identity','integrity','conduct','payment','other') then
    raise exception 'invalid_private_note_category';
  end if;

  select * into v_old
  from employee_private.employee_notes note
  where note.id=p_note_id
  for update;
  if not found then raise exception 'private_note_not_found'; end if;
  if v_old.archived_at is not null then raise exception 'private_note_archived'; end if;
  if not public.can_manage_employee(v_old.employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  if v_old.version<>p_expected_version then raise exception 'private_note_version_conflict'; end if;

  v_actor:=employee_private.current_note_actor_username();
  update employee_private.employee_notes note
  set note_text=v_note,category=v_category,incident_date=p_incident_date,
      version=note.version+1,updated_by=v_user,updated_by_username=v_actor,
      updated_at=clock_timestamp()
  where note.id=p_note_id and note.version=p_expected_version
  returning * into v_new;
  if not found then raise exception 'private_note_version_conflict'; end if;

  insert into employee_private.employee_note_revisions(
    note_id,employee_id,version,note_text,category,incident_date,
    action,changed_by,changed_by_username
  ) values(
    v_new.id,v_new.employee_id,v_new.version,v_new.note_text,
    v_new.category,v_new.incident_date,'update',v_user,v_actor
  );

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
  ) values(
    v_user,v_new.employee_id,'employee_private_note','update_private_note',v_new.id::text,
    employee_private.note_audit_metadata(v_old.id,v_old.category,v_old.note_text,v_old.version,false),
    employee_private.note_audit_metadata(v_new.id,v_new.category,v_new.note_text,v_new.version,false),
    '修改员工内部备注（审计不保存正文）'
  );

  return jsonb_build_object('ok',true,'note',jsonb_build_object(
    'id',v_new.id,'employee_id',v_new.employee_id,
    'note_text',v_new.note_text,'category',v_new.category,
    'incident_date',v_new.incident_date,'version',v_new.version,
    'created_by_username',v_new.created_by_username,'created_at',v_new.created_at,
    'updated_by_username',v_new.updated_by_username,'updated_at',v_new.updated_at
  ));
end;
$$;

create or replace function public.admin_employee_private_note_archive(
  p_note_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid:=(select auth.uid());
  v_actor text;
  v_old employee_private.employee_notes%rowtype;
  v_new employee_private.employee_notes%rowtype;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('employee.private_note.manage') then
    raise exception 'permission_denied';
  end if;
  if p_note_id is null or coalesce(p_expected_version,0)<1 then
    raise exception 'private_note_version_required';
  end if;

  select * into v_old
  from employee_private.employee_notes note
  where note.id=p_note_id
  for update;
  if not found then raise exception 'private_note_not_found'; end if;
  if v_old.archived_at is not null then raise exception 'private_note_archived'; end if;
  if not public.can_manage_employee(v_old.employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  if v_old.version<>p_expected_version then raise exception 'private_note_version_conflict'; end if;

  v_actor:=employee_private.current_note_actor_username();
  update employee_private.employee_notes note
  set version=note.version+1,updated_by=v_user,updated_by_username=v_actor,
      updated_at=clock_timestamp(),archived_by=v_user,
      archived_by_username=v_actor,archived_at=clock_timestamp()
  where note.id=p_note_id and note.version=p_expected_version
  returning * into v_new;
  if not found then raise exception 'private_note_version_conflict'; end if;

  insert into employee_private.employee_note_revisions(
    note_id,employee_id,version,note_text,category,incident_date,
    action,changed_by,changed_by_username
  ) values(
    v_new.id,v_new.employee_id,v_new.version,v_new.note_text,
    v_new.category,v_new.incident_date,'archive',v_user,v_actor
  );

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
  ) values(
    v_user,v_new.employee_id,'employee_private_note','archive_private_note',v_new.id::text,
    employee_private.note_audit_metadata(v_old.id,v_old.category,v_old.note_text,v_old.version,false),
    employee_private.note_audit_metadata(v_new.id,v_new.category,v_new.note_text,v_new.version,true),
    '归档员工内部备注（审计不保存正文）'
  );

  return jsonb_build_object('ok',true,'id',v_new.id,'version',v_new.version,'archived',true);
end;
$$;

revoke all on function public.admin_employee_private_notes(uuid,integer,integer),
  public.admin_employee_private_note_create(uuid,text,text,date),
  public.admin_employee_private_note_update(uuid,integer,text,text,date),
  public.admin_employee_private_note_archive(uuid,integer)
  from public,anon,authenticated;
grant execute on function public.admin_employee_private_notes(uuid,integer,integer),
  public.admin_employee_private_note_create(uuid,text,text,date),
  public.admin_employee_private_note_update(uuid,integer,text,text,date),
  public.admin_employee_private_note_archive(uuid,integer)
  to authenticated;

comment on function public.admin_employee_private_notes(uuid,integer,integer) is
  'Returns active internal notes only after current admin session, dedicated permission and employee-scope checks.';
comment on function public.admin_employee_private_note_create(uuid,text,text,date) is
  'Creates a scoped internal note and private body revision; public audit contains metadata only.';
comment on function public.admin_employee_private_note_update(uuid,integer,text,text,date) is
  'Optimistically updates a scoped internal note by expected version and retains the private prior revision.';
comment on function public.admin_employee_private_note_archive(uuid,integer) is
  'Archives rather than deletes a scoped internal note using optimistic version control.';

notify pgrst,'reload schema';

commit;
