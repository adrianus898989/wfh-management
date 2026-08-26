begin;

-- Keep the original seven alert rules and add only rules backed by an
-- authoritative employee identity and an unambiguous state. The remaining
-- requested categories are presented by the UI as pending integrations until
-- their source contract and thresholds are defined.
alter table public.admin_alert_events
  drop constraint admin_alert_events_type_check;
alter table public.admin_alert_events
  add constraint admin_alert_events_type_check check (alert_type in (
    'payout_change',
    'error_spike',
    'deduction_frequency',
    'late_timeout_frequency',
    'consecutive_rest',
    'weekly_absence',
    'monthly_leave',
    'exam_failed',
    'resigned_account_active'
  ));

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
    when 'exam_failed' then public.has_permission('exam.view')
    when 'resigned_account_active' then
      public.has_permission('account.view') or public.has_permission('user.view')
    else false
  end;
$$;

revoke all on function alerts_private.caller_can_view_alert_type(text)
  from public, anon, authenticated;

create or replace function alerts_private.refresh_extended_alerts()
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
  -- The core refresh takes the same transaction-scoped lock. Advisory locks
  -- are re-entrant for the current transaction, while a concurrent refresh
  -- fails closed instead of racing the candidate/resolution phases.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('alerts_private.refresh_alerts', 0)
  ) then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'refresh_running');
  end if;

  create temporary table if not exists admin_alert_extended_candidates (
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
  truncate table pg_temp.admin_alert_extended_candidates;

  -- One actionable exam alert per employee. A later passing result resolves the
  -- condition; a different failed result advances the alert cycle so it becomes
  -- unread again without duplicating the still-active incident.
  insert into pg_temp.admin_alert_extended_candidates
  with ranked as (
    select session.*,
      row_number() over (
        partition by session.employee_id
        order by coalesce(session.graded_at, session.submitted_at, session.started_at) desc,
          session.source_system desc, session.id desc
      ) as result_rank
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
      coalesce(nullif(btrim(failed.title), ''), '未命名考试') || '（' ||
      coalesce(trim(to_char(failed.percentage, 'FM999999990D00')), '—') || '%）',
    (coalesce(failed.graded_at, failed.submitted_at, failed.started_at)
      at time zone 'Asia/Manila')::date,
    (coalesce(failed.graded_at, failed.submitted_at, failed.started_at)
      at time zone 'Asia/Manila')::date,
    1,
    jsonb_strip_nulls(jsonb_build_object(
      'session_id', failed.id,
      'source_system', failed.source_system,
      'exam_title', failed.title,
      'percentage', failed.percentage,
      'graded_at', failed.graded_at,
      'rule', 'latest_graded_attempt_failed'
    )),
    coalesce(nullif(btrim(failed.source_system), ''), 'exam') || ':' || failed.id::text
  from latest_failed failed
  join public.employees employee on employee.id = failed.employee_id
  where employee.status in ('active', 'probation', 'suspended');

  -- Employment status is the authority for departure. Any still-enabled linked
  -- access row requires manual recovery; this rule never disables an account.
  insert into pg_temp.admin_alert_extended_candidates
  with access_stats as (
    select access.employee_id,
      count(*)::numeric account_count,
      bool_or(access.active) active_access,
      bool_or(access.backend_enabled) backend_enabled,
      bool_or(access.employee_portal_enabled) employee_portal_enabled
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
    jsonb_build_object(
      'account_count', stats.account_count,
      'active', stats.active_access,
      'backend_enabled', stats.backend_enabled,
      'employee_portal_enabled', stats.employee_portal_enabled,
      'automatic_disable', false
    ),
    'user_access'
  from access_stats stats
  join public.employees employee on employee.id = stats.employee_id;

  insert into public.admin_alert_events (
    alert_key, condition_key, alert_type, severity, employee_id, employee_no,
    employee_name, title, message, window_start, window_end, occurrence_count,
    payload, source_ref, is_active, last_seen_at, resolved_at
  )
  select candidate.condition_key || ':' || gen_random_uuid()::text,
    candidate.condition_key, candidate.alert_type, candidate.severity,
    candidate.employee_id, candidate.employee_no, candidate.employee_name,
    candidate.title, candidate.message, candidate.window_start,
    candidate.window_end, candidate.occurrence_count, candidate.payload,
    candidate.source_ref, true, clock_timestamp(), null
  from pg_temp.admin_alert_extended_candidates candidate
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
      when public.admin_alert_events.source_ref is distinct from excluded.source_ref
        or public.admin_alert_events.payload is distinct from excluded.payload
      then public.admin_alert_events.alert_cycle + 1
      else public.admin_alert_events.alert_cycle
    end,
    is_active = true,
    last_seen_at = clock_timestamp(),
    resolved_at = null
  where (
    public.admin_alert_events.alert_type,
    public.admin_alert_events.severity,
    public.admin_alert_events.employee_id,
    public.admin_alert_events.employee_no,
    public.admin_alert_events.employee_name,
    public.admin_alert_events.title,
    public.admin_alert_events.message,
    public.admin_alert_events.window_start,
    public.admin_alert_events.window_end,
    public.admin_alert_events.occurrence_count,
    public.admin_alert_events.payload,
    public.admin_alert_events.source_ref
  ) is distinct from (
    excluded.alert_type,
    excluded.severity,
    excluded.employee_id,
    excluded.employee_no,
    excluded.employee_name,
    excluded.title,
    excluded.message,
    excluded.window_start,
    excluded.window_end,
    excluded.occurrence_count,
    excluded.payload,
    excluded.source_ref
  );
  get diagnostics v_upserted = row_count;

  update public.admin_alert_events event
  set is_active = false,
      last_seen_at = clock_timestamp(),
      resolved_at = coalesce(event.resolved_at, clock_timestamp())
  where event.is_active
    and event.alert_type in ('exam_failed', 'resigned_account_active')
    and not exists (
      select 1
      from pg_temp.admin_alert_extended_candidates candidate
      where candidate.condition_key = event.condition_key
    );
  get diagnostics v_resolved = row_count;

  return jsonb_build_object(
    'ok', true,
    'as_of', clock_timestamp(),
    'active', (
      select count(*) from public.admin_alert_events
      where is_active and alert_type in ('exam_failed', 'resigned_account_active')
    ),
    'upserted', v_upserted,
    'resolved', v_resolved
  );
end;
$$;

revoke all on function alerts_private.refresh_extended_alerts()
  from public, anon, authenticated;

-- Preserve the audited seven-rule implementation unchanged and compose the two
-- new rules behind the existing refresh entry point used by pg_cron.
alter function alerts_private.refresh_alerts() rename to refresh_core_alerts;
revoke all on function alerts_private.refresh_core_alerts()
  from public, anon, authenticated;

create or replace function alerts_private.refresh_alerts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_core jsonb;
  v_extended jsonb;
begin
  v_core := alerts_private.refresh_core_alerts();
  if coalesce((v_core->>'skipped')::boolean, false) then
    return v_core;
  end if;

  v_extended := alerts_private.refresh_extended_alerts();
  return v_core || jsonb_build_object('extended', v_extended);
end;
$$;

revoke all on function alerts_private.refresh_alerts()
  from public, anon, authenticated;

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
  v_group text := lower(btrim(coalesce(p_filters->>'group', 'all')));
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
    or public.has_permission('daily_work.manage')
    or public.has_permission('exam.view')
    or public.has_permission('account.view')
    or public.has_permission('user.view')
  ) then raise exception 'permission_denied'; end if;
  if v_status not in ('all', 'active', 'resolved') then
    raise exception 'invalid_alert_status';
  end if;
  if v_group not in ('all', 'account', 'attendance', 'quality') then
    raise exception 'invalid_alert_group';
  end if;
  if v_severity <> '' and v_severity not in ('info', 'warning', 'critical') then
    raise exception 'invalid_alert_severity';
  end if;
  if v_type <> '' and v_type not in (
    'payout_change', 'error_spike', 'deduction_frequency',
    'late_timeout_frequency', 'consecutive_rest', 'weekly_absence',
    'monthly_leave', 'exam_failed', 'resigned_account_active'
  ) then raise exception 'invalid_alert_type'; end if;

  with visible as materialized (
    select event.*,
      (event.is_active and receipt.alert_id is null) unread
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
      and (
        v_group = 'all'
        or (v_group = 'account' and alert.alert_type in (
          'payout_change', 'resigned_account_active'
        ))
        or (v_group = 'attendance' and alert.alert_type in (
          'late_timeout_frequency', 'consecutive_rest', 'weekly_absence',
          'monthly_leave'
        ))
        or (v_group = 'quality' and alert.alert_type in (
          'error_spike', 'deduction_frequency', 'exam_failed'
        ))
      )
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
    'pages', greatest(1,
      ceil((select count(*) from filtered)::numeric / v_page_size)::integer),
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

-- Seed only the new rules during deployment. The already-installed core rules
-- keep their current state and the existing cron invokes the composed wrapper
-- on its next normal five-minute run.
select alerts_private.refresh_extended_alerts();

comment on function alerts_private.refresh_extended_alerts() is
  'Refreshes only authoritative extended alert rules: latest failed exam and unrecovered access for resigned employees.';
comment on function alerts_private.refresh_alerts() is
  'Runs the original seven-rule alert refresh and the authoritative extended rules under one transaction lock.';
comment on function public.admin_alert_center(jsonb, integer, integer) is
  'Returns scoped alert records and supports account, attendance, and quality category filters.';

notify pgrst, 'reload schema';

commit;
