-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

do $$
declare
  v_source_count integer;
  v_usd text;
  v_php text;
begin
  select count(*)
  into v_source_count
  from public.attendance_sheet_sources s
  where s.metadata#>>'{annual_sync,contract}' = 'annual_v1'
    and s.source_month in ('2026-09', '2026-10', '2026-11', '2026-12')
    and (
      (s.source_key like 'onsite_annual_2026_%'
        and s.metadata#>>'{annual_sync,currency}' = 'USD')
      or (s.source_key like 'home_vimm_annual_2026_%'
        and s.metadata#>>'{annual_sync,currency}' = 'USD')
      or (s.source_key like 'home_ph_annual_2026_%'
        and s.metadata#>>'{annual_sync,currency}' = 'PHP')
    );
  if v_source_count <> 12 then
    raise exception 'expected 12 correctly configured annual sources, got %', v_source_count;
  end if;

  select attendance_private.resolve_adjustment_currency(s.id, null, 'UNKNOWN-USD', 'UNKNOWN USD', null)
  into v_usd
  from public.attendance_sheet_sources s
  where s.source_key = 'home_vimm_annual_2026_09';
  if v_usd is distinct from 'USD' then
    raise exception 'unmatched VIMM annual source resolved %, expected USD', v_usd;
  end if;

  select attendance_private.resolve_adjustment_currency(s.id, null, 'UNKNOWN-PHP', 'UNKNOWN PHP', null)
  into v_php
  from public.attendance_sheet_sources s
  where s.source_key = 'home_ph_annual_2026_09';
  if v_php is distinct from 'PHP' then
    raise exception 'unmatched PH annual source resolved %, expected PHP', v_php;
  end if;

  insert into public.employee_attendance_records (
    source_id, source_block, source_row, source_item_key, kind,
    event_date, event_kind, amount, raw_amount,
    employee_no_raw, employee_name_raw, match_status,
    raw_values, content_hash, is_mirror
  )
  select
    s.id, 'adjustment', 1900000001,
    'v1:' || repeat('a', 64), 'adjustment',
    '2026-09-01', 'bonus', 1, '1',
    'UNKNOWN-USD-TRIGGER', 'UNKNOWN USD TRIGGER', 'unmatched',
    '{}'::jsonb, repeat('b', 64), false
  from public.attendance_sheet_sources s
  where s.source_key = 'home_vimm_annual_2026_09'
  returning currency into v_usd;
  if v_usd is distinct from 'USD' then
    raise exception 'annual USD trigger stored %, expected USD', v_usd;
  end if;

  insert into public.employee_attendance_records (
    source_id, source_block, source_row, source_item_key, kind,
    event_date, event_kind, amount, raw_amount,
    employee_no_raw, employee_name_raw, match_status,
    raw_values, content_hash, is_mirror
  )
  select
    s.id, 'adjustment', 1900000002,
    'v1:' || repeat('c', 64), 'adjustment',
    '2026-09-01', 'deduction', -1, '-1',
    'UNKNOWN-PHP-TRIGGER', 'UNKNOWN PHP TRIGGER', 'unmatched',
    '{}'::jsonb, repeat('d', 64), false
  from public.attendance_sheet_sources s
  where s.source_key = 'home_ph_annual_2026_09'
  returning currency into v_php;
  if v_php is distinct from 'PHP' then
    raise exception 'annual PHP trigger stored %, expected PHP', v_php;
  end if;
end;
$$;

rollback;
