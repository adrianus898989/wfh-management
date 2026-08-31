import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  '../../supabase/migrations/20260831135710_online_training_manager_team_scope.sql',
  import.meta.url,
)

const functionBody = (sql, signature, endMarker) => sql.slice(
  sql.indexOf(signature),
  sql.indexOf(endMarker, sql.indexOf(signature)),
)

test('team-scoped managers read the canonical account scope while self actors keep roster relationships', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const setScope = functionBody(
    sql,
    'create or replace function session_private.online_training_effective_employee_ids()',
    'revoke all on function session_private.online_training_effective_employee_ids()',
  )
  const scalarScope = functionBody(
    sql,
    'create or replace function public.online_training_employee_in_scope(',
    'revoke all on function public.online_training_employee_in_scope(uuid)',
  )

  for (const body of [setScope, scalarScope]) {
    assert.match(body, /current_app_session_is_valid\('admin'\)/)
    assert.match(body, /online_training_can_view_module\(\)/)
    assert.match(body, /v_data_scope in \('all', 'own_team', 'assigned', 'assigned_teams'\)/)
    assert.match(body, /admin_scope_effective_employee_ids\(v_user_id\)/)
    assert.match(body, /online_training_relationship_allows|onsite_trainer_employee_id/)
  }
  assert.doesNotMatch(sql, /create or replace function public\.backend_employee_in_scope/)
})

test('manager report targets keep stable assignments and intersect the configured team ceiling', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const targets = functionBody(
    sql,
    'create or replace function session_private.online_training_assignment_targets(',
    'revoke all on function\n  session_private.online_training_assignment_targets(uuid)',
  )

  assert.match(targets, /p_actor_employee_id = v_caller_employee_id/)
  assert.match(targets, /v_data_scope in \('own_team', 'assigned', 'assigned_teams'\)/)
  assert.match(targets, /onsite_trainer_employee_id = p_actor_employee_id/)
  assert.match(targets, /online_trainer_employee_id = p_actor_employee_id/)
  assert.match(targets, /online_leader_employee_id = p_actor_employee_id/)
  assert.match(targets, /join public\.admin_scope_effective_employee_ids\(v_user_id\) scope/)
  assert.match(targets, /scope\.employee_id = assignment\.target_employee_id/)
  assert.doesNotMatch(targets, /select scope\.employee_id target_employee_id/)
})

test('private helpers remain browser-inaccessible after the scope change', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /revoke all on function session_private\.online_training_effective_employee_ids\(\)[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(sql, /revoke all on function[\s\S]+session_private\.online_training_assignment_targets\(uuid\)[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(sql, /grant execute on function public\.online_training_employee_in_scope\(uuid\)[\s\S]+to authenticated, service_role/)
})
