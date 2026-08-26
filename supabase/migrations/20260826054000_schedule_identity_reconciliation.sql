-- The private schedule currently contains one repeated employee ID with an
-- older and a newer assignment, plus two named rows whose IDs are still being
-- filled in. Treat an employee ID as the primary identity and the normalized
-- name as the fallback only when the ID is empty. The Edge normalizers already
-- collapse repeated identities to their latest source row before this RPC.

create or replace function public.ingest_schedule_roster_snapshot(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb := p_payload->'rows';
  v_trigger_kind text := btrim(coalesce(p_payload->>'trigger_kind', ''));
  v_new_count integer := 0;
  v_new_unique_identities integer := 0;
  v_new_unique_ids integer := 0;
  v_old_unique_ids integer := 0;
  v_removed_ids integer := 0;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'invalid_schedule_snapshot');
  end if;

  v_new_count := jsonb_array_length(v_rows);
  select
    count(distinct case
      when nullif(btrim(item->>'employee_id'), '') is not null
        then 'id:' || upper(btrim(item->>'employee_id'))
      else 'name:' || lower(regexp_replace(btrim(item->>'name'), '[[:space:]]+', ' ', 'g'))
    end)::integer,
    count(distinct upper(btrim(item->>'employee_id')))
      filter (where nullif(btrim(item->>'employee_id'), '') is not null)::integer
  into v_new_unique_identities, v_new_unique_ids
  from jsonb_array_elements(v_rows) item;

  if v_new_count < 1 or v_new_unique_identities <> v_new_count then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'schedule_identities_incomplete',
      'rows', v_new_count,
      'unique_identities', v_new_unique_identities,
      'unique_employee_ids', v_new_unique_ids);
  end if;

  with old_ids as (
    select distinct upper(btrim(item->>'employee_id')) employee_id
    from public.report_sheet_snapshots s
    cross join lateral jsonb_array_elements(s.payload) item
    where s.source = '居家排班表/填表'
      and nullif(btrim(item->>'employee_id'), '') is not null
  ), new_ids as (
    select distinct upper(btrim(item->>'employee_id')) employee_id
    from jsonb_array_elements(v_rows) item
    where nullif(btrim(item->>'employee_id'), '') is not null
  )
  select
    (select count(*)::integer from old_ids),
    (select count(*)::integer from old_ids o
      where not exists (select 1 from new_ids n where n.employee_id=o.employee_id))
  into v_old_unique_ids, v_removed_ids;

  if v_trigger_kind <> 'manual'
    and v_old_unique_ids >= 100
    and v_removed_ids > greatest(50, floor(v_old_unique_ids * 0.20)::integer) then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'schedule_mass_delete_guard',
      'previous_employee_ids', v_old_unique_ids,
      'new_employee_ids', v_new_unique_ids,
      'removed_employee_ids', v_removed_ids);
  end if;

  return public.ingest_schedule_roster_snapshot_internal(p_payload);
end;
$$;

revoke all on function public.ingest_schedule_roster_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_schedule_roster_snapshot(jsonb)
  to service_role;

-- The dual-source employee reconciliation intentionally filters which roster
-- rows can update the canonical employee directory. Reporting is different:
-- its schedule headcount must reflect every normalized row from the private
-- schedule sheet. Refresh the report snapshot only after the master run has
-- completed successfully, while leaving the filtered directory untouched.
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
    'employee-master-full-schedule-v2;hash:' || v_snapshot_hash
  )
  on conflict (source) do update
  set payload = excluded.payload,
      row_count = excluded.row_count,
      synced_at = excluded.synced_at,
      note = excluded.note;

  return new;
end;
$$;

revoke all on function public.refresh_schedule_report_snapshot_after_master_sync()
  from public, anon, authenticated, service_role;

drop trigger if exists employee_master_refresh_full_schedule_report
  on public.employee_master_sync_runs;
create trigger employee_master_refresh_full_schedule_report
after update of status on public.employee_master_sync_runs
for each row
when (new.status = 'success')
execute function public.refresh_schedule_report_snapshot_after_master_sync();

notify pgrst, 'reload schema';
