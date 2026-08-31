import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL(
  '../../supabase/migrations/20260831130000_employee_master_scope_rebuild_coalescing.sql',
  import.meta.url,
), 'utf8')

test('employee-master scope coalescing is fail-closed against the deployed wrapper and trigger shape', () => {
  assert.match(migration, /employee_master_scope_coalescing_prerequisite_missing/)
  assert.match(migration, /ingest_employee_master_snapshot_validated_v1/)
  assert.match(migration, /employee-master-dual-source-sync/)
  assert.match(migration, /scope_private\.skip_next_directory_sync/)
  assert.match(migration, /AFTER UPDATE OF employee_no/)
  assert.match(migration, /employee_master_scope_update_trigger_shape_changed/)
})

test('employee update scope requests only fire for real identity, team, or position changes', () => {
  assert.match(migration, /referencing old table as old_employee_scope_rows[\s\S]+new table as new_employee_scope_rows/i)
  assert.match(migration, /old_row\.employee_no is distinct from new_row\.employee_no/)
  assert.match(migration, /old_row\.team_id is distinct from new_row\.team_id/)
  assert.match(migration, /old_row\.position_id is distinct from new_row\.position_id/)
  assert.match(migration, /if v_scope_input_changed then[\s\S]+request_all_assigned_employee_scope_rebuild/)
})

test('atomic ingest defers repeated requests and performs no more than one changed-input rebuild', () => {
  const wrapperStart = migration.indexOf(
    'create function public.ingest_employee_master_snapshot(p_payload jsonb)',
  )
  const wrapperEnd = migration.indexOf(
    'revoke all on function public.ingest_employee_master_snapshot(jsonb)',
    wrapperStart,
  )
  const wrapper = migration.slice(wrapperStart, wrapperEnd)

  assert.match(wrapper, /pg_advisory_xact_lock[\s\S]+employee-master-dual-source-sync/)
  assert.match(wrapper, /assigned_employee_scope_input_fingerprint\(\)/)
  assert.match(wrapper, /defer_assigned_scope_rebuild', 'on'/)
  assert.match(wrapper, /assigned_scope_rebuild_dirty', 'off'/)
  assert.match(wrapper, /if v_dirty[\s\S]+v_before_fingerprint is distinct from v_after_fingerprint/)
  assert.equal(
    wrapper.match(/perform scope_private\.rebuild_all_assigned_employee_scopes\(\);/g)?.length,
    1,
  )
  assert.match(wrapper, /return v_result;/)
  assert.match(wrapper, /exception when others[\s\S]+raise;/)
})

test('scope input fingerprint covers direct employees and the canonical roster mapping', () => {
  assert.match(migration, /from public\.employees employee/)
  assert.match(migration, /employee\.employee_no/)
  assert.match(migration, /employee\.team_id/)
  assert.match(migration, /employee\.position_id/)
  assert.match(migration, /scope_private\.current_employee_scope_directory\(\) directory/)
  assert.match(migration, /directory\.current_team_id/)
  assert.match(migration, /directory\.current_position_id/)
})

test('new helpers and the renamed ingest body remain private while service role keeps only the public entrypoint', () => {
  assert.match(
    migration,
    /revoke all on function[\s\S]+request_all_assigned_employee_scope_rebuild\(\)[\s\S]+from public, anon, authenticated, service_role/,
  )
  assert.match(
    migration,
    /revoke all on function[\s\S]+assigned_employee_scope_input_fingerprint\(\)[\s\S]+from public, anon, authenticated, service_role/,
  )
  assert.match(
    migration,
    /revoke all on function[\s\S]+ingest_employee_master_snapshot_scope_coalesce_inner_v1\(jsonb\)[\s\S]+from public, anon, authenticated, service_role/,
  )
  assert.match(
    migration,
    /grant execute on function public\.ingest_employee_master_snapshot\(jsonb\)[\s\S]+to service_role/,
  )
})
