import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const component = await readFile(new URL('../components/AdminTopbar.jsx', import.meta.url), 'utf8')
const layout = await readFile(new URL('../components/AppLayout.jsx', import.meta.url), 'utf8')
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
  assert.match(endpoint, /can\('account\.view'\)[\s\S]+can\('user\.view'\)[\s\S]+can\('employee\.view'\)/)
  assert.doesNotMatch(endpoint, /last_sign_in_at/)
  assert.match(component, /setInterval\(refresh, 60000\)/)
  assert.match(component, /连续 5 分钟没有心跳即显示离线/)
})
