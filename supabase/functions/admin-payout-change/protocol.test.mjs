import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  errorResponse,
  expectedDeleteConfirmation,
  isSafeRequestProofPath,
  normalizeDeleteRequest,
  normalizeProofPaths,
} from './protocol.js'

const requestId = '199cc009-8221-411b-addb-5cec7a4d9dd4'
const ownerId = '59c3b0a6-4eda-49eb-af86-e4027a5a29cc'
const migration = await readFile(
  new URL('../../migrations/20260902133000_payout_change_authorized_delete_and_filters.sql', import.meta.url),
  'utf8',
)
const edge = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

function functionBody(source, name) {
  const start = source.indexOf(`function public.${name}`)
  assert.notEqual(start, -1, `${name} missing`)
  const next = source.indexOf('\ncreate or replace function ', start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

test('delete payload requires exact action, UUID, business reason and confirmation', () => {
  assert.deepEqual(normalizeDeleteRequest({
    action: 'delete_request',
    request_id: requestId.toUpperCase(),
    reason: '  测试申请资料，确认清理  ',
    confirmation: 'DELETE CJ00007',
  }), {
    action: 'delete_request',
    requestId,
    reason: '测试申请资料，确认清理',
    confirmation: 'DELETE CJ00007',
  })
  assert.equal(expectedDeleteConfirmation(' CJ00007 '), 'DELETE CJ00007')
  assert.throws(() => normalizeDeleteRequest({ action: 'delete_request', request_id: requestId, reason: 'test', confirmation: 'DELETE CJ00007' }), /5–500/)
  assert.throws(() => normalizeDeleteRequest({ action: 'delete_request', request_id: 'bad', reason: 'valid reason', confirmation: 'DELETE CJ00007' }), /ID/)
})

test('proof cleanup accepts only exact request-owned paths and deduplicates safely', () => {
  const identity = `${ownerId}/${requestId}/identity-proof.png`
  const payment = `${ownerId}/${requestId}/payment-proof.png`
  assert.equal(isSafeRequestProofPath(requestId, identity), true)
  assert.deepEqual(normalizeProofPaths(requestId, [identity, payment, identity]), [identity, payment])
  assert.equal(isSafeRequestProofPath(requestId, `${ownerId}/cc13cf52-de2d-4cb7-9178-1439fa86a07b/proof.png`), false)
  assert.equal(isSafeRequestProofPath(requestId, `${ownerId}/${requestId}/nested/proof.png`), false)
  assert.throws(() => normalizeProofPaths(requestId, [`${ownerId}/${requestId}/../proof.png`]), /路径异常/)
})

test('delete API maps authorization failures without leaking backend details', () => {
  assert.deepEqual(errorResponse({ message: 'payout_change_delete_permission_denied' }), {
    status: 403,
    code: 'permission_denied',
    error: '无删除修改工资信息记录的权限',
    retryable: false,
  })
  assert.equal(errorResponse({ status: 503, message: 'upstream timeout' }).retryable, true)
  assert.deepEqual(errorResponse({ message: 'payout_change_proof_cleanup_incomplete' }), {
    status: 409,
    code: 'proof_cleanup_incomplete',
    error: '证明文件尚未完全清理，请重试',
    retryable: true,
  })
  assert.deepEqual(errorResponse({ status: 400, code: 'XX000', message: 'private database detail' }), {
    status: 400,
    code: 'delete_failed',
    error: '删除失败，请刷新后重试',
    retryable: false,
  })
})

test('edge performs prepare, exact Storage API removal, then retry-safe finalize', () => {
  const prepareAt = edge.indexOf("'admin_prepare_payout_change_request_delete_v1'")
  const storageAt = edge.indexOf(`storage.from(PROOF_BUCKET).remove(paths)`)
  const finalizeAt = edge.indexOf("'admin_finalize_payout_change_request_delete_v1'")
  assert.ok(prepareAt > 0 && storageAt > prepareAt && finalizeAt > storageAt)
  assert.match(edge, /normalizeDeleteRequest\(await req\.json\(\)\)/)
  assert.match(edge, /p_reason: input\.reason/)
  assert.match(edge, /p_confirmation: input\.confirmation/)
  assert.match(edge, /userClient\.rpc\([\s\S]+admin_prepare_payout_change_request_delete_v1/)
  assert.match(edge, /userClient\.rpc\([\s\S]+admin_finalize_payout_change_request_delete_v1/)
  assert.doesNotMatch(edge, /from\(['"]storage\.objects/)
})

test('database boundary uses a dedicated off-by-default permission, session and canonical scope', () => {
  const prepare = functionBody(migration, 'admin_prepare_payout_change_request_delete_v1')
  assert.match(migration, /'payroll\.change_history\.delete', '删除修改工资信息记录', 'payroll', true/)
  assert.doesNotMatch(migration, /insert into public\.role_permissions[\s\S]+payroll\.change_history\.delete/i)
  assert.match(migration, /drop index if exists payment_change_private\.payout_change_delete_one_prepare_per_request_idx;/)
  assert.match(prepare, /session_private\.current_app_session_is_valid\('admin'\)/)
  assert.match(prepare, /public\.has_permission\('payroll\.change_history\.view'\)/)
  assert.match(prepare, /public\.has_permission\('payroll\.change_history\.delete'\)/)
  assert.match(prepare, /public\.can_manage_employee\(v_request\.employee_id\)/)
  assert.match(prepare, /v_confirmation <> \('DELETE ' \|\| v_employee_no\)/)
  assert.match(prepare, /payout_change_proof_path_shared/)
  assert.match(prepare, /event_type in \('finalized', 'superseded'\)/)
  assert.match(prepare, /clock_timestamp\(\) - interval '5 minutes'/)
  assert.match(prepare, /'superseded'/)
  assert.match(prepare, /v_request\.payment_kind is distinct from v_prepared_payment_kind/)
  assert.match(prepare, /v_request\.status is distinct from v_prepared_status/)
  assert.match(prepare, /v_request\.created_at is distinct from v_prepared_created_at/)
  assert.match(prepare, /v_request\.updated_at is distinct from v_prepared_updated_at/)
  assert.doesNotMatch(prepare, /delete\s+from\s+storage\.objects/i)
})

test('staff proof upload policy closes the deletion race without blocking new request UUIDs', () => {
  const guard = functionBody(migration, 'payment_change_proof_upload_allowed')
  const guardSql = guard.slice(0, guard.indexOf('$$;', guard.indexOf('as $$')) + 3)
  assert.match(guard, /v_actor_user_id uuid := auth\.uid\(\)/)
  assert.match(guard, /cardinality\(v_parts\) <> 3/)
  assert.match(guard, /v_parts\[1\] <> v_actor_user_id::text/)
  assert.match(guard, /v_request_id := v_parts\[2\]::uuid/)
  assert.match(guard, /volatile[\s\S]+security definer/)
  assert.match(guard, /pg_advisory_xact_lock\(hashtextextended\([\s\S]+'payout_change_request_delete:' \|\| v_request_id::text/)
  assert.match(guard, /event\.event_type = 'finalized'/)
  assert.match(guard, /event\.event_type = 'prepared'[\s\S]+terminal\.event_type in \('finalized', 'superseded'\)/)
  assert.match(guard, /return not exists/)
  assert.match(guard, /exception when others then\s+return false/)
  assert.match(migration, /revoke all on function public\.payment_change_proof_upload_allowed\(text\)\s+from public, anon, authenticated, service_role;\s+grant execute on function public\.payment_change_proof_upload_allowed\(text\)\s+to authenticated;/)
  assert.match(migration, /create policy payment_change_proof_insert[\s\S]+bucket_id = 'payment-change-proof'[\s\S]+split_part\(name, '\/', 1\) = \(select auth\.uid\(\)\)::text[\s\S]+public\.payment_change_current_staff_session_is_valid\(\)[\s\S]+public\.payment_change_proof_upload_allowed\(name\)/)
  assert.doesNotMatch(guardSql, /(?:delete|update|insert)[\s\S]{0,40}storage\.objects/i)
})

test('finalization atomically deletes only the request, preserves alert history and writes non-sensitive audit', () => {
  const finalize = functionBody(migration, 'admin_finalize_payout_change_request_delete_v1')
  assert.match(finalize, /delete from public\.payout_change_requests[\s\S]+request\.id = p_request_id[\s\S]+request\.employee_id = v_prepared\.employee_id/)
  assert.match(finalize, /update public\.admin_alert_events[\s\S]+request_status', 'deleted'[\s\S]+where event\.condition_key = 'payout_change:' \|\| p_request_id::text/)
  assert.match(finalize, /insert into public\.audit_logs[\s\S]+'delete_payout_change_request'/)
  assert.match(finalize, /'employee_profile_retained', true[\s\S]+'payroll_data_retained', true/)
  assert.match(finalize, /session_private\.current_app_session_is_valid\('admin'\)/)
  assert.match(finalize, /public\.has_permission\('payroll\.change_history\.view'\)/)
  assert.match(finalize, /public\.has_permission\('payroll\.change_history\.delete'\)/)
  assert.match(finalize, /public\.can_manage_employee\(v_prepared\.employee_id\)/)
  assert.match(finalize, /not exists \([\s\S]+superseded\.operation_id = prepared\.operation_id[\s\S]+superseded\.event_type = 'superseded'[\s\S]+\)/)
  assert.match(finalize, /v_request\.payment_kind is distinct from v_prepared\.payment_kind/)
  assert.match(finalize, /v_request\.status is distinct from v_prepared\.request_status/)
  assert.match(finalize, /v_request\.created_at is distinct from v_prepared\.request_created_at/)
  assert.match(finalize, /v_request\.updated_at is distinct from v_prepared\.request_updated_at/)
  assert.match(finalize, /from storage\.objects stored[\s\S]+stored\.bucket_id = 'payment-change-proof'[\s\S]+stored\.name = any\(v_prepared\.proof_paths\)/)
  assert.doesNotMatch(finalize, /(?:delete|update|insert)[\s\S]{0,40}storage\.objects/i)
  const auditStart = finalize.indexOf('insert into public.audit_logs')
  const auditEnd = finalize.indexOf('insert into payment_change_private.payout_change_delete_operation_events', auditStart)
  const audit = finalize.slice(auditStart, auditEnd)
  assert.doesNotMatch(audit, /v_request\.(?:old_data|new_data|identity_proof_path|payment_proof_path)/)
  assert.doesNotMatch(audit, /['"]proof_paths['"]/)
  assert.match(migration, /revoke all on function public\.admin_prepare_payout_change_request_delete_v1\(uuid, text, text\)\s+from public, anon, authenticated, service_role;\s+grant execute on function public\.admin_prepare_payout_change_request_delete_v1\(uuid, text, text\)\s+to authenticated;/)
  assert.match(migration, /revoke all on function public\.admin_finalize_payout_change_request_delete_v1\(uuid, uuid\)\s+from public, anon, authenticated, service_role;\s+grant execute on function public\.admin_finalize_payout_change_request_delete_v1\(uuid, uuid\)\s+to authenticated;/)
})

test('v2 reader has independent filters and preserves hardened applicant privacy', () => {
  const reader = functionBody(migration, 'admin_payout_change_requests_v2')
  for (const arg of ['p_employee_no', 'p_employee_name', 'p_team', 'p_position', 'p_reason']) {
    assert.match(reader, new RegExp(`${arg} text default null`))
  }
  assert.match(reader, /public\.can_manage_employee\(request\.employee_id\)/)
  assert.doesNotMatch(reader, /requested_by|requester|login_email/)
  assert.match(reader, /strpos\(btrim\(coalesce\(reviewer\.login_username/)
  assert.match(reader, /strpos\(btrim\(coalesce\(fulfiller\.login_username/)
  assert.match(reader, /grant execute[\s\S]+to authenticated;/)
})
