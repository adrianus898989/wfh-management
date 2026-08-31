import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const component = fs.readFileSync(new URL('../components/AdminAlertCenter.jsx', import.meta.url), 'utf8')
const styles = fs.readFileSync(new URL('../styles-admin-alerts.css', import.meta.url), 'utf8')
const migration = fs.readFileSync(
  new URL('../../supabase/migrations/20260831110500_admin_alert_professional_search.sql', import.meta.url),
  'utf8',
)

test('warning center exposes independent employee and warning filters', () => {
  assert.match(component, /employee_no:''[\s\S]{0,100}employee_name:''[\s\S]{0,100}team:''[\s\S]{0,100}search:''/)
  assert.match(component, /draft\.employee_no[\s\S]{0,300}employee_no:event\.target\.value/)
  assert.match(component, /draft\.employee_name[\s\S]{0,300}employee_name:event\.target\.value/)
  assert.match(component, /draft\.team[\s\S]{0,300}team:event\.target\.value/)
  assert.match(component, /Warning keyword[^]*预警关键词/)
  assert.match(component, /admin-alert-identity-filters[^]*admin-alert-warning-filters/)
  assert.match(styles, /admin-alert-identity-filters[^}]*grid-template-columns:repeat\(3/)
})

test('warning filters remain server-side, scoped and bounded', () => {
  assert.match(migration, /p_filters->>'employee_no'/)
  assert.match(migration, /p_filters->>'employee_name'/)
  assert.match(migration, /p_filters->>'team'/)
  assert.match(migration, /current_directory as materialized \([\s\S]*scope_private\.current_employee_scope_directory\(\) directory/)
  assert.match(migration, /current_directory\.employee_id = alert\.employee_id/)
  assert.match(migration, /left join current_directory directory/)
  assert.match(migration, /alter function alerts_private\.admin_alert_center_page_fast[\s\S]+statement_timeout = '3s'/)
  assert.match(migration, /revoke all on function alerts_private\.admin_alert_center_page_fast[\s\S]+authenticated, service_role/)
  assert.match(migration, /admin_alert_public_scope_wrapper_changed/)
  assert.doesNotMatch(component, /\.in\([^\n]*employee/)
})

test('reset and active-summary actions clear all identity filters', () => {
  assert.match(component, /const reset = \(\) => \{[\s\S]{0,120}const next = emptyFilters\(\)/)
  assert.match(component, /const showActive = [\s\S]{0,160}\{ \.\.\.emptyFilters\(\), unread_only:unreadOnly \}/)
})
