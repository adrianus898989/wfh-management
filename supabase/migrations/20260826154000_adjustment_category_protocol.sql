-- Preserve the explicit 奖惩「类型」 column end-to-end.  The original
-- adjustment-v1 functions remain as private implementation details so this
-- migration can safely wrap an already-applied production migration.

alter function attendance_private.enqueue_adjustment_sheet_outbox(uuid)
  rename to enqueue_adjustment_sheet_outbox_without_category;

create function attendance_private.enqueue_adjustment_sheet_outbox(
  p_record_id uuid
)
returns bigint
language plpgsql
security definer
set search_path=''
as $$
declare
  v_outbox_id bigint;
  v_category text;
begin
  v_outbox_id:=attendance_private.enqueue_adjustment_sheet_outbox_without_category(p_record_id);

  select nullif(btrim(r.reason),'') into v_category
  from public.employee_attendance_records r
  where r.id=p_record_id and r.kind='adjustment';

  update attendance_private.adjustment_sheet_outbox o
  set payload=o.payload||jsonb_build_object('category',v_category),
      updated_at=clock_timestamp()
  where o.id=v_outbox_id;

  return v_outbox_id;
end;
$$;

revoke all on function attendance_private.enqueue_adjustment_sheet_outbox_without_category(uuid)
  from public, anon, authenticated, service_role;
revoke all on function attendance_private.enqueue_adjustment_sheet_outbox(uuid)
  from public, anon, authenticated, service_role;

alter function public.ingest_adjustment_sheet_inbound(jsonb)
  rename to ingest_adjustment_sheet_inbound_without_category;

