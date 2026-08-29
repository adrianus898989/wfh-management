-- Allow an outage to be recorded while it is still in progress, then completed
-- through the existing scoped edit flow after service resumes.
--
-- This migration deliberately keeps the existing permission/session checks,
-- employee scope, attachment validation, audit logging and status vocabulary.

begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $connectivity_ongoing_prerequisites$
declare
  v_create_definition text;
  v_update_definition text;
begin
  if to_regclass('public.employee_connectivity_incidents') is null then
    raise exception 'employee_connectivity_incidents_missing';
  end if;

  if not exists(
    select 1
    from information_schema.columns
    where table_schema='public'
      and table_name='employee_connectivity_incidents'
      and column_name='ended_at'
  ) then
    raise exception 'employee_connectivity_ended_at_missing';
  end if;

  if to_regprocedure('employee_ops_private.admin_connectivity_create(jsonb)') is null then
    raise exception 'admin_connectivity_create_private_missing';
  end if;
  if to_regprocedure('public.admin_connectivity_update(jsonb)') is null then
    raise exception 'admin_connectivity_update_missing';
  end if;

  select pg_get_functiondef(
    'employee_ops_private.admin_connectivity_create(jsonb)'::regprocedure
  ) into v_create_definition;
  if strpos(v_create_definition,'public.can_manage_employee')=0
     or strpos(v_create_definition,'public.has_permission(''connectivity.create'')')=0
     or strpos(v_create_definition,'invalid_attachments')=0 then
    raise exception 'admin_connectivity_create_prerequisite_changed';
  end if;

  select pg_get_functiondef(
    'public.admin_connectivity_update(jsonb)'::regprocedure
  ) into v_update_definition;
  if strpos(v_update_definition,'current_app_session_is_valid(''admin'')')=0
     or strpos(v_update_definition,'public.has_permission(''connectivity.edit'')')=0
     or strpos(v_update_definition,'public.can_manage_employee')=0
     or strpos(v_update_definition,'''update_incident''')=0 then
    raise exception 'admin_connectivity_update_prerequisite_changed';
  end if;
end
$connectivity_ongoing_prerequisites$;

alter table public.employee_connectivity_incidents
  alter column ended_at drop not null;

alter table public.employee_connectivity_incidents
  drop constraint if exists employee_connectivity_end_duration_pair_check;
alter table public.employee_connectivity_incidents
  add constraint employee_connectivity_end_duration_pair_check
  check (
    (ended_at is null and duration_minutes is null)
    or (ended_at is not null and duration_minutes is not null)
  ) not valid;
alter table public.employee_connectivity_incidents
  validate constraint employee_connectivity_end_duration_pair_check;

