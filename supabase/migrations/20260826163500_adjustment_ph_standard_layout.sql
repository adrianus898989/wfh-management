-- The Philippines adjustment workbook now uses the same seven-column month
-- blocks as the onsite and VIM workbooks:
-- 姓名 / ID / 奖金 / 扣除 / 类型 / 备注 / 日期.
--
-- The first version of adjustment-v1 modelled that workbook as two half-month
-- slots.  Correct the allowlisted route and the private admin writer without
-- changing the category wrapper or weakening any permission/scope checks.

do $$
declare
  v_source_count integer;
begin
  select count(*)::integer into v_source_count
  from public.attendance_sheet_sources s
  where s.scope='adjustment'
    and s.is_active
    and s.metadata->>'sync_protocol'='adjustment-v1'
    and s.metadata->>'workbook_key'='home_ph'
    and s.source_month in ('2026-09','2026-10','2026-11','2026-12');

  if v_source_count<>4 then
    raise exception 'expected_four_ph_adjustment_sources_found_%',v_source_count;
  end if;

  if to_regprocedure('public.admin_adjustment_upsert_without_category(jsonb)') is null then
    raise exception 'adjustment_category_wrapper_not_installed';
  end if;
end;
$$;

update public.attendance_sheet_sources s
set metadata=jsonb_set(coalesce(s.metadata,'{}'::jsonb),'{layout}','"standard"'::jsonb,true),
    updated_at=clock_timestamp()
where s.scope='adjustment'
  and s.is_active
  and s.metadata->>'sync_protocol'='adjustment-v1'
  and s.metadata->>'workbook_key'='home_ph'
  and s.source_month in ('2026-09','2026-10','2026-11','2026-12');

-- Normalize any canonical records produced before this correction.  Without
-- this, a later Google edit using the new primary slot would be rejected as an
-- external_id_source_slot_mismatch.
update public.employee_attendance_records r
set raw_values=coalesce(r.raw_values,'{}'::jsonb)
      ||jsonb_build_object('source_slot','primary'),
    content_hash=md5(concat_ws('|',r.external_id::text,r.sync_revision::text,
      'primary',r.event_date::text,r.employee_no_raw,r.employee_name_raw,
      r.amount::text,nullif(btrim(r.reason),''),r.note)),
    updated_at=clock_timestamp()
from public.attendance_sheet_sources s
where r.source_id=s.id
  and r.kind='adjustment'
  and coalesce(r.raw_values->>'sync_protocol','')='adjustment-v1'
  and coalesce(r.raw_values->>'source_slot','')<>'primary'
  and s.scope='adjustment'
  and s.metadata->>'sync_protocol'='adjustment-v1'
  and s.metadata->>'workbook_key'='home_ph'
  and s.source_month in ('2026-09','2026-10','2026-11','2026-12');

-- Only actionable queue rows are rewritten.  Delivered and superseded rows
-- remain immutable history; pending/failed/in-flight rows are safely requeued
-- with the corrected slot and layout.
update attendance_private.adjustment_sheet_outbox o
set source_slot='primary',
    payload=coalesce(o.payload,'{}'::jsonb)
      ||jsonb_build_object('source_slot','primary','layout','standard'),
    state='pending',
    available_at=clock_timestamp(),
    locked_by=null,
    locked_until=null,
    last_error=null,
    updated_at=clock_timestamp()
where o.source_key in (
  select s.source_key
  from public.attendance_sheet_sources s
  where s.scope='adjustment'
    and s.metadata->>'sync_protocol'='adjustment-v1'
    and s.metadata->>'workbook_key'='home_ph'
    and s.source_month in ('2026-09','2026-10','2026-11','2026-12')
)
and o.state in ('pending','processing','failed');

