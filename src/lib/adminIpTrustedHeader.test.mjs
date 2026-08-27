import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hostCidr,
  jwtSessionId,
  trustedClientIp,
} from '../../supabase/functions/_shared/adminIp.ts'

const request = headers => new Request('https://example.test/functions/v1/admin-ip-guard', { headers })

test('only the hosted gateway Cloudflare address is trusted', () => {
  assert.equal(trustedClientIp(request({
    'cf-connecting-ip': '203.0.113.8',
    'x-forwarded-for': '198.51.100.7, 10.0.0.4',
    'x-real-ip': '198.51.100.7',
    'x-client-ip': '192.0.2.4',
  })), '203.0.113.8')
  assert.equal(trustedClientIp(request({ 'x-real-ip': '198.51.100.7' })), '')
  assert.equal(trustedClientIp(request({
    'cf-connecting-ip': '198.51.100.7, 10.0.0.4',
  })), '')
  assert.equal(trustedClientIp(request({ 'cf-connecting-ip': '203.0.113.0/24' })), '')
})

test('missing trusted IP fails closed without inventing a browser value', () => {
  assert.equal(trustedClientIp(request({})), '')
  assert.equal(trustedClientIp(request({ 'cf-connecting-ip': '   ' })), '')
})

test('exact IPv4/IPv6 CIDRs and JWT session binding stay deterministic', () => {
  assert.equal(hostCidr('203.0.113.8'), '203.0.113.8/32')
  assert.equal(hostCidr('2001:db8::8'), '2001:db8::8/128')
  const payload = Buffer.from(JSON.stringify({
    session_id: '11111111-2222-4333-8444-555555555555',
  })).toString('base64url')
  assert.equal(
    jwtSessionId(`Bearer header.${payload}.signature`),
    '11111111-2222-4333-8444-555555555555',
  )
})
