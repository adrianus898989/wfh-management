-- Keep employee-master identity/status reconciliation strict, but make the
-- schedule UI and reports read every normalized row from the authoritative
-- private schedule snapshot. Previously this trigger restored only the report
-- snapshot after a successful master sync; the directory cache was left with
-- the onsite-gated subset and therefore hid valid scheduled employees.

create or replace function public.refresh_schedule_report_snapshot_after_master_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_row_count integer;
  v_snapshot_hash text;
  v_captured_at timestamptz;
  v_directory_result jsonb;
begin
  if new.status <> 'success' then return new; end if;

  select snapshot.payload, snapshot.row_count, snapshot.snapshot_hash,
    snapshot.captured_at
  into v_payload, v_row_count, v_snapshot_hash, v_captured_at
  from public.employee_master_source_snapshots snapshot
  where snapshot.source_key = 'home_schedule_roster_current'
    and snapshot.run_id = new.id;

  if v_payload is null or jsonb_typeof(v_payload) <> 'array'
    or v_row_count < 1 or jsonb_array_length(v_payload) <> v_row_count then
    raise exception using errcode = '22023',
      message = 'successful_master_run_missing_schedule_snapshot';
  end if;

  insert into public.report_sheet_snapshots (
    source, payload, row_count, synced_at, note
  ) values (
    '居家排班表/填表', v_payload, v_row_count,
    greatest(coalesce(v_captured_at, clock_timestamp()), clock_timestamp()),
    'employee-master-full-schedule-v3;hash:' || v_snapshot_hash
  )
  on conflict (source) do update
  set payload = excluded.payload,
      row_count = excluded.row_count,
      synced_at = excluded.synced_at,
      note = excluded.note;

  -- This cache is a read model. Rebuilding it from the full schedule does not
  -- create employees, change employment status, or grant a portal account.
  v_directory_result := public.sync_report_employee_directory(v_payload);
  if not public.report_employee_directory_cache_matches(v_payload) then
    raise exception using errcode = '22023',
      message = 'full_schedule_directory_cache_mismatch',
      detail = coalesce(v_directory_result::text, '{}');
  end if;

  return new;
end;
$$;

revoke all on function public.refresh_schedule_report_snapshot_after_master_sync()
  from public, anon, authenticated, service_role;

comment on function public.refresh_schedule_report_snapshot_after_master_sync() is
  'After a successful dual-source master sync, publishes the complete normalized schedule and atomically rebuilds its read-only directory cache without relaxing employee identity/status rules.';

-- Backfill the derived display cache immediately when this migration is
-- deployed, rather than waiting for the next scheduled master sync. The DO
-- block and the function replacement run in the same migration transaction:
-- any missing/invalid snapshot or cache mismatch aborts and rolls back all
-- changes. Canonical employee records and account state are never modified.
do $$
declare
  v_payload jsonb;
  v_row_count integer;
  v_directory_result jsonb;
begin
  select snapshot.payload, snapshot.row_count
  into v_payload, v_row_count
  from public.report_sheet_snapshots snapshot
  where snapshot.source = '居家排班表/填表';

  if v_payload is null or jsonb_typeof(v_payload) <> 'array'
    or v_row_count < 1 or jsonb_array_length(v_payload) <> v_row_count then
    raise exception using errcode = '22023',
      message = 'current_schedule_report_snapshot_missing_or_invalid';
  end if;

  v_directory_result := public.sync_report_employee_directory(v_payload);
  if not public.report_employee_directory_cache_matches(v_payload) then
    raise exception using errcode = '22023',
      message = 'schedule_directory_cache_backfill_mismatch',
      detail = coalesce(v_directory_result::text, '{}');
  end if;
end;
$$;

notify pgrst, 'reload schema';
