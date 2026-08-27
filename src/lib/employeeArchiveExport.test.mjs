import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  EMPLOYEE_ARCHIVE_EXPORT_COLUMNS,
  employeeArchiveCsv,
  employeeArchiveExportFilename,
} from './employeeArchiveExport.js'

test('employee archive CSV includes the visible directory fields and an Excel UTF-8 BOM', () => {
  const csv = employeeArchiveCsv([{
    employee_no: 'CS000123',
    full_name: 'Alice, "Quality"',
    risk_label: '正常',
    total_error_count: 2,
    work_tg: '@alice',
  }])

  assert.equal(csv.charCodeAt(0), 0xfeff)
  assert.match(csv, /"等级","累计错误","员工ID","姓名"/)
  assert.match(csv, /"CS000123","Alice, ""Quality"""/)
  assert.match(csv, /"'@alice"/)
  assert.ok(EMPLOYEE_ARCHIVE_EXPORT_COLUMNS.some(([key, label]) => key === 'operator_account' && label === '操作人账号'))
  assert.ok(EMPLOYEE_ARCHIVE_EXPORT_COLUMNS.some(([key, label]) => key === 'account_status' && label === '员工端账号'))
})

test('employee archive export filename is deterministic and date based', () => {
  assert.equal(employeeArchiveExportFilename(new Date(2026, 7, 27)), '员工档案_当前筛选_2026-08-27.csv')
})

test('employee archive exports every page for the applied filters and keeps the current table intact on failure', async () => {
  const page = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
  const start = page.indexOf('const exportEmployeeArchive=async')
  const end = page.indexOf('const pages=', start)
  assert.ok(start > 0 && end > start)
  const source = page.slice(start, end)

  assert.match(source, /fetchEmployeeListData\(nextPage,EMPLOYEE_EXPORT_PAGE_SIZE,appliedFilters,true\)/)
  assert.match(source, /while\(nextPage<=expectedPages\)/)
  assert.match(source, /loadOperatorMap\(visibleRows\.map\(row=>row\.id\)\)/)
  assert.match(source, /employeeArchiveCsv\(exportRows\)/)
  assert.doesNotMatch(source, /setRows\(/)
  assert.match(page, /导出当前筛选/)
})
