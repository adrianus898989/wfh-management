-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

insert into public.employees (
  employee_no,
  full_name,
  status,
  hire_date,
  source_type,
  source_sheet,
  official_id_pending,
  profile_status
) values
  (
    'TEST-RESIGN-GUARD-A',
    '__RESIGN_IDENTITY_GUARD_A__',
    'active',
    current_date - 30,
    'backend',
    'SQL regression test',
    false,
    'backend_created'
  ),
  (
    'TEST-RESIGN-GUARD-B',
    '__RESIGN_IDENTITY_GUARD_B__',
    'active',
    current_date - 30,
    'backend',
    'SQL regression test',
    false,
    'backend_created'
  );

do $$
declare
  v_source_id uuid;
  v_employee_a uuid;
  v_employee_b uuid;
  v_record_a uuid;
  v_record_b uuid;
  v_result jsonb;
begin
  select source.id
  into v_source_id
  from public.attendance_sheet_sources source
  where source.source_key = 'home_vimm_annual_2026_09';

  if v_source_id is null then
    raise exception 'annual regression source missing';
  end if;

  select employee.id into v_employee_a
  from public.employees employee
  where employee.employee_no = 'TEST-RESIGN-GUARD-A';

  select employee.id into v_employee_b
  from public.employees employee
  where employee.employee_no = 'TEST-RESIGN-GUARD-B';

  -- A contradictory non-empty ID must not be allowed to attach a resignation
  -- to the unique same-name employee.
  insert into public.employee_attendance_records (
    source_id,
    source_block,
    source_row,
    source_item_key,
    kind,
    event_date,
    event_kind,
    employee_id,
    employee_no_raw,
    employee_name_raw,
    match_status,
    match_method,
    raw_values,
    content_hash,
    is_mirror
  ) values (
    v_source_id,
    'resignation',
    1999000001,
    'identity-guard-conflict',
    'resignation',
    current_date - 1,
    'resignation',
    v_employee_a,
    'UNKNOWN-RESIGN-ID',
    '__RESIGN_IDENTITY_GUARD_A__',
    'matched',
    'name_unique_exact',
    '{}'::jsonb,
    repeat('a', 64),
    false
  )
  returning id into v_record_a;

  if not exists (
    select 1
    from public.employee_attendance_records record
    where record.id = v_record_a
      and record.employee_id is null
      and record.match_status = 'unmatched'
      and record.match_method is null
      and record.matched_at is null
  ) then
    raise exception 'conflicting resignation ID was allowed to fall back to name';
  end if;

  v_result := attendance_private.reconcile_employee_resignations();
  if not exists (
    select 1
    from public.employees employee
    where employee.id = v_employee_a
      and lower(btrim(employee.status::text)) = 'active'
      and employee.resign_date is null
  ) then
    raise exception 'unmatched conflicting resignation changed employee A: %', v_result;
  end if;

  -- An exact non-empty ID remains authoritative and is normalized to the
  -- employee_id_exact method even if an importer proposed a name match.
  insert into public.employee_attendance_records (
    source_id,
    source_block,
    source_row,
    source_item_key,
    kind,
    event_date,
    event_kind,
    employee_id,
    employee_no_raw,
    employee_name_raw,
    match_status,
    match_method,
    raw_values,
    content_hash,
    is_mirror
  ) values (
    v_source_id,
    'resignation',
    1999000002,
    'identity-guard-exact',
    'resignation',
    current_date - 1,
    'resignation',
    v_employee_b,
    '  test-resign-guard-b  ',
    '__RESIGN_IDENTITY_GUARD_B__',
    'matched',
    'name_unique_exact',
    '{}'::jsonb,
    repeat('b', 64),
    false
  )
  returning id into v_record_b;

  if not exists (
    select 1
    from public.employee_attendance_records record
    where record.id = v_record_b
      and record.employee_id = v_employee_b
      and record.match_status = 'matched'
      and record.match_method = 'employee_id_exact'
  ) then
    raise exception 'exact resignation ID was not preserved as employee_id_exact';
  end if;

  v_result := attendance_private.reconcile_employee_resignations();
  if not exists (
    select 1
    from public.employees employee
    where employee.id = v_employee_b
      and lower(btrim(employee.status::text)) = 'resigned'
      and employee.resign_date = current_date - 1
  ) then
    raise exception 'exact resignation ID did not change employee B: %', v_result;
  end if;

  -- If the exact source ID is later corrected to an unknown conflicting ID,
  -- the guard removes the link and the reconciler conservatively restores the
  -- pre-sync state it recorded above.
  update public.employee_attendance_records record
  set
    employee_no_raw = 'UNKNOWN-RESIGN-ID-B',
    employee_id = v_employee_b,
    match_status = 'matched',
    match_method = 'name_unique_exact'
  where record.id = v_record_b;

  if not exists (
    select 1
    from public.employee_attendance_records record
    where record.id = v_record_b
      and record.employee_id is null
      and record.match_status = 'unmatched'
      and record.match_method is null
  ) then
    raise exception 'corrected conflicting ID remained linked to employee B';
  end if;

  v_result := attendance_private.reconcile_employee_resignations();
  if not exists (
    select 1
    from public.employees employee
    where employee.id = v_employee_b
      and lower(btrim(employee.status::text)) = 'active'
      and employee.resign_date is null
  ) then
    raise exception 'stale exact resignation did not restore employee B: %', v_result;
  end if;

  if exists (
    select 1
    from attendance_private.employee_resignation_sync_state state
    where state.employee_id = v_employee_b
  ) then
    raise exception 'stale resignation tracking row was not released';
  end if;
end;
$$;

rollback;
