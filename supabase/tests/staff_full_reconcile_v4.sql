-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

do $$
declare
  v_definition text;
  v_config text;
begin
  select pg_catalog.pg_get_functiondef(
    'attendance_private.ingest_staff_full_reconcile_v4(text,text,jsonb)'::regprocedure
  ) into v_definition;
  if position('jsonb_array_length(v_items)' in v_definition) = 0
    or position('v_count>8' in replace(v_definition, ' ', '')) = 0
    or position('staff_full_reconcile_requests' in v_definition) = 0 then
    raise exception 'bank v4 lost its batch bound or durable request ledger';
  end if;
  if position('employee_payment_profiles' in v_definition) = 0
    or position('employee_contact_profiles' in v_definition) = 0
    or position('employee_name_mismatch' in v_definition) = 0
    or position('bank_binding_dry_run' in v_definition) = 0
    or position('update public.employees' in lower(v_definition)) > 0
    or position('employee_compensation_settings' in v_definition) > 0 then
    raise exception 'bank v4 crossed its payment/contact ownership boundary';
  end if;

  if not (select relrowsecurity from pg_catalog.pg_class
    where oid = 'attendance_private.staff_full_reconcile_requests'::regclass) then
    raise exception 'bank request ledger does not have RLS enabled';
  end if;
  if has_table_privilege('anon', 'attendance_private.staff_full_reconcile_requests', 'SELECT')
    or has_table_privilege('authenticated', 'attendance_private.staff_full_reconcile_requests', 'SELECT')
    or has_table_privilege('service_role', 'attendance_private.staff_full_reconcile_requests', 'SELECT') then
    raise exception 'bank request ledger is directly readable by an API role';
  end if;
  if exists (
    select 1 from information_schema.columns column_info
    where column_info.table_schema = 'attendance_private'
      and column_info.table_name = 'staff_full_reconcile_requests'
      and (column_info.column_name = 'payload' or column_info.column_name like '%secret%')
  ) then
    raise exception 'bank request ledger can persist a payload or secret';
  end if;
  if has_function_privilege('anon', 'public.ingest_staff_full_reconcile_v4(text,text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.ingest_staff_full_reconcile_v4(text,text,jsonb)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.ingest_staff_full_reconcile_v4(text,text,jsonb)', 'EXECUTE') then
    raise exception 'bank v4 public RPC execution boundary is incorrect';
  end if;

  select array_to_string(proconfig, ',') into v_config
  from pg_catalog.pg_proc
  where oid = 'attendance_private.ingest_staff_full_reconcile_v4(text,text,jsonb)'::regprocedure;
  if position('statement_timeout=8s' in coalesce(v_config, '')) = 0
    or position('lock_timeout=2s' in coalesce(v_config, '')) = 0 then
    raise exception 'bank v4 fail-fast timeouts were lost: %', v_config;
  end if;
end;
$$;

do $$
declare
  v_employee_id uuid;
  v_payload jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_payment_updated_at timestamptz;
  v_payment_before jsonb;
  v_payment_after jsonb;
  v_employee_before jsonb;
  v_employee_after jsonb;
