-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

do $contract$
declare
  v_signature regprocedure :=
    'alerts_private.refresh_alert_group(text)'::regprocedure;
  v_definition text;
  v_security_definer boolean;
  v_config text[];
begin
  select pg_catalog.pg_get_functiondef(v_signature),
    procedure.prosecdef,
    procedure.proconfig
  into v_definition, v_security_definer, v_config
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature;

  if not coalesce(v_security_definer, false)
     or not coalesce('statement_timeout=6s' = any(v_config), false)
     or not coalesce('lock_timeout=500ms' = any(v_config), false)
     or position(
       'pg_catalog.hashtextextended(''alerts_private.refresh_alerts'', 0)'
       in v_definition
     ) = 0
     or position('alerts_private.enrich_attendance_alert_details()' in v_definition) = 0
     or position('where classified.occurrence_count > classified.allowed_days' in v_definition) = 0
     or position('error_frequency_candidates' in v_definition) > 0 then
    raise exception 'monthly_leave_routing_contract_missing';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated', v_signature, 'execute'
     ) then
    raise exception 'authenticated_can_execute_private_alert_refresh';
  end if;
end;
$contract$;

insert into public.employees (
  id, employee_no, full_name, status, employment_type, country
) values
  ('00000000-0000-4000-8000-000000005301', 'TEST-ML-ONSITE-25', 'Monthly onsite 2.5', 'active', '现场转居家', '菲律宾'),
  ('00000000-0000-4000-8000-000000005302', 'TEST-ML-ONSITE-20', 'Monthly onsite 2.0', 'active', '现场转居家', '越南'),
  ('00000000-0000-4000-8000-000000005303', 'TEST-ML-HOME-45', 'Monthly home 4.5', 'active', '纯居家菲律宾', '越南'),
  ('00000000-0000-4000-8000-000000005304', 'TEST-ML-HOME-40', 'Monthly home 4.0', 'active', '纯居家（越南/缅甸/印尼等）', '菲律宾'),
  ('00000000-0000-4000-8000-000000005305', 'TEST-ML-CONFLICT', 'Monthly source conflict', 'active', '纯居家菲律宾', '菲律宾'),
  ('00000000-0000-4000-8000-000000005306', 'TEST-ML-MIXED', 'Monthly mixed source', 'active', '现场转居家', '菲律宾'),
  ('00000000-0000-4000-8000-000000005307', 'TEST-ML-UNKNOWN', 'Monthly unknown source', 'active', '现场人员', '菲律宾'),
  ('00000000-0000-4000-8000-000000005308', 'TEST-ML-HOME-LEAVE', 'Monthly home leave excluded', 'active', '现场转居家', '菲律宾');

insert into public.attendance_sheet_sources (
  id, source_key, source_name, scope, source_group, source_month,
  status, is_active
) values
  (
    '00000000-0000-4000-8000-000000005311',
    'test_monthly_leave_onsite', 'SQL monthly onsite source',
    'attendance', 'onsite_to_home',
    pg_catalog.to_char(
      (pg_catalog.clock_timestamp() at time zone 'Asia/Manila')::date,
      'YYYY-MM'
    ),
    'success', true
  ),
  (
    '00000000-0000-4000-8000-000000005312',
    'test_monthly_leave_home', 'SQL monthly home source',
    'attendance', 'home',
    pg_catalog.to_char(
      (pg_catalog.clock_timestamp() at time zone 'Asia/Manila')::date,
      'YYYY-MM'
    ),
    'success', true
  ),
  (
    '00000000-0000-4000-8000-000000005313',
    'test_monthly_leave_unknown', 'SQL monthly unknown source',
    'attendance', null,
    pg_catalog.to_char(
      (pg_catalog.clock_timestamp() at time zone 'Asia/Manila')::date,
      'YYYY-MM'
    ),
    'success', true
  );

-- full_days, half_days, and home_leave_days are expanded into distinct dates.
with fixture(
  employee_id, source_id, full_days, half_days, home_leave_days, source_row_base
) as (
  values
    ('00000000-0000-4000-8000-000000005301'::uuid, '00000000-0000-4000-8000-000000005311'::uuid, 2, 1, 0, 530100),
    ('00000000-0000-4000-8000-000000005302'::uuid, '00000000-0000-4000-8000-000000005311'::uuid, 2, 0, 0, 530200),
    ('00000000-0000-4000-8000-000000005303'::uuid, '00000000-0000-4000-8000-000000005312'::uuid, 4, 1, 0, 530300),
    ('00000000-0000-4000-8000-000000005304'::uuid, '00000000-0000-4000-8000-000000005312'::uuid, 4, 0, 0, 530400),
    ('00000000-0000-4000-8000-000000005305'::uuid, '00000000-0000-4000-8000-000000005311'::uuid, 5, 1, 0, 530500),
    ('00000000-0000-4000-8000-000000005306'::uuid, '00000000-0000-4000-8000-000000005311'::uuid, 6, 0, 0, 530600),
    ('00000000-0000-4000-8000-000000005306'::uuid, '00000000-0000-4000-8000-000000005312'::uuid, 6, 0, 0, 530610),
    ('00000000-0000-4000-8000-000000005307'::uuid, '00000000-0000-4000-8000-000000005313'::uuid, 6, 0, 0, 530700),
    ('00000000-0000-4000-8000-000000005308'::uuid, '00000000-0000-4000-8000-000000005311'::uuid, 2, 0, 4, 530800)
), expanded as (
  select fixture.*,
    ordinal,
    case
      when ordinal <= full_days then 'public_holiday'
      when ordinal <= full_days + half_days then 'half_day'
      else 'home_leave'
    end event_kind
  from fixture
  cross join lateral pg_catalog.generate_series(
    1, fixture.full_days + fixture.half_days + fixture.home_leave_days
  ) as generated(ordinal)
)
insert into public.employee_attendance_records (
  source_id, source_block, source_row, source_item_key, kind,
  event_date, event_kind, employee_id, employee_no_raw, employee_name_raw,
  match_status, match_method, matched_at, raw_values, content_hash, is_mirror
)
select
  expanded.source_id,
  'attendance',
  expanded.source_row_base + expanded.ordinal,
  'monthly-threshold-routing',
  'attendance',
  pg_catalog.date_trunc(
    'month', pg_catalog.clock_timestamp() at time zone 'Asia/Manila'
  )::date + (expanded.ordinal - 1),
  expanded.event_kind,
  expanded.employee_id,
  employee.employee_no,
  employee.full_name,
  'matched',
  'employee_id_exact',
  pg_catalog.clock_timestamp(),
  '{}'::jsonb,
  pg_catalog.md5(expanded.employee_id::text || ':' || expanded.source_row_base::text || ':' || expanded.ordinal::text),
  false
