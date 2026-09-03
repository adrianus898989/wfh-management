-- Production migration history version: 20260903103727.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- 20260903102401_rekey_duplicate_adjustment_trigger_identities.sql aligned the
-- three durable identity fields with the UUIDs already stored in Google, but it
-- intentionally did not touch the business payload.  content_hash includes the
-- external UUID, so those rows retained hashes derived from the former UUID.
--
-- Repair only the 25 verified physical slots.  A row is accepted only when its
-- identity is fully aligned to the new UUID and its hash is either the canonical
-- new-UUID hash (idempotent replay / a completed Google retry) or the exact stale
-- old-UUID hash left by the rekey.  No business timestamp is advanced because
-- this is a derived-value correction rather than a new Google or admin edit.
create temporary table adjustment_identity_hash_repair_map (
  source_key text not null,
  google_row integer not null check (google_row >= 3),
  source_slot text not null check (source_slot <> ''),
  employee_no text not null check (
    employee_no = btrim(employee_no) and employee_no <> ''
  ),
  old_external_id uuid not null,
  new_external_id uuid not null,
  primary key (source_key, google_row, source_slot),
  unique (old_external_id),
  unique (new_external_id),
  check (old_external_id <> new_external_id)
) on commit drop;

create temporary table adjustment_identity_hash_repair_before (
  record_id uuid primary key,
  row_without_content_hash jsonb not null
) on commit drop;

