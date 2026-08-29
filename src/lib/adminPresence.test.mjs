import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  APP_HEARTBEAT_CROSS_TAB_WINDOW_MS,
  runCoalescedAppHeartbeat,
} from './appSessionHeartbeatPressure.js'

const component = await readFile(new URL('../components/AdminTopbar.jsx', import.meta.url), 'utf8')
const layout = await readFile(new URL('../components/AppLayout.jsx', import.meta.url), 'utf8')
const baseStyles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
const topbarStyles = await readFile(new URL('../styles-admin-topbar.css', import.meta.url), 'utf8')
const recoveryEndpoint = await readFile(new URL('../../supabase/functions/admin-accounts/recovery.ts', import.meta.url), 'utf8')
const explicitPresenceMigration = await readFile(new URL('../../supabase/migrations/20260829012000_account_presence_and_role_delegation.sql', import.meta.url), 'utf8')
const alertCenter = await readFile(new URL('../components/AdminAlertCenter.jsx', import.meta.url), 'utf8')
const supabaseClient = await readFile(new URL('./supabase.js', import.meta.url), 'utf8')

test('global admin header owns account, alert bell and scoped online lists', () => {
  assert.match(layout, /<AdminTopbar access=\{adminAccess\}/)
  assert.doesNotMatch(layout, /sidebar-brand[\s\S]{0,300}<AdminAlertBell/)
  assert.match(component, /后台在线/)
  assert.match(component, /员工在线/)
  assert.match(component, /<AdminAlertBell access=\{access\}/)
  assert.match(component, /loginUsername/)
})

test('online status reuses the existing low-frequency application lease', () => {
  assert.match(recoveryEndpoint, /action === 'online_presence'/)
  assert.match(recoveryEndpoint, /userClient[\s\S]*\.rpc\('admin_online_presence_allowed'\)/)
  assert.match(recoveryEndpoint, /from\('app_session_leases'\)[\s\S]+\.gt\('lease_expires_at',nowIso\)/)
  assert.match(recoveryEndpoint, /if \(!can\('account\.online_presence\.view'\)\)/)
  assert.doesNotMatch(recoveryEndpoint.slice(recoveryEndpoint.indexOf("if (action === 'online_presence')"), recoveryEndpoint.indexOf("if (action === 'role_list')")), /can\('backend_account\.view'\)|can\('staff_account\.view'\)|can\('employee\.directory\.view'\)/)
  assert.match(component, /PERMISSIONS\.ACCOUNT_ONLINE_PRESENCE_VIEW/)
  assert.doesNotMatch(component.slice(component.indexOf('const canPresence'), component.indexOf('const canManual')), /PERMISSIONS\.(BACKEND_ACCOUNT_VIEW|STAFF_ACCOUNT_VIEW|EMPLOYEE_DIRECTORY_VIEW)/)
  assert.match(explicitPresenceMigration, /'account\.online_presence\.view'[\s\S]+sensitive[\s\S]+true/)
  assert.match(explicitPresenceMigration, /return public\.has_permission\('account\.online_presence\.view'\)/)
  assert.doesNotMatch(explicitPresenceMigration, /insert into public\.role_permissions/)
  assert.doesNotMatch(component, /\['account\.view', 'user\.view', 'employee\.view'\]/)
  assert.doesNotMatch(recoveryEndpoint, /last_sign_in_at/)
  assert.match(component, /PRESENCE_COUNT_REFRESH_MS = 3 \* 60 \* 1000/)
  assert.match(component, /presencePollDelay\(failureCountRef\.current\)/)
  assert.match(component, /document\.visibilityState !== 'visible'/)
  assert.match(component, /PRESENCE_MAX_BACKOFF_MS/)
  assert.match(component, /人数约每 3 分钟更新；连续 5 分钟没有心跳即显示离线/)
})

