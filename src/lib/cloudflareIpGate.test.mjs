import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const loadWorker = async portal => {
  const source = (await read('cloudflare/edge-gate-worker.js'))
    .replaceAll('__WFH_PORTAL_MODE__', portal)
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${portal}-${Date.now()}`)
}

test('Cloudflare worker gates entry documents before static assets', async () => {
  const [worker, routes, build] = await Promise.all([
    read('cloudflare/edge-gate-worker.js'),
    read('public/_routes.json'),
    read('scripts/build-cloudflare.mjs'),
  ])
  const routeConfig = JSON.parse(routes)

  assert.equal(routeConfig.version, 1)
  assert.deepEqual(routeConfig.include, ['/*'])
  assert.deepEqual(routeConfig.exclude, ['/assets/*', '/release.json'])
  assert.match(worker, /request\.headers\.get\('CF-Connecting-IP'\)/)
  assert.match(worker, /env\.IP_GATE_HMAC_SECRET/)
  assert.match(worker, /X-Pages-IP-Gate-Timestamp/)
  assert.match(worker, /X-Pages-IP-Gate-Signature/)
  assert.match(worker, /crypto\.subtle\.sign/)
  assert.match(worker, /globalThis\.caches\?\.default/)
  assert.match(worker, /DECISION_CACHE_SECONDS = 45/)
  assert.match(worker, /FAILURE_CIRCUIT_SECONDS = 5/)
  assert.match(worker, /const gateFlights = new Map\(\)/)
  assert.match(worker, /const decisionMemory = new Map\(\)/)
  assert.match(worker, /redirect: 'manual'/)
  assert.doesNotMatch(worker, /redirect: 'error'/)
  assert.match(worker, /payload\?\.allowed === false && payload\?\.reason === 'ip_not_allowed'/)
  assert.match(worker, /return blocked\(403, 'Access denied'\)/)
  assert.match(worker, /return blocked\(503, 'Service temporarily unavailable'/)
  assert.match(worker, /env\.ASSETS\.fetch\(request\)/)
  assert.doesNotMatch(worker, /service[_-]?role/i)
  assert.doesNotMatch(worker, /request\.json\(\).*portal/s)
  assert.match(build, /cloudflare\/edge-gate-worker\.js/)
  assert.match(build, /Cloudflare builds require \$\{name\}/)
  assert.match(build, /'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'/)
  assert.match(build, /replaceAll\('__WFH_PORTAL_MODE__', portalMode\)/)
  assert.match(build, /dist\/_worker\.js/)
})

test('Cloudflare builds stamp one fixed portal and never ship the placeholder', async () => {
  const template = await read('cloudflare/edge-gate-worker.js')
  for (const portal of ['admin', 'staff']) {
    const built = template.replaceAll('__WFH_PORTAL_MODE__', portal)
    assert.match(built, new RegExp(`const PORTAL_MODE = '${portal}'`))
    assert.doesNotMatch(built, /__WFH_PORTAL_MODE__/)
  }
})

test('edge gate signs the trusted Cloudflare IP and serves assets only after allow', async t => {
  const module = await loadWorker('admin')
  const originalFetch = globalThis.fetch
  const secret = 'test-secret-with-at-least-thirty-two-characters'
  let upstream
  let assetCalls = 0
  globalThis.fetch = async (url, init) => {
    upstream = { url, init }
    return new Response(JSON.stringify({ allowed: true, enforced: true, reason: 'matched' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const response = await module.default.fetch(new Request(
    'https://wfh-workspaceexpert.pages.dev/workspace/login',
    { headers: { 'CF-Connecting-IP': '203.0.113.8' } },
  ), {
    IP_GATE_HMAC_SECRET: secret,
    ASSETS: { fetch: async () => {
      assetCalls += 1
      return new Response('app', { headers: { 'Cache-Control': 'public' } })
    } },
  })

  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'app')
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0')
  assert.equal(assetCalls, 1)
  assert.equal(upstream.url, 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/portal-ip-edge-gate')
  assert.deepEqual(JSON.parse(upstream.init.body), { portal: 'admin', client_ip: '203.0.113.8' })
  assert.match(upstream.init.headers['X-Pages-IP-Gate-Timestamp'], /^\d{13}$/)
  assert.match(upstream.init.headers['X-Pages-IP-Gate-Signature'], /^[a-f0-9]{64}$/)
  assert.equal(upstream.init.redirect, 'manual')
})

test('edge gate denies a non-allowlisted IP and fails closed on missing trust material', async t => {
  const module = await loadWorker('staff')
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  let assetCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return new Response(JSON.stringify({ allowed: false, enforced: true, reason: 'ip_not_allowed' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const env = {
    IP_GATE_HMAC_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    ASSETS: { fetch: async () => { assetCalls += 1; return new Response('app') } },
  }

  const denied = await module.default.fetch(new Request(
    'https://wfh-teamportal.pages.dev/portal/login',
    { headers: { 'CF-Connecting-IP': '198.51.100.9' } },
  ), env)
  assert.equal(denied.status, 403)
  assert.equal(await denied.text(), 'Access denied')
  assert.equal(assetCalls, 0)

  const unavailable = await module.default.fetch(new Request(
    'https://wfh-teamportal.pages.dev/portal/login',
  ), env)
  assert.equal(unavailable.status, 503)
  assert.equal(fetchCalls, 1)
  assert.equal(assetCalls, 0)
})

test('edge gate reuses a short IP-bound decision and opens a fail-closed outage circuit', async t => {
  const entries = new Map()
  const memoryCache = {
    async match(request) {
      const response = entries.get(request.url)
      return response?.clone() || undefined
    },
    async put(request, response) {
      entries.set(request.url, response.clone())
    },
  }
  const originalCaches = globalThis.caches
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: memoryCache },
  })
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalCaches === undefined) delete globalThis.caches
    else Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches })
  })

  const module = await loadWorker('admin')
  const env = {
    IP_GATE_HMAC_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    ASSETS: { fetch: async () => new Response('app') },
  }
  let upstreamCalls = 0
  globalThis.fetch = async () => {
    upstreamCalls += 1
    return new Response(JSON.stringify({ allowed: true, enforced: true, reason: 'matched' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const allowedRequest = () => new Request(
    'https://wfh-workspaceexpert.pages.dev/workspace/login',
    { headers: { 'CF-Connecting-IP': '203.0.113.18' } },
  )
  const concurrent = await Promise.all([
    module.default.fetch(allowedRequest(), env),
    module.default.fetch(allowedRequest(), env),
  ])
  assert.deepEqual(concurrent.map(response => response.status), [200, 200])
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await module.default.fetch(allowedRequest(), env)).status, 200)
  assert.equal(upstreamCalls, 1)

  entries.clear()
  globalThis.fetch = async () => {
    upstreamCalls += 1
    return new Response('busy', { status: 503 })
  }
  const firstFailure = await module.default.fetch(new Request(
    'https://wfh-workspaceexpert.pages.dev/workspace/login',
    { headers: { 'CF-Connecting-IP': '203.0.113.19' } },
  ), env)
  await new Promise(resolve => setTimeout(resolve, 0))
  const circuitFailure = await module.default.fetch(new Request(
    'https://wfh-workspaceexpert.pages.dev/workspace/login',
    { headers: { 'CF-Connecting-IP': '203.0.113.20' } },
  ), env)
  assert.equal(firstFailure.status, 503)
  assert.equal(circuitFailure.status, 503)
  assert.equal(upstreamCalls, 2)
})
