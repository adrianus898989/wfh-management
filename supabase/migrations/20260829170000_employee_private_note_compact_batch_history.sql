begin;

-- Keep bulk note writes append-only and replay-safe. The request key is not a
-- secret; it only prevents a browser retry from creating a second note for the
-- same employee.
alter table employee_private.employee_notes
  add column if not exists batch_request_key uuid;

create unique index if not exists employee_private_notes_batch_request_employee_uidx
  on employee_private.employee_notes(batch_request_key,employee_id)
  where batch_request_key is not null;

create index if not exists employee_private_note_revisions_employee_history_idx
  on employee_private.employee_note_revisions(employee_id,changed_at desc,id desc);

create or replace function public.admin_employee_private_note_history(
  p_employee_id uuid,
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,50),1),100);
  v_total bigint;
  v_rows jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not (
    public.has_permission('employee.private_note.manage') or
    public.has_permission('employee.private_note.view')
  ) then
    raise exception 'permission_denied';
  end if;
  if p_employee_id is null then raise exception 'employee_required'; end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  select count(*) into v_total
  from employee_private.employee_note_revisions revision
  where revision.employee_id=p_employee_id;

  select coalesce(
    jsonb_agg(to_jsonb(row_data) order by row_data.changed_at desc,row_data.id desc),
    '[]'::jsonb
  ) into v_rows
  from (
    select
      revision.id,revision.note_id,revision.version,revision.note_text,
      revision.category,revision.incident_date,revision.action,
      revision.changed_by_username,revision.changed_at,
      note.archived_at is not null as archived
    from employee_private.employee_note_revisions revision
    join employee_private.employee_notes note on note.id=revision.note_id
    where revision.employee_id=p_employee_id
    order by revision.changed_at desc,revision.id desc
    limit v_size offset (v_page-1)*v_size
  ) row_data;

  return jsonb_build_object(
    'rows',v_rows,'total',v_total,'page',v_page,'page_size',v_size,
    'pages',greatest(ceil(v_total::numeric/v_size)::integer,1)
  );
end;
$$;

