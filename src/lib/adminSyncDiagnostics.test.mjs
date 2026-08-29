import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {
  adminSyncDiagnosticEvidence,
  adminSyncDiagnosticLabel,
  adminSyncDiagnosticSourceRows,
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
  assert.match(component,/admin_sync_diagnostics/)
})
