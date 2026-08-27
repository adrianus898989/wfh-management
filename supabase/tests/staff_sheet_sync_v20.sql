-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

do $$
declare
  v_definition text;
  v_claim_config text;
  v_holder uuid := gen_random_uuid();
  v_lease jsonb;
begin
  select pg_catalog.pg_get_functiondef(
    'attendance_private.ingest_staff_sheet_sync_v20(text,text,jsonb)'::regprocedure
  ) into v_definition;
  if position('jsonb_array_length(v_items)' in v_definition) = 0
    or position('v_count>8' in replace(v_definition, ' ', '')) = 0
    or position('staff_sheet_sync_requests' in v_definition) = 0 then
    raise exception 'onsite v20 lost its batch bound or request ledger';
  end if;

  if not (select relrowsecurity from pg_catalog.pg_class
    where oid = 'attendance_private.staff_sheet_sync_requests'::regclass) then
    raise exception 'staff sync request ledger does not have RLS enabled';
  end if;
  if has_table_privilege('anon', 'attendance_private.staff_sheet_sync_requests', 'SELECT')
    or has_table_privilege('authenticated', 'attendance_private.staff_sheet_sync_requests', 'SELECT')
    or has_table_privilege('service_role', 'attendance_private.staff_sheet_sync_requests', 'SELECT') then
    raise exception 'staff sync request ledger is directly readable by an API role';
  end if;
  if exists (
    select 1 from information_schema.columns column_info
    where column_info.table_schema = 'attendance_private'
      and column_info.table_name = 'staff_sheet_sync_requests'
      and (column_info.column_name = 'payload' or column_info.column_name like '%secret%')
  ) then
    raise exception 'staff sync request ledger can persist a payload or secret';
  end if;
  if has_function_privilege('anon', 'public.ingest_staff_sheet_sync_v20(text,text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.ingest_staff_sheet_sync_v20(text,text,jsonb)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.ingest_staff_sheet_sync_v20(text,text,jsonb)', 'EXECUTE') then
    raise exception 'staff sync public RPC execution boundary is incorrect';
  end if;

  select array_to_string(proconfig, ',') into v_claim_config
  from pg_catalog.pg_proc
  where oid = 'public.claim_sheet_sync_runtime_lease(text,uuid,integer)'::regprocedure;
  if position('statement_timeout=3s' in coalesce(v_claim_config, '')) = 0
    or position('lock_timeout=1s' in coalesce(v_claim_config, '')) = 0 then
    raise exception 'lease claim fail-fast timeouts were lost: %', v_claim_config;
  end if;

  v_lease := public.claim_sheet_sync_runtime_lease('staff-sheet-sync', v_holder, 30);
  if not coalesce((v_lease->>'ok')::boolean, false)
    or not coalesce((v_lease->>'acquired')::boolean, false) then
    raise exception 'staff sync runtime lease is not allowlisted: %', v_lease;
  end if;
  perform public.release_sheet_sync_runtime_lease('staff-sheet-sync', v_holder);
end;
$$;

do $$
declare
  v_payload jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_employee_id uuid;
  v_updated_at timestamptz;
