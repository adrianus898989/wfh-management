import test from 'node:test'
import assert from 'node:assert/strict'
import { adminAlertEmployeeTarget, adminAlertTarget } from './adminAlertRoutes.js'

test('warning links include the tab required by the admin route guard', () => {
  assert.equal(new URL(adminAlertTarget('weekly_absence'), 'https://wfh.local').searchParams.get('tab'), '预警记录')
  assert.equal(new URL(adminAlertTarget('payout_change'), 'https://wfh.local').searchParams.get('tab'), '收款资料审核')
})

test('employee links keep the warning tab visible and open the selected employee drawer', () => {
  const target = new URL(adminAlertEmployeeTarget('employee / 42'), 'https://wfh.local')
  assert.equal(target.pathname, '/admin/employees')
  assert.equal(target.searchParams.get('tab'), '预警记录')
  assert.equal(target.searchParams.get('employee'), 'employee / 42')
})
