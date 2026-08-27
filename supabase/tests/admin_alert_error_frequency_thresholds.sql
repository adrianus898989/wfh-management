-- Run only against a disposable database after every migration. All fixture
-- mutations are rolled back. This protects the three independent thresholds,
-- canonical record-key deduplication, one-active-incident behavior, and the
-- existing employee-scope boundary on the alert reader.

begin;

do $preconditions$
declare
  v_refresh text;
  v_reader text;
  v_volatility "char";
  v_security_definer boolean;
  v_config text[];
begin
  select pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_core_alerts()'::regprocedure
  ) into v_refresh;
  if position('error_frequency_candidates(v_today)' in v_refresh) = 0
     or position('count(distinct error.record_key) >= 6' in v_refresh) > 0 then
    raise exception 'core refresh does not use the current error-frequency rules';
  end if;

  if pg_catalog.has_function_privilege(
    'authenticated',
    'alerts_private.error_frequency_candidates(date)',
    'execute'
  ) then
    raise exception 'authenticated role can execute private error-frequency scan';
  end if;

  select function_row.provolatile, function_row.prosecdef, function_row.proconfig
  into v_volatility, v_security_definer, v_config
  from pg_catalog.pg_proc function_row
  where function_row.oid =
    'alerts_private.error_frequency_candidates(date)'::regprocedure;
  if v_volatility <> 's'
     or not v_security_definer
     or not ('search_path=""' = any(coalesce(v_config, array[]::text[]))) then
    raise exception 'private error-frequency helper volatility/security/search_path changed: %, %, %',
      v_volatility, v_security_definer, v_config;
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.admin_alert_center_page_v1(jsonb,integer,integer)'::regprocedure
  ) into v_reader;
  if position('backend_employee_in_scope(event.employee_id)' in v_reader) = 0 then
    raise exception 'alert reader lost the centralized employee-scope guard';
  end if;
end
$preconditions$;

insert into public.employees (id, employee_no, full_name, status) values
  ('00000000-0000-4000-8000-00000000e651', 'ALERT-FREQ-1D', '__ALERT_FREQ_1D__', 'active'),
  ('00000000-0000-4000-8000-00000000e652', 'ALERT-FREQ-3D', '__ALERT_FREQ_3D__', 'active'),
  ('00000000-0000-4000-8000-00000000e653', 'ALERT-FREQ-7D', '__ALERT_FREQ_7D__', 'active'),
  ('00000000-0000-4000-8000-00000000e654', 'ALERT-FREQ-NO', '__ALERT_FREQ_NO__', 'active');

-- Five distinct errors today. A newer duplicate copy of record 1 must not
-- turn the count into six.
insert into public.report_employee_error_rows (
  source_name, source_row, source_chunk_index, record_key,
  employee_no, error_type, qc_date, synced_at
)
select
  '__alert_frequency_1d__', item, 0, '__ALERT_FREQ_1D_' || item::text,
  'ALERT-FREQ-1D', '__TEST_ERROR__',
  (clock_timestamp() at time zone 'Asia/Manila')::date,
  clock_timestamp() - interval '1 minute'
from generate_series(1, 5) item;

insert into public.report_employee_error_rows (
  source_name, source_row, source_chunk_index, record_key,
  employee_no, error_type, qc_date, synced_at
) values (
  '__alert_frequency_1d_duplicate__', 999, 0, '__ALERT_FREQ_1D_1',
  'ALERT-FREQ-1D', '__TEST_ERROR__',
  (clock_timestamp() at time zone 'Asia/Manila')::date,
  clock_timestamp()
);

-- Five errors over three days, but fewer than five today.
insert into public.report_employee_error_rows (
  source_name, source_row, source_chunk_index, record_key,
  employee_no, error_type, qc_date, synced_at
)
select
  '__alert_frequency_3d__', item, 0, '__ALERT_FREQ_3D_' || item::text,
  'ALERT-FREQ-3D', '__TEST_ERROR__',
  (clock_timestamp() at time zone 'Asia/Manila')::date
    - case when item <= 2 then 0 when item <= 4 then 1 else 2 end,
  clock_timestamp()
from generate_series(1, 5) item;

-- Ten errors over seven days, with only four inside the latest three days.
insert into public.report_employee_error_rows (
  source_name, source_row, source_chunk_index, record_key,
  employee_no, error_type, qc_date, synced_at
)
select
  '__alert_frequency_7d__', item, 0, '__ALERT_FREQ_7D_' || item::text,
  'ALERT-FREQ-7D', '__TEST_ERROR__',
  (clock_timestamp() at time zone 'Asia/Manila')::date
    - case
        when item <= 4 then (item - 1) % 3
        else 3 + ((item - 5) % 4)
      end,
  clock_timestamp()