create function public.ingest_adjustment_sheet_inbound(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_result jsonb;
  v_source_key text:=btrim(coalesce(p_payload->>'source_key',''));
  v_layout text;
  v_row jsonb;
  v_external_id uuid;
  v_category text;
begin
  select s.metadata->>'layout' into v_layout
  from public.attendance_sheet_sources s
  where s.source_key=v_source_key
    and s.scope='adjustment'
    and s.is_active
    and s.metadata->>'sync_protocol'='adjustment-v1';
  if v_layout is null then raise exception 'source_not_allowlisted'; end if;

  -- Validate categories before invoking the v1 writer. A standard workbook
  -- with a missing/oversized type fails as one transaction and changes no row.
  for v_row in select value from jsonb_array_elements(coalesce(p_payload->'rows','[]'::jsonb))
  loop
    v_category:=btrim(coalesce(v_row->>'category',''));
    if char_length(v_category)>200
      or (v_layout='standard' and v_category='') then
      raise exception 'invalid_adjustment_category';
    end if;
  end loop;

  v_result:=public.ingest_adjustment_sheet_inbound_without_category(p_payload);

  -- v1 owns identity/revision/idempotency. Once it accepts a Google row, add
  -- the category to the same canonical record so UI display and text search use
  -- employee_attendance_records.reason rather than the free-form note.
  for v_row in select value from jsonb_array_elements(p_payload->'rows')
  loop
    v_category:=nullif(btrim(coalesce(v_row->>'category','')),'');
    if v_category is null then continue; end if;
    begin
      v_external_id:=(v_row->>'external_id')::uuid;
    exception when others then
      raise exception 'invalid_inbound_row';
    end;
    update public.employee_attendance_records r
    set reason=v_category,
        raw_values=coalesce(r.raw_values,'{}'::jsonb)||jsonb_build_object(
          'category',v_category,
          'raw_type',v_category
        ),
        content_hash=md5(concat_ws('|',r.external_id::text,r.sync_revision::text,
          coalesce(r.raw_values->>'source_slot',''),r.event_date::text,
          r.employee_no_raw,r.employee_name_raw,r.amount::text,v_category,r.note)),
        updated_at=clock_timestamp()
    where r.external_id=v_external_id
      and r.source_id=(
        select s.id from public.attendance_sheet_sources s
        where s.source_key=v_source_key and s.scope='adjustment' and s.is_active
      )
      and r.kind='adjustment'
      -- The v1 writer deliberately ignores stale Google revisions.  The
      -- category wrapper must follow the same decision or an old retry could
      -- overwrite the type belonging to a newer canonical revision.
      and r.sync_revision=(v_row->>'revision')::bigint;
  end loop;

  return v_result;
end;
$$;

revoke all on function public.ingest_adjustment_sheet_inbound_without_category(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ingest_adjustment_sheet_inbound(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_adjustment_sheet_inbound(jsonb)
  to service_role;

comment on function public.ingest_adjustment_sheet_inbound(jsonb) is
  'Applies Google adjustment edits and persists the explicit 类型 field in reason/raw_values for display and search.';

-- Admin-created records use the same explicit category contract.  Keep the
-- already-deployed editor implementation private and wrap it so this patch is
-- small, preserves its permission/scope checks, and still updates the queued
-- Google payload in the same transaction.
alter function public.admin_adjustment_upsert(jsonb)
  rename to admin_adjustment_upsert_without_category;

create function public.admin_adjustment_upsert(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_result jsonb;
  v_workbook text:=lower(btrim(coalesce(p_payload->>'workbook_key','')));
  v_category text:=btrim(coalesce(p_payload->>'category',p_payload->>'type',''));
  v_record_id uuid;
  v_outbox_id bigint;
begin
  -- The current Philippines workbook has no independent 类型 column.  Ignore
  -- a forged/stale client value so Supabase never claims a type that cannot
  -- round-trip to that sheet.
  if v_workbook='home_ph' then v_category:=''; end if;
  if char_length(v_category)>200
    or (v_workbook in ('onsite','home_vim') and v_category='') then
    raise exception 'invalid_adjustment_category';
  end if;

  v_result:=public.admin_adjustment_upsert_without_category(p_payload);
  v_record_id:=(v_result->>'id')::uuid;
  v_outbox_id:=(v_result->>'outbox_id')::bigint;

  if v_category<>'' then
    update public.employee_attendance_records r
    set reason=v_category,
        raw_values=coalesce(r.raw_values,'{}'::jsonb)||jsonb_build_object(
          'category',v_category,
          'raw_type',v_category
        ),
        content_hash=md5(concat_ws('|',r.external_id::text,r.sync_revision::text,
          coalesce(r.raw_values->>'source_slot',''),r.event_date::text,
          r.employee_no_raw,r.employee_name_raw,r.amount::text,v_category,r.note)),
        updated_at=clock_timestamp()
    where r.id=v_record_id and r.kind='adjustment';

    update attendance_private.adjustment_sheet_outbox o
    set payload=o.payload||jsonb_build_object('category',v_category),
        updated_at=clock_timestamp()
    where o.id=v_outbox_id and o.adjustment_record_id=v_record_id;

    update public.audit_logs audit
    set new_data=coalesce(audit.new_data,'{}'::jsonb)
          ||jsonb_build_object(
            'reason',v_category,
            'raw_values',coalesce(audit.new_data->'raw_values','{}'::jsonb)
              ||jsonb_build_object('category',v_category,'raw_type',v_category)
          )
    where audit.id=(
      select latest.id
      from public.audit_logs latest
      where latest.record_id=v_record_id::text
        and latest.module='attendance_adjustment'
        and latest.actor_user_id=(select auth.uid())
      order by latest.created_at desc,latest.id desc
      limit 1
    );
  end if;

  return v_result||jsonb_build_object('category',nullif(v_category,''));
end;
$$;

revoke all on function public.admin_adjustment_upsert_without_category(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_adjustment_upsert(jsonb)
  from public, anon, service_role;
grant execute on function public.admin_adjustment_upsert(jsonb)
  to authenticated;

comment on function public.admin_adjustment_upsert(jsonb) is
  'Creates or edits a managed adjustment while preserving 类型 separately from the free-form 备注/原因 and updating the Google outbox atomically.';

notify pgrst,'reload schema';
