import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { claimAttendanceSheetSyncLeaseWithWait } from './leaseWait.ts'

function builder(result) {
  const promise = Promise.resolve(result)
  promise.abortSignal = () => promise
  return promise
}

function fakeClock() {
  let current = 0
  const waits = []
  return {
    now: () => current,
    sleep: async milliseconds => {
      waits.push(milliseconds)
      current += milliseconds
    },
    waits,
  }
}

test('bounded wait absorbs a short busy lease and still requires a real acquire', async () => {
  const clock = fakeClock()
  let attempts = 0
  const client = {
    rpc(name) {
      assert.equal(name, 'claim_sheet_sync_runtime_lease')
      attempts += 1
      return builder({
        data: attempts < 3
          ? { ok: true, acquired: false, retry_after_seconds: 90 }
          : { ok: true, acquired: true },
        error: null,
      })
    },
  }

  const claim = await claimAttendanceSheetSyncLeaseWithWait(client, 90, {
    maxWaitMs: 12_000,
    pollIntervalMs: 750,
    pollJitterMs: 250,
    random: () => 0,
    now: clock.now,
    sleep: clock.sleep,
  })

  assert.equal(claim.acquired, true)
  assert.equal(attempts, 3)
  assert.deepEqual(clock.waits, [750, 750])
  assert.equal(claim.lease.jobName, 'attendance-sheet-sync')
})

test('bounded wait never manufactures success when the lease remains busy', async () => {
  const clock = fakeClock()
  let attempts = 0
  const client = {
    rpc() {
      attempts += 1
      return builder({
        data: { ok: true, acquired: false, retry_after_seconds: 73 },
        error: null,
      })
    },
  }

  const claim = await claimAttendanceSheetSyncLeaseWithWait(client, 90, {
    maxWaitMs: 2_000,
    pollIntervalMs: 750,
    pollJitterMs: 0,
    now: clock.now,
    sleep: clock.sleep,
  })

  assert.deepEqual(claim, { acquired: false, lease: null, retryAfterSeconds: 73 })
  assert.equal(attempts, 4)
  assert.deepEqual(clock.waits, [750, 750, 250])
  assert.ok(clock.waits.reduce((total, value) => total + value, 0) < 2_000)
})

test('retryable lease lock failures are retried inside the same bounded budget', async () => {
  const clock = fakeClock()
  let attempts = 0
  const client = {
    rpc() {
      attempts += 1
      return builder(attempts === 1
        ? { data: null, error: { code: '55P03', message: 'lock timeout' } }
        : { data: { ok: true, acquired: true }, error: null })
    },
  }

  const claim = await claimAttendanceSheetSyncLeaseWithWait(client, 90, {
    maxWaitMs: 2_000,
    pollIntervalMs: 750,
    pollJitterMs: 0,
    now: clock.now,
    sleep: clock.sleep,
  })

  assert.equal(claim.acquired, true)
  assert.equal(attempts, 2)
  assert.deepEqual(clock.waits, [750])
})

test('non-retryable lease failures fail closed without polling', async () => {
  const clock = fakeClock()
  const client = {
    rpc() {
      return builder({ data: null, error: { code: '23505', message: 'unexpected conflict' } })
    },
  }

  await assert.rejects(
    claimAttendanceSheetSyncLeaseWithWait(client, 90, {
      maxWaitMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
    }),
    /lease_claim_failed:23505/,
  )
  assert.deepEqual(clock.waits, [])
})

test('attendance Edge keeps timeout and busy responses retryable and never calls them success', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(source, /claimAttendanceSheetSyncLeaseWithWait\(client, LEASE_TTL_SECONDS\)/)
  assert.match(source, /error: "sync_busy"[\s\S]{0,180}503/)
  assert.match(source, /error: "database_timeout"[\s\S]{0,100}503/)
  assert.match(source, /preserveLeaseUntilExpiry = true/)
  assert.match(source, /await releaseSheetSyncLease\(client, lease\)/)
  assert.doesNotMatch(source, /error: "sync_busy"[^\n]+status\s*=\s*200/)
})

test('Apps Script advances the source hash only after an explicit 2xx ok response', () => {
  const source = readFileSync(
    new URL('../../../google-apps-script/attendance-sync/Code.gs', import.meta.url),
    'utf8',
  )
  const success = source.indexOf(
    'responseCode >= 200 && responseCode < 300 && result && result.ok === true',
  )
  const writeHash = source.indexOf('properties.setProperty(hashKey, snapshot.hash)', success)
  const scheduleRetry = source.indexOf(
    'scheduleAttendanceRetry_(properties, retryKey, snapshot.hash, retryState)',
    writeHash,
  )
  assert.ok(success >= 0)
  assert.ok(writeHash > success)
  assert.ok(scheduleRetry > writeHash)
  assert.match(source.slice(writeHash, scheduleRetry + 120), /properties\.deleteProperty\(dirtyKey\)/)
  assert.match(source.slice(scheduleRetry - 160, scheduleRetry + 180), /throw new Error\('HTTP '/)
})
