import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ADMIN_ALERT_TYPES,
  canViewAdminAlertType,
  visibleAdminAlertTypes,
} from './adminAlertCatalog.js'

test('catalog preserves seven existing rules and exposes two authoritative extensions', () => {
  const ready = Object.entries(ADMIN_ALERT_TYPES).filter(([, meta]) => meta.ready).map(([type]) => type)
  assert.deepEqual(ready.sort(), [
    'consecutive_rest', 'deduction_frequency', 'error_spike', 'exam_failed',
    'late_timeout_frequency', 'monthly_leave', 'payout_change',
    'resigned_account_active', 'weekly_absence',
  ].sort())
})

test('five undefined rules remain visible but fail closed as pending', () => {
  const pending = Object.entries(ADMIN_ALERT_TYPES).filter(([, meta]) => !meta.ready)
  assert.deepEqual(pending.map(([type]) => type).sort(), [
    'leave_activity', 'low_workload_streak', 'repeated_error',
    'today_missing_clock_in', 'today_missing_daily_report',
  ].sort())
  pending.forEach(([, meta]) => {
    assert.ok(meta.pendingZh)
    assert.ok(meta.pendingEn)
  })
})

test('type visibility follows the least privilege permission map', () => {
  const examViewer = { permissions:['exam.view'] }
  assert.equal(canViewAdminAlertType(examViewer, 'exam_failed'), true)
  assert.equal(canViewAdminAlertType(examViewer, 'resigned_account_active'), false)
  assert.deepEqual(visibleAdminAlertTypes(examViewer, { readyOnly:true }).map(([type]) => type), ['exam_failed'])

  const accountViewer = { permissions:['account.view'] }
  assert.equal(canViewAdminAlertType(accountViewer, 'resigned_account_active'), true)
  assert.equal(canViewAdminAlertType(accountViewer, 'exam_failed'), false)

  const founder = { founder:true, permissions:[] }
  assert.equal(visibleAdminAlertTypes(founder).length, Object.keys(ADMIN_ALERT_TYPES).length)
})

test('group filter never promotes pending categories into ready RPC filters', () => {
  const access = { permissions:['attendance.view','adjustment.view'] }
  const attendance = visibleAdminAlertTypes(access, { readyOnly:true, group:'attendance' })
  assert.deepEqual(attendance.map(([type]) => type), [
    'late_timeout_frequency', 'consecutive_rest', 'weekly_absence', 'monthly_leave',
  ])
})
