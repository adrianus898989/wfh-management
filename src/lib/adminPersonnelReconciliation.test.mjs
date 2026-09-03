import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  PERSONNEL_RECONCILIATION_VIEWS,
  normalizePersonnelReconciliationResponse,
  personnelReconciliationConfirmationLabel,
  personnelReconciliationErrorMessage,
  personnelReconciliationIssueLabel,
  personnelReconciliationOnsiteAccepted,
  personnelReconciliationOnsiteLabel,
  personnelReconciliationReasonLabel,
  personnelReconciliationSearch,
} from './adminPersonnelReconciliation.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = path => fs.readFileSync(new URL(path, `file://${root}/`), 'utf8')

test('normalizes the bounded reconciliation RPC contract without inventing missing counts', () => {
  const result = normalizePersonnelReconciliationResponse({
    contract_version:1,
    view:'headcount',
    rows:[
      { row_key:'master-only:1', employee_no:'CJ00001' },
      { issue_id:'name-fallback:1', employee_no:'CJ00002', employee_name:'Fallback Name' },
    ],
    total:61,
    page:2,
    pages:3,
    page_size:30,
    summary:{
      dashboard_active:1114,
      effective_active:1114,
      dashboard_effective_active:1114,
      directory_effective_active:1113,
      directory_total:1116,
      schedule_unique_total:1116,
      report_total:1116,
      headcount_total:4,
      issue_total:28,
      onsite_total:50,
    },
    freshness:{ run_id:42, captured_at:'2026-09-03T10:00:00Z', home_rows:3614, schedule_rows:1116, report_source:'居家排班表/填表', report_synced_at:'2026-09-03T10:01:00Z', report_rows:1116, report_is_stale:false, report_age_seconds:10, is_stale:false, age_seconds:15 },
  }, 'headcount', 30)

  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[1].full_name, 'Fallback Name')
  assert.equal(result.total, 61)
  assert.equal(result.page, 2)
  assert.equal(result.summary.dashboard_effective_active, 1114)
  assert.equal(result.summary.dashboard_active, 1114)
  assert.equal(result.summary.effective_active, 1114)
  assert.equal(result.summary.directory_effective_active, 1113)
  assert.equal(result.summary.directory_total, 1116)
  assert.equal(result.summary.schedule_unique_total, 1116)
  assert.equal(result.summary.report_total, 1116)
  assert.equal(result.summary.headcount_total, 4)
  assert.equal(result.summary.issue_total, 28)
  assert.equal(result.summary.onsite_total, 50)
  assert.equal(result.freshness.run_id, '42')
  assert.equal(result.freshness.schedule_rows, 1116)
  assert.equal(result.freshness.report_rows, 1116)

  const incomplete = normalizePersonnelReconciliationResponse({ view:'issues' }, 'issues', 30)
  assert.equal(incomplete.summary.dashboard_effective_active, null)
  assert.equal(incomplete.summary.issue_total, null)
  assert.equal(incomplete.pages, 1)
})

test('view, search and page bounds follow the RPC contract', () => {
  assert.deepEqual(PERSONNEL_RECONCILIATION_VIEWS.map(item => item.key), ['headcount', 'issues', 'onsite'])
  assert.deepEqual(PERSONNEL_RECONCILIATION_VIEWS.map(item => item.label), ['人数差异', '来源待核对', '现场人员'])
  assert.deepEqual(PERSONNEL_RECONCILIATION_VIEWS.map(item => item.unit), ['人', '项', '人'])
  assert.equal(personnelReconciliationSearch(`  ${'人'.repeat(130)}  `).length, 120)
  const result = normalizePersonnelReconciliationResponse({ view:'unknown', page_size:500, page:-1 }, 'onsite', 30)
  assert.equal(result.view, 'onsite')
  assert.equal(result.pageSize, 50)
  assert.equal(result.page, 1)

  const missingNumbers = normalizePersonnelReconciliationResponse({
    page:null,
    page_size:'   ',
    total:false,
    summary:{ headcount_total:'', issue_total:null, onsite_total:undefined },
    freshness:{ age_seconds:' ' },
  }, 'headcount', 30)
  assert.equal(missingNumbers.page, 1)
  assert.equal(missingNumbers.pageSize, 30)
  assert.equal(missingNumbers.total, 0)
  assert.equal(missingNumbers.summary.headcount_total, null)
  assert.equal(missingNumbers.summary.issue_total, null)
  assert.equal(missingNumbers.freshness.age_seconds, null)
})

