import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL(
  '../../supabase/migrations/20260905091923_reconcile_adjustment_physical_slot_identity.sql',
  import.meta.url,
), 'utf8');

test('adjustment UUID recovery serializes on the physical Google slot', () => {
  assert.match(migration, /pg_catalog\.pg_advisory_xact_lock/);
  assert.match(migration, /adjustment-slot-v1/);
  assert.match(migration, /order by[\s\S]*google_row[\s\S]*source_slot/);
  assert.match(
    migration,
    /employee_attendance_adjustment_physical_slot_unique_idx[\s\S]*create unique index|create unique index[\s\S]*employee_attendance_adjustment_physical_slot_unique_idx/,
  );
});

test('only identical business content can adopt a newer UUID', () => {
  for (const field of [
    'employee_no_raw',
    'employee_name_raw',
    'event_date',
    'amount',
    'note',
    'category',
    'raw_type',
  ]) {
    assert.match(migration, new RegExp(field));
  }
  assert.match(migration, /v_revision > v_slot_record\.sync_revision/);
  assert.match(migration, /set external_id = v_external_id/);
  assert.match(migration, /source_item_key = v_external_id::text/);
  assert.match(migration, /external_id_google_row_mismatch/);
  assert.match(migration, /google_source_slot_identity_conflict/);
});

test('identical stale UUIDs delegate as stale successes', () => {
  assert.match(migration, /\{external_id\}/);
  assert.match(migration, /v_slot_record\.external_id::text/);
  assert.match(migration, /identity_stale_ignored/);
  assert.match(
    migration,
    /ingest_adjustment_sheet_inbound_without_slot_recovery[\s\S]*v_delegate_payload/,
  );
  assert.match(
    migration,
    /update attendance_private\.adjustment_sheet_inbound_requests[\s\S]*set result = v_result/,
  );
});

test('duplicate cleanup is archived and fails closed before delete', () => {
  const archiveAt = migration.indexOf(
    'insert into attendance_private.adjustment_identity_duplicate_archive',
  );
  const deleteAt = migration.indexOf(
    'delete from public.employee_attendance_records',
  );
  assert.ok(archiveAt >= 0);
  assert.ok(deleteAt > archiveAt);
  assert.match(migration, /adjustment_duplicate_business_content_mismatch/);
  assert.match(migration, /adjustment_duplicate_has_outbox_history/);
  assert.match(migration, /record_snapshot jsonb not null/);
  assert.match(migration, /enable row level security/);
});

test('migration has no production record-ID mapping', () => {
  assert.doesNotMatch(
    migration,
    /values\s*\(\s*'adjustment_(?:onsite|home_vim|home_ph)_2026_/,
  );
  assert.doesNotMatch(
    migration,
    /old_external_id\s+uuid\s+not\s+null[\s\S]*new_external_id\s+uuid\s+not\s+null/,
  );
});
