import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { requestPortalIpPreflight } from './adminIpPreflight.js'

const source = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8')

const [
  migration,
  app,
  gate,
  loginEdge,
  registrationEdge,
  sessionGuardEdge,
  allowlistEdge,
  allowlistPage,
] = await Promise.all([
  source('../../supabase/migrations/20260829112326_staff_portal_ip_allowlist.sql'),
  source('../App.jsx'),
  source('../components/StaffIpPreflightGate.jsx'),
  source('../../supabase/functions/admin-login/index.ts'),
  source('../../supabase/functions/register-employee/index.ts'),
  source('../../supabase/functions/admin-ip-guard/index.ts'),
  source('../../supabase/functions/admin-ip-allowlist/index.ts'),
  source('../pages/AdminIpAllowlistPage.jsx'),
])

test('staff preflight sends an enum portal and keeps the public response minimal', async () => {
  const result = await requestPortalIpPreflight({
    functions: {
      invoke: async (name, options) => {
        assert.equal(name, 'admin-ip-preflight')
        assert.deepEqual(options.body, { portal: 'staff' })
        return {
          data: { allowed: true, enforced: false, reason: 'enforcement_disabled' },
          error: null,
        }
      },
    },
  }, 'staff')
  assert.deepEqual(result, {
    status: 'allowed',
    allowed: true,
    enforced: false,
    reason: 'enforcement_disabled',
  })
})

test('staff login and activation forms are not mounted before Edge preflight', () => {
  assert.match(app, /path="\/staff\/login"[\s\S]{0,160}?<StaffIpPreflightGate><StaffLoginPage/)
  assert.match(app, /path="\/staff\/register"[\s\S]{0,180}?<StaffIpPreflightGate><StaffRegisterPage/)
  assert.match(gate, /if \(preflight\.status === 'allowed'\) return children/)
  assert.match(gate, /requestPortalIpPreflight\(configured \? supabase : null, 'staff'/)
  assert.match(gate, /当前网络未获准访问员工前端/)
})

test('login, registration, claim and heartbeat recheck staff IP server-side', () => {
  assert.match(loginEdge, /portal_ip_prelogin_check[\s\S]{0,120}?p_portal: mode/)
  assert.match(loginEdge, /mode === 'staff'[\s\S]{0,100}?'staff_ip_session_attest'/)
  assert.match(registrationEdge, /trustedClientIp\(req\)/)
  assert.match(registrationEdge, /portal_ip_prelogin_check[\s\S]{0,100}?p_portal: 'staff'/)
  assert.ok(
    registrationEdge.indexOf("admin.rpc('portal_ip_prelogin_check'")
      < registrationEdge.indexOf("from('employee_activation_codes')"),
  )
  assert.match(sessionGuardEdge, /portal !== 'admin' && portal !== 'staff'/)
  assert.match(sessionGuardEdge, /staff_ip_session_attest/)
  assert.match(sessionGuardEdge, /app_session_claim', \{ p_portal: portal \}/)
  assert.doesNotMatch(sessionGuardEdge, /ip_guard:\s*guard\b/)
  assert.match(sessionGuardEdge, /ip_guard:\s*\{[\s\S]{0,180}?enforced:[\s\S]{0,180}?effective:[\s\S]{0,180}?reason:/)
})

test('migration preserves existing admin scope and never auto-enables staff', () => {
  assert.match(migration, /portal_scope text not null default 'admin'/)
  assert.match(migration, /staff_enforced boolean not null default false/)
  assert.match(migration, /entry\.portal_scope in \('staff', 'both'\)/)
  assert.match(migration, /entry\.portal_scope in \('admin', 'both'\)/)
  assert.doesNotMatch(migration, /update public\.admin_ip_allowlist_entries[\s\S]{0,160}?portal_scope\s*=\s*'staff'/)
  assert.doesNotMatch(migration, /staff_enforced\s*=\s*true/)
})

test('direct Auth bypass cannot produce a usable staff data session', () => {
  assert.match(migration, /create or replace function session_private\.current_app_session_is_valid/)
  assert.match(migration, /lease\.portal <> 'staff'[\s\S]{0,180}?current_staff_ip_attestation_is_valid/)
  assert.match(migration, /create or replace function session_private\.app_session_claim[\s\S]*?ip_check_required/)
  assert.match(migration, /create or replace function session_private\.app_session_heartbeat[\s\S]*?ip_check_required/)
  assert.match(migration, /revoke all on table public\.staff_ip_session_attestations[\s\S]{0,100}?authenticated/)
})

test('management requires explicit scope and staff activation confirmation', () => {
  assert.match(allowlistEdge, /portal_ip_allowlist_mutate/)
  assert.match(allowlistEdge, /portal_scope: text\(body\.portal_scope\)/)
  assert.match(allowlistPage, /<option value="admin">仅后台<\/option>/)
  assert.match(allowlistPage, /<option value="staff">仅员工前端<\/option>/)
  assert.match(allowlistPage, /<option value="both">后台 \+ 员工前端<\/option>/)
  assert.match(allowlistPage, /所有现有员工前端会话会退出/)
  assert.match(migration, /cannot_enable_without_staff_entries/)
  assert.match(migration, /if v_requested_enforced then[\s\S]{0,360}?if v_client_ip is null then[\s\S]{0,120}?client_ip_unavailable/)
  assert.match(migration, /where lease\.portal = 'staff'/)
  assert.match(allowlistEdge, /effective: Boolean\(setting\.enforced && adminEnabledCount > 0\)/)
  assert.match(allowlistEdge, /staff_effective: Boolean\(setting\.staff_enforced && staffEnabledCount > 0\)/)
  assert.match(allowlistPage, /拒绝全部 \/ 配置异常/)
})
