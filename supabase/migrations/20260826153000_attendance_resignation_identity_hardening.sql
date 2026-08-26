-- A resignation is allowed to change employee lifecycle state only when a
-- supplied employee number identifies that exact employee.  Name fallback is
-- still supported for genuinely name-only rows, but it must never override a
-- conflicting non-empty employee number.
--
-- This migration also repairs legacy rows that were linked by name despite a
-- conflicting employee number.  The existing resignation reconciler owns the
-- corresponding employee status changes and therefore performs the rollback
-- to its recorded prior state; this migration never guesses an active status.

create or replace function attendance_private.enforce_resignation_employee_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw_employee_no text;
  v_exact_employee_id uuid;
  v_before_identity record;
begin
  if new.source_block is distinct from 'resignation'
    and new.kind is distinct from 'resignation'
    and new.event_kind is distinct from 'resignation' then
    return new;
  end if;

  v_raw_employee_no := nullif(
    public.employee_master_normalize_id(new.employee_no_raw),
    ''
  );

  -- With no employee number the existing unique-name matching rules remain
  -- available.  This guard is specifically for contradictory ID evidence.
  if v_raw_employee_no is null then
    return new;
  end if;

  select employee.id
  into v_exact_employee_id
  from public.employees employee
  where public.employee_master_normalize_id(employee.employee_no)
    = v_raw_employee_no
  limit 1;

  if tg_op = 'UPDATE' then
    select
      old.employee_id,
      old.match_status,
      old.match_method,
      old.matched_at
    into v_before_identity;
  end if;

  if v_exact_employee_id is not null then
    new.employee_id := v_exact_employee_id;
    new.match_status := 'matched';
    new.match_method := 'employee_id_exact';
    new.matched_at := coalesce(new.matched_at, clock_timestamp());
  else
    -- A non-empty but unknown employee number is evidence of an unresolved
    -- identity.  Do not silently attach the resignation to a same-name person.
    new.employee_id := null;
    new.match_status := 'unmatched';
    new.match_method := null;
    new.matched_at := null;
  end if;

  if tg_op = 'UPDATE' then
    if (
        v_before_identity.employee_id,
        v_before_identity.match_status,
        v_before_identity.match_method,
        v_before_identity.matched_at
      ) is distinct from (
        new.employee_id,
        new.match_status,
        new.match_method,
        new.matched_at
      ) then
      new.updated_at := clock_timestamp();
    end if;
  end if;

  return new;
end;
$$;

revoke all on function attendance_private.enforce_resignation_employee_identity()
  from public, anon, authenticated, service_role;

drop trigger if exists zzz_employee_attendance_resignation_identity_guard
  on public.employee_attendance_records;

-- PostgreSQL executes same-kind triggers in name order.  The zzz prefix makes
-- this the final BEFORE identity trigger, so it also validates any contextual
-- name match proposed by zz_employee_attendance_contextual_match.
create trigger zzz_employee_attendance_resignation_identity_guard
before insert or update of
  source_block,
  kind,
  event_kind,
  employee_no_raw,
  employee_id,
  match_status,
  match_method
on public.employee_attendance_records
for each row
execute function attendance_private.enforce_resignation_employee_identity();

comment on function attendance_private.enforce_resignation_employee_identity() is
  'For resignation rows, a non-empty raw employee number must resolve to the exact linked employee; otherwise the row remains unmatched instead of falling back to name.';

-- Defense in depth: lifecycle reconciliation independently verifies that a
-- non-empty raw employee number equals the canonical employee number.  This
-- keeps a legacy or manually imported bad match from changing status even if
-- a row-level trigger was temporarily bypassed.
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
    and (
      nullif(public.employee_master_normalize_id(record.employee_no_raw), '') is null
      or (
        record.match_method = 'employee_id_exact'
        and public.employee_master_normalize_id(record.employee_no_raw)
          = public.employee_master_normalize_id(employee.employee_no)
      )
    )
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
  from public, anon, authenticated, service_role;

comment on function attendance_private.current_employee_resignations() is
  'Canonical current-cycle resignations. A supplied raw employee number must exactly match the canonical employee; name fallback is allowed only when the raw number is blank.';

