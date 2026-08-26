-- Restore the real Philippines adjustment layout after
-- 20260826163500_adjustment_ph_standard_layout.sql incorrectly modelled it as
-- the seven-column standard sheet.  The real repeating block is:
-- 姓名 / ID / 金额1-15 / 类型 / 金额16-末 / 类型 / 备注1-15 / 备注16-末 / 日期.
--
-- This correction intentionally has no data-conversion path.  It fails closed
-- unless all four allowlisted PH routes exist and neither canonical PH rows nor
-- PH outbox rows have been produced under the incorrect protocol.

set lock_timeout = '5s';
set statement_timeout = '60s';

lock table public.attendance_sheet_sources in share row exclusive mode;
lock table public.employee_attendance_records in share row exclusive mode;
lock table attendance_private.adjustment_sheet_outbox in share row exclusive mode;

do $$
declare
  v_source_count integer;
  v_source_month_count integer;
  v_record_count integer;
  v_outbox_count integer;
begin
  select count(*)::integer,count(distinct s.source_month)::integer
  into v_source_count,v_source_month_count
  from public.attendance_sheet_sources s
  where s.scope='adjustment'
    and s.is_active
    and s.metadata->>'sync_protocol'='adjustment-v1'
    and s.metadata->>'workbook_key'='home_ph'
    and s.source_month in ('2026-09','2026-10','2026-11','2026-12');

  if v_source_count<>4 or v_source_month_count<>4 then
    raise exception 'ph_adjustment_restore_expected_one_source_per_month_found_%_sources_%_months',
      v_source_count,v_source_month_count;
  end if;

  if to_regprocedure('public.admin_adjustment_upsert_without_category(jsonb)') is null
    or to_regprocedure('public.admin_adjustment_upsert(jsonb)') is null
    or to_regprocedure('public.ingest_adjustment_sheet_inbound_without_category(jsonb)') is null
    or to_regprocedure('public.ingest_adjustment_sheet_inbound(jsonb)') is null then
    raise exception 'ph_adjustment_restore_expected_category_protocol_functions';
  end if;

  select count(*)::integer into v_record_count
  from public.employee_attendance_records r
  join public.attendance_sheet_sources s on s.id=r.source_id
  where r.kind='adjustment'
    and coalesce(r.raw_values->>'sync_protocol','')='adjustment-v1'
    and s.scope='adjustment'
    and s.metadata->>'sync_protocol'='adjustment-v1'
    and s.metadata->>'workbook_key'='home_ph'
    and s.source_month in ('2026-09','2026-10','2026-11','2026-12');

  if v_record_count<>0 then
    raise exception 'ph_adjustment_restore_requires_zero_managed_rows_found_%',v_record_count;
  end if;

  select count(*)::integer into v_outbox_count
  from attendance_private.adjustment_sheet_outbox o
  where o.source_key in (
    select s.source_key
    from public.attendance_sheet_sources s
    where s.scope='adjustment'
      and s.is_active
      and s.metadata->>'sync_protocol'='adjustment-v1'
      and s.metadata->>'workbook_key'='home_ph'
      and s.source_month in ('2026-09','2026-10','2026-11','2026-12')
  );

  if v_outbox_count<>0 then
    raise exception 'ph_adjustment_restore_requires_zero_outbox_rows_found_%',v_outbox_count;
  end if;
end;
$$;

update public.attendance_sheet_sources s
set metadata=coalesce(s.metadata,'{}'::jsonb)||jsonb_build_object(
      'layout','philippines',
      'sheet_schema','philippines_9_columns_with_type'
    ),
    updated_at=clock_timestamp()
where s.scope='adjustment'
  and s.is_active
  and s.metadata->>'sync_protocol'='adjustment-v1'
  and s.metadata->>'workbook_key'='home_ph'
  and s.source_month in ('2026-09','2026-10','2026-11','2026-12');

-- The annual snapshot boundary must agree with the live workbook names too.
-- Verify every one of the three workbooks' Sep-Dec routes before changing the
-- legacy private allowlist, then make the actual 奖惩填表 name canonical.
do $$
declare
  v_configured_count integer;
