import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { LEGACY_ERROR_TABLE_SELECTOR, legacyErrorTables } from './legacyErrorTableScope.js'

test('legacy 错误增强器只选择错误统计表，员工档案 DOM 保持原列结构', () => {
  const employeeTable = {
    classes: ['employee-master-table'],
    headers: ['等级', '员工ID', '姓名'],
    rows: [['重点', 'CJ00007', 'Dohren']],
  }
  const errorTable = {
    classes: ['rp-errors-table'],
    headers: ['员工ID', '错误类型'],
    rows: [['CJ00007', '迟到']],
  }
  const queried = []
  const root = {
    querySelectorAll(selector) {
      queried.push(selector)
      return selector === LEGACY_ERROR_TABLE_SELECTOR ? [errorTable] : []
    },
  }

  for (const table of legacyErrorTables(root)) {
    table.headers.unshift('等级')
    table.rows.forEach(row => row.unshift('优秀'))
  }

  assert.deepEqual(queried, ['.rp-errors-table'])
  assert.equal(employeeTable.headers.length, employeeTable.rows[0].length)
  assert.equal(employeeTable.headers.filter(value => value === '等级').length, 1)
  assert.equal(employeeTable.rows[0].filter(value => value === '重点').length, 1)
  assert.deepEqual(employeeTable.rows[0].slice(1), ['CJ00007', 'Dohren'])
})

test('员工档案原生表头与数据行列数一致，等级只渲染一次', async () => {
  const enhancerSource = await readFile(new URL('../stableErrorUiEnhancer.js', import.meta.url), 'utf8')
  assert.doesNotMatch(enhancerSource, /employee-master-table/)
  assert.match(enhancerSource, /legacyErrorTables\(document\)/)

  const pageSource = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
  const tableStart = pageSource.indexOf('<table className="data-table employee-master-table">')
  const tableEnd = pageSource.indexOf('</table>', tableStart)
  assert.notEqual(tableStart, -1)
  assert.notEqual(tableEnd, -1)
  const tableSource = pageSource.slice(tableStart, tableEnd)
  const headerSource = tableSource.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/)?.[1] || ''
  const rowSource = tableSource.match(/return <tr key=\{r\.id\}>([\s\S]*?)<\/tr>/)?.[1] || ''
  const headerCount = (headerSource.match(/<th\b/g) || []).length
  const rowCount = (rowSource.match(/<td\b/g) || []).length

  assert.ok(headerCount > 0)
  assert.equal(headerCount, rowCount)
  assert.equal((headerSource.match(/<th>等级<\/th>/g) || []).length, 1)
  assert.equal((rowSource.match(/employee-risk-badge/g) || []).length, 1)
  assert.match(pageSource, /normal:\{zh:'正常',en:'Normal'/)
  assert.match(rowSource, /data-admin-i18n-skip/)
  assert.match(rowSource, /risk\[locale\]\|\|risk\.zh/)

  const listNormalizeStart = pageSource.indexOf('const applyEmployeeListData=async')
  const normalizedStart = listNormalizeStart === -1
    ? pageSource.indexOf('const applyEmployeeListData=')
    : listNormalizeStart
  const listNormalizeEnd = pageSource.indexOf('const executeEmployeeDirectoryRequest=async', normalizedStart)
  const listNormalizeSource = pageSource.slice(normalizedStart, listNormalizeEnd)
  assert.doesNotMatch(listNormalizeSource, /getAllErrorSummaryMap/)
  assert.match(listNormalizeSource, /total_error_count:totalErrorCount/)
  assert.match(listNormalizeSource, /risk_level:riskKeyFromCount\(totalErrorCount\)/)

  const endpointSource = await readFile(new URL('../../supabase/functions/admin-employees/index.ts', import.meta.url), 'utf8')
  assert.match(endpointSource, /from\("employee_error_summary"\)/)
  assert.match(endpointSource, /risk_level:employeeRiskKey\(totalErrorCount\)/)
})
