begin;

-- Enrich active attendance warnings in one database-side pass. The browser
-- still reads only the scoped admin_alert_center payload and does not perform
-- one extra attendance query for each warning row.
create or replace function alerts_private.enrich_attendance_alert_details()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enriched integer := 0;
begin
  with active_alerts as materialized (
    select event.id, event.employee_id, event.alert_type,
      event.window_start, event.window_end
    from public.admin_alert_events event
    where event.is_active
      and event.employee_id is not null
      and event.alert_type in ('weekly_absence', 'monthly_leave')
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
      -- Match refresh_core_alerts exactly: home leave participates in the
      -- one-event-per-day priority decision, then is excluded from the monthly
      -- total. A lower-priority same-day status must not be shown as evidence.
      and not (
        ranked.alert_type = 'monthly_leave'
        and ranked.event_kind = 'home_leave'
      )
    group by ranked.alert_id
  )
  update public.admin_alert_events event
  set payload = event.payload || jsonb_build_object(
    'details_version', 1,
    'events', details.events
  )
  from details
  where event.id = details.alert_id
    and (
      event.payload->'events' is distinct from details.events
      or event.payload->>'details_version' is distinct from '1'
    );
  get diagnostics v_enriched = row_count;

  return jsonb_build_object(
    'ok', true,
    'enriched', v_enriched,
    'active_attendance_alerts', (
      select count(*)
      from public.admin_alert_events event
      where event.is_active
        and event.alert_type in ('weekly_absence', 'monthly_leave')
    )
  );
end;
$$;

revoke all on function alerts_private.enrich_attendance_alert_details()
  from public, anon, authenticated;

-- Preserve the existing audited core + extended refresh unchanged. The cron
-- keeps calling refresh_alerts(), which now appends its evidence enrichment in
-- the same transaction after the warning candidates have been recalculated.
alter function alerts_private.refresh_alerts()
  rename to refresh_alerts_without_attendance_details;
revoke all on function alerts_private.refresh_alerts_without_attendance_details()
  from public, anon, authenticated;

create or replace function alerts_private.refresh_alerts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alerts jsonb;
  v_details jsonb;
begin
  v_alerts := alerts_private.refresh_alerts_without_attendance_details();
  if coalesce((v_alerts->>'skipped')::boolean, false) then
    return v_alerts;
  end if;

  v_details := alerts_private.enrich_attendance_alert_details();
  return v_alerts || jsonb_build_object('attendance_details', v_details);
end;
$$;

revoke all on function alerts_private.refresh_alerts()
  from public, anon, authenticated;

-- Backfill the currently active weekly/monthly warnings without waiting for
-- the next five-minute cron run.
select alerts_private.enrich_attendance_alert_details();

comment on function alerts_private.enrich_attendance_alert_details() is
  'Batch-enriches active weekly absence and monthly leave alert payloads with canonical dates, reasons, and notes.';
comment on function alerts_private.refresh_alerts() is
  'Runs the existing admin alert refresh, then batch-enriches attendance alert payload evidence for the scoped RPC.';

commit;
