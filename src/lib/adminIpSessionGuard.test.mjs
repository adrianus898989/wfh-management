import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8')

const [app, client, guard, migration] = await Promise.all([
  source('../App.jsx'),
  source('./supabase.js'),
  source('../../supabase/functions/admin-ip-guard/index.ts'),
  source('../../supabase/migrations/20260827090427_admin_login_ip_allowlist.sql'),
])

test('admin claim and heartbeat use Edge while staff retains its direct heartbeat', () => {
  assert.match(app, /mode === 'admin'\s*\? guardAdminAppSession\(method\)\s*:\s*method === 'heartbeat' \? heartbeatAppSession\(\)/)
  assert.match(client, /supabase\.functions\.invoke\('admin-ip-guard'/)
  assert.match(guard, /p_source: action/)
  assert.match(guard, /action === 'claim'[\s\S]*?app_session_claim[\s\S]*?: await userClient\.rpc\('app_session_heartbeat'\)/)
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

test('proxy metadata outage is retryable and cannot revoke a valid server session', () => {
  const attest = migration.slice(
    migration.indexOf('create or replace function public.admin_ip_session_attest'),
    migration.indexOf('create or replace function public.admin_ip_allowlist_mutate'),
  )
  assert.match(attest, /if v_gate->>'reason' = 'ip_not_allowed' then[\s\S]*?delete from auth\.sessions/)
  assert.match(attest, /session_revoked', false/)
  assert.doesNotMatch(attest, /client_ip_unavailable'[\s\S]{0,300}?delete from auth\.sessions/)
})
