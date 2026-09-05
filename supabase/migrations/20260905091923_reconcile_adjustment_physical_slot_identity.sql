begin;

set local lock_timeout = '15s';
set local statement_timeout = '90s';

-- A Google adjustment cell has two identities:
--   * its logical UUID, stored in sheet metadata; and
--   * its physical source coordinate (source + row + slot).
--
-- Duplicate Apps Script installations can race while the metadata cell is
-- empty and allocate different UUIDs for the same physical coordinate.  Keep
-- an immutable snapshot of any provably identical duplicate that is removed
-- while establishing the physical-coordinate invariant below.
create table if not exists attendance_private.adjustment_identity_duplicate_archive (
  id bigint generated always as identity primary key,
  archive_batch text not null,
  archive_reason text not null,
  source_id uuid not null,
  source_key text not null,
  google_row integer not null check (google_row >= 3),
  source_slot text not null check (source_slot <> ''),
  survivor_record_id uuid not null,
  archived_record_id uuid not null unique,
  business_fingerprint text not null check (business_fingerprint <> ''),
  record_snapshot jsonb not null check (jsonb_typeof(record_snapshot) = 'object'),
  archived_at timestamptz not null default clock_timestamp()
);

alter table attendance_private.adjustment_identity_duplicate_archive
  enable row level security;

revoke all on table attendance_private.adjustment_identity_duplicate_archive
  from public, anon, authenticated;
revoke all on sequence attendance_private.adjustment_identity_duplicate_archive_id_seq
  from public, anon, authenticated;
grant select on table attendance_private.adjustment_identity_duplicate_archive
  to service_role;

drop policy if exists adjustment_identity_duplicate_archive_no_direct_access
  on attendance_private.adjustment_identity_duplicate_archive;
create policy adjustment_identity_duplicate_archive_no_direct_access
  on attendance_private.adjustment_identity_duplicate_archive
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- Block adjustment writes only for the short cleanup/index-build window.  The
-- sync is retried by Apps Script if this lock happens to overlap a run.
lock table public.employee_attendance_records in share row exclusive mode;

create temporary table adjustment_identity_duplicate_plan
on commit drop
as
with outbox_usage as (
  select o.adjustment_record_id, count(*)::integer as outbox_count
  from attendance_private.adjustment_sheet_outbox o
  group by o.adjustment_record_id
), candidates as (
  select
    r.id as record_id,
    r.source_id,
    s.source_key,
    (btrim(r.raw_values->>'google_row'))::integer as google_row,
    lower(btrim(r.raw_values->>'source_slot')) as source_slot,
    row_number() over (
      partition by
        r.source_id,
        btrim(r.raw_values->>'google_row'),
        lower(btrim(r.raw_values->>'source_slot'))
      order by
        (coalesce(outbox_usage.outbox_count, 0) > 0) desc,
        r.sync_revision desc,
        r.updated_at desc,
        r.id desc
    ) as duplicate_rank,
    first_value(r.id) over (
      partition by
        r.source_id,
        btrim(r.raw_values->>'google_row'),
        lower(btrim(r.raw_values->>'source_slot'))
      order by
        (coalesce(outbox_usage.outbox_count, 0) > 0) desc,
        r.sync_revision desc,
        r.updated_at desc,
        r.id desc
    ) as survivor_record_id,
    count(*) over (
      partition by
        r.source_id,
        btrim(r.raw_values->>'google_row'),
        lower(btrim(r.raw_values->>'source_slot'))
    ) as duplicate_count
  from public.employee_attendance_records r
  join public.attendance_sheet_sources s
    on s.id = r.source_id
   and s.scope = 'adjustment'
  left join outbox_usage
    on outbox_usage.adjustment_record_id = r.id
  where r.kind = 'adjustment'
    and r.raw_values->>'sync_protocol' = 'adjustment-v1'
    and btrim(coalesce(r.raw_values->>'google_row', '')) ~ '^[0-9]{1,9}$'
    and (btrim(r.raw_values->>'google_row'))::integer >= 3
    and nullif(lower(btrim(r.raw_values->>'source_slot')), '') is not null
)
select
  record_id,
  survivor_record_id,
  source_id,
  source_key,
  google_row,
  source_slot,
  duplicate_count
from candidates
where duplicate_count > 1
  and duplicate_rank > 1;

do $deduplicate$
declare
  v_expected integer;
  v_archived integer;
  v_deleted integer;
