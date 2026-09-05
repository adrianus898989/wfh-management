import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL(
  '../../supabase/migrations/20260905183000_exclude_protected_missing_attendance_from_alerts.sql',
  import.meta.url,
), 'utf8');
const acceptance = await readFile(new URL(
  '../../supabase/tests/cs000673_consecutive_rest_resolution.sql',
  import.meta.url,
), 'utf8');

test('protected annual omissions stay stored but are marked as absent from the latest snapshot', () => {
  const protectedCopy = migration.match(
    /v_protected_row_new text := \$new\$([\s\S]*?)\$new\$;/,
  )?.[1] ?? '';

  assert.match(protectedCopy, /'sync_presence', 'protected_missing'/);
  assert.match(protectedCopy, /'sync_protected_missing_snapshot_hash', v_snapshot_hash/);
  assert.match(protectedCopy, /from public\.employee_attendance_records r/);
  assert.match(protectedCopy, /pg_catalog\.md5\([\s\S]*?v_snapshot_hash/);
  assert.doesNotMatch(protectedCopy, /delete from public\.employee_attendance_records/);
});

test('the current snapshot is replayed once so already-retained production rows receive the marker', () => {
  const fastPath = migration.match(
    /v_fast_path_new text := \$new\$([\s\S]*?)\$new\$;/,
  )?.[1] ?? '';
  const sourceRead = migration.match(
    /v_source_read_new text := \$new\$([\s\S]*?)\$new\$;/,
  )?.[1] ?? '';

  assert.match(sourceRead, /metadata->>'protected_missing_tagged_hash'/);
  assert.match(fastPath, /v_source_key = 'home_ph_annual_2026_09'/);
  assert.match(fastPath, /v_protected_tagged_hash is distinct from v_snapshot_hash/);
  assert.match(migration, /'protected_missing_tagged_hash',v_snapshot_hash/);
});

test('attendance alert candidates and evidence ignore protected missing rows', () => {
  const currentEvidencePredicate =
    /record\.raw_values->>'sync_presence' is distinct from 'protected_missing'/g;
  const occurrences = migration.match(currentEvidencePredicate) ?? [];

  // Candidate days, monthly source classification, and detail enrichment all
  // use the same current-snapshot predicate.
  assert.equal(occurrences.length >= 3, true);
  assert.match(migration, /v_refresh_days_new[\s\S]*?sync_presence/);
  assert.match(migration, /v_source_evidence_new[\s\S]*?sync_presence/);
  assert.match(migration, /v_enrich_new[\s\S]*?sync_presence/);
});

test('existing destructive-sync and alert-refresh safety boundaries remain required', () => {
  assert.match(migration, /empty_snapshot_requires_manual_override/);
  assert.match(migration, /annual_snapshot_deletes_are_count_preserving_moves/);
  assert.match(migration, /v_source_key <> ''home_ph_annual_2026_09''/);
  assert.match(migration, /where v_group <> ''access_exam''/);
  assert.match(migration, /alerts_private\.enrich_attendance_alert_details\(\)/);
  assert.match(
    migration,
    /revoke all on function attendance_private\.ingest_annual_attendance_snapshot\(jsonb\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function attendance_private\.ingest_annual_attendance_snapshot\(jsonb\)[\s\S]*to service_role/,
  );
});

test('the confirmed CS000673 stale row and warning are corrected narrowly', () => {
  assert.match(migration, /employee\.employee_no = 'CS000673'/);
  assert.match(migration, /record\.event_date = date '2026-09-06'/);
  assert.match(migration, /source\.source_key = 'home_ph_annual_2026_09'/);
  assert.match(
    migration,
    /record\.raw_values->>'sync_presence' is distinct from 'protected_missing'/,
  );
  assert.match(migration, /if v_updated <> 1 then/);
  assert.doesNotMatch(migration, /and source\.content_hash =/);
  assert.doesNotMatch(migration, /and record\.content_hash =/);
  assert.doesNotMatch(migration, /set[\s\S]*?synced_at = pg_catalog\.clock_timestamp\(\)/);
  assert.doesNotMatch(migration, /select alerts_private\.refresh_alert_group\('attendance'\)/);
  assert.match(migration, /update public\.admin_alert_events alert/);
  assert.match(migration, /alert\.window_start = date '2026-09-05'/);
  assert.match(migration, /alert\.window_end = date '2026-09-06'/);
  assert.match(migration, /set is_active = false/);
});

test('read-only acceptance verifies current day, retained history, and resolved warning', () => {
  assert.match(acceptance, /employee_no\)\) = 'CS000673'/);
  assert.match(acceptance, /event_date = date '2026-09-05'/);
  assert.match(acceptance, /event_date = date '2026-09-06'/);
  assert.match(acceptance, /sync_presence' = 'protected_missing'/);
  assert.match(acceptance, /alert\.alert_type = 'consecutive_rest'/);
  assert.match(acceptance, /alert\.is_active/);
  assert.doesNotMatch(acceptance, /\b(insert|update|delete|truncate)\b/i);
});