create or replace function employee_ops_private.admin_connectivity_create(p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text := regexp_replace(upper(coalesce(btrim(p_record->>'employee_no'),'')),'[^A-Z0-9]','','g');
  v_date date := nullif(p_record->>'incident_date','')::date;
  v_type text := coalesce(nullif(btrim(p_record->>'incident_type'),''),'power_outage');
  v_start time := nullif(p_record->>'started_at','')::time;
  v_end time := nullif(p_record->>'ended_at','')::time;
  v_start_ts timestamp;
  v_end_ts timestamp;
  v_duration integer;
  v_status text;
  v_attachments jsonb := coalesce(p_record->'attachments','[]'::jsonb);
  v_id bigint;
  v_full_name text;
  v_hire_date date;
  v_country text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('connectivity.create') then raise exception 'permission_denied'; end if;
  if v_employee_no='' then raise exception 'employee_id_required'; end if;
  if v_date is null or v_start is null then raise exception 'incident_start_required'; end if;
  if v_type not in ('power_outage','internet_outage') then raise exception 'invalid_incident_type'; end if;
  if jsonb_typeof(v_attachments)<>'array' or jsonb_array_length(v_attachments)>3 then raise exception 'invalid_attachments'; end if;
  if exists(
    select 1 from jsonb_array_elements(v_attachments) attachment
    where btrim(coalesce(attachment->>'path',''))=''
      or split_part(attachment->>'path','/',1)<>v_user::text
      or not (
        coalesce(attachment->>'mime','') like 'image/%'
        or coalesce(attachment->>'mime','') like 'video/%'
      )
  ) then raise exception 'invalid_attachments'; end if;

  select employee.id,employee.full_name,employee.hire_date,
    coalesce(nullif(btrim(employee.country),''),nullif(btrim(employee.nationality),''),'未填写')
  into v_employee_id,v_full_name,v_hire_date,v_country
  from public.employees employee
  where regexp_replace(upper(employee.employee_no),'[^A-Z0-9]','','g')=v_employee_no
  order by case when employee.status='active' then 0 else 1 end,
    employee.updated_at desc nulls last,employee.id
  limit 1;
  if v_employee_id is null then raise exception 'employee_not_found'; end if;
  if not public.can_manage_employee(v_employee_id) then raise exception 'employee_out_of_scope'; end if;

  if v_end is not null then
    v_start_ts:=v_date+v_start;
    v_end_ts:=v_date+v_end;
    if v_end_ts<v_start_ts then v_end_ts:=v_end_ts+interval '1 day'; end if;
    v_duration:=ceil(extract(epoch from (v_end_ts-v_start_ts))/60.0)::integer;
  end if;
  v_status:=case when v_end is null then 'reported' else 'resolved' end;

  insert into public.employee_connectivity_incidents(
    employee_id,incident_date,incident_type,started_at,ended_at,duration_minutes,
    work_impact,details,evidence_url,attachments,status,recorded_by
  ) values(
    v_employee_id,v_date,v_type,v_start,v_end,v_duration,
    'absent',nullif(btrim(p_record->>'details'),''),null,v_attachments,v_status,v_user
  ) returning id into v_id;

  return jsonb_build_object(
    'id',v_id,
    'employee_id',v_employee_id,
    'employee_no',v_employee_no,
    'full_name',v_full_name,
    'hire_date',v_hire_date,
    'employee_country',v_country,
    'ended_at',v_end,
    'duration_minutes',v_duration,
    'status',v_status
  );
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
  v_type text := coalesce(nullif(btrim(p_record->>'incident_type'),''),'power_outage');
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
  from public.employee_connectivity_incidents incident
  where incident.id=v_id
  for update;
  if not found then raise exception 'connectivity_record_not_found'; end if;
  if not public.can_manage_employee(v_old.employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  if v_employee_no='' then raise exception 'employee_id_required'; end if;
  if v_date is null or v_start is null then raise exception 'incident_start_required'; end if;
  if v_type not in ('power_outage','internet_outage') then raise exception 'invalid_incident_type'; end if;
  if v_status not in ('reported','verified','resolved','rejected') then raise exception 'invalid_status'; end if;
  if v_details is not null and char_length(v_details)>3000 then raise exception 'details_too_long'; end if;
  if jsonb_typeof(v_attachments)<>'array' or jsonb_array_length(v_attachments)>3 then
    raise exception 'invalid_attachments';
  end if;

  select employee.id,employee.full_name
  into v_employee_id,v_full_name
  from public.employees employee
  where regexp_replace(upper(employee.employee_no),'[^A-Z0-9]','','g')=v_employee_no
  order by case when employee.status='active' then 0 else 1 end,
    employee.updated_at desc nulls last,employee.id
  limit 1;
  if v_employee_id is null then raise exception 'employee_not_found'; end if;
  if not public.can_manage_employee(v_employee_id) then raise exception 'employee_out_of_scope'; end if;

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
  ) then raise exception 'invalid_attachments'; end if;

  if v_end is null then
    v_duration:=null;
    if v_status='resolved' then v_status:='reported'; end if;
  else
    v_start_ts:=v_date+v_start;
    v_end_ts:=v_date+v_end;
    if v_end_ts<v_start_ts then v_end_ts:=v_end_ts+interval '1 day'; end if;
    v_duration:=ceil(extract(epoch from (v_end_ts-v_start_ts))/60.0)::integer;
    if v_status in ('reported','verified') then v_status:='resolved'; end if;
  end if;

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
    'ended_at',v_end,
    'duration_minutes',v_duration,
    'status',v_status,
    'attachments',v_new.attachments
  );
end;
$$;

revoke all on function employee_ops_private.admin_connectivity_create(jsonb)
  from public,anon,authenticated;
revoke all on function public.admin_connectivity_update(jsonb)
  from public,anon,authenticated;
grant execute on function public.admin_connectivity_update(jsonb)
  to authenticated;

comment on column public.employee_connectivity_incidents.ended_at is
  'Nullable while an outage is ongoing; completed later through the scoped edit RPC.';
comment on function public.admin_connectivity_update(jsonb) is
  'Updates an in-scope incident; a blank recovery time keeps it ongoing and a supplied recovery time calculates duration.';

notify pgrst,'reload schema';

commit;
