import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8')

const [migration, recoveryEdge, regularEdge, registerEdge] = await Promise.all([
  read('../../supabase/migrations/20260904083345_staff_account_retention_soft_delete.sql'),
  read('../../supabase/functions/admin-accounts/recovery.ts'),
  read('../../supabase/functions/admin-accounts/index.ts'),
  read('../../supabase/functions/register-employee/index.ts'),
])

const between = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0, `missing start marker: ${startMarker}`)
  assert.ok(end > start, `missing end marker: ${endMarker}`)
  return source.slice(start, end)
}

test('recovery staff deletion soft-deletes Auth and lets the database reconcile an ambiguous result', () => {
  const action = between(
    recoveryEdge,
    "if (action === 'delete_staff_account') {",
    "if (action === 'account_list') {",
  )
  const firstPrepare = action.indexOf("admin.rpc('admin_recovery_prepare_staff_account_delete_v1'")
  const authRead = action.indexOf('admin.auth.admin.getUserById(targetAuthUserId)', firstPrepare)
  const secondGate = action.indexOf('await recheckRecoveryMutationGate()', authRead)
  const secondPrepare = action.indexOf("admin.rpc('admin_recovery_prepare_staff_account_delete_v1'", secondGate)
  const softDelete = action.indexOf('admin.auth.admin.deleteUser(targetAuthUserId, true)', secondPrepare)
  const finalizer = action.indexOf("admin.rpc('admin_recovery_finalize_staff_account_delete_v1'", softDelete)

  assert.ok(firstPrepare >= 0 && authRead > firstPrepare && secondGate > authRead)
  assert.ok(secondPrepare > secondGate && softDelete > secondPrepare && finalizer > softDelete)
  assert.doesNotMatch(action, /deleteUser\(targetAuthUserId, false\)/)
  assert.doesNotMatch(action.slice(softDelete, finalizer), /getUserById/)
  assert.match(action, /staff_auth_identity_still_active/)
  assert.match(action, /staff_account_delete_outcome_unknown/)
  assert.match(action, /employee_profile_retained/)
  assert.match(action, /exam_history_retained/)
  assert.match(action, /referenced_employee_files_retained/)
})

test('ordinary account endpoint refuses pure-staff deletion before its Auth delete', () => {
  const action = between(
    regularEdge,
    "if (action === 'delete_account') {",
    "if (action === 'create_employee') {",
  )
  const pureStaffGuard = action.indexOf('const pureStaffAccount = !current.backend_enabled')
  const rejection = action.indexOf("code:'staff_delete_requires_recovery'", pureStaffGuard)
  const authDelete = action.indexOf('admin.auth.admin.deleteUser(target)', rejection)
  assert.ok(pureStaffGuard >= 0 && rejection > pureStaffGuard && authDelete > rejection)
  assert.match(action, /current\.employee_portal_enabled === true/)
  assert.doesNotMatch(action.slice(pureStaffGuard, rejection), /targetRole/)
})

