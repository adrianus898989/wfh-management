import test from 'node:test'
import assert from 'node:assert/strict'
import { requestedAdminRoute } from '../config/navigation.js'
import { adminAlertEmployeeTarget, adminAlertTarget } from './adminAlertRoutes.js'

test('warning links generate English tabs accepted by the admin route guard', () => {
  const warning = new URL(adminAlertTarget('weekly_absence'), 'https://wfh.local')
  const payout = new URL(adminAlertTarget('payout_change'), 'https://wfh.local')

  assert.equal(warning.searchParams.get('tab'), 'alerts')
  assert.equal(payout.searchParams.get('tab'), 'payment-change-history')
  assert.ok(requestedAdminRoute(warning.pathname, warning.search))
  assert.ok(requestedAdminRoute(payout.pathname, payout.search))
})

test('employee links keep the warning tab visible and open the selected employee drawer', () => {
  const target = new URL(adminAlertEmployeeTarget('employee / 42'), 'https://wfh.local')
  assert.equal(target.pathname, '/admin/employees')
  assert.equal(target.searchParams.get('tab'), 'alerts')
  assert.equal(target.searchParams.get('employee'), 'employee / 42')
})

test('old Chinese warning bookmarks remain accepted after generated links move to English', () => {
  assert.ok(requestedAdminRoute('/admin/employees', '?tab=%E9%A2%84%E8%AD%A6%E8%AE%B0%E5%BD%95'))
  assert.ok(requestedAdminRoute('/admin/payroll', '?tab=%E7%94%B3%E8%AF%B7%E8%AE%B0%E5%BD%95'))
})
