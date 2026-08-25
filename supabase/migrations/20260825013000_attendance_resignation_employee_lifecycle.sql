-- Promote a current, canonical attendance-sheet resignation into the employee
-- master record.  The employee status trigger installed immediately before
-- this migration is responsible for closing any active staff Portal session.
--
-- Safety rules:
--   * only canonical (non-mirror) resignation-block rows are considered;
--   * the row must be explicitly matched to one employee;
--   * the source must still be active and the date must not be in the future;
--   * resignations from before the current hire/return cycle are ignored;
--   * ambiguous/unmatched rows can never change an employee;
--   * changes owned by this synchronizer are restored conservatively if the
--     authoritative source later corrects or removes the resignation.

create table if not exists attendance_private.employee_resignation_sync_state (
  employee_id uuid primary key
    references public.employees(id) on delete cascade,
  applied_resign_date date not null,
  prior_status text not null,
  prior_resign_date date,
  source_record_ids uuid[] not null default '{}'::uuid[],
  first_applied_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint employee_resignation_sync_prior_status_check
    check (prior_status in ('active', 'probation', 'suspended', 'resigned')),
  constraint employee_resignation_sync_source_records_check
    check (cardinality(source_record_ids) > 0)
);

revoke all on table attendance_private.employee_resignation_sync_state
  from public, anon, authenticated;

create index if not exists employee_attendance_canonical_resignation_idx
  on public.employee_attendance_records (employee_id, event_date, source_id)
  where match_status = 'matched'
    and employee_id is not null
    and source_block = 'resignation'
    and kind = 'resignation'
    and event_kind = 'resignation'
    and not is_mirror
    and event_date is not null;

create index if not exists employee_lifecycle_active_reactivate_idx
  on public.employee_lifecycle_events (employee_id, effective_date desc)
  where event_type = 'reactivate'
    and note is distinct from '__VOIDED__';

