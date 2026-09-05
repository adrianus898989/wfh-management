-- Local integration test. Run only against a disposable database after all
-- migrations. Every fixture and DDL mutation is rolled back.

begin;

do $contract$
declare
  v_definition text;
  v_strict_definition text;
  v_security_definer boolean;
  v_config text[];
  v_index_unique boolean;
  v_archive_rls boolean;
  v_repair_archive_rls boolean;
  v_repair_definition text;
begin
  select
    pg_catalog.pg_get_functiondef(procedure.oid),
    procedure.prosecdef,
    procedure.proconfig
  into v_definition, v_security_definer, v_config
  from pg_catalog.pg_proc procedure
  where procedure.oid =
    'public.ingest_adjustment_sheet_inbound_without_category(jsonb)'::regprocedure;

  select pg_catalog.pg_get_functiondef(procedure.oid)
  into v_strict_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid =
    'public.ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut(jsonb)'::regprocedure;

  if not coalesce(v_security_definer, false)
     or position(
       'search_path=' in coalesce(array_to_string(v_config, ','), '')
     ) = 0
     or position('pg_catalog.pg_advisory_xact_lock' in v_definition) = 0
     or position('adjustment-slot-v1' in v_definition) = 0
     or position('identity_stale_short_circuited' in v_definition) = 0
     or position(
       'public.ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut'
       in v_definition
     ) = 0
     or position('identity_rekeyed' in v_strict_definition) = 0
     or position('identity_stale_ignored' in v_strict_definition) = 0
     or position(
       'public.ingest_adjustment_sheet_inbound_without_slot_recovery'
       in v_strict_definition
     ) = 0 then
    raise exception 'adjustment physical-slot recovery contract is incomplete';
  end if;

  if pg_catalog.has_function_privilege(
       'anon',
       'public.ingest_adjustment_sheet_inbound_without_category(jsonb)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.ingest_adjustment_sheet_inbound_without_category(jsonb)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.ingest_adjustment_sheet_inbound_without_category(jsonb)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut(jsonb)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut(jsonb)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut(jsonb)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.ingest_adjustment_sheet_inbound_without_slot_recovery(jsonb)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.ingest_adjustment_sheet_inbound_without_slot_recovery(jsonb)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.ingest_adjustment_sheet_inbound_without_slot_recovery(jsonb)',
       'execute'
     ) then
    raise exception 'an adjustment implementation helper is directly executable';
  end if;

  if pg_catalog.has_function_privilege(
       'anon', 'public.ingest_adjustment_sheet_inbound(jsonb)', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', 'public.ingest_adjustment_sheet_inbound(jsonb)', 'execute'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', 'public.ingest_adjustment_sheet_inbound(jsonb)', 'execute'
     ) then
    raise exception 'public adjustment ingest execution boundary changed';
  end if;

  select index_class.relkind = 'i' and index_details.indisunique
  into v_index_unique
  from pg_catalog.pg_class index_class
  join pg_catalog.pg_index index_details
    on index_details.indexrelid = index_class.oid
  where index_class.oid =
    'public.employee_attendance_adjustment_physical_slot_unique_idx'::regclass;
  if not coalesce(v_index_unique, false) then
    raise exception 'adjustment physical-slot unique index is missing';
  end if;

  select table_details.relrowsecurity
  into v_archive_rls
  from pg_catalog.pg_class table_details
  where table_details.oid =
    'attendance_private.adjustment_identity_duplicate_archive'::regclass;
  if not coalesce(v_archive_rls, false)
     or pg_catalog.has_table_privilege(
       'anon',
       'attendance_private.adjustment_identity_duplicate_archive',
       'select'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'attendance_private.adjustment_identity_duplicate_archive',
       'select'
     )
     or not pg_catalog.has_table_privilege(
       'service_role',
       'attendance_private.adjustment_identity_duplicate_archive',
       'select'
     ) then
    raise exception 'adjustment duplicate archive access boundary is incorrect';
  end if;

  select table_details.relrowsecurity
  into v_repair_archive_rls
  from pg_catalog.pg_class table_details
  where table_details.oid =
    'attendance_private.adjustment_identity_repair_archive'::regclass;
  select pg_catalog.pg_get_functiondef(
    'attendance_private.repair_adjustment_slot_from_verified_google(jsonb)'::regprocedure
  ) into v_repair_definition;
  if not coalesce(v_repair_archive_rls, false)
     or position('pg_advisory_xact_lock' in v_repair_definition) = 0
     or position('v_slot_count <> 1' in v_repair_definition) = 0
     or position('v_revision <= v_record.sync_revision' in v_repair_definition) = 0
     or position('adjustment_identity_repair_archive' in v_repair_definition) = 0
     or pg_catalog.has_function_privilege(
       'anon',
       'attendance_private.repair_adjustment_slot_from_verified_google(jsonb)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'attendance_private.repair_adjustment_slot_from_verified_google(jsonb)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'attendance_private.repair_adjustment_slot_from_verified_google(jsonb)',
       'execute'
     )
     or pg_catalog.has_table_privilege(
       'anon',
       'attendance_private.adjustment_identity_repair_archive',
       'select'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'attendance_private.adjustment_identity_repair_archive',
       'select'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'attendance_private.adjustment_identity_repair_archive',
       'select'
     ) then
    raise exception 'operator adjustment repair boundary is incomplete';
  end if;

  if exists (
    select 1
    from public.employee_attendance_records record
    where record.kind = 'adjustment'
      and record.raw_values->>'sync_protocol' = 'adjustment-v1'
      and nullif(btrim(record.raw_values->>'google_row'), '') is not null
      and nullif(lower(btrim(record.raw_values->>'source_slot')), '') is not null
    group by
      record.source_id,
      btrim(record.raw_values->>'google_row'),
      lower(btrim(record.raw_values->>'source_slot'))
    having count(*) > 1
  ) then
    raise exception 'duplicate adjustment physical slots remain after migration';
  end if;