begin
  v_payload := jsonb_build_object(
    'protocol_version', 'staff-sheet-sync-v20',
    'action', 'sheet_row_changed',
    'items', jsonb_build_array(jsonb_build_object(
      'sheet_name', '现场转居家',
      'row_number', 990001,
      'row', jsonb_build_object(
        'ID', 'ZZ-V20-ONSITE-001',
        '名字', '__STAFF_V20_ONSITE_ONE__',
        '员工国家', '测试国家',
        '国家', 'TEST MARKET',
        '岗位', '__STAFF_V20_POSITION__',
        '盘口', 'TEST PLATFORM',
        '班次', 'DAY SHIFT',
        '最后的地点', 'TEST LOCATION',
        '入职时间', '2099-08-01',
        '回去时间', '',
        '居家时间', '2099年8月2日',
        '离职时间', '',
        '后台账号', '',
        'WORKFOLIO邮箱', 'v20@example.invalid',
        'telegram 用户名', 'v20-test',
        'ZOOM邮箱', 'zoom@example.invalid',
        'Facebook', 'v20-fb',
        'WhatsApp/或者手机号', '000000',
        '居家底薪工资', '1,250.50',
        '绩效', '25',
        '餐补', '10',
        'USDT地址', 'TTestOnlyAddressNotForProduction123'
      ),
      'audit_context', jsonb_build_object('audit', false)
    ))
  );

  v_result := public.ingest_staff_sheet_sync_v20(
    'staff-v20:test-onsite-001', repeat('a', 64), v_payload
  );
  if not coalesce((v_result->>'ok')::boolean, false)
    or (v_result->>'processed')::integer <> 1 then
    raise exception 'valid onsite v20 ingest failed: %', v_result;
  end if;

  select employee.id, employee.updated_at into v_employee_id, v_updated_at
  from public.employees employee
  where employee.employee_no = 'ZZ-V20-ONSITE-001';
  if v_employee_id is null then
    raise exception 'onsite employee was not inserted';
  end if;
  if not exists (
    select 1 from public.employee_contact_profiles profile
    where profile.employee_id = v_employee_id
      and profile.work_email = 'v20@example.invalid'
      and profile.source_sheet = '现场转居家'
  ) or not exists (
    select 1 from public.employee_compensation_settings setting
    where setting.employee_id = v_employee_id
      and setting.base_salary = 1250.50
      and setting.currency = 'USD'
  ) or not exists (
    select 1 from public.employee_payment_profiles profile
    where profile.employee_id = v_employee_id
      and profile.payment_mode = 'usdt'
      and profile.source_sheet = '现场转居家'
  ) then
    raise exception 'onsite profile transaction was incomplete';
  end if;
  if not exists (
    select 1 from public.employee_lifecycle_events event
    where event.employee_id = v_employee_id
      and event.event_type = 'join'
      and event.effective_date = date '2099-08-01'
      and not (event.snapshot ? 'USDT地址')
      and not (event.snapshot ? '居家底薪工资')
  ) then
    raise exception 'sanitized onsite lifecycle event was not written';
  end if;
  if not exists (
    select 1 from attendance_private.staff_sheet_sync_requests request
    where request.request_id = 'staff-v20:test-onsite-001'
      and request.state = 'succeeded'
      and request.payload_hash = repeat('a', 64)
      and request.response->>'ok' = 'true'
  ) then
    raise exception 'onsite request ledger did not persist success';
  end if;

  v_replay := public.ingest_staff_sheet_sync_v20(
    'staff-v20:test-onsite-001', repeat('a', 64), v_payload
  );
  if not coalesce((v_replay->>'idempotent_replay')::boolean, false)
    or (select employee.updated_at from public.employees employee
        where employee.id = v_employee_id) <> v_updated_at then
    raise exception 'onsite idempotent replay performed another write: %', v_replay;
  end if;

  v_result := public.ingest_staff_sheet_sync_v20(
    'staff-v20:test-onsite-001', repeat('b', 64), v_payload
  );
  if v_result->>'error' <> 'request_id_reuse_mismatch' then
    raise exception 'request ID reuse with another hash was accepted: %', v_result;
  end if;

  insert into public.employee_lifecycle_events (
    employee_id, employee_no, full_name, event_type, effective_date,
    source, source_sheet, source_row, source_key, snapshot
  ) values (
    null, 'ZZ-V20-ONSITE-001', '__STAFF_V20_ONSITE_ONE__',
    'profile_update', date '2099-07-01', 'google_sheet_history',
    '现场转居家', 990001, 'staff-v20:test-unlinked-history', '{}'::jsonb
  );
  v_result := public.ingest_staff_sheet_sync_v20(
    'staff-v20:test-unlinked-history-update', repeat('e', 64), v_payload
  );
  if not coalesce((v_result->>'ok')::boolean, false) then
    raise exception 'normal same-ID update was rejected by unlinked history: %', v_result;
  end if;
end;
$$;

do $$
declare
  v_items jsonb;
  v_result jsonb;
  v_index integer;
