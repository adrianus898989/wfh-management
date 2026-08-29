begin;

-- Bank-only recovery for the legacy staff workbook. The prior v2 Edge
-- function performed multiple direct REST upserts, matched primarily by name,
-- and had no durable request ledger. This RPC deliberately owns only payment
-- fields from 银行信息 plus its two contact mirrors.
create table if not exists attendance_private.staff_full_reconcile_requests (
  request_id text primary key,
  payload_hash text not null,
  action text not null,
  state text not null,
  response jsonb,
  error_code text,
  attempt_count integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint staff_full_reconcile_requests_request_id_check check (
    char_length(request_id) between 8 and 128
    and request_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint staff_full_reconcile_requests_payload_hash_check check (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint staff_full_reconcile_requests_action_check check (
    action in ('bank_row_changed', 'bank_batch_changed', 'bank_binding_dry_run')
  ),
  constraint staff_full_reconcile_requests_state_check check (
    state in ('processing', 'succeeded', 'failed')
  ),
  constraint staff_full_reconcile_requests_attempt_count_check check (
    attempt_count between 1 and 1000
  )
);

create index if not exists staff_full_reconcile_requests_updated_idx
  on attendance_private.staff_full_reconcile_requests (updated_at desc);

-- Current IDs normally hit employees_employee_no_key. These small expression
-- indexes bound the exceptional old-ID lookup used after an employee rekey.
create index if not exists employees_employee_no_normalized_v4_idx
  on public.employees (
    attendance_private.staff_sync_employee_key(employee_no)
  );

create index if not exists lifecycle_employee_no_normalized_v4_idx
  on public.employee_lifecycle_events (
    attendance_private.staff_sync_employee_key(employee_no)
  )
  where employee_id is not null;

alter table attendance_private.staff_full_reconcile_requests enable row level security;
revoke all on table attendance_private.staff_full_reconcile_requests
  from public, anon, authenticated, service_role;

create or replace function attendance_private.ingest_staff_full_reconcile_v4(
  p_request_id text,
  p_payload_hash text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id text := btrim(coalesce(p_request_id, ''));
  v_payload_hash text := lower(btrim(coalesce(p_payload_hash, '')));
  v_action text := lower(btrim(coalesce(p_payload->>'action', '')));
  v_items jsonb := p_payload->'items';
  v_count integer;
  v_request attendance_private.staff_full_reconcile_requests%rowtype;
  v_response jsonb;
  v_results jsonb := '[]'::jsonb;
  v_item jsonb;
  v_row jsonb;
  v_row_number integer;
  v_source_name_count integer;
  v_binding text;
  v_binding_key text;
  v_full_name text;
  v_name_key text;
  v_employee public.employees%rowtype;
  v_payment public.employee_payment_profiles%rowtype;
  v_payment_found boolean;
  v_match_count integer;
  v_alias_employee_id uuid;
  v_matched_by text;
  v_mode text;
  v_account text;
  v_account_name text;
  v_using text;
  v_phone text;
  v_whatsapp text;
  v_facebook text;
  v_address text;
  v_has_payment_data boolean;
  v_has_owned_data boolean;
  v_diff_fields jsonb;
  v_error_state text;
  v_error_message text;
  v_safe_error text;
begin
  if char_length(v_request_id) not between 8 and 128
    or v_request_id !~ '^[A-Za-z0-9._:-]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_request_id');
  end if;
  if v_payload_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload_hash');
  end if;
  if v_action not in ('bank_row_changed', 'bank_batch_changed', 'bank_binding_dry_run') then
    return jsonb_build_object('ok', false, 'error', 'invalid_action');
  end if;

  insert into attendance_private.staff_full_reconcile_requests (
    request_id, payload_hash, action, state
  ) values (
    v_request_id, v_payload_hash, v_action, 'processing'
  ) on conflict (request_id) do nothing;

  select request.* into v_request
  from attendance_private.staff_full_reconcile_requests request
  where request.request_id = v_request_id
  for update;

  if v_request.payload_hash <> v_payload_hash then
    return jsonb_build_object(
      'ok', false, 'error', 'request_id_reuse_mismatch',
      'request_id', v_request_id, 'write_performed', false
    );
  end if;
  if v_request.state = 'succeeded' then
    return coalesce(v_request.response, '{}'::jsonb) || jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'request_id', v_request_id
    );
  end if;

  update attendance_private.staff_full_reconcile_requests request
  set state = 'processing', response = null, error_code = null,
      attempt_count = case when request.state = 'processing'
        then request.attempt_count else least(request.attempt_count + 1, 1000) end,
      updated_at = clock_timestamp(), completed_at = null
  where request.request_id = v_request_id;

  begin
    if coalesce(p_payload->>'protocol_version', '') <> 'staff-full-reconcile-v4' then
      raise exception using errcode = '22023', message = 'invalid_protocol_version';
    end if;
    if v_items is null or jsonb_typeof(v_items) <> 'array' then
      raise exception using errcode = '22023', message = 'invalid_items';
    end if;
    v_count := jsonb_array_length(v_items);
    if v_count < 1 or v_count > 8 then
      raise exception using errcode = '22023', message = 'invalid_batch_size';
    end if;

    for v_item in select item.value from jsonb_array_elements(v_items) item(value)
    loop
      if v_item->'row' is null or jsonb_typeof(v_item->'row') <> 'object' then
        raise exception using errcode = '22023', message = 'invalid_row';
      end if;
      v_row_number := case when coalesce(v_item->>'row_number', '') ~ '^\d+$'
        then (v_item->>'row_number')::integer else 0 end;
      if v_row_number < 1 or v_row_number > 1000000 then
        raise exception using errcode = '22023', message = 'invalid_row_number';
      end if;

      v_row := v_item->'row';
      v_binding := upper(btrim(coalesce(v_row->>'__WFH员工ID', '')));
      v_binding_key := attendance_private.staff_sync_employee_key(v_binding);
      v_full_name := regexp_replace(
        btrim(coalesce(v_row->>'FULL NAME / 姓名', '')),
        '[[:space:]]+', ' ', 'g'
      );
      v_name_key := attendance_private.staff_sync_name_key(v_full_name);
      v_employee := null;
      v_alias_employee_id := null;
      v_matched_by := '';
      v_source_name_count := case
        when coalesce(v_item->>'source_name_count', '') ~ '^\d+$'
          then (v_item->>'source_name_count')::integer
        else 0
      end;

      -- A planning run must account for the whole source sheet before it can
      -- resolve either a missing or an existing hidden binding. Duplicate
      -- source names are quarantined as row results instead of aborting the
      -- remaining rows in this read-only batch.
      if v_action = 'bank_binding_dry_run' then
        if v_source_name_count < 1 then
          raise exception using errcode = '22023', message = 'invalid_source_name_count';
        elsif v_source_name_count > 1 then
          v_results := v_results || jsonb_build_array(jsonb_build_object(
            'ok', true, 'row_number', v_row_number,
            'status', 'source_name_duplicate', 'write_needed', false
          ));
          continue;
        end if;
        if v_name_key = '' then
          raise exception using errcode = '22023', message = 'missing_employee_name';
        end if;
      end if;

      -- Dry-run may plan a missing hidden binding from a name only when the
      -- caller proves the name occurs once in the entire source sheet and the
      -- database independently finds exactly one employee. It never writes.
      if v_action = 'bank_binding_dry_run' and v_binding_key = '' then
        select count(*)::integer, min(employee.id::text)::uuid
        into v_match_count, v_alias_employee_id
        from public.employees employee
        where attendance_private.staff_sync_name_key(employee.full_name) = v_name_key;
        if v_match_count = 0 then
          v_results := v_results || jsonb_build_array(jsonb_build_object(
            'ok', true, 'row_number', v_row_number,
            'status', 'employee_not_found', 'write_needed', false
          ));
          continue;
        elsif v_match_count > 1 then
          v_results := v_results || jsonb_build_array(jsonb_build_object(
            'ok', true, 'row_number', v_row_number,
            'status', 'employee_name_ambiguous', 'write_needed', false
          ));
          continue;
        end if;
        select employee.* into v_employee
        from public.employees employee
        where employee.id = v_alias_employee_id;
        v_matched_by := 'unique_name_plan';
      else
        if v_binding_key = '' or v_binding in ('SYSTEM', 'ADMIN') then
          if v_action = 'bank_binding_dry_run' then
            v_results := v_results || jsonb_build_array(jsonb_build_object(
              'ok', true, 'row_number', v_row_number,
              'status', 'employee_binding_not_found', 'write_needed', false
            ));
            continue;
          end if;
          raise exception using errcode = '22023', message = 'missing_employee_binding';
        end if;
        v_matched_by := 'employee_no';
        select count(*)::integer into v_match_count
        from public.employees employee
        where attendance_private.staff_sync_employee_key(employee.employee_no) = v_binding_key;
        if v_match_count > 1 then
          if v_action = 'bank_binding_dry_run' then
            v_results := v_results || jsonb_build_array(jsonb_build_object(
              'ok', true, 'row_number', v_row_number,
              'status', 'employee_binding_ambiguous', 'write_needed', false
            ));
            continue;
          end if;
          raise exception using errcode = 'P0001', message = 'employee_binding_ambiguous';
        elsif v_match_count = 1 then
          select employee.* into v_employee
          from public.employees employee
          where attendance_private.staff_sync_employee_key(employee.employee_no) = v_binding_key;
        else
          select count(*)::integer,
                 min(alias.employee_id::text)::uuid
          into v_match_count, v_alias_employee_id
          from (
            select distinct event.employee_id
            from public.employee_lifecycle_events event
            join public.employees employee on employee.id = event.employee_id
            where event.employee_id is not null
              and attendance_private.staff_sync_employee_key(event.employee_no) = v_binding_key
          ) alias;
          if v_match_count = 0 then
            if v_action = 'bank_binding_dry_run' then
              v_results := v_results || jsonb_build_array(jsonb_build_object(
                'ok', true, 'row_number', v_row_number,
                'status', 'employee_binding_not_found', 'write_needed', false
              ));
              continue;
            end if;
            raise exception using errcode = 'P0001', message = 'employee_binding_not_found';
          elsif v_match_count > 1 then
            if v_action = 'bank_binding_dry_run' then
              v_results := v_results || jsonb_build_array(jsonb_build_object(
                'ok', true, 'row_number', v_row_number,
                'status', 'employee_binding_ambiguous', 'write_needed', false
              ));
              continue;
            end if;
            raise exception using errcode = 'P0001', message = 'employee_binding_ambiguous';
          end if;
          select employee.* into v_employee
          from public.employees employee
          where employee.id = v_alias_employee_id;
          v_matched_by := 'lifecycle_alias';
        end if;
      end if;

      -- A binding is never sufficient on its own: current IDs and lifecycle
      -- aliases must both agree with the normalized visible name. This blocks
      -- a stale or accidentally copied hidden ID from updating another person.
      if v_name_key = ''
        or attendance_private.staff_sync_name_key(v_employee.full_name) <> v_name_key then
        if v_action = 'bank_binding_dry_run' then
          v_results := v_results || jsonb_build_array(jsonb_build_object(
            'ok', true, 'row_number', v_row_number,
            'status', 'employee_name_mismatch', 'write_needed', false
          ));
          continue;
        end if;
        raise exception using errcode = 'P0001', message = 'employee_name_mismatch';
      end if;

      v_using := btrim(coalesce(v_row->>'TRANSFER USING', ''));
      v_account := btrim(coalesce(v_row->>'GCASH ACCOUNT / GCASH 账号', ''));
      v_account_name := btrim(coalesce(v_row->>'GCASH NAME / GCASH 姓名', ''));
      v_phone := btrim(coalesce(v_row->>'联系电话 / CONTACT PHONE NUMBER', ''));
      v_whatsapp := btrim(coalesce(v_row->>'WhatsApp Number', ''));
      v_facebook := btrim(coalesce(v_row->>'脸书   /   FACEBOOK', ''));
      v_address := btrim(coalesce(v_row->>'员工地址/Employee address', ''));
      v_has_payment_data := v_using <> '' or v_account <> '' or v_account_name <> '';
      v_has_owned_data := v_has_payment_data or v_phone <> '' or v_whatsapp <> ''
        or v_facebook <> '' or v_address <> '';

      v_mode := case
        when lower(v_using) like '%usdt%'
          or v_account ~ '^T[1-9A-HJ-NP-Za-km-z]{25,40}$' then 'usdt'
        when coalesce(v_employee.employment_type, '') = '现场转居家' then 'usdt'
        when coalesce(v_employee.employment_type, '') like '%纯居家%'
          and exists (
            select 1 from unnest(array[
              '印尼', '印度尼西亚', '越南', '缅甸', '马来', '马来西亚'
            ]) as country_list(country_name)
            where coalesce(v_employee.country, v_employee.nationality, '') like '%' || country_name || '%'
          ) then 'usdt'
        else 'bank_wallet'
      end;

      if v_action = 'bank_binding_dry_run' then
        v_diff_fields := '[]'::jsonb;
        select payment.* into v_payment
        from public.employee_payment_profiles payment
        where payment.employee_id = v_employee.id;
        v_payment_found := found;
        if not v_payment_found then
          v_diff_fields := jsonb_build_array('profile_missing');
        else
          if v_has_payment_data
            and btrim(coalesce(v_payment.payment_mode, '')) <> v_mode then
            v_diff_fields := v_diff_fields || jsonb_build_array('payment_mode');
          end if;
          if v_using <> '' and btrim(coalesce(v_payment.transfer_using, '')) <> v_using then
            v_diff_fields := v_diff_fields || jsonb_build_array('transfer_using');
          end if;
          if v_account <> '' and (
            (v_mode = 'usdt' and btrim(coalesce(v_payment.usdt_address, '')) <> v_account)
            or (v_mode = 'bank_wallet' and btrim(coalesce(v_payment.gcash_account, '')) <> v_account)
          ) then
            v_diff_fields := v_diff_fields || jsonb_build_array('account');
          end if;
          if v_mode = 'bank_wallet' and v_account_name <> ''
            and btrim(coalesce(v_payment.gcash_name, '')) <> v_account_name then
            v_diff_fields := v_diff_fields || jsonb_build_array('account_name');
          end if;
          if v_phone <> '' and btrim(coalesce(v_payment.contact_phone, '')) <> v_phone then
            v_diff_fields := v_diff_fields || jsonb_build_array('contact_phone');
          end if;
          if v_whatsapp <> '' and btrim(coalesce(v_payment.whatsapp_number, '')) <> v_whatsapp then
            v_diff_fields := v_diff_fields || jsonb_build_array('whatsapp_number');
          end if;
          if v_facebook <> '' and btrim(coalesce(v_payment.facebook, '')) <> v_facebook then
            v_diff_fields := v_diff_fields || jsonb_build_array('facebook');
          end if;
          if v_address <> '' and btrim(coalesce(v_payment.employee_address, '')) <> v_address then
            v_diff_fields := v_diff_fields || jsonb_build_array('employee_address');
          end if;
        end if;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'ok', true, 'row_number', v_row_number, 'status', 'ready',
          'resolved_employee_no', v_employee.employee_no,
          'matched_by', v_matched_by, 'name_verified', true,
          'profile_exists', v_payment_found,
          'write_needed', jsonb_array_length(v_diff_fields) > 0,
          'diff_fields', v_diff_fields
        ));
        continue;
      end if;

      -- An entirely empty source row is not a delete and must not claim or
      -- touch an existing payment profile merely because its hidden binding
      -- was populated.
      if not v_has_owned_data then
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'ok', true, 'row_number', v_row_number, 'status', 'no_changes',
          'matched_by', v_matched_by, 'name_verified', true,
          'write_performed', false
        ));
        continue;
      end if;

      insert into public.employee_payment_profiles as payment (
        employee_id, payment_mode, payment_mode_source, transfer_using,
        usdt_address, gcash_account, gcash_name, contact_phone,
        whatsapp_number, facebook, employee_address, source_sheet, updated_at
      ) values (
        v_employee.id, v_mode, '银行信息',
        nullif(v_using, ''),
        case when v_mode = 'usdt' then nullif(v_account, '') else null end,
        case when v_mode = 'bank_wallet' then nullif(v_account, '') else null end,
        case when v_mode = 'bank_wallet' then nullif(v_account_name, '') else null end,
        nullif(v_phone, ''), nullif(v_whatsapp, ''), nullif(v_facebook, ''),
        nullif(v_address, ''), '银行信息', clock_timestamp()
      ) on conflict (employee_id) do update
      set payment_mode = case
            when v_has_payment_data then excluded.payment_mode
            else payment.payment_mode
          end,
          payment_mode_source = case when v_has_payment_data
            then excluded.payment_mode_source else payment.payment_mode_source end,
          transfer_using = coalesce(excluded.transfer_using, payment.transfer_using),
          usdt_address = case when excluded.payment_mode = 'usdt'
            then coalesce(excluded.usdt_address, payment.usdt_address)
            else payment.usdt_address end,
          gcash_account = case when excluded.payment_mode = 'bank_wallet'
            then coalesce(excluded.gcash_account, payment.gcash_account)
            else payment.gcash_account end,
          gcash_name = case when excluded.payment_mode = 'bank_wallet'
            then coalesce(excluded.gcash_name, payment.gcash_name)
            else payment.gcash_name end,
          contact_phone = coalesce(excluded.contact_phone, payment.contact_phone),
          whatsapp_number = coalesce(excluded.whatsapp_number, payment.whatsapp_number),
          facebook = coalesce(excluded.facebook, payment.facebook),
          employee_address = coalesce(excluded.employee_address, payment.employee_address),
          source_sheet = case when v_has_payment_data
            then excluded.source_sheet else payment.source_sheet end,
          updated_at = excluded.updated_at;

      if v_facebook <> '' or v_whatsapp <> '' then
        insert into public.employee_contact_profiles as contact (
          employee_id, facebook, whatsapp_phone, source_sheet, updated_at
        ) values (
          v_employee.id, nullif(v_facebook, ''), nullif(v_whatsapp, ''),
          '银行信息', clock_timestamp()
        ) on conflict (employee_id) do update
        set facebook = coalesce(excluded.facebook, contact.facebook),
            whatsapp_phone = coalesce(excluded.whatsapp_phone, contact.whatsapp_phone),
            source_sheet = excluded.source_sheet,
            updated_at = excluded.updated_at;
      end if;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'ok', true, 'row_number', v_row_number, 'matched_by', v_matched_by,
        'name_verified', true
      ));
    end loop;

    if v_action = 'bank_binding_dry_run' then
      v_response := jsonb_build_object(
        'ok', true, 'dry_run', true, 'write_performed', false,
        'request_id', v_request_id, 'count', v_count,
        'processed', jsonb_array_length(v_results), 'results', v_results
      );
    else
      v_response := jsonb_build_object(
        'ok', true, 'write_performed', true, 'request_id', v_request_id,
        'count', v_count, 'processed', jsonb_array_length(v_results),
        'results', v_results
      );
    end if;
  exception when others then
    get stacked diagnostics v_error_state = returned_sqlstate,
      v_error_message = message_text;
    if v_error_state in ('57014', '55P03', '40P01', '40001', '53300', '53400') then
      raise;
    end if;
    v_safe_error := case
      when v_error_message ~ '^(invalid_|missing_employee_binding$|employee_)'
        then v_error_message
      when v_error_state = '23505' then 'identity_conflict'
      else 'database_ingest_failed'
    end;
    v_response := jsonb_build_object(
      'ok', false, 'write_performed', false, 'error', v_safe_error,
      'request_id', v_request_id,
      'retryable', v_safe_error = 'database_ingest_failed'
    );
    update attendance_private.staff_full_reconcile_requests request
    set state = 'failed', response = v_response, error_code = v_safe_error,
        updated_at = clock_timestamp(), completed_at = clock_timestamp()
    where request.request_id = v_request_id;
    return v_response;
  end;

  update attendance_private.staff_full_reconcile_requests request
  set state = 'succeeded', response = v_response, error_code = null,
      updated_at = clock_timestamp(), completed_at = clock_timestamp()
  where request.request_id = v_request_id;
  return v_response;
