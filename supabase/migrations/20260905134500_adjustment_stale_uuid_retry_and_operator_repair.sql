begin;

set local lock_timeout = '15s';
set local statement_timeout = '90s';

-- The physical-slot recovery installed immediately before this migration is
-- intentionally strict for newer Google edits.  A delayed retry with an old
-- UUID is different: once its revision is no newer than the canonical slot,
-- none of its business fields can be applied, so it is safe to translate only
-- the UUID and let the proven writer record a normal stale success.
alter function public.ingest_adjustment_sheet_inbound_without_category(jsonb)
  rename to ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut;

create function public.ingest_adjustment_sheet_inbound_without_category(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_payload_hash text := lower(btrim(coalesce(p_payload->>'payload_hash', '')));
  v_source_key text := btrim(coalesce(p_payload->>'source_key', ''));
  v_source public.attendance_sheet_sources%rowtype;
  v_existing_hash text;
  v_existing_result jsonb;
  v_row jsonb;
  v_delegate_row jsonb;
  v_delegate_rows jsonb := '[]'::jsonb;
  v_external_id uuid;
  v_revision bigint;
  v_google_row integer;
  v_source_slot text;
  v_origin text;
  v_slot_record public.employee_attendance_records%rowtype;
  v_candidate public.employee_attendance_records%rowtype;
  v_slot_count integer;
  v_stale_shortcut integer := 0;
  v_result jsonb;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_payload';
  end if;
  begin
    v_request_id := (p_payload->>'request_id')::uuid;
  exception when others then
    raise exception 'invalid_request_id';
  end;
  if v_request_id is null then
    raise exception 'invalid_request_id';
  end if;
  if v_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_payload_hash';
  end if;
  if jsonb_typeof(coalesce(p_payload->'rows', 'null'::jsonb)) is distinct from 'array'
     or jsonb_array_length(p_payload->'rows') = 0
     or jsonb_array_length(p_payload->'rows') > 200 then
    raise exception 'invalid_rows';
  end if;

  -- Preserve request-id idempotency byte-for-byte.  This check must happen
  -- before a later canonical revision could change the shortcut decision.
  select inbound.payload_hash, inbound.result
  into v_existing_hash, v_existing_result
  from attendance_private.adjustment_sheet_inbound_requests inbound
  where inbound.request_id = v_request_id;
  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception 'request_id_payload_mismatch';
    end if;
    return coalesce(
      v_existing_result,
      jsonb_build_object('ok', true, 'status', 'already_processing')
    );
  end if;

  select *
  into v_source
  from public.attendance_sheet_sources source
  where source.source_key = v_source_key
    and source.scope = 'adjustment'
    and source.is_active
    and source.metadata->>'sync_protocol' = 'adjustment-v1';
  if not found then
    raise exception 'source_not_allowlisted';
  end if;

  -- Lock every physical coordinate in deterministic order before looking at
  -- its revision.  The wrapped recovery takes the same transaction locks, so
  -- no writer can change the canonical row between translation and ingest.
  for v_row in
    select item.value
    from jsonb_array_elements(p_payload->'rows') item(value)
    order by
      btrim(coalesce(item.value->>'google_row', '')),
      lower(btrim(coalesce(item.value->>'source_slot', '')))
  loop
    begin
      v_google_row := (v_row->>'google_row')::integer;
    exception when others then
      raise exception 'invalid_inbound_row';
    end;
    v_source_slot := lower(btrim(coalesce(v_row->>'source_slot', '')));
    if v_google_row < 3 then
      raise exception 'invalid_inbound_row';
    end if;
    if (v_source.metadata->>'layout' = 'standard' and v_source_slot <> 'primary')
       or (v_source.metadata->>'layout' = 'philippines'
           and v_source_slot not in ('first_half', 'second_half')) then
      raise exception 'invalid_source_slot';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        concat_ws('|', 'adjustment-slot-v1', v_source.id::text,
          v_google_row::text, v_source_slot),
        0
      )
    );
  end loop;

  for v_row in
    select item.value
    from jsonb_array_elements(p_payload->'rows') with ordinality item(value, ordinal)
    order by item.ordinal
  loop
    v_delegate_row := v_row;
    v_slot_record := null;
    v_slot_count := 0;
    begin
      v_external_id := (v_row->>'external_id')::uuid;
      v_revision := (v_row->>'revision')::bigint;
      v_google_row := (v_row->>'google_row')::integer;
    exception when others then
      raise exception 'invalid_inbound_row';
    end;
    if v_external_id is null or v_revision < 1 or v_google_row < 3 then
      raise exception 'invalid_inbound_row';
    end if;
    v_source_slot := lower(btrim(coalesce(v_row->>'source_slot', '')));
    v_origin := lower(btrim(coalesce(v_row->>'origin', '')));

    -- Existing UUIDs retain all normal route/slot validation in the wrapped
    -- writer.  Only an otherwise unknown Google UUID can be a duplicate-
    -- trigger identity for this physical slot.
    if v_origin <> 'google' or exists (
      select 1
      from public.employee_attendance_records record
      where record.external_id = v_external_id
    ) then
      v_delegate_rows := v_delegate_rows || jsonb_build_array(v_delegate_row);
      continue;
    end if;

    for v_candidate in
      select record.*
      from public.employee_attendance_records record
      where record.source_id = v_source.id
        and record.kind = 'adjustment'
        and btrim(coalesce(record.raw_values->>'google_row', '')) =
            v_google_row::text
        and lower(btrim(coalesce(record.raw_values->>'source_slot', ''))) =
            v_source_slot
      order by record.id
      for update
    loop
      v_slot_count := v_slot_count + 1;
      v_slot_record := v_candidate;
    end loop;

    if v_slot_count > 1 then
      raise exception 'google_source_slot_identity_conflict';
    end if;

    -- Deliberately precede every business-content comparison in the wrapped
    -- recovery.  Because the revision cannot win, translating to the canonical
    -- UUID can only produce its stale-success path and cannot mutate the row.
    if v_slot_count = 1
       and v_revision <= v_slot_record.sync_revision
       and v_slot_record.external_id is not null
       and v_slot_record.source_item_key = v_slot_record.external_id::text
       and v_slot_record.raw_values->>'external_id' =
           v_slot_record.external_id::text then
      v_delegate_row := jsonb_set(
        v_delegate_row,
        '{external_id}',
        to_jsonb(v_slot_record.external_id::text),
        false
      );
      v_stale_shortcut := v_stale_shortcut + 1;
    end if;

    v_delegate_rows := v_delegate_rows || jsonb_build_array(v_delegate_row);
  end loop;

  v_result := public.ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut(
    jsonb_set(p_payload, '{rows}', v_delegate_rows, false)
  );
  v_result := v_result || jsonb_build_object(
    'identity_stale_short_circuited', v_stale_shortcut
  );

  update attendance_private.adjustment_sheet_inbound_requests inbound
  set result = v_result
  where inbound.request_id = v_request_id;

  return v_result;
