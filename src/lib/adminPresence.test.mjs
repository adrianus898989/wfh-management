import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const component = await readFile(new URL('../components/AdminTopbar.jsx', import.meta.url), 'utf8')
const layout = await readFile(new URL('../components/AppLayout.jsx', import.meta.url), 'utf8')
const baseStyles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
const topbarStyles = await readFile(new URL('../styles-admin-topbar.css', import.meta.url), 'utf8')
const endpoint = await readFile(new URL('../../supabase/functions/admin-accounts/index.ts', import.meta.url), 'utf8')

test('global admin header owns account, alert bell and scoped online lists', () => {
  assert.match(layout, /<AdminTopbar access=\{adminAccess\}/)
  assert.doesNotMatch(layout, /sidebar-brand[\s\S]{0,300}<AdminAlertBell/)
  assert.match(component, /后台在线/)
  assert.match(component, /员工在线/)
  assert.match(component, /<AdminAlertBell access=\{access\}/)
  assert.match(component, /loginUsername/)
})

test('online status reuses the existing low-frequency application lease', () => {
  assert.match(endpoint, /action === 'online_presence'/)
  assert.match(endpoint, /from\('app_session_leases'\)[\s\S]+\.gt\('lease_expires_at', nowIso\)/)
  assert.match(endpoint, /can\('backend_account\.view'\)[\s\S]+can\('staff_account\.view'\)[\s\S]+can\('employee\.directory\.view'\)/)
  assert.match(component, /PERMISSIONS\.BACKEND_ACCOUNT_VIEW[\s\S]+PERMISSIONS\.STAFF_ACCOUNT_VIEW[\s\S]+PERMISSIONS\.EMPLOYEE_DIRECTORY_VIEW/)
  assert.doesNotMatch(component, /\['account\.view', 'user\.view', 'employee\.view'\]/)
  assert.doesNotMatch(endpoint, /last_sign_in_at/)
  assert.match(component, /setInterval\(refresh, 60000\)/)
  assert.match(component, /连续 5 分钟没有心跳即显示离线/)
})

test('online presence scopes only live employees without loading the full account directory', () => {
  const start = endpoint.indexOf("if (action === 'online_presence')")
  const end = endpoint.indexOf("if (action === 'dashboard')", start)
  const source = endpoint.slice(start, end)
  assert.match(source, /loadEffectiveEmployeeScope\(/)
  assert.match(source, /presenceScope\.mode === 'all'/)
  assert.doesNotMatch(source, /getScopeContext\(/)
  assert.doesNotMatch(source, /getAllEmployeeRows\(/)
  assert.doesNotMatch(source, /admin_scope_current_employee_directory/)
})

test('admin presence controls remain visible while the page content scrolls', () => {
  assert.match(layout, /mode==='admin'\?'admin-shell':'staff-shell'/)
  assert.match(baseStyles, /\.admin-shell\{height:100vh;min-height:0;overflow:hidden\}/)
  assert.match(baseStyles, /\.admin-shell>\.main\{height:100vh;min-height:0;overflow:auto\}/)
  assert.match(topbarStyles, /\.admin-global-topbar\{position:sticky;top:0;z-index:70/)
})
