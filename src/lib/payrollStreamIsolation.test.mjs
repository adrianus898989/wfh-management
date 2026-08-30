import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  normalizePayrollPayCycleKey,
  normalizePayrollPopulationKey,
  payrollStreamIdentity,
} from './payrollStream.js'

const read=relative=>readFile(new URL(relative,import.meta.url),'utf8')
const migration=await read('../../supabase/migrations/20260830153000_payroll_published_stream_isolation.sql')
const page=await read('../pages/AdminPayrollPage.jsx')

const functionBody=(signature,nextSignature)=>{
  const start=migration.indexOf(signature)
  assert.ok(start>=0,`missing ${signature}`)
  const end=nextSignature
    ?migration.indexOf(nextSignature,start+signature.length)
    :migration.length
  assert.ok(end>start,`missing boundary after ${signature}`)
  return migration.slice(start,end)
}

const privateImport=functionBody(
  'create or replace function payroll_private.admin_payroll_import(',
  'create or replace function payroll_private.payroll_import_result(',
)
const publicImport=functionBody(
  'create or replace function public.admin_payroll_import(',
  'create or replace function public.admin_payroll_import_status(',
)
const importStatus=functionBody(
  'create or replace function public.admin_payroll_import_status(',
  'create or replace function public.admin_payroll_publish(',
)
const privatePublish=functionBody(
  'create or replace function payroll_private.admin_payroll_publish(',
  '-- Import retries are serialized by request key.',
)
const publicPublish=functionBody(
  'create or replace function public.admin_payroll_publish(',
  '-- Replacement is an explicit correction action.',
)
const replacementPublish=functionBody(
  'create or replace function public.admin_payroll_publish_replacement(',
  '-- A recoverably deleted published document',
)
const restoreRpc=functionBody(
  'create or replace function public.admin_payroll_restore_batch(',
  'revoke all on function payroll_private.payroll_population_key',
)

test('population, cycle and currency are stable labels, not publication exclusivity',()=>{
  const common={period_start:'2026-08-01'}
  const streams=[
    {...common,population_key:'pure_remote',pay_cycle_key:'first_half',currency:'PHP'},
    {...common,population_key:'pure_remote',pay_cycle_key:'second_half',currency:'PHP'},
    {...common,population_key:'onsite_to_home',pay_cycle_key:'monthly',currency:'PHP'},
    {...common,population_key:'pure_remote',pay_cycle_key:'monthly',currency:'PHP'},
    {...common,population_key:'pure_remote',pay_cycle_key:'monthly',currency:'USD'},
  ]
  const identities=streams.map(payrollStreamIdentity)
  assert.equal(new Set(identities).size,streams.length)
  assert.equal(
    payrollStreamIdentity({...streams[0],id:99}),
    payrollStreamIdentity({...streams[0],id:100}),
  )
  assert.equal(normalizePayrollPopulationKey('ONSITE_TO_HOME'),'onsite_to_home')
  assert.equal(normalizePayrollPayCycleKey('SECOND_HALF'),'second_half')
})

test('same-stream published documents coexist and only import attempts are unique',()=>{
  const drop=migration.indexOf(
    'drop index if exists public.payroll_batches_one_published_stream_idx',
  )
  const repair=migration.indexOf('with restored as (')
  assert.ok(drop>=0)
  assert.ok(repair>drop,'old publication exclusivity must be removed before repair')
  assert.doesNotMatch(
    migration,
    /create\s+unique\s+index[^;]+payroll_batches_one_published_stream_idx/i,
  )
  assert.match(
    migration,
    /create unique index if not exists payroll_batches_import_request_key_idx[\s\S]+import_request_key[\s\S]+where import_request_key is not null/,
  )
})

test('repair restores only non-voided legacy auto-archives with matching audit evidence',()=>{
  const repair=migration.slice(
    migration.indexOf('with restored as ('),
    migration.indexOf('-- A published batch is not unique by stream'),
  )
  assert.match(repair,/batch\.status = 'archived'/)
  assert.match(repair,/batch\.voided_at is null/)
  assert.match(repair,/batch\.published_at is not null/)
  assert.match(
    repair,
    /batch\.archive_reason like '批次 #% 发布后自动替代同月份旧批次'/,
  )
  assert.match(
    repair,
    /audit\.batch_id=batch\.id and audit\.action='auto_archive'/,
  )
  assert.match(repair,/set status = 'published'/)
  assert.match(repair,/'repair_published_coexistence'/)
})

