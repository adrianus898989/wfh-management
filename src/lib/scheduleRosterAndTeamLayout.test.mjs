import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const migration=await readFile(new URL('../../supabase/migrations/20260826152100_schedule_full_roster_directory_cache.sql',import.meta.url),'utf8')
const consistencyMigration=await readFile(new URL('../../supabase/migrations/20260827101500_live_employee_filters_and_schedule_consistency.sql',import.meta.url),'utf8')
const qualityGuardMigration=await readFile(new URL('../../supabase/migrations/20260827102000_employee_master_schedule_quality_guard.sql',import.meta.url),'utf8')
const qualityGuardLockMigration=await readFile(new URL('../../supabase/migrations/20260827102100_employee_master_schedule_quality_guard_lock.sql',import.meta.url),'utf8')
const reportsPage=await readFile(new URL('../pages/AdminReportsPage.jsx',import.meta.url),'utf8')
const attendancePage=await readFile(new URL('../pages/AdminAttendancePage.jsx',import.meta.url),'utf8')
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

test('schedule and report use one normalized, deduplicated roster identity set',()=>{
  assert.match(consistencyMigration,/create or replace function attendance_private\.current_schedule_roster\(\)/i)
  assert.match(consistencyMigration,/public\.employee_master_normalize_id\(item->>'employee_id'\)/i)
  assert.match(consistencyMigration,/normalize\(btrim\(item->>'name'\), NFKC\)/i)
  assert.match(consistencyMigration,/distinct on \(normalized\.identity_key\)/i)
  assert.match(consistencyMigration,/from attendance_private\.current_schedule_roster\(\)/i)
  assert.match(consistencyMigration,/'identity_issues', jsonb_build_object[\s\S]+?'missing_employee_id'/i)
  assert.match(consistencyMigration,/create or replace function public\.schedule_roster_identity_diagnostics\(\)/i)
  assert.match(consistencyMigration,/grant execute on function public\.schedule_roster_identity_diagnostics\(\)[\s\S]+?to service_role/i)
})

test('schedule page exposes actionable missing-ID and unmatched employee diagnostics',()=>{
  assert.match(attendancePage,/identityIssues:payload\.identity_issues\|\|\{\}/)
  assert.match(attendancePage,/sourceQuality:payload\.source_quality\|\|\{\}/)
  assert.match(attendancePage,/Google 排班本次读取不完整/)
  assert.match(attendancePage,/Google 第 \$\{item\.source_row\|\|'—'\} 行/)
  assert.match(attendancePage,/只看未匹配（\{unmatchedEmployees\.length\}）/)
})

test('accepted roster sync propagates detailed and legacy assignment fields',()=>{
  assert.match(consistencyMigration,/create or replace function public\.sync_schedule_employee_assignments\(p_rows jsonb\)/i)
  assert.match(consistencyMigration,/person_in_charge = desired\.responsible/i)
  assert.match(consistencyMigration,/online_leader = desired\.online_leader/i)
  assert.match(consistencyMigration,/coalesce\(assignments\.online_leader, assignments\.responsible\) leader_name/i)
  assert.match(consistencyMigration,/coalesce\(assignments\.online_trainer, assignments\.onsite_trainer\) trainer_name/i)
  assert.match(consistencyMigration,/v_result := public\.ingest_schedule_roster_snapshot_guarded_v1\(p_payload\)/i)
  assert.match(consistencyMigration,/if coalesce\(\(v_result->>'ok'\)::boolean, false\)/i)
  assert.match(consistencyMigration,/v_synced_at >= clock_timestamp\(\) - interval '24 hours'/i)
  assert.match(consistencyMigration,/v_loading_rows = 0/i)
  assert.match(consistencyMigration,/v_schedule_count \* 100 >= v_recent_good_peak \* 95/i)
})

test('employee master rejects partial Google schedule reads before any ingest mutation',()=>{
  assert.match(qualityGuardMigration,/rename to ingest_employee_master_snapshot_validated_v1/i)
  assert.match(qualityGuardMigration,/schedule_snapshot_loading_placeholders/i)
  assert.match(qualityGuardMigration,/schedule_snapshot_missing_ids/i)
  assert.match(qualityGuardMigration,/v_schedule_count \* 100 < v_recent_good_peak \* 95/i)
  assert.match(qualityGuardMigration,/return public\.ingest_employee_master_snapshot_validated_v1\(p_payload\)/i)
  assert.match(qualityGuardMigration,/grant execute on function public\.ingest_employee_master_snapshot\(jsonb\)[\s\S]+to service_role/i)
  assert.match(qualityGuardLockMigration,/pg_advisory_xact_lock[\s\S]+employee-master-dual-source-sync/i)
  assert.match(qualityGuardLockMigration,/v_schedule_rows is null or jsonb_typeof\(v_schedule_rows\) <> 'array'/i)
})

test('team statistics table owns its compact no-inner-scroll layout at render time',()=>{
  assert.match(reportsPage,/rp-team-matrix-card wfh-team-fit-card/)
  assert.match(reportsPage,/rp-table-scroll rp-team-table-scroll/)
  assert.match(compactCss,/\.wfh-team-fit-card \.rp-team-table-scroll\{[^}]*max-height:none!important;[^}]*overflow-x:auto!important;[^}]*overflow-y:visible!important/)
  assert.match(compactCss,/\.wfh-team-fit-card \.rp-team-table td\{[^}]*height:38px!important;[^}]*font-size:10\.5px!important/)
  assert.match(compactCss,/@media\(max-width:1120px\)[\s\S]*\.rp-team-table\{min-width:1180px!important\}/)
})