begin
  -- The second invalid row must roll back the first row while retaining a
  -- failed ledger result outside the nested PL/pgSQL subtransaction.
  v_items := jsonb_build_array(
    jsonb_build_object(
      'sheet_name', '现场转居家', 'row_number', 990002,
      'row', jsonb_build_object(
        'ID', 'ZZ-V20-ROLLBACK-001', '名字', '__STAFF_V20_ROLLBACK__',
        '员工国家', '测试国家', '入职时间', '2099-08-03',
        '岗位', '__STAFF_V20_POSITION__'
      ),
      'audit_context', '{}'::jsonb
    ),
    jsonb_build_object(
      'sheet_name', '现场转居家', 'row_number', 990003,
      'row', jsonb_build_object('ID', '', '名字', '__INVALID__'),
      'audit_context', '{}'::jsonb
    )
  );
  v_result := public.ingest_staff_sheet_sync_v20(
    'staff-v20:test-rollback-001', repeat('c', 64),
    jsonb_build_object(
      'protocol_version', 'staff-sheet-sync-v20',
      'action', 'sheet_batch_sync', 'items', v_items
    )
  );
  if v_result->>'error' <> 'invalid_employee_id'
    or exists (select 1 from public.employees where employee_no = 'ZZ-V20-ROLLBACK-001') then
    raise exception 'invalid batch was partially committed: %', v_result;
  end if;
  if not exists (
    select 1 from attendance_private.staff_sheet_sync_requests request
    where request.request_id = 'staff-v20:test-rollback-001'
      and request.state = 'failed'
      and request.error_code = 'invalid_employee_id'
  ) then
    raise exception 'failed transaction was not recorded in the ledger';
  end if;

  v_items := '[]'::jsonb;
  for v_index in 1..9 loop
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'sheet_name', '现场转居家', 'row_number', 991000 + v_index,
      'row', jsonb_build_object('ID', 'ZZ-V20-BATCH-' || v_index, '名字', 'Batch ' || v_index),
      'audit_context', '{}'::jsonb
    ));
  end loop;
  v_result := public.ingest_staff_sheet_sync_v20(
    'staff-v20:test-batch-limit', repeat('d', 64),
    jsonb_build_object(
      'protocol_version', 'staff-sheet-sync-v20',
      'action', 'sheet_batch_sync', 'items', v_items
    )
  );
  if v_result->>'error' <> 'invalid_batch_size' then
    raise exception 'nine-row onsite batch was accepted: %', v_result;
  end if;
end;
$$;

do $$
declare
  v_result jsonb;
begin
  insert into public.employee_lifecycle_events (
    employee_id, employee_no, full_name, event_type, effective_date,
    source, source_sheet, source_row, source_key, snapshot
  ) values (
    null, 'ZZ-V20-OTHER-HISTORY', '__STAFF_V20_TAKEN_HISTORY__',
    'resign', date '2098-01-01', 'google_sheet_history',
    '历史', 1, 'staff-v20:test-taken-name-history', '{}'::jsonb
  );
  v_result := public.ingest_staff_sheet_sync_v20(
    'staff-v20:test-name-history-conflict', repeat('f', 64),
    jsonb_build_object(
      'protocol_version', 'staff-sheet-sync-v20',
      'action', 'sheet_row_changed',
      'items', jsonb_build_array(jsonb_build_object(
        'sheet_name', '现场转居家', 'row_number', 990004,
        'row', jsonb_build_object(
          'ID', 'ZZ-V20-NAME-CONFLICT',
          '名字', '__STAFF_V20_TAKEN_HISTORY__',
          '员工国家', '测试国家', '入职时间', '2099-08-04'
        ),
        'audit_context', '{}'::jsonb
      ))
    )
  );
  if v_result->>'error' <> 'employee_name_history_conflict'
    or exists (select 1 from public.employees where employee_no = 'ZZ-V20-NAME-CONFLICT') then
    raise exception 'permanent historical name reuse was accepted: %', v_result;
  end if;
end;
$$;

do $$
declare
  v_result jsonb;
begin
  -- An unlinked historical ID may be reclaimed only by the same normalized
  -- historical name. A different person cannot reuse that permanent ID.
  insert into public.employee_lifecycle_events (
    employee_id, employee_no, full_name, event_type, effective_date,
    source, source_sheet, source_row, source_key, snapshot
  ) values (
    null, 'ZZ-V20-HISTORY-ID', '__STAFF_V20_ORIGINAL_HISTORY_NAME__',
    'resign', date '2098-02-01', 'google_sheet_history',
    '历史', 2, 'staff-v20:test-history-id-owner', '{}'::jsonb
  );
  v_result := public.ingest_staff_sheet_sync_v20(
    'staff-v20:test-history-id-reuse', repeat('1', 64),
    jsonb_build_object(
      'protocol_version', 'staff-sheet-sync-v20',
      'action', 'sheet_row_changed',
      'items', jsonb_build_array(jsonb_build_object(
        'sheet_name', '现场转居家', 'row_number', 990005,
        'row', jsonb_build_object(
          'ID', 'ZZ-V20-HISTORY-ID',
          '名字', '__STAFF_V20_DIFFERENT_PERSON__',
          '员工国家', '测试国家', '入职时间', '2099-08-05'
        ),
        'audit_context', '{}'::jsonb
      ))
    )
  );
  if v_result->>'error' <> 'employee_id_history_conflict'
    or exists (select 1 from public.employees where employee_no = 'ZZ-V20-HISTORY-ID') then
    raise exception 'historical employee ID was reused by a different name: %', v_result;
  end if;
end;
$$;

rollback;
