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

test('employee Edge Function failures identify the action in logs and responses', () => {
  assert.match(edgeFunction, /let requestAction = "unknown"/)
  assert.match(edgeFunction, /requestAction = action/)
  assert.match(edgeFunction, /console\.error\(JSON\.stringify\(\{ function:"admin-employees", action:requestAction, message \}\)\)/)
  assert.match(edgeFunction, /return json\(\{ error:message, action:requestAction \},400\)/)
})
