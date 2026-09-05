import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  '../../supabase/migrations/20260905220000_online_training_search_reports_set_permissions.sql',
  import.meta.url,
)

const sliceBetween = (text, start, end) => {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  assert.notEqual(from, -1, `missing start marker: ${start}`)
  assert.notEqual(to, -1, `missing end marker: ${end}`)
  return text.slice(from, to)
}

test('migration guards the scalar permission implications before simplifying them', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const guard = sliceBetween(
    sql,
    'do $prerequisite_guard$',
    '$prerequisite_guard$;',
  )

  assert.match(guard, /online_training_caller_is_report_trainer\(uuid\)/)
  assert.match(guard, /member\.employee_id is not null/)
  assert.match(guard, /and not public\.online_training_employee_in_scope\(member\.employee_id\)/)
  assert.match(guard, /online_training\.report\.submit/)
  assert.match(guard, /online_training\.report\.manage/)
  assert.match(guard, /online_training\.report\.review/)
  assert.match(guard, /report\.created_by = \(select auth\.uid\(\)\)/)
  assert.match(guard, /online_training_employee_in_scope\(report\.author_employee_id\)/)
  assert.match(guard, /online_training_employee_in_scope\(member\.employee_id\)/)
})

test('report search materializes employee scope and permission context once', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const prefix = sliceBetween(
    sql,
    'v_new_prefix constant text := $new_prefix$',
    '$new_prefix$;',
  )

  assert.match(prefix, /allowed_employee_ids as materialized/)
  assert.match(prefix, /select distinct scope\.employee_id/)
  assert.match(prefix, /online_training_effective_employee_ids\(\) scope/)
  assert.match(prefix, /permission_context as materialized/)
  assert.match(prefix, /\(select auth\.uid\(\)\) caller_user_id/)
  assert.equal((prefix.match(/public\.has_permission\(/g) ?? []).length, 3)
  assert.match(prefix, /can_submit/)
  assert.match(prefix, /can_manage/)
  assert.match(prefix, /can_review_permission/)
})

test('all four member paths use allowed-set membership instead of scalar report checks', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const patch = sliceBetween(
    sql,
    'do $patch_search_reports$',
    '$patch_search_reports$;',
  )
  const newBlocks = sliceBetween(
    patch,
    'v_new_blocks text[] := array[',
    '  ];',
  )

  for (const alias of [
    'trainer_member',
    'member_filter',
    'keyword_member',
    'member',
  ]) {
    assert.match(
      newBlocks,
      new RegExp(`allowed\\.employee_id = ${alias}\\.employee_id`),
    )
  }
  assert.equal((newBlocks.match(/from allowed_employee_ids allowed/g) ?? []).length, 4)
  assert.match(patch, /online_training_search_reports_member_shape_changed/)
})

test('set edit and review formulas preserve scoped historical behavior', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const permissions = sliceBetween(
    sql,
    'v_new_permissions constant text := $new_permissions$',
    '$new_permissions$;',
  )

  assert.match(permissions, /permission\.can_submit or permission\.can_manage/)
  assert.match(permissions, /coalesce\([\s\S]+page_report\.created_by = permission\.caller_user_id[\s\S]+false/)
  assert.match(permissions, /or permission\.can_manage/)
  assert.match(permissions, /allowed_author\.employee_id =[\s\S]+page_report\.author_employee_id/)
  assert.match(permissions, /editable_allowed\.employee_id = editable_member\.employee_id/)
  assert.match(permissions, /permission\.can_review_permission or permission\.can_manage/)
  assert.match(sql, /cross join permission_context permission/)
})

test('final definition verification rejects any remaining per-row permission helper', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const verify = sliceBetween(sql, 'do $verify$', '$verify$;')

  assert.match(verify, /online_training_search_reports_scalar_permission_remains/)
  assert.match(verify, /public\.online_training_employee_in_scope\(/)
  assert.match(verify, /public\.online_training_caller_is_report_trainer\(/)
  assert.match(verify, /public\.online_training_can_edit_report\(/)
  assert.match(verify, /public\.online_training_can_review_report\(/)
  assert.match(verify, /v_permission_calls <> 3/)
})