from expanded
join public.employees employee on employee.id = expanded.employee_id;

select alerts_private.refresh_alert_group('attendance');

do $thresholds$
begin
  if not exists (
    select 1 from public.admin_alert_events alert
    where alert.is_active
      and alert.alert_type = 'monthly_leave'
      and alert.employee_id = '00000000-0000-4000-8000-000000005301'
      and alert.occurrence_count = 2.5
      and alert.payload @> '{"allowed_days":2,"trigger_at":3,"work_mode":"onsite_to_home","source_group":"onsite_to_home","classification_quality":"verified"}'::jsonb
  ) then raise exception 'onsite_2_5_threshold_failed'; end if;

  if exists (
    select 1 from public.admin_alert_events alert
    where alert.is_active
      and alert.alert_type = 'monthly_leave'
      and alert.employee_id = '00000000-0000-4000-8000-000000005302'
  ) then raise exception 'onsite_exactly_2_alerted'; end if;

  if not exists (
    select 1 from public.admin_alert_events alert
    where alert.is_active
      and alert.alert_type = 'monthly_leave'
      and alert.employee_id = '00000000-0000-4000-8000-000000005303'
      and alert.occurrence_count = 4.5
      and alert.payload @> '{"allowed_days":4,"trigger_at":5,"work_mode":"home","source_group":"home","classification_quality":"verified"}'::jsonb
  ) then raise exception 'home_4_5_threshold_failed'; end if;

  if exists (
    select 1 from public.admin_alert_events alert
    where alert.is_active
      and alert.alert_type = 'monthly_leave'
      and alert.employee_id in (
        '00000000-0000-4000-8000-000000005304',
        '00000000-0000-4000-8000-000000005308'
      )
  ) then raise exception 'non_qualifying_or_home_leave_employee_alerted'; end if;

  if not exists (
    select 1 from public.admin_alert_events alert
    where alert.is_active
      and alert.alert_type = 'monthly_leave'
      and alert.employee_id = '00000000-0000-4000-8000-000000005305'
      and alert.payload @> '{"allowed_days":5,"work_mode":"legacy_fallback","source_group":"onsite_to_home","classification_quality":"fallback","classification_issue":"employment_type_source_conflict"}'::jsonb
  ) then raise exception 'source_type_conflict_did_not_keep_legacy_limit'; end if;

  if not exists (
    select 1 from public.admin_alert_events alert
    where alert.is_active
      and alert.alert_type = 'monthly_leave'
      and alert.employee_id = '00000000-0000-4000-8000-000000005306'
      and alert.occurrence_count = 6
      and alert.payload @> '{"allowed_days":5,"work_mode":"legacy_fallback","source_group":"mixed","classification_quality":"fallback","classification_issue":"mixed_source_group"}'::jsonb
  ) then raise exception 'mixed_source_did_not_keep_legacy_limit'; end if;

  if not exists (
    select 1 from public.admin_alert_events alert
    where alert.is_active
      and alert.alert_type = 'monthly_leave'
      and alert.employee_id = '00000000-0000-4000-8000-000000005307'
      and alert.payload @> '{"allowed_days":5,"work_mode":"legacy_fallback","source_group":"unknown","classification_quality":"fallback","classification_issue":"missing_source_group"}'::jsonb
  ) then raise exception 'unknown_source_did_not_keep_legacy_limit'; end if;
end;
$thresholds$;

-- Repeating the refresh keeps one active incident per employee/month.
select alerts_private.refresh_alert_group('attendance');

do $dedup$
begin
  if exists (
    select alert.employee_id
    from public.admin_alert_events alert
    where alert.is_active
      and alert.alert_type = 'monthly_leave'
      and alert.employee_id between
        '00000000-0000-4000-8000-000000005301'::uuid and
        '00000000-0000-4000-8000-000000005308'::uuid
    group by alert.employee_id
    having count(*) <> 1
  ) then raise exception 'monthly_leave_active_incident_was_duplicated'; end if;
end;
$dedup$;

delete from public.employee_attendance_records record
where record.employee_id = '00000000-0000-4000-8000-000000005301'
  and record.event_kind = 'half_day';

select alerts_private.refresh_alert_group('attendance');

do $resolution$
begin
  if exists (
    select 1 from public.admin_alert_events alert
    where alert.is_active
      and alert.alert_type = 'monthly_leave'
      and alert.employee_id = '00000000-0000-4000-8000-000000005301'
  ) then raise exception 'onsite_alert_not_resolved_at_2_days'; end if;
end;
$resolution$;

rollback;
