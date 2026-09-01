import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [migration, phaseA] = await Promise.all([
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

function tagged(name) {
  const marker = `$${name}$`
  const start = migration.indexOf(marker)
  const end = migration.indexOf(marker, start + marker.length)
  assert.notEqual(start, -1, `missing ${name} start marker`)
  assert.notEqual(end, -1, `missing ${name} end marker`)
  return migration.slice(start + marker.length, end)
}

test('pending-departure patch targets the exact deployed Phase-A markers', () => {
  const oldMissing = tagged('old_missing')
  const oldExpected = tagged('old_expected')
  const oldIssueRebuild = tagged('old_issue_rebuild')
  const oldPendingAssertion = tagged('old_pending_assertion')
  const oldHomeAssertion = tagged('old_home_assertion')
  const oldWarningAssertion = tagged('old_warning_assertion')
  const oldWarningTotal = tagged('old_warning_total')

  assert.equal(phaseA.split(oldMissing).length - 1, 1)
  assert.equal(phaseA.split(oldExpected).length - 1, 1)
  assert.equal(phaseA.split(oldIssueRebuild).length - 1, 1)
  assert.equal(phaseA.split(oldPendingAssertion).length - 1, 1)
  assert.equal(phaseA.split(oldHomeAssertion).length - 1, 1)
  assert.equal(phaseA.split(oldWarningAssertion).length - 1, 1)
  assert.equal(phaseA.split(oldWarningTotal).length - 1, 1)
  assert.match(migration, /pg_catalog\.pg_get_functiondef\(procedure\.oid\)/)
  assert.match(migration, /confirmed_identity_pending_departure_marker_changed/)
  assert.match(migration, /confirmed_identity_pending_departure_patch_partial/)
  assert.match(migration, /confirmed_identity_pending_departure_patch_verify_failed/)
})

test('missing-from-both exception requires one explicit resigned row from the exact current run', () => {
  const missing = tagged('new_missing')

  assert.match(missing, /select count\(\*\) = 1[\s\S]+bool_and\(coalesce\(/)
  assert.match(missing, /home_snapshot\.source_key = 'home_employee_roster_current'/)
  assert.match(missing, /home_snapshot\.run_id = v_latest_run_id/)
  assert.match(missing, /\(home_item->>'explicitly_resigned'\)::boolean/)
  assert.match(missing, /home_item->>'resign_date'[\s\S]+\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/)
  assert.match(missing, /resolve_confirmed_employee_id\([\s\S]+home_item->>'employee_id'[\s\S]+\) = employee\.id/)
  assert.doesNotMatch(missing, /schedule_present|source_type\s*=\s*'schedule_only'/)
})

test('final employee-only expectation is data-driven by exact current home evidence', () => {
  const expected = tagged('new_expected')

  assert.match(expected, /select effective\.employee_no, 'employee_only'::text/)
  assert.match(expected, /from effective_active effective/)
  assert.match(expected, /select count\(\*\) = 1/)
  assert.match(expected, /home_snapshot\.source_key = 'home_employee_roster_current'/)
  assert.match(expected, /home_snapshot\.run_id = v_latest_run_id/)
  assert.match(expected, /resolve_confirmed_employee_id\([\s\S]+home_item->>'employee_id'[\s\S]+\) = employee\.id/)
  assert.match(expected, /not exists \([\s\S]+from schedule[\s\S]+schedule\.employee_no = effective\.employee_no/)
  assert.doesNotMatch(expected, /'schedule_only'|CS001449|WD001217|WD001753/)
})

test('live discrepancy issues preserve home-only and resigned-profile evidence', () => {
  const rebuild = tagged('new_issue_rebuild')
  const pending = tagged('new_pending_assertion')
  const homeOnly = tagged('new_home_assertion')

  assert.match(rebuild, /insert into public\.employee_master_sync_issues[\s\S]+home_only_missing_schedule/)
  assert.match(rebuild, /active_home_employee_not_yet_scheduled/)
  assert.match(rebuild, /await_schedule_assignment/)
  assert.match(rebuild, /insert into public\.employee_master_sync_issues[\s\S]+pending_manual_review/)
  assert.match(rebuild, /home_source_resigned_profile_still_active/)
  assert.match(rebuild, /future_resignation_removed_from_schedule_early/)
  assert.match(rebuild, /review_schedule_until_resignation_effective_date/)
  assert.match(rebuild, /confirm_employee_status_or_restore_home_source/)
  assert.match(rebuild, /'resign_date', candidate\.resign_date/)
  assert.match(rebuild, /candidate\.resign_date is not null/)
  assert.match(rebuild, /source_explicitly_resigned/)
  assert.match(rebuild, /count\(\*\) over \(partition by employee\.id\) source_count/)
  assert.match(rebuild, /candidate\.source_count = 1/g)
  assert.match(rebuild, /not candidate\.explicitly_resigned/)
  assert.match(rebuild, /and candidate\.explicitly_resigned/)
  assert.doesNotMatch(rebuild, /CS001449|WD001217|WD001753/)

  for (const exactSet of [pending, homeOnly]) {
    assert.match(exactSet, /home_snapshot\.run_id = v_latest_run_id/)
    assert.match(exactSet, /resolve_confirmed_employee_id\([\s\S]+\) = employee\.id/)
    assert.match(exactSet, /select \* from actual except select \* from expected/)
    assert.match(exactSet, /select \* from expected except select \* from actual/)
  }
  assert.doesNotMatch(pending, /issue\.details->>'reason'\s*=/)
  assert.doesNotMatch(homeOnly, /issue\.details->>'reason'\s*=/)
  assert.match(pending, /issue\.details->>'resign_date' resign_date/)
  assert.match(pending, /when \(home_item->>'resign_date'\)::date >[\s\S]+Asia\/Manila/)
})

test('warning totals are derived from the exact visible issue categories', () => {
  const assertion = tagged('new_warning_assertion')
  const total = tagged('new_warning_total')

  for (const issueCode of [
    'cross_source_name_mismatch',
    'schedule_only_missing_onsite_marker',
    'home_only_missing_schedule',
    'pending_manual_review',
  ]) {
    assert.match(assertion, new RegExp(issueCode))
  }
  assert.doesNotMatch(assertion, /v_remaining_issue_count\s*<>\s*\d+/)
  assert.doesNotMatch(assertion, /v_parse_warning_count\s*<>\s*\d+/)
  assert.match(total, /v_parse_warning_count \+ v_remaining_issue_count/)
  assert.doesNotMatch(total, /warning_count\s*=\s*44/)
})

test('patch preserves the private function privilege and execution boundary', () => {
  assert.match(migration, /procedure\.proacl/)
  assert.match(migration, /procedure\.proowner/)
  assert.match(migration, /procedure\.prosecdef/)
  assert.match(migration, /procedure\.proconfig/)
  assert.match(migration, /v_acl_after is distinct from v_acl_before/)
  assert.match(migration, /v_owner_after is distinct from v_owner_before/)
  assert.match(migration, /v_security_definer_after is distinct from[\s\S]+v_security_definer_before/)
  assert.match(migration, /v_config_after is distinct from v_config_before/)
  assert.match(migration, /v_comment_after is distinct from v_comment_before/)
  assert.match(migration, /confirmed_identity_reconciliation_privilege_boundary_changed/)
  assert.doesNotMatch(migration, /\b(?:grant|revoke)\b/i)
  assert.match(migration, /set local lock_timeout = '2s'/)
  assert.match(migration, /set local statement_timeout = '20s'/)
})
