import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const edgeFunctions = [
  'admin-employee-stats',
  'admin-employee-operators',
  'admin-employee-risk-list',
  'admin-employee-dates',
  'admin-report-errors',
  'admin-reports',
]

test('employee-facing Edge functions use the canonical current-roster scope', async () => {
  for (const functionName of edgeFunctions) {
    const source = await readFile(
      new URL(`../../supabase/functions/${functionName}/index.ts`, import.meta.url),
      'utf8',
    )
    assert.match(source, /loadEffectiveEmployeeScope/)
    assert.doesNotMatch(source, /from\(['"]user_scope_teams['"]\)/)
  }
})

test('the shared resolver delegates scope decisions to the database boundary', async () => {
  const source = await readFile(
    new URL('../../supabase/functions/_shared/employeeScope.ts', import.meta.url),
    'utf8',
  )
  assert.match(source, /admin_scope_effective_employee_ids/)
  assert.match(source, /SCOPE_RESULT_LIMIT_EXCEEDED/)
  assert.doesNotMatch(source, /from\(['"]employees['"]\).*team_id/s)
})

test('risk list and people analytics use current roster organization after the effective allow-list', async () => {
  const [riskSource, statsSource] = await Promise.all([
    readFile(
      new URL('../../supabase/functions/admin-employee-risk-list/index.ts', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../../supabase/functions/admin-employee-stats/index.ts', import.meta.url),
      'utf8',
    ),
  ])

  for (const source of [riskSource, statsSource]) {
    assert.match(source, /rpc\(['"]admin_scope_current_employee_directory['"]\)/)
    assert.match(source, /scope\.mode\s*===?\s*['"]all['"]/)
    assert.match(source, /new Set\(scope\.employeeIds\s*\|\|\s*\[\]\)/)
    assert.match(source, /resolvedDirectory=?.*filter\(.*teamById\.has\(.*positionById\.has/s)
    assert.match(source, /loadReferenceRows\(service,[\s\S]*?['"]teams['"][\s\S]*?loadReferenceRows\(service,[\s\S]*?['"]positions['"]/)
  }

  const riskEmployeeQuery = riskSource.slice(
    riskSource.indexOf('const buildEmployeeQuery'),
    riskSource.indexOf('const currentEmployees'),
  )
  assert.doesNotMatch(riskEmployeeQuery, /team_id|position_id|teams:team_id|positions:position_id/)
  assert.match(riskSource, /team_id:\s*current\?\.teamId\s*\|\|\s*null/)
  assert.match(riskSource, /position_id:\s*current\?\.positionId\s*\|\|\s*null/)

  const statsEmployeeLoader = statsSource.slice(
    statsSource.indexOf('async function allEmployees'),
    statsSource.indexOf('function splitPlatforms'),
  )
  assert.doesNotMatch(statsEmployeeLoader, /teams:team_id|positions:position_id/)
  assert.match(statsEmployeeLoader, /team_id:current\?\.teamId\|\|null/)
  assert.match(statsEmployeeLoader, /position_id:current\?\.positionId\|\|null/)
})