do $$
declare
  v_target_id uuid;
  v_before_status text;
  v_before_resign_date date;
  v_after_status text;
  v_after_resign_date date;
  v_prior_status text;
  v_prior_resign_date date;
  v_applied_resign_date date;
  v_source_record_ids uuid[];
  v_bad_target_rows jsonb := '[]'::jsonb;
  v_latest_schedule_present boolean := false;
  v_latest_home_explicit_resignation boolean := false;
  v_reconcile_result jsonb;
  v_raymond_id uuid;
  v_raymond_before_status text;
  v_raymond_before_resign_date date;
  v_raymond_after_status text;
  v_raymond_after_resign_date date;
begin
  create temporary table attendance_resignation_identity_repair_audit
  on commit drop
  as
  select
    employee.id employee_id,
    employee.employee_no,
    employee.full_name,
    lower(btrim(employee.status::text)) before_status,
    employee.resign_date before_resign_date,
    state.prior_status,
    state.prior_resign_date,
    state.applied_resign_date,
    state.source_record_ids,
    jsonb_agg(
      jsonb_build_object(
        'record_id', record.id,
        'source_id', record.source_id,
        'source_row', record.source_row,
        'source_item_key', record.source_item_key,
        'event_date', record.event_date,
        'employee_no_raw', record.employee_no_raw,
        'employee_name_raw', record.employee_name_raw,
        'match_method', record.match_method,
        'is_mirror', record.is_mirror
      )
      order by record.is_mirror, record.source_row, record.id
    ) repaired_rows
  from public.employee_attendance_records record
  join public.employees employee on employee.id = record.employee_id
  left join attendance_private.employee_resignation_sync_state state
    on state.employee_id = employee.id
  where (
      record.source_block = 'resignation'
      or record.kind = 'resignation'
      or record.event_kind = 'resignation'
    )
    and nullif(public.employee_master_normalize_id(record.employee_no_raw), '')
      is not null
    and public.employee_master_normalize_id(record.employee_no_raw)
      <> public.employee_master_normalize_id(employee.employee_no)
  group by
    employee.id,
    employee.employee_no,
    employee.full_name,
    employee.status,
    employee.resign_date,
    state.prior_status,
    state.prior_resign_date,
    state.applied_resign_date,
    state.source_record_ids;

  -- CS000766 / Raymond is a confirmed exact-ID resignation effective
  -- 2026-08-18.  Capture the lifecycle values so this identity cleanup can
  -- prove that the legitimate resignation is not rolled back or re-dated.
  select
    employee.id,
    lower(btrim(employee.status::text)),
    employee.resign_date
  into
    v_raymond_id,
    v_raymond_before_status,
    v_raymond_before_resign_date
  from public.employees employee
  where public.employee_master_normalize_id(employee.employee_no) = 'CS000766'
  limit 1;

  -- Capture the production incident before repairing the match.  Absence of
  -- this employee in a disposable database is valid and simply skips the
  -- incident-specific assertion/audit entry.
  select
    employee.id,
    lower(btrim(employee.status::text)),
    employee.resign_date
  into
    v_target_id,
    v_before_status,
    v_before_resign_date
  from public.employees employee
  where public.employee_master_normalize_id(employee.employee_no) = 'JA523041401'
  limit 1;

  if v_target_id is not null then
    select coalesce((
      select exists (
        select 1
        from jsonb_array_elements(snapshot.payload) row_data
        where public.employee_master_normalize_id(row_data->>'employee_id')
          = 'JA523041401'
      )
      from public.employee_master_source_snapshots snapshot
      where snapshot.source_key = 'home_schedule_roster_current'
      order by snapshot.captured_at desc, snapshot.run_id desc
      limit 1
    ), false)
    into v_latest_schedule_present;

    select coalesce((
      select exists (
        select 1
        from jsonb_array_elements(snapshot.payload) row_data
        where public.employee_master_normalize_id(row_data->>'employee_id')
          = 'JA523041401'
          and (
            coalesce((row_data->>'explicitly_resigned')::boolean, false)
            or nullif(btrim(row_data->>'resign_date'), '') is not null
          )
      )
      from public.employee_master_source_snapshots snapshot
      where snapshot.source_key = 'home_employee_roster_current'
      order by snapshot.captured_at desc, snapshot.run_id desc
      limit 1
    ), false)
    into v_latest_home_explicit_resignation;

    select
      state.prior_status,
      state.prior_resign_date,
      state.applied_resign_date,
      state.source_record_ids
    into
      v_prior_status,
      v_prior_resign_date,
      v_applied_resign_date,
      v_source_record_ids
    from attendance_private.employee_resignation_sync_state state
    where state.employee_id = v_target_id;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'record_id', record.id,
          'source_id', record.source_id,
          'source_row', record.source_row,
          'source_item_key', record.source_item_key,
          'event_date', record.event_date,
          'employee_no_raw', record.employee_no_raw,
          'employee_name_raw', record.employee_name_raw,
          'match_method', record.match_method,
          'is_mirror', record.is_mirror
        )
        order by record.is_mirror, record.source_row, record.id
      ),
      '[]'::jsonb
    )
    into v_bad_target_rows
    from public.employee_attendance_records record
    where record.employee_id = v_target_id
      and (
        record.source_block = 'resignation'
        or record.kind = 'resignation'
        or record.event_kind = 'resignation'
      )
      and nullif(public.employee_master_normalize_id(record.employee_no_raw), '')
        is not null
      and public.employee_master_normalize_id(record.employee_no_raw)
        <> 'JA523041401';
  end if;

  -- Re-run every numbered resignation row through the new final identity
  -- guard. Exact IDs become employee_id_exact; unknown/conflicting IDs become
  -- unmatched. Mirror rows are also corrected so UI history cannot show the
  -- wrong employee even though only canonical rows drive lifecycle state.
  update public.employee_attendance_records record
  set employee_no_raw = record.employee_no_raw
  where (
      record.source_block = 'resignation'
      or record.kind = 'resignation'
      or record.event_kind = 'resignation'
    )
    and nullif(public.employee_master_normalize_id(record.employee_no_raw), '')
      is not null;

  -- Reconcile immediately so the returned diagnostics describe this repair,
  -- rather than the harmless second reconciliation fired by source-counter
  -- maintenance below.
  v_reconcile_result := attendance_private.reconcile_employee_resignations();

  -- Keep source diagnostics aligned with the repaired final row state.
  with source_counts as materialized (
    select
      source.id,
      count(record.id) filter (
        where not record.is_mirror and record.match_status = 'matched'
      )::integer matched_count,
      count(record.id) filter (
        where not record.is_mirror and record.match_status = 'unmatched'
      )::integer unmatched_count,
      count(record.id) filter (
        where not record.is_mirror and record.match_status = 'ambiguous'
      )::integer ambiguous_count
    from public.attendance_sheet_sources source
    left join public.employee_attendance_records record
      on record.source_id = source.id
    group by source.id
  )
  update public.attendance_sheet_sources source
  set
    matched_count = counts.matched_count,
    unmatched_count = counts.unmatched_count,
    ambiguous_count = counts.ambiguous_count,
    updated_at = clock_timestamp()
  from source_counts counts
  where counts.id = source.id
    and (
      source.matched_count,
      source.unmatched_count,
      source.ambiguous_count
    ) is distinct from (
      counts.matched_count,
      counts.unmatched_count,
      counts.ambiguous_count
    );

  -- The reconciliation above restores only status/date values still equal to
  -- values previously written by the attendance synchronizer. A later manual
  -- lifecycle change wins and is never overwritten.

  if v_raymond_id is not null then
    select
      lower(btrim(employee.status::text)),
      employee.resign_date
    into
      v_raymond_after_status,
      v_raymond_after_resign_date
    from public.employees employee
    where employee.id = v_raymond_id;

    if (
      v_raymond_after_status,
      v_raymond_after_resign_date
    ) is distinct from (
      v_raymond_before_status,
      v_raymond_before_resign_date
    ) then
      raise exception 'cs000766_confirmed_resignation_unexpectedly_changed'
        using detail = jsonb_build_object(
          'before_status', v_raymond_before_status,
          'before_resign_date', v_raymond_before_resign_date,
          'after_status', v_raymond_after_status,
          'after_resign_date', v_raymond_after_resign_date,
          'reconcile_result', v_reconcile_result
        )::text;
    end if;
  end if;

  if v_target_id is not null then
    select
      lower(btrim(employee.status::text)),
      employee.resign_date
    into v_after_status, v_after_resign_date
    from public.employees employee
    where employee.id = v_target_id;

    -- The known incident is eligible for an automatic repair only when the
    -- existing synchronizer proves that it originally changed active ->
    -- resigned on 2026-08-02 from the now-invalid source record.
    if jsonb_array_length(v_bad_target_rows) > 0
      and v_before_status = 'resigned'
      and v_before_resign_date = date '2026-08-02' then
      if v_applied_resign_date is distinct from date '2026-08-02'
        or v_prior_status not in ('active', 'probation', 'suspended')
        or not v_latest_schedule_present
        or v_latest_home_explicit_resignation then
        raise exception 'ja523041401_resignation_repair_state_missing'
          using detail = jsonb_build_object(
            'before_status', v_before_status,
            'before_resign_date', v_before_resign_date,
            'prior_status', v_prior_status,
            'prior_resign_date', v_prior_resign_date,
            'applied_resign_date', v_applied_resign_date,
            'latest_schedule_present', v_latest_schedule_present,
            'latest_home_explicit_resignation',
              v_latest_home_explicit_resignation,
            'source_record_ids', v_source_record_ids,
            'bad_target_rows', v_bad_target_rows,
            'reconcile_result', v_reconcile_result
          )::text;
      end if;

      if (
        v_after_status,
        v_after_resign_date
      ) is distinct from (
        v_prior_status,
        v_prior_resign_date
      ) then
        raise exception 'ja523041401_resignation_repair_precondition_failed'
          using detail = jsonb_build_object(
            'before_status', v_before_status,
            'before_resign_date', v_before_resign_date,
            'prior_status', v_prior_status,
            'prior_resign_date', v_prior_resign_date,
            'after_status', v_after_status,
            'after_resign_date', v_after_resign_date,
            'source_record_ids', v_source_record_ids,
            'bad_target_rows', v_bad_target_rows,
            'reconcile_result', v_reconcile_result
          )::text;
      end if;
    end if;

  end if;

  -- Record every corrected identity link, including rows that had not yet
  -- changed employee status.  This leaves a durable explanation for both the
  -- row repair and any conservative status rollback performed above.
  insert into public.employee_audit_logs (
    employee_id,
    employee_no,
    full_name,
    action,
    source,
    actor_username,
    changes,
    metadata
  )
  select
    repair.employee_id,
    repair.employee_no,
    repair.full_name,
    'attendance_resignation_identity_repair',
    'migration',
    'system',
    jsonb_build_object(
      'status', jsonb_build_object(
        'before', repair.before_status,
        'after', lower(btrim(employee.status::text))
      ),
      'resign_date', jsonb_build_object(
        'before', repair.before_resign_date,
        'after', employee.resign_date
      )
    ),
    jsonb_build_object(
      'migration',
        '20260826153000_attendance_resignation_identity_hardening',
      'reason', 'conflicting_raw_employee_no_name_fallback',
      'prior_status', repair.prior_status,
      'prior_resign_date', repair.prior_resign_date,
      'applied_resign_date', repair.applied_resign_date,
      'source_record_ids', repair.source_record_ids,
      'repaired_rows', repair.repaired_rows,
      'reconcile_result', v_reconcile_result,
      'latest_schedule_present', case
        when public.employee_master_normalize_id(repair.employee_no)
          = 'JA523041401' then v_latest_schedule_present
      end,
      'latest_home_explicit_resignation', case
        when public.employee_master_normalize_id(repair.employee_no)
          = 'JA523041401' then v_latest_home_explicit_resignation
      end
    )
  from attendance_resignation_identity_repair_audit repair
  join public.employees employee on employee.id = repair.employee_id
  where not exists (
    select 1
    from public.employee_audit_logs audit
    where audit.employee_id = repair.employee_id
      and audit.action = 'attendance_resignation_identity_repair'
      and audit.metadata->>'migration'
        = '20260826153000_attendance_resignation_identity_hardening'
  );
end;
$$;

notify pgrst, 'reload schema';
