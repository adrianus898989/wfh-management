import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const migrationPath = new URL(
  'supabase/migrations/20260903054439_personnel_reconciliation_page.sql',
  `file://${root}/`,
)
const sql = fs.readFileSync(migrationPath, 'utf8')
const matches = pattern => [...sql.matchAll(pattern)].length

test('personnel reconciliation is a fail-closed, founder-seeded sensitive permission', () => {
  assert.match(sql, /'employee\.reconciliation\.view',[\s\S]*?'employee',[\s\S]*?true/)
  assert.match(sql, /role\.code\s*=\s*'founder'/)
  assert.doesNotMatch(sql, /source_permission\.code\s*=\s*'alert\./)
  assert.match(sql, /session_private\.current_app_session_is_valid\('admin'\)/)
  assert.match(sql, /public\.has_permission\('employee\.reconciliation\.view'\)/)
  assert.match(sql, /access\.active\s*=\s*true[\s\S]*?access\.backend_enabled\s*=\s*true[\s\S]*?role\.active\s*=\s*true/)
})

test('security definer RPC has bounded execution, exact ACLs and scoped rows', () => {
  assert.match(sql, /create or replace function public\.admin_personnel_reconciliation\(/)
  assert.match(sql, /stable\s+security definer\s+set search_path\s*=\s*''/)
  assert.match(sql, /set statement_timeout\s*=\s*'6s'/)
  assert.match(sql, /set lock_timeout\s*=\s*'500ms'/)
  assert.match(sql, /public\.admin_scope_effective_employee_ids\(v_user_id\)/)
  assert.match(sql, /v_page_size integer := least\([\s\S]*?50/)
  assert.ok(matches(/page_control as materialized/gi) >= 3)
  assert.ok(matches(/offset \(\(select page from page_control\) - 1\) \* v_page_size/gi) >= 3)
  assert.match(sql, /revoke all on function public\.admin_personnel_reconciliation\([\s\S]*?from public, anon, authenticated, service_role/)
  assert.match(sql, /grant execute on function public\.admin_personnel_reconciliation\([\s\S]*?to authenticated/)
})

test('the RPC selects the latest complete atomic employee snapshot and actual report snapshot', () => {
  assert.match(sql, /run\.status\s*=\s*'success'/)
  assert.match(sql, /home_snapshot\.captured_at\s*=\s*run\.captured_at/)
  assert.match(sql, /schedule_snapshot\.captured_at\s*=\s*run\.captured_at/)
  assert.match(sql, /home_snapshot\.row_count\s*=\s*run\.home_roster_row_count/)
  assert.match(sql, /schedule_snapshot\.row_count\s*=\s*run\.schedule_roster_row_count/)
  assert.match(sql, /order by run\.finished_at desc nulls last,[\s\S]*?run\.captured_at desc,[\s\S]*?run\.id desc[\s\S]*?limit 1/)
  assert.match(sql, /from public\.report_sheet_snapshots snapshot[\s\S]*?snapshot\.source\s*=\s*'居家排班表\/填表'/)
  assert.match(sql, /when nullif\(report\.employee_key, ''\) is not null[\s\S]*?'id:' \|\| report\.employee_key[\s\S]*?'name:' \|\| report\.name_key/)
  assert.ok(matches(/interval '36 hours'/g) >= 3)
})

test('all visible count sets, accepted onsite exclusions and review issues stay explicit', () => {
  for (const key of [
    'dashboard_active',
    'directory_effective_active',
    'directory_total',
    'report_total',
    'headcount_total',
    'issue_total',
    'onsite_total',
  ]) assert.match(sql, new RegExp(`'${key}'`))

  assert.match(sql, /in_employee_page/)
  assert.match(sql, /in_report/)
  assert.match(sql, /in_schedule_source/)
  assert.match(sql, /accepted_onsite_keys as materialized/)
  assert.match(sql, /override\.override_kind in \([\s\S]*?'confirmed_onsite',[\s\S]*?'managed_external'/)
  assert.match(sql, /schedule_backfill_requires_review/)
  assert.match(sql, /report_alias_duplicate_collapsed/)
  assert.doesNotMatch(sql, /WD001787|CS001455|WD001809|ZJ00169|PH526083101|336225/)
  assert.doesNotMatch(sql, /'payload'\s*,/)
})

test('PostgREST schema reload is part of the atomic migration', () => {
  assert.match(sql, /^begin;/)
  assert.match(sql, /notify pgrst, 'reload schema';\s+commit;\s*$/)
})