create or replace function public.admin_adjustment_upsert_without_category(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_id uuid;
  v_employee public.employees%rowtype;
  v_employee_no text := upper(btrim(coalesce(p_payload->>'employee_no','')));
  v_workbook text := lower(btrim(coalesce(p_payload->>'workbook_key','')));
  v_month text := btrim(coalesce(p_payload->>'source_month',''));
  v_currency text := upper(btrim(coalesce(p_payload->>'currency','')));
  v_event_date date;
  v_amount numeric;
  v_note text := btrim(coalesce(p_payload->>'note',''));
  v_source_id uuid;
  v_source_key text;
  v_expected_currency text;
  v_external_id uuid;
  v_revision bigint;
  v_expected_revision bigint;
  v_employee_count integer := 0;
  v_source_slot text := 'primary';
  v_outbox_id bigint;
  v_record_id uuid;
  v_record public.employee_attendance_records%rowtype;
  v_old_json jsonb;
  v_raw jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'invalid_payload';
  end if;

  if nullif(btrim(coalesce(p_payload->>'id','')),'') is not null then
    begin v_id:=(p_payload->>'id')::uuid;
    exception when invalid_text_representation then raise exception 'invalid_record_id'; end;
    begin v_expected_revision:=(p_payload->>'expected_revision')::bigint;
    exception when others then raise exception 'invalid_expected_revision'; end;
    if v_expected_revision is null or v_expected_revision<1 then
      raise exception 'invalid_expected_revision';
    end if;
  end if;
  if v_id is null and not public.has_permission('adjustment.create') then
    raise exception 'permission_denied';
  end if;
  if v_id is not null and not public.has_permission('adjustment.approve') then
    raise exception 'permission_denied';
  end if;

  if v_workbook not in ('onsite','home_vim','home_ph') then
    raise exception 'invalid_workbook';
  end if;
  if v_month not in ('2026-09','2026-10','2026-11','2026-12') then
    raise exception 'invalid_source_month';
  end if;
  begin v_event_date:=(p_payload->>'event_date')::date;
  exception when others then raise exception 'invalid_event_date'; end;
  if to_char(v_event_date,'YYYY-MM')<>v_month then
    raise exception 'event_date_outside_source_month';
  end if;
  begin v_amount:=round((p_payload->>'amount')::numeric,2);
  exception when others then raise exception 'invalid_amount'; end;
  if v_amount=0 or abs(v_amount)>100000000 then raise exception 'invalid_amount'; end if;
  if v_note='' then raise exception 'note_required'; end if;
  if char_length(v_note)>4000 then raise exception 'note_too_long'; end if;
  if v_employee_no='' then raise exception 'employee_no_required'; end if;

  select count(*)::integer into v_employee_count
  from public.employees e
  where upper(btrim(e.employee_no))=v_employee_no;
  if v_employee_count=0 then raise exception 'employee_not_found'; end if;
  if v_employee_count>1 then raise exception 'canonical_employee_id_ambiguous'; end if;
  select e.* into strict v_employee
  from public.employees e
  where upper(btrim(e.employee_no))=v_employee_no;
  if not public.can_manage_employee(v_employee.id) then
    raise exception 'employee_out_of_scope';
  end if;

  select r.source_id,r.source_key,r.currency
  into v_source_id,v_source_key,v_expected_currency
  from attendance_private.adjustment_route(v_workbook,v_month) r;
  if v_source_id is null then raise exception 'adjustment_route_not_found'; end if;
  if v_currency='' or v_currency<>v_expected_currency then
    raise exception 'currency_does_not_match_workbook';
  end if;

  if v_id is null then
    v_external_id:=gen_random_uuid();
    v_revision:=1;
    v_raw:=jsonb_build_object(
      'sync_protocol','adjustment-v1','external_id',v_external_id,
      'origin','admin','revision',v_revision,'google_sync_state','pending',
      'workbook_key',v_workbook,'source_key',v_source_key,
      'source_month',v_month,'source_slot',v_source_slot,'currency',v_currency
    );
    insert into public.employee_attendance_records(
      source_id,source_block,source_row,source_item_key,kind,event_date,event_kind,
      reason,note,amount,raw_amount,currency,employee_id,employee_no_raw,
      employee_name_raw,employee_status_raw,team_name_raw,position_name_raw,
      country_raw,platform_raw,manager_raw,match_status,match_method,matched_at,
      raw_values,content_hash,is_mirror,source_updated_at,synced_at,
      external_id,sync_origin,sync_revision,created_by,updated_by
    ) values(
      v_source_id,'adjustment',
      nextval('attendance_private.adjustment_managed_source_row_seq')::integer,
      v_external_id::text,'adjustment',v_event_date,
      case when v_amount>0 then 'bonus' else 'deduction' end,
      case when v_amount>0 then '后台录入奖金' else '后台录入扣款' end,
      v_note,v_amount,v_amount::text,v_currency,v_employee.id,v_employee.employee_no,
      v_employee.full_name,v_employee.status,null,null,
      coalesce(nullif(btrim(v_employee.country),''),nullif(btrim(v_employee.nationality),'')),
      v_employee.platform_scope,
      nullif(concat_ws(' / ',nullif(btrim(v_employee.person_in_charge),''),
        nullif(btrim(v_employee.leader_name),''),nullif(btrim(v_employee.online_leader),''),
        nullif(btrim(v_employee.online_trainer),''),nullif(btrim(v_employee.on_site_trainer),''),
        nullif(btrim(v_employee.trainer_name),'')),''),
      'matched','employee_id_exact',clock_timestamp(),v_raw,
      md5(concat_ws('|',v_external_id::text,v_revision::text,v_source_slot,v_event_date::text,
        v_employee.employee_no,v_amount::text,v_note)),false,clock_timestamp(),clock_timestamp(),
      v_external_id,'admin',v_revision,v_user,v_user
    ) returning * into v_record;
  else
    select * into v_record
    from public.employee_attendance_records r
    where r.id=v_id and r.kind='adjustment'
    for update;
    if not found then raise exception 'adjustment_not_found'; end if;
    if v_record.sync_revision<>v_expected_revision then
      raise exception 'adjustment_revision_conflict';
    end if;
    if not public.can_manage_employee(v_record.employee_id) then
      raise exception 'employee_out_of_scope';
    end if;
    if v_record.external_id is null
      or coalesce(v_record.raw_values->>'sync_protocol','')<>'adjustment-v1' then
      raise exception 'adjustment_not_editable';
    end if;
    if v_record.source_id<>v_source_id then
      raise exception 'workbook_and_month_cannot_change';
    end if;

    v_old_json:=to_jsonb(v_record);
    v_external_id:=v_record.external_id;
    v_revision:=greatest(v_record.sync_revision,0)+1;
    v_raw:=coalesce(v_record.raw_values,'{}'::jsonb)||jsonb_build_object(
      'sync_protocol','adjustment-v1','external_id',v_external_id,
      'origin','admin','revision',v_revision,'google_sync_state','pending',
      'workbook_key',v_workbook,'source_key',v_source_key,
      'source_month',v_month,'source_slot',v_source_slot,'currency',v_currency
    );
    update public.employee_attendance_records r
    set event_date=v_event_date,
        event_kind=case when v_amount>0 then 'bonus' else 'deduction' end,
        reason=case when v_amount>0 then '后台录入奖金' else '后台录入扣款' end,
        note=v_note,amount=v_amount,raw_amount=v_amount::text,currency=v_currency,
        employee_id=v_employee.id,employee_no_raw=v_employee.employee_no,
        employee_name_raw=v_employee.full_name,employee_status_raw=v_employee.status,
        country_raw=coalesce(nullif(btrim(v_employee.country),''),nullif(btrim(v_employee.nationality),'')),
        platform_raw=v_employee.platform_scope,match_status='matched',
        match_method='employee_id_exact',matched_at=clock_timestamp(),raw_values=v_raw,
        content_hash=md5(concat_ws('|',v_external_id::text,v_revision::text,v_source_slot,
          v_event_date::text,v_employee.employee_no,v_amount::text,v_note)),
        source_updated_at=clock_timestamp(),synced_at=clock_timestamp(),
        sync_origin='admin',sync_revision=v_revision,updated_by=v_user,updated_at=clock_timestamp()
    where r.id=v_record.id
    returning * into v_record;
  end if;

  -- The legacy currency trigger derives currency from employee geography. This
  -- protocol's contract is stricter: the selected workbook is authoritative.
  v_record_id:=v_record.id;
  update public.employee_attendance_records
  set currency=v_expected_currency
  where id=v_record_id and currency is distinct from v_expected_currency;
  select * into strict v_record
  from public.employee_attendance_records
  where id=v_record_id;

  v_outbox_id:=attendance_private.enqueue_adjustment_sheet_outbox(v_record.id);
  update public.attendance_sheet_sources
  set status='pending',error_message=null,updated_at=clock_timestamp(),
      metadata=metadata||jsonb_build_object('google_sync_state','pending')
  where id=v_source_id;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
  ) values(
    v_user,v_employee.id,'attendance_adjustment',
    case when v_id is null then 'create_adjustment' else 'update_adjustment' end,
    v_record.id::text,v_old_json,to_jsonb(v_record),
    case when v_id is null then '后台新增奖金 / 扣款并进入 Google 同步队列'
      else '后台编辑奖金 / 扣款并进入 Google 同步队列' end
  );

  return jsonb_build_object(
    'ok',true,'database_saved',true,'id',v_record.id,
    'external_id',v_record.external_id,'revision',v_record.sync_revision,
    'source_slot',v_source_slot,
    'event_kind',v_record.event_kind,'signed_amount',v_record.amount,
    'currency',v_record.currency,'sync_state','pending','outbox_id',v_outbox_id
  );
end;
$$;

revoke all on function public.admin_adjustment_upsert_without_category(jsonb)
  from public, anon, authenticated, service_role;

comment on function public.admin_adjustment_upsert_without_category(jsonb) is
  'Private adjustment-v1 admin writer. All allowlisted workbooks use the standard seven-column layout and primary source slot; called only by the category-preserving public wrapper.';

notify pgrst,'reload schema';
