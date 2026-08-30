import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {
  adminSyncDiagnosticEvidence,
  adminSyncDiagnosticLabel,
  adminSyncDiagnosticSourceRows,
  adminSyncDiagnosticStatus,
} from './adminSyncDiagnostics.js'

const root=fileURLToPath(new URL('../../',import.meta.url))
const read=path=>fs.readFileSync(new URL(path,`file://${root}/`),'utf8')

test('diagnostic presentation explains exact mismatch evidence',()=>{
  const row={issue_code:'cross_source_name_mismatch',home_source_row:214,schedule_source_row:472,details:{home_name:'FULL NAME',schedule_name:'Short'}}
  assert.equal(adminSyncDiagnosticLabel(row.issue_code),'两份员工来源姓名不一致')
  assert.deepEqual(adminSyncDiagnosticEvidence(row),['居家名单：FULL NAME · 排班：Short'])
  assert.equal(adminSyncDiagnosticSourceRows(row),'居家名单行 214 · 排班行 472')
})

test('source diagnostics include bounded aggregate evidence',()=>{
  const evidence=adminSyncDiagnosticEvidence({details:{row_count:604,unmatched_count:4,ambiguous_count:1}})
  assert.deepEqual(evidence,['604 行中有 4 行未匹配','1 行匹配到多名员工'])
})

test('diagnostic status is explicit and backwards compatible',()=>{
  assert.equal(adminSyncDiagnosticStatus({diagnostic_status:'partial'}).label,'部分完成')
  assert.equal(adminSyncDiagnosticStatus({issue_code:'source_sync_failed'}).label,'同步失败')
  assert.equal(adminSyncDiagnosticStatus({issue_code:'cross_source_name_mismatch'}).label,'待核对')
})

test('v2 diagnostic contract adds status without another source scan',()=>{
  const sql=read('supabase/migrations/20260830131653_admin_sync_diagnostics_status.sql')
  assert.match(sql,/security invoker/i)
  assert.match(sql,/public\.admin_sync_diagnostics\(p_filters,p_page,p_page_size\)/)
  assert.match(sql,/jsonb_array_elements\(coalesce\(v_result->'rows'/)
  assert.match(sql,/diagnostic_status/)
  assert.match(sql,/grant execute[\s\S]+to authenticated,service_role/i)
  assert.doesNotMatch(sql,/employee_master_sync_issues|attendance_sheet_sources|docs\.google|spreadsheet/i)
  assert.doesNotMatch(sql,/error_spike|repeated_error|1_day|3_day|7_day/i)
})

test('database diagnostic endpoint is permission, scope and timeout bounded',()=>{
  const sql=read('supabase/migrations/20260829105932_admin_sync_diagnostics.sql')
  assert.match(sql,/alert\.sync_diagnostics\.view/)
  assert.match(sql,/current_app_session_is_valid\('admin'\)/)
  assert.match(sql,/user_scope_employees/)
  assert.match(sql,/set statement_timeout = '3s'/)
  assert.match(sql,/least\([\s\S]{0,120}p_page_size[\s\S]{0,120}50\)/i)
  assert.match(sql,/where run\.status='success'/)
  assert.doesNotMatch(sql,/docs\.google|spreadsheet_id|sheet_url/)
  assert.doesNotMatch(sql,/pg_catalog\.(?:coalesce|greatest|least|nullif)\s*\(/i)
  assert.match(sql,/jsonb_path_query_array\([\s\S]{0,180}@\.type\(\) == "number"/)
  assert.match(sql,/select diagnostic\.diagnostic_kind,diagnostic\.diagnostic_id,[\s\S]{0,500}from filtered diagnostic/)
})

test('diagnostics UI loads only after explicit open and caps request time',()=>{
  const component=read('src/components/AdminSyncDiagnosticsPanel.jsx')
  assert.match(component,/if\(!open\|\|state\.loaded\)return/)
  assert.match(component,/setTimeout\(\(\)=>controller\.abort\(\),5000\)/)
  assert.match(component,/controllerRef\.current\?\.abort\(\)/)
  assert.match(component,/pageSizeOptions=\{\[20,30,50\]\}/)
  assert.match(component,/admin_sync_diagnostics_v2/)
  assert.match(component,/Source.+来源/)
  assert.match(component,/Object \/ employee.+对象 \/ 员工/)
  assert.match(component,/Mismatch type.+误差类型/)
  assert.match(component,/Reason.+原因/)
  assert.match(component,/Last detected.+最后检测/)
  assert.match(component,/Status.+状态/)
  assert.match(component,/adminSyncDiagnosticStatus/)
  assert.match(component,/admin-sync-error" role="alert"/)
})
