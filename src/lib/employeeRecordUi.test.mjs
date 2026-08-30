import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read=relative=>readFile(new URL(relative,import.meta.url),'utf8')

test('payroll import history has eight compact, clearly separated columns',async()=>{
  const page=await read('../pages/AdminPayrollPage.jsx')
  const styles=await read('../styles-payroll.css')
  const header=page.match(/className="payroll-import-history-columns"[^>]*>(.*?)<\/div>/s)?.[1]||''
  assert.equal((header.match(/<span>/g)||[]).length,8)
  assert.match(header,/导入文档[\s\S]+来源 \/ 批次[\s\S]+工资月份[\s\S]+操作轨迹[\s\S]+人数[\s\S]+总金额[\s\S]+状态[\s\S]+操作/)
  assert.doesNotMatch(header,/导入时间/)
  assert.doesNotMatch(page,/className="payroll-import-time"/)
  assert.match(page,/payroll-import-source"><b><i>来源<\/i>[\s\S]+<small[^>]*><i>批次<\/i>/)
  assert.match(page,/payroll-import-actors"><span><i>导入<\/i>[\s\S]+<i>最近<\/i>/)
  assert.match(styles,/grid-template-columns:minmax\(220px,1\.55fr\)[\s\S]{0,300}min-width:1220px/)
})

test('drawer record tabs expose consistent date and text controls without dropping local rows',async()=>{
  const drawer=await read('../pages/AdminEmployeesPage.jsx')
  const records=await read('../components/ConnectivityRecords.jsx')
  const alerts=await read('../components/AdminAlertCenter.jsx')

  assert.match(drawer,/function EmployeeProfileHistoryFilters[\s\S]+日期起[\s\S]+日期止[\s\S]+搜索/)
  assert.match(drawer,/filterEmployeeErrorHistory\(sourceRows,filters\)/)
  assert.match(drawer,/filterEmployeeExamHistory\(sourceRows,filters\)/)
  assert.match(records,/filterEmployeePayrollHistory\(rows,filters\)/)
  assert.match(records,/const visibleRows=history\.serverMode\?rows:locallyFilteredRows/)
  assert.match(records,/搜索月份、日期、批次、币种、金额或备注/)
  assert.match(alerts,/date_from:'', date_to:'', search:''/)
  assert.match(alerts,/value=\{draft\.date_from\}[\s\S]+value=\{draft\.date_to\}/)
})

test('server-paged tabs keep scoped RPC filtering and fallback tabs only filter loaded data',async()=>{
  const records=await read('../components/ConnectivityRecords.jsx')
  const attendance=await read('../components/AttendanceRecords.jsx')
  const drawer=await read('../pages/AdminEmployeesPage.jsx')
  const alerts=await read('../components/AdminAlertCenter.jsx')

  for(const rpc of [
    'admin_employee_connectivity_history_page',
    'admin_employee_payroll_history_page',
  ])assert.ok(records.includes(rpc),`missing ${rpc}`)
  for(const rpc of [
    'admin_employee_attendance_history_filtered',
    'admin_employee_adjustment_history_filtered',
  ])assert.ok(attendance.includes(rpc),`missing ${rpc}`)
  assert.match(drawer,/当前安全读取最近 \{sourceRows\.length\} \/ 共 \{sourceTotal\}/)
  assert.match(alerts,/admin_alert_center[\s\S]+p_filters: filters/)
  assert.match(alerts,/date_from[\s\S]+date_to/)
})
