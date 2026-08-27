begin;

-- Reuse the existing date and canonical-record indexes. The frequency scan
-- starts from only the latest seven days, then uses the record-key index to
-- reject superseded copies without scanning the full reporting view.
create index if not exists report_employee_error_rows_qc_date_idx
  on public.report_employee_error_rows (qc_date desc, source_row desc);
create index if not exists report_employee_error_rows_record_key_idx
  on public.report_employee_error_rows (record_key, synced_at desc, source_row desc);

create or replace function alerts_private.error_frequency_candidates(
  p_today date default null
)
returns table (
  employee_id uuid,
  employee_no text,
  employee_name text,
  matched_days integer,
  matched_threshold integer,
  occurrence_count numeric,
  count_1d numeric,
  count_3d numeric,
  count_7d numeric,
  severity text,
  window_start date,
  window_end date,
  payload jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with parameters as (
    select coalesce(
      p_today,
      (current_timestamp at time zone 'Asia/Manila')::date
    ) as today
  ), latest_recent_errors as materialized (
    select
      error.record_key,
      upper(btrim(error.employee_no)) as employee_no_key,
      error.qc_date
    from public.report_employee_error_rows error
    cross join parameters
    where error.qc_date between parameters.today - 6 and parameters.today
      and nullif(btrim(error.employee_no), '') is not null
      -- report_employee_errors_v keeps the newest copy of every record_key.
      -- Apply the same rule after the selective seven-day date scan so an old
      -- duplicate cannot inflate an employee's frequency count.
      and not exists (
        select 1
        from public.report_employee_error_rows newer
        where newer.record_key = error.record_key
          and (
            newer.synced_at > error.synced_at
            or (
              newer.synced_at = error.synced_at
              and newer.source_row > error.source_row
            )
          )
      )
  ), counts as (
    select
      recent.employee_no_key,
      parameters.today,
      count(distinct recent.record_key) filter (
        where recent.qc_date = parameters.today
      )::numeric as count_1d,
      count(distinct recent.record_key) filter (
        where recent.qc_date between parameters.today - 2 and parameters.today
      )::numeric as count_3d,
      count(distinct recent.record_key)::numeric as count_7d
    from latest_recent_errors recent
    cross join parameters
    group by recent.employee_no_key, parameters.today
  ), qualified as (
    select
      counts.*,
      case
        when counts.count_1d >= 5 then 1
        when counts.count_3d >= 5 then 3
        else 7
      end as matched_days,
      case
        when counts.count_1d >= 5 then 5
        when counts.count_3d >= 5 then 5
        else 10
      end as matched_threshold,
      case
        when counts.count_1d >= 5 then counts.count_1d
        when counts.count_3d >= 5 then counts.count_3d
        else counts.count_7d
      end as matched_count
    from counts
    where counts.count_1d >= 5
       or counts.count_3d >= 5
       or counts.count_7d >= 10
  )
  select
    employee.id,
    employee.employee_no,
    employee.full_name,
    qualified.matched_days,
    qualified.matched_threshold,
    qualified.matched_count,
    qualified.count_1d,
    qualified.count_3d,
    qualified.count_7d,
    case
      when qualified.count_1d >= 5 or qualified.count_7d >= 10
        then 'critical'
      else 'warning'
    end,
    qualified.today - (qualified.matched_days - 1),
    qualified.today,
    jsonb_build_object(
      'details_version', 2,
      'days', qualified.matched_days,
      'threshold', qualified.matched_threshold,
      'count', qualified.matched_count,
      'counts', jsonb_build_object(
        '1d', qualified.count_1d,
        '3d', qualified.count_3d,
        '7d', qualified.count_7d
      ),
      'rules', jsonb_build_array(
        jsonb_build_object(
          'days', 1, 'threshold', 5, 'count', qualified.count_1d,
          'triggered', qualified.count_1d >= 5
        ),
        jsonb_build_object(
          'days', 3, 'threshold', 5, 'count', qualified.count_3d,
          'triggered', qualified.count_3d >= 5
        ),
        jsonb_build_object(
          'days', 7, 'threshold', 10, 'count', qualified.count_7d,
          'triggered', qualified.count_7d >= 10
        )
      )
    )
  from qualified
  join public.employees employee
    on upper(btrim(employee.employee_no)) = qualified.employee_no_key
  where employee.status in ('active', 'probation', 'suspended');
$$;

revoke all on function alerts_private.error_frequency_candidates(date)
  from public, anon, authenticated;

-- Keep the existing atomic refresh, incident history, alert-cycle escalation,
-- and stale-alert resolution unchanged. Replace only the error-frequency
-- candidate block so one employee still has at most one active incident.
do $migration$
declare
  v_definition text;
  v_old_block text := $old_error_frequency$
  -- More than five errors in three calendar days means six or more records.
  insert into pg_temp.admin_alert_candidates
  with stats as (
    select upper(btrim(error.employee_no)) employee_no_key,
      count(distinct error.record_key)::numeric occurrence_count
    from public.report_employee_errors_v error
    where error.qc_date between v_today - 2 and v_today
      and nullif(btrim(error.employee_no), '') is not null
    group by upper(btrim(error.employee_no))
    having count(distinct error.record_key) >= 6
  )
  select
    'error_spike:' || employee.id::text,
    'error_spike',
    case when stats.occurrence_count >= 10 then 'critical' else 'warning' end,
    employee.id,
    employee.employee_no,
    employee.full_name,
    '三天错误次数预警',
    employee.full_name || ' 近3天有 ' || stats.occurrence_count::text || ' 笔错误记录',
    v_today - 2,
    v_today,
    stats.occurrence_count,
    jsonb_build_object('days', 3, 'threshold', 6, 'count', stats.occurrence_count),
    'report_employee_errors_v'
  from stats
  join public.employees employee
    on upper(btrim(employee.employee_no)) = stats.employee_no_key
  where employee.status in ('active', 'probation', 'suspended');
$old_error_frequency$;
  v_new_block text := $new_error_frequency$
  -- One employee produces one active error-frequency incident when any rule
  -- matches: 1 day >= 5, 3 days >= 5, or 7 days >= 10.
  insert into pg_temp.admin_alert_candidates
  select
    'error_spike:' || frequency.employee_id::text,
    'error_spike',
    frequency.severity,
    frequency.employee_id,
    frequency.employee_no,
    frequency.employee_name,
    '错误频率预警',
    frequency.employee_name || ' 近' || frequency.matched_days::text
      || '天有 ' || frequency.occurrence_count::text || ' 笔错误记录',
    frequency.window_start,
    frequency.window_end,
    frequency.occurrence_count,
    frequency.payload,
    'report_employee_error_rows'
  from alerts_private.error_frequency_candidates(v_today) frequency;
$new_error_frequency$;
begin
  select pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_core_alerts()'::regprocedure
  ) into v_definition;

  if position(v_old_block in v_definition) = 0 then
    raise exception 'admin_alert_error_frequency_definition_changed';
  end if;

  v_definition := replace(v_definition, v_old_block, v_new_block);
  execute v_definition;

  select pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_core_alerts()'::regprocedure
  ) into v_definition;
  if position('error_frequency_candidates(v_today)' in v_definition) = 0
     or position('count(distinct error.record_key) >= 6' in v_definition) > 0 then
    raise exception 'admin_alert_error_frequency_patch_incomplete';
  end if;
end
$migration$;

revoke all on function alerts_private.refresh_core_alerts()
  from public, anon, authenticated;

comment on function alerts_private.error_frequency_candidates(date) is
  'Returns one deduplicated candidate per current employee when 1d>=5, 3d>=5, or 7d>=10 errors; payload retains all three counts.';
comment on function alerts_private.refresh_core_alerts() is
  'Atomically refreshes core warning incidents, including deduplicated 1/3/7-day employee error-frequency thresholds.';

-- Do not run the global refresh inside this migration transaction. Production
-- refreshes are intentionally left to the existing scheduler after deploy so
-- schema rollout cannot hold locks while the full alert catalog is scanned.

commit;
