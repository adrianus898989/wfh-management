import assert from 'node:assert/strict'
import test from 'node:test'
import { withAbortableRequestTimeout } from './abortableRequestTimeout.js'

test('a request deadline aborts the underlying operation with a stable error code', async () => {
  let requestSignal
  const startedAt = Date.now()
  await assert.rejects(
    withAbortableRequestTimeout(signal => {
      requestSignal = signal
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        reject(new Error('fetch aborted'))
      }, { once: true }))
    }, 10, 'EDGE_TIMEOUT'),
    error => error?.code === 'EDGE_TIMEOUT' && error?.message === 'EDGE_TIMEOUT',
  )

  assert.equal(requestSignal.aborted, true)
  assert.ok(Date.now() - startedAt < 500)
})

test('a completed request clears its deadline without a late abort', async () => {
  let requestSignal
  const result = await withAbortableRequestTimeout(signal => {
    requestSignal = signal
    return Promise.resolve('ok')
  }, 15)

  assert.equal(result, 'ok')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(requestSignal.aborted, false)
})