begin
  with expected(
    source_key,source_month,spreadsheet_id,attendance_gid,
    adjustment_gid,leave_gid
  ) as (values
    ('onsite_annual_2026_09','2026-09','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','605098048','1011694934','868595464'),
    ('onsite_annual_2026_10','2026-10','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','938715589','1011694934','868595464'),
    ('onsite_annual_2026_11','2026-11','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','200094426','1011694934','868595464'),
    ('onsite_annual_2026_12','2026-12','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','462628124','1011694934','868595464'),
    ('home_vimm_annual_2026_09','2026-09','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','515895997','3368572','1582220550'),
    ('home_vimm_annual_2026_10','2026-10','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','2006236394','3368572','1582220550'),
    ('home_vimm_annual_2026_11','2026-11','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','465666790','3368572','1582220550'),
    ('home_vimm_annual_2026_12','2026-12','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','527622305','3368572','1582220550'),
    ('home_ph_annual_2026_09','2026-09','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','1827489324','687407921','1880767097'),
    ('home_ph_annual_2026_10','2026-10','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','296363311','687407921','1880767097'),
    ('home_ph_annual_2026_11','2026-11','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','138573169','687407921','1880767097'),
    ('home_ph_annual_2026_12','2026-12','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','787543818','687407921','1880767097')
  )
  select count(*)::integer into v_configured_count
  from expected e
  join public.attendance_sheet_sources s
    on s.source_key=e.source_key
   and s.scope='mixed'
   and s.is_active
   and s.source_month=e.source_month
   and s.sheet_id=e.spreadsheet_id
   and s.sheet_gid=e.attendance_gid
   and s.source_group=case
     when e.source_key like 'onsite_annual_%' then 'onsite_to_home'
     else 'home'
   end
   and s.metadata#>>'{annual_sync,contract}'='annual_v1'
   and s.metadata#>>'{annual_sync,attendance_tab}'=
     ltrim(split_part(e.source_month,'-',2),'0')||'月'
   and s.metadata#>>'{annual_sync,adjustment_sheet_gid}'=e.adjustment_gid
   and s.metadata#>>'{annual_sync,adjustment_tab}'='奖惩填表'
   and s.metadata#>>'{annual_sync,currency}'=case
     when e.source_key like 'home_ph_annual_%' then 'PHP'
     else 'USD'
   end
   and s.metadata#>>'{annual_sync,snapshot_mode}'='sparse_exceptions'
   and s.metadata#>>'{annual_sync,leave_sheet_gid}'=e.leave_gid
   and s.metadata#>>'{annual_sync,leave_tab}'='休假填表';

  if v_configured_count<>12 then
    raise exception 'annual_sep_dec_restore_expected_12_exact_routes_found_%',
      v_configured_count;
  end if;
end;
$$;

update public.attendance_sheet_sources s
set metadata=jsonb_set(
      jsonb_set(
        coalesce(s.metadata,'{}'::jsonb),
        '{annual_sync,adjustment_tab}',to_jsonb('奖惩填表'::text),true
      ),
      '{annual_sync,adjustment_tab_name}',to_jsonb('奖惩填表'::text),true
    ),
    updated_at=clock_timestamp()
where s.source_key in (
  'onsite_annual_2026_09','onsite_annual_2026_10',
  'onsite_annual_2026_11','onsite_annual_2026_12',
  'home_vimm_annual_2026_09','home_vimm_annual_2026_10',
  'home_vimm_annual_2026_11','home_vimm_annual_2026_12',
  'home_ph_annual_2026_09','home_ph_annual_2026_10',
  'home_ph_annual_2026_11','home_ph_annual_2026_12'
);

-- Restore the original, trusted half-month identity semantics while retaining
-- all existing authentication, permission, employee-scope, audit, and
-- optimistic-revision checks.  The public wrapper below still owns 类型.
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
  v_source_slot text;
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
  v_source_slot:=case
    when v_workbook='home_ph' and extract(day from v_event_date)<=15 then 'first_half'
    when v_workbook='home_ph' then 'second_half'
    else 'primary'
  end;

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
    v_source_slot:=lower(btrim(coalesce(v_record.raw_values->>'source_slot','')));
    if v_source_slot='' then
      v_source_slot:=case
        when v_workbook='home_ph' and extract(day from v_record.event_date)<=15 then 'first_half'
        when v_workbook='home_ph' then 'second_half'
        else 'primary'
      end;
    end if;
    if (v_workbook='home_ph' and v_source_slot not in ('first_half','second_half'))
      or (v_workbook<>'home_ph' and v_source_slot<>'primary') then
      raise exception 'invalid_source_slot';
    end if;
    if v_workbook='home_ph' and (
      (v_source_slot='first_half' and extract(day from v_event_date)>15)
      or (v_source_slot='second_half' and extract(day from v_event_date)<=15)
    ) then
      raise exception 'event_date_cannot_cross_source_slot';
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

  -- The selected workbook, not employee geography, is authoritative currency.
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

