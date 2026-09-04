import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8')

const [assets, activity, reports, staffPayroll, portal, connectivity] = await Promise.all([
  source('../pages/AdminCompanyAssetsPage.jsx'),
  source('../pages/AdminActivityLogPage.jsx'),
  source('../pages/AdminReportsPage.jsx'),
  source('../pages/StaffPayrollPage.jsx'),
  source('../pages/PortalPage.jsx'),
  source('../components/ConnectivityRecords.jsx'),
])

test('remaining admin reads announce only explicit operations', () => {
  assert.match(assets, /const load = async \(\{ announce=false \}=\{\}\) =>/)
  assert.match(assets, /onClick=\{\(\)=>load\(\{ announce:true \}\)\}/)
  assert.match(activity, /const readIntentRef=useRef\(''\)/)
  assert.match(activity, /readIntentRef\.current='刷新操作日志'/)
  assert.match(reports, /onClick=\{\(\)=>load\(false,'刷新统计数据'\)\}/)
  assert.match(reports, /useEffect\(\(\)=>\{load\(currentMonthRange\(\)\)\},\[\]\)/)
})

test('remaining write failures never replay mutations', () => {
  assert.match(connectivity, /operation:editor==='edit'\?'保存修改':'新增记录'/)
  assert.match(connectivity, /refresh:\(\)=>\{const current=activeQueryRef\.current;return load\(current\.page,current\.pageSize,current\.applied,'刷新记录列表'\)\}/)
  assert.doesNotMatch(connectivity, /refresh:\(\)=>save/)
  assert.doesNotMatch(connectivity, /refresh:\(\)=>confirmDelete/)
})

test('staff portal and payroll keep automatic loads quiet and expose safe read retries', () => {
  assert.match(portal, /const load = async \(announce=false\) =>/)
  assert.match(portal, /useEffect\(\(\) => \{ load\(\) \}, \[\]\)/)
  assert.match(portal, /onClick=\{\(\)=>load\(true\)\}/)
  assert.match(portal, /const readIntentRef=useRef\(''\)/)
  assert.match(staffPayroll, /const detailIntentRef=useRef\(''\)/)
  assert.match(staffPayroll, /setDetailRefreshKey\(value=>value\+1\)/)
  assert.match(staffPayroll, /if\(requestedOperation\)notify\(writeFailureToast/)
})

test('explicit report and connectivity reads preserve inline errors and offer read-only refresh', () => {
  assert.match(reports, /onError\(reason\)/)
  assert.match(reports, /refresh:\(\)=>load\(\{nextRange,nextFilters,nextSort,nextPage,nextSize,announceOperation\}\)/)
  assert.match(connectivity, /setFormError\(reason\)/)
  assert.match(connectivity, /setDeleteError\(reason\)/)
  assert.match(connectivity, /activateAndLoad\(1,pageSize,next,'查询记录'\)/)
})