test('recovery online presence is count-only without loading an account or employee directory', () => {
  const start = recoveryEndpoint.indexOf("if (action === 'online_presence')")
  const end = recoveryEndpoint.indexOf("if (action === 'role_list')", start)
  const source = recoveryEndpoint.slice(start, end)
  assert.doesNotMatch(source, /loadEffectiveEmployeeScope\(/)
  assert.doesNotMatch(source, /admin_scope_effective_employee_ids/)
  assert.doesNotMatch(source, /getScopeContext\(/)
  assert.doesNotMatch(source, /getAllEmployeeRows\(/)
  assert.doesNotMatch(source, /admin_scope_current_employee_directory/)
  assert.doesNotMatch(source, /user_scope_team_filters|user_scope_position_filters|user_scope_employee_filters/)
  assert.doesNotMatch(source, /from\('employees'\)|from\('user_access'\)/)
  assert.match(source, /select\('user_id', \{ count:'exact', head:true \}\)/)
  assert.match(source, /admin:\{ count:Number\(adminCountResult\.count \|\| 0\), rows:\[\] \}/)
  assert.match(source, /staff:\{ count:Number\(staffCountResult\.count \|\| 0\), rows:\[\] \}/)
  // Production recovery intentionally keeps the header count-only. Opening
  // the popover must not escalate into account/employee directory reads.
  assert.doesNotMatch(component, /include_rows:includeRows|includeRows:true/)
  assert.match(component, /body:\{ action:'online_presence' \}/)
  assert.match(component, /countOnly:data\?\.degraded === true/)
  assert.match(component, /稳定恢复期间仅显示人数/)
  assert.match(component, /flightRef\.current/)
  assert.match(component, /controller\.abort\(\)/)
  assert.match(component, /timeout:12000/)
})

test('alerts remain on demand and cancel/single-flight a closed popover read', () => {
  assert.doesNotMatch(alertCenter, /setInterval\([^\n]*admin_alert_center|setInterval\(load/)
  assert.match(alertCenter, /if \(flightRef\.current\) return flightRef\.current\.promise/)
  assert.match(alertCenter, /query\.abortSignal\(signal\)/)
  assert.match(alertCenter, /if \(!open && flightRef\.current\)/)
  assert.match(alertCenter, /openRef\.current && !document\.hidden/)
})

test('Supabase transient retries are disabled so a timeout cannot multiply statements', () => {
  assert.match(supabaseClient, /db:\{retry:false\}/)
})

test('recurring session heartbeats coalesce across tabs but remain portal isolated', async () => {
  const values = new Map()
  const storage = {
    getItem:key => values.get(key) || null,
    setItem:(key,value) => values.set(key, value),
  }
  let now = 100_000
  let adminCalls = 0
  let staffCalls = 0
  const admin = () => runCoalescedAppHeartbeat({
    portal:'admin', storage, locks:null, now:()=>now,
    run:async()=>{ adminCalls += 1; return {data:{ok:true},error:null} },
  })
  const staff = () => runCoalescedAppHeartbeat({
    portal:'staff', storage, locks:null, now:()=>now,
    run:async()=>{ staffCalls += 1; return {data:{ok:true},error:null} },
  })

  assert.equal((await admin()).data.coalesced, undefined)
  assert.equal((await admin()).data.coalesced, true)
  assert.equal(adminCalls, 1)
  await staff()
  assert.equal(staffCalls, 1)

  now += APP_HEARTBEAT_CROSS_TAB_WINDOW_MS + 1
  await admin()
  assert.equal(adminCalls, 2)
})

test('cross-tab lock serializes simultaneous heartbeat dispatches', async () => {
  const values = new Map()
  const storage = {
    getItem:key => values.get(key) || null,
    setItem:(key,value) => values.set(key, value),
  }
  let tail = Promise.resolve()
  const locks = {
    request(_name, _options, callback) {
      const result = tail.then(callback)
      tail = result.catch(() => {})
      return result
    },
  }
  let calls = 0
  const invoke = () => runCoalescedAppHeartbeat({
    portal:'staff', storage, locks, now:()=>50_000,
    run:async()=>{ calls += 1; await Promise.resolve(); return {data:{ok:true},error:null} },
  })
  const results = await Promise.all([invoke(), invoke(), invoke()])
  assert.equal(calls, 1)
  assert.equal(results.filter(result => result.data.coalesced).length, 2)
})

test('admin presence controls remain visible while the page content scrolls', () => {
  assert.match(layout, /mode==='admin'\?'admin-shell':'staff-shell'/)
  assert.match(baseStyles, /\.admin-shell\{height:100vh;min-height:0;overflow:hidden\}/)
  assert.match(baseStyles, /\.admin-shell>\.main\{height:100vh;min-height:0;overflow:auto\}/)
  assert.match(topbarStyles, /\.admin-global-topbar\{position:sticky;top:0;z-index:70/)
})
