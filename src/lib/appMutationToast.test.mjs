import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mutationAuthFailure,
  mutationErrorReason,
  writeFailureToast,
  writeSuccessToast,
} from './appMutationToast.js'

test('write failure toast never offers a refresh action for 401 or 403', () => {
  const refresh = () => {}
  for (const error of [
    { status:401, message:'not_authenticated' },
    { context:{ status:403 }, message:'permission_denied' },
    new Error('session_not_current'),
    new Error('forbidden'),
  ]) {
    const toast = writeFailureToast({ module:'账号', operation:'保存', error, refresh })
    assert.equal(toast.type, 'error')
    assert.equal(toast.retry, undefined)
  }
  assert.equal(mutationAuthFailure({ status:401 }), 401)
  assert.equal(mutationAuthFailure({ context:{ status:403 } }), 403)
})

test('timeout and 5xx failures can only expose the supplied safe read refresh', () => {
  const refresh = () => 'read-only-refresh'
  for (const error of [new Error('statement timeout'), { status:503, message:'temporarily unavailable' }]) {
    const toast = writeFailureToast({
      module:'工资统计', operation:'发布工资', error, refresh,
      dedupeKey:'payroll:publish:error',
    })
    assert.equal(toast.retry, refresh)
    assert.equal(toast.retryLabel, '刷新确认')
    assert.equal(toast.dedupeKey, 'payroll:publish:error')
  }
})

test('write toast helpers preserve explicit operation copy and durable inline reason', () => {
  assert.deepEqual(writeSuccessToast({
    module:'预警中心', operation:'确认跟进', reason:'已记录确认账号。', dedupeKey:'alert:confirm:success',
  }), {
    type:'success', module:'预警中心', operation:'确认跟进', reason:'已记录确认账号。', dedupeKey:'alert:confirm:success',
  })
  assert.equal(mutationErrorReason({ details:'database unavailable' }), 'database unavailable')
  assert.equal(mutationErrorReason({ status:503 }, 'service unavailable'), 'service unavailable')
  assert.equal(mutationErrorReason(null, 'fallback'), 'fallback')
})
