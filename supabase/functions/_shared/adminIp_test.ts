import {
  bearerToken,
  hostCidr,
  jwtSessionId,
  trustedClientIp,
} from './adminIp.ts'

function assertEquals(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function request(headers: Record<string, string>) {
  return new Request('https://example.test/functions/v1/admin-ip-guard', { headers })
}

Deno.test('client IP comes only from the gateway-owned Cloudflare header', () => {
  assertEquals(
    trustedClientIp(request({
      'cf-connecting-ip': '203.0.113.8',
      'x-forwarded-for': '198.51.100.7, 10.0.0.4',
      'x-real-ip': '198.51.100.9',
      'x-client-ip': '192.0.2.4',
    })),
    '203.0.113.8',
    'trusted IP',
  )
  assertEquals(
    trustedClientIp(request({
      'x-forwarded-for': '198.51.100.7, 10.0.0.4',
      'x-real-ip': '198.51.100.9',
    })),
    '',
    'untrusted fallback was accepted',
  )
})

Deno.test('malformed Cloudflare client values fail closed', () => {
  assertEquals(
    trustedClientIp(request({ 'cf-connecting-ip': '2001:db8::8, 10.0.0.4' })),
    '',
    'client IP chain',
  )
  assertEquals(
    trustedClientIp(request({ 'cf-connecting-ip': '203.0.113.0/24' })),
    '',
    'CIDR is not a client address',
  )
})

Deno.test('host CIDR preserves exact IPv4 and IPv6 addresses', () => {
  assertEquals(hostCidr('203.0.113.8'), '203.0.113.8/32', 'IPv4 host CIDR')
  assertEquals(hostCidr('2001:db8::8'), '2001:db8::8/128', 'IPv6 host CIDR')
})

Deno.test('JWT session id is decoded without trusting an input body', () => {
  const payload = btoa(JSON.stringify({ session_id: '11111111-2222-4333-8444-555555555555' }))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  const token = `header.${payload}.signature`
  assertEquals(bearerToken(`Bearer ${token}`), token, 'bearer token')
  assertEquals(
    jwtSessionId(`Bearer ${token}`),
    '11111111-2222-4333-8444-555555555555',
    'session id',
  )
})