begin
  insert into public.employees (
    employee_no, full_name, country, nationality, employment_type,
    status, source_type, source_sheet, market_country, market_position,
    team_id, position_id, hire_date
  ) values (
    'ZZ-BANK-V4-CURRENT', '__BANK_V4_EMPLOYEE__', '印尼', '印尼', '纯居家',
    'active', 'google_sheet', '在职名单 Current Staff List',
    '__BANK_V4_TEAM_MARKER__', '__BANK_V4_POSITION_MARKER__',
    null, null, date '2099-01-01'
  ) returning id into v_employee_id;

  insert into public.employee_lifecycle_events (
    employee_id, employee_no, full_name, event_type, effective_date,
    source, source_sheet, source_row, source_key, snapshot
  ) values (
    v_employee_id, 'ZZ-BANK-V4-OLD', '__BANK_V4_EMPLOYEE__',
    'profile_update', date '2099-01-02', 'google_sheet_history',
    '在职名单 Current Staff List', 999001, 'bank-v4:test-alias', '{}'::jsonb
  );

  select jsonb_build_object(
    'employee_no', employee.employee_no, 'full_name', employee.full_name,
    'status', employee.status, 'source_sheet', employee.source_sheet,
    'market_country', employee.market_country,
    'market_position', employee.market_position, 'hire_date', employee.hire_date
  ) into v_employee_before
  from public.employees employee where employee.id = v_employee_id;

  v_payload := jsonb_build_object(
    'protocol_version', 'staff-full-reconcile-v4',
    'action', 'bank_row_changed',
    'items', jsonb_build_array(jsonb_build_object(
      'row_number', 999101,
      'row', jsonb_build_object(
        '__WFH员工ID', 'ZZ-BANK-V4-OLD',
        'FULL NAME / 姓名', '__BANK_V4_EMPLOYEE__',
        'TRANSFER USING', 'USDT',
        'GCASH ACCOUNT / GCASH 账号', 'T11111111111111111111111111111111',
        '联系电话 / CONTACT PHONE NUMBER', 'test-phone',
        'WhatsApp Number', 'test-whatsapp',
        '脸书   /   FACEBOOK', 'test-facebook',
        '员工地址/Employee address', 'test-address'
      )
    ))
  );

  v_result := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-alias-001', repeat('a', 64), v_payload
  );
  if not coalesce((v_result->>'ok')::boolean, false)
    or not coalesce((v_result->>'write_performed')::boolean, false)
    or v_result#>>'{results,0,matched_by}' <> 'lifecycle_alias' then
    raise exception 'valid old-ID bank ingest failed: %', v_result;
  end if;
  if not exists (
    select 1 from public.employee_payment_profiles profile
    where profile.employee_id = v_employee_id
      and profile.payment_mode = 'usdt'
      and profile.payment_mode_source = '银行信息'
      and profile.source_sheet = '银行信息'
      and profile.usdt_address = 'T11111111111111111111111111111111'
      and profile.contact_phone = 'test-phone'
  ) or not exists (
    select 1 from public.employee_contact_profiles profile
    where profile.employee_id = v_employee_id
      and profile.facebook = 'test-facebook'
      and profile.whatsapp_phone = 'test-whatsapp'
  ) then
    raise exception 'bank payment/contact transaction was incomplete';
  end if;

  select jsonb_build_object(
    'employee_no', employee.employee_no, 'full_name', employee.full_name,
    'status', employee.status, 'source_sheet', employee.source_sheet,
    'market_country', employee.market_country,
    'market_position', employee.market_position, 'hire_date', employee.hire_date
  ) into v_employee_after
  from public.employees employee where employee.id = v_employee_id;
  if v_employee_after is distinct from v_employee_before then
    raise exception 'bank writer mutated employee-master-owned fields';
  end if;

  select updated_at into v_payment_updated_at
  from public.employee_payment_profiles where employee_id = v_employee_id;
  v_replay := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-alias-001', repeat('a', 64), v_payload
  );
  if not coalesce((v_replay->>'idempotent_replay')::boolean, false)
    or (select updated_at from public.employee_payment_profiles
        where employee_id = v_employee_id) <> v_payment_updated_at then
    raise exception 'bank idempotent replay performed another write: %', v_replay;
  end if;

  -- Empty source cells are not deletion instructions. A later full-row event
  -- may omit optional payment/contact fields and must preserve known values.
  select to_jsonb(profile) - 'updated_at' into v_payment_before
  from public.employee_payment_profiles profile where profile.employee_id = v_employee_id;
  v_result := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-blank-preserve', repeat('f', 64),
    jsonb_build_object(
      'protocol_version', 'staff-full-reconcile-v4',
      'action', 'bank_row_changed',
      'items', jsonb_build_array(jsonb_build_object(
        'row_number', 999104,
        'row', jsonb_build_object(
          '__WFH员工ID', 'ZZ-BANK-V4-CURRENT',
          'FULL NAME / 姓名', '__BANK_V4_EMPLOYEE__',
          'TRANSFER USING', 'USDT',
          'GCASH ACCOUNT / GCASH 账号', '',
          'GCASH NAME / GCASH 姓名', '',
          '联系电话 / CONTACT PHONE NUMBER', '',
          'WhatsApp Number', '',
          '脸书   /   FACEBOOK', '',
          '员工地址/Employee address', ''
        )
      ))
    )
  );
  select to_jsonb(profile) - 'updated_at' into v_payment_after
  from public.employee_payment_profiles profile where profile.employee_id = v_employee_id;
  if not coalesce((v_result->>'ok')::boolean, false)
    or v_payment_after is distinct from v_payment_before
    or (select contact.facebook from public.employee_contact_profiles contact
        where contact.employee_id = v_employee_id) <> 'test-facebook'
    or (select contact.whatsapp_phone from public.employee_contact_profiles contact
        where contact.employee_id = v_employee_id) <> 'test-whatsapp' then
    raise exception 'blank bank fields erased an existing value: % / % / %',
      v_result, v_payment_before, v_payment_after;
  end if;

  select profile.updated_at into v_payment_updated_at
  from public.employee_payment_profiles profile where profile.employee_id = v_employee_id;
  v_result := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-empty-noop', repeat('5', 64),
    jsonb_build_object(
      'protocol_version', 'staff-full-reconcile-v4',
      'action', 'bank_row_changed',
      'items', jsonb_build_array(jsonb_build_object(
        'row_number', 999109,
        'row', jsonb_build_object(
          '__WFH员工ID', 'ZZ-BANK-V4-CURRENT',
          'FULL NAME / 姓名', '__BANK_V4_EMPLOYEE__'
        )
      ))
    )
  );
  if v_result#>>'{results,0,status}' <> 'no_changes'
    or (select profile.updated_at from public.employee_payment_profiles profile
        where profile.employee_id = v_employee_id) <> v_payment_updated_at then
    raise exception 'empty bank row was treated as a deletion or profile write: %', v_result;
  end if;

  v_result := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-alias-001', repeat('b', 64), v_payload
  );
  if v_result->>'error' <> 'request_id_reuse_mismatch' then
    raise exception 'bank request ID reuse with another hash was accepted: %', v_result;
  end if;
