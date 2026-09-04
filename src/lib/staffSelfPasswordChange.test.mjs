import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8')

const [edge, migration, dialog, layout, login, i18n] = await Promise.all([
  read('../../supabase/functions/staff-change-password/index.ts'),
  read('../../supabase/migrations/20260904083341_staff_self_password_change.sql'),
  read('../components/StaffChangePasswordDialog.jsx'),
  read('../components/AppLayout.jsx'),
  read('../pages/StaffLoginPage.jsx'),
  read('./staffI18n.js'),
])

test('staff password Edge verifies JWT, current lease/IP, and a pure staff identity', () => {
  assert.match(edge, /corsGate\(req\)/)
  assert.match(edge, /admin\.auth\.getUser\(token\)/)
  assert.match(edge, /trustedClientIp\(req\)/)
  assert.match(edge, /rpc\('staff_ip_session_attest'/)
  assert.match(edge, /p_source: 'heartbeat'/)
  assert.match(edge, /rpc\([\s\S]{0,100}'staff_password_change_preflight_v1'/)

  assert.match(migration, /security definer[\s\S]{0,80}set search_path = ''/i)
  assert.match(migration, /access\.employee_portal_enabled = true/)
  assert.match(migration, /access\.backend_enabled = false/)
  assert.match(migration, /lower\(btrim\(role\.code\)\) = 'employee'/)
  assert.match(migration, /lease\.portal = 'staff'/)
  assert.match(migration, /lease\.release_epoch = v_release_epoch/)
  assert.match(migration, /lease\.lease_expires_at > statement_timestamp\(\)/)
  assert.match(migration, /current_staff_ip_attestation_is_valid/)
})

test('current password is reauthenticated with the server-confirmed Auth email before mutation', () => {
  const verifyIndex = edge.indexOf('/auth/v1/token?grant_type=password')
  const updateIndex = edge.indexOf('/auth/v1/user')
  const finalizeIndex = edge.indexOf("'staff_password_change_finalize_v1'")
  assert.ok(verifyIndex > 0 && updateIndex > verifyIndex && finalizeIndex > updateIndex)
  assert.match(edge, /const email = String\(currentAuth\?\.user\?\.email/)
  assert.match(edge, /body: JSON\.stringify\(\{ email, password: currentPassword \}\)/)
  assert.match(edge, /Authorization: `Bearer \$\{verifiedToken\}`/)
  assert.match(edge, /body: JSON\.stringify\(\{ password: newPassword \}\)/)
  assert.doesNotMatch(edge, /auth\.admin\.updateUserById/)
  assert.doesNotMatch(edge, /signInWithPassword/)
})

test('password failure lockout and success clearing are race-safe and no token is returned', () => {
  assert.match(edge, /login_password_failure_register/)
  assert.match(edge, /login_password_success_clear/)
  assert.match(edge, /if \(clearedLock\?\.login_locked\)/)
  assert.match(edge, /releaseCurrentLease\(userClient\)/)
  assert.match(edge, /revokeWithToken\(admin, (?:token|verifiedToken), 'global'\)/)
  assert.match(edge, /PASSWORD_CHANGE_OUTCOME_UNKNOWN/)
  assert.match(edge, /password_change_outcome_unknown: true/)
  const successBody = edge.slice(edge.lastIndexOf("code: 'PASSWORD_CHANGED'"))
  assert.doesNotMatch(successBody, /access_token|refresh_token/)
  assert.doesNotMatch(edge, /console\.(?:log|error)\([^\n]*(?:currentPassword|newPassword|verifiedToken|token),/)
})

test('finalizer atomically clears forced change, audits metadata only, and revokes every session', () => {
  assert.match(migration, /staff_password_change_finalize_v1\([\s\S]*p_verified_session_id uuid/)
  assert.match(migration, /auth_session_matches_current_release\([\s\S]{0,100}p_verified_session_id/)
  assert.match(migration, /set must_change_password = false/)
  assert.match(migration, /'staff_self_password_change'/)
  assert.match(migration, /'all_sessions_revoked', true/)
  assert.match(migration, /delete from public\.staff_ip_session_attestations/)
  assert.match(migration, /delete from public\.app_session_leases[\s\S]{0,100}where lease\.user_id = p_user_id/)
  assert.match(migration, /delete from auth\.sessions[\s\S]{0,100}where auth_session\.user_id = p_user_id/)

  const auditStart = migration.indexOf('insert into public.audit_logs')
  const auditEnd = migration.indexOf('delete from auth.sessions', auditStart)
  const audit = migration.slice(auditStart, auditEnd)
  assert.doesNotMatch(audit, /current_password|new_password|password_hash|password_length/)
  assert.match(migration, /revoke all on function public\.staff_password_change_preflight_v1[\s\S]{0,140}public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.staff_password_change_preflight_v1[\s\S]{0,100}to service_role/)
  assert.match(migration, /revoke all on function public\.staff_password_change_finalize_v1[\s\S]{0,140}public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.staff_password_change_finalize_v1[\s\S]{0,100}to service_role/)
})

test('staff sidebar dialog validates three fields and clears the local session after any changed outcome', () => {
  assert.match(dialog, /autoComplete="current-password"/)
  assert.equal((dialog.match(/autoComplete="new-password"/g) || []).length, 2)
  assert.match(dialog, /STAFF_PASSWORD_RULES/)
  assert.match(dialog, /form\.newPassword !== form\.currentPassword/)
  assert.match(dialog, /form\.newPassword === form\.confirmPassword/)
  assert.match(dialog, /functions\.invoke\('staff-change-password'/)
  assert.match(dialog, /payload\?\.password_changed \|\| payload\?\.password_change_outcome_unknown/)
  assert.match(dialog, /role="dialog"/)
  assert.match(dialog, /aria-modal="true"/)

  assert.match(layout, /staff-sidebar-footer[\s\S]*passwordChange\.open/)
  assert.match(layout, /<StaffChangePasswordDialog/)
  assert.match(layout, /setAppSessionNotice\(notice,'staff'\)/)
  assert.match(layout, /await discardLocalAppSession\(\)/)
  assert.doesNotMatch(layout, /auth\.updateUser|signInWithPassword/)
})

test('login explains administrator reset and all supported staff locales include change-password copy', () => {
  assert.match(login, /auth\.forgotPasswordContactAdmin/)
  assert.match(login, /passwordChange\.success/)
  assert.doesNotMatch(login, /resetPasswordForEmail|forgot-password|recovery redirect/i)
  for (const marker of ['const en = {', 'const zh = {', 'const vi = {', 'const id = {']) {
    const start = i18n.indexOf(marker)
    const next = i18n.indexOf('\nconst ', start + marker.length)
    const dictionary = i18n.slice(start, next < 0 ? undefined : next)
    assert.match(dictionary, /'auth\.forgotPasswordContactAdmin'/)
    assert.match(dictionary, /'passwordChange\.open'/)
    assert.match(dictionary, /'passwordChange\.outcomeUnknown'/)
  }
})