test('import is set-based and preserves strict identity matching boundaries',()=>{
  assert.match(privateImport,/jsonb_array_elements\(p_rows\) with ordinality/)
  assert.match(privateImport,/create temporary table payroll_import_rows/)
  assert.match(privateImport,/insert into public\.payroll_payslips\([\s\S]+\)\s+select/)
  assert.doesNotMatch(privateImport,/\bloop\b/i)
  assert.match(
    privateImport,
    /row\.employee_id is null and row\.employee_key='' and row\.name_key<>''/,
  )
  assert.match(privateImport,/having count\(distinct raw\.employee_id\)=1/)
  assert.match(
    privateImport,
    /identity_match_source='legacy_old_id_unique_name_hire_date'/,
  )
  assert.match(privateImport,/on conflict\(old_employee_no_key\) do update/)
  assert.match(privateImport,/where payroll_private\.employee_identity_aliases\.employee_id=excluded\.employee_id/)
  assert.match(privateImport,/'legacy_old_id_matched',v_legacy_matches/)
})

test('bulk import rejects malformed non-empty classification, row, JSON and date fields',()=>{
  for(const body of [privateImport,publicImport]){
    assert.match(body,/jsonb_typeof\(p_batch\) is distinct from 'object'/)
    assert.match(body,/jsonb_typeof\(p_rows\) is distinct from 'array'/)
  }
  for(const body of [privateImport,publicImport]){
    assert.match(body,/raise exception 'invalid_payroll_population_key'/)
    assert.match(body,/raise exception 'invalid_payroll_cycle_key'/)
  }
  assert.match(privateImport,/raise exception 'invalid_source_row_at_row_%'/)
  assert.match(privateImport,/raise exception 'invalid_line_items_at_row_%'/)
  assert.match(privateImport,/raise exception 'invalid_raw_payload_at_row_%'/)
  assert.match(privateImport,/payroll_import_strict_date\([\s\S]+?'hire_date'/)
  assert.match(privateImport,/payroll_import_strict_date\([\s\S]+?'departure_date'/)
  assert.match(
    migration,
    /if v_value !~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$' then[\s\S]+invalid_%_at_row_%/,
  )
})

test('request-key import retries are backward-compatible, concurrent and payload-safe',()=>{
  assert.match(publicImport,/if v_request_key='' then/)
  assert.ok(publicImport.includes("md5(v_user::text||'|'||v_payload_hash)"))
  assert.match(publicImport,/raise exception 'invalid_import_request_key'/)
  const lock=publicImport.indexOf('pg_catalog.pg_advisory_xact_lock')
  const lookup=publicImport.indexOf('where batch.import_request_key=v_request_key')
  const mutation=publicImport.indexOf(
    'payroll_private.admin_payroll_import(v_safe_batch,p_rows)',
  )
  assert.ok(lock>=0 && lookup>lock && mutation>lookup)
  assert.match(publicImport,/v_existing\.created_by is distinct from v_user/)
  assert.match(publicImport,/v_existing\.import_payload_hash is distinct from v_payload_hash/)
  assert.match(publicImport,/'idempotent_replay',true/)
  assert.match(importStatus,/batch\.created_by=v_user/)
})

test('ordinary publish changes only its target and never archives another batch',()=>{
  for(const body of [privatePublish,publicPublish]){
    assert.doesNotMatch(body,/'auto_archive'/)
    assert.doesNotMatch(body,/set\s+status='archived'/i)
    assert.doesNotMatch(body,/period_start\s*=\s*v_batch\.period_start/i)
  }
  assert.match(privatePublish,/where batch\.id=p_batch_id/)
  assert.match(privatePublish,/set status='published'/)
  assert.match(privatePublish,/'coexists_with_other_published',true/)
  assert.match(
    publicPublish,
    /v_result:=payroll_private\.admin_payroll_publish\(p_batch_id\)/,
  )
  assert.match(publicPublish,/'replacement_mode','none'/)
})

test('explicit replacement archives exactly its correction source',()=>{
  assert.match(replacementPublish,/v_source_id bigint/)
  assert.match(replacementPublish,/v_target\.correction_of_batch_id is distinct from v_source_id/)
  assert.match(replacementPublish,/v_source\.status<>'published'/)
  assert.match(
    replacementPublish,
    /where batch\.id=v_source_id and batch\.status='published'[\s\S]+batch\.voided_at is null/,
  )
  assert.match(replacementPublish,/'explicit_replace'/)
  assert.match(replacementPublish,/'archived_batch_ids',jsonb_build_array\(v_source_id\)/)
  assert.doesNotMatch(
    replacementPublish,
    /batch\.period_start\s*=\s*v_target\.period_start/,
  )
})

test('correction and restore preserve published coexistence',()=>{
  assert.match(migration,/new\.population_key := v_source\.population_key/)
  assert.match(migration,/new\.pay_cycle_key := v_source\.pay_cycle_key/)
  assert.match(
    migration,
    /before insert on public\.payroll_batches[\s\S]+payroll_inherit_correction_stream/,
  )
  assert.doesNotMatch(restoreRpc,/published_restore_conflict/)
  assert.doesNotMatch(restoreRpc,/conflict_batch/)
  assert.match(restoreRpc,/v_batch\.voided_at is null/)
  assert.match(restoreRpc,/'published_coexistence',true/)
})

test('public mutations authorize before writes and private bulk RPCs are not callable',()=>{
  const ordered=(body,needles)=>{
    let cursor=-1
    for(const needle of needles){
      const next=body.indexOf(needle)
      assert.ok(next>cursor,`${needle} must follow the prior authorization gate`)
      cursor=next
    }
  }
  ordered(publicImport,[
    "if v_user is null then raise exception 'not_authenticated'",
    "current_app_session_is_valid('admin')",
    "has_permission('payroll.import_history.edit')",
    'admin_payroll_has_full_scope()',
    'payroll_private.admin_payroll_import(v_safe_batch,p_rows)',
  ])
  ordered(publicPublish,[
    "if v_user is null then raise exception 'not_authenticated'",
    "current_app_session_is_valid('admin')",
    "has_permission('payroll.pending.publish')",
    'admin_payroll_has_full_scope()',
    'payroll_private.admin_payroll_publish(p_batch_id)',
  ])
  ordered(restoreRpc,[
    "if v_user is null then raise exception 'not_authenticated'",
    "current_app_session_is_valid('admin')",
    "has_permission('payroll.import_history.delete')",
    'admin_payroll_has_full_scope()',
    'select * into v_batch',
  ])
  assert.doesNotMatch(
    migration,
    /insert\s+into\s+public\.(?:permissions|role_permissions|user_permission_overrides)/i,
  )
  const privateAcl=migration.slice(
    migration.indexOf('revoke all on function payroll_private.payroll_population_key'),
    migration.indexOf('revoke all on function public.admin_payroll_import'),
  )
  assert.ok(privateAcl.includes('payroll_private.admin_payroll_import(jsonb,jsonb)'))
  assert.ok(privateAcl.includes('from public,anon,authenticated,service_role'))
  assert.match(
    migration,
    /grant execute on function public\.admin_payroll_import\(jsonb,jsonb\)[\s\S]+to authenticated,service_role/,
  )
  assert.match(migration,/notify pgrst,'reload schema';\s+commit;/)
})

test('classification controls remain explicit in the import UI and payload',()=>{
  assert.match(page,/populationKey:'pure_remote'/)
  assert.match(page,/payCycleKey:'monthly'/)
  assert.match(page,/population_key:form\.populationKey,pay_cycle_key:form\.payCycleKey/)
  assert.match(page,/PAYROLL_POPULATION_OPTIONS\.map/)
  assert.match(page,/PAYROLL_PAY_CYCLE_OPTIONS\.map/)
})
