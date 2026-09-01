import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [migration, phaseA, phaseB] = await Promise.all([
  readFile(
    new URL(
      '../../supabase/migrations/20260901170800_optimize_confirmed_employee_identity_resolver.sql',
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
  readFile(
    new URL(
      '../../supabase/migrations/20260901171000_apply_confirmed_employee_identity_reconciliation.sql',
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

test('resolver performance patch is ordered after Phase A and before Phase B', () => {
  assert.ok('20260901170000' < '20260901170800')
  assert.ok('20260901170800' < '20260901171000')
  assert.match(phaseA, /create or replace function employee_private\.resolve_confirmed_employee_id/)
  assert.match(phaseB, /apply_confirmed_employee_identity_reconciliation\(\)/)
})

test('patch replaces the exact deployed resolver markers once', () => {
  const employeeOld = tagged('employee_join_old')
  const employeeNew = tagged('employee_join_new')
  const ledgerOld = tagged('ledger_join_old')
  const ledgerNew = tagged('ledger_join_new')

  assert.equal(phaseA.split(employeeOld).length - 1, 1)
  assert.equal(phaseA.split(ledgerOld).length - 1, 1)
  assert.doesNotMatch(phaseA, new RegExp(employeeNew.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(phaseA, new RegExp(ledgerNew.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(migration, /confirmed_employee_identity_resolver_performance_marker_changed/)
  assert.match(migration, /confirmed_employee_identity_resolver_performance_patch_partial/)
  assert.match(
    migration,
    /pg_catalog\.length\(v_after_definition\)[\s\S]+pg_catalog\.replace\(\s*v_after_definition, v_ledger_join_old, ''[\s\S]+pg_catalog\.length\(v_ledger_join_old\) <> 1/,
  )
})

test('both candidate branches expose their partial-index predicates', () => {
  const employeeNew = tagged('employee_join_new')
  const ledgerNew = tagged('ledger_join_new')

  assert.match(
    employeeNew,
    /on regexp_replace\([\s\S]+upper\(btrim\(employee\.employee_no\)\)[\s\S]+\) = requested\.employee_key/,
  )
  assert.match(
    employeeNew,
    /nullif\([\s\S]+regexp_replace\([\s\S]+employee\.employee_no[\s\S]+\),[\s\S]+''[\s\S]+\) is not null/,
  )
  assert.match(
    ledgerNew,
    /employee_identity_key\([\s\S]+ledger\.previous_employee_no[\s\S]+\) <> ''/,
  )
  assert.match(migration, /employees_employee_no_normalized_unique_idx/)
  assert.match(migration, /employee_identity_merge_ledger_previous_identity_key_uidx/)
  assert.match(migration, /index_row\.indisvalid/)
  assert.match(migration, /index_row\.indisready/)
  assert.match(migration, /index_row\.indisunique/)
  assert.match(migration, /pg_get_expr\([\s\S]+index_row\.indexprs/)
  assert.match(migration, /pg_get_expr\([\s\S]+index_row\.indpred/)
  assert.match(
    migration,
    /regexp_replace\(upper\(btrim\(employee_no\)\), ''\[\^A-Z0-9\]''::text, ''''::text, ''g''::text\)/,
  )
  assert.match(
    migration,
    /\(NULLIF\(regexp_replace\(upper\(btrim\(employee_no\)\), ''\[\^A-Z0-9\]''::text, ''''::text, ''g''::text\), ''''::text\) IS NOT NULL\)/,
  )
  assert.match(
    migration,
    /employee_private\.employee_identity_key\(previous_employee_no\)/,
  )
  assert.match(
    migration,
    /\(employee_private\.employee_identity_key\(previous_employee_no\) <> ''''::text\)/,
  )
  assert.doesNotMatch(migration, /pg_get_expr\([\s\S]{0,160}\)\s+like\b/i)
})

test('patch preserves resolver metadata, ACL, and sampled results', () => {
  for (const property of [
    'proacl',
    'proowner',
    'prosecdef',
    'proconfig',
    'provolatile',
    'proparallel',
    'proleakproof',
    'prokind',
    'prorettype',
  ]) {
    assert.match(migration, new RegExp(`procedure\\.${property}`))
  }

  assert.match(migration, /v_acl_after is distinct from v_acl_before/)
  assert.match(migration, /v_owner_after is distinct from v_owner_before/)
  assert.match(migration, /v_probe_after is distinct from v_probe_before/)
  assert.match(migration, /confirmed_employee_identity_resolver_probe_semantics_changed/)
  assert.match(migration, /pg_catalog\.aclexplode\(/)
  assert.match(migration, /privilege\.grantee = 0/)
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const checks = migration.match(
      new RegExp(`has_function_privilege\\(\\s*'${role}'`, 'g'),
    )
    assert.equal(checks?.length, 2, `${role} must be checked before and after`)
  }
  assert.match(
    migration,
    /confirmed_employee_identity_resolver_preflight_execute_boundary_changed/,
  )
  assert.match(
    migration,
    /confirmed_employee_identity_resolver_postflight_execute_boundary_changed/,
  )
  assert.doesNotMatch(migration, /\b(?:grant|revoke)\b/i)
  assert.match(migration, /set local lock_timeout = '2s'/)
  assert.match(migration, /set local statement_timeout = '20s'/)
})