create or replace function attendance_private.current_employee_resignations()
returns table (
  employee_id uuid,
  resign_date date,
  source_record_ids uuid[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    record.employee_id,
    min(record.event_date) as resign_date,
    array_agg(record.id order by record.event_date, record.id) as source_record_ids
  from public.employee_attendance_records record
  join public.attendance_sheet_sources source
    on source.id = record.source_id
   and source.is_active = true
  join public.employees employee
    on employee.id = record.employee_id
  where record.match_status = 'matched'
    and record.employee_id is not null
    and record.source_block = 'resignation'
    and record.kind = 'resignation'
    and record.event_kind = 'resignation'
    and record.is_mirror = false
    and record.event_date is not null
    and record.event_date <= current_date
    and (employee.hire_date is null or record.event_date >= employee.hire_date)
    and (employee.return_date is null or record.event_date >= employee.return_date)
    and not exists (
      select 1
      from public.employee_lifecycle_events reactivate
      where reactivate.employee_id = record.employee_id
        and reactivate.event_type = 'reactivate'
        and reactivate.note is distinct from '__VOIDED__'
        and reactivate.effective_date > record.event_date
    )
  group by record.employee_id;
$$;

revoke all on function attendance_private.current_employee_resignations()
  from public, anon, authenticated;

comment on function attendance_private.current_employee_resignations() is
  'Canonical, explicitly matched, non-future sheet resignations in the employee current employment cycle.';

create or replace function attendance_private.reconcile_employee_resignations()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tracked integer := 0;
  v_resigned integer := 0;
  v_restored integer := 0;
  v_released integer := 0;
begin
  -- Serialize source-completion triggers and the migration backfill.  The key
  -- is intentionally namespace-specific and transaction scoped.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('attendance_employee_resignation_reconcile', 20260825)
  );

  -- Record the pre-sync state only when this synchronizer needs to make a
  -- change. Existing manually maintained resigned dates remain authoritative.
  insert into attendance_private.employee_resignation_sync_state as state (
    employee_id,
    applied_resign_date,
    prior_status,
    prior_resign_date,
    source_record_ids,
    first_applied_at,
    updated_at
  )
  select
    candidate.employee_id,
    candidate.resign_date,
    lower(btrim(employee.status::text)),
    employee.resign_date,
    candidate.source_record_ids,
    clock_timestamp(),
    clock_timestamp()
  from attendance_private.current_employee_resignations() candidate
  join public.employees employee on employee.id = candidate.employee_id
  where lower(btrim(employee.status::text)) in ('active', 'probation', 'suspended')
     or (
       lower(btrim(employee.status::text)) = 'resigned'
       and employee.resign_date is null
     )
  on conflict (employee_id) do update
  set applied_resign_date = excluded.applied_resign_date,
      source_record_ids = excluded.source_record_ids,
      updated_at = clock_timestamp();
  get diagnostics v_tracked = row_count;

  -- Keep dates already owned by this synchronizer aligned when the current
  -- sheet is corrected from one valid resignation date to another.
  update attendance_private.employee_resignation_sync_state state
  set applied_resign_date = candidate.resign_date,
      source_record_ids = candidate.source_record_ids,
      updated_at = clock_timestamp()
  from attendance_private.current_employee_resignations() candidate
  where candidate.employee_id = state.employee_id
    and (
      state.applied_resign_date,
      state.source_record_ids
    ) is distinct from (
      candidate.resign_date,
      candidate.source_record_ids
    );

  update public.employees employee
  set status = 'resigned',
      resign_date = state.applied_resign_date,
      updated_at = clock_timestamp()
  from attendance_private.employee_resignation_sync_state state
  where employee.id = state.employee_id
    and exists (
      select 1
      from attendance_private.current_employee_resignations() candidate
      where candidate.employee_id = state.employee_id
        and candidate.resign_date = state.applied_resign_date
    )
    and (
      lower(btrim(employee.status::text)),
      employee.resign_date
    ) is distinct from (
      'resigned',
      state.applied_resign_date
    );
  get diagnostics v_resigned = row_count;

  -- A removed, disabled, unlinked or newly ambiguous source record is no
  -- longer effective. Restore only if the employee still has the exact values
  -- this synchronizer wrote; any later manual lifecycle edit wins.
  with stale as materialized (
    select state.*
    from attendance_private.employee_resignation_sync_state state
    where not exists (
      select 1
      from attendance_private.current_employee_resignations() candidate
      where candidate.employee_id = state.employee_id
    )
  )
  update public.employees employee
  set status = stale.prior_status,
      resign_date = stale.prior_resign_date,
      updated_at = clock_timestamp()
  from stale
  where employee.id = stale.employee_id
    and lower(btrim(employee.status::text)) = 'resigned'
    and employee.resign_date = stale.applied_resign_date;
  get diagnostics v_restored = row_count;

  delete from attendance_private.employee_resignation_sync_state state
  where not exists (
    select 1
    from attendance_private.current_employee_resignations() candidate
    where candidate.employee_id = state.employee_id
  );
  get diagnostics v_released = row_count;

  return jsonb_build_object(
    'ok', true,
    'tracked', v_tracked,
    'employees_resigned', v_resigned,
    'employees_restored', v_restored,
    'tracking_released', v_released
  );
end;
$$;

revoke all on function attendance_private.reconcile_employee_resignations()
  from public, anon, authenticated;

comment on function attendance_private.reconcile_employee_resignations() is
  'Idempotently applies and conservatively rolls back attendance-sheet-owned employee resignations.';

create or replace function attendance_private.reconcile_employee_resignations_after_source_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- Run once per source UPDATE statement, and only after a completed/failed
  -- snapshot, source activation change, or a bulk rematch counter change.
  if exists (
    select 1
    from new_sources new_source
    join old_sources old_source using (id)
    where new_source.is_active is distinct from old_source.is_active
       or (
         new_source.synced_at is distinct from old_source.synced_at
         and new_source.status in ('success', 'partial', 'failed')
       )
       or (
         new_source.matched_count,
         new_source.unmatched_count,
         new_source.ambiguous_count
       ) is distinct from (
         old_source.matched_count,
         old_source.unmatched_count,
         old_source.ambiguous_count
       )
  ) then
    perform attendance_private.reconcile_employee_resignations();
  end if;
  return null;
end;
$$;

revoke all on function attendance_private.reconcile_employee_resignations_after_source_update()
  from public, anon, authenticated;

drop trigger if exists attendance_sources_reconcile_employee_resignations
  on public.attendance_sheet_sources;
create trigger attendance_sources_reconcile_employee_resignations
after update on public.attendance_sheet_sources
referencing old table as old_sources new table as new_sources
for each statement
execute function attendance_private.reconcile_employee_resignations_after_source_update();

create or replace function attendance_private.reconcile_employee_resignations_after_cycle_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- A rehire/return date can invalidate an older resignation without any
  -- Google Sheet change, so lifecycle-cycle edits must reconcile immediately.
  perform attendance_private.reconcile_employee_resignations();
  return null;
end;
$$;

revoke all on function attendance_private.reconcile_employee_resignations_after_cycle_update()
  from public, anon, authenticated;

drop trigger if exists employees_reconcile_attendance_resignations_after_cycle_update
  on public.employees;
create trigger employees_reconcile_attendance_resignations_after_cycle_update
after update of hire_date, return_date on public.employees
for each statement
execute function attendance_private.reconcile_employee_resignations_after_cycle_update();

-- Repair already-imported resignations that were never promoted into the
-- employee master record. Re-running the migration logic is harmless.
select attendance_private.reconcile_employee_resignations();

notify pgrst, 'reload schema';
