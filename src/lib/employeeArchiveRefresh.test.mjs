import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
const edgeFunction = await readFile(new URL('../../supabase/functions/admin-employees/index.ts', import.meta.url), 'utf8')

test('employee archive refresh does not start the expensive analytics request', () => {
  const refreshStart = page.indexOf('const refreshEmployeeData=async')
  const refreshEnd = page.indexOf('refreshEmployeeDataRef.current=refreshEmployeeData', refreshStart)
  assert.ok(refreshStart > 0 && refreshEnd > refreshStart)
  const refreshSource = page.slice(refreshStart, refreshEnd)

  assert.match(refreshSource, /tab==='员工档案'[^\n]+loadList/)
  assert.doesNotMatch(refreshSource, /loadAnalytics\(/)
  assert.match(refreshSource, /tab==='人员分析'[\s\S]+loadPeopleAnalytics/)
})

test('the first unfiltered analytics result is reused instead of requested twice', () => {
  const peopleStart = page.indexOf('const loadPeopleAnalytics=async')
  const peopleEnd = page.indexOf('const loadResignationAnalytics=async', peopleStart)
  assert.ok(peopleStart > 0 && peopleEnd > peopleStart)
  const peopleSource = page.slice(peopleStart, peopleEnd)

  assert.match(peopleSource, /if\(!hasFilterValues\(nextFilters\)\)/)
  assert.match(peopleSource, /setAnalytics\(\{\.\.\.data,loading:false,error:''\}\)/)
  assert.match(peopleSource, /setResignationAnalytics\(\{\.\.\.data,loading:false,error:''\}\)/)
})

test('archive filters use lightweight metadata and expose the Edge response body', () => {
  assert.match(page, /employee-team-filter[\s\S]*?meta\.teams|meta\.teams[\s\S]*?employee-team-filter/)
  assert.match(page, /employee-position-filter[\s\S]*?meta\.positions|meta\.positions[\s\S]*?employee-position-filter/)
  assert.match(page, /edgeFunctionErrorMessage\(\{data,error,fallback:'操作失败'\}\)/)
  assert.doesNotMatch(page, /data\?\.error\|\|error\?\.message\|\|'操作失败'/)
})

test('employee archive starts at 20 rows and keeps loaded rows visible during a failed refresh', () => {
  assert.match(page, /const \[pageSize,setPageSizeState\]=useState\(20\)/)
  assert.doesNotMatch(page, /wfh_employee_page_size/)

  const listStart = page.indexOf('const loadList=async')
  const listEnd = page.indexOf('const loadHistory=async', listStart)
  const listSource = page.slice(listStart, listEnd)
  assert.match(listSource, /setError\(employeeRequestError\(e,rows\.length\?'员工档案刷新失败，已保留当前列表，请稍后重试。':'员工档案读取失败，请稍后重试。'\)\)/)
  assert.doesNotMatch(listSource, /setRows\(\[\]\)/)
  assert.match(page, /loading&&rows\.length===0\?<div className="empty-state">读取中\.\.\.<\/div>/)
})

test('employee Edge Function failures identify the action in logs and responses', () => {
  assert.match(edgeFunction, /let requestAction = "unknown"/)
  assert.match(edgeFunction, /requestAction = action/)
  assert.match(edgeFunction, /console\.error\(JSON\.stringify\(\{ function:"admin-employees", action:requestAction, message \}\)\)/)
  assert.match(edgeFunction, /return json\(\{ error:message, action:requestAction \},400\)/)
})
