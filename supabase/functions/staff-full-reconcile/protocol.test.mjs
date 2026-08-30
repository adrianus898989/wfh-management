import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isTerminalBankRequestSuccess,
  normalizeStaffFullReconcileRequest,
  STAFF_BANK_BINDING_HEADER,
  STAFF_FULL_RECONCILE_MAX_BATCH,
  staffFullReconcileSecretIsValid,
} from './protocol.ts'

const bankItem = (rowNumber = 2, binding = `WD${rowNumber}`) => ({
  row_number: rowNumber,
  row: {
    [STAFF_BANK_BINDING_HEADER]: binding,
    'FULL NAME / 姓名': `Bank ${rowNumber}`,
    'TRANSFER USING': 'USDT',
    'GCASH ACCOUNT / GCASH 账号': `T${'1'.repeat(32)}`,
  },
})

test('bank requests get a stable secret-free ledger identity', async () => {
  const first = await normalizeStaffFullReconcileRequest({
    action: 'bank_row_changed', ...bankItem(), secret: 'never-persist-me',
  })
  const second = await normalizeStaffFullReconcileRequest({
    ...bankItem(), action: 'bank_row_changed', secret: 'different-secret',
  })
  assert.equal(first.payloadHash, second.payloadHash)
  assert.equal(first.requestId, `bank-v4:${first.payloadHash}`)
  assert.equal(first.rpcPayload.protocol_version, 'staff-full-reconcile-v4')
  assert.equal(JSON.stringify(first.rpcPayload).includes('never-persist-me'), false)
})

test('auth accepts the installed body-secret path without persisting it', async () => {
  assert.equal(await staffFullReconcileSecretIsValid('expected', '', { secret: 'expected' }), true)
  assert.equal(await staffFullReconcileSecretIsValid('expected', 'expected', {}), true)
  assert.equal(await staffFullReconcileSecretIsValid('expected', '', {}), false)
  assert.equal(await staffFullReconcileSecretIsValid('expected', 'wrong', { secret: 'expected' }), false)
})

test('recovery refuses name-only rows and non-bank actions', async () => {
  await assert.rejects(
    normalizeStaffFullReconcileRequest({
      action: 'bank_row_changed', row_number: 2,
      row: { 'FULL NAME / 姓名': 'Name only' },
    }),
    /missing_employee_binding/,
  )
  await assert.rejects(
    normalizeStaffFullReconcileRequest({
      action: 'export_profile_chunk', ...bankItem(),
    }),
    /invalid_action/,
  )
})

test('dry-run permits name planning only with a whole-sheet occurrence count', async () => {
  const planned = await normalizeStaffFullReconcileRequest({
    action: 'bank_binding_dry_run',
    items: [{
      row_number: 2,
      source_name_count: 1,
      row: { 'FULL NAME / 姓名': 'Unique Source Name' },
    }],
  })
  assert.equal(planned.action, 'bank_binding_dry_run')
  assert.equal(planned.items[0].source_name_count, 1)
  assert.equal(planned.items[0].row[STAFF_BANK_BINDING_HEADER], undefined)

  await assert.rejects(
    normalizeStaffFullReconcileRequest({
      action: 'bank_binding_dry_run',
      items: [{ row_number: 2, row: { 'FULL NAME / 姓名': 'Missing count' } }],
    }),
    /invalid_source_name_count/,
  )
})

test('bank batches are bounded to the Apps Script chunk size', async () => {
  await assert.rejects(
    normalizeStaffFullReconcileRequest({
      action: 'bank_batch_changed',
      items: Array.from({ length: STAFF_FULL_RECONCILE_MAX_BATCH + 1 }, (_, index) => bankItem(index + 2)),
    }),
    /invalid_batch_size/,
  )
})

test('only completed writes or explicit read-only plans are terminal success', () => {
  assert.equal(isTerminalBankRequestSuccess({ ok: true, write_performed: true }), true)
  assert.equal(isTerminalBankRequestSuccess({ ok: true, completed: true, write_performed: false }), true)
  assert.equal(isTerminalBankRequestSuccess({ ok: true, completed: false, write_performed: false }), false)
  assert.equal(isTerminalBankRequestSuccess({ ok: true, dry_run: true, write_performed: false }), true)
  assert.equal(isTerminalBankRequestSuccess({ ok: true, delegated: true, write_performed: false }), false)
  assert.equal(isTerminalBankRequestSuccess({ ok: true, write_performed: true, paused: true }), false)
  assert.equal(isTerminalBankRequestSuccess({ ok: false, write_performed: false, error: 'busy' }), false)
})