end;
$$;

do $$
declare
  v_employee_id uuid;
  v_payload jsonb;
  v_result jsonb;
  v_before_account text;
  v_items jsonb := '[]'::jsonb;
  v_index integer;
begin
  select employee.id into v_employee_id
  from public.employees employee where employee.employee_no = 'ZZ-BANK-V4-CURRENT';
  select profile.usdt_address into v_before_account
  from public.employee_payment_profiles profile where profile.employee_id = v_employee_id;

  -- The valid first row must roll back when a later old-ID alias carries a
  -- mismatching visible name.
  v_payload := jsonb_build_object(
    'protocol_version', 'staff-full-reconcile-v4',
    'action', 'bank_batch_changed',
    'items', jsonb_build_array(
      jsonb_build_object(
        'row_number', 999102,
        'row', jsonb_build_object(
          '__WFH员工ID', 'ZZ-BANK-V4-CURRENT',
          'FULL NAME / 姓名', '__BANK_V4_EMPLOYEE__',
          'TRANSFER USING', 'USDT',
          'GCASH ACCOUNT / GCASH 账号', 'T22222222222222222222222222222222'
        )
      ),
      jsonb_build_object(
        'row_number', 999103,
        'row', jsonb_build_object(
          '__WFH员工ID', 'ZZ-BANK-V4-OLD',
          'FULL NAME / 姓名', '__WRONG_IDENTITY__'
        )
      )
    )
  );
  v_result := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-rollback-001', repeat('c', 64), v_payload
  );
  if v_result->>'error' <> 'employee_name_mismatch'
    or (select profile.usdt_address from public.employee_payment_profiles profile
        where profile.employee_id = v_employee_id) is distinct from v_before_account then
    raise exception 'invalid bank batch partially committed: %', v_result;
  end if;

  -- A current employee number is not sufficient: its visible normalized name
  -- must also agree, and a rejected row must not mutate the profile.
  v_result := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-current-name-mismatch', repeat('9', 64),
    jsonb_build_object(
      'protocol_version', 'staff-full-reconcile-v4',
      'action', 'bank_row_changed',
      'items', jsonb_build_array(jsonb_build_object(
        'row_number', 999105,
        'row', jsonb_build_object(
          '__WFH员工ID', 'ZZ-BANK-V4-CURRENT',
          'FULL NAME / 姓名', '__WRONG_CURRENT_IDENTITY__',
          'TRANSFER USING', 'USDT',
          'GCASH ACCOUNT / GCASH 账号', 'T33333333333333333333333333333333'
        )
      ))
    )
  );
  if v_result->>'error' <> 'employee_name_mismatch'
    or (select profile.usdt_address from public.employee_payment_profiles profile
        where profile.employee_id = v_employee_id) is distinct from v_before_account then
    raise exception 'current-ID name mismatch wrote payment data: %', v_result;
  end if;

  for v_index in 1..9 loop
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'row_number', 999200 + v_index,
      'row', jsonb_build_object(
        '__WFH员工ID', 'ZZ-BANK-V4-CURRENT',
        'FULL NAME / 姓名', '__BANK_V4_EMPLOYEE__'
      )
    ));
  end loop;
  v_result := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-batch-limit', repeat('d', 64),
    jsonb_build_object(
      'protocol_version', 'staff-full-reconcile-v4',
      'action', 'bank_batch_changed', 'items', v_items
    )
  );
  if v_result->>'error' <> 'invalid_batch_size' then
    raise exception 'nine-row bank batch was accepted: %', v_result;
  end if;