test('reason and onsite labels clearly separate accepted staff from actionable differences', () => {
  assert.equal(personnelReconciliationReasonLabel({ reason_code:'master_only_missing_schedule' }), '员工主档在职，但当前排班没有')
  assert.equal(personnelReconciliationReasonLabel({ issue_code:'cross_source_name_mismatch' }), '两份员工来源姓名不一致')
  assert.equal(personnelReconciliationOnsiteLabel({ confirmed_onsite:true }), '已确认现场人员')
  assert.equal(personnelReconciliationOnsiteLabel({ managed_external:true }), '管理范围内外部人员')
  assert.equal(personnelReconciliationOnsiteLabel({ classification:'onsite_marker' }), '源表标记现场人员')
  assert.equal(personnelReconciliationOnsiteAccepted({ classification:'onsite_marker' }), true)
  assert.equal(personnelReconciliationOnsiteAccepted({ classification:'schedule_backfill' }), false)
  assert.equal(personnelReconciliationConfirmationLabel('source_sheet_marker'), 'Google 排班现场标记')
  assert.equal(personnelReconciliationConfirmationLabel('internal_new_token'), '已记录确认依据')
  assert.equal(personnelReconciliationReasonLabel({ issue_code:'schedule_backfill_requires_review' }), '排班补录身份需核对')
  assert.equal(personnelReconciliationReasonLabel({ reason_code:'private_internal_token' }), '待核对')
  assert.equal(personnelReconciliationIssueLabel({ issue_code:'private_internal_token' }), '来源差异')
  assert.equal(personnelReconciliationOnsiteLabel({ classification:'private_internal_token' }), '现场身份待确认')
})

test('permission, session, timeout and network failures use actionable Chinese copy', () => {
  assert.match(personnelReconciliationErrorMessage({ code:'42501', message:'permission_denied' }), /没有“人员对账”查看权限/)
  assert.match(personnelReconciliationErrorMessage({ message:'session_not_current' }), /重新登录/)
  assert.match(personnelReconciliationErrorMessage({ code:'57014', message:'canceling statement due to statement timeout' }), /读取超时/)
  assert.match(personnelReconciliationErrorMessage({ message:'Failed to fetch' }), /网络暂时不稳定/)
  assert.match(personnelReconciliationErrorMessage({}, { timedOut:true }), /保留上次结果/)
  assert.equal(
    personnelReconciliationErrorMessage({ message:'relation private.secret_table does not exist' }),
    '人员对账暂时无法读取，已保留上次结果，请稍后重试。',
  )
})

test('standalone page calls one server-paged RPC and preserves old rows while refreshing', () => {
  const page = read('src/pages/AdminReconciliationPage.jsx')
  assert.match(page, /supabase\.rpc\('admin_personnel_reconciliation'/)
  assert.match(page, /p_view:view/)
  assert.match(page, /p_filters:\{ search:personnelReconciliationSearch\(search\) \}/)
  assert.match(page, /p_page:page/)
  assert.match(page, /p_page_size:size/)
  assert.match(page, /\[view\]:\{ \.\.\.current\[view\], loading:true, error:'' \}/)
  assert.match(page, /当前保留显示上次结果/)
  assert.match(page, /requestRefs\.current\[view\]/)
  assert.match(page, /metadataRequestId === metadataRequestRef\.current/)
  assert.match(page, /successfulViewsRef\.current\.add\(view\)/)
  assert.match(page, /requestRefs\.current\[activeView\] = \(requestRefs\.current\[activeView\] \|\| 0\) \+ 1/)
  assert.match(page, /activeController\.abort\(\)/)
  assert.match(page, /\[activeView\]:\{ \.\.\.current\[activeView\], loading:false \}/)
  assert.match(page, /if \(!successfulViewsRef\.current\.has\(view\)\) \{[\s\S]*?void load\(\{ view, page:1, size:pageSize, search:appliedSearch \}\)/)
  assert.match(page, /!result\.rows\.length && result\.total > 0 && result\.page < page/)
  assert.match(page, /dashboard_effective_active/)
  assert.match(page, /directory_effective_active/)
  assert.match(page, /directory_total/)
  assert.match(page, /员工档案当前目录/)
  assert.match(page, /当前排班映射出的系统员工档案/)
  assert.match(page, /report_total/)
  assert.match(page, /report_synced_at/)
  assert.match(page, /reportAgeSeconds !== null && reportAgeSeconds \* 1000 >= FRESHNESS_STALE_AFTER_MS/)
  assert.match(page, /headcount_total/)
  assert.match(page, /重新读取结果/)
  assert.match(page, /activeView === 'onsite'[\s\S]*?团队 \/ 岗位 \/ 班次/)
  assert.match(page, /Google《居家员工名单》/)
  assert.match(page, /汇总表排班/)
  assert.match(page, /row\.in_report/)
  assert.match(page, /员工同步排班/)
  assert.match(page, /员工档案页/)
  assert.match(page, /row\.in_employee_page/)
  assert.match(page, /report_person_keys/)
  assert.doesNotMatch(page, /JSON\.stringify\(row|row\.details/)
  assert.doesNotMatch(page, /<small>\{row\.confirmation\}<\/small>/)
  assert.doesNotMatch(page, /<code>\{row\.(?:reason_code|issue_code)/)
  assert.doesNotMatch(page, /center-screen|window\.location\.reload/)
})

test('page styles stay scoped and retain a compact responsive table', () => {
  const styles = read('src/styles-reconciliation.css')
  assert.match(styles, /\.reconciliation-page/)
  assert.match(styles, /\.recon-summary-grid/)
  assert.match(styles, /\.recon-table-scroll/)
  assert.match(styles, /@media\(max-width:700px\)/)
  assert.match(styles, /pagination-number-list/)
  assert.match(styles, /\.recon-table th:first-child/)
  assert.doesNotMatch(styles, /(^|[},])\s*(?:body|html|table|button|input)\s*\{/m)
})
