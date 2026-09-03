import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8')

const [
  loginEdge,
  regularAccountsEdge,
  recoveryAccountsEdge,
  adminLoginPage,
  staffLoginPage,
  adminUsersPage,
] = await Promise.all([
  read('../../supabase/functions/admin-login/index.ts'),
  read('../../supabase/functions/admin-accounts/index.ts'),
  read('../../supabase/functions/admin-accounts/recovery.ts'),
  read('../pages/AdminLoginPage.jsx'),
  read('../pages/StaffLoginPage.jsx'),
  read('../pages/AdminUsersPage.jsx'),
])

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0, `missing start marker: ${startMarker}`)
  assert.ok(end > start, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

test('admin-login prechecks a permanent lock before Auth and counts only invalid_credentials', () => {
  const lockPrecheck = loginEdge.indexOf('const lockState = await readPasswordLockState(admin, access.auth_user_id)')
  const authAttempt = loginEdge.indexOf('const { data: authData, error: authError } = await authenticate(', lockPrecheck)
  assert.ok(lockPrecheck >= 0 && authAttempt > lockPrecheck)

  const precheck = loginEdge.slice(lockPrecheck, authAttempt)
  assert.match(precheck, /if \(lockState\?\.login_locked\) return loginError\(req, 'ACCOUNT_LOCKED', 423/)
  assert.match(precheck, /lock_threshold: Number\(lockState\?\.lock_threshold \|\| 5\)/)

  assert.match(loginEdge, /function isInvalidCredentials\(error: any\) \{[\s\S]{0,180}?return code === 'invalid_credentials'[\s\S]{0,30}?\}/)
  const authFailure = between(loginEdge, 'if (authError) {', 'if (\n      !authData?.user')
  const invalidCredentialBranch = between(
    authFailure,
    'if (isInvalidCredentials(authError)) {',
    'if (isRateLimited(authError))',
  )
  assert.match(invalidCredentialBranch, /registerPasswordFailure\(admin, access\.auth_user_id, mode\)/)
  assert.match(invalidCredentialBranch, /lockState\?\.login_locked \? 'ACCOUNT_LOCKED' : 'PASSWORD_INCORRECT'/)
  assert.equal((authFailure.match(/registerPasswordFailure\(/g) || []).length, 1)
  assert.doesNotMatch(
    authFailure.slice(authFailure.indexOf('if (isRateLimited(authError))')),
    /registerPasswordFailure\(/,
  )
})

test('a successful password is rechecked atomically and a concurrent lock never receives tokens', () => {
  const authAttempt = loginEdge.indexOf('const { data: authData, error: authError } = await authenticate(')
  const successClear = loginEdge.indexOf('const lockState = await clearPasswordFailuresAfterSuccess(admin, authData.user.id)', authAttempt)
  const tokenRead = loginEdge.indexOf('const sessionId = jwtSessionId(authData.session.access_token)', successClear)
  assert.ok(authAttempt >= 0 && successClear > authAttempt && tokenRead > successClear)

  const postAuthLockGuard = loginEdge.slice(successClear, tokenRead)
  assert.match(postAuthLockGuard, /if \(lockState\?\.login_locked\) \{[\s\S]{0,180}?await discardCandidateSession\(authClient\)[\s\S]{0,180}?loginError\(req, 'ACCOUNT_LOCKED', 423/)
  assert.match(postAuthLockGuard, /catch \(lockError\) \{[\s\S]{0,180}?await discardCandidateSession\(authClient\)[\s\S]{0,180}?loginError\(req, 'LOGIN_SERVICE_UNAVAILABLE', 503\)/)
  assert.doesNotMatch(postAuthLockGuard, /access_token|refresh_token/)
})

test('both login pages use the guarded Edge flow and render the server threshold dynamically', () => {
  assert.match(adminLoginPage, /supabase\.functions\.invoke\('admin-login',[\s\S]{0,180}?mode: 'admin'/)
  assert.match(staffLoginPage, /supabase\.functions\.invoke\('admin-login',[\s\S]{0,180}?mode: 'staff'/)
  assert.doesNotMatch(adminLoginPage, /signInWithPassword/)
  assert.doesNotMatch(staffLoginPage, /signInWithPassword/)

  assert.match(adminLoginPage, /response\?\.code === 'ACCOUNT_LOCKED'[\s\S]{0,180}?Number\(response\?\.lock_threshold \|\| 5\)/)
  assert.match(staffLoginPage, /ACCOUNT_LOCKED:[\s\S]{0,220}?\.replace\('\{count\}', String\(Number\(response\?\.lock_threshold \|\| 5\)\)\)/)
})

test('regular account actions preserve exact grants when wildcard access is denied', () => {
  const canStart = regularAccountsEdge.indexOf('const can = (code: string)')
  const canEnd = regularAccountsEdge.indexOf('const audit = async', canStart)
  const effectiveCan = regularAccountsEdge.slice(canStart, canEnd)

  assert.ok(canStart > 0 && canEnd > canStart)
  assert.match(effectiveCan, /!callerDeniedPermissions\.has\(code\)/)
  assert.match(effectiveCan, /callerEffectivePermissions\.has\(code\)/)
  assert.match(effectiveCan, /!callerDeniedPermissions\.has\('\*'\) && callerEffectivePermissions\.has\('\*'\)/)
  assert.doesNotMatch(effectiveCan, /!callerDeniedPermissions\.has\('\*'\)\s*&&\s*!callerDeniedPermissions\.has\(code\)/)
})

test('lockout policy is bounded to 3–99 in UI and both account Edge modes', () => {
  assert.match(adminUsersPage, /const canManageLockoutPolicy = [^\n]*callerCan\('backend_account\.lockout_policy_manage'\)[^\n]*recoveryCan\('update_login_lockout_policy'\)/)
  assert.match(adminUsersPage, /<input type="number" min="3" max="99" step="1"[\s\S]{0,300}?disabled=\{!canManageLockoutPolicy\}/)
  assert.match(adminUsersPage, /!Number\.isInteger\(threshold\) \|\| threshold < 3 \|\| threshold > 99/)
  assert.match(adminUsersPage, /action:'update_login_lockout_policy',[\s\S]{0,100}?lock_threshold:threshold/)

  for (const [edge, nextAction] of [
    [regularAccountsEdge, "if (action === 'reset_password') {"],
    [recoveryAccountsEdge, "if (action === 'generate_activation_code') {"],
  ]) {
    const policyAction = between(
      edge,
      "if (action === 'update_login_lockout_policy') {",
      nextAction,
    )
    assert.match(policyAction, /can\('backend_account\.lockout_policy_manage'\)/)
    assert.match(policyAction, /!Number\.isInteger\(threshold\) \|\| threshold < 3 \|\| threshold > 99/)
    assert.match(policyAction, /rpc\('login_password_lockout_policy_set'/)
    assert.match(policyAction, /p_lock_threshold:threshold/)
    assert.doesNotMatch(policyAction, /can\('account\.edit'\)|can\('backend_account\.view'\)/)
  }
})

test('backend and staff unlocks remain distinct exact-permission operations', () => {
  assert.match(adminUsersPage, /const canUnlockBackend = [^\n]*callerCan\('backend_account\.unlock'\)[^\n]*recoveryCan\('unlock_login'\)/)
  assert.match(adminUsersPage, /const canUnlockStaff = [\s\S]{0,160}?callerCan\('staff_account\.unlock'\)[\s\S]{0,100}?recoveryStaffCan\('unlock_staff_login'\)/)
  assert.match(adminUsersPage, /action:accountKind === 'staff' \? 'unlock_staff_login' : 'unlock_login'/)

  const regularUnlock = between(
    regularAccountsEdge,
    "if (action === 'unlock_login' || action === 'unlock_staff_login') {",
    "if (action === 'update_login_lockout_policy') {",
  )
  assert.match(regularUnlock, /const expectedBackendTarget = action === 'unlock_login'/)
  assert.match(regularUnlock, /if \(backendTarget !== expectedBackendTarget \|\| \(!backendTarget && !current\.employee_portal_enabled\)\)/)
  assert.match(regularUnlock, /const requiredPermission = backendTarget \? 'backend_account\.unlock' : 'staff_account\.unlock'/)
  assert.match(regularUnlock, /if \(!can\(requiredPermission\)\)/)
  assert.match(regularUnlock, /rpc\('login_password_lock_clear'/)
  assert.match(regularUnlock, /cleanString\(error\.code\) === '42501' \? 403 : 400/)

  assert.match(recoveryAccountsEdge, /unlock_login:'backend_account\.unlock'/)
  assert.match(recoveryAccountsEdge, /unlock_staff_login:'staff_account\.unlock'/)
  assert.match(recoveryAccountsEdge, /delegatedRecoveryAccounts[\s\S]{0,350}?accountAction === 'unlock_login'[\s\S]{0,180}?RECOVERY_POLICY_ACTIONS/)
  assert.match(recoveryAccountsEdge, /if \(!delegatedRecoveryAccounts && action !== 'unlock_login'\)/)
  const recoveryStaffUnlock = between(
    recoveryAccountsEdge,
    "if (action === 'unlock_staff_login') {",
    "if (action === 'delete_staff_account') {",
  )
  assert.match(recoveryStaffUnlock, /!can\('staff_account\.view'\) \|\| !can\('staff_account\.unlock'\)/)
  assert.match(recoveryStaffUnlock, /rpc\('login_password_lock_clear'/)
  assert.match(recoveryStaffUnlock, /code:denied \? 'permission_or_scope_denied' : 'unlock_failed'/)
})