end;
$$;

revoke all on function
  public.ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ingest_adjustment_sheet_inbound_without_category(jsonb)
  from public, anon, authenticated, service_role;

comment on function public.ingest_adjustment_sheet_inbound_without_category(jsonb) is
  'Private stale-UUID shortcut: serializes by physical Google slot and converts an unknown UUID at an older/equal revision into a non-mutating stale success before strict newer-content recovery.';
comment on function
  public.ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut(jsonb) is
  'Private strict physical-slot identity recovery retained behind the stale-UUID shortcut.';

-- Manual repair is reserved for a newer, independently verified current
-- Google value whose business content legitimately differs from Supabase.
-- Its archive is append-only even for privileged application roles.
create table if not exists attendance_private.adjustment_identity_repair_archive (
  id bigint generated always as identity primary key,
  repair_request_id uuid not null unique,
  repair_reason text not null,
  source_id uuid not null,
  source_key text not null,
  google_row integer not null check (google_row >= 3),
  source_slot text not null check (source_slot <> ''),
  record_id uuid not null,
  old_external_id uuid not null,
  new_external_id uuid not null,
  old_revision bigint not null check (old_revision > 0),
  new_revision bigint not null check (new_revision > old_revision),
  superseded_outbox_count integer not null check (superseded_outbox_count >= 0),
  record_snapshot jsonb not null check (jsonb_typeof(record_snapshot) = 'object'),
  verified_google_payload jsonb not null
    check (jsonb_typeof(verified_google_payload) = 'object'),
  payload_fingerprint text not null check (payload_fingerprint <> ''),
  archived_at timestamptz not null default clock_timestamp()
);

