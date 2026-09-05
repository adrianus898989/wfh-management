import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(
  new URL('../../supabase/migrations/20260905221500_online_training_set_report_trainer_keys.sql', import.meta.url),
  'utf8',
)

const sliceBetween = (text, start, end) => {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  assert.notEqual(from, -1, `missing start marker: ${start}`)
  assert.notEqual(to, -1, `missing end marker: ${end}`)
  return text.slice(from, to)
}

test('trainer-key helper resolves visible reports in bounded sets', () => {
  const helper = sliceBetween(
    migration,
    'create or replace function\n  session_private.online_training_visible_report_trainer_keys(',
    '\ncomment on function',
  )

  assert.match(helper, /if not coalesce\(p_enabled, false\)/)
  assert.match(helper, /allowed_employee_ids as materialized/)
  assert.match(helper, /visible_reports as materialized/)
  assert.match(helper, /visible_members as materialized/)
  assert.match(helper, /member_rollup as materialized/)
  assert.match(helper, /actor_inputs as materialized/)
  assert.match(helper, /actor_keys as materialized/)
  assert.equal(
    (helper.match(/session_private\.online_training_roster_actor_label\(/g) ?? []).length,
    1,
  )
})

test('trainer-key helper preserves identity and fallback semantics', () => {
  assert.match(migration, /count\(distinct public\.online_training_identity_key\(/)
  assert.match(migration, /order by member\.sort_order, member\.employee_name/)
  assert.match(
    migration,
    /report\.trainer_name[\s\S]+member\.member_trainer_name[\s\S]+report\.author_name[\s\S]+report\.author_employee_no[\s\S]+'未填写线上培训'/,
  )
  assert.match(migration, /coalesce\(actor\.trainer_key, ''\) trainer_key/)
})

test('report search joins the set helper and removes the scalar trainer key', () => {
  const patch = sliceBetween(
    migration,
    'do $patch_search_reports$',
    '$patch_search_reports$;',
  )

  assert.match(patch, /report_trainer_keys as materialized/)
  assert.match(patch, /pg_catalog\.cardinality\(v_trainer_keys\) > 0/)
  assert.match(patch, /left join report_trainer_keys report_trainer/)
  assert.match(patch, /report_trainer\.trainer_key = any\(v_trainer_keys\)/)
  assert.match(patch, /online_training_search_reports_key_shape_changed/)
  assert.match(patch, /online_training_search_reports_set_key_patch_failed/)
})

test('migration fails closed and keeps the private helper private', () => {
  assert.match(migration, /online_training_set_report_trainer_keys_prerequisite_missing/)
  assert.match(migration, /online_training_scalar_report_trainer_key_shape_changed/)
  assert.match(migration, /online_training_search_reports_trainer_key_shape_changed/)
  assert.match(migration, /online_training_search_reports_key_metadata_changed/)
  assert.match(
    migration,
    /revoke all on function[\s\S]+online_training_visible_report_trainer_keys\(date,date,boolean\)[\s\S]+from public, anon, authenticated, service_role/,
  )
  assert.match(migration, /online_training_visible_report_trainer_keys_acl_widened/)
})
