import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const employeePage = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
const stableLayout = await readFile(new URL('../stable-layout-hotfix.css', import.meta.url), 'utf8')

test('employee directory columns use semantic classes so the optional note checkbox cannot shift widths', () => {
  for (const column of [
    'level','id','name','country','team','trainer','position','shift','type','hire-date',
    'tenure','created','operator','profile','account','action',
  ]) {
    assert.match(employeePage, new RegExp(`className="employee-col-${column}"`), `missing semantic ${column} column`)
    assert.match(stableLayout, new RegExp(`\\.employee-master-table \\.employee-col-${column}`), `missing ${column} width rule`)
  }
  assert.doesNotMatch(stableLayout, /\.employee-master-table\s+(?:th|td):nth-child\(/)
  assert.match(employeePage, /canManagePrivateNotes&&<th className="employee-note-select-cell"/)
  assert.match(employeePage, /canManagePrivateNotes&&<td className="employee-note-select-cell"/)
})

test('employee name has one compact full-name line with a native full-value tooltip', () => {
  assert.match(employeePage, /<td className="employee-col-name"><span className="employee-name-value" title=\{r\.full_name\}>\{r\.full_name\}<\/span><\/td>/)
  assert.match(stableLayout, /\.employee-master-table \.employee-name-value\{[\s\S]*text-overflow:ellipsis!important;[\s\S]*white-space:nowrap!important;/)
  assert.doesNotMatch(employeePage, /employee-name-(?:secondary|alias)/)
  assert.match(stableLayout, /\.employee-master-table\{min-width:1320px!important;table-layout:fixed!important;\}/)
})

test('authorized note deletion stays permission-gated and uses the existing audited archive RPC', () => {
  assert.match(employeePage, /\{canManage&&<div><button/)
  assert.match(employeePage, /onClick=\{\(\)=>remove\(note\)\}>删除<\/button>/)
  assert.match(employeePage, /supabase\.rpc\('admin_employee_private_note_archive'/)
  assert.doesNotMatch(employeePage, /admin_employee_private_note_delete/)
  assert.match(employeePage, /备注已删除，操作记录和修改历史仍保留。/)
  assert.match(employeePage, /const actionLabel=\{create:'新增',update:'修改',archive:'删除'\}/)
  assert.doesNotMatch(employeePage, /仅授权后台账号可见；所有修改均保留操作账号、时间和版本。/)
})
