import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const sql=await readFile(new URL(
  '../../supabase/migrations/20260904072801_online_training_trainer_multivalue_filters.sql',
  import.meta.url,
),'utf8')

test('trainer_names reuses the bounded unit-separator decoder and canonicalizes only on the server',()=>{
  assert.match(sql,/online_training_filter_values\(p_encoded\)/)
  assert.match(sql,/public\.online_training_identity_key\(selected\.value\)/)
  assert.match(sql,/online_training_trainer_filter_identity_invalid/)
  assert.match(sql,/p_filters->>'trainer_names'/)
  assert.match(sql,/returns text\[\][\s\S]+immutable[\s\S]+parallel safe/)
  assert.match(sql,/revoke all on function[\s\S]+online_training_trainer_filter_keys\(text\)[\s\S]+from public, anon, authenticated, service_role/)
  assert.doesNotMatch(sql,/grant execute on function[\s\S]+online_training_trainer_filter_keys/)
})

test('canonical report matching follows report, unique visible member, then author priority',()=>{
  const helper=sql.slice(
    sql.indexOf('session_private.online_training_report_trainer_key(p_report_id uuid)'),
    sql.indexOf("comment on function\n  session_private.online_training_report_trainer_key(uuid)"),
  )
  assert.match(helper,/report\.trainer_name[\s\S]+member_rollup\.trainer_name[\s\S]+report\.author_name[\s\S]+report\.author_employee_no/)
  assert.match(helper,/count\(distinct public\.online_training_identity_key\([\s\S]+\) = 1/)
  assert.match(helper,/online_training_roster_actor_label\(/)
  assert.match(helper,/online_training_employee_in_scope\(member\.employee_id\)/)
  assert.match(helper,/online_training_caller_is_report_trainer\(report\.id\)/)
  assert.match(helper,/online_training_can_view_report\(report\.id\)/)
  assert.match(sql,/revoke all on function[\s\S]+online_training_report_trainer_key\(uuid\)[\s\S]+from public, anon, authenticated, service_role/)
})

test('all three RPCs retain scalar trainer LIKE and add exact selected-key OR semantics',()=>{
  for(const name of [
    'online_training_search_people',
    'online_training_search_trainers',
    'online_training_search_reports',
  ]){
    assert.match(sql,new RegExp(`public\\.${name}\\(jsonb,integer,integer\\)`))
  }
  assert.match(sql,/v_trainer text := lower\(btrim\(coalesce\(p_filters->>'trainer', ''\)\)\)/)
  assert.match(sql,/v_trainer = ''[\s\S]+cardinality\(v_trainer_keys\) = 0/)
  assert.match(sql,/v_trainer <> ''[\s\S]+like '%' \|\| v_trainer \|\| '%'/)
  assert.match(sql,/= any\(v_trainer_keys\)/)
  assert.match(sql,/online_training_report_trainer_key\(report\.id\)[\s\S]+any\(v_trainer_keys\)/)
})

test('people current/history and trainer canonical aggregation are all patched exactly once',()=>{
  assert.match(sql,/v_old_current_person/)
  assert.match(sql,/v_old_history_person/)
  assert.match(sql,/v_old_trainer_report_prefilter/)
  assert.match(sql,/v_old_report_trainer_rows_end/)
  assert.match(sql,/v_old_report_search_filter/)
  assert.match(sql,/v_hits <> 1/)
  assert.match(sql,/online_training_trainer_filter_shape_changed/)
  assert.match(sql,/online_training_trainer_filter_patch_incomplete/)
  assert.match(sql,/online_training_trainer_filter_verify_failed/)
  assert.doesNotMatch(sql,/drop function|cascade/i)
})

test('existing RPC security metadata and scope gates must remain byte-for-byte equivalent',()=>{
  assert.match(sql,/procedure\.proacl/)
  assert.match(sql,/procedure\.proowner/)
  assert.match(sql,/procedure\.prosecdef/)
  assert.match(sql,/procedure\.proconfig/)
  assert.match(sql,/v_config_before @> array\['search_path=""'\]::text\[\]/)
  assert.match(sql,/procedure\.provolatile::text/)
  assert.match(sql,/procedure\.proparallel::text/)
  assert.match(sql,/obj_description\(procedure\.oid, 'pg_proc'\)/)
  assert.match(sql,/v_acl_after is distinct from v_acl_before/)
  assert.match(sql,/current_app_session_is_valid\(''admin''\)/)
  assert.match(sql,/public\.online_training_can_view_module\(\)/)
  assert.match(sql,/set local lock_timeout = '2s'/)
  assert.match(sql,/set local statement_timeout = '20s'/)
})
