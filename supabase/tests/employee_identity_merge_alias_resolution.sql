-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

insert into public.employees (
  id, employee_no, full_name, status, hire_date, source_type,
  source_sheet, official_id_pending, profile_status
) values
  (
    '00000000-0000-4000-8000-000000000701',
    'TST-CURRENT-001', 'Alias Person', 'active', current_date - 30,
    'backend', 'SQL regression test', false, 'backend_created'
  ),
  (
    '00000000-0000-4000-8000-000000000702',
    'TST-WRONG-NAME', 'Different Person', 'active', current_date - 30,
    'backend', 'SQL regression test', false, 'backend_created'
  );

insert into employee_private.employee_identity_merge_ledger (
  migration_key, source_employee_id, target_employee_id,
  previous_employee_no, official_employee_no, full_name,
  previous_employee_snapshot, moved_reference_counts,
  reason, approved_by
) values (
  'sql-test:employee-identity-alias',
  '00000000-0000-4000-8000-000000000703',
  '00000000-0000-4000-8000-000000000701',
  'TST-ALIAS-001', 'TST-CURRENT-001', 'Alias Person',
  '{"employee_no":"TST-ALIAS-001","full_name":"Alias Person"}'::jsonb,
  '{}'::jsonb, 'SQL regression test', 'sql-test'
);

do $$
declare
  v_blocked boolean := false;
  v_result record;
  v_refresh_definition text := pg_catalog.pg_get_functiondef(
    'public.refresh_schedule_report_snapshot_after_master_sync()'::regprocedure
  );
  v_reconciliation_definition text := pg_catalog.pg_get_functiondef(
    'employee_private.apply_confirmed_employee_identity_reconciliation()'::regprocedure
  );
  v_reconciled_payload jsonb;
  v_work_table_count integer;
