import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  filterPayrollBatches,
  payrollBatchIdentity,
  payrollBatchLifecycleState,
  payrollBatchSourcePresentation,
  payrollMatchState,
  summarizePayrollRows,
} from './payrollImportState.js'

const pageUrl = new URL('../pages/AdminPayrollPage.jsx', import.meta.url)
const page = await readFile(pageUrl, 'utf8')
const migrationUrl = new URL('../../supabase/migrations/20260826160000_payroll_historical_identity_and_publish_scope.sql', import.meta.url)
const migration = await readFile(migrationUrl, 'utf8')

test('same-month payroll documents keep independent batch identities', () => {
  const first = { id: 12, period_start: '2026-08-01' }
  const second = { id: 10, period_start: '2026-08-01' }
  assert.notEqual(payrollBatchIdentity(first), payrollBatchIdentity(second))
  assert.match(page, /p_batch_id:batch\.id/)
  assert.match(page, /key=\{payrollBatchIdentity\(batch\)\}/)
})

test('payroll import history can search actors and filter the effective lifecycle status', () => {
  const batches = [
    { id: 4, status: 'draft', source_file_name: 'August PH.xlsx', created_by_name: 'founder' },
    { id: 3, status: 'published', title: 'Vietnam July', updated_by_name: 'xiaonang001' },
    { id: 2, status: 'archived', title: 'Old draft', voided_at: '2026-08-28T12:00:00Z', published_by_name: 'founder' },
  ]
  assert.equal(payrollBatchLifecycleState(batches[2]), 'voided')
  assert.deepEqual(filterPayrollBatches(batches, { status: 'published' }).map(batch => batch.id), [3])
  assert.deepEqual(filterPayrollBatches(batches, { status: 'voided' }).map(batch => batch.id), [2])
  assert.deepEqual(filterPayrollBatches(batches, { search: 'xiaonang001' }).map(batch => batch.id), [3])
  assert.deepEqual(filterPayrollBatches(batches, { search: '#4' }).map(batch => batch.id), [4])
  assert.deepEqual(filterPayrollBatches(batches, { search: '已删除' }).map(batch => batch.id), [2])
  assert.match(page, /批次状态[\s\S]+value="draft">待发布[\s\S]+value="voided">已删除（可恢复）/)
  assert.match(page, /批次搜索[\s\S]+文档名 \/ 来源 \/ 批次类别 \/ 批次号 \/ 操作人 \/ 币种/)
})

