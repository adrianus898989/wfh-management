import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createPortalIpEdgeGateHandler } from '../../supabase/functions/portal-ip-edge-gate/handler.ts'
import {
  PORTAL_IP_GATE_MAX_CLOCK_SKEW_MS,
  createPortalIpGateSignature,
  isValidHostIp,
} from '../../supabase/functions/portal-ip-edge-gate/protocol.ts'

const NOW = 1_788_400_000_000
const ADMIN_SECRET = 'admin-secret-with-at-least-thirty-two-bytes'
const STAFF_SECRET = 'staff-secret-with-at-least-thirty-two-bytes'

const readSecret = name => ({
  PAGES_ADMIN_IP_GATE_SECRET: ADMIN_SECRET,
  PAGES_STAFF_IP_GATE_SECRET: STAFF_SECRET,
})[name] || ''

async function signedRequest({
  portal = 'admin',
  clientIp = '203.0.113.8',
  timestamp = String(NOW),
  secret = portal === 'admin' ? ADMIN_SECRET : STAFF_SECRET,
  signature,
  body,
  headers = {},
} = {}) {
  const payload = body ?? JSON.stringify({ portal, client_ip: clientIp })
  const resolvedSignature = signature ?? await createPortalIpGateSignature(
    secret,
    timestamp,
    portal,
    clientIp,
  )
  return new Request('https://project.supabase.co/functions/v1/portal-ip-edge-gate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pages-ip-gate-timestamp': timestamp,
      'x-pages-ip-gate-signature': resolvedSignature,
      ...headers,
    },
    body: payload,
  })
}

function handler(lookup = async () => ({ ok: true, enforced: true, reason: 'matched' })) {
  return createPortalIpEdgeGateHandler({ lookup, readSecret, now: () => NOW })
}

async function payload(response) {
  const value = await response.json()
  assert.deepEqual(Object.keys(value).sort(), ['allowed', 'enforced', 'reason'])
  assert.match(response.headers.get('cache-control') || '', /no-store/)
  assert.equal(response.headers.has('access-control-allow-origin'), false)
  return value
}

test('accepts valid IPv4 and IPv6 hosts but rejects networks and proxy chains', () => {
  for (const value of ['203.0.113.8', '2001:db8::8', '::1', '::ffff:192.0.2.1']) {
    assert.equal(isValidHostIp(value), true, value)
  }
  for (const value of [
    '203.0.113.8/32',
    '203.0.113.8, 198.51.100.1',
    '256.0.0.1',
    '01.2.3.4',
    '2001:db8:::8',
    '[2001:db8::8]',
    'fe80::1%eth0',
  ]) assert.equal(isValidHostIp(value), false, value)
})

