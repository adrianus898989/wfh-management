import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../../supabase/migrations/20260828103500_optimize_admin_home_dashboard.sql', import.meta.url), 'utf8')
const edge = await readFile(new URL('../../supabase/functions/admin-accounts/index.ts', import.meta.url), 'utf8')
const page = await readFile(new URL('../pages/PortalPage.jsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../styles-pro.css', import.meta.url), 'utf8')

const between = (value, start, end) => {
  const from = value.indexOf(start)
  const to = value.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `missing section ${start}`)
  return value.slice(from, to)
}

test('admin home resolves session, permission and employee scope once in a bounded RPC', () => {
  const dashboardFunction = between(
    migration,
    'create or replace function public.admin_home_dashboard()',
    'revoke all on function public.admin_home_dashboard()',
  )
  assert.match(migration, /create or replace function public\.admin_home_dashboard\(\)/i)
  assert.match(dashboardFunction, /session_private\.current_app_session_is_valid\('admin'\)/)
  assert.match(dashboardFunction, /join public\.roles role[\s\S]*role\.active = true/)
  assert.match(dashboardFunction, /role_permissions[\s\S]*user_permission_overrides[\s\S]*effective_permissions/)
  assert.match(dashboardFunction, /'dashboard\.view' = any\(v_permissions\)/)
  assert.doesNotMatch(dashboardFunction, /public\.has_permission\(/)
  assert.equal((dashboardFunction.match(/public\.admin_scope_effective_employee_ids\(v_user_id\)/g) || []).length, 1)
  assert.match(migration, /scope_ids as materialized/)
  assert.match(migration, /scoped_employees as materialized/)
  assert.match(migration, /limit 8/)
  assert.match(migration, /limit 6/)
  assert.match(migration, /set statement_timeout = '5s'/)
  assert.match(migration, /revoke all on function public\.admin_home_dashboard\(\)[\s\S]*from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.admin_home_dashboard\(\)[\s\S]*to authenticated, service_role/)
})

test('movement uses current hire truth plus evidence-backed historical lifecycle rows', () => {
  assert.match(migration, /public\.employee_master_normalize_id\(event\.employee_no\)/)
  assert.match(migration, /global_alias_candidates as materialized[\s\S]*employee_identity_rekeys/)
  assert.match(migration, /global_aliases as materialized[\s\S]*having count\(distinct candidate\.employee_id\) = 1/)
  assert.match(migration, /scope_aliases as materialized[\s\S]*join scope_ids scope/)
  assert.match(migration, /lifecycle_base as materialized[\s\S]*event\.event_type in \('join', 'resign'\)/)
  assert.doesNotMatch(between(migration, 'lifecycle_base as materialized', 'canonical_resign_events as materialized'), /'reactivate'/)
  assert.match(migration, /canonical_resign_events as materialized[\s\S]*snapshot_resign is not null[\s\S]*snapshot_backend in[\s\S]*auto_reconciled/)
  assert.match(migration, /current_hires as materialized[\s\S]*employee\.hire_date/)
  assert.match(migration, /historical_join_ranked as materialized[\s\S]*not exists[\s\S]*scoped_employees/)
  assert.match(migration, /historical_hires as materialized[\s\S]*canonical_resign_events[\s\S]*snapshot_hire = event\.snapshot_resign/)
  assert.match(migration, /current_resign_fallback as materialized[\s\S]*employee\.resign_date/)
  assert.match(migration, /movement_events as materialized[\s\S]*canonical_hires[\s\S]*canonical_resigns/)
  assert.match(migration, /'movement_quality'[\s\S]*'ambiguous_hires_excluded'[\s\S]*'resign_rows_not_counted_including_duplicates'[\s\S]*'counts_raw_rows', false/)
  assert.match(migration, /note is distinct from '__VOIDED__'/)
  assert.match(between(migration, 'movement as materialized', 'team_distribution as materialized'), /movement_events/)
})

test('online presence has a lightweight user-JWT database guard', () => {
  assert.match(migration, /create or replace function public\.admin_online_presence_allowed\(\)/)
  assert.match(migration, /current_app_session_is_valid\('admin'\)/)
  assert.match(migration, /join public\.roles role[\s\S]*role\.active = true/)
  assert.match(migration, /public\.has_permission\('backend_account\.view'\)[\s\S]*public\.has_permission\('staff_account\.view'\)[\s\S]*public\.has_permission\('employee\.directory\.view'\)/)
  assert.match(migration, /revoke all on function public\.admin_online_presence_allowed\(\)/)
})

test('dashboard Edge action no longer loads or serializes the employee directory', () => {
  const action = between(edge, "if (action === 'dashboard')", "if (action === 'company_assets')")
  assert.match(action, /userClient[\s\S]*\.rpc\('admin_home_dashboard'\)/)
  assert.doesNotMatch(action, /getScopedEmployees|getScopeContext|getAllEmployeeRows/)
  assert.doesNotMatch(action, /from\('user_access'\)|employees\.map|employeeWithoutSensitiveContact/)
})

test('dashboard UI accepts bounded aggregates without fabricating missing lifecycle counts', () => {
  assert.match(page, /const serverSummary = data\?\.summary \|\| null/)
  assert.match(page, /serverDistributions\?\.teams/)
  assert.match(page, /Array\.isArray\(data\?\.movement\) \? data\.movement/)
  assert.match(page, /Array\.isArray\(data\?\.recent_hires\) \? data\.recent_hires/)
  assert.match(page, /view\.hires30 == null \? '—'/)
  assert.match(page, /view\.resignations30 == null \? '—'/)
  assert.match(page, /e\?\.team_name \|\| e\?\.teams\?\.name/)
})

test('dashboard current employee KPI excludes resignation history', () => {
  const kpis = between(page, '<div className="kpi-grid kpi-grid-pro dashboard-kpi-grid">', '</div>')
  assert.match(kpis, /label=\{adminT\('当前在职员工'\)\}[\s\S]*value=\{loading \? '—' : view\.active\}/)
  assert.match(kpis, /只计算当前在职员工，不包含历史离职档案/)
  assert.doesNotMatch(kpis, /value=\{loading \? '—' : view\.total\}/)
})

test('dashboard refresh is visible-only, low-frequency and coalesced', () => {
  assert.match(page, /DASHBOARD_REFRESH_MS = 5 \* 60 \* 1000/)
  assert.match(page, /if \(dashboardFlightRef\.current\) return dashboardFlightRef\.current/)
  assert.match(page, /document\.visibilityState !== 'visible'/)
  assert.match(page, /if \(completedSuccessfully\) dashboardLastCompletedRef\.current = Date\.now\(\)/)
  assert.match(page, /window\.setInterval\(refreshWhenDue, DASHBOARD_REFRESH_MS\)/)
  assert.match(page, /window\.clearInterval\(interval\)/)
  assert.match(page, /document\.removeEventListener\('visibilitychange', refreshWhenDue\)/)
})

test('movement legend stays inside the chart instead of overlapping the card header', () => {
  assert.match(styles, /\.movement-legend\{position:absolute;right:8px;top:3px/)
  assert.doesNotMatch(styles, /\.movement-legend\{[^}]*top:-39px/)
})
