import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySessionFailure } from './sessionFailure.js'

test('expired application leases recover before signing out', () => {
  assert.deepEqual(classifySessionFailure(401, '{"error":"SESSION_NOT_CURRENT"}'), {
    shouldCheck: true,
    terminal: false,
    reason: 'lease_recovery',
  })
  assert.equal(classifySessionFailure(403, 'not_owner').terminal, false)
})

test('definitive auth revocation remains terminal', () => {
  assert.equal(classifySessionFailure(403, 'release_updated').terminal, true)
  assert.equal(classifySessionFailure(401, 'auth_session_missing').terminal, true)
  assert.equal(classifySessionFailure(401, 'active_elsewhere').terminal, true)
  assert.equal(classifySessionFailure(400, 'Invalid Refresh Token').terminal, true)
  assert.equal(classifySessionFailure(401, 'JWT expired').terminal, true)
})

test('generic unauthorized responses trigger verification without destructive logout', () => {
  assert.deepEqual(classifySessionFailure(401, '此账号已在其他设备登录或会话已过期，请重新登录'), {
    shouldCheck: true,
    terminal: false,
    reason: 'verify_unauthorized',
  })
})

test('unrelated permission and server errors do not trigger a session check', () => {
  assert.equal(classifySessionFailure(403, 'permission_denied').shouldCheck, false)
  assert.equal(classifySessionFailure(500, 'SESSION_NOT_CURRENT').shouldCheck, false)
})
