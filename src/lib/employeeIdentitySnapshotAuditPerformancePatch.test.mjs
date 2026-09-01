import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [migration, pendingPatch, phaseA] = await Promise.all([
  readFile(
    new URL(
      '../../supabase/migrations/20260901170900_optimize_confirmed_identity_snapshot_audits.sql',
      import.meta.url,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      '../../supabase/migrations/20260901170500_patch_confirmed_identity_pending_departures.sql',
      import.meta.url,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      '../../supabase/migrations/20260901170000_reconcile_confirmed_employee_identity_merges.sql',
      import.meta.url,
    ),
    'utf8',
  ),
])

function tagged(source, name) {
  const marker = `$${name}$`
  const start = source.indexOf(marker)
  const end = source.indexOf(marker, start + marker.length)
  assert.notEqual(start, -1, `missing ${name} start marker`)
  assert.notEqual(end, -1, `missing ${name} end marker`)
  return source.slice(start + marker.length, end)
}

test('snapshot-audit optimization targets the exact deployed patch text', () => {
  for (const [optimizedOld, deployedNew] of [
    ['old_missing', 'new_missing'],
    ['old_expected', 'new_expected'],
    ['old_pending_assertion', 'new_pending_assertion'],
    ['old_home_assertion', 'new_home_assertion'],
  ]) {
    assert.equal(
      tagged(migration, optimizedOld),
      tagged(pendingPatch, deployedNew),
      `${optimizedOld} no longer matches the deployed pending-departure patch`,
    )
  }

  const oldUnapproved = tagged(migration, 'old_unapproved')
  assert.equal(phaseA.split(oldUnapproved).length - 1, 1)
  assert.match(oldUnapproved, /unapproved_schedule_only_identity_remains/)
})

test('missing-current audit resolves and groups the home snapshot once', () => {
  const snippet = tagged(migration, 'new_missing')

  assert.match(snippet, /with resolved_home as materialized/)
  assert.match(snippet, /home_evidence as materialized/)
  assert.match(snippet, /group by resolved\.employee_id/)
  assert.match(snippet, /left join home_evidence evidence/)
  assert.match(snippet, /coalesce\(evidence\.source_count, 0\) = 1/)
  assert.match(snippet, /evidence\.all_explicitly_resigned/)
  assert.match(snippet, /evidence\.all_valid_resign_date/)
  assert.equal(
    snippet.match(/resolve_confirmed_employee_id\(/g)?.length,
    1,
  )
  assert.doesNotMatch(
    snippet,
    /from public\.employees employee[\s\S]+select count\(\*\)[\s\S]+jsonb_array_elements/,
  )
})

test('schedule-only audit uses one canonical map per current snapshot', () => {
  const snippet = tagged(migration, 'new_unapproved')

  assert.match(snippet, /with resolved_home as materialized/)
  assert.match(snippet, /home_employee_ids as materialized/)
  assert.match(snippet, /resolved_schedule as materialized/)
  assert.match(snippet, /home_snapshot\.run_id = v_latest_run_id/)
  assert.match(snippet, /schedule_snapshot\.run_id = v_latest_run_id/)
  assert.equal(
    snippet.match(/resolve_confirmed_employee_id\(/g)?.length,
    2,
  )
  assert.doesNotMatch(
    snippet,
    /from resolved_schedule schedule[\s\S]+jsonb_array_elements/,
  )
})

test('final headcount expectation joins grouped exact home evidence', () => {
  const snippet = tagged(migration, 'new_expected')

  assert.match(snippet, /resolved_current_home as materialized/)
  assert.match(snippet, /current_home_evidence as materialized/)
  assert.match(snippet, /home\.source_count = 1/)
  assert.match(snippet, /home_snapshot\.run_id = v_latest_run_id/)
  assert.equal(
    snippet.match(/resolve_confirmed_employee_id\(/g)?.length,
    1,
  )
  assert.doesNotMatch(snippet, /where \(\s*select count\(\*\) = 1/)
})

test('both visible issue assertions compare set-based canonical evidence', () => {
  const pending = tagged(migration, 'new_pending_assertion')
  const homeOnly = tagged(migration, 'new_home_assertion')

  for (const snippet of [pending, homeOnly]) {
    assert.match(snippet, /with resolved_home as materialized/)
    assert.match(snippet, /home_evidence as materialized/)
    assert.match(snippet, /schedule_employee_ids as materialized/)
    assert.match(snippet, /evidence\.source_count = 1/)
    assert.match(snippet, /select \* from actual except select \* from expected/)
    assert.match(snippet, /select \* from expected except select \* from actual/)
    assert.equal(
      snippet.match(/resolve_confirmed_employee_id\(/g)?.length,
      2,
    )
    assert.doesNotMatch(snippet, /exact_home_snapshot|exact_home_item/)
  }

  assert.match(pending, /home\.resign_date is not null/)
  assert.match(pending, /source_explicitly_resigned/)
  assert.match(homeOnly, /not home\.explicitly_resigned/)
  assert.match(homeOnly, /active_home_employee_not_yet_scheduled/)
})

test('function replacement remains fail closed and metadata preserving', () => {
  assert.match(migration, /confirmed_identity_snapshot_audit_marker_changed/)
  assert.match(migration, /confirmed_identity_snapshot_audit_patch_partial/)
  assert.match(migration, /confirmed_identity_snapshot_audit_patch_verify_failed/)
  assert.match(migration, /procedure\.proacl/)
  assert.match(migration, /procedure\.proowner/)
  assert.match(migration, /procedure\.prosecdef/)
  assert.match(migration, /procedure\.proconfig/)
  assert.match(migration, /procedure\.provolatile/)
  assert.match(migration, /procedure\.proparallel/)
  assert.match(migration, /procedure\.proleakproof/)
  assert.match(migration, /v_comment_after is distinct from v_comment_before/)
  assert.doesNotMatch(migration, /\b(?:grant|revoke)\b/i)
  assert.match(migration, /set local lock_timeout = '2s'/)
  assert.match(migration, /set local statement_timeout = '20s'/)
})
