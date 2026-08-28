import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  publicPreflightPayload,
  unavailablePreflight,
} from '../../supabase/functions/admin-ip-preflight/protocol.ts'
import {
  classifyAdminIpPreflight,
  requestAdminIpPreflight,
} from './adminIpPreflight.js'

const source = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8')

const [edge, login, helper] = await Promise.all([
  source('../../supabase/functions/admin-ip-preflight/index.ts'),
  source('../pages/AdminLoginPage.jsx'),
  source('./adminIpPreflight.js'),
])

test('public preflight projection never leaks privileged allowlist details', () => {
  const projected = publicPreflightPayload({
    ok: true,
    enforced: true,
    effective: true,
    reason: 'matched',
    client_ip: '203.0.113.42',
    matched_entry_id: 99,
    enabled_count: 12,
  })
  assert.deepEqual(projected, { allowed: true, enforced: true, reason: 'matched' })
  assert.deepEqual(Object.keys(projected).sort(), ['allowed', 'enforced', 'reason'])
  assert.doesNotMatch(JSON.stringify(projected), /203\.0\.113\.42|matched_entry_id|enabled_count/)
  assert.deepEqual(unavailablePreflight(), {
    allowed: false,
    enforced: false,
    reason: 'service_unavailable',
  })
})

test('unexpected or inconsistent gate results fail closed', () => {
  assert.deepEqual(publicPreflightPayload(null), unavailablePreflight())
  assert.deepEqual(publicPreflightPayload({ ok: true, reason: 'unknown' }), unavailablePreflight())
  assert.deepEqual(publicPreflightPayload({
    ok: true,
    enforced: false,
    reason: 'matched',
  }), unavailablePreflight())
  assert.deepEqual(publicPreflightPayload({ ok: false, enforced: true, reason: 'matched' }), {
    allowed: false,
    enforced: true,
    reason: 'matched',
  })
  assert.equal(classifyAdminIpPreflight({
    allowed: false,
    enforced: true,
    reason: 'matched',
  }).status, 'unavailable')
})

test('frontend distinguishes a verified denial from a retryable dependency failure', async () => {
  const allowed = await requestAdminIpPreflight({
    functions: {
      invoke: async (name, options) => {
        assert.equal(name, 'admin-ip-preflight')
        assert.deepEqual(options.body, {})
        assert.ok(options.signal instanceof AbortSignal)
        return { data: { allowed: true, enforced: false, reason: 'enforcement_disabled' }, error: null }
      },
    },
  })
  assert.equal(allowed.status, 'allowed')

  assert.equal(classifyAdminIpPreflight({
    allowed: false,
    enforced: true,
    reason: 'ip_not_allowed',
  }).status, 'blocked')
  assert.equal(classifyAdminIpPreflight({
    allowed: false,
    enforced: true,
    reason: 'client_ip_unavailable',
  }).status, 'unavailable')

  const failed = await requestAdminIpPreflight({
    functions: { invoke: async () => ({ data: null, error: new Error('temporary') }) },
  })
  assert.deepEqual(failed, {
    status: 'unavailable',
    allowed: false,
    enforced: false,
    reason: 'service_unavailable',
  })
})

test('browser preflight aborts a hung invocation and releases the loading state', async () => {
  let requestSignal
  const startedAt = Date.now()
  const result = await requestAdminIpPreflight({
    functions: {
      invoke: async (_name, options) => {
        requestSignal = options.signal
        return await new Promise(resolve => options.signal.addEventListener('abort', () => {
          resolve({ data: null, error: new Error('aborted') })
        }, { once: true }))
      },
    },
  }, { timeoutMs: 10 })

  assert.equal(requestSignal.aborted, true)
  assert.ok(Date.now() - startedAt < 500)
  assert.equal(result.status, 'unavailable')
})

test('Edge preflight is anonymous-only at the gateway but service-role-only at the database', () => {
  assert.match(edge, /verify_jwt=false/)
  assert.match(edge, /trustedClientIp\(req\)/)
  assert.match(edge, /secretKeys\.default \|\| Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/)
  assert.match(edge, /admin\.rpc\('admin_ip_prelogin_check'/)
  assert.doesNotMatch(edge, /await req\.json\(|req\.url|searchParams/)
  assert.match(edge, /const DEPENDENCY_TIMEOUT_MS = 8_000/)
  assert.match(edge, /global: \{ fetch: timedFetch\(DEPENDENCY_TIMEOUT_MS\) \}/)
  assert.match(edge, /origin && origin !== ALLOWED_ORIGIN/)
  assert.match(edge, /Cache-Control': 'no-store, private, max-age=0'/)
})

test('admin login never flashes or submits the credential form before a successful preflight', () => {
  assert.match(login, /status: 'checking',[\s\S]{0,100}?allowed: false/)
  assert.match(login, /preflight\.status === 'allowed' \? <form/)
  assert.match(login, /if \(preflight\.status !== 'allowed'\) return/)
  assert.match(login, /preflight\.status === 'blocked'[\s\S]{0,220}?当前网络未获准访问后台/)
  assert.match(login, /访问验证暂时不可用，请稍后重试/)
  assert.match(login, /onClick=\{\(\) => void checkPreflight\(\)\}/)
  assert.doesNotMatch(helper, /signOut|removeItem|clearSession|setAppSession/)
})