alter table attendance_private.adjustment_identity_repair_archive
  enable row level security;

revoke all on table attendance_private.adjustment_identity_repair_archive
  from public, anon, authenticated, service_role;
revoke all on sequence
  attendance_private.adjustment_identity_repair_archive_id_seq
  from public, anon, authenticated, service_role;

drop policy if exists adjustment_identity_repair_archive_no_app_access
  on attendance_private.adjustment_identity_repair_archive;
create policy adjustment_identity_repair_archive_no_app_access
  on attendance_private.adjustment_identity_repair_archive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create or replace function
  attendance_private.prevent_adjustment_identity_repair_archive_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'adjustment_identity_repair_archive_is_immutable';
end;
$$;

drop trigger if exists adjustment_identity_repair_archive_immutable
  on attendance_private.adjustment_identity_repair_archive;
create trigger adjustment_identity_repair_archive_immutable
before update or delete on attendance_private.adjustment_identity_repair_archive
for each row execute function
  attendance_private.prevent_adjustment_identity_repair_archive_mutation();

revoke all on function
  attendance_private.prevent_adjustment_identity_repair_archive_mutation()
  from public, anon, authenticated, service_role;

create or replace function
  attendance_private.repair_adjustment_slot_from_verified_google(
    p_payload jsonb
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_source_key text := btrim(coalesce(p_payload->>'source_key', ''));
  v_source public.attendance_sheet_sources%rowtype;
  v_record public.employee_attendance_records%rowtype;
  v_candidate public.employee_attendance_records%rowtype;
  v_record_snapshot jsonb;
  v_slot_count integer := 0;
  v_external_id uuid;
  v_revision bigint;
  v_google_row integer;
  v_source_slot text;
  v_origin text;
  v_event_date date;
  v_amount numeric;
  v_note text;
  v_employee_no text;
  v_employee_name text;
  v_category text;
  v_currency text;
  v_employee_id uuid;
  v_employee_count integer;
  v_superseded integer := 0;
  v_updated integer := 0;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_payload';
  end if;
  begin
    v_request_id := (p_payload->>'request_id')::uuid;
    v_external_id := (p_payload->>'external_id')::uuid;
    v_revision := (p_payload->>'revision')::bigint;
    v_google_row := (p_payload->>'google_row')::integer;
    v_event_date := (p_payload->>'event_date')::date;
    v_amount := round((p_payload->>'signed_amount')::numeric, 2);
  exception when others then
    raise exception 'invalid_verified_google_payload';
  end;
  if v_request_id is null or v_external_id is null then
    raise exception 'invalid_verified_google_payload';
  end if;
  if exists (
    select 1
    from attendance_private.adjustment_identity_repair_archive archive
    where archive.repair_request_id = v_request_id
  ) then
    raise exception 'adjustment_repair_request_already_used';
  end if;

  v_origin := lower(btrim(coalesce(p_payload->>'origin', '')));
  v_source_slot := lower(btrim(coalesce(p_payload->>'source_slot', '')));
  v_note := btrim(coalesce(p_payload->>'note', ''));
  v_employee_no := upper(btrim(coalesce(p_payload->>'employee_no', '')));
  v_employee_name := btrim(coalesce(p_payload->>'employee_name', ''));
  v_category := btrim(coalesce(p_payload->>'category', p_payload->>'raw_type', ''));
  v_currency := upper(btrim(coalesce(p_payload->>'currency', '')));

  select *
  into v_source
  from public.attendance_sheet_sources source
  where source.source_key = v_source_key
    and source.scope = 'adjustment'
    and source.is_active
    and source.metadata->>'sync_protocol' = 'adjustment-v1';
  if not found then
    raise exception 'source_not_allowlisted';
  end if;

  if v_origin <> 'google'
     or v_revision < 1
     or v_google_row < 3
     or to_char(v_event_date, 'YYYY-MM') <> v_source.source_month
     or v_amount = 0
     or abs(v_amount) > 100000000
     or v_note = ''
     or char_length(v_note) > 4000
     or v_employee_no = ''
     or char_length(v_employee_no) > 100
     or v_employee_name = ''
     or v_category = ''
     or char_length(v_category) > 200 then
    raise exception 'invalid_verified_google_payload';
  end if;
  if v_currency <> upper(btrim(coalesce(v_source.metadata->>'currency', '')))
     or v_currency not in ('USD', 'PHP') then
    raise exception 'currency_does_not_match_workbook';
  end if;
  if (v_source.metadata->>'layout' = 'standard' and v_source_slot <> 'primary')
     or (v_source.metadata->>'layout' = 'philippines'
         and v_source_slot not in ('first_half', 'second_half')) then
    raise exception 'invalid_source_slot';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      concat_ws('|', 'adjustment-slot-v1', v_source.id::text,
        v_google_row::text, v_source_slot),
      0
    )
  );

  for v_candidate in
    select record.*
    from public.employee_attendance_records record
    where record.source_id = v_source.id
      and record.kind = 'adjustment'
      and record.raw_values->>'sync_protocol' = 'adjustment-v1'
      and btrim(coalesce(record.raw_values->>'google_row', '')) =
          v_google_row::text
      and lower(btrim(coalesce(record.raw_values->>'source_slot', ''))) =
          v_source_slot
    order by record.id
    for update
  loop
    v_slot_count := v_slot_count + 1;
    v_record := v_candidate;
  end loop;

  if v_slot_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_repair_requires_exactly_one_canonical_row',
      detail = format('found=%s', v_slot_count);
  end if;
  if v_record.external_id is null
     or v_record.source_item_key is distinct from v_record.external_id::text
     or v_record.raw_values->>'external_id' is distinct from
        v_record.external_id::text then
    raise exception 'adjustment_repair_canonical_uuid_projection_mismatch';
  end if;
  if v_record.external_id = v_external_id then
    raise exception 'adjustment_repair_requires_different_external_id';
  end if;
  if v_revision <= v_record.sync_revision then
    raise exception 'adjustment_repair_requires_newer_revision';
  end if;
  if exists (
    select 1
    from public.employee_attendance_records record
    where record.id <> v_record.id
      and (
        record.external_id = v_external_id
        or record.source_item_key = v_external_id::text
        or record.raw_values->>'external_id' = v_external_id::text
      )
  ) then
    raise exception 'adjustment_repair_external_id_already_owned';
  end if;

  -- Exact canonical employee-number resolution is mandatory; names may be
  -- corrected by the verified Google value only after the employee ID agrees.
  select count(*)::integer, min(employee.id::text)::uuid
  into v_employee_count, v_employee_id
  from public.employees employee
  where upper(btrim(employee.employee_no)) = v_employee_no;
  if v_employee_count <> 1
     or v_record.employee_id is distinct from v_employee_id
     or upper(btrim(coalesce(v_record.employee_no_raw, ''))) is distinct from
        v_employee_no then
    raise exception 'adjustment_repair_employee_identity_mismatch';
  end if;

  v_record_snapshot := to_jsonb(v_record);

  -- Delivered rows remain immutable history.  Only unfinished work carrying
  -- the superseded UUID is closed before the canonical row is rekeyed.
  update attendance_private.adjustment_sheet_outbox outbox
  set state = 'superseded',
      locked_by = null,
      locked_until = null,
      last_error = 'verified_google_slot_repair',
      updated_at = clock_timestamp()
  where outbox.adjustment_record_id = v_record.id
    and outbox.external_id = v_record.external_id
    and outbox.state in ('pending', 'processing', 'failed');
  get diagnostics v_superseded = row_count;

  insert into attendance_private.adjustment_identity_repair_archive (
    repair_request_id,
    repair_reason,
    source_id,
    source_key,
    google_row,
    source_slot,
    record_id,
    old_external_id,
    new_external_id,
    old_revision,
    new_revision,
    superseded_outbox_count,
    record_snapshot,
    verified_google_payload,
    payload_fingerprint
  ) values (
    v_request_id,
    'verified_current_google_business_content',
    v_source.id,
    v_source_key,
    v_google_row,
    v_source_slot,
    v_record.id,
    v_record.external_id,
    v_external_id,
    v_record.sync_revision,
    v_revision,
    v_superseded,
    v_record_snapshot,
    p_payload,
    md5(p_payload::text)
  );

  update public.employee_attendance_records record
  set source_item_key = v_external_id::text,
      event_date = v_event_date,
      event_kind = case when v_amount > 0 then 'bonus' else 'deduction' end,
      reason = v_category,
      note = v_note,
      amount = v_amount,
      raw_amount = v_amount::text,
      currency = v_currency,
      employee_id = v_employee_id,
      employee_no_raw = v_employee_no,
      employee_name_raw = v_employee_name,
      match_status = 'matched',
      match_method = 'employee_id_exact',
      matched_at = clock_timestamp(),
      raw_values = jsonb_build_object(
        'sync_protocol', 'adjustment-v1',
        'external_id', v_external_id,
        'origin', 'google',
        'revision', v_revision,
        'google_sync_state', 'synced',
        'workbook_key', v_source.metadata->>'workbook_key',
        'source_key', v_source_key,
        'source_month', v_source.source_month,
        'source_slot', v_source_slot,
        'currency', v_currency,
        'google_row', v_google_row,
        'category', v_category,
        'raw_type', v_category
      ),
      content_hash = md5(concat_ws('|',
        v_external_id::text,
        v_revision::text,
        v_source_slot,
        v_event_date::text,
        v_employee_no,
        v_employee_name,
        v_amount::text,
        v_category,
        v_note
      )),
      source_updated_at = clock_timestamp(),
      synced_at = clock_timestamp(),
      external_id = v_external_id,
      sync_origin = 'google',
      sync_revision = v_revision,
      updated_by = null,
      updated_at = clock_timestamp()
  where record.id = v_record.id;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'adjustment_repair_canonical_update_count_mismatch';
  end if;

  -- Do not mark the entire source healthy from one repaired slot; a normal
  -- sync run owns source-wide status.  Record only the narrow operator action.
  update public.attendance_sheet_sources source
  set metadata = source.metadata || jsonb_build_object(
        'last_verified_slot_repair_at', clock_timestamp()
      ),
      updated_at = clock_timestamp()
  where source.id = v_source.id;

  return jsonb_build_object(
    'ok', true,
    'status', 'repaired',
    'request_id', v_request_id,
    'record_id', v_record.id,
    'source_key', v_source_key,
    'google_row', v_google_row,
    'source_slot', v_source_slot,
    'old_external_id', v_record.external_id,
    'new_external_id', v_external_id,
    'old_revision', v_record.sync_revision,
    'new_revision', v_revision,
    'superseded_outbox', v_superseded
  );
end;
$$;

revoke all on function
  attendance_private.repair_adjustment_slot_from_verified_google(jsonb)
  from public, anon, authenticated, service_role;

comment on table attendance_private.adjustment_identity_repair_archive is
  'Append-only pre-change snapshots for narrowly verified operator repairs of newer Google adjustment slot identities; inaccessible to application roles.';
comment on function
  attendance_private.repair_adjustment_slot_from_verified_google(jsonb) is
  'Database-operator-only repair for one verified newer Google adjustment payload. It locks one slot, requires exact canonical row and employee identity, archives first, supersedes unfinished old outbox work, and atomically rekeys all UUID and business projections.';

notify pgrst, 'reload schema';

commit;
