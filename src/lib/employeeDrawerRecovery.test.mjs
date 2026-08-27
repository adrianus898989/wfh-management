import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pageUrl=new URL('../pages/AdminEmployeesPage.jsx',import.meta.url)
const edgeUrl=new URL('../../supabase/functions/admin-employees/index.ts',import.meta.url)
const connectivityUrl=new URL('../components/ConnectivityRecords.jsx',import.meta.url)

test('employee drawer shows its seeded row while full detail is still loading', async () => {
  const source=await readFile(pageUrl,'utf8')
  const connectivitySource=await readFile(connectivityUrl,'utf8')
  const drawer=source.slice(source.indexOf('export function EmployeeDrawer'),source.indexOf('function EmployeeTrainerReviewPanel'))

  assert.doesNotMatch(source,/getAllErrorSummaryMap/)
  assert.match(source,/withEmployeeDetailTimeout\(invoke\(\{action:'detail'/)
  assert.match(source,/month_error_count:row\.month_error_count/)
  assert.match(drawer,/EmployeeProfileMetrics data=\{visibleProfileSummary\}/)
  assert.match(drawer,/已先显示员工基础资料/)
  assert.match(drawer,/onClick=\{onRetry\}>重新读取/)
  assert.match(source,/employeeDetailPartialError\(detail\)/)
  assert.match(source,/const selectedEmployeeId=text\(selected\.employee\.id\)/)
  assert.match(source,/const detailRequestId=detailRequestRef\.current/)
  assert.match(source,/selectedEmployeeIdRef\.current!==selectedEmployeeId/)
  assert.match(source,/detailRequestRef\.current!==detailRequestId\|\|text\(prev\?\.employee\?\.id\)!==selectedEmployeeId/)
  assert.match(source,/mergeEmployeeDetailRefresh\(prev,d\)/)
  assert.match(source,/setDetailError\(employeeDetailPartialError\(d\)\)/)
  assert.match(connectivitySource,/employeeMetricCountLabel\(data\?\.month_records,'\u7b14'\)/)
  assert.match(connectivitySource,/employeeMetricCountLabel\(data\?\.exam_attempts,'\u6b21'\)/)
  assert.doesNotMatch(connectivitySource,/Number\(data\?\.exam_attempts\|\|0\)/)
  assert.match(drawer,/employee-drawer-tabs/)
  assert.doesNotMatch(drawer,/loading\?<div className="empty-state">读取完整档案/)
})

test('employee detail resolves permission decisions in one bounded batch', async () => {
  const source=await readFile(edgeUrl,'utf8')
  const detailStart=source.indexOf('if (action === "detail")')
  const detail=source.slice(detailStart,source.indexOf('if (action === "history_list")',detailStart))

  assert.match(source,/async function permissionDecisionBatch/)
  assert.match(source,/from\("permissions"\)[\s\S]*?\.in\("code",uniqueCodes\)/)
  assert.match(source,/from\("user_permission_overrides"\)[\s\S]*?\.in\("permission_id",permissionIds\)/)
  assert.match(source,/from\("role_permissions"\)[\s\S]*?\.in\("permission_id",permissionIds\)/)
  assert.match(detail,/permissionDecisionBatch\(service,caller,detailPermissionCodes\)/)
  assert.match(detail,/permissionAllowedFromBatch/)
  assert.match(detail,/partial_errors:partialErrors/)
  assert.match(detail,/!portalResult\.error/)
  assert.doesNotMatch(detail,/permissionAllowed\(service,caller/)
  assert.doesNotMatch(detail,/permissionAllowedFirstDefined\(service,caller/)
})
