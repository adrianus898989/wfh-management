import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL(
  '../../supabase/migrations/20260831123000_attendance_count_preserving_date_corrections.sql',
  import.meta.url,
), 'utf8');

test('annual attendance only permits bounded count-preserving date moves', () => {
  assert.match(migration, /v_deleted <= 5/);
  assert.match(migration, /v_payload_row_count >= v_existing_record_count/);
  assert.match(
    migration,
    /annual_snapshot_deletes_are_count_preserving_moves\(\s*v_source_id,\s*v_run_id\s*\)/,
  );
  assert.match(
    migration,
    /coalesce\(staged\.record_count, 0\) < existing\.record_count/,
  );
  assert.match(migration, /raise exception 'large_delete_requires_manual_override'/);
});

test('count preservation is scoped by employee, source block, and event kind', () => {
  assert.match(migration, /record\.source_block/);
  assert.match(migration, /record\.event_kind/);
  assert.match(migration, /as employee_key/);
  assert.match(migration, /staged\.source_block = existing\.source_block/);
  assert.match(migration, /staged\.event_kind = existing\.event_kind/);
  assert.match(migration, /staged\.employee_key = existing\.employee_key/);
});

test('failed sync diagnostics retain proposed and deletion counts after rollback', () => {
  assert.match(migration, /raw_record_count=v_payload_row_count/);
  assert.match(migration, /canonical_record_count=v_payload_row_count/);
  assert.match(migration, /deleted_count=v_deleted/);
});

test('private helper and ingest remain closed to browser roles', () => {
  assert.match(migration, /returns boolean\s+language sql\s+volatile\s+security invoker/);
  assert.match(
    migration,
    /revoke all on function attendance_private\.annual_snapshot_deletes_are_count_preserving_moves\(uuid, uuid\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /revoke all on function attendance_private\.ingest_annual_attendance_snapshot\(jsonb\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function attendance_private\.ingest_annual_attendance_snapshot\(jsonb\)[\s\S]*to service_role/,
  );
});
