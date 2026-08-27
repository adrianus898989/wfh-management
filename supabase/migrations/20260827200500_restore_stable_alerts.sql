begin;

-- Roll back the experimental 1/3/7-day error-frequency thresholds. Keep the
-- alert refresher manual until it is replaced by an incremental, load-tested
-- job; no login or ordinary page should compete with a global alert scan.
select cron.unschedule(jobid)
from cron.job
where jobname = 'admin-alert-refresh';

do $restore_previous_error_frequency$
declare
  v_definition text;
  v_previous_block text := $previous$
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
$previous$;
  v_experimental_block text := $experimental$
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
$experimental$;
begin
  select pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_core_alerts()'::regprocedure
  ) into v_definition;

  if position(v_previous_block in v_definition) = 0 then
    if position(v_experimental_block in v_definition) = 0 then
      raise exception 'admin_alert_error_frequency_restore_definition_changed';
    end if;
    v_definition := replace(
      v_definition,
      v_experimental_block,
      v_previous_block
    );
    execute v_definition;
  end if;

  select pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_core_alerts()'::regprocedure
  ) into v_definition;
  if position(v_previous_block in v_definition) = 0
     or position('error_frequency_candidates(v_today)' in v_definition) > 0 then
    raise exception 'admin_alert_error_frequency_restore_incomplete';
  end if;
end
$restore_previous_error_frequency$;

revoke all on function alerts_private.refresh_core_alerts()
  from public, anon, authenticated;

comment on function alerts_private.error_frequency_candidates(date) is
  'Experimental 1/3/7-day detector retained for audit only; not called by the active warning refresh.';
comment on function alerts_private.refresh_core_alerts() is
  'Uses the previous stable three-day six-error rule; automatic global refresh remains paused pending an incremental replacement.';
comment on function alerts_private.refresh_alerts() is
  'Manual only during recovery. Do not schedule until an incremental refresh passes production load and connection-budget checks.';

-- Restore the pre-incident alert reader. It keeps every existing session,
-- granular alert-type and employee-scope boundary, and enriches only the
-- already-scoped page with the strict current-roster team.
create or replace function public.admin_alert_center(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_rows jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('alert.view') then
    raise exception 'permission_denied';
  end if;

  if not (
    alerts_private.caller_can_view_alert_type('payout_change')
    or alerts_private.caller_can_view_alert_type('resigned_account_active')
    or alerts_private.caller_can_view_alert_type('today_missing_clock_in')
    or alerts_private.caller_can_view_alert_type('today_missing_daily_report')
    or alerts_private.caller_can_view_alert_type('leave_activity')
    or alerts_private.caller_can_view_alert_type('late_timeout_frequency')
    or alerts_private.caller_can_view_alert_type('consecutive_rest')
    or alerts_private.caller_can_view_alert_type('weekly_absence')
    or alerts_private.caller_can_view_alert_type('monthly_leave')
    or alerts_private.caller_can_view_alert_type('error_spike')
    or alerts_private.caller_can_view_alert_type('repeated_error')
    or alerts_private.caller_can_view_alert_type('deduction_frequency')
    or alerts_private.caller_can_view_alert_type('exam_failed')
    or alerts_private.caller_can_view_alert_type('low_workload_streak')
  ) then
    return jsonb_build_object(
      'page', least(greatest(coalesce(p_page, 1), 1), 1000000),
      'page_size', least(greatest(coalesce(p_page_size, 30), 1), 100),
      'total', 0,
      'pages', 1,
      'active_total', 0,
      'unread_total', 0,
      'type_counts', '{}'::jsonb,
      'rows', '[]'::jsonb
    );
  end if;

  v_result := public.admin_alert_center_page_v1(
    p_filters,
    p_page,
    p_page_size
  );

  select coalesce(
    jsonb_agg(
      item.row_data || jsonb_build_object(
        'team_name', coalesce(nullif(btrim(team.name), ''), '')
      )
      order by item.ordinality
    ),
    '[]'::jsonb
  )
  into v_rows
  from jsonb_array_elements(
    coalesce(v_result->'rows', '[]'::jsonb)
  ) with ordinality as item(row_data, ordinality)
  left join scope_private.current_employee_scope_directory() directory
    on directory.employee_id::text = nullif(item.row_data->>'employee_id', '')
  left join public.teams team
    on team.id = directory.current_team_id;

  return jsonb_set(v_result, '{rows}', v_rows, true);
end;
$$;

revoke all on function public.admin_alert_center(jsonb, integer, integer)
  from public, anon;
grant execute on function public.admin_alert_center(jsonb, integer, integer)
  to authenticated, service_role;

comment on function public.admin_alert_center(jsonb, integer, integer) is
  'On-demand granular alert reader restored after recovery; automatic bell polling and global refresh remain disabled.';

notify pgrst, 'reload schema';

commit;
