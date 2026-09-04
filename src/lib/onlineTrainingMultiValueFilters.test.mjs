import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const sql=await readFile(new URL(
  '../../supabase/migrations/20260904054810_online_training_multivalue_filters.sql',
  import.meta.url,
),'utf8')

test('online-training multi-value protocol is collision-resistant, bounded, and private',()=>{
  assert.match(sql,/session_private\.online_training_filter_values\(\s*p_encoded text/)
  assert.match(sql,/string_to_array\(v_encoded, pg_catalog\.chr\(31\)\)/)
  assert.match(sql,/cardinality\(v_parts\) > 100/)
  assert.match(sql,/char_length\(pg_catalog\.btrim\(part\.value\)\) > 512/)
  assert.match(sql,/select distinct pg_catalog\.lower\(pg_catalog\.btrim\(part\.value\)\)/)
  assert.match(sql,/revoke all on function session_private\.online_training_filter_values\(text\)[\s\S]+from public, anon, authenticated, service_role/)
  assert.doesNotMatch(sql,/grant execute on function session_private\.online_training_filter_values/)
})

test('all three existing RPC signatures are patched without changing their public contract',()=>{
  for(const name of [
    'online_training_search_people',
    'online_training_search_trainers',
    'online_training_search_reports',
  ]){
    assert.match(sql,new RegExp(`public\\.${name}\\(jsonb,integer,integer\\)`))
  }
  assert.match(sql,/pg_catalog\.pg_get_functiondef\(procedure\.oid\)/)
  assert.match(sql,/v_%1\$s text\[\] := session_private\.online_training_filter_values/)
  assert.match(sql,/pg_catalog\.cardinality\(v_%s\) = 0/)
  assert.match(sql,/= any\(v_%s\)/)
  assert.doesNotMatch(sql,/drop function|cascade/i)
})

test('the transformation is fail-closed for the reviewed live function shapes',()=>{
  assert.match(sql,/v_expected_empty := 2;[\s\S]+v_expected_match := 2;/)
  assert.match(sql,/v_expected_empty := 4;[\s\S]+v_expected_match := 3;/)
  assert.match(sql,/online_training_multivalue_declaration_shape_changed/)
  assert.match(sql,/online_training_multivalue_empty_shape_changed/)
  assert.match(sql,/online_training_multivalue_match_shape_changed/)
  assert.match(sql,/online_training_multivalue_declaration_verify_failed/)
  assert.match(sql,/online_training_multivalue_empty_verify_failed/)
  assert.match(sql,/online_training_multivalue_match_verify_failed/)
})

test('session, scope, SECURITY DEFINER, ACL, configuration, and comments are preserved',()=>{
  assert.match(sql,/current_app_session_is_valid\(''admin''\)/)
  assert.match(sql,/public\.online_training_can_view_module\(\)/)
  assert.match(sql,/procedure\.proacl/)
  assert.match(sql,/procedure\.proowner/)
  assert.match(sql,/procedure\.prosecdef/)
  assert.match(sql,/procedure\.proconfig/)
  assert.match(sql,/v_config_before @> array\['search_path=""'\]::text\[\]/)
  assert.match(sql,/procedure\.provolatile::text/)
  assert.match(sql,/procedure\.proparallel::text/)
  assert.match(sql,/obj_description\(procedure\.oid, 'pg_proc'\)/)
  assert.match(sql,/v_acl_after is distinct from v_acl_before/)
  assert.match(sql,/online_training_multivalue_function_boundary_changed/)
  assert.match(sql,/set local lock_timeout = '2s'/)
  assert.match(sql,/set local statement_timeout = '20s'/)
})
