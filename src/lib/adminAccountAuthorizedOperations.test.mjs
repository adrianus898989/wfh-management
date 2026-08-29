import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8')

test('regular account controls are permission-driven and never Founder-only', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/index.ts')
  const page = await read('../pages/AdminUsersPage.jsx')

  assert.match(edge, /callerEffectivePermissions\.has\('\*'\) \|\| callerEffectivePermissions\.has\(code\)/)
  assert.match(edge, /current\.backend_enabled \? 'account\.disable' : 'user\.account\.disable'/)
  assert.match(edge, /current\.backend_enabled \? 'account\.reset_password' : 'user\.password\.reset'/)
  assert.match(edge, /targetAccount\.backend_enabled \? 'backend_account\.mfa_reset' : 'staff_account\.mfa_reset'/)
  assert.match(edge, /current\.backend_enabled \? 'account\.delete' : 'user\.account\.delete'/)
  assert.match(edge, /if \(!can\('account\.otp_toggle'\)\)/)

  assert.match(page, /const canToggleBackend = \(!recoveryAccountMode && callerCan\('account\.disable'\)\)/)
  assert.match(page, /const canResetBackendPassword = \(!recoveryAccountMode && callerCan\('account\.reset_password'\)\)/)
  assert.match(page, /const canResetBackendMfa = \(!recoveryAccountMode && callerCan\('backend_account\.mfa_reset'\)\)/)
  assert.match(page, /!founder && canToggleBackend/)
  assert.match(page, /!founder && canResetBackendPassword/)
  assert.match(page, /!founder && canResetBackendMfa/)
  assert.doesNotMatch(page, /callerFounder\s*&&\s*can(?:Toggle|Reset)Backend/)
})

test('regular account controls fail closed for self, Founder and out-of-scope or peer targets', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/index.ts')
  const targetStart = edge.indexOf('async function getTargetAccount')
  const accessStart = edge.indexOf("if (action === 'access')", targetStart)
  const targetGuard = edge.slice(targetStart, accessStart)

  assert.match(targetGuard, /targetAuthUserId === authenticatedUser\.id/)
  assert.match(targetGuard, /targetRole\?\.code === 'founder'/)
  assert.match(targetGuard, /requireEmployeeInScope\(targetAccess\.employee_id\)/)
  assert.match(targetGuard, /targetEffectiveScopeWithinCaller\(targetAuthUserId, targetAccess\)/)
  assert.match(targetGuard, /permissionsWithinCaller\(targetPermissions, true\)/)
  assert.match(targetGuard, /不能管理权限级别相同、较高或权限集合不同的账号/)

  const containmentStart = edge.indexOf('async function targetEffectiveScopeWithinCaller')
  const validationStart = edge.indexOf('async function validateDelegatedScope', containmentStart)
  const containment = edge.slice(containmentStart, validationStart)
  const structureCheck = containment.indexOf('scopeStructureWithinCaller(access, selection)')
  const inactiveGrant = containment.indexOf('if (access?.active === false) return true')
  assert.ok(structureCheck > 0 && inactiveGrant > structureCheck)
  assert.match(containment, /Dynamic own-team and[\s\S]+all-data targets already fail that structural check/)

  const otpStart = edge.indexOf("if (action === 'toggle_otp')")
  const activeStart = edge.indexOf("if (action === 'toggle_active')", otpStart)
  const otp = edge.slice(otpStart, activeStart)
  assert.match(otp, /current = await getTargetAccount\(target\)/)
  assert.match(otp, /if \(!current\.backend_enabled\)/)
  assert.match(otp, /后台登录 OTP 开关只能用于后台账号/)
})

test('recovery controls delegate only exact sensitive capabilities and recheck server authority', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const migration = await read('../../supabase/migrations/20260829130000_delegate_recovery_backend_account_controls.sql')

  assert.match(edge, /toggle_active:'account\.disable'/)
  assert.match(edge, /toggle_otp:'account\.otp_toggle'/)
  assert.match(edge, /reset_password:'account\.reset_password'/)
  assert.match(edge, /reset_mfa:'backend_account\.mfa_reset'/)
  assert.match(edge, /RECOVERY_ACCOUNT_ACTIONS\.filter\(accountAction => can\(RECOVERY_ACCOUNT_ACTION_PERMISSION\[accountAction\]\)\)/)
  assert.match(edge, /targetAuthUserId === userData\.user\.id/)
  assert.match(edge, /recheckRecoveryMutationGate\(\)/)
  assert.match(edge, /admin_recovery_backend_action_allowed/)

  assert.match(migration, /permission\.code in \('\*', p_required_permission\)/)
  assert.match(migration, /v_target_role_code = 'founder'/)
  assert.match(migration, /return \(v_subset and v_strictly_lower\)/)
  assert.match(migration, /v_explicitly_delegated and not v_target_has_override_expansion/)
  assert.match(migration, /v_actor_scope is distinct from 'all'/)
  assert.match(migration, /revoke all on function public\.admin_recovery_backend_action_allowed[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.admin_recovery_backend_action_allowed[\s\S]+to service_role/)
})