test('a valid admin signature calls the canonical RPC dependency and projects its result', async () => {
  const calls = []
  const response = await handler(async (portal, clientIp) => {
    calls.push({ portal, clientIp })
    return {
      ok: true,
      enforced: true,
      reason: 'matched',
      client_ip: clientIp,
      matched_entry_id: 99,
      enabled_count: 4,
    }
  })(await signedRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(await payload(response), { allowed: true, enforced: true, reason: 'matched' })
  assert.deepEqual(calls, [{ portal: 'admin', clientIp: '203.0.113.8' }])
})

test('admin and staff signatures cannot be replayed across portal secrets', async () => {
  let calls = 0
  const response = await handler(async () => { calls += 1 })(
    await signedRequest({ portal: 'staff', secret: ADMIN_SECRET }),
  )
  assert.equal(response.status, 401)
  assert.deepEqual(await payload(response), {
    allowed: false,
    enforced: false,
    reason: 'invalid_signature',
  })
  assert.equal(calls, 0)
})

test('a database denial stays a three-field non-cacheable decision', async () => {
  const response = await handler(async () => ({
    ok: false,
    enforced: true,
    reason: 'ip_not_allowed',
    client_ip: '203.0.113.8',
    matched_entry_id: null,
    enabled_count: 4,
  }))(await signedRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(await payload(response), {
    allowed: false,
    enforced: true,
    reason: 'ip_not_allowed',
  })
})

test('timestamp window accepts its exact boundary and rejects either side beyond it', async () => {
  for (const offset of [-PORTAL_IP_GATE_MAX_CLOCK_SKEW_MS, PORTAL_IP_GATE_MAX_CLOCK_SKEW_MS]) {
    const response = await handler()(await signedRequest({ timestamp: String(NOW + offset) }))
    assert.equal(response.status, 200)
  }
  for (const offset of [
    -PORTAL_IP_GATE_MAX_CLOCK_SKEW_MS - 1,
    PORTAL_IP_GATE_MAX_CLOCK_SKEW_MS + 1,
  ]) {
    const response = await handler()(await signedRequest({ timestamp: String(NOW + offset) }))
    assert.equal(response.status, 401)
    assert.equal((await payload(response)).reason, 'request_expired')
  }
})

test('rejects malformed timestamp, signature, body shape, IP and short configured secret', async () => {
  const cases = [
    await signedRequest({ timestamp: '1700000000' }),
    await signedRequest({ signature: '0'.repeat(63) }),
    await signedRequest({ body: JSON.stringify({ portal: 'admin', client_ip: '203.0.113.8', extra: true }) }),
    await signedRequest({ clientIp: '203.0.113.8/32' }),
  ]
  for (const request of cases) {
    const response = await handler()(request)
    assert.ok([400, 401].includes(response.status))
    assert.equal((await payload(response)).allowed, false)
  }

  const shortSecretHandler = createPortalIpEdgeGateHandler({
    lookup: async () => ({ ok: true, enforced: true, reason: 'matched' }),
    readSecret: () => 'short',
    now: () => NOW,
  })
  const response = await shortSecretHandler(await signedRequest())
  assert.equal(response.status, 503)
  assert.equal((await payload(response)).reason, 'service_unavailable')
})

test('rejects browser, non-POST and non-JSON calls without invoking the database', async () => {
  let calls = 0
  const handle = handler(async () => { calls += 1 })
  const browser = await signedRequest({ headers: { origin: 'https://example.pages.dev' } })
  const get = new Request(browser.url)
  const text = new Request(browser.url, { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })

  assert.equal((await handle(browser)).status, 403)
  assert.equal((await handle(get)).status, 405)
  assert.equal((await handle(text)).status, 400)
  assert.equal(calls, 0)
})

test('fails closed on dependency errors and malformed privileged RPC payloads', async () => {
  const thrown = await handler(async () => { throw new Error('database unavailable') })(await signedRequest())
  assert.equal(thrown.status, 503)
  assert.equal((await payload(thrown)).reason, 'service_unavailable')

  const malformed = await handler(async () => ({
    ok: true,
    enforced: true,
    reason: 'unexpected',
    client_ip: '203.0.113.8',
  }))(await signedRequest())
  assert.equal(malformed.status, 503)
  assert.deepEqual(await payload(malformed), {
    allowed: false,
    enforced: false,
    reason: 'service_unavailable',
  })
})

test('the deployed entrypoint uses only the service-only RPC after HMAC verification', async () => {
  const source = await readFile(
    new URL('../../supabase/functions/portal-ip-edge-gate/index.ts', import.meta.url),
    'utf8',
  )
  assert.match(source, /verify_jwt=false/)
  assert.match(source, /createPortalIpEdgeGateHandler/)
  assert.match(source, /\.rpc\('portal_ip_prelogin_check'/)
  assert.match(source, /SUPABASE_SECRET_KEYS/)
  assert.doesNotMatch(source, /admin_ip_allowlist_(entries|settings)/)
  assert.doesNotMatch(source, /Access-Control-Allow-Origin/)
})
