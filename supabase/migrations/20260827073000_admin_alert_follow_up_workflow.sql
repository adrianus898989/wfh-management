begin;

-- Human follow-up is deliberately separate from is_active/resolved_at. The
-- latter describes whether the detector still sees the condition; this table
-- records whether an admin confirmed and handled that specific alert cycle.
create table if not exists public.admin_alert_follow_ups (
  alert_id uuid not null references public.admin_alert_events(id) on delete cascade,
  alert_cycle integer not null,
  status text not null default 'confirmed',
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_by_name text not null,
  confirmed_at timestamptz not null default clock_timestamp(),
  handled_by uuid references auth.users(id) on delete set null,
  handled_by_name text,
  handled_at timestamptz,
  handling_note text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (alert_id, alert_cycle),
  constraint admin_alert_follow_ups_cycle_check check (alert_cycle > 0),
  constraint admin_alert_follow_ups_status_check
    check (status in ('confirmed', 'handled')),
  constraint admin_alert_follow_ups_actor_names_check check (
    nullif(btrim(confirmed_by_name), '') is not null
    and (handled_by_name is null or nullif(btrim(handled_by_name), '') is not null)
  ),
  constraint admin_alert_follow_ups_handled_check check (
    (status = 'confirmed' and handled_by is null and handled_by_name is null and handled_at is null
      and handling_note is null)
    or
    (status = 'handled' and handled_by_name is not null and handled_at is not null
      and nullif(btrim(handling_note), '') is not null)
  ),
  constraint admin_alert_follow_ups_note_length_check
    check (handling_note is null or char_length(handling_note) <= 2000)
);

create index if not exists admin_alert_read_receipts_alert_cycle_read_idx
  on public.admin_alert_read_receipts (alert_id, alert_cycle, read_at desc);
create index if not exists admin_alert_follow_ups_status_updated_idx
  on public.admin_alert_follow_ups (status, updated_at desc);

alter table public.admin_alert_follow_ups enable row level security;
revoke all on table public.admin_alert_follow_ups
  from public, anon, authenticated;
grant select, insert, update, delete on table public.admin_alert_follow_ups
  to service_role;

drop policy if exists admin_alert_follow_ups_no_direct_access
  on public.admin_alert_follow_ups;
create policy admin_alert_follow_ups_no_direct_access
on public.admin_alert_follow_ups for all to anon, authenticated
using (false) with check (false);

