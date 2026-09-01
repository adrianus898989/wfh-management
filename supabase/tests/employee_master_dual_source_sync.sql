-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

do $$
begin
  if public.employee_master_normalize_id(U&'\FF57\FF44\200B009') <> 'WD009' then
    raise exception 'SQL ID normalization is not NFKC/zero-width equivalent';
  end if;
  if public.employee_master_normalize_shift('DAY SHIFT') <> '白班 Day'
    or public.employee_master_normalize_shift('夜班') <> '夜班 Night'
    or public.employee_master_normalize_shift('MID 11:30') <> '中班 MID 11:30' then
    raise exception 'SQL shift normalization failed';
  end if;
  if public.employee_master_has_explicit_resignation_marker('未离职')
    or public.employee_master_has_explicit_resignation_marker('非離職')
    or public.employee_master_has_explicit_resignation_marker('not-resigned')
    or public.employee_master_has_explicit_resignation_marker('not terminated')
    or not public.employee_master_has_explicit_resignation_marker('已离职') then
    raise exception 'strict resignation marker semantics failed';
  end if;
end;
$$;

insert into public.employees (
  employee_no, full_name, status, source_type, source_sheet,
  official_id_pending, profile_status
) values (
  'TMP-SCHED-SYNC-TEST', '__EMPLOYEE_MASTER_REKEY_TEST__', 'active',
  'schedule_temp', '居家排班表/填表', true, 'needs_official_id'
);

do $$
declare
  v_payload jsonb;
  v_result jsonb;
  v_temp_employee_id uuid;
  v_run_count bigint;
begin
  select id into v_temp_employee_id from public.employees
  where employee_no = 'TMP-SCHED-SYNC-TEST';

  v_payload := jsonb_build_object(
    'request_id', '00000000-0000-4000-8000-000000000101',
    'trigger_kind', 'manual',
    'captured_at', '2099-08-25T01:00:00Z',
    'parser_version', 'employee-master-dual-source-v1',
    'snapshot_hash', repeat('1', 64),
    'parse_warning_count', 0,
    'sources', jsonb_build_object(
      'home_roster', jsonb_build_object(
        'source_key', 'home_employee_roster_current',
        'spreadsheet_id', '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8',
        'sheet_gid', '970844334',
        'tab_name', '在职名单 Current Staff List',
        'snapshot_hash', repeat('2', 64),
        'read_row_count', 3, 'roster_row_count', 1
      ),
      'schedule_roster', jsonb_build_object(
        'source_key', 'home_schedule_roster_current',
        'spreadsheet_id', '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA',
        'sheet_gid', '1457335551', 'tab_name', '填表',
        'snapshot_hash', repeat('3', 64),
        'read_row_count', 2, 'roster_row_count', 1
      )
    ),
    'home_rows', jsonb_build_array(jsonb_build_object(
      'source_row', 3, 'employee_id', U&'\FF37\FF24\200B-SYNC-TEST-001',
      'name', '__EMPLOYEE_MASTER_REKEY_TEST__',
      'name_key', 'employeemasterrekeytest',
      'team', 'TEST TEAM HOME', 'platform', 'HOME PLATFORM',
      'position', 'HOME POSITION', 'shift', 'DAY SHIFT',
      'country', '菲律宾', 'hire_date', '2099-08-01',
      'resign_date', '', 'work_tg', '', 'backend_accounts', '未离职',
      'resign_reason', '', 'explicitly_resigned', true,
      'resignation_signal', 'account_marker'
    )),
    'schedule_rows', jsonb_build_array(jsonb_build_object(
      'source_row', 2, 'employee_id', 'WD-SYNC-TEST-001',
      'name', '__EMPLOYEE_MASTER_REKEY_TEST__',
      'name_key', 'employeemasterrekeytest',
      'responsible', 'TEST PIC', 'onsite_trainer', 'TEST ONSITE',
      'online_leader', 'TEST LEADER', 'online_trainer', 'TEST TRAINER',
      'group', 'TEST GROUP', 'team', 'TEST TEAM SCHEDULE',
      'shift', '夜班', 'country', '菲律宾',
      'position', 'TEST POSITION', 'platform', 'TEST PLATFORM',
      'work_content', 'HOME WORK', 'onsite_marker', false
    ))
  );

  v_result := public.ingest_employee_master_snapshot(v_payload);
  if not coalesce((v_result->>'ok')::boolean, false) then
    raise exception 'initial employee master sync failed: %', v_result;
  end if;
  if not exists (
    select 1 from public.employees employee
    where employee.id = v_temp_employee_id
      and employee.employee_no = 'TMP-SCHED-SYNC-TEST'
      and employee.official_id_pending
  ) then
    raise exception 'name-only evidence automatically rekeyed the TMP employee';
  end if;
  if exists (
    select 1 from public.employee_identity_rekeys rekey
    where rekey.employee_id = v_temp_employee_id
  ) then
    raise exception 'name-only evidence wrote an identity rekey';
  end if;
  if not exists (
    select 1
    from public.employee_master_sync_issues issue
    where issue.run_id = (v_result->>'run_id')::bigint
      and issue.issue_code = 'temporary_official_id_name_only_manual_review'
      and issue.employee_no = 'WD-SYNC-TEST-001'
  ) then
    raise exception 'name-only TMP evidence did not create a manual-review issue';
  end if;
  if not exists (
    select 1 from public.employees employee
    where public.employee_master_normalize_id(employee.employee_no) = 'WD-SYNC-TEST-001'
      and employee.status = 'active'
      and employee.shift_name = '夜班 Night'
  ) then
    raise exception 'official employee was not inserted with canonical ID/shift';
  end if;

  -- The semantic combined hash is the database idempotency key. Raw source
  -- hashes may differ (for example, home M:P changed) without any write.
  select count(*) into v_run_count from public.employee_master_sync_runs;
  v_payload := jsonb_set(v_payload, '{request_id}',
    to_jsonb('00000000-0000-4000-8000-000000000102'::text));
  v_payload := jsonb_set(v_payload, '{captured_at}',
    to_jsonb('2099-08-25T02:00:00Z'::text));
  v_payload := jsonb_set(v_payload, '{sources,home_roster,snapshot_hash}',
    to_jsonb(repeat('4', 64)));
  v_result := public.ingest_employee_master_snapshot(v_payload);
  if v_result->>'status' <> 'unchanged' then
    raise exception 'same semantic hash did not short-circuit: %', v_result;
  end if;
  if (select count(*) from public.employee_master_sync_runs) <> v_run_count
    or exists (
      select 1 from public.employee_master_sync_runs
      where request_id = '00000000-0000-4000-8000-000000000102'
    ) then
    raise exception 'same semantic hash wrote a sync run';
  end if;