begin
  if employee_private.employee_identity_key(' tst.alias_001 ') <>
       employee_private.employee_identity_key('TST-ALIAS-001') then
    raise exception 'identity key does not match the employee unique-index domain';
  end if;

  if employee_private.resolve_confirmed_employee_id(
       ' tst.alias_001 '
     ) <> '00000000-0000-4000-8000-000000000701' then
    raise exception 'confirmed alias did not resolve to the canonical UUID';
  end if;

  begin
    insert into public.employees (
      employee_no, full_name, status, source_type, source_sheet,
      official_id_pending, profile_status
    ) values (
      'TST.ALIAS_001', '__ALIAS_RECREATION__', 'active', 'backend',
      'SQL regression test', false, 'backend_created'
    );
  exception
    when unique_violation then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'a punctuation variant recreated a retired employee ID';
  end if;

  update public.employees
  set employee_no = 'TST-CURRENT-002',
      full_name = 'Alias Person Renamed'
  where id = '00000000-0000-4000-8000-000000000701';

  select *
  into v_result
  from public.resolve_employee_identity_batch(
    array[' tst.alias_001 ']
  );
  if v_result.employee_id <>
       '00000000-0000-4000-8000-000000000701'
     or v_result.canonical_employee_no <> 'TST-CURRENT-002'
     or v_result.confirmed_full_name <> 'Alias Person'
     or not v_result.is_confirmed_alias then
    raise exception 'batch resolver did not retain UUID/current-ID/immutable-name semantics';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated',
       'public.resolve_employee_identity_batch(text[])'::regprocedure,
       'execute'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.resolve_employee_identity_batch(text[])'::regprocedure,
       'execute'
     ) then
    raise exception 'batch resolver privilege boundary changed';
  end if;

  if pg_catalog.strpos(
       v_refresh_definition, 'home_only_missing_schedule'
     ) = 0
     or pg_catalog.strpos(
       v_refresh_definition, 'active_home_employee_not_yet_scheduled'
     ) = 0
     or pg_catalog.strpos(
       v_refresh_definition,
       'employee_master_warning_count_below_issue_count'
     ) = 0 then
    raise exception 'continuous home-only discrepancy maintenance is missing';
  end if;

  if pg_catalog.strpos(
       v_refresh_definition,
       'inline_directory_cache_diff_refresh_v1'
     ) = 0
     or pg_catalog.strpos(
       v_refresh_definition, 'public.report_employee_directory_cache_matches'
     ) > 0
     or pg_catalog.strpos(
       v_refresh_definition,
       'employee_private.report_employee_directory_cache_diff'
     ) > 0
     or pg_catalog.strpos(
       v_refresh_definition,
       'execute $' || 'directory_cache_diff_refresh$'
     ) = 0
     or pg_catalog.strpos(
       v_refresh_definition, 'jsonb_array_elements($1::jsonb)'
     ) = 0
     or pg_catalog.strpos(
       v_refresh_definition,
       'using v_canonical_payload, v_row_count'
     ) = 0
     or pg_catalog.strpos(
       v_refresh_definition, 'from public.report_employee_directory_cache'
     ) = 0
     or pg_catalog.strpos(v_refresh_definition, '''missing_cached''') = 0
     or pg_catalog.strpos(v_refresh_definition, '''extra_cached''') = 0
     or pg_catalog.strpos(v_refresh_definition, '''field_mismatch''') = 0
     or pg_catalog.strpos(v_refresh_definition, '''input_rows''') = 0
     or pg_catalog.strpos(v_refresh_definition, '''row_count''') = 0
     or pg_catalog.strpos(v_refresh_definition, 'limit 5') = 0 then
    raise exception 'inline directory-cache verifier is incomplete';
  end if;

  if to_regprocedure(
       'employee_private.report_employee_directory_cache_diff(jsonb)'
     ) is not null then
    raise exception 'nested directory-cache verifier was retained';
  end if;

  if pg_catalog.strpos(
       v_reconciliation_definition,
       'employee_private.employee_identity_reconcile_merge_plan'
     ) = 0
     or pg_catalog.strpos(
       v_reconciliation_definition,
       'employee_identity_reconciliation_work_state_not_empty'
     ) = 0
     or pg_catalog.strpos(v_reconciliation_definition, 'pg_temp.') > 0
     or pg_catalog.strpos(
       v_reconciliation_definition, 'create temporary table'
     ) > 0
     or pg_catalog.strpos(v_reconciliation_definition, 'drop table') > 0
     or pg_catalog.strpos(v_reconciliation_definition, 'alter table') > 0
     or pg_catalog.strpos(v_reconciliation_definition, 'create trigger') > 0
     or pg_catalog.strpos(v_reconciliation_definition, 'truncate ') > 0 then
    raise exception 'phase-B reconciliation is not DML-only';
  end if;

  if pg_catalog.has_function_privilege(
       'service_role',
       'employee_private.apply_confirmed_employee_identity_reconciliation()'::regprocedure,
       'execute'
     ) then
    raise exception 'phase-B reconciliation escaped its owner-only boundary';
  end if;

  select count(*)::integer
  into v_work_table_count
  from (
    values
      ('employee_identity_reconcile_approved_schedule'::text),
      ('employee_identity_reconcile_merge_plan'::text),
      ('employee_identity_reconcile_target_schedule_fields'::text),
      ('employee_identity_reconcile_expected_fk'::text),
      ('employee_identity_reconcile_expected_name_mismatch'::text),
      ('employee_identity_reconcile_actual_name_mismatch'::text),
      ('employee_identity_reconcile_source_presence'::text),
      ('employee_identity_reconcile_cross_name_mismatch'::text)
  ) expected(table_name)
  join pg_catalog.pg_namespace namespace
    on namespace.nspname = 'employee_private'
  join pg_catalog.pg_class relation
    on relation.relnamespace = namespace.oid
   and relation.relname = expected.table_name
   and relation.relkind = 'r'
   and relation.relrowsecurity
  where not exists (
    select 1
    from (
      values
        ('anon'::text),
        ('authenticated'::text),
        ('service_role'::text)
    ) boundary_role(role_name)
    cross join (
      values
        ('select'::text),
        ('insert'::text),
        ('update'::text),
        ('delete'::text),
        ('truncate'::text),
        ('references'::text),
        ('trigger'::text)
    ) boundary_privilege(privilege_name)
    where pg_catalog.has_table_privilege(
      boundary_role.role_name,
      relation.oid,
      boundary_privilege.privilege_name
    )
  );
  if v_work_table_count <> 8 then
    raise exception 'phase-B work-table boundary changed';
  end if;

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_approved_schedule
    union all
    select 1
    from employee_private.employee_identity_reconcile_merge_plan
    union all
    select 1
    from
      employee_private.employee_identity_reconcile_target_schedule_fields
    union all
    select 1
    from employee_private.employee_identity_reconcile_expected_fk
    union all
    select 1
    from
      employee_private.employee_identity_reconcile_expected_name_mismatch
    union all
    select 1
    from
      employee_private.employee_identity_reconcile_actual_name_mismatch
    union all
    select 1
    from employee_private.employee_identity_reconcile_source_presence
    union all
    select 1
    from employee_private.employee_identity_reconcile_cross_name_mismatch
  ) then
    raise exception 'phase-B work tables were not empty after reconciliation';
  end if;

  select snapshot.payload
  into v_reconciled_payload
  from public.report_sheet_snapshots snapshot
  where snapshot.source = '居家排班表/填表'
    and snapshot.note like '%identity-reconciled%'
  order by snapshot.synced_at desc
  limit 1;
  if v_reconciled_payload is null
     or not public.report_employee_directory_cache_matches(
       v_reconciled_payload
     ) then
    raise exception 'reconciliation inline directory-cache check did not persist';
  end if;
