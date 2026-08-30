import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { withAbortTimeout } from './abortableRequest.js'

const page = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../components/ManagementRiskPanel.jsx', import.meta.url), 'utf8')
const boundedRankingMigration = await readFile(
  new URL('../../supabase/migrations/20260830154500_management_risk_bounded_rankings.sql', import.meta.url),
  'utf8',
)

test('management risk keeps only the latest pending filters without applying a dropped request', () => {
  assert.match(page, /managementRiskRequestRef=useRef\(\{inFlight:null,activeFilterKey:'',pendingFilters:null\}\)/)
  assert.match(page, /if\(requestState\.inFlight\)\{[\s\S]{0,420}?requestState\.pendingFilters=requestedFilterKey===requestState\.activeFilterKey[\s\S]{0,180}?return requestState\.inFlight/)
  assert.match(page, /while\(activeFilters\)\{[\s\S]{0,400}?setAppliedManagementRiskFilters\(activeFilters\)/)

  const handlers = page.slice(
    page.indexOf('const applyManagementRiskFilters='),
    page.indexOf('const changeAnalysisView='),
  )
  assert.doesNotMatch(handlers, /setAppliedManagementRiskFilters/)
  assert.match(handlers, /loadManagementRisk\(next,\{force:true\}\)/)
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

test('management risk only reuses a short-lived component-local successful response', () => {
  const loader = page.slice(
    page.indexOf('const loadManagementRisk='),
    page.indexOf('const loadResignationAnalytics='),
  )
  assert.match(page, /const MANAGEMENT_RISK_CACHE_TTL_MS=60\*1000/)
  assert.match(page, /const managementRiskCacheRef=useRef\(new Map\(\)\)/)
  assert.match(loader, /requestedCacheKey=JSON\.stringify\(\[employeeAccessKey,requestedFilters,50\]\)/)
  assert.match(loader, /if\(!force\)\{[\s\S]{0,420}?cachedAt<MANAGEMENT_RISK_CACHE_TTL_MS/)
  assert.match(loader, /if\(error\|\|data\?\.error\) throw[\s\S]{0,420}?cache\.set\(activeCacheKey,\{cachedAt:Date\.now\(\),data\}\)/)
  assert.match(page, /employeeDirectoryRequestRef\.current\.pending=null\s+managementRiskCacheRef\.current\.clear\(\)/)
  assert.match(page, /loadManagementRisk\(next,\{force:true\}\)/)
})

test('management risk keeps complete filter options but bounds high-cardinality rankings', () => {
  assert.match(boundedRankingMigration, /partition by scored\.dimension/)
  assert.match(boundedRankingMigration, /metric\.dimension=''group'' and metric\.organization_rank<=v_top_limit/)
  assert.match(boundedRankingMigration, /metric\.dimension=''manager'' and metric\.organization_rank<=v_top_limit/)
  assert.match(boundedRankingMigration, /option_groups as materialized/)
  assert.match(boundedRankingMigration, /option_managers as materialized/)
  assert.doesNotMatch(boundedRankingMigration, /option_(?:groups|managers)[\s\S]{0,300}?organization_rank<=v_top_limit/)
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
