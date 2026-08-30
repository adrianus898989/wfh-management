import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl=new URL(
  '../../supabase/migrations/20260830171000_capacity_hotpath_guardrails.sql',
  import.meta.url,
)

test('online-training directories replace only the snapshot roster hot path',async()=>{
  const sql=await readFile(migrationUrl,'utf8')
  const replacement=sql.slice(
    sql.indexOf('v_replacement constant text'),
    sql.indexOf('$cte$;\nbegin'),
  )

  assert.match(sql,/online_training_search_people\(jsonb,integer,integer\)/)
  assert.match(sql,/online_training_search_trainers\(jsonb,integer,integer\)/)
  assert.match(replacement,/session_private\.online_training_roster_relationships/)
  assert.match(replacement,/public\.report_employee_directory_cache/)
  assert.match(replacement,/public\.online_training_employee_in_scope\(employee\.id\)/)
  assert.doesNotMatch(replacement,/report_sheet_snapshots|jsonb_array_elements/)
  assert.match(sql,/visible_member_rows as materialized/)
  assert.match(sql,/visible_reports as materialized/)
})

test('two-minute heartbeat skips only a safely fresh lease write',async()=>{
  const sql=await readFile(migrationUrl,'utf8')
  const heartbeat=sql.slice(
    sql.indexOf('create or replace function session_private.app_session_heartbeat()'),
    sql.indexOf('revoke all on function session_private.app_session_heartbeat()'),
  )

  assert.match(heartbeat,/auth_session_matches_current_release/)
  assert.match(heartbeat,/staff_portal_account_exists/)
  assert.match(heartbeat,/current_staff_ip_attestation_is_valid/)
  assert.match(heartbeat,/current_admin_ip_attestation_is_valid/)
  assert.match(heartbeat,/lease_expires_at > clock_timestamp\(\) \+ interval '135 seconds'/)
  assert.match(heartbeat,/'heartbeat_interval_seconds', 120/)
  assert.match(heartbeat,/app_session_heartbeat_release_inner_v1\(\)/)
  assert.match(heartbeat,/'lease_refreshed', false/)
})