end
$contract$;

do $operator_repair$
declare
  v_employee_id uuid := gen_random_uuid();
  v_source_id uuid := gen_random_uuid();
  v_record_id uuid := gen_random_uuid();
  v_request_id uuid := gen_random_uuid();
  v_old_external_id uuid := gen_random_uuid();
  v_new_external_id uuid := gen_random_uuid();
  v_employee_no text := 'TST-REPAIR-' ||
    substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  v_source_key text := 'test_adjustment_repair_' ||
    replace(gen_random_uuid()::text, '-', '');
  v_payload jsonb;
  v_result jsonb;
  v_saved public.employee_attendance_records%rowtype;
  v_archive attendance_private.adjustment_identity_repair_archive%rowtype;
  v_outbox_state text;
  v_immutable boolean := false;
begin
  insert into public.employees (id, employee_no, full_name, status)
  values (v_employee_id, v_employee_no, 'Verified Repair Person', 'active');

  insert into public.attendance_sheet_sources (
    id, source_key, source_name, scope, source_month, status, is_active, metadata
  ) values (
    v_source_id, v_source_key, 'SQL verified repair test', 'adjustment',
    '2026-09', 'partial', true,
    jsonb_build_object(
      'sync_protocol', 'adjustment-v1',
      'workbook_key', 'onsite',
      'layout', 'standard',
      'currency', 'USD'
    )
  );

  insert into public.employee_attendance_records (
    id, source_id, source_block, source_row, source_item_key, kind,
    event_date, event_kind, reason, note, amount, raw_amount, currency,
    employee_id, employee_no_raw, employee_name_raw, match_status,
    match_method, matched_at, raw_values, content_hash, is_mirror,
    external_id, sync_origin, sync_revision
  ) values (
    v_record_id, v_source_id, 'adjustment', 190000010,
    v_old_external_id::text, 'adjustment', '2026-09-04', 'bonus',
    '旧类型', 'old canonical value', 10.00, '10', 'USD',
    v_employee_id, v_employee_no, 'Verified Repair Person', 'matched',
    'employee_id_exact', clock_timestamp(),
    jsonb_build_object(
      'sync_protocol', 'adjustment-v1',
      'external_id', v_old_external_id,
      'origin', 'google',
      'revision', 20,
      'google_sync_state', 'pending',
      'workbook_key', 'onsite',
      'source_key', v_source_key,
      'source_month', '2026-09',
      'source_slot', 'primary',
      'currency', 'USD',
      'google_row', 88,
      'category', '旧类型',
      'raw_type', '旧类型'
    ),
    'sql-test-verified-repair-before', false, v_old_external_id, 'admin', 20
  );

  insert into attendance_private.adjustment_sheet_outbox (
    adjustment_record_id, external_id, revision, operation, source_key,
    source_month, source_slot, currency, payload, state, attempts
  ) values (
    v_record_id, v_old_external_id, 20, 'upsert', v_source_key,
    '2026-09', 'primary', 'USD',
    jsonb_build_object('external_id', v_old_external_id, 'revision', 20),
    'failed', 8
  );

  v_payload := jsonb_build_object(
    'request_id', v_request_id,
    'source_key', v_source_key,
    'external_id', v_new_external_id,
    'origin', 'google',
    'revision', 21,
    'source_slot', 'primary',
    'google_row', 88,
    'event_date', '2026-09-05',
    'signed_amount', -12.50,
    'currency', 'USD',
    'employee_no', v_employee_no,
    'employee_name', 'Verified Repair Person Updated',
    'category', '新类型',
    'note', 'verified current Google value'
  );
  v_result := attendance_private.repair_adjustment_slot_from_verified_google(
    v_payload
  );

  select * into strict v_saved
  from public.employee_attendance_records record
  where record.id = v_record_id;
  select * into strict v_archive
  from attendance_private.adjustment_identity_repair_archive archive
  where archive.repair_request_id = v_request_id;
  select outbox.state into strict v_outbox_state
  from attendance_private.adjustment_sheet_outbox outbox
  where outbox.adjustment_record_id = v_record_id
    and outbox.external_id = v_old_external_id;

  if v_result->>'status' <> 'repaired'
     or v_result->>'superseded_outbox' <> '1'
     or v_saved.external_id <> v_new_external_id
     or v_saved.source_item_key <> v_new_external_id::text
     or v_saved.raw_values->>'external_id' <> v_new_external_id::text
     or v_saved.sync_revision <> 21
     or v_saved.event_date <> '2026-09-05'::date
     or v_saved.amount <> -12.50
     or v_saved.event_kind <> 'deduction'
     or v_saved.reason <> '新类型'
     or v_saved.note <> 'verified current Google value'
     or v_saved.employee_id <> v_employee_id
     or v_archive.old_external_id <> v_old_external_id
     or v_archive.new_external_id <> v_new_external_id
     or v_archive.record_snapshot->>'external_id' <>
        v_old_external_id::text
     or v_archive.record_snapshot->>'note' <> 'old canonical value'
     or v_outbox_state <> 'superseded' then
    raise exception 'verified Google operator repair was not atomic and complete';
  end if;

  begin
    update attendance_private.adjustment_identity_repair_archive archive
    set repair_reason = 'must not change'
    where archive.repair_request_id = v_request_id;
  exception when sqlstate '55000' then
    v_immutable := true;
  end;
  if not v_immutable then
    raise exception 'operator repair archive allowed mutation';
  end if;