test('payroll import batch summaries paginate locally without reloading Supabase', () => {
  const historySource = page.slice(
    page.indexOf('function PayrollImportHistory('),
    page.indexOf('function PayrollRows('),
  )
  assert.match(page, /PAYROLL_IMPORT_HISTORY_PAGE_SIZE_OPTIONS=\[20,30,50,100,200\]/)
  assert.match(historySource, /const pagedHistory=useMemo\(\(\)=>history\.slice\(/)
  assert.match(historySource, /history\.length\?pagedHistory\.map\(batch=>/)
  const pagination = historySource.match(/<Pagination\n\s+page=\{historyPage\}[\s\S]+?\/>/)?.[0] || ''
  assert.match(pagination, /pageSizeOptions=\{PAYROLL_IMPORT_HISTORY_PAGE_SIZE_OPTIONS\}/)
  assert.match(pagination, /onPage=\{setHistoryPage\}/)
  assert.match(pagination, /onPageSize=\{value=>\{setHistoryPageSize\(value\);setHistoryPage\(1\)\}\}/)
  assert.doesNotMatch(pagination, /supabase\.rpc|openBatch\(|load\(/)
})

test('payroll import history presents only persisted source and category fields', () => {
  assert.deepEqual(payrollBatchSourcePresentation({
    source_type: 'upload',
    source_file_name: '现场转居家5月工资.xlsx',
    title: '2026-05 现场转居家',
  }), {
    sourceType: 'upload',
    sourceLabel: '文件上传',
    category: '2026-05 现场转居家',
    sourceFileName: '现场转居家5月工资.xlsx',
    sourceProjectRef: '',
    sourceBatchKey: '',
  })
  assert.equal(payrollBatchSourcePresentation({source_type:'friend_supabase',title:'外部批次'}).sourceLabel,'外部 Supabase 导入')
  assert.equal(payrollBatchSourcePresentation({source_type:'partner_feed',title:'已记录类别'}).sourceLabel,'partner_feed')
  assert.match(page, /<span>来源 \/ 批次类别<\/span>/)
  assert.match(page, /source\.sourceLabel[\s\S]+source\.category/)
  assert.match(page, /<span>币种<\/span><select value=\{historyCurrency\}/)
  assert.match(page, /historyCurrency==='all'/)
  assert.match(page, /clean\(batch\?\.currency\)\.toUpperCase\(\)===historyCurrency/)
})

test('payroll import history renders recorded actor timestamps without fabricating an editor', () => {
  assert.match(page, /导入 \{batch\.created_by_name\|\|'—'\} · \{dateTime\(batch\.created_at\)\}/)
  assert.match(page, /最近操作 \{batch\.updated_by_name\|\|'—'\} · \{dateTime\(batch\.updated_at\)\}/)
  assert.match(page, /发布 \{batch\.published_by_name\|\|'—'\} · \{dateTime\(batch\.published_at\)\}/)
  assert.doesNotMatch(page, /updated_by_name\|\|batch\.created_by_name/)
})

test('payroll import history exposes lifecycle-specific safe actions directly on each row', () => {
  assert.match(page, /if\(batch\?\.voided_at\)return canDelete\?'恢复记录':''/)
  assert.match(page, /status==='published'\)return canDelete\?'删除记录':canEdit\?'创建纠正草稿':''/)
  assert.match(page, /\['draft','archived'\]\.includes\(status\)\)return canDelete\?'删除记录':''/)
  assert.match(page, /<span>状态<\/span><span>操作<\/span>/)
  assert.match(page, /payrollBatchActionLabel\(batch,\{canEdit,canDelete\}\)/)
  const historyRow = page.match(/return <div key=\{payrollBatchIdentity\(batch\)\}[\s\S]+?<\/div>/)?.[0] || ''
  assert.match(historyRow, /onClick=\{\(\)=>openBatch\(batch\)\}/)
  assert.match(historyRow, /deleteRecordFromRow\(batch\)/)
  assert.match(historyRow, /restoreBatchFromRow\(batch\)/)
  assert.match(historyRow, /cloneCorrectionFromRow\(batch\)/)
  assert.match(page, /DELETE PUBLISHED #\$\{batchId\}/)
  assert.match(page, /admin_payroll_delete_record/)
  assert.match(page, /canDelete&&!selected\.voided_at/)
  assert.match(page, /canDelete&&selected\.voided_at/)
  assert.doesNotMatch(historyRow, /public\.payroll_batches|delete from/)
})

test('an explicitly selected batch is not replaced by the first batch with the same status', () => {
  assert.match(page, /if\(wantedStatus&&data\?\.selected_batch\?\.status!==wantedStatus\)\{[\s\S]+?\.find\(batch=>batch\.status===wantedStatus\)/)
  assert.doesNotMatch(page, /if\(wantedStatus\)\{\s*const target=\(data\?\.batches\|\|\[\]\)\.find/)
})

test('historical resigned identities are not counted as unmatched', () => {
  const rows = [
    { employee_id: 'active-id', match_state: 'active' },
    { employee_id: null, identity_match_state: 'historical_resigned' },
    { employee_id: null, match_state: 'unmatched' },
  ]
  assert.equal(payrollMatchState(rows[1]), 'resigned')
  assert.deepEqual(summarizePayrollRows(rows), { active: 1, suspended: 0, resigned: 1, unmatched: 1, total: 3 })
})

test('visible unmatched summary is derived from current batch rows', () => {
  assert.match(page, /const unmatchedCount=rowStateCounts\.unmatched/)
  assert.doesNotMatch(page, /const unmatchedCount=Number\(visibleSelected\?\.unmatched_count/)
})

test('database classifies exact non-voided lifecycle resignations without recreating an employee FK', () => {
  const helperCreate = migration.indexOf('create or replace function payroll_private.resolve_historical_resigned_identity(')
  const helperComment = migration.indexOf('comment on function payroll_private.resolve_historical_resigned_identity(text)')
  assert.ok(helperCreate >= 0, 'historical identity helper must be created')
  assert.ok(helperComment > helperCreate, 'function must exist before its COMMENT statement')
  assert.match(migration, /resolve_historical_resigned_identity\(text\)/i)
  assert.match(migration, /internal\.payroll_employee_no_key\(lifecycle\.employee_no\)[\s\S]+internal\.payroll_employee_no_key\(p_employee_no\)/i)
  assert.match(migration, /lifecycle\.note is distinct from '__VOIDED__'/i)
  assert.match(migration, /lifecycle\.event_type in \('join','resign','reactivate'\)/i)
  assert.doesNotMatch(migration, /lifecycle\.event_type in \([^)]*profile_update/i)
  assert.match(migration, /latest\.event_type = 'resign'/i)
  assert.match(migration, /identity_match_state = 'historical_resigned'/i)
  const historicalBackfill = migration.match(/update public\.payroll_payslips payslip\nset identity_match_state = 'historical_resigned'[\s\S]+?\nwhere payslip\.employee_id is null[\s\S]+?\n  \);/i)?.[0] || ''
  assert.ok(historicalBackfill, 'historical resigned backfill must target detached rows')
  assert.doesNotMatch(historicalBackfill, /\n\s*employee_id\s*=/i)
  assert.doesNotMatch(migration, /update public\.employees[\s\S]+historical_resigned/i)
})

test('publication freezes active or probation eligibility and staff reads only eligible rows', () => {
  assert.match(migration, /published_to_staff = \([\s\S]+identity_match_state = 'employee'[\s\S]+coalesce\(lower\(btrim\(employee\.status::text\)\),''\) in \('active','probation'\)/i)
  assert.match(migration, /identity_match_state = 'historical_resigned'[\s\S]+then 'resigned'/i)
  assert.match(migration, /when coalesce\(lower\(btrim\(employee\.status::text\)\),''\) not in \('active','probation'\) then 'inactive'/i)
  assert.match(migration, /and payslip\.identity_match_state = 'employee'[\s\S]+and payslip\.published_to_staff/i)
  assert.match(migration, /'excluded_rows',v_excluded/i)
  assert.match(migration, /revoke all on function payroll_private\.staff_payroll_home\(\)[\s\S]+from public, anon, authenticated/i)
})

test('already-published linked payslips are preserved while detached historical rows stay excluded', () => {
  assert.match(migration, /set published_to_staff = \(payslip\.employee_id is not null\)[\s\S]+from public\.payroll_batches batch[\s\S]+batch\.status = 'published'/i)
  assert.match(migration, /when payslip\.employee_id is null then[\s\S]+identity_match_state = 'historical_resigned'[\s\S]+then 'resigned'/i)
})

test('stored batch totals and API batch totals use the same explicit identity state', () => {
  assert.match(migration, /matched_count = counts\.matched_count/i)
  assert.match(migration, /unmatched_count = counts\.unmatched_count/i)
  assert.match(migration, /count\(payslip\.id\) filter\(where payslip\.identity_match_state = 'unmatched'\)::integer unmatched_count/i)
})
