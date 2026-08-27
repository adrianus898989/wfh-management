begin;

-- The former global refresher could hold a database connection for tens of
-- seconds.  Keep it disabled and replace it with disjoint, bounded groups.
-- This migration installs the functions only; schedules are activated by a
-- separate migration after every group passes a production canary.
select cron.unschedule(jobid)
from cron.job
where jobname in (
  'admin-alert-refresh',
  'admin-alert-refresh-error',
  'admin-alert-refresh-adjustment',
  'admin-alert-refresh-attendance',
  'admin-alert-refresh-access-exam'
);

do $verify_stable_error_rule$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_core_alerts()'::regprocedure
  );
begin
  if position('having count(distinct error.record_key) >= 6' in v_definition) = 0
     or position('error_frequency_candidates' in v_definition) > 0 then
    raise exception 'stable_error_rule_precondition_failed';
  end if;
end;
$verify_stable_error_rule$;

create or replace function alerts_private.refresh_alert_group(p_group text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '6s'
set lock_timeout = '500ms'
as $$
declare
  v_group text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_group, '')));
  v_today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Manila')::date;
  v_started_at timestamptz := pg_catalog.clock_timestamp();
  v_alert_types text[];
  v_upserted integer := 0;
  v_resolved integer := 0;
begin
  if v_group not in ('error', 'adjustment', 'attendance', 'access_exam') then
    raise exception 'invalid_alert_refresh_group';
  end if;

  -- One global non-blocking lock guarantees that a slow group can never stack
  -- behind another group and consume a second connection.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('alerts_private.refresh_alert_group', 0)
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'group', v_group, 'skipped', true,
      'reason', 'refresh_running'
    );
  end if;

  create temporary table if not exists admin_alert_group_candidates (
    condition_key text primary key,
    alert_type text not null,
    severity text not null,
    employee_id uuid not null,
    employee_no text not null,
    employee_name text not null,
    title text not null,
    message text not null,
    window_start date,
    window_end date,
    occurrence_count numeric not null,
    payload jsonb not null,
    source_ref text
  ) on commit drop;
  truncate table pg_temp.admin_alert_group_candidates;

  if v_group = 'error' then
    v_alert_types := array['error_spike'];

    -- Previous stable rule only: six or more distinct errors in three days.
    insert into pg_temp.admin_alert_group_candidates
    with stats as (
      select pg_catalog.upper(pg_catalog.btrim(error.employee_no)) employee_no_key,
        count(distinct error.record_key)::numeric occurrence_count
      from public.report_employee_errors_v error
      where error.qc_date between v_today - 2 and v_today
        and nullif(pg_catalog.btrim(error.employee_no), '') is not null
      group by pg_catalog.upper(pg_catalog.btrim(error.employee_no))
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
      pg_catalog.jsonb_build_object(
        'days', 3, 'threshold', 6, 'count', stats.occurrence_count
      ),
      'report_employee_errors_v'
    from stats
    join public.employees employee
      on pg_catalog.upper(pg_catalog.btrim(employee.employee_no)) = stats.employee_no_key
    where employee.status in ('active', 'probation', 'suspended');

  elsif v_group = 'adjustment' then
    v_alert_types := array['deduction_frequency', 'late_timeout_frequency'];

    insert into pg_temp.admin_alert_group_candidates
    with stats as (
      select record.employee_id, count(*)::numeric occurrence_count
      from public.employee_attendance_records record
      where record.employee_id is not null
        and record.kind = 'adjustment'
        and pg_catalog.lower(record.event_kind) = 'deduction'
        and record.event_date between v_today - 6 and v_today
        and not record.is_mirror
      group by record.employee_id
      having count(*) >= 4
    )
    select
      'deduction_frequency:' || employee.id::text,
      'deduction_frequency',
      case when stats.occurrence_count >= 7 then 'critical' else 'warning' end,
      employee.id,
      employee.employee_no,
      employee.full_name,
      '七天扣款次数预警',
      employee.full_name || ' 近7天被扣款 ' || stats.occurrence_count::text || ' 次',
      v_today - 6,
      v_today,
      stats.occurrence_count,
      pg_catalog.jsonb_build_object(
        'days', 7, 'threshold', 4, 'count', stats.occurrence_count
      ),
      'employee_attendance_records'
    from stats
    join public.employees employee on employee.id = stats.employee_id
    where employee.status in ('active', 'probation', 'suspended');

    insert into pg_temp.admin_alert_group_candidates
    with matching as (
      select record.employee_id, record.note, record.reason
      from public.employee_attendance_records record
      where record.employee_id is not null
        and record.kind = 'adjustment'
        and pg_catalog.lower(record.event_kind) = 'deduction'
        and record.event_date between v_today - 6 and v_today
        and not record.is_mirror
        and pg_catalog.lower(pg_catalog.concat_ws(' ', record.note, record.reason)) ~
          '(迟到|超时|(^|[^[:alnum:]_])late([^[:alnum:]_]|$)|overslept|over[[:space:]-]?(break|smoke)|break[[:space:]]+time|time[[:space:]]+limit)'
    ), stats as (
      select employee_id, count(*)::numeric occurrence_count,
        pg_catalog.jsonb_agg(distinct pg_catalog.left(coalesce(
          nullif(pg_catalog.btrim(note), ''),
          nullif(pg_catalog.btrim(reason), ''), '—'
        ), 160)) reasons
      from matching
      group by employee_id
      having count(*) >= 3
    )
    select
      'late_timeout_frequency:' || employee.id::text,
      'late_timeout_frequency',
      'warning',
      employee.id,
      employee.employee_no,
      employee.full_name,
      '迟到 / 超时频率预警',
      employee.full_name || ' 近7天有 ' || stats.occurrence_count::text || ' 次迟到或超时相关扣款',
      v_today - 6,
      v_today,
      stats.occurrence_count,
      pg_catalog.jsonb_build_object(
        'days', 7, 'threshold', 3, 'count', stats.occurrence_count,
        'reasons', stats.reasons
      ),
      'employee_attendance_records'
    from stats
    join public.employees employee on employee.id = stats.employee_id
    where employee.status in ('active', 'probation', 'suspended');

  elsif v_group = 'attendance' then
    v_alert_types := array['consecutive_rest', 'weekly_absence', 'monthly_leave'];

    create temporary table if not exists admin_alert_group_attendance_days (
      employee_id uuid not null,
      event_date date not null,
      event_kind text not null,
      primary key (employee_id, event_date)
    ) on commit drop;
    truncate table pg_temp.admin_alert_group_attendance_days;

    insert into pg_temp.admin_alert_group_attendance_days(employee_id, event_date, event_kind)
    select distinct on (record.employee_id, record.event_date)
      record.employee_id,
      record.event_date,
      case when pg_catalog.lower(record.event_kind) = 'absent'
        then 'absence' else pg_catalog.lower(record.event_kind) end
    from public.employee_attendance_records record
    where record.employee_id is not null
      and record.kind = 'attendance'
      and record.event_date >= least(
        pg_catalog.date_trunc('month', v_today)::date, v_today - 45
      )
      and record.event_date <= v_today + 31
      and pg_catalog.lower(record.event_kind) in (
        'public_holiday', 'home_leave', 'leave', 'half_day', 'absence', 'absent'
      )
    order by record.employee_id, record.event_date,
      case pg_catalog.lower(record.event_kind)
        when 'absence' then 1 when 'absent' then 1 when 'leave' then 2
        when 'home_leave' then 3 when 'public_holiday' then 4
        when 'half_day' then 5 else 9 end,
      record.updated_at desc,
      record.id desc;

    insert into pg_temp.admin_alert_group_candidates
    with rest_numbered as (
      select day.employee_id, day.event_date,
        day.event_date - (pg_catalog.row_number() over (
          partition by day.employee_id order by day.event_date
        ))::integer island_key
      from pg_temp.admin_alert_group_attendance_days day
      where day.event_kind = 'public_holiday'
        and day.event_date >= v_today - 8
    ), sequences as (
      select employee_id, min(event_date) window_start, max(event_date) window_end,
        count(*)::numeric occurrence_count
      from rest_numbered
      group by employee_id, island_key
      having count(*) >= 2 and max(event_date) >= v_today - 6
    )
    select
      'consecutive_rest:' || employee.id::text || ':' || sequence.window_start::text,
      'consecutive_rest',
      'warning',
      employee.id,
      employee.employee_no,
      employee.full_name,
      '连续公休预警',
      employee.full_name || ' 连续 ' || sequence.occurrence_count::text || ' 天标记为公休',
      sequence.window_start,
      sequence.window_end,
      sequence.occurrence_count,
      pg_catalog.jsonb_build_object(
        'threshold', 2, 'count', sequence.occurrence_count
      ),
      'employee_attendance_records'
    from sequences sequence
    join public.employees employee on employee.id = sequence.employee_id
    where employee.status in ('active', 'probation', 'suspended');

    insert into pg_temp.admin_alert_group_candidates
    with stats as (
      select day.employee_id, count(*)::numeric occurrence_count
      from pg_temp.admin_alert_group_attendance_days day
      where day.event_kind = 'absence'
        and day.event_date between v_today - 6 and v_today
      group by day.employee_id
      having count(*) >= 2
    )
    select
      'weekly_absence:' || employee.id::text,
      'weekly_absence',
      case when stats.occurrence_count >= 3 then 'critical' else 'warning' end,
      employee.id,
      employee.employee_no,
      employee.full_name,
      '一周缺席次数预警',
      employee.full_name || ' 近7天缺席 ' || stats.occurrence_count::text || ' 天',
      v_today - 6,
      v_today,
      stats.occurrence_count,
      pg_catalog.jsonb_build_object(
        'days', 7, 'threshold', 2, 'count', stats.occurrence_count
      ),
      'employee_attendance_records'
    from stats
    join public.employees employee on employee.id = stats.employee_id
    where employee.status in ('active', 'probation', 'suspended');

    insert into pg_temp.admin_alert_group_candidates
    with stats as (
      select day.employee_id,
        sum(case when day.event_kind = 'half_day' then 0.5 else 1 end)::numeric occurrence_count,
        count(*) filter (where day.event_kind = 'public_holiday') public_holiday,
        count(*) filter (where day.event_kind = 'leave') leave_days,
        count(*) filter (where day.event_kind = 'absence') absence_days,
        count(*) filter (where day.event_kind = 'half_day') half_days
      from pg_temp.admin_alert_group_attendance_days day
      where day.event_date >= pg_catalog.date_trunc('month', v_today)::date
        and day.event_date <= v_today
        and day.event_kind in ('public_holiday', 'leave', 'absence', 'half_day')
      group by day.employee_id
      having sum(case when day.event_kind = 'half_day' then 0.5 else 1 end) > 5
    )
    select
      'monthly_leave:' || employee.id::text || ':' || pg_catalog.to_char(v_today, 'YYYY-MM'),
      'monthly_leave',
      case when stats.occurrence_count >= 8 then 'critical' else 'warning' end,
      employee.id,
      employee.employee_no,
      employee.full_name,
      '当月休假天数预警',
      employee.full_name || ' 本月累计休假 ' || stats.occurrence_count::text || ' 天（回家不计）',
      pg_catalog.date_trunc('month', v_today)::date,
      v_today,
      stats.occurrence_count,
      pg_catalog.jsonb_build_object(
        'threshold', 5,
        'count', stats.occurrence_count,
        'public_holiday', stats.public_holiday,
        'leave', stats.leave_days,
        'absence', stats.absence_days,
        'half_day', stats.half_days,
        'home_leave_excluded', true
      ),
      'employee_attendance_records'
    from stats
    join public.employees employee on employee.id = stats.employee_id
    where employee.status in ('active', 'probation', 'suspended');

  else
    v_alert_types := array['exam_failed', 'resigned_account_active'];

    insert into pg_temp.admin_alert_group_candidates
    with ranked as (
      select session.*,
        pg_catalog.row_number() over (
          partition by session.employee_id
          order by coalesce(session.graded_at, session.submitted_at, session.started_at) desc,
            session.source_system desc, session.id desc
        ) result_rank
      from public.admin_exam_combined_sessions_v session
      where session.employee_id is not null
        and session.id is not null
        and session.status = 'graded'
        and session.passed is not null
    ), latest_failed as (
      select * from ranked where result_rank = 1 and passed = false
    )
    select
      'exam_failed:' || employee.id::text,
      'exam_failed',
      'warning',
      employee.id,
      employee.employee_no,
      employee.full_name,
      '最近一次考试不及格',
      employee.full_name || ' 最近一次已评分考试未及格：' ||
        coalesce(nullif(pg_catalog.btrim(failed.title), ''), '未命名考试') || '（' ||
        coalesce(pg_catalog.btrim(pg_catalog.to_char(failed.percentage, 'FM999999990D00')), '—') || '%）',
      (coalesce(failed.graded_at, failed.submitted_at, failed.started_at)
        at time zone 'Asia/Manila')::date,
      (coalesce(failed.graded_at, failed.submitted_at, failed.started_at)
        at time zone 'Asia/Manila')::date,
      1,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'session_id', failed.id,
        'source_system', failed.source_system,
        'exam_title', failed.title,
        'percentage', failed.percentage,
        'graded_at', failed.graded_at,
        'rule', 'latest_graded_attempt_failed'
      )),
      coalesce(nullif(pg_catalog.btrim(failed.source_system), ''), 'exam')
        || ':' || failed.id::text
    from latest_failed failed
    join public.employees employee on employee.id = failed.employee_id
    where employee.status in ('active', 'probation', 'suspended');

    insert into pg_temp.admin_alert_group_candidates
    with access_stats as (
      select access.employee_id,
        count(*)::numeric account_count,
        pg_catalog.bool_or(access.active) active_access,
        pg_catalog.bool_or(access.backend_enabled) backend_enabled,
        pg_catalog.bool_or(access.employee_portal_enabled) employee_portal_enabled
      from public.user_access access
      join public.employees employee on employee.id = access.employee_id
      where employee.status = 'resigned'
        and (
          access.active
          or access.backend_enabled
          or access.employee_portal_enabled
        )
      group by access.employee_id
    )
    select
      'resigned_account_active:' || employee.id::text,
      'resigned_account_active',
      'critical',
      employee.id,
      employee.employee_no,
      employee.full_name,
      '离职账号未回收',
      employee.full_name || ' 已离职，但仍有 ' || stats.account_count::text ||
        ' 个登录映射处于启用状态，请人工核对并回收权限',
      coalesce(employee.resign_date, v_today),
      v_today,
      stats.account_count,
      pg_catalog.jsonb_build_object(
        'account_count', stats.account_count,
        'active', stats.active_access,
        'backend_enabled', stats.backend_enabled,
        'employee_portal_enabled', stats.employee_portal_enabled,
        'automatic_disable', false
      ),
      'user_access'
    from access_stats stats
    join public.employees employee on employee.id = stats.employee_id;
  end if;

  insert into public.admin_alert_events (
    alert_key, condition_key, alert_type, severity, employee_id, employee_no,
    employee_name, title, message, window_start, window_end, occurrence_count,
    payload, source_ref, is_active, last_seen_at, resolved_at
  )
  select candidate.condition_key || ':' || pg_catalog.gen_random_uuid()::text,
    candidate.condition_key, candidate.alert_type, candidate.severity,
    candidate.employee_id, candidate.employee_no, candidate.employee_name,
    candidate.title, candidate.message, candidate.window_start,
    candidate.window_end, candidate.occurrence_count, candidate.payload,
    candidate.source_ref, true, pg_catalog.clock_timestamp(), null
  from pg_temp.admin_alert_group_candidates candidate
  on conflict (condition_key) where is_active do update set
    alert_type = excluded.alert_type,
    severity = excluded.severity,
    employee_id = excluded.employee_id,
    employee_no = excluded.employee_no,
    employee_name = excluded.employee_name,
    title = excluded.title,
    message = excluded.message,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    occurrence_count = excluded.occurrence_count,
    payload = excluded.payload,
    source_ref = excluded.source_ref,
    alert_cycle = case
      when public.admin_alert_events.severity <> 'critical'
       and excluded.severity = 'critical'
      then public.admin_alert_events.alert_cycle + 1
      when v_group = 'access_exam'
       and (
         public.admin_alert_events.source_ref is distinct from excluded.source_ref
         or public.admin_alert_events.payload is distinct from excluded.payload
       )
      then public.admin_alert_events.alert_cycle + 1
      else public.admin_alert_events.alert_cycle
    end,
    is_active = true,
    last_seen_at = pg_catalog.clock_timestamp(),
    resolved_at = null;
  get diagnostics v_upserted = row_count;

  update public.admin_alert_events event
  set is_active = false,
      last_seen_at = pg_catalog.clock_timestamp(),
      resolved_at = coalesce(event.resolved_at, pg_catalog.clock_timestamp())
  where event.is_active
    and event.alert_type = any(v_alert_types)
    and not exists (
      select 1
      from pg_temp.admin_alert_group_candidates candidate
      where candidate.condition_key = event.condition_key
    );
  get diagnostics v_resolved = row_count;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'group', v_group,
    'as_of', pg_catalog.clock_timestamp(),
    'duration_ms', pg_catalog.round(
      extract(epoch from (pg_catalog.clock_timestamp() - v_started_at)) * 1000,
      1
    ),
    'active', (
      select count(*)
      from public.admin_alert_events event
      where event.is_active and event.alert_type = any(v_alert_types)
    ),
    'upserted', v_upserted,
    'resolved', v_resolved
  );
end;
$$;

revoke all on function alerts_private.refresh_alert_group(text)
  from public, anon, authenticated;

comment on function alerts_private.refresh_alert_group(text) is
  'Bounded disjoint alert refresh. Uses only the previous stable 3-day/6-error rule; the experimental 1/3/7 detector is absent. Automatic schedules are activated separately after production canaries.';

notify pgrst, 'reload schema';

commit;
