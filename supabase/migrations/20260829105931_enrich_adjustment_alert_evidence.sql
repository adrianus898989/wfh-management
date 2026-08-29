begin;

-- Keep the warning list a read of precomputed data.  Evidence is attached
-- while the bounded adjustment refresh writes its (usually very small)
-- candidate set, never while an administrator opens the page.
create or replace function alerts_private.attach_adjustment_alert_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '6s'
set lock_timeout = '500ms'
as $$
declare
  v_events jsonb := '[]'::jsonb;
begin
  if new.alert_type not in ('deduction_frequency', 'late_timeout_frequency')
     or new.employee_id is null then
    return new;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'date', evidence.event_date,
    'event_kind', evidence.event_kind,
    'amount', evidence.amount,
    'currency', evidence.currency,
    'reason', evidence.reason,
    'note', evidence.note
  ) order by evidence.event_date desc, evidence.updated_at desc, evidence.id desc), '[]'::jsonb)
  into v_events
  from (
    select record.id, record.event_date, record.event_kind, record.amount,
      nullif(btrim(record.currency), '') currency,
      nullif(btrim(record.reason), '') reason,
      nullif(btrim(record.note), '') note,
      record.updated_at
    from public.employee_attendance_records record
    where record.employee_id = new.employee_id
      and record.kind = 'adjustment'
      and lower(record.event_kind) = 'deduction'
      and not record.is_mirror
      and record.event_date between
        coalesce(new.window_start, (clock_timestamp() at time zone 'Asia/Manila')::date - 6)
        and coalesce(new.window_end, (clock_timestamp() at time zone 'Asia/Manila')::date)
      and (
        new.alert_type = 'deduction_frequency'
        or lower(concat_ws(' ', record.note, record.reason)) ~
          '(迟到|超时|(^|[^[:alnum:]_])late([^[:alnum:]_]|$)|overslept|over[[:space:]-]?(break|smoke)|break[[:space:]]+time|time[[:space:]]+limit)'
      )
    order by record.event_date desc, record.updated_at desc, record.id desc
    limit 12
  ) evidence;

  new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object(
    'adjustment_details_version', 1,
    'events', v_events
  );
  return new;
end;
$$;

revoke all on function alerts_private.attach_adjustment_alert_evidence()
  from public, anon, authenticated;

drop trigger if exists admin_alert_attach_adjustment_evidence
  on public.admin_alert_events;
create trigger admin_alert_attach_adjustment_evidence
before insert or update of alert_type, employee_id, window_start, window_end, payload
on public.admin_alert_events
for each row
when (new.alert_type in ('deduction_frequency', 'late_timeout_frequency'))
execute function alerts_private.attach_adjustment_alert_evidence();

-- Backfill only currently actionable rows.  The trigger keeps future refreshes
-- enriched, while resolved history remains immutable.
update public.admin_alert_events
set payload = payload
where is_active
  and alert_type in ('deduction_frequency', 'late_timeout_frequency');

commit;
