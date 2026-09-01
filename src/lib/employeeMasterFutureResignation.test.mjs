import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL(
  '../../supabase/migrations/20260901115900_employee_master_future_resignation_effective_date.sql',
  import.meta.url,
), 'utf8')

test('future resignation date is not an effective resignation before the captured day', () => {
  assert.match(
    migration,
    /when nullif\(item->>'resign_date', ''\)::date is not null then\s+nullif\(item->>'resign_date', ''\)::date <=\s+\(v_captured_at at time zone 'Asia\/Manila'\)::date/,
  )
  assert.match(
    migration,
    /else public\.employee_master_has_explicit_resignation_marker\(item->>'backend_accounts'\)/,
  )
})

test('same-hash shortcut reconciles only a dated lifecycle state mismatch', () => {
  const replacementStart = migration.indexOf('v_new_same_hash text := $new$')
  const replacementEnd = migration.indexOf('$new$;', replacementStart)
  const replacement = migration.slice(replacementStart, replacementEnd)

  assert.match(replacement, /and not exists \(/)
  assert.match(replacement, /jsonb_array_elements\(v_home_rows\)/)
  assert.match(
    replacement,
    /resignation\.effective_date >\s+\(v_captured_at at time zone 'Asia\/Manila'\)::date/,
  )
  assert.match(replacement, /employee\.status is distinct from 'active'/)
  assert.match(replacement, /employee\.resign_date is not null/)
  assert.match(
    replacement,
    /resignation\.effective_date <=\s+\(v_captured_at at time zone 'Asia\/Manila'\)::date/,
  )
  assert.match(replacement, /employee\.status is distinct from 'resigned'/)
  assert.match(
    replacement,
    /employee\.resign_date is distinct from\s+resignation\.effective_date/,
  )
})

test('patch is fail-closed, idempotent, and preserves private function privileges', () => {
  assert.match(migration, /employee_master_future_resignation_patch_partial/)
  assert.match(migration, /employee_master_same_hash_marker_not_unique/)
  assert.match(migration, /employee_master_resignation_flag_marker_not_unique/)
  assert.match(migration, /employee_master_future_resignation_patch_failed/)
  assert.match(
    migration,
    /revoke all on function[\s\S]+ingest_employee_master_snapshot_validated_v1\(jsonb\)[\s\S]+from public, anon, authenticated, service_role/,
  )
})
