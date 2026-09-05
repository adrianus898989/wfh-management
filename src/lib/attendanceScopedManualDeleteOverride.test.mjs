import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL(
  '../../supabase/migrations/20260901124150_attendance_scoped_manual_delete_override.sql',
  import.meta.url,
), 'utf8');
const refreshMigration = await readFile(new URL(
  '../../supabase/migrations/20260901131500_refresh_home_ph_sep_reviewed_snapshot.sql',
  import.meta.url,
), 'utf8');
const protectedMergeMigration = await readFile(new URL(
  '../../supabase/migrations/20260905130600_preserve_home_ph_missing_rows_during_sync.sql',
  import.meta.url,
), 'utf8');

const reviewedGuard = migration.match(/v_guard_new text := \$new\$([\s\S]*?)\$new\$;/)?.[1] ?? '';
const emptyGuard = migration.match(/v_empty_new text := \$new\$([\s\S]*?)\$new\$;/)?.[1] ?? '';

test('large-delete authorization is pinned to one audited source and transition', () => {
  assert.match(reviewedGuard, /v_trigger_kind='manual'/);
  assert.match(reviewedGuard, /v_allow_large_delete/);
  assert.match(reviewedGuard, /v_source_key='home_ph_annual_2026_09'/);
  assert.match(reviewedGuard, /527f340c6cf16ab44dc76005f1148882380b84dd29e462441178d68c225b1071/);
  assert.match(reviewedGuard, /f6da820efa127e92d99bf0240380ef334e5007b093429d5ba1f30683ddf01126/);
});

test('database recomputes and checks every reviewed count before deletion', () => {
  assert.match(reviewedGuard, /v_expected_delete_count=9/);
  assert.match(reviewedGuard, /v_expected_delete_count=v_deleted/);
  assert.match(reviewedGuard, /v_expected_read_row_count=720/);
  assert.match(reviewedGuard, /v_expected_read_row_count=v_read_row_count/);
  assert.match(reviewedGuard, /v_expected_canonical_record_count=295/);
  assert.match(reviewedGuard, /v_expected_canonical_record_count=v_payload_row_count/);
  assert.match(reviewedGuard, /v_expected_parse_warning_count=7/);
});

test('empty snapshots and broad manual overrides remain blocked', () => {
  assert.match(emptyGuard, /v_payload_row_count=0 and v_read_row_count=0 then/);
  assert.doesNotMatch(emptyGuard, /allow_large_delete/);
  assert.match(reviewedGuard, /v_payload_row_count>0/);
  assert.match(reviewedGuard, /v_read_row_count>0/);
  assert.doesNotMatch(reviewedGuard, /not \(v_trigger_kind='manual' and v_allow_large_delete\)/);
});

test('ingest remains private and service-role only', () => {
  assert.match(
    migration,
    /revoke all on function attendance_private\.ingest_annual_attendance_snapshot\(jsonb\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function attendance_private\.ingest_annual_attendance_snapshot\(jsonb\)[\s\S]*to service_role/,
  );
});

test('follow-up migration replaces only the re-audited target hash and read count', () => {
  assert.match(refreshMigration, /f6da820efa127e92d99bf0240380ef334e5007b093429d5ba1f30683ddf01126/);
  assert.match(refreshMigration, /9390bd569f7eeaeb0f563d1598a05159db3f334d0af53c0944a6ff7a59bee651/);
  assert.match(refreshMigration, /v_old_hash_count <> 1/);
  assert.match(refreshMigration, /v_old_read_count <> 1/);
  assert.match(refreshMigration, /v_expected_read_row_count\\s\*=\\s\*720/);
  assert.match(refreshMigration, /v_expected_read_row_count = 721/);
});

test('follow-up migration preserves the remaining reviewed boundary and privileges', () => {
  assert.match(refreshMigration, /527f340c6cf16ab44dc76005f1148882380b84dd29e462441178d68c225b1071/);
  assert.match(refreshMigration, /v_expected_delete_count\\s\*=\\s\*9/);
  assert.match(refreshMigration, /v_expected_canonical_record_count\\s\*=\\s\*295/);
  assert.match(refreshMigration, /v_expected_parse_warning_count\\s\*=\\s\*7/);
  assert.match(
    refreshMigration,
    /revoke all on function attendance_private\.ingest_annual_attendance_snapshot\(jsonb\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    refreshMigration,
    /grant execute on function attendance_private\.ingest_annual_attendance_snapshot\(jsonb\)[\s\S]*to service_role/,
  );
});

test('Home-PH September can merge valid rows while unreviewed omissions stay stored', () => {
  assert.match(protectedMergeMigration, /v_source_key <> 'home_ph_annual_2026_09'/);
  assert.match(
    protectedMergeMigration,
    /insert into attendance_private\.attendance_sheet_sync_stage[\s\S]*from public\.employee_attendance_records/,
  );
  assert.match(protectedMergeMigration, /v_protected_delete_count := v_deleted/);
  assert.match(protectedMergeMigration, /v_deleted := 0/);
  assert.match(protectedMergeMigration, /'protected_deletes',v_protected_delete_count/);
  assert.match(protectedMergeMigration, /'protected_delete_count',v_protected_delete_count/);
});

test('protected merge remains fail closed outside the exact source and for empty snapshots', () => {
  assert.match(
    protectedMergeMigration,
    /if v_source_key <> 'home_ph_annual_2026_09' then\s+raise exception 'large_delete_requires_manual_override'/,
  );
  assert.match(protectedMergeMigration, /empty_snapshot_requires_manual_override/);
  assert.match(protectedMergeMigration, /v_deleted <= 5/);
  assert.match(protectedMergeMigration, /annual_snapshot_deletes_are_count_preserving_moves/);
  assert.match(protectedMergeMigration, /v_expected_delete_count=v_deleted/);
  assert.match(
    protectedMergeMigration,
    /revoke all on function attendance_private\.ingest_annual_attendance_snapshot\(jsonb\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    protectedMergeMigration,
    /grant execute on function attendance_private\.ingest_annual_attendance_snapshot\(jsonb\)[\s\S]*to service_role/,
  );
});