end;
$$;

do $$
declare
  v_sequence integer;
  v_payload jsonb;
  v_result jsonb;
begin
  for v_sequence in 1..2 loop
    v_payload := jsonb_build_object(
      'request_id', case v_sequence
        when 1 then '00000000-0000-4000-8000-000000000103'
        else '00000000-0000-4000-8000-000000000104' end,
      'trigger_kind', 'change',
      'captured_at', case v_sequence
        when 1 then '2099-08-25T03:00:00Z'
        else '2099-08-25T04:00:00Z' end,
      'parser_version', 'employee-master-dual-source-v1',
      'snapshot_hash', repeat(case v_sequence when 1 then '5' else '6' end, 64),
      'parse_warning_count', 0,
      'sources', jsonb_build_object(
        'home_roster', jsonb_build_object(
          'source_key', 'home_employee_roster_current',
          'spreadsheet_id', '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8',
          'sheet_gid', '970844334', 'tab_name', '在职名单 Current Staff List',
          'snapshot_hash', repeat(case v_sequence when 1 then '7' else '8' end, 64),
          'read_row_count', 3, 'roster_row_count', 1
        ),
        'schedule_roster', jsonb_build_object(
          'source_key', 'home_schedule_roster_current',
          'spreadsheet_id', '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA',
          'sheet_gid', '1457335551', 'tab_name', '填表',
          'snapshot_hash', repeat(case v_sequence when 1 then '9' else 'a' end, 64),
          'read_row_count', 4, 'roster_row_count', 3
        )
      ),
      'home_rows', jsonb_build_array(jsonb_build_object(
        'source_row', 3, 'employee_id', 'WD-SYNC-TEST-OTHER',
        'name', '__EMPLOYEE_MASTER_OTHER__', 'name_key', 'employeemasterother',
        'team', 'TEST TEAM HOME', 'platform', 'HOME PLATFORM',
        'position', 'HOME POSITION', 'shift', '白班 Day',
        'country', '菲律宾', 'hire_date', '2099-08-01',
        'resign_date', '', 'work_tg', '', 'backend_accounts', '',
        'resign_reason', '', 'explicitly_resigned', false,
        'resignation_signal', 'none'
      )),
      'schedule_rows', jsonb_build_array(
        jsonb_build_object(
          'source_row', 2, 'employee_id', 'WD-SYNC-TEST-OTHER',
          'name', '__EMPLOYEE_MASTER_OTHER__', 'name_key', 'employeemasterother',
          'responsible', '', 'onsite_trainer', '', 'online_leader', '',
          'online_trainer', '', 'group', 'TEST GROUP',
          'team', 'TEST TEAM SCHEDULE', 'shift', '白班 Day',
          'country', '菲律宾', 'position', 'TEST POSITION',
          'platform', 'TEST PLATFORM', 'work_content', '', 'onsite_marker', false
        ),
        jsonb_build_object(
          'source_row', 3, 'employee_id', 'WD-SYNC-ONSITE',
          'name', '__EMPLOYEE_MASTER_ONSITE__', 'name_key', 'employeemasteronsite',
          'responsible', '', 'onsite_trainer', '', 'online_leader', '',
          'online_trainer', '', 'group', 'TEST GROUP',
          'team', 'TEST TEAM SCHEDULE', 'shift', 'DAY SHIFT',
          'country', '菲律宾', 'position', 'TEST POSITION',
          'platform', 'TEST PLATFORM', 'work_content', '现场人员', 'onsite_marker', true
        ),
        jsonb_build_object(
          'source_row', 4, 'employee_id', 'WD-SYNC-NONONSITE',
          'name', '__EMPLOYEE_MASTER_NONONSITE__', 'name_key', 'employeemasternononsite',
          'responsible', '', 'onsite_trainer', '', 'online_leader', '',
          'online_trainer', '', 'group', 'TEST GROUP',
          'team', 'TEST TEAM SCHEDULE', 'shift', 'DAY SHIFT',
          'country', '菲律宾', 'position', 'TEST POSITION',
          'platform', 'TEST PLATFORM', 'work_content', '', 'onsite_marker', false
        )
      )
    );
    v_result := public.ingest_employee_master_snapshot(v_payload);
    if not coalesce((v_result->>'ok')::boolean, false) then
      raise exception 'missing snapshot % failed: %', v_sequence, v_result;
    end if;
  end loop;

  if exists (
    select 1 from public.employees
    where employee_no in ('TMP-SCHED-SYNC-TEST', 'WD-SYNC-TEST-001')
      and status = 'resigned'
  ) then
    raise exception 'absence automatically resigned an employee';
  end if;
  if not exists (
    select 1 from public.employees employee
    join public.employee_master_presence_state state on state.employee_id = employee.id
    where public.employee_master_normalize_id(employee.employee_no) = 'WD-SYNC-TEST-001'
      and employee.status = 'active'
      and state.missing_streak = 2
      and not state.auto_archived
      and not state.eligible_for_disable
  ) then
    raise exception 'two absences were not retained as manual-review-only evidence';
  end if;
  if (
    select count(*) from public.employee_master_sync_issues issue
    where issue.employee_no = 'WD-SYNC-TEST-001'
      and issue.issue_code = 'pending_manual_review'
  ) <> 2 then
    raise exception 'absence did not emit one pending_manual_review issue per run';
  end if;
  if not exists (
    select 1 from public.employees
    where employee_no = 'WD-SYNC-ONSITE' and status = 'active'
  ) or exists (
    select 1 from public.employees where employee_no = 'WD-SYNC-NONONSITE'
  ) then
    raise exception 'schedule-only onsite marker gate failed';
  end if;
  if not exists (
    select 1
    from public.report_sheet_snapshots snapshot
    where snapshot.source = '居家排班表/填表'
      and snapshot.row_count = 3
      and exists (
        select 1 from jsonb_array_elements(snapshot.payload) row
        where row->>'employee_id' = 'WD-SYNC-ONSITE'
      )
      and exists (
        select 1 from jsonb_array_elements(snapshot.payload) row
        where row->>'employee_id' = 'WD-SYNC-NONONSITE'
      )
  ) then
    raise exception 'report snapshot did not retain the complete normalized schedule set';
  end if;
  if not exists (
    select 1 from public.report_employee_directory_cache directory
    where directory.employee_no = 'WD-SYNC-NONONSITE'
      and directory.source_kind = 'roster'
      and directory.shift_name = 'DAY SHIFT'
  ) then
    raise exception 'schedule display cache omitted a non-onsite-marked roster row';
  end if;
  if exists (
    select 1 from public.user_access access
    join public.employees employee on employee.id = access.employee_id
    where employee.employee_no = 'WD-SYNC-ONSITE'
  ) then
    raise exception 'schedule-only sync created a front-end account';
  end if;
