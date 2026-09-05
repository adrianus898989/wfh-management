import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const migration=await readFile(new URL('../../supabase/migrations/20260905215000_online_training_list_set_based_visibility.sql',import.meta.url),'utf8')
const ddl=migration.match(/v_new_definition constant text := \$ddl\$([\s\S]+?)\$ddl\$;/)?.[1]||''

test('online-training list evaluates report and employee visibility as bounded sets',()=>{
  assert.match(ddl,/create or replace function public\.online_training_list\(/i)
  assert.match(ddl,/with allowed_employee_ids as materialized[\s\S]+visible as materialized[\s\S]+counted as materialized[\s\S]+paged as materialized[\s\S]+row_payload as materialized/i)
  assert.match(ddl,/join session_private\.online_training_visible_published_report_ids\([\s\S]+p_date_from,[\s\S]+p_date_to[\s\S]+\) visible_report/i)
  assert.match(ddl,/from session_private\.online_training_effective_employee_ids\(\) scope/i)
  assert.doesNotMatch(ddl,/public\.online_training_can_view_report\(/i)
  assert.doesNotMatch(ddl,/public\.online_training_caller_is_report_trainer\(/i)
  assert.doesNotMatch(ddl,/public\.online_training_employee_in_scope\(/i)
})

test('online-training list preserves history, paging, detail and action contracts',()=>{
  assert.match(ddl,/online_training_employee_history_in_scope\(p_employee_id\)/)
  assert.match(ddl,/least\(greatest\(coalesce\(p_page_size, 12\), 1\), 100\)/)
  assert.match(ddl,/offset \(v_page - 1\) \* v_page_size[\s\S]+limit v_page_size/)
  assert.match(ddl,/jsonb_build_object\('hire_date', employee\.hire_date\)/)
  assert.match(ddl,/'can_edit'[\s\S]+online_training_can_edit_report\(report\.id\)/)
  assert.match(ddl,/'can_review'[\s\S]+online_training_can_review_report\(report\.id\)/)
  for(const field of ['rows','total','page','page_size','pages']){
    assert.match(ddl,new RegExp(`'${field}'`))
  }
})

test('migration fails closed on dependency drift and preserves function metadata',()=>{
  assert.match(migration,/online_training_list_set_visibility_prerequisite_missing/)
  assert.match(migration,/online_training_list_production_shape_changed/)
  assert.match(migration,/online_training_list_metadata_changed/)
  assert.match(migration,/online_training_list_set_visibility_verify_failed/)
  assert.match(migration,/procedure\.proacl[\s\S]+procedure\.proowner[\s\S]+obj_description/)
  assert.doesNotMatch(migration,/grant execute on function public\.online_training_list/i)
  assert.doesNotMatch(migration,/revoke all on function public\.online_training_list/i)
})
