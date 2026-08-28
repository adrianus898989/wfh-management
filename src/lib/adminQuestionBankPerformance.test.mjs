import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(
  new URL('../../supabase/migrations/20260828055000_optimize_exam_question_bank_scope.sql', import.meta.url),
  'utf8',
)

test('question-bank dashboard resolves caller and roster scope once', () => {
  assert.match(migration, /public\.has_permission\('exam\.question_bank\.view'\)/)
  assert.equal(migration.match(/scope_private\.current_employee_scope_directory\(\)/g)?.length, 1)
  assert.equal(migration.match(/from public\.user_access access/g)?.length, 1)
  assert.doesNotMatch(migration, /exam_team_position_in_scope\(question\./)
  assert.match(migration, /with directory_scope as materialized/)
  assert.match(migration, /with scoped_questions as materialized/)
})

test('question-bank scope keeps all, own-team and assigned team-position semantics', () => {
  assert.match(migration, /v_role_code = 'founder' or v_scope = 'all'/)
  assert.match(migration, /v_scope = 'own_team'[\s\S]+directory\.employee_id = v_employee_id/)
  assert.match(migration, /v_scope = 'assigned_teams'[\s\S]+directory\.current_team_id = any\(v_selected_team_ids\)/)
  assert.match(migration, /directory\.current_position_id = any\(v_selected_position_ids\)/)
  assert.match(migration, /jsonb_build_array\(scoped\.team_key, scoped\.position_key\)::text/)
  assert.match(migration, /public\.exam_norm\(question\.team_name\) = any\(v_allowed_team_keys\)/)
  assert.match(migration, /any\(v_allowed_pair_keys\)/)
})

test('question-bank response and execution boundary stay compatible', () => {
  for (const key of ['questions', 'total', 'page', 'page_size', 'teams', 'series', 'positions', 'last_sync']) {
    assert.ok(migration.includes(`'${key}'`), `missing response key ${key}`)
  }
  for (const column of [
    'external_key', 'series_name', 'team_name', 'position_name',
    'question_en', 'question_zh', 'question_vi', 'points', 'difficulty',
    'image_urls', 'active', 'revision', 'source', 'sync_status', 'backend_updated_at',
  ]) assert.ok(migration.includes(`question.${column}`), `missing projected column ${column}`)
  assert.match(migration, /revoke all on function public\.admin_exam_question_bank_dashboard[\s\S]+from public, anon/)
  assert.match(migration, /grant execute on function public\.admin_exam_question_bank_dashboard[\s\S]+to authenticated, service_role/)
})