-- Require the explicit 类型 in both the standard seven-column layout and the
-- real Philippines nine-column layout before the legacy identity writer runs.
create or replace function public.ingest_adjustment_sheet_inbound(p_payload jsonb)
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

  for v_row in select value
    from jsonb_array_elements(coalesce(p_payload->'rows','[]'::jsonb))
  loop
    v_category:=btrim(coalesce(v_row->>'category',''));
    if char_length(v_category)>200
      or (v_layout in ('standard','philippines') and v_category='') then
      raise exception 'invalid_adjustment_category';
    end if;
  end loop;

  v_result:=public.ingest_adjustment_sheet_inbound_without_category(p_payload);

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
  'Applies Google adjustment edits and requires/persists 类型 for standard and Philippines layouts.';

-- Reinstall the public admin category wrapper as well.  This makes the forward
-- correction independent from whether the already-applied 154000 migration
-- contained the temporary PH no-category exception.
create or replace function public.admin_adjustment_upsert(p_payload jsonb)
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
  if char_length(v_category)>200
    or (v_workbook in ('onsite','home_vim','home_ph') and v_category='') then
    raise exception 'invalid_adjustment_category';
  end if;

  v_result:=public.admin_adjustment_upsert_without_category(p_payload);
  v_record_id:=(v_result->>'id')::uuid;
  v_outbox_id:=(v_result->>'outbox_id')::bigint;

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

  return v_result||jsonb_build_object('category',v_category);
end;
$$;

revoke all on function public.admin_adjustment_upsert(jsonb)
  from public, anon, service_role;
grant execute on function public.admin_adjustment_upsert(jsonb)
  to authenticated;

comment on function public.admin_adjustment_upsert(jsonb) is
  'Creates or edits a managed adjustment with required 类型 and the workbook-specific source slot.';

-- Replace only the twelve allowlisted legacy tab literals in the already
-- deployed, trusted private annual ingester.  Refuse an unknown function body
-- instead of broadly replacing text in a changed implementation.
do $$
declare
  v_definition text;
  v_legacy_tab_count integer;
begin
  select pg_catalog.pg_get_functiondef(
    'attendance_private.ingest_annual_attendance_snapshot(jsonb)'::regprocedure
  ) into v_definition;

  v_legacy_tab_count :=
    (char_length(v_definition)-char_length(replace(v_definition,'''填表''','')))
    /char_length('''填表''');
  if v_legacy_tab_count<>12 then
    raise exception 'annual_adjustment_allowlist_expected_12_legacy_tabs_found_%',
      v_legacy_tab_count;
  end if;

  execute replace(v_definition,'''填表''','''奖惩填表''');
end;
$$;

revoke all on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  from public,anon,authenticated;
grant execute on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  to service_role;

-- Keep the live leave-tab validation from 154500, but stop rewriting the real
-- adjustment tab name back to the obsolete placeholder before private ingest.
create or replace function public.ingest_annual_attendance_snapshot(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_source_key text:=btrim(coalesce(p_payload#>>'{source,source_key}',''));
  v_leave_gid text:=btrim(coalesce(p_payload#>>'{source,leave_sheet_gid}',''));
  v_leave_tab text:=btrim(coalesce(p_payload#>>'{source,leave_tab_name}',''));
  v_adjustment_tab text:=btrim(coalesce(p_payload#>>'{source,adjustment_tab_name}',''));
  v_expected_leave_gid text;
begin
  v_expected_leave_gid:=case
    when v_source_key like 'onsite_annual_2026_%' then '868595464'
    when v_source_key like 'home_vimm_annual_2026_%' then '1582220550'
    when v_source_key like 'home_ph_annual_2026_%' then '1880767097'
  end;
  if v_expected_leave_gid is null
    or v_leave_gid<>v_expected_leave_gid
    or v_leave_tab<>'休假填表'
    or v_adjustment_tab<>'奖惩填表' then
    raise exception 'source_not_configured';
  end if;

  return attendance_private.ingest_annual_attendance_snapshot(p_payload);
end;
$$;

revoke all on function public.ingest_annual_attendance_snapshot(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_annual_attendance_snapshot(jsonb)
  to service_role;

comment on function public.ingest_annual_attendance_snapshot(jsonb) is
  'Service-role annual ingest boundary using the live 休假填表 and 奖惩填表 names for all 12 Sep-Dec routes.';

notify pgrst,'reload schema';
