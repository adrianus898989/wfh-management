begin;

-- Keep the already deployed v4 implementation as a private core and place a
-- row-level ownership filter in front of it.  The filter quarantines rows
-- owned by another source, completes identical effective values as no-ops,
-- and lets the remaining rows continue through the original transactional
-- identity checks and upserts.
do $$
begin
  if to_regprocedure(
    'attendance_private.ingest_staff_full_reconcile_v4_unguarded(text,text,jsonb)'
  ) is null then
    alter function attendance_private.ingest_staff_full_reconcile_v4(text, text, jsonb)
      rename to ingest_staff_full_reconcile_v4_unguarded;
  end if;
end;
$$;

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
  v_item jsonb;
  v_row jsonb;
  v_row_number integer;
  v_binding text;
  v_binding_key text;
  v_full_name text;
  v_name_key text;
  v_source_name_count integer;
  v_employee_id uuid;
  v_alias_employee_id uuid;
  v_match_count integer;
  v_matched_by text;
  v_employee public.employees%rowtype;
  v_payment public.employee_payment_profiles%rowtype;
  v_contact public.employee_contact_profiles%rowtype;
  v_payment_found boolean;
  v_contact_found boolean;
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
  v_payment_write_needed boolean;
  v_contact_write_needed boolean;
  v_conflict_reasons jsonb;
  v_safe_items jsonb := '[]'::jsonb;
  v_quarantined_results jsonb := '[]'::jsonb;
  v_noop_results jsonb := '[]'::jsonb;
  v_safe_count integer := 0;
  v_quarantined_count integer := 0;
  v_noop_count integer := 0;
  v_core_response jsonb;
  v_results jsonb;
  v_response jsonb;
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
  if coalesce(p_payload->>'protocol_version', '') <> 'staff-full-reconcile-v4' then
    return jsonb_build_object('ok', false, 'error', 'invalid_protocol_version');
  end if;
  if v_items is null or jsonb_typeof(v_items) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'invalid_items');
  end if;
  v_count := jsonb_array_length(v_items);
  if v_count < 1 or v_count > 8 then
    return jsonb_build_object('ok', false, 'error', 'invalid_batch_size');
  end if;

  -- Return the exact stored terminal result before re-evaluating ownership.
  -- This keeps retries deterministic even if an operator changes an owner
  -- after the first attempt.
  select request.* into v_request
  from attendance_private.staff_full_reconcile_requests request
  where request.request_id = v_request_id;
  if found then
    if v_request.payload_hash <> v_payload_hash then
      return jsonb_build_object(
        'ok', false, 'error', 'request_id_reuse_mismatch',
        'request_id', v_request_id, 'write_performed', false
      );
    end if;
    if v_request.state = 'succeeded' then
      return coalesce(v_request.response, '{}'::jsonb) || jsonb_build_object(
        'ok', true, 'idempotent_replay', true, 'request_id', v_request_id
      );
    end if;
  end if;

  for v_item in select item.value from jsonb_array_elements(v_items) item(value)
  loop
    -- Malformed and unresolved identity rows stay in the original core path,
    -- which preserves the existing all-or-nothing validation semantics.  This
    -- wrapper quarantines ownership conflicts only.
    if v_item->'row' is null or jsonb_typeof(v_item->'row') <> 'object' then
      v_safe_items := v_safe_items || jsonb_build_array(v_item);
      continue;
    end if;
    v_row_number := case when coalesce(v_item->>'row_number', '') ~ '^\d+$'
      then (v_item->>'row_number')::integer else 0 end;
    if v_row_number < 1 or v_row_number > 1000000 then
      v_safe_items := v_safe_items || jsonb_build_array(v_item);
      continue;
    end if;

    v_row := v_item->'row';
    v_binding := upper(btrim(coalesce(v_row->>'__WFH员工ID', '')));
    v_binding_key := attendance_private.staff_sync_employee_key(v_binding);
    v_full_name := regexp_replace(
      btrim(coalesce(v_row->>'FULL NAME / 姓名', '')),
      '[[:space:]]+', ' ', 'g'
    );
    v_name_key := attendance_private.staff_sync_name_key(v_full_name);
    v_source_name_count := case
      when coalesce(v_item->>'source_name_count', '') ~ '^\d+$'
        then (v_item->>'source_name_count')::integer
      else 0
    end;
    v_employee := null;
    v_employee_id := null;
    v_alias_employee_id := null;
    v_matched_by := '';

    if v_action = 'bank_binding_dry_run'
      and v_binding_key = ''
      and v_source_name_count = 1
      and v_name_key <> '' then
      select count(*)::integer, min(employee.id::text)::uuid
      into v_match_count, v_employee_id
      from public.employees employee
      where attendance_private.staff_sync_name_key(employee.full_name) = v_name_key;
      if v_match_count = 1 then
        select employee.* into v_employee
        from public.employees employee where employee.id = v_employee_id;
        v_matched_by := 'unique_name_plan';
      end if;
    elsif v_binding_key <> '' and v_binding not in ('SYSTEM', 'ADMIN') then
      select count(*)::integer, min(employee.id::text)::uuid
      into v_match_count, v_employee_id
      from public.employees employee
      where attendance_private.staff_sync_employee_key(employee.employee_no) = v_binding_key;
      if v_match_count = 1 then
        select employee.* into v_employee
        from public.employees employee where employee.id = v_employee_id;
        v_matched_by := 'employee_no';
      elsif v_match_count = 0 then
        select count(*)::integer, min(alias.employee_id::text)::uuid
        into v_match_count, v_alias_employee_id
        from (
          select distinct event.employee_id
          from public.employee_lifecycle_events event
          join public.employees employee on employee.id = event.employee_id
          where event.employee_id is not null
            and attendance_private.staff_sync_employee_key(event.employee_no) = v_binding_key
        ) alias;
        if v_match_count = 1 then
          v_employee_id := v_alias_employee_id;
          select employee.* into v_employee
          from public.employees employee where employee.id = v_employee_id;
          v_matched_by := 'lifecycle_alias';
        end if;
      end if;
    end if;

    if v_employee_id is null
      or v_name_key = ''
      or attendance_private.staff_sync_name_key(v_employee.full_name) <> v_name_key then
      v_safe_items := v_safe_items || jsonb_build_array(v_item);
      continue;
    end if;

    -- These NOWAIT locks keep the ownership decision and the core upsert in
    -- one short transaction without waiting behind an admin edit.
    -- FOR UPDATE also conflicts with the KEY SHARE lock taken by a concurrent
    -- child-profile insert.  That closes the otherwise-empty-child TOCTOU
    -- window between this ownership decision and the core upsert.
    select employee.* into v_employee
    from public.employees employee
    where employee.id = v_employee_id
    for update nowait;
    if not found
      or attendance_private.staff_sync_name_key(v_employee.full_name) <> v_name_key then
      v_safe_items := v_safe_items || jsonb_build_array(v_item);
      continue;
    end if;

    select payment.* into v_payment
    from public.employee_payment_profiles payment
    where payment.employee_id = v_employee_id
    for update nowait;
    v_payment_found := found;

    select contact.* into v_contact
    from public.employee_contact_profiles contact
    where contact.employee_id = v_employee_id
    for update nowait;
    v_contact_found := found;

    v_conflict_reasons := '[]'::jsonb;
    if coalesce(v_employee.employment_type, '') = '现场转居家' then
      v_conflict_reasons := v_conflict_reasons ||
        jsonb_build_array('employment_type_owned_by_onsite');
    end if;
    if v_payment_found
      and nullif(btrim(coalesce(v_payment.source_sheet, '')), '') is not null
      and v_payment.source_sheet <> '银行信息' then
      v_conflict_reasons := v_conflict_reasons ||
        jsonb_build_array('payment_profile_owned_by_other_source');
    end if;
    if v_payment_found
      and nullif(btrim(coalesce(v_payment.payment_mode_source, '')), '') is not null
      and v_payment.payment_mode_source not in ('银行信息', 'employment_type') then
      v_conflict_reasons := v_conflict_reasons ||
        jsonb_build_array('payment_mode_owned_by_other_source');
    end if;
    if v_contact_found
      and nullif(btrim(coalesce(v_contact.source_sheet, '')), '') is not null
      and v_contact.source_sheet <> '银行信息' then
      v_conflict_reasons := v_conflict_reasons ||
        jsonb_build_array('contact_profile_owned_by_other_source');
    end if;

    if jsonb_array_length(v_conflict_reasons) > 0 then
      v_quarantined_count := v_quarantined_count + 1;
      v_quarantined_results := v_quarantined_results || jsonb_build_array(
        jsonb_build_object(
          'ok', true,
          'row_number', v_row_number,
          'status', 'source_ownership_conflict',
          'resolved_employee_no', v_employee.employee_no,
          'matched_by', v_matched_by,
          'name_verified', true,
          'write_needed', false,
          'write_performed', false,
          'conflict_reasons', v_conflict_reasons,
          'profile_source_sheet', case when v_payment_found
            then v_payment.source_sheet else null end,
          'payment_mode_source', case when v_payment_found
            then v_payment.payment_mode_source else null end,
          'contact_source_sheet', case when v_contact_found
            then v_contact.source_sheet else null end
        )
      );
      continue;
    end if;

    -- Suppress identical bank events before they reach the core upserts.
    -- The request ledger is still completed for idempotency, but payment and
    -- contact updated_at values (and any downstream business audit) remain
    -- untouched when the effective values are already identical.
    -- Multi-item batches stay entirely on the original ordered core path.
    -- Two rows may resolve to the same person through a current ID and a
    -- lifecycle alias; filtering either against the pre-batch database state
    -- would change the core's last-row-wins sequence semantics.
    if v_action <> 'bank_binding_dry_run' and v_count = 1 then
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
            where coalesce(v_employee.country, v_employee.nationality, '')
              like '%' || country_name || '%'
          ) then 'usdt'
        else 'bank_wallet'
      end;

      if not v_has_owned_data then
        v_payment_write_needed := false;
        v_contact_write_needed := false;
      else
        v_payment_write_needed := not v_payment_found;
        if v_payment_found then
          v_payment_write_needed :=
            (v_has_payment_data and v_payment.payment_mode is distinct from v_mode)
            or (v_has_payment_data and v_payment.payment_mode_source is distinct from '银行信息')
            or (v_using <> '' and v_payment.transfer_using is distinct from v_using)
            or (v_mode = 'usdt' and v_account <> ''
                and v_payment.usdt_address is distinct from v_account)
            or (v_mode = 'bank_wallet' and v_account <> ''
                and v_payment.gcash_account is distinct from v_account)
            or (v_mode = 'bank_wallet' and v_account_name <> ''
                and v_payment.gcash_name is distinct from v_account_name)
            or (v_phone <> '' and v_payment.contact_phone is distinct from v_phone)
            or (v_whatsapp <> '' and v_payment.whatsapp_number is distinct from v_whatsapp)
            or (v_facebook <> '' and v_payment.facebook is distinct from v_facebook)
            or (v_address <> '' and v_payment.employee_address is distinct from v_address)
            or (v_has_payment_data and v_payment.source_sheet is distinct from '银行信息');
        end if;

        v_contact_write_needed := false;
        if v_facebook <> '' or v_whatsapp <> '' then
          v_contact_write_needed := not v_contact_found;
          if v_contact_found then
            v_contact_write_needed :=
              (v_facebook <> '' and v_contact.facebook is distinct from v_facebook)
              or (v_whatsapp <> '' and v_contact.whatsapp_phone is distinct from v_whatsapp)
              or v_contact.source_sheet is distinct from '银行信息';
          end if;
        end if;
      end if;

      if not v_payment_write_needed and not v_contact_write_needed then
        v_noop_count := v_noop_count + 1;
        v_noop_results := v_noop_results || jsonb_build_array(
          jsonb_build_object(
            'ok', true,
            'row_number', v_row_number,
            'status', 'no_changes',
            'resolved_employee_no', v_employee.employee_no,
            'matched_by', v_matched_by,
            'name_verified', true,
            'write_needed', false,
            'write_performed', false
          )
        );
        continue;
      end if;
    end if;

    v_safe_items := v_safe_items || jsonb_build_array(v_item);
  end loop;

  v_safe_count := jsonb_array_length(v_safe_items);
  if v_quarantined_count = 0 and v_noop_count = 0 then
    return attendance_private.ingest_staff_full_reconcile_v4_unguarded(
      v_request_id, v_payload_hash, p_payload
    );
  end if;

  if v_safe_count > 0 then
    v_core_response := attendance_private.ingest_staff_full_reconcile_v4_unguarded(
      v_request_id,
      v_payload_hash,
      jsonb_set(p_payload, '{items}', v_safe_items, false)
    );
    if not coalesce((v_core_response->>'ok')::boolean, false) then
      return v_core_response;
    end if;
  else
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
    v_core_response := jsonb_build_object(
      'ok', true,
      'write_performed', false,
      'request_id', v_request_id,
      'count', 0,
      'processed', 0,
      'results', '[]'::jsonb
    );
  end if;

  select coalesce(jsonb_agg(result.value order by (result.value->>'row_number')::integer), '[]'::jsonb)
  into v_results
  from jsonb_array_elements(
    coalesce(v_core_response->'results', '[]'::jsonb)
      || v_quarantined_results || v_noop_results
  ) result(value);

  v_response := v_core_response || jsonb_build_object(
    'ok', true,
    'completed', true,
    'write_performed', case when v_safe_count > 0
      then coalesce((v_core_response->>'write_performed')::boolean, false)
      else false end,
    'request_id', v_request_id,
    'count', v_count,
    'processed', jsonb_array_length(v_results),
    'quarantined', v_quarantined_count,
    'no_changes', v_noop_count,
    'results', v_results
  );
  if v_action = 'bank_binding_dry_run' then
    v_response := v_response || jsonb_build_object('dry_run', true);
  end if;

  update attendance_private.staff_full_reconcile_requests request
  set state = 'succeeded', response = v_response, error_code = null,
      updated_at = clock_timestamp(), completed_at = clock_timestamp()
  where request.request_id = v_request_id;
  return v_response;