end
$operator_repair$;

do $behavior$
declare
  v_employee_id uuid := gen_random_uuid();
  v_source_id uuid := gen_random_uuid();
  v_record_id uuid := gen_random_uuid();
  v_old_external_id uuid := gen_random_uuid();
  v_new_external_id uuid := gen_random_uuid();
  v_stale_external_id uuid := gen_random_uuid();
  v_conflict_external_id uuid := gen_random_uuid();
  v_employee_no text := 'TST-SLOT-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  v_source_key text := 'test_adjustment_slot_' || replace(gen_random_uuid()::text, '-', '');
  v_payload jsonb;
  v_result jsonb;
  v_saved public.employee_attendance_records%rowtype;
  v_blocked boolean;
  v_error text;
begin
  insert into public.employees (id, employee_no, full_name, status)
  values (v_employee_id, v_employee_no, 'Adjustment Slot Person', 'active');

  insert into public.attendance_sheet_sources (
    id,
    source_key,
    source_name,
    scope,
    source_month,
    status,
    is_active,
    metadata
  ) values (
    v_source_id,
    v_source_key,
    'SQL adjustment slot test',
    'adjustment',
    '2026-09',
    'success',
    true,
    jsonb_build_object(
      'sync_protocol', 'adjustment-v1',
      'workbook_key', 'onsite',
      'layout', 'standard',
      'currency', 'USD'
    )
  );

  insert into public.employee_attendance_records (
    id,
    source_id,
    source_block,
    source_row,
    source_item_key,
    kind,
    event_date,
    event_kind,
    reason,
    note,
    amount,
    raw_amount,
    currency,
    employee_id,
    employee_no_raw,
    employee_name_raw,
    match_status,
    match_method,
    matched_at,
    raw_values,
    content_hash,
    is_mirror,
    external_id,
    sync_origin,
    sync_revision
  ) values (
    v_record_id,
    v_source_id,
    'adjustment',
    190000001,
    v_old_external_id::text,
    'adjustment',
    '2026-09-10',
    'bonus',
    '质量奖励',
    'same business content',
    25.00,
    '25',
    'USD',
    v_employee_id,
    v_employee_no,
    'Adjustment Slot Person',
    'matched',
    'employee_id_exact',
    clock_timestamp(),
    jsonb_build_object(
      'sync_protocol', 'adjustment-v1',
      'external_id', v_old_external_id,
      'origin', 'google',
      'revision', 10,
      'google_sync_state', 'synced',
      'workbook_key', 'onsite',
      'source_key', v_source_key,
      'source_month', '2026-09',
      'source_slot', 'primary',
      'currency', 'USD',
      'google_row', 77,
      'category', '质量奖励',
      'raw_type', '质量奖励'
    ),
    'sql-test-adjustment-slot-before',
    false,
    v_old_external_id,
    'google',
    10
  );

  -- A newer UUID for identical content adopts the existing row; it must not
  -- create a second canonical record.
  v_payload := jsonb_build_object(
    'request_id', gen_random_uuid(),
    'payload_hash', repeat('a', 64),
    'source_key', v_source_key,
    'rows', jsonb_build_array(jsonb_build_object(
      'external_id', v_new_external_id,
      'origin', 'google',
      'revision', 11,
      'source_slot', 'primary',
      'google_row', 77,
      'event_date', '2026-09-10',
      'signed_amount', 25.00,
      'currency', 'USD',
      'employee_no', v_employee_no,
      'employee_name', 'Adjustment Slot Person',
      'category', '质量奖励',
      'note', 'same business content'
    ))
  );
  v_result := public.ingest_adjustment_sheet_inbound(v_payload);

  select *
  into strict v_saved
  from public.employee_attendance_records record
  where record.id = v_record_id;

  if (v_result->>'identity_rekeyed')::integer <> 1
     or (v_result->>'inserted')::integer <> 0
     or (v_result->>'updated')::integer <> 1
     or v_saved.external_id <> v_new_external_id
     or v_saved.source_item_key <> v_new_external_id::text
     or v_saved.raw_values->>'external_id' <> v_new_external_id::text
     or v_saved.sync_revision <> 11
     or v_saved.reason <> '质量奖励'
     or v_saved.raw_values->>'category' <> '质量奖励'
     or (
       select count(*)
       from public.employee_attendance_records record
       where record.source_id = v_source_id
         and record.kind = 'adjustment'
         and record.raw_values->>'google_row' = '77'
         and record.raw_values->>'source_slot' = 'primary'
     ) <> 1 then
    raise exception 'newer identical UUID did not rekey exactly one canonical row';
  end if;

  -- An older/equal UUID is accepted before content comparison because it can
  -- never win the revision race or change canonical data.
  v_payload := jsonb_build_object(
    'request_id', gen_random_uuid(),
    'payload_hash', repeat('b', 64),
    'source_key', v_source_key,
    'rows', jsonb_build_array(jsonb_build_object(
      'external_id', v_stale_external_id,
      'origin', 'google',
      'revision', 10,
      'source_slot', 'primary',
      'google_row', 77,
      'event_date', '2026-09-09',
      'signed_amount', 999.00,
      'currency', 'USD',
      'employee_no', v_employee_no,
      'employee_name', 'Stale value must not overwrite',
      'category', '过期类型',
      'note', 'stale mismatched content must be ignored'
    ))
  );
  v_result := public.ingest_adjustment_sheet_inbound(v_payload);

  select *
  into strict v_saved
  from public.employee_attendance_records record
  where record.id = v_record_id;

  if (v_result->>'identity_stale_short_circuited')::integer <> 1
     or (v_result->>'stale_ignored')::integer <> 1
     or v_saved.external_id <> v_new_external_id
     or v_saved.sync_revision <> 11
     or v_saved.event_date <> '2026-09-10'::date
     or v_saved.amount <> 25.00
     or v_saved.reason <> '质量奖励'
     or v_saved.note <> 'same business content' then
    raise exception 'mismatched stale UUID was not accepted without mutation';
  end if;

  -- Changed business content is never treated as an identity-only race.
  v_blocked := false;
  v_error := null;
  begin
    v_payload := jsonb_build_object(
      'request_id', gen_random_uuid(),
      'payload_hash', repeat('c', 64),
      'source_key', v_source_key,
      'rows', jsonb_build_array(jsonb_build_object(
        'external_id', v_conflict_external_id,
        'origin', 'google',
        'revision', 12,
        'source_slot', 'primary',
        'google_row', 77,
        'event_date', '2026-09-10',
        'signed_amount', 25.00,
        'currency', 'USD',
        'employee_no', v_employee_no,
        'employee_name', 'Adjustment Slot Person',
        'category', '质量奖励',
        'note', 'different content must remain blocked'
      ))
    );
    perform public.ingest_adjustment_sheet_inbound(v_payload);
  exception when raise_exception then
    get stacked diagnostics v_error = message_text;
    v_blocked := v_error = 'google_source_slot_identity_conflict';
  end;
  if not v_blocked then
    raise exception 'business-content mismatch was not fail closed: %', v_error;
  end if;

  select *
  into strict v_saved
  from public.employee_attendance_records record
  where record.id = v_record_id;
  if v_saved.external_id <> v_new_external_id or v_saved.sync_revision <> 11 then
    raise exception 'failed conflict attempt changed the canonical row';
  end if;

  -- A stable UUID cannot be moved from its already-bound physical row.
  v_blocked := false;
  v_error := null;
  begin
    v_payload := jsonb_build_object(
      'request_id', gen_random_uuid(),
      'payload_hash', repeat('d', 64),
      'source_key', v_source_key,
      'rows', jsonb_build_array(jsonb_build_object(
        'external_id', v_new_external_id,
        'origin', 'google',
        'revision', 12,
        'source_slot', 'primary',
        'google_row', 78,
        'event_date', '2026-09-10',
        'signed_amount', 25.00,
        'currency', 'USD',
        'employee_no', v_employee_no,
        'employee_name', 'Adjustment Slot Person',
        'category', '质量奖励',
        'note', 'same business content'
      ))
    );
    perform public.ingest_adjustment_sheet_inbound(v_payload);
  exception when raise_exception then
    get stacked diagnostics v_error = message_text;
    v_blocked := v_error = 'external_id_google_row_mismatch';
  end;
  if not v_blocked then
    raise exception 'stable UUID was allowed to move to another Google row: %', v_error;
  end if;

  -- The unique partial index prevents a second UUID from being inserted at a
  -- coordinate even outside the ingest function.
  v_blocked := false;
  begin
    insert into public.employee_attendance_records (
      source_id, source_block, source_row, source_item_key, kind,
      event_date, event_kind, reason, note, amount, raw_amount, currency,
      employee_id, employee_no_raw, employee_name_raw, match_status,
      match_method, matched_at, raw_values, content_hash, is_mirror,
      external_id, sync_origin, sync_revision
    ) values (
      v_source_id, 'adjustment', 190000002,
      v_stale_external_id::text, 'adjustment', '2026-09-10', 'bonus',
      '质量奖励', 'same business content', 25.00, '25', 'USD',
      v_employee_id, v_employee_no, 'Adjustment Slot Person', 'matched',
      'employee_id_exact', clock_timestamp(),
      jsonb_build_object(
        'sync_protocol', 'adjustment-v1',
        'external_id', v_stale_external_id,
        'source_slot', 'primary',
        'google_row', 77,
        'category', '质量奖励'
      ),
      'sql-test-adjustment-slot-duplicate', false,
      v_stale_external_id, 'google', 10
    );
  exception when unique_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'physical-slot unique index allowed a duplicate UUID';
  end if;

  -- Defense in depth: even if the index is unavailable, multiple physical
  -- rows remain ambiguous and the recovery function must refuse to choose.
  execute 'drop index public.employee_attendance_adjustment_physical_slot_unique_idx';
  insert into public.employee_attendance_records (
    source_id, source_block, source_row, source_item_key, kind,
    event_date, event_kind, reason, note, amount, raw_amount, currency,
    employee_id, employee_no_raw, employee_name_raw, match_status,
    match_method, matched_at, raw_values, content_hash, is_mirror,
    external_id, sync_origin, sync_revision
  ) values (
    v_source_id, 'adjustment', 190000003,
    v_stale_external_id::text, 'adjustment', '2026-09-10', 'bonus',
    '质量奖励', 'same business content', 25.00, '25', 'USD',
    v_employee_id, v_employee_no, 'Adjustment Slot Person', 'matched',
    'employee_id_exact', clock_timestamp(),
    jsonb_build_object(
      'sync_protocol', 'adjustment-v1',
      'external_id', v_stale_external_id,
      'source_slot', 'primary',
      'google_row', 77,
      'category', '质量奖励',
      'raw_type', '质量奖励'
    ),
    'sql-test-adjustment-slot-ambiguous', false,
    v_stale_external_id, 'google', 11
  );

  v_blocked := false;
  v_error := null;
  begin
    v_payload := jsonb_build_object(
      'request_id', gen_random_uuid(),
      'payload_hash', repeat('e', 64),
      'source_key', v_source_key,
      'rows', jsonb_build_array(jsonb_build_object(
        'external_id', gen_random_uuid(),
        'origin', 'google',
        'revision', 12,
        'source_slot', 'primary',
        'google_row', 77,
        'event_date', '2026-09-10',
        'signed_amount', 25.00,
        'currency', 'USD',
        'employee_no', v_employee_no,
        'employee_name', 'Adjustment Slot Person',
        'category', '质量奖励',
        'note', 'same business content'
      ))
    );
    perform public.ingest_adjustment_sheet_inbound(v_payload);
  exception when raise_exception then
    get stacked diagnostics v_error = message_text;
    v_blocked := v_error = 'google_source_slot_identity_conflict';
  end;
  if not v_blocked then
    raise exception 'ambiguous physical slot was not fail closed: %', v_error;
  end if;
end
$behavior$;

rollback;
