import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isStrictSuccess,
  normalizeStaffSyncRequest,
  STAFF_SYNC_MAX_BATCH,
  staffSyncSecretIsValid,
} from './protocol.ts'

const onsiteItem = (rowNumber = 2) => ({
  sheet_name: '现场转居家',
  row_number: rowNumber,
  row: { ID: `OS-${rowNumber}`, 名字: `Onsite ${rowNumber}` },
  audit_context: { audit: true },
})

test('onsite requests get a stable derived ledger identity', async () => {
  const first = await normalizeStaffSyncRequest({ action: 'sheet_row_changed', ...onsiteItem(), secret: 'never-persist-me' })
  const second = await normalizeStaffSyncRequest({ ...onsiteItem(), action: 'sheet_row_changed', secret: 'different-secret' })
  assert.equal(first.route, 'onsite-v20')
  assert.equal(first.payloadHash, second.payloadHash)
  assert.equal(first.requestId, `staff-v20:${first.payloadHash}`)
  assert.equal(first.rpcPayload.protocol_version, 'staff-sheet-sync-v20')
  assert.equal(JSON.stringify(first.rpcPayload).includes('never-persist-me'), false)
  assert.equal(first.payloadHash, second.payloadHash)
})

test('auth accepts legacy body secret or header secret and rejects missing secret', async () => {
  assert.equal(await staffSyncSecretIsValid('expected', '', { secret: 'expected' }), true)
  assert.equal(await staffSyncSecretIsValid('expected', 'expected', {}), true)
  assert.equal(await staffSyncSecretIsValid('expected', '', {}), false)
  assert.equal(await staffSyncSecretIsValid('expected', '', { secret: 'wrong' }), false)
  // An explicit header is authoritative and cannot silently fall back to body.
  assert.equal(await staffSyncSecretIsValid('expected', 'wrong', { secret: 'expected' }), false)
})

test('current and schedule edits are delegated to employee-master', async () => {
  const current = await normalizeStaffSyncRequest({
    action: 'sheet_row_changed', sheet_name: '在职名单 Current Staff List',
    row_number: 3, row: { ID: 'WD-3', '名字 Name': 'Current Person' },
  })
  const schedule = await normalizeStaffSyncRequest({
    action: 'schedule_row_changed', row_number: 4,
    row: { ID: 'WD-4', 姓名: 'Schedule Person' },
  })
  assert.equal(current.route, 'employee-master')
  assert.equal(schedule.route, 'employee-master')
})

test('bank edits are delegated to the v2 single writer', async () => {
  const request = await normalizeStaffSyncRequest({
    action: 'sheet_batch_sync',
    items: [{
      sheet_name: '银行信息', row_number: 8,
      row: { 'FULL NAME / 姓名': 'Bank Person' },
    }],
  })
  assert.equal(request.route, 'bank-v2')
})

test('batch is bounded and mixed sources are rejected', async () => {
  await assert.rejects(
    normalizeStaffSyncRequest({
      action: 'sheet_batch_sync',
      items: Array.from({ length: STAFF_SYNC_MAX_BATCH + 1 }, (_, index) => onsiteItem(index + 2)),
    }),
    /invalid_batch_size/,
  )
  await assert.rejects(
    normalizeStaffSyncRequest({
      action: 'sheet_batch_sync',
      items: [onsiteItem(), {
        sheet_name: '银行信息', row_number: 3,
        row: { 'FULL NAME / 姓名': 'Bank Person' },
      }],
    }),
    /mixed_sources_not_allowed/,
  )
})

test('strict success rejects paused and error-shaped HTTP 200 bodies', () => {
  assert.equal(isStrictSuccess({ ok: true }), true)
  assert.equal(isStrictSuccess({ ok: true, delegated: true }), true)
  assert.equal(isStrictSuccess({ ok: true, paused: true }), false)
  assert.equal(isStrictSuccess({ ok: true, error: 'failed' }), false)
  assert.equal(isStrictSuccess({ error: 'failed' }), false)
})