create or replace function public.admin_employee_private_note_batch_create(
  p_employee_ids uuid[],
  p_request_key uuid,
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
  v_employee uuid;
  v_seen uuid[]:='{}'::uuid[];
  v_record employee_private.employee_notes%rowtype;
  v_existing employee_private.employee_notes%rowtype;
  v_results jsonb:='[]'::jsonb;
  v_failures jsonb:='[]'::jsonb;
  v_created integer:=0;
  v_replayed integer:=0;
  v_failed integer:=0;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('employee.private_note.manage') then
    raise exception 'permission_denied';
  end if;
  if p_request_key is null then raise exception 'private_note_request_key_required'; end if;
  if coalesce(cardinality(p_employee_ids),0) not between 1 and 50 then
    raise exception 'invalid_private_note_batch_size';
  end if;
  if char_length(v_note) not between 1 and 2000 then
    raise exception 'invalid_private_note';
  end if;
  if v_category not in ('general','identity','integrity','conduct','payment','other') then
    raise exception 'invalid_private_note_category';
  end if;

  v_actor:=employee_private.current_note_actor_username();

  foreach v_employee in array p_employee_ids loop
    if v_employee is null or v_employee=any(v_seen) then continue; end if;
    v_seen:=array_append(v_seen,v_employee);

    begin
      select * into v_existing
      from employee_private.employee_notes note
      where note.batch_request_key=p_request_key
        and note.employee_id=v_employee;

      if found then
        if v_existing.created_by<>v_user
          or v_existing.note_text<>v_note
          or v_existing.category<>v_category
          or v_existing.incident_date is distinct from p_incident_date
        then
          v_failed:=v_failed+1;
          v_failures:=v_failures||jsonb_build_array(jsonb_build_object(
            'employee_id',v_employee,'reason','request_key_payload_conflict'
          ));
        else
          v_replayed:=v_replayed+1;
          v_results:=v_results||jsonb_build_array(jsonb_build_object(
            'employee_id',v_employee,'note_id',v_existing.id,'status','idempotent_replay'
          ));
        end if;
        continue;
      end if;

      if not public.can_manage_employee(v_employee) then
        v_failed:=v_failed+1;
        v_failures:=v_failures||jsonb_build_array(jsonb_build_object(
          'employee_id',v_employee,'reason','employee_out_of_scope'
        ));
        continue;
      end if;

      insert into employee_private.employee_notes(
        employee_id,note_text,category,incident_date,batch_request_key,
        created_by,created_by_username,updated_by,updated_by_username
      ) values(
        v_employee,v_note,v_category,p_incident_date,p_request_key,
        v_user,v_actor,v_user,v_actor
      ) returning * into v_record;

      insert into employee_private.employee_note_revisions(
        note_id,employee_id,version,note_text,category,incident_date,
        action,changed_by,changed_by_username
      ) values(
        v_record.id,v_record.employee_id,v_record.version,v_record.note_text,
        v_record.category,v_record.incident_date,'create',v_user,v_actor
      );

      insert into public.audit_logs(
        actor_user_id,employee_id,module,action,record_id,new_data,reason
      ) values(
        v_user,v_employee,'employee_private_note','create_private_note',v_record.id::text,
        employee_private.note_audit_metadata(
          v_record.id,v_record.category,v_record.note_text,v_record.version,false
        )||jsonb_build_object('batch_request_key',p_request_key,'batch',true),
        '批量新增员工内部备注（审计不保存正文）'
      );

      v_created:=v_created+1;
      v_results:=v_results||jsonb_build_array(jsonb_build_object(
        'employee_id',v_employee,'note_id',v_record.id,'status','created'
      ));
    exception
      when unique_violation then
        -- A concurrent retry may win the unique key race. Treat an identical
        -- payload owned by the same actor as a successful replay.
        select * into v_existing
        from employee_private.employee_notes note
        where note.batch_request_key=p_request_key
          and note.employee_id=v_employee;
        if found
          and v_existing.created_by=v_user
          and v_existing.note_text=v_note
          and v_existing.category=v_category
          and v_existing.incident_date is not distinct from p_incident_date
        then
          v_replayed:=v_replayed+1;
          v_results:=v_results||jsonb_build_array(jsonb_build_object(
            'employee_id',v_employee,'note_id',v_existing.id,'status','idempotent_replay'
          ));
        else
          v_failed:=v_failed+1;
          v_failures:=v_failures||jsonb_build_array(jsonb_build_object(
            'employee_id',v_employee,'reason','request_key_payload_conflict'
          ));
        end if;
      when others then
        v_failed:=v_failed+1;
        v_failures:=v_failures||jsonb_build_array(jsonb_build_object(
          'employee_id',v_employee,'reason','save_failed'
        ));
    end;
  end loop;

  return jsonb_build_object(
    'ok',v_failed=0,
    'request_key',p_request_key,
    'created',v_created,
    'idempotent_replays',v_replayed,
    'failed',v_failed,
    'rows',v_results,
    'failures',v_failures
  );
end;
$$;

revoke all on function public.admin_employee_private_note_history(uuid,integer,integer),
  public.admin_employee_private_note_batch_create(uuid[],uuid,text,text,date)
  from public,anon,authenticated;

grant execute on function public.admin_employee_private_note_history(uuid,integer,integer),
  public.admin_employee_private_note_batch_create(uuid[],uuid,text,text,date)
  to authenticated;

comment on function public.admin_employee_private_note_history(uuid,integer,integer) is
  'Returns the complete private note revision timeline after current admin session, dedicated permission and employee-scope checks.';
comment on function public.admin_employee_private_note_batch_create(uuid[],uuid,text,text,date) is
  'Creates one append-only private note per scoped employee with per-item failures and request-key idempotency; existing notes are never overwritten.';

notify pgrst,'reload schema';

commit;
