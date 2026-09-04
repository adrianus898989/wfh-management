import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  EMPLOYEE_PORTAL_ACCOUNT_STATE,
  employeePortalAccountPresentation,
  employeePortalAccountState,
} from './employeeAccountStatus.js'

test('employee portal account status distinguishes provisioning from enabled state', () => {
  assert.equal(employeePortalAccountState({ account_opened:false }), EMPLOYEE_PORTAL_ACCOUNT_STATE.NOT_OPENED)
  assert.equal(employeePortalAccountState({ account_opened:true, account_active:true }), EMPLOYEE_PORTAL_ACCOUNT_STATE.ENABLED)
  assert.equal(employeePortalAccountState({ account_opened:true, account_active:false }), EMPLOYEE_PORTAL_ACCOUNT_STATE.DISABLED)
})

test('a disabled account remains opened and cannot receive a second activation code', () => {
  assert.deepEqual(employeePortalAccountPresentation({ account_opened:true, account_active:false }), {
    state:EMPLOYEE_PORTAL_ACCOUNT_STATE.DISABLED,
    label:'已停用',
    className:'status-chip off',
    canGenerateActivationCode:false,
  })
})

test('employee list endpoints derive opened state from portal mapping, not active flag', async () => {
  const sources = await Promise.all([
    readFile(new URL('../../supabase/functions/admin-employees/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/functions/admin-employee-risk-list/index.ts', import.meta.url), 'utf8'),
  ])
  for (const source of sources) {
    assert.match(source, /account_opened:/)
    assert.match(source, /account_active:/)
  }
  assert.match(sources[0], /readRelatedRowsInBatches\(service,"user_access","employee_id,employee_portal_enabled,active"/)
  const riskAccountQuery = sources[1].slice(
    sources[1].indexOf('loadRowsByValues(employeeIds'),
    sources[1].indexOf('const summaryMap'),
  )
  assert.match(riskAccountQuery, /employee_portal_enabled/)
  assert.match(riskAccountQuery, /\.in\('employee_id', group\)/)
  assert.doesNotMatch(riskAccountQuery, /\.eq\('active', true\)/)
})
