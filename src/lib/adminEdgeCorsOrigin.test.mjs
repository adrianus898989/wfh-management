import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  allowedAppOrigins,
  corsGate,
  corsHeaders,
  isRequestOriginAllowed,
} from '../../supabase/functions/_shared/corsOrigin.ts'

const LEGACY_ORIGIN = 'https://adrianus898989.github.io'
const ADMIN_CLOUDFLARE_ORIGIN = 'https://wfh-workspaceexpert.pages.dev'
const STAFF_CLOUDFLARE_ORIGIN = 'https://wfh-teamportal.pages.dev'
const source = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8')

test('legacy GitHub Pages and configured exact HTTPS origins are allowed', () => {
  const origins = allowedAppOrigins(
    ` ${ADMIN_CLOUDFLARE_ORIGIN}, ${STAFF_CLOUDFLARE_ORIGIN}/ ,${ADMIN_CLOUDFLARE_ORIGIN}`,
  )
  assert.deepEqual([...origins], [
    LEGACY_ORIGIN,
    ADMIN_CLOUDFLARE_ORIGIN,
    STAFF_CLOUDFLARE_ORIGIN,
  ])
})

test('wildcards, paths, credentials, non-HTTPS and local origins are rejected', () => {
  const rejected = [
    'https://*.pages.dev',
    'https://pages.dev/*',
    'https://portal.example.com/admin',
    'https://user:password@portal.example.com',
    'https://portal.example.com?next=admin',
    'https://portal.example.com#admin',
    'http://portal.example.com',
    'https://localhost',
    'https://dev.localhost:8443',
    'https://127.0.0.1',
    'https://[::1]',
    'null',
  ]
  const origins = allowedAppOrigins(rejected.join(','))
  assert.deepEqual([...origins], [LEGACY_ORIGIN])
})

test('an allowed browser origin receives only its own exact ACAO value', () => {
  const request = new Request('https://edge.example.test', {
    method: 'POST',
    headers: { Origin: ADMIN_CLOUDFLARE_ORIGIN },
  })
  const configuredOrigins = `${ADMIN_CLOUDFLARE_ORIGIN},${STAFF_CLOUDFLARE_ORIGIN}`
  assert.equal(isRequestOriginAllowed(request, configuredOrigins), true)
  assert.equal(corsGate(request, {}, configuredOrigins), null)

  const headers = corsHeaders(request, {}, configuredOrigins)
  assert.equal(headers['Access-Control-Allow-Origin'], ADMIN_CLOUDFLARE_ORIGIN)
  assert.equal(headers.Vary, 'Origin')
})

test('an unknown browser origin fails closed before request handling', async () => {
  const request = new Request('https://edge.example.test', {
    method: 'POST',
    headers: { Origin: 'https://untrusted.pages.dev' },
  })
  const response = corsGate(request, {}, `${ADMIN_CLOUDFLARE_ORIGIN},${STAFF_CLOUDFLARE_ORIGIN}`)
  assert.equal(response?.status, 403)
  assert.equal(response?.headers.get('vary'), 'Origin')
  assert.equal(response?.headers.has('access-control-allow-origin'), false)
  assert.equal((await response?.json()).code, 'origin_not_allowed')
})

test('allowed OPTIONS is answered without entering function business logic', () => {
  const request = new Request('https://edge.example.test', {
    method: 'OPTIONS',
    headers: { Origin: STAFF_CLOUDFLARE_ORIGIN },
  })
  const configuredOrigins = `${ADMIN_CLOUDFLARE_ORIGIN},${STAFF_CLOUDFLARE_ORIGIN}`
  const response = corsGate(request, { maxAgeSeconds: 600 }, configuredOrigins)
  assert.equal(response?.status, 204)
  assert.equal(response?.headers.get('access-control-allow-origin'), STAFF_CLOUDFLARE_ORIGIN)
  assert.equal(response?.headers.get('access-control-max-age'), '600')
})

test('origin-less server calls keep their existing auth and method semantics', () => {
  const post = new Request('https://edge.example.test', { method: 'POST' })
  assert.equal(isRequestOriginAllowed(post, ADMIN_CLOUDFLARE_ORIGIN), true)
  assert.equal(corsGate(post, {}, ADMIN_CLOUDFLARE_ORIGIN), null)
  assert.equal('Access-Control-Allow-Origin' in corsHeaders(post, {}, ADMIN_CLOUDFLARE_ORIGIN), false)

  const options = new Request('https://edge.example.test', { method: 'OPTIONS' })
  const response = corsGate(options, {}, ADMIN_CLOUDFLARE_ORIGIN)
  assert.equal(response?.status, 204)
  assert.equal(response?.headers.has('access-control-allow-origin'), false)
})

const targets = [
  '../../supabase/functions/admin-login/index.ts',
  '../../supabase/functions/admin-ip-guard/index.ts',
  '../../supabase/functions/admin-ip-preflight/index.ts',
  '../../supabase/functions/admin-ip-allowlist/index.ts',
  '../../supabase/functions/admin-accounts/index.ts',
  '../../supabase/functions/admin-accounts/recovery.ts',
  '../../supabase/functions/staff-change-password/index.ts',
  '../../supabase/functions/admin-payout-change/index.ts',
]

for (const relativePath of targets) {
  test(`${relativePath} gates origin before method and business logic`, async () => {
    const edge = await source(relativePath)
    const gate = edge.indexOf('const corsResponse = corsGate(req')
    const earlyReturn = edge.indexOf('if (corsResponse) return corsResponse', gate)
    const methodHandling = edge.indexOf("if (req.method !== 'POST')", gate)

    assert.match(edge, /from '\.\.\/_shared\/corsOrigin\.ts'/)
    assert.ok(gate >= 0, 'shared CORS gate must be called')
    assert.ok(earlyReturn > gate, 'CORS response must return immediately')
    assert.ok(methodHandling > earlyReturn, 'origin gate must run before method/business handling')
    assert.match(edge, /\.\.\.corsHeaders\(req(?:, corsOptions)?\)/)
    assert.doesNotMatch(edge, /adrianus898989\.github\.io/)
    assert.doesNotMatch(edge, /Access-Control-Allow-Origin/)
  })
}

test('shared helper owns the only legacy origin and reads a narrow environment key', async () => {
  const helper = await source('../../supabase/functions/_shared/corsOrigin.ts')
  assert.match(helper, /APP_ALLOWED_ORIGINS/)
  assert.match(helper, /https:\/\/adrianus898989\.github\.io/)
  assert.doesNotMatch(helper, /Deno\.env\.toObject/)
})