test('retention allowlist accepts only old-Auth-prefixed, formally referenced employee files', () => {
  const helper = between(
    migration,
    'create or replace function scope_private.recovery_staff_storage_is_safely_retained(',
    '-- Service-only, side-effect-free password preflight.',
  )
  assert.match(helper, /security definer[\s\S]+set search_path = ''/i)
  assert.match(helper, /stored\.owner_id = p_target_auth_user_id::text[\s\S]+stored\.owner = p_target_auth_user_id/)
  assert.match(helper, /split_part\(stored\.name, '\/', 1\) = p_target_auth_user_id::text/)
  assert.match(helper, /stored\.bucket_id = 'exam-answer-images'[\s\S]+answer\.attachments @>/)
  assert.match(helper, /session_row\.employee_id = p_target_employee_id/)
  assert.match(helper, /session_row\.auth_user_id = p_target_auth_user_id/)
  assert.match(helper, /split_part\(stored\.name, '\/', 2\) = session_row\.id::text/)
  assert.match(helper, /split_part\(stored\.name, '\/', 3\) = answer\.question_id::text/)
  assert.match(helper, /stored\.bucket_id = 'connectivity-evidence'[\s\S]+incident\.employee_id = p_target_employee_id[\s\S]+incident\.attachments @>/)
  assert.match(helper, /stored\.bucket_id = 'payment-change-proof'[\s\S]+request\.employee_id = p_target_employee_id[\s\S]+split_part\(stored\.name, '\/', 2\) = request\.id::text/)
  assert.match(helper, /stored\.name in \([\s\S]+request\.identity_proof_path,[\s\S]+request\.payment_proof_path/)
  assert.match(helper, /and not \([\s\S]+exam-answer-images[\s\S]+connectivity-evidence[\s\S]+payment-change-proof/)
  assert.match(migration, /revoke all on function scope_private\.recovery_staff_storage_is_safely_retained\(uuid, uuid\)[\s\S]+from public, anon, authenticated, service_role/)
})

test('delete finalizer requires a deleted Auth tombstone, removes only access, and retains history', () => {
  const finalizer = between(
    migration,
    'create or replace function public.admin_recovery_finalize_staff_account_delete_v1(',
    'revoke all on function public.admin_recovery_prepare_staff_account_delete_v1',
  )
  assert.match(finalizer, /auth_user\.deleted_at is not null/)
  assert.match(finalizer, /staff_auth_identity_still_active/)
  assert.match(finalizer, /staff_access_row_changed_before_finalize/)
  assert.match(finalizer, /update public\.exam_sessions session_row[\s\S]+set status = 'expired'[\s\S]+status = 'in_progress'/)
  assert.match(finalizer, /delete from public\.user_access target[\s\S]+target\.backend_enabled = false[\s\S]+target\.employee_portal_enabled = true[\s\S]+target_role\.code = 'employee'/)
  assert.match(finalizer, /v_removed_access_rows <> 1/)
  assert.match(finalizer, /delete from public\.app_session_leases[\s\S]+delete from public\.staff_ip_session_attestations[\s\S]+delete from auth\.sessions/)
  assert.match(finalizer, /update public\.employee_activation_codes activation[\s\S]+activation\.used_at is null[\s\S]+activation\.revoked_at is null/)
  assert.match(finalizer, /on conflict \(operation_id, event_type\) do nothing/)
  assert.match(finalizer, /'employee_profile_retained', true[\s\S]+'exam_history_retained', true[\s\S]+'referenced_employee_files_retained', true/)
  assert.match(finalizer, /'unused_activation_codes_revoked', v_revoked_activation_codes/)
  assert.match(finalizer, /login_admin_permission_allowed\([\s\S]+staff_account\.view[\s\S]+login_admin_permission_allowed\([\s\S]+user\.account\.delete/)
  assert.match(finalizer, /v_current_actor_scope in \('own_team', 'assigned_teams'\)/)
  assert.match(migration, /v_expires_at := 'infinity'::timestamptz/)
  assert.doesNotMatch(finalizer, /delete from public\.employees|delete from public\.exam_answers|delete from storage\.objects/)
})

test('re-registered staff see durable history while resume remains bound to current Auth', () => {
  const readGuard = between(
    migration,
    'create or replace function session_private.exam_answer_storage_can_view(p_name text)',
    'revoke all on function session_private.exam_answer_storage_can_view(text)',
  )
  const examHome = between(
    migration,
    'create or replace function public.staff_exam_home()',
    'revoke all on function public.staff_exam_home()',
  )
  assert.match(readGuard, /context_row\.employee_id = session_row\.employee_id/)
  assert.doesNotMatch(readGuard, /session_row\.auth_user_id = \(select auth\.uid\(\)\)/)
  assert.match(examHome, /where session_row\.employee_id = c\.employee_id[\s\S]+session_row\.status <> 'expired'/)
  assert.match(examHome, /where session_row\.employee_id = c\.employee_id[\s\S]+session_row\.auth_user_id = auth\.uid\(\)[\s\S]+session_row\.status = 'in_progress'/)
  assert.match(examHome, /where employee_id = c\.employee_id[\s\S]+status <> 'in_progress'/)

  const payoutRead = between(
    migration,
    'create or replace function session_private.payment_change_staff_can_read_retained_proof(',
    'revoke all on function session_private.payment_change_staff_can_read_retained_proof(text)',
  )
  assert.match(payoutRead, /context_row\.employee_id = request\.employee_id/)
  assert.match(payoutRead, /request\.identity_proof_path = coalesce\(p_name, ''\)[\s\S]+request\.payment_proof_path = coalesce\(p_name, ''\)/)
  assert.match(migration, /create policy payment_change_proof_read[\s\S]+payment_change_staff_can_read_retained_proof\(name\)/)
})

test('staff password reset is exact, double-preflighted, bounded and password-free in database audit', () => {
  assert.match(recoveryEdge, /reset_staff_password:'user\.password\.reset'/)
  const action = between(
    recoveryEdge,
    "if (action === 'reset_staff_password') {",
    "if (action === 'delete_staff_account') {",
  )
  assert.match(action, /new Set\(\[[\s\S]+'password'[\s\S]+'expected_login_email'[\s\S]+'expected_employee_no'/)
  assert.match(action, /!passwordOk\(password\) \|\| password\.length > 128/)
  assert.equal((action.match(/admin_recovery_prepare_staff_password_reset_v1/g) || []).length, 1)
  assert.equal((action.match(/preparePasswordReset\(\)/g) || []).length, 2)
  assert.match(action, /admin\.auth\.admin\.getUserById\(targetAuthUserId\)/)
  assert.match(action, /boundedAuthMutation\([\s\S]+admin\.auth\.admin\.updateUserById\(targetAuthUserId, \{ password \}\)/)
  assert.match(action, /staff_password_reset_outcome_unknown[\s\S]+同一个新密码/)
  assert.match(action, /admin_recovery_finalize_staff_password_reset_v1/)
  assert.match(action, /staff_password_reset_finalize_pending[\s\S]+password_changed:true/)
  assert.match(action, /admin_recovery_revoke_staff_sessions_v1/)
  assert.match(action, /staff_password_reset_outcome_unknown[\s\S]+sessions_revocation_attempted:true/)

  const preflight = between(
    migration,
    'create or replace function public.admin_recovery_prepare_staff_password_reset_v1(',
    'create or replace function public.admin_recovery_finalize_staff_password_reset_v1(',
  )
  const finalizer = between(
    migration,
    'create or replace function public.admin_recovery_finalize_staff_password_reset_v1(',
    'revoke all on function public.admin_recovery_prepare_staff_password_reset_v1',
  )
  assert.match(preflight, /login_admin_permission_allowed\([\s\S]+staff_account\.view[\s\S]+login_admin_permission_allowed\([\s\S]+user\.password\.reset/)
  assert.match(preflight, /target_role\.code = 'employee'/)
  assert.match(preflight, /auth_user\.deleted_at is null/)
  assert.match(preflight, /v_actor_scope in \('own_team', 'assigned_teams'\)[\s\S]+public\.user_scope_employees/)
  assert.match(finalizer, /set must_change_password = false,[\s\S]+password_reset_at = v_reset_at/)
  assert.match(finalizer, /delete from public\.app_session_leases[\s\S]+delete from public\.staff_ip_session_attestations[\s\S]+delete from auth\.sessions/)
  assert.match(finalizer, /insert into public\.audit_logs/)
  assert.doesNotMatch(finalizer, /p_password|new_password|'password',|"password"/i)
  assert.match(migration, /revoke all on function public\.admin_recovery_prepare_staff_password_reset_v1[\s\S]+from public, anon, authenticated, service_role[\s\S]+grant execute[\s\S]+to service_role/)
})

test('session safety net is service-only and activation accepts only active or probation staff', () => {
  const revoker = between(
    migration,
    'create or replace function public.admin_recovery_revoke_staff_sessions_v1(',
    'revoke all on function public.admin_recovery_prepare_staff_password_reset_v1',
  )
  assert.match(revoker, /target_role\.code = 'employee'/)
  assert.match(revoker, /lower\(btrim\(auth_user\.email\)\) = v_expected_email/)
  assert.match(revoker, /delete from public\.app_session_leases[\s\S]+delete from public\.staff_ip_session_attestations[\s\S]+delete from auth\.sessions/)
  assert.match(migration, /revoke all on function public\.admin_recovery_revoke_staff_sessions_v1[\s\S]+from public, anon, authenticated, service_role[\s\S]+grant execute[\s\S]+to service_role/)
  assert.match(migration, /recovery_activation_v2_status_patch_count_mismatch/)
  assert.match(migration, /procedure\.proconfig @> array\['search_path=""'\]::text\[\]/)
  assert.match(migration, /employee\.status in \('active', 'probation'\)/)
  assert.match(regularEdge, /getScopedEmployees\(false\)[\s\S]+\['active', 'probation'\]\.includes\(cleanString\(x\.status\)\.toLowerCase\(\)\)/)
  assert.match(registerEdge, /\['active', 'probation'\]\.includes\(String\(employee\.status \|\| ''\)\.trim\(\)\.toLowerCase\(\)\)/)
})
