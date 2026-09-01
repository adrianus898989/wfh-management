import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL(
    '../../supabase/migrations/20260901171500_fix_confirmed_identity_source_row_ambiguity.sql',
    import.meta.url,
  ),
  'utf8',
)

test('confirmed identity canonicalizers qualify JSON ordinality source_row', () => {
  assert.match(
    migration,
    /refresh_schedule_report_snapshot_after_master_sync\(\)/,
  )
  assert.match(migration, /ingest_schedule_roster_snapshot\(jsonb\)/)
  assert.match(migration, /order by source\.source_row/)
  assert.match(migration, /v_old_count <> 1/)
  assert.match(migration, /with ordinality source\(item, source_row\)/)
  assert.match(migration, /employee_identity_merge_ledger ledger/)
  assert.match(migration, /public\.employees canonical/)
})

test('source_row hotfix preserves function security and ACL metadata', () => {
  assert.match(migration, /procedure\.proowner is distinct from v_owner/)
  assert.match(migration, /procedure\.proacl is distinct from v_acl/)
  assert.match(
    migration,
    /procedure\.prosecdef is distinct from v_security_definer/,
  )
  assert.match(migration, /procedure\.proconfig is distinct from v_config/)
  assert.match(migration, /source_row_patch_invalid/)
})