create or replace function public.admin_alert_update_follow_up(
  p_alert_id uuid,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_alert_cycle integer;
  v_actor_name text;
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if v_action not in ('confirm', 'handle') then
    raise exception 'invalid_alert_action';
  end if;
  if v_action = 'handle' and v_note is null then
    raise exception 'handling_note_required';
  end if;
  if char_length(coalesce(v_note, '')) > 2000 then
    raise exception 'handling_note_too_long';
  end if;

  -- Lock the alert row so two admins cannot race a confirm/handle transition.
  select event.alert_cycle into v_alert_cycle
  from public.admin_alert_events event
  where event.id = p_alert_id
    and alerts_private.caller_can_view_alert_type(event.alert_type)
    and (
      public.backend_employee_in_scope(event.employee_id)
      or (event.employee_id is null and public.is_founder())
    )
  for update;

  if v_alert_cycle is null then
    raise exception 'alert_not_found_or_out_of_scope';
  end if;

  select coalesce(
    nullif(btrim(access.login_username), ''),
    nullif(btrim(access.login_email), ''),
    left(v_user_id::text, 8)
  ) into v_actor_name
  from public.user_access access
  where access.auth_user_id = v_user_id;
  v_actor_name := coalesce(v_actor_name, left(v_user_id::text, 8));

  -- Confirmation/handling implies that the acting account read this cycle.
  -- The normal expand action writes the same receipt first; DO NOTHING makes
  -- this a race-safe fallback without changing the existing read timestamp.
  insert into public.admin_alert_read_receipts (
    alert_id, auth_user_id, alert_cycle, read_at
  ) values (
    p_alert_id, v_user_id, v_alert_cycle, clock_timestamp()
  ) on conflict (alert_id, auth_user_id, alert_cycle) do nothing;

  if v_action = 'confirm' then
    insert into public.admin_alert_follow_ups (
      alert_id, alert_cycle, status, confirmed_by, confirmed_by_name, confirmed_at,
      created_at, updated_at
    ) values (
      p_alert_id, v_alert_cycle, 'confirmed', v_user_id, v_actor_name,
      clock_timestamp(), clock_timestamp(), clock_timestamp()
    )
    -- Confirm is idempotent and never downgrades a handled warning.
    on conflict (alert_id, alert_cycle) do nothing;
  else
    update public.admin_alert_follow_ups follow_up
    set status = 'handled',
        handled_by = v_user_id,
        handled_by_name = v_actor_name,
        handled_at = clock_timestamp(),
        handling_note = v_note,
        updated_at = clock_timestamp()
    where follow_up.alert_id = p_alert_id
      and follow_up.alert_cycle = v_alert_cycle
      and follow_up.status in ('confirmed', 'handled');

    if not found then
      raise exception 'alert_confirmation_required';
    end if;
  end if;

  select jsonb_build_object(
    'status', follow_up.status,
    'confirmed_by', follow_up.confirmed_by,
    'confirmed_by_name', follow_up.confirmed_by_name,
    'confirmed_at', follow_up.confirmed_at,
    'handled_by', follow_up.handled_by,
    'handled_by_name', follow_up.handled_by_name,
    'handled_at', follow_up.handled_at,
    'handling_note', follow_up.handling_note,
    'updated_at', follow_up.updated_at
  ) into v_result
  from public.admin_alert_follow_ups follow_up
  where follow_up.alert_id = p_alert_id
    and follow_up.alert_cycle = v_alert_cycle;

  return jsonb_build_object('ok', true, 'follow_up', v_result);
end;
$$;

revoke all on function public.admin_alert_update_follow_up(uuid, text, text)
  from public, anon;
grant execute on function public.admin_alert_update_follow_up(uuid, text, text)
  to authenticated, service_role;

-- Return all readers for the current alert cycle plus the human follow-up
-- record. Direct table access remains denied; the same permission and employee
-- scope checks as the original warning RPC are preserved.
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
  v_employee_id_text text := btrim(coalesce(p_filters->>'employee_id', ''));
  v_employee_id uuid;
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
  if v_employee_id_text <> '' then
    begin
      v_employee_id := v_employee_id_text::uuid;
    exception when invalid_text_representation then
      raise exception 'invalid_employee_id';
    end;
  end if;

  with visible as materialized (
    select event.*,
      employee.hire_date,
      (event.is_active and receipt.alert_id is null) unread
    from public.admin_alert_events event
    left join public.employees employee on employee.id = event.employee_id
    left join public.admin_alert_read_receipts receipt
      on receipt.alert_id = event.id
     and receipt.auth_user_id = v_user_id
     and receipt.alert_cycle = event.alert_cycle
    where alerts_private.caller_can_view_alert_type(event.alert_type)
      and (
        public.backend_employee_in_scope(event.employee_id)
        or (event.employee_id is null and public.is_founder())
      )
  ), employee_visible as materialized (
    select * from visible alert
    where v_employee_id is null or alert.employee_id = v_employee_id
  ), filtered as materialized (
    select * from employee_visible alert
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
    'active_total', (select count(*) from employee_visible where is_active),
    'unread_total', (select count(*) from employee_visible where is_active and unread),
    'type_counts', coalesce((
      select jsonb_object_agg(alert_type, total order by alert_type)
      from (
        select alert_type, count(*) total
        from employee_visible where is_active group by alert_type
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
        'hire_date', alert.hire_date,
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
        'resolved_at', alert.resolved_at,
        'readers', coalesce((
          select jsonb_agg(jsonb_build_object(
            'auth_user_id', reader.auth_user_id,
            'account', reader.account,
            'read_at', reader.read_at
          ) order by reader.read_at desc)
          from (
            select receipt.auth_user_id,
              receipt.read_at,
              coalesce(
                nullif(btrim(reader_access.login_username), ''),
                nullif(btrim(reader_access.login_email), ''),
                left(receipt.auth_user_id::text, 8)
              ) account
            from public.admin_alert_read_receipts receipt
            left join public.user_access reader_access
              on reader_access.auth_user_id = receipt.auth_user_id
            where receipt.alert_id = alert.id
              and receipt.alert_cycle = alert.alert_cycle
          ) reader
        ), '[]'::jsonb),
        'follow_up', coalesce((
          select jsonb_build_object(
            'status', follow_up.status,
            'confirmed_by', follow_up.confirmed_by,
            'confirmed_by_name', follow_up.confirmed_by_name,
            'confirmed_at', follow_up.confirmed_at,
            'handled_by', follow_up.handled_by,
            'handled_by_name', follow_up.handled_by_name,
            'handled_at', follow_up.handled_at,
            'handling_note', follow_up.handling_note,
            'updated_at', follow_up.updated_at
          )
          from public.admin_alert_follow_ups follow_up
          where follow_up.alert_id = alert.id
            and follow_up.alert_cycle = alert.alert_cycle
        ), jsonb_build_object('status', 'pending'))
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

-- Consecutive rest warnings use the same canonical attendance evidence as the
-- weekly absence and monthly leave warnings, including date, reason and note.
create or replace function alerts_private.enrich_attendance_alert_details()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enriched integer := 0;
begin
  -- PostgreSQL advisory locks are re-entrant for the owning session. When the
  -- refresh_alerts wrapper calls this function, its transaction already owns
  -- this same key and this call succeeds; a different concurrent refresh is
  -- still skipped.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('alerts_private.refresh_alerts', 0)
  ) then
    return jsonb_build_object(
      'ok', true, 'skipped', true, 'reason', 'refresh_running'
    );
  end if;

  with active_alerts as materialized (
    select event.id, event.employee_id, event.alert_type,
      event.window_start, event.window_end
    from public.admin_alert_events event
    where event.is_active
      and event.employee_id is not null
      and event.alert_type in (
        'consecutive_rest', 'weekly_absence', 'monthly_leave'
      )
  ), ranked_events as materialized (
    select alert.id alert_id,
      alert.alert_type,
      record.event_date,
      case when lower(record.event_kind) = 'absent' then 'absence'
        else lower(record.event_kind) end event_kind,
      nullif(btrim(record.reason), '') reason,
      nullif(btrim(record.note), '') note,
      row_number() over (
        partition by alert.id, record.event_date
        order by case lower(record.event_kind)
          when 'absence' then 1 when 'absent' then 1 when 'leave' then 2
          when 'home_leave' then 3 when 'public_holiday' then 4
          when 'half_day' then 5 else 9 end,
          record.updated_at desc,
          record.id desc
      ) event_rank
    from active_alerts alert
    join public.employee_attendance_records record
      on record.employee_id = alert.employee_id
     and record.kind = 'attendance'
     and record.event_date between alert.window_start and alert.window_end
    where (
      alert.alert_type = 'consecutive_rest'
      and lower(record.event_kind) = 'public_holiday'
    ) or (
      alert.alert_type = 'weekly_absence'
      and lower(record.event_kind) in ('absence', 'absent')
    ) or (
      alert.alert_type = 'monthly_leave'
      and lower(record.event_kind) in (
        'public_holiday', 'home_leave', 'leave', 'absence', 'absent', 'half_day'
      )
    )
  ), details as materialized (
    select ranked.alert_id,
      jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'date', ranked.event_date,
        'event_kind', ranked.event_kind,
        'reason', ranked.reason,
        'note', ranked.note,
        'weight', case when ranked.event_kind = 'half_day' then 0.5 else 1 end
      )) order by ranked.event_date) events
    from ranked_events ranked
    where ranked.event_rank = 1
      and not (
        ranked.alert_type = 'monthly_leave'
        and ranked.event_kind = 'home_leave'
      )
    group by ranked.alert_id
  )
  update public.admin_alert_events event
  set payload = event.payload || jsonb_build_object(
    'details_version', 2,
    'events', details.events
  )
  from details
  where event.id = details.alert_id
    and (
      event.payload->'events' is distinct from details.events
      or event.payload->>'details_version' is distinct from '2'
    );
  get diagnostics v_enriched = row_count;

  return jsonb_build_object(
    'ok', true,
    'enriched', v_enriched,
    'active_attendance_alerts', (
      select count(*)
      from public.admin_alert_events event
      where event.is_active
        and event.alert_type in (
          'consecutive_rest', 'weekly_absence', 'monthly_leave'
        )
    )
  );
end;
$$;

revoke all on function alerts_private.enrich_attendance_alert_details()
  from public, anon, authenticated;

-- Backfill the currently active warning payloads during deployment. This only
-- updates derived alert evidence and never edits attendance source records.
select alerts_private.enrich_attendance_alert_details();

comment on table public.admin_alert_follow_ups is
  'Human confirmation and handling audit for each durable admin alert cycle.';
comment on function public.admin_alert_update_follow_up(uuid, text, text) is
  'Confirms or handles one visible alert after enforcing current admin session, type permission, and employee scope.';
comment on function public.admin_alert_center(jsonb, integer, integer) is
  'Returns scoped alert records with reader accounts and human follow-up state.';
comment on function alerts_private.enrich_attendance_alert_details() is
  'Batch-enriches active consecutive-rest, weekly-absence, and monthly-leave alerts with canonical dates, reasons, and notes.';

notify pgrst, 'reload schema';

commit;
