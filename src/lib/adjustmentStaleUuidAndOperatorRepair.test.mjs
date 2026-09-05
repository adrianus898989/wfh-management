import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL(
  '../../supabase/migrations/20260905134500_adjustment_stale_uuid_retry_and_operator_repair.sql',
  import.meta.url,
), 'utf8');

test('older or equal unknown UUIDs become non-mutating stale successes', () => {
  assert.match(migration, /v_revision <= v_slot_record\.sync_revision/);
  assert.match(
    migration,
    /v_revision <= v_slot_record\.sync_revision[\s\S]*?jsonb_set\([\s\S]*?'\{external_id\}'[\s\S]*?v_slot_record\.external_id::text/,
  );
  assert.match(migration, /identity_stale_short_circuited/);
  assert.match(
    migration,
    /pg_catalog\.pg_advisory_xact_lock[\s\S]*?adjustment-slot-v1/,
  );
  assert.match(
    migration,
    /ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut/,
  );
});

test('newer business mismatches still flow through strict recovery', () => {
  const staleGuard = migration.indexOf(
    'v_revision <= v_slot_record.sync_revision',
  );
  const strictDelegate = migration.indexOf(
    'public.ingest_adjustment_sheet_inbound_without_stale_uuid_shortcut',
    staleGuard,
  );
  assert.ok(staleGuard >= 0);
  assert.ok(strictDelegate > staleGuard);
  assert.match(migration, /google_source_slot_identity_conflict/);
});

test('operator repair is private, locked, exact and revision-monotonic', () => {
  assert.match(
    migration,
    /attendance_private\.repair_adjustment_slot_from_verified_google/,
  );
  assert.match(migration, /v_slot_count <> 1/);
  assert.match(migration, /v_revision <= v_record\.sync_revision/);
  assert.match(migration, /adjustment_repair_employee_identity_mismatch/);
  assert.match(migration, /pg_catalog\.pg_advisory_xact_lock/);
  assert.match(
    migration,
    /repair_adjustment_slot_from_verified_google\(jsonb\)[\s\S]*?from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function[\s\S]{0,160}repair_adjustment_slot_from_verified_google/,
  );
});

test('operator repair archives before canonical mutation and closes only unfinished old outbox', () => {
  const archiveAt = migration.indexOf(
    'insert into attendance_private.adjustment_identity_repair_archive',
  );
  const canonicalUpdateAt = migration.indexOf(
    'update public.employee_attendance_records record',
    archiveAt,
  );
  assert.ok(archiveAt >= 0);
  assert.ok(canonicalUpdateAt > archiveAt);
  assert.match(migration, /record_snapshot jsonb not null/);
  assert.match(migration, /before update or delete/);
  assert.match(migration, /adjustment_identity_repair_archive_is_immutable/);
  assert.match(
    migration,
    /adjustment_sheet_outbox[\s\S]*?outbox\.external_id = v_record\.external_id[\s\S]*?outbox\.state in \('pending', 'processing', 'failed'\)/,
  );
});

test('operator repair updates all canonical business and UUID projections', () => {
  for (const assignment of [
    'source_item_key = v_external_id::text',
    'event_date = v_event_date',
    'reason = v_category',
    'note = v_note',
    'amount = v_amount',
    'employee_id = v_employee_id',
    'employee_no_raw = v_employee_no',
    'employee_name_raw = v_employee_name',
    "'external_id', v_external_id",
    'external_id = v_external_id',
    "sync_origin = 'google'",
    'sync_revision = v_revision',
  ]) {
    assert.ok(migration.includes(assignment), `missing ${assignment}`);
  }
});

test('migration contains no production source, row or UUID repair mapping', () => {
  assert.doesNotMatch(migration, /adjustment_(?:onsite|home_vim|home_ph)_2026_/);
  assert.doesNotMatch(
    migration,
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  );
});