end;
$$;

-- A future resignation date must not remove a current employee early.  The
-- same semantic snapshot must still be reprocessed once on the effective day,
-- while an unrelated manually-resigned employee remains untouched.
insert into public.employees (
  employee_no, full_name, status, source_type, source_sheet,
  official_id_pending, profile_status, resign_date, resign_reason
) values (
  'WD-SYNC-MANUAL-RESIGNED', '__EMPLOYEE_MASTER_MANUAL_RESIGNED__',
  'resigned', 'backend_manual', 'backend', false, 'manual_resigned', null,
  'User-confirmed resignation without a supplied effective date.'
);

do $$
declare
  v_payload jsonb;
  v_result jsonb;
begin
  v_payload := jsonb_build_object(
    'request_id', '00000000-0000-4000-8000-000000000107',
    'trigger_kind', 'change', 'captured_at', '2099-09-01T01:00:00Z',
    'parser_version', 'employee-master-dual-source-v1',
    'snapshot_hash', repeat('9', 64), 'parse_warning_count', 0,
    'sources', jsonb_build_object(
      'home_roster', jsonb_build_object(
        'source_key', 'home_employee_roster_current',
        'spreadsheet_id', '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8',
        'sheet_gid', '970844334', 'tab_name', '在职名单 Current Staff List',
        'snapshot_hash', repeat('8', 64), 'read_row_count', 3,
        'roster_row_count', 1
      ),
      'schedule_roster', jsonb_build_object(
        'source_key', 'home_schedule_roster_current',
        'spreadsheet_id', '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA',
        'sheet_gid', '1457335551', 'tab_name', '填表',
        'snapshot_hash', repeat('7', 64), 'read_row_count', 4,
        'roster_row_count', 3
      )
    ),
    'home_rows', jsonb_build_array(jsonb_build_object(
      'source_row', 3, 'employee_id', 'WD-SYNC-FUTURE-RESIGN',
      'name', '__EMPLOYEE_MASTER_FUTURE_RESIGN__',
      'name_key', 'employeemasterfutureresign',
      'team', 'TEST TEAM HOME', 'platform', 'HOME PLATFORM',
      'position', 'HOME POSITION', 'shift', 'DAY SHIFT',
      'country', '菲律宾', 'hire_date', '2099-08-01',
      'resign_date', '2099-09-09', 'work_tg', '',
      'backend_accounts', '辞职',
      'resign_reason', 'Scheduled future resignation',
      'explicitly_resigned', true, 'resignation_signal', 'date'
    )),
    'schedule_rows', jsonb_build_array(
      jsonb_build_object(
        'source_row', 2, 'employee_id', 'WD-SYNC-FUTURE-RESIGN',
        'name', '__EMPLOYEE_MASTER_FUTURE_RESIGN__',
        'name_key', 'employeemasterfutureresign',
        'responsible', '', 'onsite_trainer', '', 'online_leader', '',
        'online_trainer', '', 'group', 'TEST GROUP',
        'team', 'TEST TEAM SCHEDULE', 'shift', 'DAY SHIFT',
        'country', '菲律宾', 'position', 'TEST POSITION',
        'platform', 'TEST PLATFORM', 'work_content', '',
        'onsite_marker', false
      ),
      jsonb_build_object(
        'source_row', 3, 'employee_id', 'WD-SYNC-FUTURE-AUX-1',
        'name', '__EMPLOYEE_MASTER_FUTURE_AUX_1__',
        'name_key', 'employeemasterfutureaux1', 'onsite_marker', true
      ),
      jsonb_build_object(
        'source_row', 4, 'employee_id', 'WD-SYNC-FUTURE-AUX-2',
        'name', '__EMPLOYEE_MASTER_FUTURE_AUX_2__',
        'name_key', 'employeemasterfutureaux2', 'onsite_marker', true
      )
    )
  );

  v_result := public.ingest_employee_master_snapshot(v_payload);
  if not coalesce((v_result->>'ok')::boolean, false)
     or v_result->>'status' = 'unchanged' then
    raise exception 'future resignation initial sync failed: %', v_result;
  end if;
  if not exists (
    select 1 from public.employees employee
    where employee.employee_no = 'WD-SYNC-FUTURE-RESIGN'
      and employee.status = 'active'
      and employee.resign_date is null
  ) then
    raise exception 'future resignation removed the employee before its date';
  end if;
  if exists (
    select 1 from public.employee_lifecycle_events event
    where event.employee_no = 'WD-SYNC-FUTURE-RESIGN'
      and event.event_type = 'resign'
  ) then
    raise exception 'future resignation wrote an early lifecycle event';
  end if;

  v_payload := jsonb_set(v_payload, '{request_id}',
    to_jsonb('00000000-0000-4000-8000-000000000108'::text));
  v_payload := jsonb_set(v_payload, '{captured_at}',
    to_jsonb('2099-09-02T01:00:00Z'::text));
  v_result := public.ingest_employee_master_snapshot(v_payload);
  if v_result->>'status' <> 'unchanged' then
    raise exception 'aligned future resignation was not zero-write: %', v_result;
  end if;

  v_payload := jsonb_set(v_payload, '{request_id}',
    to_jsonb('00000000-0000-4000-8000-000000000109'::text));
  v_payload := jsonb_set(v_payload, '{captured_at}',
    to_jsonb('2099-09-09T01:00:00Z'::text));
  v_result := public.ingest_employee_master_snapshot(v_payload);
  if not coalesce((v_result->>'ok')::boolean, false)
     or v_result->>'status' = 'unchanged' then
    raise exception 'effective-day same-hash reconciliation did not run: %',
      v_result;
  end if;
  if not exists (
    select 1 from public.employees employee
    where employee.employee_no = 'WD-SYNC-FUTURE-RESIGN'
      and employee.status = 'resigned'
      and employee.resign_date = date '2099-09-09'
  ) then
    raise exception 'future resignation was not applied on its effective day';
  end if;
  if not exists (
    select 1 from public.employee_lifecycle_events event
    where event.employee_no = 'WD-SYNC-FUTURE-RESIGN'
      and event.event_type = 'resign'
      and event.effective_date = date '2099-09-09'
  ) then
    raise exception 'effective resignation lifecycle event is missing';
  end if;
  if not exists (
    select 1 from public.employees employee
    where employee.employee_no = 'WD-SYNC-MANUAL-RESIGNED'
      and employee.status = 'resigned'
      and employee.resign_date is null
  ) then
    raise exception 'unrelated manual resignation was modified';
  end if;

  v_payload := jsonb_set(v_payload, '{request_id}',
    to_jsonb('00000000-0000-4000-8000-000000000110'::text));
  v_payload := jsonb_set(v_payload, '{captured_at}',
    to_jsonb('2099-09-10T01:00:00Z'::text));
  v_result := public.ingest_employee_master_snapshot(v_payload);
  if v_result->>'status' <> 'unchanged' then
    raise exception 'aligned effective resignation was not zero-write: %',
      v_result;
  end if;
