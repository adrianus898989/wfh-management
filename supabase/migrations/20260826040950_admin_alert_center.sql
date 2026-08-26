begin;

-- Durable, permission-aware admin alerts. The underlying tables stay outside
-- the browser Data API; admins can only read or acknowledge alerts through the
-- scoped RPCs below.
create schema if not exists alerts_private;
revoke all on schema alerts_private from public, anon, authenticated;

create table if not exists public.admin_alert_events (
  id uuid primary key default gen_random_uuid(),
  alert_key text not null unique,
  condition_key text not null,
  alert_type text not null,
  severity text not null default 'warning',
  employee_id uuid references public.employees(id) on delete set null,
  employee_no text not null,
  employee_name text not null,
  title text not null,
  message text not null,
  window_start date,
  window_end date,
  occurrence_count numeric not null default 1,
  payload jsonb not null default '{}'::jsonb,
  source_ref text,
  is_active boolean not null default true,
  alert_cycle integer not null default 1,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  constraint admin_alert_events_type_check check (alert_type in (
    'payout_change',
    'error_spike',
    'deduction_frequency',
    'late_timeout_frequency',
    'consecutive_rest',
    'weekly_absence',
    'monthly_leave'
  )),
  constraint admin_alert_events_severity_check
    check (severity in ('info', 'warning', 'critical')),
  constraint admin_alert_events_count_check check (occurrence_count >= 0),
  constraint admin_alert_events_cycle_check check (alert_cycle > 0),
  constraint admin_alert_events_condition_key_check check (btrim(condition_key) <> ''),
  constraint admin_alert_events_payload_object_check
    check (jsonb_typeof(payload) = 'object')
);