insert into adjustment_identity_hash_repair_map (
  source_key,
  google_row,
  source_slot,
  employee_no,
  old_external_id,
  new_external_id
)
values
  ('adjustment_onsite_2026_09', 8, 'primary', 'YM525081704',
    '9ae3c3fb-c043-4b16-94b5-8d763a1ec1b7',
    '1e574f34-0817-40ab-b316-0cda215f9fc1'),
  ('adjustment_home_vim_2026_09', 7, 'primary', 'CS000575',
    '00870f7b-1868-48d7-a703-058a74deaa79',
    '12f19697-c162-487d-b0ef-c9eff13005d4'),
  ('adjustment_home_vim_2026_09', 8, 'primary', 'CS001198',
    '1cf774db-233d-45fe-8325-a3c3140b2fbb',
    'ad2d206b-d6be-47e6-a9a6-6103180105b0'),
  ('adjustment_home_vim_2026_09', 9, 'primary', 'ZJ00119',
    '5f879869-de5c-4c74-b943-424599a4b0ac',
    'c3603c6b-7217-4d5f-8c9e-3eeb97b3d271'),
  ('adjustment_home_vim_2026_09', 11, 'primary', 'ZJ00179',
    'ce05c041-ac02-4c32-9f6e-87279b199ad2',
    '4b456494-54a7-4a9c-adce-6c4c1ace4d72'),
  ('adjustment_home_vim_2026_09', 14, 'primary', 'ZJ00119',
    '1e7001d6-195a-4b41-82f1-1ce5db8e1f98',
    'ef4408b9-d45c-4412-b70f-d9767f779249'),
  ('adjustment_home_vim_2026_09', 15, 'primary', 'ZJ00179',
    '978982ae-a62b-4b77-ab0b-aec6ba6f5d72',
    'b7843470-cf3f-4aec-9dd0-b370098a5b46'),
  ('adjustment_home_ph_2026_09', 5, 'first_half', 'WD001418',
    'c1761a03-397c-48aa-bdb0-e5e4709073cd',
    'bc3ae48c-3fa6-4894-b24a-cd3a5463fd47'),
  ('adjustment_home_ph_2026_09', 7, 'first_half', 'CS00025',
    '7fe8628d-c4cd-4e5c-9d96-cd470c0111ad',
    'c179b273-7a04-4be7-bd0e-1fc4f9faf953'),
  ('adjustment_home_ph_2026_09', 15, 'first_half', 'WD000506',
    '77681320-98f0-4551-835d-784df6093777',
    'bbee7764-c3ff-4830-b6af-cfbe22b81543'),
  ('adjustment_home_ph_2026_09', 19, 'first_half', 'WD001094',
    '79aab3cf-f0a0-406f-b3df-c7caabddd40e',
    'a255efad-dc79-471d-8bdc-9278880e5441'),
  ('adjustment_home_ph_2026_09', 21, 'first_half', 'WD001499',
    '6793e208-e720-4bbf-9ec1-a7abea2cb588',
    '21a6dbcd-3fd8-44ca-a9ea-8944c647392c'),
  ('adjustment_home_ph_2026_09', 24, 'first_half', 'CS001363',
    '3d163d57-667f-411b-a2ab-1895cf7aef17',
    '26fcb5c8-13a1-45e0-8a72-8983181b9dd6'),
  ('adjustment_home_ph_2026_09', 26, 'first_half', 'CS000987',
    'f5087190-09c6-4db5-b857-4db152121a49',
    '9ee398aa-010d-4cad-a667-644225aa02b9'),
  ('adjustment_home_ph_2026_09', 27, 'first_half', 'WD001697',
    '5492c45f-c840-4d62-9548-a09a5e0631ca',
    '0ceea703-7ccd-40dd-b91c-566b340c68f2'),
  ('adjustment_home_ph_2026_09', 28, 'first_half', 'WD001725',
    '447ea5fe-3800-46f6-8732-fa6a2f5830d1',
    'e646b3fc-96b8-4e11-88c3-cfb69da3db33'),
  ('adjustment_home_ph_2026_09', 31, 'first_half', 'CS001342',
    'e0f4a722-c675-40b5-9230-429c8e424696',
    'b9c19995-98e1-4d17-8763-bd6a7eb2dc2d'),
  ('adjustment_home_ph_2026_09', 32, 'first_half', 'WD001209',
    '3732fbd2-b097-4418-92d2-5d99879477b0',
    '37df1b6f-44f9-4bfd-8e29-e8e6b3a10d45'),
  ('adjustment_home_ph_2026_09', 34, 'first_half', 'CS000721',
    '9f619a35-9bbc-47ac-a326-b7615753dc67',
    '558a62c8-adfe-40b8-9345-3f680cbf45eb'),
  ('adjustment_home_ph_2026_09', 35, 'first_half', 'CS000940',
    '51f5738d-4648-474c-868f-46a36d0b47c5',
    'f868c283-0c41-4a6f-9293-8daad393d333'),
  ('adjustment_home_ph_2026_09', 36, 'first_half', 'WD000904',
    '01c000c0-f92f-4be5-a442-b2a36e0bea22',
    'f931083d-5c45-419e-93e2-c05af39d40c2'),
  ('adjustment_home_ph_2026_09', 37, 'first_half', 'CS001395',
    '66b9f8b3-afa7-4755-bacd-c5f391735267',
    '4dc3f8b2-f1fd-4428-91fa-4f50edfe8582'),
  ('adjustment_home_ph_2026_09', 38, 'first_half', 'WD001117',
    '22d1f341-7838-43f3-9cf5-9d9599b98e61',
    '2809411c-e326-4ce2-b2e5-0dc29f047cc7'),
  ('adjustment_home_ph_2026_09', 39, 'first_half', 'WD000152',
    'cd5f46cf-5ed3-476f-9eb3-8d4d2e00c0ae',
    '50257f28-90d9-452d-8c7b-97b4f9404d6f'),
  ('adjustment_home_ph_2026_09', 40, 'first_half', 'WD001340',
    'd16bc0b4-ba08-4570-811a-119b1f314152',
    '2132dd8c-bbe3-4be5-b34a-154d8e7db9b2');

do $repair$
declare
  v_count integer;
  v_updated integer;
