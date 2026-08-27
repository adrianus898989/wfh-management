import assert from 'node:assert/strict'
import test from 'node:test'

import {
  employeeMetricCountLabel,
  employeeProfileMetricSeed,
  employeeRiskGradeFromTotal,
  mergeEmployeeDetailRefresh,
  withEmployeeDetailTimeout,
} from './employeeDrawerState.js'

test('employee drawer never presents an unknown total as excellent', () => {
  assert.equal(employeeRiskGradeFromTotal(null), '—')
  assert.equal(employeeRiskGradeFromTotal(undefined), '—')
  assert.equal(employeeRiskGradeFromTotal(''), '—')
  assert.equal(employeeRiskGradeFromTotal(0), '优秀')
  assert.equal(employeeRiskGradeFromTotal(8), '正常')
  assert.equal(employeeRiskGradeFromTotal(9), '注意')
  assert.equal(employeeRiskGradeFromTotal(16), '重点')
  assert.equal(employeeRiskGradeFromTotal(31), '高频')
})

test('employee drawer seeds risk metrics from the already rendered list row', () => {
  assert.deepEqual(employeeProfileMetricSeed({
    id:'employee-1',
    month_error_count:12,
    total_error_count:37,
  }), {
    employee_id:'employee-1',
    month_records:12,
    total_errors:37,
  })
  assert.deepEqual(employeeProfileMetricSeed({id:'employee-2'}), {
    employee_id:'employee-2',
    month_records:null,
    total_errors:null,
  })
})

test('unknown employee metrics stay unknown instead of becoming false zeroes', () => {
  assert.equal(employeeMetricCountLabel(undefined,'笔'), '—')
  assert.equal(employeeMetricCountLabel(null,'次'), '—')
  assert.equal(employeeMetricCountLabel('not-a-number','笔'), '—')
  assert.equal(employeeMetricCountLabel(0,'次'), '0 次')
  assert.equal(employeeMetricCountLabel(12,'笔'), '12 笔')
})

test('partial detail refresh preserves the current employee metrics and successful prior sections', () => {
  const previous={
    employee:{id:'employee-1',month_error_count:7,total_error_count:37,risk_level:'high'},
    contact:{telegram_username:'kept-contact'},
    payment:{bank_wallet_account:'kept-payment'},
    compensation:{base_salary:900},
    resignation_reason:'kept reason',
  }
  const incoming={
    employee:{id:'employee-1',full_name:'Updated Name'},
    contact:null,
    payment:null,
    compensation:null,
    partial_errors:['联系方式','收款资料','工资设置'],
  }
  assert.deepEqual(mergeEmployeeDetailRefresh(previous,incoming),{
    ...incoming,
    employee:{
      ...incoming.employee,
      month_error_count:7,
      total_error_count:37,
      risk_level:'high',
    },
    contact:previous.contact,
    payment:previous.payment,
    compensation:previous.compensation,
    resignation_reason:'kept reason',
  })
})

test('employee detail timeout preserves fast responses and rejects a stalled request', async () => {
  assert.equal(await withEmployeeDetailTimeout(Promise.resolve('ready'),50), 'ready')
  await assert.rejects(
    withEmployeeDetailTimeout(new Promise(()=>{}),10),
    error=>error?.code==='employee_detail_timeout'&&/保留当前可见资料/.test(error.message),
  )
})
