import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8')

const [app, client, guard, allowlistPage, allowlistEdge, migration, raceFix, staffMigration] = await Promise.all([
  source('../App.jsx'),
  source('./supabase.js'),
  source('../../supabase/functions/admin-ip-guard/index.ts'),
  source('../pages/AdminIpAllowlistPage.jsx'),
  source('../../supabase/functions/admin-ip-allowlist/index.ts'),
  source('../../supabase/migrations/20260827090427_admin_login_ip_allowlist.sql'),
  source('../../supabase/migrations/20260828064000_admin_ip_attestation_session_race.sql'),
  source('../../supabase/migrations/20260829112326_staff_portal_ip_allowlist.sql'),
])

test('admin and staff claim and heartbeat both use the gateway IP Edge boundary', () => {
  assert.match(app, /guardPortalAppSession\(mode, method\)/)
  assert.match(client, /supabase\.functions\.invoke\('admin-ip-guard'/)
  assert.match(client, /body:\{action,portal:normalizedPortal\}/)
  assert.match(guard, /p_source: action/)
  assert.match(guard, /portal === 'staff'[\s\S]*?'staff_ip_session_attest'/)
  assert.match(guard, /p_portal: portal/)
  assert.match(guard, /action === 'claim'[\s\S]*?app_session_claim[\s\S]*?: await userClient\.rpc\('app_session_heartbeat'\)/)
})

test('admin IP guard bounds every upstream dependency call', () => {
  assert.match(guard, /const DEPENDENCY_TIMEOUT_MS = 8_000/)
  assert.match(guard, /function timedFetch\(timeoutMs: number\)/)
  assert.match(guard, /global: \{ fetch: boundedFetch \}/)
  assert.match(guard, /global: \{[\s\S]{0,100}?fetch: boundedFetch,[\s\S]{0,100}?Authorization: authorization/)
  assert.doesNotMatch(guard, /auth\.getUser\(/)
  assert.match(guard, /const userId = jwtUserId\(token\)/)
  assert.match(guard, /p_user_id: userId/)
})

test('IP allowlist requests abort and always release both saving locks', () => {
  assert.match(allowlistPage, /const IP_ALLOWLIST_REQUEST_TIMEOUT_MS = 15 \* 1000/)
  assert.match(allowlistPage, /withAbortTimeout\([\s\S]{0,100}?signal => supabase\.functions\.invoke\('admin-ip-allowlist',[\s\S]{0,120}?signal/)
  assert.match(allowlistPage, /保存响应超时；本次操作可能已经完成，请先刷新确认，未生效再重试/)
  assert.match(allowlistPage, /const mutate = async[\s\S]{0,900}?finally \{\s*setSaving\(false\)/)
  assert.match(allowlistPage, /const saveEntry = async[\s\S]{0,1300}?finally \{\s*setModal\(current => current \? \(\{ \.\.\.current, saving: false \}\) : current\)/)
  assert.match(allowlistPage, /response\?\.refresh_required[\s\S]{0,220}?void load\(\{ background: true \}\)/)
  assert.match(allowlistPage, /const load = async \(\{ background = false \} = \{\}\)[\s\S]{0,220}?if \(!background\) setLoading\(false\)/)
})

test('IP allowlist Edge dependencies are bounded and rely on gateway-verified JWT identity', () => {
  assert.match(allowlistEdge, /const DEPENDENCY_TIMEOUT_MS = 8_000/)
  assert.match(allowlistEdge, /global: \{ fetch: boundedFetch \}/)
  assert.match(allowlistEdge, /fetch: boundedFetch,[\s\S]{0,100}?Authorization: authorization/)
  assert.doesNotMatch(allowlistEdge, /auth\.getUser\(/)
  assert.match(allowlistEdge, /const userId = jwtUserId\(token\)/)
  assert.match(allowlistEdge, /p_user_id: userId/)
  assert.match(allowlistEdge, /p_actor_id: userId/)
  assert.match(allowlistEdge, /if \(heartbeatError\)[\s\S]{0,220}?service_unavailable[\s\S]{0,40}?503/)
  assert.match(allowlistEdge, /return json\(req, \{ ok: true, mutation, refresh_required: true \}\)/)
  assert.equal(allowlistEdge.match(/await snapshot\(admin, clientIp\)/g)?.length, 1)
})

test('only an explicit non-allowlisted decision is terminal in React', () => {
  const terminalBlock = app.slice(
    app.indexOf('const terminalLeaseReason'),
    app.indexOf('const terminalBootstrapReason'),
  )
  assert.match(terminalBlock, /'ip_not_allowed'/)
  assert.doesNotMatch(terminalBlock, /client_ip_unavailable|guard_unavailable|ip_check_required/)
})

test('five-minute attestation blocks direct renewal after freshness expires', () => {
  assert.match(migration, /verified_until timestamptz not null/)
  assert.match(migration, /attestation\.verified_until > statement_timestamp\(\)/)
  assert.match(migration, /v_now \+ interval '5 minutes'/)
  assert.match(migration, /app_session_heartbeat[\s\S]*?current_admin_ip_attestation_is_valid/)
  assert.match(migration, /v_portal = 'staff'[\s\S]*?staff_portal_account_exists/)
})

test('staff IP enforcement is default-off and protects the central session predicate', () => {
  assert.match(staffMigration, /staff_enforced boolean not null default false/)
  assert.match(staffMigration, /portal_scope text not null default 'admin'/)
  assert.match(staffMigration, /portal_scope in \('admin', 'staff', 'both'\)/)
  assert.match(staffMigration, /current_staff_ip_attestation_is_valid/)
  assert.match(staffMigration, /lease\.portal <> 'staff'[\s\S]{0,180}?current_staff_ip_attestation_is_valid/)
  assert.match(staffMigration, /app_session_claim[\s\S]*?ip_check_required/)
  assert.match(staffMigration, /app_session_heartbeat[\s\S]*?ip_check_required/)
})

test('proxy metadata outage is retryable and cannot revoke a valid server session', () => {
  const attest = migration.slice(
    migration.indexOf('create or replace function public.admin_ip_session_attest'),
    migration.indexOf('create or replace function public.admin_ip_allowlist_mutate'),
  )
  assert.match(attest, /if v_gate->>'reason' = 'ip_not_allowed' then[\s\S]*?delete from auth\.sessions/)
  assert.match(attest, /session_revoked', false/)
  assert.doesNotMatch(attest, /client_ip_unavailable'[\s\S]{0,300}?delete from auth\.sessions/)
})

test('concurrent logout cannot turn an IP attestation into an FK infrastructure error', () => {
  assert.match(raceFix, /from auth\.sessions auth_session[\s\S]{0,180}?for key share;/)
  assert.match(raceFix, /if not found then[\s\S]{0,180}?'auth_session_missing'/)
  assert.ok(
    raceFix.indexOf('for key share;') <
      raceFix.indexOf('insert into public.admin_ip_session_attestations'),
  )
  assert.match(raceFix, /set lock_timeout = '750ms'/)
})