end;
$$;

do $$
declare
  v_payload jsonb;
  v_result jsonb;
  v_snapshot_run_id bigint;
begin
  select run_id into v_snapshot_run_id
  from public.employee_master_source_snapshots
  where source_key = 'home_employee_roster_current';

  v_payload := jsonb_build_object(
    'request_id', '00000000-0000-4000-8000-000000000105',
    'trigger_kind', 'change', 'captured_at', '2099-09-11T01:00:00Z',
    'parser_version', 'employee-master-dual-source-v1',
    'snapshot_hash', repeat('b', 64), 'parse_warning_count', 0,
    'sources', jsonb_build_object(
      'home_roster', jsonb_build_object(
        'source_key', 'home_employee_roster_current',
        'spreadsheet_id', '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8',
        'sheet_gid', '970844334', 'tab_name', '在职名单 Current Staff List',
        'snapshot_hash', repeat('c', 64), 'read_row_count', 3, 'roster_row_count', 1
      ),
      'schedule_roster', jsonb_build_object(
        'source_key', 'home_schedule_roster_current',
        'spreadsheet_id', '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA',
        'sheet_gid', '1457335551', 'tab_name', '填表',
        'snapshot_hash', repeat('d', 64), 'read_row_count', 4, 'roster_row_count', 3
      )
    ),
    'home_rows', jsonb_build_array(jsonb_build_object(
      'source_row', 3, 'employee_id', 'WD-SYNC-CONFLICT',
      'name', 'Home Name', 'name_key', 'homename', 'team', '', 'platform', '',
      'position', '', 'shift', '', 'country', '', 'hire_date', '',
      'resign_date', '', 'work_tg', '', 'backend_accounts', '',
      'resign_reason', '', 'explicitly_resigned', false, 'resignation_signal', 'none'
    )),
    'schedule_rows', jsonb_build_array(
      jsonb_build_object(
        'source_row', 2, 'employee_id', 'WD-SYNC-CONFLICT',
        'name', 'Schedule Name', 'name_key', 'schedulename',
        'responsible', '', 'onsite_trainer', '', 'online_leader', '',
        'online_trainer', '', 'group', '', 'team', '', 'shift', '',
        'country', '', 'position', '', 'platform', '', 'work_content', '现场人员',
        'onsite_marker', true
      ),
      jsonb_build_object(
        'source_row', 3, 'employee_id', 'WD-SYNC-CONFLICT-AUX-1',
        'name', 'Aux One', 'name_key', 'auxone', 'onsite_marker', true
      ),
      jsonb_build_object(
        'source_row', 4, 'employee_id', 'WD-SYNC-CONFLICT-AUX-2',
        'name', 'Aux Two', 'name_key', 'auxtwo', 'onsite_marker', true
      )
    )
  );
  v_result := public.ingest_employee_master_snapshot(v_payload);
  if coalesce((v_result->>'ok')::boolean, true)
    or v_result->>'error_code' <> 'cross_source_name_mismatch' then
    raise exception 'cross-source identity conflict did not fail closed: %', v_result;
  end if;
  if exists (
    select 1 from public.employees where employee_no = 'WD-SYNC-CONFLICT'
  ) or (select run_id from public.employee_master_source_snapshots
        where source_key = 'home_employee_roster_current') <> v_snapshot_run_id then
    raise exception 'failed cross-source batch mutated canonical state';
  end if;
