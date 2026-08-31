import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  '../../supabase/migrations/20260831120000_online_training_set_based_scope.sql',
  import.meta.url,
)

test('online training scope is materialized once without widening restricted trainer relationships', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const effectiveScope = sql.slice(
    sql.indexOf('create or replace function session_private.online_training_effective_employee_ids()'),
    sql.indexOf('revoke all on function session_private.online_training_effective_employee_ids()'),
  )

  assert.match(effectiveScope, /current_app_session_is_valid\('admin'\)/)
  assert.match(effectiveScope, /online_training_can_view_module\(\)/)
  assert.match(effectiveScope, /v_role_code = 'founder' or v_data_scope = 'all'/)
  assert.match(effectiveScope, /admin_scope_effective_employee_ids\(v_user_id\)/)
  assert.match(effectiveScope, /onsite_trainer_employee_id = v_caller_employee_id/)
  assert.match(effectiveScope, /online_trainer_employee_id = v_caller_employee_id/)
  assert.match(effectiveScope, /online_leader_employee_id = v_caller_employee_id/)
  assert.match(effectiveScope, /select relation\.online_trainer_employee_id/)
  assert.match(sql, /revoke all on function session_private\.online_training_effective_employee_ids\(\)[\s\S]+from public, anon, authenticated, service_role/)
})

test('all three online training directory RPCs replace scalar per-row scope checks', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /online_training_search_people\(jsonb,integer,integer\)/)
  assert.match(sql, /online_training_search_trainers\(jsonb,integer,integer\)/)
  assert.match(sql, /session_private\.online_training_context_stable_relationship_inner_v1\(\)/)
  assert.match(sql, /public\.online_training_context\(\)/)
  assert.match(sql, /select scope\.employee_id[\s\S]+online_training_effective_employee_ids\(\) scope/)
  assert.match(sql, /online_training_context_inner_roster_shape_changed/)
  assert.match(sql, /online_training_context_outer_scope_shape_changed/)
  assert.match(sql, /online_training_set_scope_verify_failed/)
  assert.match(sql, /online_training_snapshot_employee_id\(scoped\.online_trainer\)/)
  assert.match(sql, /pg_catalog\.strpos\(v_patched, 'online_training_snapshot_employee_id\(scoped\.online_trainer\)'\) > 0/)
})