begin
  select count(*) into v_count
  from pg_temp.adjustment_identity_hash_repair_map;
  if v_count <> 25 then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_identity_hash_repair_mapping_count_invalid',
      detail = format('expected=25 actual=%s', v_count);
  end if;

  if to_regclass('public.employee_attendance_records') is null
     or to_regclass('public.attendance_sheet_sources') is null
  then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_identity_hash_repair_dependency_missing';
  end if;

  select count(*) into v_count
  from pg_temp.adjustment_identity_hash_repair_map m
  where (
    select count(*)
    from public.attendance_sheet_sources s
    where s.source_key = m.source_key
      and s.scope = 'adjustment'
      and s.is_active
      and s.metadata->>'sync_protocol' = 'adjustment-v1'
  ) <> 1;
  if v_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_identity_hash_repair_source_mismatch',
      detail = format('invalid_mappings=%s', v_count);
  end if;

  -- Lock every mapped row in a deterministic order before validating or
  -- changing a hash.  Concurrent Google retries can then finish either before
  -- this transaction starts or after it commits, without a mixed proof state.
  perform r.id
  from pg_temp.adjustment_identity_hash_repair_map m
  join public.attendance_sheet_sources s
    on s.source_key = m.source_key
   and s.scope = 'adjustment'
   and s.is_active
   and s.metadata->>'sync_protocol' = 'adjustment-v1'
  join public.employee_attendance_records r
    on r.source_id = s.id
   and r.kind = 'adjustment'
   and r.raw_values->>'google_row' = m.google_row::text
   and r.raw_values->>'source_slot' = m.source_slot
  order by r.id
  for update of r;

  select count(*) into v_count
  from pg_temp.adjustment_identity_hash_repair_map m
  join public.attendance_sheet_sources s
    on s.source_key = m.source_key
   and s.scope = 'adjustment'
   and s.is_active
   and s.metadata->>'sync_protocol' = 'adjustment-v1'
  where (
    select count(*)
    from public.employee_attendance_records r
    where r.source_id = s.id
      and r.kind = 'adjustment'
      and r.raw_values->>'google_row' = m.google_row::text
      and r.raw_values->>'source_slot' = m.source_slot
  ) <> 1;
  if v_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_identity_hash_repair_physical_slot_mismatch',
      detail = format('invalid_mappings=%s', v_count);
  end if;

  -- Fail closed unless every business row is still the verified, fully rekeyed
  -- record and its hash is either already canonical or exactly the stale hash
  -- produced from the former UUID and the current business values.
  select count(*) into v_count
  from pg_temp.adjustment_identity_hash_repair_map m
  join public.attendance_sheet_sources s
    on s.source_key = m.source_key
   and s.scope = 'adjustment'
   and s.is_active
   and s.metadata->>'sync_protocol' = 'adjustment-v1'
  join public.employee_attendance_records r
    on r.source_id = s.id
   and r.kind = 'adjustment'
   and r.raw_values->>'google_row' = m.google_row::text
   and r.raw_values->>'source_slot' = m.source_slot
  cross join lateral (
    select
      pg_catalog.md5(pg_catalog.concat_ws(
        '|',
        r.external_id::text,
        r.sync_revision::text,
        coalesce(r.raw_values->>'source_slot', ''),
        r.event_date::text,
        r.employee_no_raw,
        r.employee_name_raw,
        r.amount::text,
        r.reason,
        r.note
      )) as canonical_hash,
      pg_catalog.md5(pg_catalog.concat_ws(
        '|',
        m.old_external_id::text,
        r.sync_revision::text,
        coalesce(r.raw_values->>'source_slot', ''),
        r.event_date::text,
        r.employee_no_raw,
        r.employee_name_raw,
        r.amount::text,
        r.reason,
        r.note
      )) as stale_hash
  ) hashes
  where r.employee_no_raw is distinct from m.employee_no
     or r.raw_values->>'sync_protocol' is distinct from 'adjustment-v1'
     or r.external_id is distinct from m.new_external_id
     or r.source_item_key is distinct from m.new_external_id::text
     or r.raw_values->>'external_id' is distinct from m.new_external_id::text
     or (
       r.content_hash is distinct from hashes.canonical_hash
       and r.content_hash is distinct from hashes.stale_hash
     );
  if v_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_identity_hash_repair_precondition_failed',
      detail = format('invalid_mappings=%s', v_count);
  end if;

  -- employee_attendance_records has a broad BEFORE UPDATE identity guard.
  -- Snapshot every non-hash column so this migration also proves that no trigger
  -- side effect changed business data, match state or any business timestamp.
  insert into pg_temp.adjustment_identity_hash_repair_before (
    record_id,
    row_without_content_hash
  )
  select r.id, to_jsonb(r) - 'content_hash'
  from pg_temp.adjustment_identity_hash_repair_map m
  join public.attendance_sheet_sources s
    on s.source_key = m.source_key
   and s.scope = 'adjustment'
   and s.is_active
   and s.metadata->>'sync_protocol' = 'adjustment-v1'
  join public.employee_attendance_records r
    on r.source_id = s.id
   and r.kind = 'adjustment'
   and r.raw_values->>'google_row' = m.google_row::text
   and r.raw_values->>'source_slot' = m.source_slot;

  select count(*) into v_count
  from pg_temp.adjustment_identity_hash_repair_before;
  if v_count <> 25 then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_identity_hash_repair_snapshot_count_invalid',
      detail = format('expected=25 actual=%s', v_count);
  end if;

  update public.employee_attendance_records r
  set content_hash = pg_catalog.md5(pg_catalog.concat_ws(
        '|',
        r.external_id::text,
        r.sync_revision::text,
        coalesce(r.raw_values->>'source_slot', ''),
        r.event_date::text,
        r.employee_no_raw,
        r.employee_name_raw,
        r.amount::text,
        r.reason,
        r.note
      ))
  from pg_temp.adjustment_identity_hash_repair_map m
  join public.attendance_sheet_sources s
    on s.source_key = m.source_key
   and s.scope = 'adjustment'
   and s.is_active
   and s.metadata->>'sync_protocol' = 'adjustment-v1'
  where r.source_id = s.id
    and r.kind = 'adjustment'
    and r.raw_values->>'sync_protocol' = 'adjustment-v1'
    and r.raw_values->>'google_row' = m.google_row::text
    and r.raw_values->>'source_slot' = m.source_slot
    and r.employee_no_raw = m.employee_no
    and r.external_id = m.new_external_id
    and r.source_item_key = m.new_external_id::text
    and r.raw_values->>'external_id' = m.new_external_id::text
    and r.content_hash is distinct from pg_catalog.md5(pg_catalog.concat_ws(
          '|',
          r.external_id::text,
          r.sync_revision::text,
          coalesce(r.raw_values->>'source_slot', ''),
          r.event_date::text,
          r.employee_no_raw,
          r.employee_name_raw,
          r.amount::text,
          r.reason,
          r.note
        ));

  get diagnostics v_updated = row_count;
  if v_updated < 0 or v_updated > 25 then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_identity_hash_repair_update_count_invalid',
      detail = format('updated=%s', v_updated);
  end if;

  select count(*) into v_count
  from pg_temp.adjustment_identity_hash_repair_map m
  join public.attendance_sheet_sources s
    on s.source_key = m.source_key
   and s.scope = 'adjustment'
   and s.is_active
   and s.metadata->>'sync_protocol' = 'adjustment-v1'
  join public.employee_attendance_records r
    on r.source_id = s.id
   and r.kind = 'adjustment'
   and r.raw_values->>'sync_protocol' = 'adjustment-v1'
   and r.raw_values->>'google_row' = m.google_row::text
   and r.raw_values->>'source_slot' = m.source_slot
   and r.employee_no_raw = m.employee_no
   and r.external_id = m.new_external_id
   and r.source_item_key = m.new_external_id::text
   and r.raw_values->>'external_id' = m.new_external_id::text
   and r.content_hash = pg_catalog.md5(pg_catalog.concat_ws(
         '|',
         r.external_id::text,
         r.sync_revision::text,
         coalesce(r.raw_values->>'source_slot', ''),
         r.event_date::text,
         r.employee_no_raw,
         r.employee_name_raw,
         r.amount::text,
         r.reason,
         r.note
       ));
  if v_count <> 25 then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_identity_hash_repair_final_alignment_failed',
      detail = format('expected=25 actual=%s updated=%s', v_count, v_updated);
  end if;

  select count(*) into v_count
  from pg_temp.adjustment_identity_hash_repair_before before_row
  join public.employee_attendance_records r
    on r.id = before_row.record_id
  where (to_jsonb(r) - 'content_hash') = before_row.row_without_content_hash;
  if v_count <> 25 then
    raise exception using
      errcode = 'P0001',
      message = 'adjustment_identity_hash_repair_non_hash_column_changed',
      detail = format('expected=25 unchanged=%s', v_count);
  end if;
end
$repair$;

commit;