begin
  select count(*)::integer
  into v_expected
  from pg_temp.adjustment_identity_duplicate_plan;

  -- A duplicate is removable only when each row's three UUID fields are
  -- internally aligned and all business fields are identical to the survivor.
  -- Category is compared whenever it exists in the structured source fields;
  -- two historical rows with no structured category remain comparable.
  if exists (
    select 1
    from pg_temp.adjustment_identity_duplicate_plan plan
    join public.employee_attendance_records archived
      on archived.id = plan.record_id
    join public.employee_attendance_records survivor
      on survivor.id = plan.survivor_record_id
    where archived.external_id is null
       or survivor.external_id is null
       or archived.source_item_key is distinct from archived.external_id::text
       or survivor.source_item_key is distinct from survivor.external_id::text
       or archived.raw_values->>'external_id' is distinct from archived.external_id::text
       or survivor.raw_values->>'external_id' is distinct from survivor.external_id::text
       or upper(btrim(coalesce(archived.employee_no_raw, ''))) is distinct from
          upper(btrim(coalesce(survivor.employee_no_raw, '')))
       or btrim(coalesce(archived.employee_name_raw, '')) is distinct from
          btrim(coalesce(survivor.employee_name_raw, ''))
       or archived.event_date is distinct from survivor.event_date
       or round(archived.amount, 2) is distinct from round(survivor.amount, 2)
       or btrim(coalesce(archived.note, '')) is distinct from
          btrim(coalesce(survivor.note, ''))
       or coalesce(
            nullif(btrim(archived.raw_values->>'category'), ''),
            nullif(btrim(archived.raw_values->>'raw_type'), '')
          ) is distinct from coalesce(
            nullif(btrim(survivor.raw_values->>'category'), ''),
            nullif(btrim(survivor.raw_values->>'raw_type'), '')
          )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_duplicate_business_content_mismatch',
      detail = 'No physical-slot duplicate was deleted; inspect the conflicting rows manually.';
  end if;

  -- Never cascade away an outbox delivery/history row.  Ranking retains the
  -- sole outbox owner when possible; more than one owner is an unsafe state.
  if exists (
    select 1
    from pg_temp.adjustment_identity_duplicate_plan plan
    join attendance_private.adjustment_sheet_outbox outbox
      on outbox.adjustment_record_id = plan.record_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_duplicate_has_outbox_history',
      detail = 'No physical-slot duplicate was deleted; reconcile its outbox first.';
  end if;

  insert into attendance_private.adjustment_identity_duplicate_archive (
    archive_batch,
    archive_reason,
    source_id,
    source_key,
    google_row,
    source_slot,
    survivor_record_id,
    archived_record_id,
    business_fingerprint,
    record_snapshot
  )
  select
    '20260905091923_reconcile_adjustment_physical_slot_identity',
    'duplicate_physical_slot_identical_business_content',
    plan.source_id,
    plan.source_key,
    plan.google_row,
    plan.source_slot,
    plan.survivor_record_id,
    archived.id,
    md5(concat_ws('|',
      upper(btrim(coalesce(archived.employee_no_raw, ''))),
      btrim(coalesce(archived.employee_name_raw, '')),
      archived.event_date::text,
      round(archived.amount, 2)::text,
      btrim(coalesce(archived.note, '')),
      coalesce(
        nullif(btrim(archived.raw_values->>'category'), ''),
        nullif(btrim(archived.raw_values->>'raw_type'), ''),
        '<category-unavailable>'
      )
    )),
    to_jsonb(archived)
  from pg_temp.adjustment_identity_duplicate_plan plan
  join public.employee_attendance_records archived
    on archived.id = plan.record_id
  on conflict (archived_record_id) do nothing;

  get diagnostics v_archived = row_count;
  if v_archived <> v_expected then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_duplicate_archive_count_mismatch',
      detail = format('expected=%s archived=%s', v_expected, v_archived);
  end if;

  delete from public.employee_attendance_records record
  using pg_temp.adjustment_identity_duplicate_plan plan
  where record.id = plan.record_id;

  get diagnostics v_deleted = row_count;
  if v_deleted <> v_expected then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_duplicate_delete_count_mismatch',
      detail = format('expected=%s deleted=%s', v_expected, v_deleted);
  end if;

  if exists (
    select 1
    from public.employee_attendance_records r
    where r.kind = 'adjustment'
      and r.raw_values->>'sync_protocol' = 'adjustment-v1'
      and nullif(btrim(r.raw_values->>'google_row'), '') is not null
      and nullif(lower(btrim(r.raw_values->>'source_slot')), '') is not null
    group by
      r.source_id,
      btrim(r.raw_values->>'google_row'),
      lower(btrim(r.raw_values->>'source_slot'))
    having count(*) > 1
  ) then
    raise exception 'adjustment_duplicate_cleanup_incomplete';
  end if;
end
$deduplicate$;

-- Physical coordinates are now a database invariant.  Rows created in the
-- admin UI are not indexed until Google acknowledges a concrete google_row.
create unique index if not exists employee_attendance_adjustment_physical_slot_unique_idx
  on public.employee_attendance_records (
    source_id,
    (btrim(raw_values->>'google_row')),
    (lower(btrim(raw_values->>'source_slot')))
  )
  where kind = 'adjustment'
    and raw_values->>'sync_protocol' = 'adjustment-v1'
    and nullif(btrim(raw_values->>'google_row'), '') is not null
    and nullif(lower(btrim(raw_values->>'source_slot')), '') is not null;

-- Preserve the proven adjustment-v1 writer as a private implementation and
-- put the physical-slot recovery layer in front of it.  The public category
-- wrapper continues calling the original private function name.
alter function public.ingest_adjustment_sheet_inbound_without_category(jsonb)
  rename to ingest_adjustment_sheet_inbound_without_slot_recovery;

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
  v_delegate_payload jsonb;
  v_external_record public.employee_attendance_records%rowtype;
  v_slot_record public.employee_attendance_records%rowtype;
  v_candidate public.employee_attendance_records%rowtype;
  v_external_id uuid;
  v_old_external_id uuid;
  v_revision bigint;
  v_google_row integer;
  v_source_slot text;
  v_origin text;
  v_event_date date;
  v_amount numeric;
  v_note text;
  v_employee_no text;
  v_employee_name text;
  v_incoming_category text;
  v_existing_category text;
  v_slot_count integer;
  v_rekeyed integer := 0;
  v_identity_stale integer := 0;
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

  -- Reject a replay with a changed body before any identity repair happens.
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

  -- Acquire all coordinate locks in one deterministic order.  This prevents
  -- opposite row ordering in two batch requests from creating a deadlock.
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
    v_external_record := null;
    v_slot_record := null;
    v_slot_count := 0;
    begin
      v_external_id := (v_row->>'external_id')::uuid;
      v_revision := (v_row->>'revision')::bigint;
      v_google_row := (v_row->>'google_row')::integer;
      v_event_date := (v_row->>'event_date')::date;
      v_amount := round((v_row->>'signed_amount')::numeric, 2);
    exception when others then
      raise exception 'invalid_inbound_row';
    end;
    v_source_slot := lower(btrim(coalesce(v_row->>'source_slot', '')));
    v_origin := lower(btrim(coalesce(v_row->>'origin', '')));
    v_note := btrim(coalesce(v_row->>'note', ''));
    v_employee_no := upper(btrim(coalesce(v_row->>'employee_no', '')));
    v_employee_name := btrim(coalesce(v_row->>'employee_name', ''));
    v_incoming_category := coalesce(
      nullif(btrim(v_row->>'category'), ''),
      nullif(btrim(v_row->>'raw_type'), '')
    );

    select *
    into v_external_record
    from public.employee_attendance_records record
    where record.external_id = v_external_id
    for update;

    -- The old writer owns normal stable-UUID semantics, including route/slot
    -- validation, Supabase echoes and stale revisions.  Once a Google row has
    -- been bound, however, the UUID may not silently move to another row.
    if v_external_record.id is not null then
      if v_external_record.source_id = v_source.id
         and v_external_record.kind = 'adjustment'
         and nullif(btrim(v_external_record.raw_values->>'google_row'), '') is not null
         and btrim(v_external_record.raw_values->>'google_row') <> v_google_row::text then
        raise exception 'external_id_google_row_mismatch';
      end if;
      v_delegate_rows := v_delegate_rows || jsonb_build_array(v_delegate_row);
      continue;
    end if;

    if v_origin <> 'google' then
      v_delegate_rows := v_delegate_rows || jsonb_build_array(v_delegate_row);
      continue;
    end if;

    -- The unique index makes this at most one in healthy state.  Count anyway
    -- so a missing/disabled invariant never turns an ambiguity into a merge.
    for v_candidate in
      select record.*
      from public.employee_attendance_records record
      where record.source_id = v_source.id
        and record.kind = 'adjustment'
        and btrim(coalesce(record.raw_values->>'google_row', '')) = v_google_row::text
        and lower(btrim(coalesce(record.raw_values->>'source_slot', ''))) = v_source_slot
      order by record.id
      for update
    loop
      v_slot_count := v_slot_count + 1;
      v_slot_record := v_candidate;
    end loop;

    if v_slot_count > 1 then
      raise exception 'google_source_slot_identity_conflict';
    end if;
    if v_slot_count = 0 then
      v_delegate_rows := v_delegate_rows || jsonb_build_array(v_delegate_row);
      continue;
    end if;

    v_existing_category := coalesce(
      nullif(btrim(v_slot_record.raw_values->>'category'), ''),
      nullif(btrim(v_slot_record.raw_values->>'raw_type'), '')
    );

    -- A UUID may be adopted only when every sheet-owned business field still
    -- describes the same adjustment.  Any uncertainty remains fail closed.
    if upper(btrim(coalesce(v_slot_record.employee_no_raw, ''))) is distinct from v_employee_no
       or btrim(coalesce(v_slot_record.employee_name_raw, '')) is distinct from v_employee_name
       or v_slot_record.event_date is distinct from v_event_date
       or round(v_slot_record.amount, 2) is distinct from v_amount
       or btrim(coalesce(v_slot_record.note, '')) is distinct from v_note
       or v_existing_category is distinct from v_incoming_category then
      raise exception 'google_source_slot_identity_conflict';
    end if;

    if v_revision > v_slot_record.sync_revision then
      -- All stored UUID projections must agree before changing identity.
      if v_slot_record.external_id is null
         or v_slot_record.source_item_key is distinct from v_slot_record.external_id::text
         or v_slot_record.raw_values->>'external_id'
              is distinct from v_slot_record.external_id::text then
        raise exception 'google_source_slot_identity_conflict';
      end if;

      v_old_external_id := v_slot_record.external_id;

      -- A newer Google revision supersedes any unfinished delivery carrying
      -- the previous UUID.  Delivered rows remain immutable audit history.
      update attendance_private.adjustment_sheet_outbox outbox
      set state = 'superseded',
          locked_by = null,
          locked_until = null,
          last_error = 'google_identity_rekeyed',
          updated_at = clock_timestamp()
      where outbox.adjustment_record_id = v_slot_record.id
        and outbox.external_id = v_old_external_id
        and outbox.state in ('pending', 'processing', 'failed');

      update public.employee_attendance_records record
      set external_id = v_external_id,
          source_item_key = v_external_id::text,
          raw_values = jsonb_set(
            record.raw_values,
            '{external_id}',
            to_jsonb(v_external_id::text),
            true
          )
      where record.id = v_slot_record.id;

      v_rekeyed := v_rekeyed + 1;
    else
      -- The same business state with an older/equal revision is a harmless
      -- duplicate identity.  Delegate under the canonical UUID so the proven
      -- writer records a normal stale success and the Apps Script queue clears.
      v_delegate_row := jsonb_set(
        v_delegate_row,
        '{external_id}',
        to_jsonb(v_slot_record.external_id::text),
        false
      );
      v_identity_stale := v_identity_stale + 1;
    end if;

    v_delegate_rows := v_delegate_rows || jsonb_build_array(v_delegate_row);
  end loop;

  v_delegate_payload := jsonb_set(p_payload, '{rows}', v_delegate_rows, false);
  v_result := public.ingest_adjustment_sheet_inbound_without_slot_recovery(
    v_delegate_payload
  );

  v_result := v_result || jsonb_build_object(
    'identity_rekeyed', v_rekeyed,
    'identity_stale_ignored', v_identity_stale
  );

  -- Keep replay responses byte-for-byte consistent with the first accepted
  -- request, including the recovery counters added by this layer.
  update attendance_private.adjustment_sheet_inbound_requests inbound
  set result = v_result
  where inbound.request_id = v_request_id;

  return v_result;
end;
$$;

revoke all on function public.ingest_adjustment_sheet_inbound_without_slot_recovery(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ingest_adjustment_sheet_inbound_without_category(jsonb)
  from public, anon, authenticated, service_role;

comment on table attendance_private.adjustment_identity_duplicate_archive is
  'Immutable snapshots of provably identical adjustment-v1 rows removed while enforcing one canonical row per Google physical source slot.';
comment on function public.ingest_adjustment_sheet_inbound_without_category(jsonb) is
  'Private physical-slot recovery layer: serializes Google edits, safely adopts a newer UUID only for identical business content, and treats identical older UUID retries as stale success.';
comment on function public.ingest_adjustment_sheet_inbound_without_slot_recovery(jsonb) is
  'Private proven adjustment-v1 writer retained behind the physical-slot recovery layer.';

notify pgrst, 'reload schema';

commit;