end;
$$;

do $$
declare
  v_source_id uuid;
  v_match_id uuid;
  v_missing_name_id uuid;
  v_conflict_id uuid;
begin
  select source.id
  into v_source_id
  from public.attendance_sheet_sources source
  where source.source_key = 'home_vimm_annual_2026_09';
  if v_source_id is null then
    raise exception 'attendance alias test source is missing';
  end if;

  insert into public.employee_attendance_records (
    source_id, source_block, source_row, source_item_key, kind,
    event_date, event_kind, amount, raw_amount,
    employee_no_raw, employee_name_raw, match_status,
    raw_values, content_hash, is_mirror
  ) values (
    v_source_id, 'adjustment', 1999000701, 'identity-alias-name',
    'adjustment', current_date, 'bonus', 1, '1',
    'TST.ALIAS_001', 'Alias Person', 'unmatched',
    '{}'::jsonb, repeat('7', 64), false
  ) returning id into v_match_id;

  insert into public.employee_attendance_records (
    source_id, source_block, source_row, source_item_key, kind,
    event_date, event_kind, amount, raw_amount,
    employee_no_raw, employee_name_raw, match_status,
    raw_values, content_hash, is_mirror
  ) values (
    v_source_id, 'adjustment', 1999000702, 'identity-alias-no-name',
    'adjustment', current_date, 'bonus', 1, '1',
    'TST-ALIAS-001', null, 'unmatched',
    '{}'::jsonb, repeat('8', 64), false
  ) returning id into v_missing_name_id;

  insert into public.employee_attendance_records (
    source_id, source_block, source_row, source_item_key, kind,
    event_date, event_kind, amount, raw_amount,
    employee_no_raw, employee_name_raw, match_status,
    raw_values, content_hash, is_mirror
  ) values (
    v_source_id, 'adjustment', 1999000703, 'identity-alias-conflict',
    'adjustment', current_date, 'bonus', 1, '1',
    'TST-ALIAS-001', 'Different Person', 'matched',
    '{}'::jsonb, repeat('9', 64), false
  ) returning id into v_conflict_id;

  if (select count(*)
      from public.employee_attendance_records record
      where record.id in (v_match_id, v_missing_name_id)
        and record.employee_id =
          '00000000-0000-4000-8000-000000000701'
        and record.match_status = 'matched'
        and record.match_method = 'employee_id_exact') <> 2 then
    raise exception 'attendance alias did not accept immutable/missing-name evidence';
  end if;
  if not exists (
    select 1
    from public.employee_attendance_records record
    where record.id = v_conflict_id
      and record.employee_id is null
      and record.match_status = 'unmatched'
      and record.match_method is null
  ) then
    raise exception 'attendance alias name conflict did not fail closed';
  end if;