from generate_series(1, 10) item;

-- Four errors over three days and nine over seven days: below every rule.
insert into public.report_employee_error_rows (
  source_name, source_row, source_chunk_index, record_key,
  employee_no, error_type, qc_date, synced_at
)
select
  '__alert_frequency_no__', item, 0, '__ALERT_FREQ_NO_' || item::text,
  'ALERT-FREQ-NO', '__TEST_ERROR__',
  (clock_timestamp() at time zone 'Asia/Manila')::date
    - case
        when item <= 4 then (item - 1) % 3
        else 3 + ((item - 5) % 4)
      end,
  clock_timestamp()
from generate_series(1, 9) item;

create temporary table alert_frequency_test_candidates on commit drop as
select candidate.*
from alerts_private.error_frequency_candidates(
  (clock_timestamp() at time zone 'Asia/Manila')::date
) candidate
where candidate.employee_id in (
  '00000000-0000-4000-8000-00000000e651',
  '00000000-0000-4000-8000-00000000e652',
  '00000000-0000-4000-8000-00000000e653',
  '00000000-0000-4000-8000-00000000e654'
);

do $thresholds$
begin
  if not exists (
    select 1
    from pg_temp.alert_frequency_test_candidates candidate
    where candidate.employee_id = '00000000-0000-4000-8000-00000000e651'
      and candidate.severity = 'critical'
      and candidate.window_start = candidate.window_end
      and candidate.occurrence_count = 5
      and candidate.payload->>'days' = '1'
      and candidate.payload->>'threshold' = '5'
      and candidate.payload#>>'{counts,1d}' = '5'
      and candidate.payload#>>'{counts,3d}' = '5'
      and candidate.payload#>>'{rules,0,triggered}' = 'true'
  ) then
    raise exception 'one-day threshold or record-key deduplication failed';
  end if;

  if not exists (
    select 1
    from pg_temp.alert_frequency_test_candidates candidate
    where candidate.employee_id = '00000000-0000-4000-8000-00000000e652'
      and candidate.severity = 'warning'
      and candidate.window_start = candidate.window_end - 2
      and candidate.occurrence_count = 5
      and candidate.payload->>'days' = '3'
      and candidate.payload->>'threshold' = '5'
      and candidate.payload#>>'{counts,1d}' = '2'
      and candidate.payload#>>'{counts,3d}' = '5'
      and candidate.payload#>>'{rules,1,triggered}' = 'true'
  ) then
    raise exception 'three-day threshold failed';
  end if;

  if not exists (
    select 1
    from pg_temp.alert_frequency_test_candidates candidate
    where candidate.employee_id = '00000000-0000-4000-8000-00000000e653'
      and candidate.severity = 'critical'
      and candidate.window_start = candidate.window_end - 6
      and candidate.occurrence_count = 10
      and candidate.payload->>'days' = '7'
      and candidate.payload->>'threshold' = '10'
      and candidate.payload#>>'{counts,3d}' = '4'
      and candidate.payload#>>'{counts,7d}' = '10'
      and candidate.payload#>>'{rules,2,triggered}' = 'true'
  ) then
    raise exception 'seven-day threshold failed';
  end if;

  if exists (
    select 1
    from pg_temp.alert_frequency_test_candidates candidate
    where candidate.employee_id = '00000000-0000-4000-8000-00000000e654'
  ) then
    raise exception 'below-threshold employee received an alert';
  end if;

  if exists (
    select candidate.employee_id
    from pg_temp.alert_frequency_test_candidates candidate
    where candidate.employee_id in (
      '00000000-0000-4000-8000-00000000e651',
      '00000000-0000-4000-8000-00000000e652',
      '00000000-0000-4000-8000-00000000e653'
    )
    group by candidate.employee_id
    having count(*) <> 1
  ) then
    raise exception 'an employee received duplicate active frequency incidents';
  end if;
end
$thresholds$;

-- Drop one of the five same-day records. The authoritative scan must stop
-- returning that employee so the unchanged core refresh resolves the incident.
delete from public.report_employee_error_rows
where source_name = '__alert_frequency_1d__'
  and source_row = 5;

do $resolution$
begin
  if exists (
    select 1
    from alerts_private.error_frequency_candidates(
      (clock_timestamp() at time zone 'Asia/Manila')::date
    ) candidate
    where candidate.employee_id = '00000000-0000-4000-8000-00000000e651'
  ) then
    raise exception 'frequency candidate remained after falling below threshold';
  end if;
end
$resolution$;

rollback;
