import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  canonicalizeConfirmedPresentEmployeeNos,
  prepareConfirmedResignationItems,
  resolveConfirmedResignationItems,
} from '../../supabase/functions/admin-employee-stats/confirmedIdentity.js'

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

test('people statistics separate future hires from effective active headcount and keep tenure drill-down aligned', async () => {
  const source = await readFile(
    new URL('../../supabase/functions/admin-employee-stats/index.ts', import.meta.url),
    'utf8',
  )

  assert.match(source, /function isActiveEmploymentStatus[\s\S]*value===["']active["']\|\|value===["']probation["']/)
  assert.match(source, /function isEffectiveActiveEmployee[\s\S]*if\(!hireDate\) return true;[\s\S]*hireDate<=today/)
  assert.match(source, /function isFutureHireEmployee[\s\S]*hireDate>today/)
  assert.match(source, /const active=all\.filter\(\(x:any\)=>isEffectiveActiveEmployee\(x,today\)\)/)
  assert.match(source, /const futureHires=all\.filter\(\(x:any\)=>isFutureHireEmployee\(x,today\)\)/)
  assert.match(source, /future_hires:futureHires\.length/)
  assert.match(source, /timeZone:["']Asia\/Manila["']/)
  assert.match(source, /const today=manilaToday\(\)/)
  assert.doesNotMatch(source, /body\.today/)

  const tenureDetails = source.slice(
    source.indexOf('if(text(body.action)==="tenure_details")'),
    source.indexOf('const all=await allEmployees(service,organization);'),
  )
  assert.match(tenureDetails, /isTenureEmployee\(x,today\)&&tenureKey\(x\.hire_date,today\)===bucket/)
  assert.match(source, /const tenureEmployees=\[\.\.\.active,\.\.\.futureHires\]/)
  assert.match(source, /share:ratio\(tenureCounts\[key\]\|\|0,tenureEmployees\.length\)/)
  assert.doesNotMatch(source, /all\.filter\(\(x:any\)=>x\.status===["']active["']\)/)
})

test('active analytics details use the same effective-date employment boundary', async () => {
  const source = await readFile(
    new URL('../../supabase/functions/admin-employees/index.ts', import.meta.url),
    'utf8',
  )
  const activeDetails = source.slice(
    source.indexOf('if(eventType==="active")'),
    source.indexOf('const rawEvents=await fetchRecentLifecycleEvents', source.indexOf('if(eventType==="active")')),
  )

  assert.match(source, /function isAnalyticsActiveStatus[\s\S]*value===["']active["']\|\|value===["']probation["']/)
  assert.match(source, /function isAnalyticsEffectiveActiveEmployee[\s\S]*if\(!hireDate\)return true;[\s\S]*hireDate<=today/)
  assert.match(source, /function isAnalyticsFutureHireEmployee[\s\S]*hireDate>today/)
  assert.match(activeDetails, /futureHireDetails=tenureBucket===["']prepare["']/)
  assert.match(activeDetails, /if\(futureHireDetails\)[\s\S]*isAnalyticsFutureHireEmployee\(emp,today\)[\s\S]*else if\(!isAnalyticsEffectiveActiveEmployee\(emp,today\)\)continue/)
  assert.doesNotMatch(activeDetails, /text\(emp\.status\)!==["']active["']/)

  const analytics = source.slice(
    source.indexOf('if (action === "analytics")'),
    source.indexOf('if (action === "analytics_event_details")'),
  )
  assert.match(analytics, /activeRows=employees\.filter\(\(x:any\)=>isAnalyticsEffectiveActiveEmployee\(x,today\)\)/)
  assert.doesNotMatch(analytics, /activeRows=employees\.filter\(\(x:any\)=>x\.status===["']active["']\)/)
})

test('confirmed aliases canonicalize the production presence set before destructive comparison', () => {
  const result = canonicalizeConfirmedPresentEmployeeNos(
    ['OLD-001', 'LIVE002', 'UNKNOWN', 'old001'],
    [
      {
        raw_employee_no: 'OLD-001',
        raw_identity_key: 'OLD001',
        employee_id: '11111111-1111-1111-1111-111111111111',
        canonical_employee_no: 'NEW001',
        confirmed_full_name: '员工甲',
        is_confirmed_alias: true,
      },
      {
        raw_employee_no: 'LIVE002',
        raw_identity_key: 'LIVE002',
        employee_id: '22222222-2222-2222-2222-222222222222',
        canonical_employee_no: 'LIVE002',
        confirmed_full_name: null,
        is_confirmed_alias: false,
      },
      {
        raw_employee_no: 'UNKNOWN',
        raw_identity_key: 'UNKNOWN',
        employee_id: null,
        canonical_employee_no: null,
        confirmed_full_name: null,
        is_confirmed_alias: false,
      },
    ],
  )

  assert.deepEqual([...result.presentEmployeeNos].sort(), ['LIVE002', 'NEW001', 'UNKNOWN'])
  assert.equal(result.presentEmployeeNos.has('OLD-001'), false)
  assert.deepEqual(result.conflicts, [])
})

test('presence reconciliation fails closed on an unresolved confirmed alias or incomplete resolver output', () => {
  const aliasConflict = canonicalizeConfirmedPresentEmployeeNos(['OLD001'], [{
    raw_employee_no: 'OLD001',
    raw_identity_key: 'OLD001',
    employee_id: null,
    canonical_employee_no: null,
    confirmed_full_name: '员工甲',
    is_confirmed_alias: true,
  }])
  assert.deepEqual(aliasConflict.conflicts, [{
    rawEmployeeNo: 'OLD001',
    reason: 'confirmed_alias_conflict',
  }])
  assert.equal(aliasConflict.presentEmployeeNos.size, 0)

  const incomplete = canonicalizeConfirmedPresentEmployeeNos(['LIVE001'], [])
  assert.deepEqual(incomplete.conflicts, [{
    rawEmployeeNo: 'LIVE001',
    reason: 'missing_resolution',
  }])
})

test('resignation aliases resolve by reservation and validate a supplied name', () => {
  const rows = [{
    raw_employee_no: 'OLD-001',
    raw_identity_key: 'OLD001',
    employee_id: '11111111-1111-1111-1111-111111111111',
    canonical_employee_no: 'NEW001',
    confirmed_full_name: 'Amy（小 美）',
    is_confirmed_alias: true,
  }]
  const matched = resolveConfirmedResignationItems([{
    employee_no: 'old001',
    employee_name: ' Amy 小美 ',
    resign_date: '2026-09-01',
  }], rows)

  assert.equal(matched.conflicts.length, 0)
  assert.equal(matched.missing.length, 0)
  assert.deepEqual(matched.resolved.map((item) => ({
    employeeId: item.employeeId,
    canonicalEmployeeNo: item.canonicalEmployeeNo,
    sourceEmployeeNo: item.sourceEmployeeNo,
    isConfirmedAlias: item.isConfirmedAlias,
  })), [{
    employeeId: '11111111-1111-1111-1111-111111111111',
    canonicalEmployeeNo: 'NEW001',
    sourceEmployeeNo: 'OLD001',
    isConfirmedAlias: true,
  }])

  const mismatch = resolveConfirmedResignationItems([{
    employee_no: 'OLD001',
    employee_name: '另一人',
  }], rows)
  assert.equal(mismatch.resolved.length, 0)
  assert.equal(mismatch.conflicts[0].reason, 'confirmed_alias_name_mismatch')

  const missingName = resolveConfirmedResignationItems([{
    employee_no: 'OLD001',
  }], rows)
  assert.equal(missingName.conflicts.length, 0)
  assert.equal(missingName.missing.length, 0)
  assert.deepEqual(missingName.resolved.map((item) => item.employeeId), [
    '11111111-1111-1111-1111-111111111111',
  ])
})

test('resignation writes deduplicate one canonical date and reject conflicting dates', () => {
  const base = {
    employeeId: '11111111-1111-1111-1111-111111111111',
    canonicalEmployeeNo: 'NEW001',
  }
  const sameDate = prepareConfirmedResignationItems([
    {...base,sourceEmployeeNo:'OLD001',isConfirmedAlias:true,item:{resign_date:'2026-09-01'}},
    {...base,sourceEmployeeNo:'NEW001',isConfirmedAlias:false,item:{resign_date:'2026-09-01'}},
  ])
  assert.equal(sameDate.conflicts.length, 0)
  assert.equal(sameDate.items.length, 1)

  const differentDates = prepareConfirmedResignationItems([
    {...base,sourceEmployeeNo:'OLD001',isConfirmedAlias:true,item:{resign_date:'2026-09-01'}},
    {...base,sourceEmployeeNo:'NEW001',isConfirmedAlias:false,item:{resign_date:'2026-09-02'}},
  ])
  assert.equal(differentDates.items.length, 0)
  assert.deepEqual(differentDates.conflicts, [{
    employeeId:base.employeeId,
    canonicalEmployeeNo:'NEW001',
    resignDates:['2026-09-01','2026-09-02'],
    sourceEmployeeNos:['NEW001','OLD001'],
  }])
})

test('automatic presence and resignation ingress use the service-only confirmed-identity boundary', async () => {
  const [edge, migration] = await Promise.all([
    readFile(
      new URL('../../supabase/functions/admin-employee-stats/index.ts', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../../supabase/migrations/20260901170000_reconcile_confirmed_employee_identity_merges.sql', import.meta.url),
      'utf8',
    ),
  ])

  assert.match(migration, /create or replace function public\.resolve_employee_identity_batch\(\s*p_employee_nos text\[\]/i)
  assert.match(migration, /revoke all on function public\.resolve_employee_identity_batch\(text\[\]\)[\s\S]*?from public, anon, authenticated/i)
  assert.match(migration, /grant execute on function public\.resolve_employee_identity_batch\(text\[\]\)[\s\S]*?to service_role/i)

  assert.match(edge, /rpc\(["']resolve_employee_identity_batch["']/)
  const presence = edge.slice(
    edge.indexOf('async function reconcileProductionPresence'),
    edge.indexOf('async function productionSyncSnapshot'),
  )
  assert.ok(
    presence.indexOf('canonicalizeConfirmedPresentEmployeeNos')
      < presence.indexOf('const missing=candidates.filter'),
  )
  assert.match(presence, /confirmed_employee_identity_conflict[\s\S]*retryable:true/)

  const compatiblePresence = edge.slice(
    edge.indexOf('async function reconcileSheetPresence'),
    edge.indexOf('function lifecycleSourcePriority'),
  )
  assert.ok(
    compatiblePresence.indexOf('canonicalizeConfirmedPresentEmployeeNos')
      < compatiblePresence.indexOf('const missing=candidates.filter'),
  )
  assert.match(compatiblePresence, /if\(mode===["']production["']\)[\s\S]*confirmed_employee_identity_conflict[\s\S]*retryable:true/)

  const bankPresence = edge.slice(
    edge.indexOf('async function reconcileBankPresence'),
    edge.indexOf('Deno.serve'),
  )
  assert.ok(
    bankPresence.indexOf('canonicalizeConfirmedPresentEmployeeNos')
      < bankPresence.indexOf('const missing:string[]'),
  )
  assert.match(bankPresence, /confirmed_employee_identity_conflict[\s\S]*retryable:true/)

  const resignations = edge.slice(
    edge.indexOf('async function syncResignEvents'),
    edge.indexOf('async function reconcileProductionPresence'),
  )
  assert.match(resignations, /resolveConfirmedResignationItems/)
  assert.match(resignations, /confirmed_employee_alias_name_conflict[\s\S]*retryable:true/)
  assert.match(resignations, /employee_identity_not_ready[\s\S]*retryable:true/)
  assert.match(resignations, /prepareConfirmedResignationItems[\s\S]*conflicting_resignation_dates[\s\S]*retryable:true/)
  assert.match(resignations, /\.in\(["']id["'],employeeIds\.slice/)
  assert.doesNotMatch(resignations, /\.in\(["']employee_no["'],nos\.slice/)
  assert.match(resignations, /source_employee_no:resolvedItem\.sourceEmployeeNo/)
})

test('future-hire tenure details are not labeled as current employees', async () => {
  const page = await readFile(
    new URL('../pages/AdminEmployeesPage.jsx', import.meta.url),
    'utf8',
  )
  assert.match(page, /const detailTitle=bucket===['"]prepare['"]\?`\$\{label\} · 待入职员工`:`\$\{label\} · 在职员工`/)
  assert.match(page, /title:detailTitle/)
})
