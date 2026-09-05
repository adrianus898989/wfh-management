-- Read-only production acceptance for the confirmed CS000673 stale warning.
-- Run after 20260905183000_exclude_protected_missing_attendance_from_alerts.sql.

do $verify_cs000673_consecutive_rest_resolution$
declare
  v_employee_id uuid;
begin
  select employee.id
  into strict v_employee_id
  from public.employees employee
  where pg_catalog.upper(pg_catalog.btrim(employee.employee_no)) = 'CS000673';

  if not exists (
    select 1
    from public.employee_attendance_records record
    join public.attendance_sheet_sources source on source.id = record.source_id
    where record.employee_id = v_employee_id
      and source.source_key = 'home_ph_annual_2026_09'
      and record.kind = 'attendance'
      and record.event_date = date '2026-09-05'
      and record.event_kind = 'public_holiday'
      and record.raw_values->>'sync_presence' is distinct from 'protected_missing'
  ) then
    raise exception 'CS000673 current 2026-09-05 public holiday is missing';
  end if;

  if exists (
    select 1
    from public.employee_attendance_records record
    join public.attendance_sheet_sources source on source.id = record.source_id
    where record.employee_id = v_employee_id
      and source.source_key = 'home_ph_annual_2026_09'
      and record.kind = 'attendance'
      and record.event_date = date '2026-09-06'
      and record.event_kind = 'public_holiday'
      and record.raw_values->>'sync_presence' is distinct from 'protected_missing'
  ) then
    raise exception 'CS000673 stale 2026-09-06 public holiday is still current';
  end if;

  if not exists (
    select 1
    from public.employee_attendance_records record
    join public.attendance_sheet_sources source on source.id = record.source_id
    where record.employee_id = v_employee_id
      and source.source_key = 'home_ph_annual_2026_09'
      and record.kind = 'attendance'
      and record.event_date = date '2026-09-06'
      and record.event_kind = 'public_holiday'
      and record.raw_values->>'sync_presence' = 'protected_missing'
  ) then
    raise exception 'CS000673 stale 2026-09-06 history was not retained and marked';
  end if;

  if exists (
    select 1
    from public.admin_alert_events alert
    where alert.employee_id = v_employee_id
      and alert.alert_type = 'consecutive_rest'
      and alert.is_active
  ) then
    raise exception 'CS000673 consecutive-rest warning is still active';
  end if;
end;
$verify_cs000673_consecutive_rest_resolution$;

select pg_catalog.jsonb_build_object(
  'employee_no', employee.employee_no,
  'employee_name', employee.full_name,
  'current_public_holiday_dates', coalesce((
    select pg_catalog.jsonb_agg(record.event_date order by record.event_date)
    from public.employee_attendance_records record
    where record.employee_id = employee.id
      and record.kind = 'attendance'
      and record.event_kind = 'public_holiday'
      and record.event_date between date '2026-09-01' and date '2026-09-30'
      and record.raw_values->>'sync_presence' is distinct from 'protected_missing'
  ), '[]'::jsonb),
  'protected_missing_dates', coalesce((
    select pg_catalog.jsonb_agg(record.event_date order by record.event_date)
    from public.employee_attendance_records record
    where record.employee_id = employee.id
      and record.kind = 'attendance'
      and record.event_kind = 'public_holiday'
      and record.event_date between date '2026-09-01' and date '2026-09-30'
      and record.raw_values->>'sync_presence' = 'protected_missing'
  ), '[]'::jsonb),
  'active_consecutive_rest_alerts', (
    select pg_catalog.count(*)
    from public.admin_alert_events alert
    where alert.employee_id = employee.id
      and alert.alert_type = 'consecutive_rest'
      and alert.is_active
  )
) as cs000673_acceptance
from public.employees employee
where pg_catalog.upper(pg_catalog.btrim(employee.employee_no)) = 'CS000673';
