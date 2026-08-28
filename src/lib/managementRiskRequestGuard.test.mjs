import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { withAbortTimeout } from './abortableRequest.js'

const page = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../components/ManagementRiskPanel.jsx', import.meta.url), 'utf8')

test('management risk keeps only the latest pending filters without applying a dropped request', () => {
  assert.match(page, /managementRiskRequestRef=useRef\(\{inFlight:null,activeFilterKey:'',pendingFilters:null\}\)/)
  assert.match(page, /if\(requestState\.inFlight\)\{[\s\S]{0,420}?requestState\.pendingFilters=requestedFilterKey===requestState\.activeFilterKey[\s\S]{0,180}?return requestState\.inFlight/)
  assert.match(page, /while\(activeFilters\)\{[\s\S]{0,400}?setAppliedManagementRiskFilters\(activeFilters\)/)

  const handlers = page.slice(
    page.indexOf('const applyManagementRiskFilters='),
    page.indexOf('const changeAnalysisView='),
  )
  assert.doesNotMatch(handlers, /setAppliedManagementRiskFilters/)
  assert.match(handlers, /loadManagementRisk\(next\)/)
})

test('management risk RPC has one abortable 12 second attempt and no automatic retry', () => {
  const loader = page.slice(
    page.indexOf('const loadManagementRisk='),
    page.indexOf('const loadResignationAnalytics='),
  )
  assert.match(page, /const MANAGEMENT_RISK_REQUEST_TIMEOUT_MS=12\*1000/)
  assert.match(loader, /withAbortTimeout\([\s\S]{0,140}?signal=>supabase\.rpc\('admin_employee_management_risk'/)
  assert.match(loader, /\}\)\.abortSignal\(signal\)/)
  assert.match(loader, /'MANAGEMENT_RISK_TIMEOUT'/)
  assert.match(loader, /读取超过12秒，已停止本次请求；筛选条件已保留，请手动重试/)
  assert.equal(loader.match(/supabase\.rpc\('admin_employee_management_risk'/g)?.length, 1)
})

test('abort timeout cancels the underlying attempt without retrying it', async () => {
  let calls = 0
  let observedSignal
  await assert.rejects(
    withAbortTimeout(signal => {
      calls += 1
      observedSignal = signal
      return new Promise(() => {})
    }, 5, 'MANAGEMENT_RISK_TIMEOUT'),
    error => error?.code === 'MANAGEMENT_RISK_TIMEOUT',
  )
  assert.equal(calls, 1)
  assert.equal(observedSignal?.aborted, true)
})

test('management methodology is explained in plain language instead of exposing formulas', () => {
  assert.match(panel, /四项合成 0–100 关注分/)
  assert.match(panel, /时标记“样本不足”/)
  assert.doesNotMatch(panel, /Object\.values\(value\).*join\('；'\)/)
})