create table if not exists public.admin_alert_read_receipts (
  alert_id uuid not null references public.admin_alert_events(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  alert_cycle integer not null,
  read_at timestamptz not null default clock_timestamp(),
  primary key (alert_id, auth_user_id, alert_cycle),
  constraint admin_alert_read_receipts_cycle_check check (alert_cycle > 0)
);

create index if not exists admin_alert_events_active_seen_idx
  on public.admin_alert_events (is_active, last_seen_at desc, id desc);
create unique index if not exists admin_alert_events_condition_active_uidx
  on public.admin_alert_events (condition_key) where is_active;
create index if not exists admin_alert_events_condition_history_idx
  on public.admin_alert_events (condition_key, first_seen_at desc);
create index if not exists admin_alert_events_type_active_seen_idx
  on public.admin_alert_events (alert_type, is_active, last_seen_at desc, id desc);
create index if not exists admin_alert_events_employee_active_idx
  on public.admin_alert_events (employee_id, is_active, last_seen_at desc);
create index if not exists admin_alert_read_receipts_user_idx
  on public.admin_alert_read_receipts (auth_user_id, read_at desc);

alter table public.admin_alert_events enable row level security;
alter table public.admin_alert_read_receipts enable row level security;
revoke all on table public.admin_alert_events from public, anon, authenticated;
revoke all on table public.admin_alert_read_receipts from public, anon, authenticated;
grant select, insert, update, delete on table public.admin_alert_events to service_role;
grant select, insert, update, delete on table public.admin_alert_read_receipts to service_role;

drop policy if exists admin_alert_events_no_direct_access on public.admin_alert_events;
create policy admin_alert_events_no_direct_access
on public.admin_alert_events for all to anon, authenticated
using (false) with check (false);

drop policy if exists admin_alert_read_receipts_no_direct_access
  on public.admin_alert_read_receipts;
create policy admin_alert_read_receipts_no_direct_access
on public.admin_alert_read_receipts for all to anon, authenticated
using (false) with check (false);

create or replace function alerts_private.caller_can_view_alert_type(p_alert_type text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_alert_type
    when 'payout_change' then public.has_permission('payroll.payout_change.review')
    when 'error_spike' then public.has_permission('report.view')
    when 'deduction_frequency' then public.has_permission('adjustment.view')
    when 'late_timeout_frequency' then public.has_permission('adjustment.view')
    when 'consecutive_rest' then public.has_permission('attendance.view')
    when 'weekly_absence' then public.has_permission('attendance.view')
    when 'monthly_leave' then public.has_permission('attendance.view')
    else false
  end;
$$;

revoke all on function alerts_private.caller_can_view_alert_type(text)
  from public, anon, authenticated;

create or replace function alerts_private.refresh_alerts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (clock_timestamp() at time zone 'Asia/Manila')::date;
  v_upserted integer := 0;
  v_resolved integer := 0;
begin
  -- Prevent overlapping cron/manual scans. Every resolved incident remains an
  -- immutable history row; a later recurrence receives a new alert id.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('alerts_private.refresh_alerts', 0)
  ) then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'refresh_running');
  end if;

  -- The transaction-local candidate set makes one refresh atomic: alerts are
  -- first recalculated, then stale active alerts are resolved in the same run.
  create temporary table if not exists admin_alert_candidates (
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
  truncate table pg_temp.admin_alert_candidates;

  create temporary table if not exists admin_alert_attendance_days (
    employee_id uuid not null,
    event_date date not null,
    event_kind text not null,
    primary key (employee_id, event_date)
  ) on commit drop;
  truncate table pg_temp.admin_alert_attendance_days;

  insert into pg_temp.admin_alert_attendance_days(employee_id, event_date, event_kind)
  select distinct on (record.employee_id, record.event_date)
    record.employee_id,
    record.event_date,
    case when lower(record.event_kind) = 'absent' then 'absence'
      else lower(record.event_kind) end
  from public.employee_attendance_records record
  where record.employee_id is not null
    and record.kind = 'attendance'
    and record.event_date >= least(date_trunc('month', v_today)::date, v_today - 45)
    -- Future rows are loaded only so consecutive public-rest schedules can be
    -- warned before they happen. Other rules below still cap at v_today.
    and record.event_date <= v_today + 31
    and lower(record.event_kind) in (
      'public_holiday', 'home_leave', 'leave', 'half_day', 'absence', 'absent'
    )
  order by record.employee_id, record.event_date,
    case lower(record.event_kind)
      when 'absence' then 1 when 'absent' then 1 when 'leave' then 2
      when 'home_leave' then 3 when 'public_holiday' then 4
      when 'half_day' then 5 else 9 end,
    record.updated_at desc,
    record.id desc;

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

  -- More than three deductions in seven days means four or more records.
  insert into pg_temp.admin_alert_candidates
  with stats as (
    select record.employee_id, count(*)::numeric occurrence_count
    from public.employee_attendance_records record
    where record.employee_id is not null
      and record.kind = 'adjustment'
      and lower(record.event_kind) = 'deduction'
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
    jsonb_build_object('days', 7, 'threshold', 4, 'count', stats.occurrence_count),
    'employee_attendance_records'
  from stats
  join public.employees employee on employee.id = stats.employee_id
  where employee.status in ('active', 'probation', 'suspended');

  -- Repeated late/timeout reasons are called out separately so reviewers do
  -- not need to discover the pattern inside the generic deduction warning.
  insert into pg_temp.admin_alert_candidates
  with matching as (
    select record.employee_id, record.note, record.reason
    from public.employee_attendance_records record
    where record.employee_id is not null
      and record.kind = 'adjustment'
      and lower(record.event_kind) = 'deduction'
      and record.event_date between v_today - 6 and v_today
      and not record.is_mirror
      and lower(concat_ws(' ', record.note, record.reason)) ~
        '(迟到|超时|(^|[^[:alnum:]_])late([^[:alnum:]_]|$)|overslept|over[[:space:]-]?(break|smoke)|break[[:space:]]+time|time[[:space:]]+limit)'
  ), stats as (
    select employee_id, count(*)::numeric occurrence_count,
      jsonb_agg(distinct left(coalesce(nullif(btrim(note), ''), nullif(btrim(reason), ''), '—'), 160)) reasons
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
    jsonb_build_object('days', 7, 'threshold', 3, 'count', stats.occurrence_count, 'reasons', stats.reasons),
    'employee_attendance_records'
  from stats
  join public.employees employee on employee.id = stats.employee_id
  where employee.status in ('active', 'probation', 'suspended');

  -- Collapse adjacent public-holiday dates into one sequence so a three-day
  -- run creates one warning, not two overlapping pairs.
  insert into pg_temp.admin_alert_candidates
  with rest_numbered as (
    select day.employee_id, day.event_date,
      day.event_date - (row_number() over (
        partition by day.employee_id order by day.event_date
      ))::integer island_key
    from pg_temp.admin_alert_attendance_days day
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
    jsonb_build_object('threshold', 2, 'count', sequence.occurrence_count),
    'employee_attendance_records'
  from sequences sequence
  join public.employees employee on employee.id = sequence.employee_id
  where employee.status in ('active', 'probation', 'suspended');

  insert into pg_temp.admin_alert_candidates
  with stats as (
    select day.employee_id, count(*)::numeric occurrence_count
    from pg_temp.admin_alert_attendance_days day
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
    jsonb_build_object('days', 7, 'threshold', 2, 'count', stats.occurrence_count),
    'employee_attendance_records'
  from stats
  join public.employees employee on employee.id = stats.employee_id
  where employee.status in ('active', 'probation', 'suspended');

  -- Home leave is deliberately excluded. Half days contribute 0.5.
  insert into pg_temp.admin_alert_candidates
  with stats as (
    select day.employee_id,
      sum(case when day.event_kind = 'half_day' then 0.5 else 1 end)::numeric occurrence_count,
      count(*) filter (where day.event_kind = 'public_holiday') public_holiday,
      count(*) filter (where day.event_kind = 'leave') leave_days,
      count(*) filter (where day.event_kind = 'absence') absence_days,
      count(*) filter (where day.event_kind = 'half_day') half_days
    from pg_temp.admin_alert_attendance_days day
    where day.event_date >= date_trunc('month', v_today)::date
      and day.event_date <= v_today
      and day.event_kind in ('public_holiday', 'leave', 'absence', 'half_day')
    group by day.employee_id
    having sum(case when day.event_kind = 'half_day' then 0.5 else 1 end) > 5
  )
  select
    'monthly_leave:' || employee.id::text || ':' || to_char(v_today, 'YYYY-MM'),
    'monthly_leave',
    case when stats.occurrence_count >= 8 then 'critical' else 'warning' end,
    employee.id,
    employee.employee_no,
    employee.full_name,
    '当月休假天数预警',
    employee.full_name || ' 本月累计休假 ' || stats.occurrence_count::text || ' 天（回家不计）',
    date_trunc('month', v_today)::date,
    v_today,
    stats.occurrence_count,
    jsonb_build_object(
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

  insert into public.admin_alert_events (
    alert_key, condition_key, alert_type, severity, employee_id, employee_no, employee_name,
    title, message, window_start, window_end, occurrence_count, payload,
    source_ref, is_active, last_seen_at, resolved_at
  )
  select candidate.condition_key || ':' || gen_random_uuid()::text,
    candidate.condition_key, candidate.alert_type, candidate.severity,
    candidate.employee_id, candidate.employee_no, candidate.employee_name,
    candidate.title, candidate.message, candidate.window_start,
    candidate.window_end, candidate.occurrence_count, candidate.payload,
    candidate.source_ref, true, clock_timestamp(), null
  from pg_temp.admin_alert_candidates candidate
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
      else public.admin_alert_events.alert_cycle
    end,
    is_active = true,
    last_seen_at = clock_timestamp(),
    resolved_at = null;
  get diagnostics v_upserted = row_count;

  update public.admin_alert_events event
  set is_active = false,
      last_seen_at = clock_timestamp(),
      resolved_at = coalesce(event.resolved_at, clock_timestamp())
  where event.is_active = true
    and event.alert_type in (
      'error_spike', 'deduction_frequency',
      'late_timeout_frequency', 'consecutive_rest', 'weekly_absence',
      'monthly_leave'
    )
    and not exists (
      select 1 from pg_temp.admin_alert_candidates candidate
      where candidate.condition_key = event.condition_key
    );
  get diagnostics v_resolved = row_count;

  return jsonb_build_object(
    'ok', true,
    'as_of', clock_timestamp(),
    'active', (select count(*) from public.admin_alert_events where is_active),
    'upserted', v_upserted,
    'resolved', v_resolved
  );
end;
$$;

revoke all on function alerts_private.refresh_alerts()
  from public, anon, authenticated;

create or replace function alerts_private.sync_payout_change_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees%rowtype;
begin
  if tg_op = 'DELETE' then
    update public.admin_alert_events event
    set is_active = false,
        last_seen_at = clock_timestamp(),
        resolved_at = coalesce(event.resolved_at, clock_timestamp()),
        payload = event.payload || jsonb_build_object('request_status', 'deleted')
    where event.condition_key = 'payout_change:' || old.id::text
      and event.is_active = true;
    return old;
  end if;

  select * into v_employee
  from public.employees employee
  where employee.id = new.employee_id;

  if new.status = 'pending' then
    insert into public.admin_alert_events (
      alert_key, condition_key, alert_type, severity, employee_id, employee_no, employee_name,
      title, message, window_start, window_end, occurrence_count, payload,
      source_ref, is_active, last_seen_at, resolved_at
    ) values (
      'payout_change:' || new.id::text || ':' || gen_random_uuid()::text,
      'payout_change:' || new.id::text,
      'payout_change',
      'info',
      new.employee_id,
      v_employee.employee_no,
      v_employee.full_name,
      '收款资料待审核',
      v_employee.full_name || ' 提交了收款资料修改申请',
      (new.created_at at time zone 'Asia/Manila')::date,
      (new.created_at at time zone 'Asia/Manila')::date,
      1,
      jsonb_build_object(
        'request_id', new.id,
        'payment_kind', new.payment_kind,
        'reason', new.reason
      ),
      new.id::text,
      true,
      clock_timestamp(),
      null
    )
    on conflict (condition_key) where is_active do update set
      employee_no = excluded.employee_no,
      employee_name = excluded.employee_name,
      message = excluded.message,
      payload = excluded.payload,
      last_seen_at = clock_timestamp(),
      resolved_at = null;
  else
    update public.admin_alert_events event
    set is_active = false,
        last_seen_at = clock_timestamp(),
        resolved_at = coalesce(event.resolved_at, clock_timestamp()),
        payload = event.payload || jsonb_build_object('request_status', new.status)
    where event.condition_key = 'payout_change:' || new.id::text
      and event.is_active = true;
  end if;
  return new;
end;
$$;

revoke all on function alerts_private.sync_payout_change_alert()
  from public, anon, authenticated;

drop trigger if exists payout_change_admin_alert_trigger
  on public.payout_change_requests;
create trigger payout_change_admin_alert_trigger
after insert or update of status, payment_kind, reason
on public.payout_change_requests
for each row execute function alerts_private.sync_payout_change_alert();

drop trigger if exists payout_change_admin_alert_delete_trigger
  on public.payout_change_requests;
create trigger payout_change_admin_alert_delete_trigger
after delete on public.payout_change_requests
for each row execute function alerts_private.sync_payout_change_alert();

-- Seed requests that were already pending when this feature was installed.
-- Thereafter the row trigger is the only writer for payout-change alerts, so a
-- scheduled aggregate refresh can never race and undo a reviewer action.
insert into public.admin_alert_events (
  alert_key, condition_key, alert_type, severity, employee_id, employee_no,
  employee_name, title, message, window_start, window_end, occurrence_count,
  payload, source_ref, is_active, last_seen_at, resolved_at
)
select
  'payout_change:' || request.id::text || ':' || gen_random_uuid()::text,
  'payout_change:' || request.id::text,
  'payout_change',
  'info',
  employee.id,
  employee.employee_no,
  employee.full_name,
  '收款资料待审核',
  employee.full_name || ' 提交了收款资料修改申请',
  (request.created_at at time zone 'Asia/Manila')::date,
  (request.created_at at time zone 'Asia/Manila')::date,
  1,
  jsonb_build_object(
    'request_id', request.id,
    'payment_kind', request.payment_kind,
    'reason', request.reason
  ),
  request.id::text,
  true,
  clock_timestamp(),
  null
from public.payout_change_requests request
join public.employees employee on employee.id = request.employee_id
where request.status = 'pending'
on conflict (condition_key) where is_active do update set
  employee_no = excluded.employee_no,
  employee_name = excluded.employee_name,
  message = excluded.message,
  payload = excluded.payload,
  last_seen_at = excluded.last_seen_at;

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
  v_user_id uuid := (select auth.uid());
  v_status text := lower(btrim(coalesce(p_filters->>'status', 'active')));
  v_type text := lower(btrim(coalesce(p_filters->>'alert_type', '')));
  v_severity text := lower(btrim(coalesce(p_filters->>'severity', '')));
  v_search text := lower(btrim(coalesce(p_filters->>'search', '')));
  v_unread_only boolean := lower(coalesce(p_filters->>'unread_only', 'false')) = 'true';
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 1000000);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not (
    public.has_permission('payroll.payout_change.review')
    or public.has_permission('report.view')
    or public.has_permission('adjustment.view')
    or public.has_permission('attendance.view')
  ) then raise exception 'permission_denied'; end if;
  if v_status not in ('all', 'active', 'resolved') then
    raise exception 'invalid_alert_status';
  end if;
  if v_severity <> '' and v_severity not in ('info', 'warning', 'critical') then
    raise exception 'invalid_alert_severity';
  end if;
  if v_type <> '' and v_type not in (
    'payout_change', 'error_spike', 'deduction_frequency',
    'late_timeout_frequency', 'consecutive_rest', 'weekly_absence',
    'monthly_leave'
  ) then raise exception 'invalid_alert_type'; end if;

  with visible as materialized (
    select event.*,
      (
        event.is_active
        and receipt.alert_id is null
      ) unread
    from public.admin_alert_events event
    left join public.admin_alert_read_receipts receipt
      on receipt.alert_id = event.id
     and receipt.auth_user_id = v_user_id
     and receipt.alert_cycle = event.alert_cycle
    where alerts_private.caller_can_view_alert_type(event.alert_type)
      and (
        public.backend_employee_in_scope(event.employee_id)
        or (event.employee_id is null and public.is_founder())
      )
  ), filtered as materialized (
    select * from visible alert
    where (v_status = 'all'
      or (v_status = 'active' and alert.is_active)
      or (v_status = 'resolved' and not alert.is_active))
      and (v_type = '' or alert.alert_type = v_type)
      and (v_severity = '' or alert.severity = v_severity)
      and (not v_unread_only or alert.unread)
      and (
        v_search = ''
        or lower(concat_ws(' ', alert.employee_no, alert.employee_name,
          alert.title, alert.message)) like '%' || v_search || '%'
      )
  ), paged as materialized (
    select * from filtered
    order by is_active desc, last_seen_at desc, id desc
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from filtered),
    'pages', greatest(1, ceil((select count(*) from filtered)::numeric / v_page_size)::integer),
    'active_total', (select count(*) from visible where is_active),
    'unread_total', (select count(*) from visible where is_active and unread),
    'type_counts', coalesce((
      select jsonb_object_agg(alert_type, total order by alert_type)
      from (
        select alert_type, count(*) total
        from visible where is_active group by alert_type
      ) counts
    ), '{}'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', alert.id,
        'alert_key', alert.alert_key,
        'alert_type', alert.alert_type,
        'severity', alert.severity,
        'employee_id', alert.employee_id,
        'employee_no', alert.employee_no,
        'employee_name', alert.employee_name,
        'title', alert.title,
        'message', alert.message,
        'window_start', alert.window_start,
        'window_end', alert.window_end,
        'occurrence_count', alert.occurrence_count,
        'payload', alert.payload,
        'source_ref', alert.source_ref,
        'is_active', alert.is_active,
        'unread', alert.unread,
        'first_seen_at', alert.first_seen_at,
        'last_seen_at', alert.last_seen_at,
        'resolved_at', alert.resolved_at
      ) order by alert.is_active desc, alert.last_seen_at desc, alert.id desc)
      from paged alert
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_alert_center(jsonb, integer, integer)
  from public, anon;
grant execute on function public.admin_alert_center(jsonb, integer, integer)
  to authenticated, service_role;

create or replace function public.admin_alert_mark_read(p_alert_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_marked integer := 0;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  if p_alert_id is not null and not exists (
    select 1
    from public.admin_alert_events event
    where event.id = p_alert_id
      and alerts_private.caller_can_view_alert_type(event.alert_type)
      and (
        public.backend_employee_in_scope(event.employee_id)
        or (event.employee_id is null and public.is_founder())
      )
  ) then raise exception 'alert_not_found_or_out_of_scope'; end if;

  insert into public.admin_alert_read_receipts(
    alert_id, auth_user_id, alert_cycle, read_at
  )
  select event.id, v_user_id, event.alert_cycle, clock_timestamp()
  from public.admin_alert_events event
  where event.is_active
    and (p_alert_id is null or event.id = p_alert_id)
    and alerts_private.caller_can_view_alert_type(event.alert_type)
    and (
      public.backend_employee_in_scope(event.employee_id)
      or (event.employee_id is null and public.is_founder())
    )
  on conflict (alert_id, auth_user_id, alert_cycle) do update
  set read_at = excluded.read_at;
  get diagnostics v_marked = row_count;

  return jsonb_build_object('ok', true, 'marked', v_marked);
end;
$$;

revoke all on function public.admin_alert_mark_read(uuid) from public, anon;
grant execute on function public.admin_alert_mark_read(uuid)
  to authenticated, service_role;

-- A five-minute database-local scan avoids external requests and keeps costs
-- predictable. Payment-change notifications remain immediate via the trigger.
select cron.unschedule(jobid)
from cron.job
where jobname = 'admin-alert-refresh';

select cron.schedule(
  'admin-alert-refresh',
  '*/5 * * * *',
  $schedule$select alerts_private.refresh_alerts();$schedule$
);

select alerts_private.refresh_alerts();

comment on table public.admin_alert_events is
  'Durable admin warning history; direct browser access is denied and scoped RPCs enforce permissions.';
comment on function public.admin_alert_center(jsonb, integer, integer) is
  'Returns paginated alert rows limited by the caller permission set and employee data scope.';
comment on function public.admin_alert_mark_read(uuid) is
  'Acknowledges one or all currently visible active alerts for the current admin alert cycle.';

notify pgrst, 'reload schema';

commit;