end;
$$;

insert into public.legacy_exam_sessions (
  id, source_project_ref, source_session_id, employee_no, employee_name,
  employee_match_status, status
) values
  (
    '00000000-0000-4000-8000-000000000704',
    '__identity_alias_test__',
    '00000000-0000-4000-8000-000000000705',
    'TST.ALIAS_001', 'Alias Person', 'unmatched', 'submitted'
  ),
  (
    '00000000-0000-4000-8000-000000000706',
    '__identity_alias_test__',
    '00000000-0000-4000-8000-000000000707',
    'TST-ALIAS-001', null, 'unmatched', 'submitted'
  ),
  (
    '00000000-0000-4000-8000-000000000708',
    '__identity_alias_test__',
    '00000000-0000-4000-8000-000000000709',
    'TST-ALIAS-001', 'Different Person', 'matched', 'submitted'
  );

do $$
begin
  if (select count(*)
      from public.legacy_exam_sessions session
      where session.id in (
        '00000000-0000-4000-8000-000000000704',
        '00000000-0000-4000-8000-000000000706'
      )
        and session.employee_id =
          '00000000-0000-4000-8000-000000000701'
        and session.employee_match_status = 'matched') <> 2 then
    raise exception 'legacy exam alias did not accept immutable/missing-name evidence';
  end if;
  if not exists (
    select 1
    from public.legacy_exam_sessions session
    where session.id = '00000000-0000-4000-8000-000000000708'
      and session.employee_id is null
      and session.employee_match_status = 'ambiguous'
  ) then
    raise exception 'legacy exam alias name conflict did not fail closed';
  end if;
end;
$$;

do $$
declare
  v_batch_id bigint;
  v_match_id bigint;
  v_conflict_id bigint;
begin
  insert into public.payroll_batches (
    period_start, title, status, source_type
  ) values (
    date_trunc('month', current_date)::date,
    '__IDENTITY_ALIAS_TEST__', 'draft', 'upload'
  ) returning id into v_batch_id;

  insert into public.payroll_payslips (
    batch_id, period_start, employee_no_raw, full_name, hire_date,
    source_row, raw_payload
  ) values (
    v_batch_id, date_trunc('month', current_date)::date,
    'TST.ALIAS_001', 'Alias Person', current_date - 30,
    1, '{}'::jsonb
  ) returning id into v_match_id;

  insert into public.payroll_payslips (
    batch_id, period_start, employee_no_raw, full_name, hire_date,
    source_row, raw_payload
  ) values (
    v_batch_id, date_trunc('month', current_date)::date,
    'TST-ALIAS-001', 'Different Person', current_date - 30,
    2, '{}'::jsonb
  ) returning id into v_conflict_id;

  if not exists (
    select 1 from public.payroll_payslips payslip
    where payslip.id = v_match_id
      and payslip.employee_id =
        '00000000-0000-4000-8000-000000000701'
      and payslip.identity_match_state = 'employee'
      and payslip.identity_match_source = 'confirmed_employee_id_alias'
  ) then
    raise exception 'payroll alias did not resolve immutable-name evidence';
  end if;
  if not exists (
    select 1 from public.payroll_payslips payslip
    where payslip.id = v_conflict_id
      and payslip.employee_id is null
      and payslip.identity_match_state = 'unmatched'
      and payslip.identity_match_source =
        'confirmed_employee_id_alias_conflict'
  ) then
    raise exception 'payroll alias name conflict did not fail closed';
  end if;
  if exists (
    select 1
    from payroll_private.employee_identity_aliases alias
    where alias.old_employee_no_key =
      employee_private.employee_identity_key('TST-ALIAS-001')
  ) then
    raise exception 'payroll heuristic polluted its alias table before the final guard';
  end if;
end;
$$;

rollback;
