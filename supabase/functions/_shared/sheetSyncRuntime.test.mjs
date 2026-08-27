import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claimSheetSyncLease,
  releaseSheetSyncLease,
  SheetSyncDeadlineError,
  sheetSyncDatabaseErrorIsRetryable,
  sheetSyncRpcWithDeadline,
} from './sheetSyncRuntime.ts'

function builder(result, delayMs = 0) {
  let signal = null
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(result), delayMs)
    queueMicrotask(() => {
      if (!signal) return
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  })
  promise.abortSignal = (nextSignal) => {
    signal = nextSignal
    return promise
  }
  return promise
}

test('RPC deadline aborts the underlying request', async () => {
  let receivedSignal = null
  const client = {
    rpc() {
      const pending = builder({ data: null, error: null }, 100)
      const original = pending.abortSignal
      pending.abortSignal = (signal) => {
        receivedSignal = signal
        return original(signal)
      }
      return pending
    },
  }
  await assert.rejects(
    sheetSyncRpcWithDeadline(client, 'slow_rpc', {}, 5),
    SheetSyncDeadlineError,
  )
  assert.equal(receivedSignal?.aborted, true)
})

test('lease claim reports busy without manufacturing a holder', async () => {
  const calls = []
  const client = {
    rpc(name, args) {
      calls.push({ name, args })
      return builder({
        data: { ok: true, acquired: false, retry_after_seconds: 17 },
        error: null,
      })
    },
  }
  const claim = await claimSheetSyncLease(client, 'attendance-sheet-sync', 90)
  assert.deepEqual(claim, { acquired: false, lease: null, retryAfterSeconds: 17 })
  assert.equal(calls[0].name, 'claim_sheet_sync_runtime_lease')
  assert.match(calls[0].args.p_holder, /^[0-9a-f-]{36}$/)
})

test('acquired lease is released only by its holder', async () => {
  const calls = []
  const client = {
    rpc(name, args) {
      calls.push({ name, args })
      if (name === 'claim_sheet_sync_runtime_lease') {
        return builder({ data: { ok: true, acquired: true }, error: null })
      }
      return builder({ data: { ok: true, released: true }, error: null })
    },
  }
  const claim = await claimSheetSyncLease(client, 'employee-master-sync', 90)
  assert.equal(claim.acquired, true)
  await releaseSheetSyncLease(client, claim.lease)
  assert.equal(calls[1].name, 'release_sheet_sync_runtime_lease')
  assert.equal(calls[1].args.p_holder, claim.lease.holder)
})

test('database timeouts and lock failures are retryable', () => {
  assert.equal(sheetSyncDatabaseErrorIsRetryable({ code: '57014' }), true)
  assert.equal(sheetSyncDatabaseErrorIsRetryable({ code: '55P03' }), true)
  assert.equal(sheetSyncDatabaseErrorIsRetryable({ code: '23505' }), false)
})