end;
$$;

-- Per-source completeness compares with the last accepted source count. This
-- direct test adjustment is transactional and only simulates a larger baseline.
update public.employee_master_source_snapshots
set row_count = 10
where source_key = 'home_employee_roster_current';

do $$
declare
  v_result jsonb;
begin
  v_result := public.ingest_employee_master_snapshot(jsonb_build_object(
    'request_id', '00000000-0000-4000-8000-000000000106',
    'trigger_kind', 'change', 'captured_at', '2099-09-12T01:00:00Z',
    'parser_version', 'employee-master-dual-source-v1',
    'snapshot_hash', repeat('e', 64), 'parse_warning_count', 0,
    'sources', jsonb_build_object(
      'home_roster', jsonb_build_object(
        'source_key', 'home_employee_roster_current',
        'spreadsheet_id', '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8',
        'sheet_gid', '970844334', 'tab_name', '在职名单 Current Staff List',
        'snapshot_hash', repeat('f', 64), 'read_row_count', 3, 'roster_row_count', 1
      ),
      'schedule_roster', jsonb_build_object(
        'source_key', 'home_schedule_roster_current',
        'spreadsheet_id', '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA',
        'sheet_gid', '1457335551', 'tab_name', '填表',
        'snapshot_hash', repeat('0', 64), 'read_row_count', 4, 'roster_row_count', 3
      )
    ),
    'home_rows', jsonb_build_array(jsonb_build_object('source_row', 3)),
    'schedule_rows', jsonb_build_array(
      jsonb_build_object('source_row', 2),
      jsonb_build_object('source_row', 3),
      jsonb_build_object('source_row', 4)
    )
  ));
  if coalesce((v_result->>'ok')::boolean, true)
    or v_result->>'error_code' <> 'home_snapshot_incomplete_vs_previous' then
    raise exception 'per-source completeness guard did not fail closed: %', v_result;
  end if;
end;
$$;

rollback;
