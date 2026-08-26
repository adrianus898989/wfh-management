-- Local regression query. Run against a disposable database after all
-- migrations. It verifies the real Philippines nine-column / half-month
-- protocol and the public/private execution boundary.

begin;

do $$
declare
  v_source_count integer;
  v_source_month_count integer;
  v_private_definition text;
  v_ingest_definition text;
  v_admin_definition text;
  v_annual_private_definition text;
  v_annual_public_definition text;
  v_annual_source_count integer;
begin
  select count(*)::integer,count(distinct s.source_month)::integer
  into v_source_count,v_source_month_count
  from public.attendance_sheet_sources s
  where s.scope='adjustment'
    and s.is_active
    and s.metadata->>'sync_protocol'='adjustment-v1'
    and s.metadata->>'workbook_key'='home_ph'
    and s.source_month in ('2026-09','2026-10','2026-11','2026-12')
    and s.metadata->>'layout'='philippines'
    and s.metadata->>'sheet_schema'='philippines_9_columns_with_type';

  if v_source_count<>4 or v_source_month_count<>4 then
    raise exception 'expected one Philippines nine-column source per month, got % sources across % months',
      v_source_count,v_source_month_count;
  end if;

  with expected(
    source_key,source_month,spreadsheet_id,attendance_gid,adjustment_gid,leave_gid
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
  select count(*)::integer into v_annual_source_count
  from expected e
  join public.attendance_sheet_sources s on s.source_key=e.source_key
  where s.scope='mixed'
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
    and s.metadata#>>'{annual_sync,currency}'=case
      when e.source_key like 'home_ph_annual_%' then 'PHP'
      else 'USD'
    end
    and s.metadata#>>'{annual_sync,snapshot_mode}'='sparse_exceptions'
    and s.metadata#>>'{annual_sync,leave_sheet_gid}'=e.leave_gid
    and s.metadata#>>'{annual_sync,leave_tab}'='休假填表'
    and s.metadata#>>'{annual_sync,adjustment_tab}'='奖惩填表'
    and s.metadata#>>'{annual_sync,adjustment_tab_name}'='奖惩填表';
  if v_annual_source_count<>12 then
    raise exception 'expected 12 exact annual Sep-Dec source configurations, got %',
      v_annual_source_count;
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.admin_adjustment_upsert_without_category(jsonb)'::regprocedure
  ) into v_private_definition;

  if position('extract(day from v_event_date)<=15' in v_private_definition)=0
    or position('first_half' in v_private_definition)=0
    or position('second_half' in v_private_definition)=0
    or position('event_date_cannot_cross_source_slot' in v_private_definition)=0 then
    raise exception 'private adjustment writer lost PH half-month identity semantics';
  end if;
  if position('session_private.current_app_session_is_valid(''admin'')' in v_private_definition)=0
    or position('public.has_permission(''adjustment.create'')' in v_private_definition)=0
    or position('public.has_permission(''adjustment.approve'')' in v_private_definition)=0
    or position('public.can_manage_employee' in v_private_definition)=0
    or position('insert into public.audit_logs' in v_private_definition)=0 then
    raise exception 'authorization, employee scope, or audit semantics were removed';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.ingest_adjustment_sheet_inbound(jsonb)'::regprocedure
  ) into v_ingest_definition;

  if position('v_layoutin(''standard'',''philippines'')' in replace(lower(v_ingest_definition), ' ', ''))=0
    or position('public.ingest_adjustment_sheet_inbound_without_category(p_payload)' in lower(v_ingest_definition))=0
    or position('invalid_adjustment_category' in lower(v_ingest_definition))=0 then
    raise exception 'Google ingest no longer requires 类型 for both supported layouts';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.admin_adjustment_upsert(jsonb)'::regprocedure
  ) into v_admin_definition;

  if position('public.admin_adjustment_upsert_without_category(p_payload)' in lower(v_admin_definition))=0
    or position('v_workbookin(''onsite'',''home_vim'',''home_ph'')' in replace(lower(v_admin_definition), ' ', ''))=0
    or position('invalid_adjustment_category' in lower(v_admin_definition))=0 then
    raise exception 'public admin wrapper no longer requires/persists 类型';
  end if;

  if has_function_privilege('anon','public.admin_adjustment_upsert_without_category(jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.admin_adjustment_upsert_without_category(jsonb)','EXECUTE')
    or has_function_privilege('service_role','public.admin_adjustment_upsert_without_category(jsonb)','EXECUTE') then
    raise exception 'private admin adjustment writer is executable by an application role';
  end if;

  if has_function_privilege('anon','public.ingest_adjustment_sheet_inbound(jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.ingest_adjustment_sheet_inbound(jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.ingest_adjustment_sheet_inbound(jsonb)','EXECUTE') then
    raise exception 'Google ingest execution boundary is incorrect';
  end if;
  if has_function_privilege('anon','public.ingest_adjustment_sheet_inbound_without_category(jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.ingest_adjustment_sheet_inbound_without_category(jsonb)','EXECUTE')
    or has_function_privilege('service_role','public.ingest_adjustment_sheet_inbound_without_category(jsonb)','EXECUTE') then
    raise exception 'private Google ingest is executable by an application role';
  end if;

  if has_function_privilege('anon','public.admin_adjustment_upsert(jsonb)','EXECUTE')
    or has_function_privilege('service_role','public.admin_adjustment_upsert(jsonb)','EXECUTE')
    or not has_function_privilege('authenticated','public.admin_adjustment_upsert(jsonb)','EXECUTE') then
    raise exception 'public admin adjustment execution boundary is incorrect';
  end if;

  select pg_catalog.pg_get_functiondef(
    'attendance_private.ingest_annual_attendance_snapshot(jsonb)'::regprocedure
  ) into v_annual_private_definition;
  select pg_catalog.pg_get_functiondef(
    'public.ingest_annual_attendance_snapshot(jsonb)'::regprocedure
  ) into v_annual_public_definition;
  if position('''填表''' in v_annual_private_definition)>0
    or (
      (char_length(v_annual_private_definition)
        -char_length(replace(v_annual_private_definition,'''奖惩填表''','')))
      /char_length('''奖惩填表''')
    )<>12 then
    raise exception 'private annual allowlist does not contain exactly 12 live adjustment-tab names';
  end if;
  if position('jsonb_set' in lower(v_annual_public_definition))>0
    or position('v_adjustment_tab<>''奖惩填表''' in replace(v_annual_public_definition,' ',''))=0
    or position('attendance_private.ingest_annual_attendance_snapshot(p_payload)'
      in lower(v_annual_public_definition))=0 then
    raise exception 'public annual ingest still translates the live adjustment tab';
  end if;
  if has_function_privilege('anon','public.ingest_annual_attendance_snapshot(jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.ingest_annual_attendance_snapshot(jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.ingest_annual_attendance_snapshot(jsonb)','EXECUTE') then
    raise exception 'annual ingest execution boundary is incorrect';
  end if;
  if has_function_privilege('anon','attendance_private.ingest_annual_attendance_snapshot(jsonb)','EXECUTE')
    or has_function_privilege('authenticated','attendance_private.ingest_annual_attendance_snapshot(jsonb)','EXECUTE')
    or not has_function_privilege('service_role','attendance_private.ingest_annual_attendance_snapshot(jsonb)','EXECUTE') then
    raise exception 'private annual ingest execution boundary is incorrect';
  end if;

  if exists (
    select 1
    from public.employee_attendance_records r
    join public.attendance_sheet_sources s on s.id=r.source_id
    where r.kind='adjustment'
      and coalesce(r.raw_values->>'sync_protocol','')='adjustment-v1'
      and s.metadata->>'workbook_key'='home_ph'
      and s.source_month in ('2026-09','2026-10','2026-11','2026-12')
      and coalesce(r.raw_values->>'source_slot','') not in ('first_half','second_half')
  ) then
    raise exception 'a canonical PH adjustment uses an invalid source slot';
  end if;

  if exists (
    select 1
    from attendance_private.adjustment_sheet_outbox o
    join public.attendance_sheet_sources s on s.source_key=o.source_key
    where s.metadata->>'workbook_key'='home_ph'
      and s.source_month in ('2026-09','2026-10','2026-11','2026-12')
      and (
        o.source_slot not in ('first_half','second_half')
        or o.payload->>'source_slot' not in ('first_half','second_half')
        or o.payload->>'layout'<>'philippines'
        or nullif(btrim(o.payload->>'category'),'') is null
      )
  ) then
    raise exception 'a PH outbox row violates the nine-column protocol';
  end if;
end;
$$;

rollback;