end;
$$;

do $$
declare
  v_employee_id uuid;
  v_payload jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_payment_updated_at timestamptz;
  v_employee_before jsonb;
  v_employee_after jsonb;
begin
  select employee.id, to_jsonb(employee)
  into v_employee_id, v_employee_before
  from public.employees employee
  where employee.employee_no = 'ZZ-BANK-V4-CURRENT';
  select profile.updated_at into v_payment_updated_at
  from public.employee_payment_profiles profile
  where profile.employee_id = v_employee_id;

  v_payload := jsonb_build_object(
    'protocol_version', 'staff-full-reconcile-v4',
    'action', 'bank_binding_dry_run',
    'items', jsonb_build_array(jsonb_build_object(
      'row_number', 999106,
      'source_name_count', 1,
      'row', jsonb_build_object(
        'FULL NAME / 姓名', '__BANK_V4_EMPLOYEE__',
        'TRANSFER USING', 'USDT',
        'GCASH ACCOUNT / GCASH 账号', 'T11111111111111111111111111111111'
      )
    ))
  );
  v_result := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-dry-run-plan', repeat('e', 64), v_payload
  );
  select to_jsonb(employee) into v_employee_after
  from public.employees employee where employee.id = v_employee_id;
  if not coalesce((v_result->>'ok')::boolean, false)
    or not coalesce((v_result->>'dry_run')::boolean, false)
    or coalesce((v_result->>'write_performed')::boolean, true)
    or v_result#>>'{results,0,status}' <> 'ready'
    or v_result#>>'{results,0,resolved_employee_no}' <> 'ZZ-BANK-V4-CURRENT'
    or not coalesce((v_result#>>'{results,0,name_verified}')::boolean, false)
    or (select profile.updated_at from public.employee_payment_profiles profile
        where profile.employee_id = v_employee_id) <> v_payment_updated_at
    or v_employee_after is distinct from v_employee_before then
    raise exception 'bank dry-run planned by name but was not read-only: %', v_result;
  end if;
  if not exists (
    select 1 from attendance_private.staff_full_reconcile_requests request
    where request.request_id = 'bank-v4:test-dry-run-plan'
      and request.action = 'bank_binding_dry_run'
      and request.state = 'succeeded'
      and request.response->>'write_performed' = 'false'
  ) then
    raise exception 'bank dry-run did not leave a durable read-only ledger receipt';
  end if;
  v_replay := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-dry-run-plan', repeat('e', 64), v_payload
  );
  if not coalesce((v_replay->>'idempotent_replay')::boolean, false)
    or coalesce((v_replay->>'write_performed')::boolean, true) then
    raise exception 'bank dry-run replay lost read-only semantics: %', v_replay;
  end if;

  v_result := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-source-duplicate', repeat('7', 64),
    jsonb_build_object(
      'protocol_version', 'staff-full-reconcile-v4',
      'action', 'bank_binding_dry_run',
      'items', jsonb_build_array(jsonb_build_object(
        'row_number', 999107,
        'source_name_count', 2,
        'row', jsonb_build_object(
          '__WFH员工ID', 'ZZ-BANK-V4-CURRENT',
          'FULL NAME / 姓名', '__BANK_V4_EMPLOYEE__'
        )
      ))
    )
  );
  if v_result#>>'{results,0,status}' <> 'source_name_duplicate'
    or coalesce((v_result->>'write_performed')::boolean, true) then
    raise exception 'duplicate source name escaped the dry-run quarantine: %', v_result;
  end if;

  v_result := public.ingest_staff_full_reconcile_v4(
    'bank-v4:test-invalid-binding-plan', repeat('6', 64),
    jsonb_build_object(
      'protocol_version', 'staff-full-reconcile-v4',
      'action', 'bank_binding_dry_run',
      'items', jsonb_build_array(jsonb_build_object(
        'row_number', 999108,
        'source_name_count', 1,
        'row', jsonb_build_object(
          '__WFH员工ID', 'ZZ-BANK-V4-DOES-NOT-EXIST',
          'FULL NAME / 姓名', '__BANK_V4_EMPLOYEE__'
        )
      ))
    )
  );
  if v_result#>>'{results,0,status}' <> 'employee_binding_not_found'
    or coalesce((v_result->>'write_performed')::boolean, true) then
    raise exception 'invalid hidden binding aborted or escaped dry-run quarantine: %', v_result;
  end if;
end;
$$;

rollback;
