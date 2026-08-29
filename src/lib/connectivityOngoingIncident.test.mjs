import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

import {
  calculatedConnectivityDuration,
  normaliseConnectivityStatus,
} from './connectivityIncidentState.js'

const page=await readFile(new URL('../components/ConnectivityRecords.jsx',import.meta.url),'utf8')
const migration=await readFile(
  new URL('../../supabase/migrations/20260829090000_connectivity_ongoing_incidents.sql',import.meta.url),
  'utf8',
)
const statusMigration=await readFile(
  new URL('../../supabase/migrations/20260829103000_normalize_connectivity_completion_status.sql',import.meta.url),
  'utf8',
)

const between=(value,start,end)=>{
  const from=value.indexOf(start)
  const to=end?value.indexOf(end,from+start.length):value.length
  assert.ok(from>=0,`missing start marker: ${start}`)
  assert.ok(to>from,`missing end marker: ${end}`)
  return value.slice(from,to)
}

test('connectivity duration supports same-day and overnight completed incidents',()=>{
  assert.equal(calculatedConnectivityDuration('08:30','09:45'),75)
  assert.equal(calculatedConnectivityDuration('23:30','00:15'),45)
  assert.equal(calculatedConnectivityDuration('08:30',''),0)
})

test('ongoing and completed status transitions stay consistent',()=>{
  assert.equal(normaliseConnectivityStatus('reported',''),'reported')
  assert.equal(normaliseConnectivityStatus('resolved',''),'reported')
  assert.equal(normaliseConnectivityStatus('reported','10:30'),'resolved')
  assert.equal(normaliseConnectivityStatus('verified','10:30'),'resolved')
  assert.equal(normaliseConnectivityStatus('rejected',''),'rejected')
})

test('connectivity editor requires only the incident start and explains later completion',()=>{
  assert.match(page,/initialRecord=.*incident_type:'power_outage'/)
  assert.match(page,/incident_type:row\.incident_type\|\|'power_outage'/)
  assert.match(page,/if\(!record\.incident_date\|\|!record\.started_at\)/)
  assert.doesNotMatch(page,/if\(!record\.incident_date\|\|!record\.started_at\|\|!record\.ended_at\)/)
  assert.match(page,/恢复时间（可后补）/)
  assert.match(page,/尚未恢复时请留空；先保存为进行中/)
  assert.match(page,/超过 24 小时请按天分开记录/)
  assert.match(page,/normaliseConnectivityStatus\(record\.status,ended_at\)/)
  assert.match(page,/<option value="reported" disabled=\{Boolean\(record\.ended_at\)\}>/)
  assert.match(page,/<option value="verified" disabled=\{Boolean\(record\.ended_at\)\}>/)
  assert.match(page,/<option value="resolved" disabled=\{!record\.ended_at\}>/)
  assert.match(page,/上传身份验证暂时失败，请重试；当前登录状态已保留/)
  assert.match(page,/if\(files\.length\)/)
  assert.match(page,/role="dialog" aria-modal="true" aria-labelledby="connectivity-editor-title"/)
  assert.match(page,/text\(row\.ended_at\)\.slice\(0,5\)\|\|'进行中'/)
})

test('guarded migration keeps scope and audit protections while allowing a null recovery time',()=>{
  assert.match(migration,/set local lock_timeout = '2s'/)
  assert.match(migration,/alter column ended_at drop not null/)
  assert.match(migration,/ended_at is null and duration_minutes is null/)
  assert.match(migration,/ended_at is not null and duration_minutes is not null/)

  const create=between(
    migration,
    'create or replace function employee_ops_private.admin_connectivity_create',
    'create or replace function public.admin_connectivity_update',
  )
  assert.match(create,/public\.has_permission\('connectivity\.create'\)/)
  assert.match(create,/public\.can_manage_employee\(v_employee_id\)/)
  assert.match(create,/if v_date is null or v_start is null then raise exception 'incident_start_required'/)
  assert.doesNotMatch(create,/v_date is null or v_start is null or v_end is null/)
  assert.match(create,/if v_end is not null then[\s\S]*v_duration:=ceil/)
  assert.match(create,/case when v_end is null then 'reported' else 'resolved'/)
  assert.match(create,/coalesce\(nullif\(btrim\(p_record->>'incident_type'\),''\),'power_outage'\)/)

  const update=between(
    migration,
    'create or replace function public.admin_connectivity_update',
    'revoke all on function employee_ops_private.admin_connectivity_create',
  )
  assert.match(update,/current_app_session_is_valid\('admin'\)/)
  assert.match(update,/public\.has_permission\('connectivity\.edit'\)/)
  assert.ok((update.match(/public\.can_manage_employee/g)||[]).length>=2)
  assert.match(update,/if v_end is null then[\s\S]*v_duration:=null/)
  assert.match(update,/if v_status='resolved' then v_status:='reported'/)
  assert.match(update,/if v_status in \('reported','verified'\) then v_status:='resolved'/)
  assert.match(update,/'connectivity','update_incident'/)
  assert.match(migration,/revoke all on function employee_ops_private\.admin_connectivity_create\(jsonb\)[\s\S]*from public,anon,authenticated/)
  assert.match(migration,/grant execute on function public\.admin_connectivity_update\(jsonb\)[\s\S]*to authenticated/)
})

test('historical completed incidents cannot be relabelled as ongoing',()=>{
  assert.match(statusMigration,/ended_at is not null[\s\S]*status in \('reported', 'verified'\)/)
  assert.match(statusMigration,/set status = 'resolved'/)
  assert.match(statusMigration,/lock_timeout = '2s'/)
})
