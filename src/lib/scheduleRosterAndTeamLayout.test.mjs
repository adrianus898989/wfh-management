import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const migration=await readFile(new URL('../../supabase/migrations/20260826152100_schedule_full_roster_directory_cache.sql',import.meta.url),'utf8')
const reportsPage=await readFile(new URL('../pages/AdminReportsPage.jsx',import.meta.url),'utf8')
const compactCss=await readFile(new URL('../ui-v2714.css',import.meta.url),'utf8')

test('successful employee-master sync republishes the full schedule into the display cache',()=>{
  assert.match(migration,/employee_master_source_snapshots[\s\S]+source_key\s*=\s*'home_schedule_roster_current'/i)
  assert.match(migration,/public\.sync_report_employee_directory\(v_payload\)/i)
  assert.match(migration,/public\.report_employee_directory_cache_matches\(v_payload\)/i)
  assert.match(migration,/from public\.report_sheet_snapshots snapshot[\s\S]+snapshot\.source\s*=\s*'居家排班表\/填表'/i)
  assert.match(migration,/current_schedule_report_snapshot_missing_or_invalid/i)
  assert.match(migration,/schedule_directory_cache_backfill_mismatch/i)
  assert.doesNotMatch(migration,/update\s+public\.employees|insert\s+into\s+public\.employees/i)
  assert.match(migration,/set search_path\s*=\s*''/i)
  assert.match(migration,/revoke all on function public\.refresh_schedule_report_snapshot_after_master_sync\(\)[\s\S]+service_role/i)
})

test('team statistics table owns its compact no-inner-scroll layout at render time',()=>{
  assert.match(reportsPage,/rp-team-matrix-card wfh-team-fit-card/)
  assert.match(reportsPage,/rp-table-scroll rp-team-table-scroll/)
  assert.match(compactCss,/\.wfh-team-fit-card \.rp-team-table-scroll\{[^}]*max-height:none!important;[^}]*overflow-x:auto!important;[^}]*overflow-y:visible!important/)
  assert.match(compactCss,/\.wfh-team-fit-card \.rp-team-table td\{[^}]*height:38px!important;[^}]*font-size:10\.5px!important/)
  assert.match(compactCss,/@media\(max-width:1120px\)[\s\S]*\.rp-team-table\{min-width:1180px!important\}/)
})
