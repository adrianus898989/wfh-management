import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('../../supabase/migrations/20260826141000_payout_manual_fulfillment_and_entry_logs.sql', import.meta.url)
const sql = await readFile(migrationUrl, 'utf8')
const guardMigrationUrl = new URL('../../supabase/migrations/20260826145000_close_payout_race_and_log_scope.sql', import.meta.url)
const guardSql = await readFile(guardMigrationUrl, 'utf8')
const serverOwnedOldDataMigrationUrl = new URL('../../supabase/migrations/20260826150000_payout_change_server_owned_old_data.sql', import.meta.url)
const serverOwnedOldDataSql = await readFile(serverOwnedOldDataMigrationUrl, 'utf8')
const workflowComponentUrl = new URL('../components/PaymentChangeWorkflow.jsx', import.meta.url)
const workflowComponent = await readFile(workflowComponentUrl, 'utf8')

const functionBody = name => {
  const start = sql.indexOf(`create or replace function ${name}`)
  assert.notEqual(start, -1, `${name} should exist`)
  const next = sql.indexOf('\ncreate or replace function ', start + 1)
  return sql.slice(start, next === -1 ? sql.length : next)
}

test('manual payout approval cannot silently write employee payment data', () => {
  const review = functionBody('public.admin_review_payout_change_request')
  assert.match(sql, /auto_apply_enabled boolean not null default false/i)
  assert.match(review, /if coalesce\(v_auto_apply_enabled,false\) then/i)
  assert.match(review, /payment_change_private\.auto_apply_request\(v_request\.id,v_user\)/i)
  assert.doesNotMatch(review, /update\s+public\.employee_payment_profiles/i)
  assert.doesNotMatch(review, /insert\s+into\s+public\.payout_accounts/i)
  assert.match(review, /fulfillment_status=v_fulfillment/i)
})

test('automatic payout mutation helper is private and disabled by default', () => {
  const helper = functionBody('payment_change_private.auto_apply_request')
  assert.match(helper, /raise exception 'auto_apply_disabled'/i)
  assert.match(sql, /revoke all on function payment_change_private\.auto_apply_request\(uuid,uuid\)\s+from public,anon,authenticated/i)
  assert.match(sql, /revoke all on table payment_change_private\.workflow_settings\s+from public,anon,authenticated/i)
  assert.doesNotMatch(sql, /grant\s+(?:select|insert|update|delete)(?:\s*,\s*(?:select|insert|update|delete))*\s+on table payment_change_private\.workflow_settings\s+to authenticated/is)
})

test('manual fulfillment reconciliation keeps completed matches immutable', () => {
  const reconcile = functionBody('payment_change_private.reconcile_profile_change')
  assert.match(reconcile, /fulfillment_status in \('pending_manual','mismatch'\)/i)
  assert.doesNotMatch(reconcile, /fulfillment_status in \([^)]*'matched'/i)
  assert.match(reconcile, /payout_change_fulfillment_status/i)
})

test('entry-log RPC enforces session, permission and employee scope', () => {
  const logs = functionBody('public.admin_data_entry_logs')
  assert.match(logs, /current_app_session_is_valid\('admin'\)/i)
  assert.match(logs, /has_permission\('audit\.view'\)/i)
  assert.match(logs, /has_permission\('adjustment\.view'\)/i)
  assert.match(logs, /has_permission\('attendance\.view'\)/i)
  assert.match(logs, /x\.employee_id is not null/i)
  assert.match(logs, /can_manage_employee\(x\.employee_id\)/i)
  assert.match(sql, /grant execute on function public\.admin_data_entry_logs[^;]+to authenticated/is)
})

test('an approved request remains open until its manual profile update matches', () => {
  assert.match(guardSql, /payout_change_requests_one_open_per_employee_idx/i)
  assert.match(guardSql, /status\s*=\s*'approved'[\s\S]+fulfillment_status in \('awaiting_review', 'pending_manual', 'mismatch'\)/i)
  assert.match(guardSql, /raise exception 'pending_request_exists'/i)
  assert.match(workflowComponent, /request\.status === 'approved'/)
  assert.match(workflowComponent, /!\['matched', 'not_applicable'\]\.includes\(clean\(request\.fulfillment_status\)\)/i)
})

test('latest entry-log RPC excludes records that have no provable employee scope', () => {
  assert.match(guardSql, /join public\.employees employee on employee\.id = entry\.employee_id/i)
  assert.match(guardSql, /where public\.can_manage_employee\(entry\.employee_id\)/i)
  assert.doesNotMatch(guardSql, /employee_id is null\s+or\s+public\.can_manage_employee/i)
})

test('migration does not replace the shared alert-center RPC', () => {
  assert.doesNotMatch(sql, /create or replace function public\.admin_alert_center/i)
})

test('staff payout submission snapshots canonical old details instead of trusting employee input', () => {
  assert.match(serverOwnedOldDataSql, /from public\.employee_payment_profiles p[\s\S]+for update/i)
  assert.match(serverOwnedOldDataSql, /v_old:=jsonb_build_object\([\s\S]+v_profile\.gcash_account/i)
  assert.match(serverOwnedOldDataSql, /v_old:=jsonb_build_object\([\s\S]+v_profile\.usdt_address/i)
  assert.doesNotMatch(serverOwnedOldDataSql, /p_old_data\s*->>/i)
  assert.doesNotMatch(serverOwnedOldDataSql, /old_payment_mismatch/i)
  assert.match(serverOwnedOldDataSql, /insert into public\.payout_change_requests\([\s\S]+v_old,v_new,v_reason,'pending'/i)
  assert.match(serverOwnedOldDataSql, /insert into public\.audit_logs\([\s\S]+jsonb_build_object\('payment_kind',v_kind,'payment',v_old\)/i)
  assert.doesNotMatch(serverOwnedOldDataSql, /create or replace function public\.admin_review_payout_change_request/i)
  assert.doesNotMatch(serverOwnedOldDataSql, /create or replace function public\.admin_payout_change_requests/i)
})

test('staff form renders current payout details read only and submits only replacement fields', () => {
  assert.match(workflowComponent, /className="payment-change-current-fieldset"/)
  assert.match(workflowComponent, /<PaymentFacts kind=\{kind\} value=\{state\.data\?\.current\} masked \/>/)
  assert.match(workflowComponent, /p_old_data:\s*\{\}/)
  assert.doesNotMatch(workflowComponent, /form\.old(?:Transfer|Name|Account|Usdt)/)
  assert.match(workflowComponent, /form\.newTransfer/)
  assert.match(workflowComponent, /form\.newUsdt/)
  assert.match(workflowComponent, /identityProof/)
  assert.match(workflowComponent, /paymentProof/)
})
