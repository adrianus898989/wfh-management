import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  '../../supabase/migrations/20260905213000_online_training_set_based_report_visibility.sql',
  import.meta.url,
)

const sliceBetween = (text, start, end) => {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  assert.notEqual(from, -1, `missing start marker: ${start}`)
  assert.notEqual(to, -1, `missing end marker: ${end}`)
  return text.slice(from, to)
}

test('published report visibility materializes the canonical employee scope once', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const helper = sliceBetween(
    sql,
    'create or replace function\n  session_private.online_training_visible_published_report_ids(',
    'comment on function\n  session_private.online_training_visible_published_report_ids',
  )

  assert.match(sql, /v_data_scope in \('all', 'own_team', 'assigned', 'assigned_teams'\)/)
  assert.match(sql, /online_training_canonical_scope_shape_changed/)
  assert.match(helper, /current_app_session_is_valid\('admin'\)/)
  assert.match(helper, /online_training_can_view_module\(\)/)
  assert.match(helper, /if public\.is_founder\(\) then/)
  assert.match(helper, /report\.status = 'published'/)
  assert.match(helper, /select distinct scope\.employee_id[\s\S]+online_training_effective_employee_ids\(\) scope/)
  assert.match(helper, /pg_catalog\.bool_and\([\s\S]+all_members_allowed/)
  assert.match(helper, /pg_catalog\.bool_or\([\s\S]+any_member_allowed/)
  assert.match(helper, /where access\.all_members_allowed[\s\S]+allowed_author\.employee_id is not null[\s\S]+access\.any_member_allowed/)
  assert.doesNotMatch(helper, /online_training_employee_in_scope|admin_scope_effective_employee_ids|online_training_relationship_allows/)
  assert.match(sql, /revoke all on function[\s\S]+online_training_visible_published_report_ids\(date,date\)[\s\S]+from public, anon, authenticated, service_role/)
})

test('hot-path indexes match report aggregation and strict roster actor lookups', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /online_training_report_members_report_employee_idx[\s\S]+on public\.online_training_report_members \(report_id, employee_id\)/)
  assert.match(sql, /employees_online_training_roster_actor_lookup_idx[\s\S]+online_training_roster_name_key\(full_name\)[\s\S]+employee_master_normalize_id\(employee_no\)/)
  assert.match(sql, /include \(id, employee_no, full_name, hire_date\)[\s\S]+where status in \('active', 'probation'\)/)
})

test('people and trainer directories replace nested report permission calls', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const peoplePatch = sliceBetween(
    sql,
    'do $patch_search_people$',
    '$patch_search_people$;',
  )
  const trainerPatch = sliceBetween(
    sql,
    'do $patch_search_trainers_visibility$',
    '$patch_search_trainers_visibility$;',
  )

  assert.match(peoplePatch, /online_training_visible_published_report_ids\([\s\S]+v_effective_from,[\s\S]+v_effective_to/)
  assert.match(trainerPatch, /online_training_visible_published_report_ids\([\s\S]+v_effective_from,[\s\S]+v_effective_to/)
  assert.match(peoplePatch, /online_training_search_people_visibility_patch_failed/)
  assert.match(trainerPatch, /online_training_search_trainers_visibility_patch_failed/)
  assert.match(sql, /online_training_set_visibility_verify_failed/)
})

test('trainer actor labels are resolved once per distinct input pair', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const newRows = sliceBetween(
    sql,
    'v_new constant text := $new_trainer_rows$',
    '$new_trainer_rows$;',
  )
  const actorCalls = newRows.match(/session_private\.online_training_roster_actor_label\(/g) ?? []

  assert.match(newRows, /actor_inputs as materialized/)
  assert.match(newRows, /select distinct report\.trainer_name, report\.author_employee_no/)
  assert.match(newRows, /actor_labels as materialized/)
  assert.match(newRows, /join actor_labels actor/)
  assert.match(newRows, /is not distinct from report\.author_employee_no/)
  assert.equal(actorCalls.length, 1)
  assert.match(sql, /v_actor_call_count <> 1/)
})

test('report search replaces only its unconditional published visibility gate', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const reportPatch = sliceBetween(
    sql,
    'do $patch_search_reports_outer_visibility$',
    '$patch_search_reports_outer_visibility$;',
  )

  assert.match(reportPatch, /online_training_search_reports\(jsonb,integer,integer\)/)
  assert.match(reportPatch, /online_training_visible_published_report_ids\([\s\S]+v_date_from,[\s\S]+v_date_to/)
  assert.match(reportPatch, /online_training_search_reports_visibility_patch_failed/)
  assert.doesNotMatch(sql, /'public\.online_training_list[^']*'::regprocedure/)
})