end;
$$;

create or replace function public.ingest_staff_full_reconcile_v4(
  p_request_id text,
  p_payload_hash text,
  p_payload jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select attendance_private.ingest_staff_full_reconcile_v4(
    p_request_id, p_payload_hash, p_payload
  );
$$;

revoke all on function attendance_private.ingest_staff_full_reconcile_v4(text, text, jsonb)
  from public, anon, authenticated;
grant usage on schema attendance_private to service_role;
grant execute on function attendance_private.ingest_staff_full_reconcile_v4(text, text, jsonb)
  to service_role;

revoke all on function public.ingest_staff_full_reconcile_v4(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_staff_full_reconcile_v4(text, text, jsonb)
  to service_role;

alter function attendance_private.ingest_staff_full_reconcile_v4(text, text, jsonb)
  set statement_timeout = '8s';
alter function attendance_private.ingest_staff_full_reconcile_v4(text, text, jsonb)
  set lock_timeout = '2s';
alter function public.ingest_staff_full_reconcile_v4(text, text, jsonb)
  set statement_timeout = '8s';
alter function public.ingest_staff_full_reconcile_v4(text, text, jsonb)
  set lock_timeout = '2s';

comment on table attendance_private.staff_full_reconcile_requests is
  'Private idempotency ledger for bounded bank-only dry-run plans and writes; stores no payload or secret.';
comment on function public.ingest_staff_full_reconcile_v4(text, text, jsonb) is
  'Service-role-only bounded 银行信息 dry-run planner and transactional writer; never updates employee master or lifecycle ownership.';

commit;