end;
$$;

-- Recreate the public shim after renaming the old private function so any
-- cached SQL-function plan cannot continue calling the renamed core by OID.
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

revoke all on function attendance_private.ingest_staff_full_reconcile_v4_unguarded(
  text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function attendance_private.ingest_staff_full_reconcile_v4(
  text, text, jsonb
) from public, anon, authenticated;
grant execute on function attendance_private.ingest_staff_full_reconcile_v4(
  text, text, jsonb
) to service_role;
revoke all on function public.ingest_staff_full_reconcile_v4(
  text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_staff_full_reconcile_v4(
  text, text, jsonb
) to service_role;

alter function attendance_private.ingest_staff_full_reconcile_v4(text, text, jsonb)
  set statement_timeout = '8s';
alter function attendance_private.ingest_staff_full_reconcile_v4(text, text, jsonb)
  set lock_timeout = '2s';
alter function public.ingest_staff_full_reconcile_v4(text, text, jsonb)
  set statement_timeout = '8s';
alter function public.ingest_staff_full_reconcile_v4(text, text, jsonb)
  set lock_timeout = '2s';

comment on function attendance_private.ingest_staff_full_reconcile_v4(
  text, text, jsonb
) is
  'Bank v4 ownership guard: quarantines cross-source payment/contact rows and continues safe rows through the original bounded core.';
comment on function attendance_private.ingest_staff_full_reconcile_v4_unguarded(
  text, text, jsonb
) is
  'Private bank v4 core. Call only through attendance_private.ingest_staff_full_reconcile_v4 ownership guard.';

commit;
