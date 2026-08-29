import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildRecoveryProvisioningFingerprint,
  recoveryIdentityDisposition,
  recoveryProvisioningMaterial,
} from '../../supabase/functions/_shared/recoveryProvisioningFingerprint.js'

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8')

test('recovery account edge keeps bootstrap read-only and opens only bounded account list/create operations', async () => {
  const source = await read('../../supabase/functions/admin-accounts/recovery.ts')
  assert.match(source, /\['access', 'bootstrap', 'dashboard', 'online_presence', 'role_list', 'account_list', 'create_backend'\]\.includes\(action\)/)
  assert.match(source, /bootstrap[\s\S]+read-only alias of `access`/)
  assert.match(source, /temporarily_paused_for_database_recovery/)
  assert.match(source, /preserve_session:\s*true/)
  assert.doesNotMatch(source, /getAllEmployeeRows|admin_scope_current_employee_directory|loadEffectiveEmployeeScope/)
  assert.doesNotMatch(source, /auth\.admin\.(listUsers|listUserById)/)
  const listStart = source.indexOf("if (action === 'account_list')")
  const createStart = source.indexOf("if (action === 'create_backend')")
  const listSource = source.slice(listStart, createStart)
  assert.doesNotMatch(listSource, /auth\.admin|\.insert\(|\.update\(|\.delete\(/)
})

test('recovery dashboard uses only the bounded aggregate RPC', async () => {
  const source = await read('../../supabase/functions/admin-accounts/recovery.ts')
  assert.match(source, /action === 'dashboard'[\s\S]+userClient\.rpc\('admin_home_dashboard'\)/)
  assert.match(source, /ADMIN_HOME_DASHBOARD/)
  assert.match(source, /returns aggregates only; it never serializes the employee directory/)
})

test('recovery account edge checks IP and current session before service-role account data', async () => {
  const source = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const ip = source.indexOf('await enforceAdminRequestIp')
  const session = source.indexOf("userClient.rpc('admin_access_session_allowed')")
  const caller = source.indexOf("admin.from('user_access')")
  assert.ok(ip > 0 && session > ip && caller > session)
  assert.match(source, /AdminRequestIpError/)
  assert.match(source, /error\.status >= 500/)
})

test('recovery bootstrap gate exists and is executable only by authenticated services', async () => {
  const source = await read('../../supabase/migrations/20260828183200_admin_access_session_allowed.sql')
  assert.match(source, /create or replace function public\.admin_access_session_allowed\(\)/i)
  assert.match(source, /session_private\.current_app_session_is_valid\('admin'\)/i)
  assert.match(source, /access\.active = true[\s\S]+access\.backend_enabled = true[\s\S]+role\.active = true/i)
  assert.match(source, /revoke all on function public\.admin_access_session_allowed\(\) from public/i)
  assert.match(source, /revoke all on function public\.admin_access_session_allowed\(\) from anon/i)
  assert.match(source, /grant execute on function public\.admin_access_session_allowed\(\) to authenticated/i)
})

test('temporary auth and database errors preserve the session', async () => {
  const source = await read('../../supabase/functions/admin-accounts/recovery.ts')
  assert.match(source, /if \(status === 401 \|\| status === 403\)[\s\S]+not_authenticated/)
  assert.match(source, /return retryable\(req, '登录服务暂时繁忙，请稍后重试'\)/)
  assert.match(source, /retryable: true,[\s\S]+preserve_session: true/)
  assert.match(source, /DEPENDENCY_TIMEOUT_MS = 8_000/)
  assert.match(source, /typeof \(operation as any\)\?\.abortSignal === 'function'/)
  assert.match(source, /\(operation as any\)\.abortSignal\(controller\.signal\)/)
  assert.match(source, /controller\?\.abort\(\)/)
})

test('online presence recovery performs count-only bounded reads', async () => {
  const source = await read('../../supabase/functions/admin-accounts/recovery.ts')
  assert.match(source, /if \(!can\('account\.online_presence\.view'\)\)/)
  assert.match(source, /userClient\.rpc\('admin_online_presence_allowed'\)/)
  const presenceStart = source.indexOf("if (action === 'online_presence')")
  const listStart = source.indexOf("if (action === 'account_list')", presenceStart)
  assert.doesNotMatch(source.slice(presenceStart, listStart), /backend_account\.view|staff_account\.view|employee\.directory\.view/)
  assert.match(source, /select\('user_id', \{ count:'exact', head:true \}\)\.eq\('portal','admin'\)/)
  assert.match(source, /select\('user_id', \{ count:'exact', head:true \}\)\.eq\('portal','staff'\)/)
  assert.match(source, /admin:\{ count:Number\(adminCountResult\.count \|\| 0\), rows:\[\] \}/)
  assert.match(source, /staff:\{ count:Number\(staffCountResult\.count \|\| 0\), rows:\[\] \}/)
})

test('recovery role page is read-only, bounded and never loads the employee scope directory', async () => {
  const source = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const page = await read('../pages/AdminUsersPage.jsx')
  const roleStart = source.indexOf("if (action === 'role_list')")
  const accountStart = source.indexOf("if (action === 'account_list')", roleStart)
  const roleSource = source.slice(roleStart, accountStart)
  assert.match(roleSource, /if \(!can\('role\.view'\)\)/)
  assert.match(source, /RECOVERY_ROLE_LIMIT = 100/)
  assert.match(source, /RECOVERY_PERMISSION_LIMIT = 500/)
  assert.match(source, /RECOVERY_ROLE_PERMISSION_LIMIT = 5_000/)
  assert.match(roleSource, /from\('roles'\)[\s\S]+from\('permissions'\)[\s\S]+from\('role_permissions'\)/)
  assert.match(roleSource, /recovery_role_mode:true/)
  assert.doesNotMatch(roleSource, /employees|teams|positions|current_employee_scope_directory|create_role|save_role_permissions/)
  assert.match(page, /fetchRecoveryRoles = \(\) => call\(\{ action:'role_list' \}\)/)
  assert.match(page, /const recoveryRoleMode = Boolean\(data\?\.recovery_role_mode\)/)
  assert.match(page, /roleReadOnly = recoveryRoleMode \|\| !callerFounder \|\| roleIsLocked/)
  assert.match(page, /callerFounder && !recoveryRoleMode/)
  assert.match(page, /角色与权限只读展示/)
})

test('recovery account list is fixed-page, field-whitelisted and creator-private', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const migration = await read('../../supabase/migrations/20260829101500_bounded_recovery_backend_accounts.sql')
  assert.match(edge, /const ACCOUNT_PAGE_SIZE = 20/)
  assert.match(edge, /new Set\(\['username', 'employee', 'context'\]\)/)
  assert.match(edge, /Object\.keys\(rawSearch\)\.some\(key => !allowedSearchFields\.has\(key\)\)/)
  assert.match(edge, /userClient\.rpc\('admin_backend_accounts_page'/)
  assert.doesNotMatch(edge, /auth\.admin\.(listUsers|listUserById)/)
  assert.match(migration, /v_page_size constant integer := 20/)
  assert.match(migration, /set statement_timeout = '3500ms'/)
  assert.match(migration, /current_app_session_is_valid\('admin'\)/)
  assert.match(migration, /public\.has_permission\('backend_account\.view'\)/)
  assert.match(migration, /public\.user_scope_employees scoped_employee/)
  assert.match(migration, /account_effective_permissions as materialized/)
  assert.match(migration, /target_permission\.permission_id = any\(v_actor_permission_ids\)/)
  assert.match(migration, /backend_role_assignment_rules assignment[\s\S]+base_permission\.role_id = access\.role_id/)
  assert.match(migration, /user_scope_employees target_scope[\s\S]+user_scope_employees caller_scope/)
  assert.match(migration, /from manageable manageable_creator/)
  assert.match(migration, /'account_created_by_label',[\s\S]+其他授权管理员/)
  assert.doesNotMatch(migration, /'account_created_by', page_row\.account_created_by/)
  assert.match(migration, /limit 10/)
})

test('recovery backend creation is single-account, scope-contained and role fail-closed', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const createStart = edge.indexOf("if (action === 'create_backend')")
  const dashboardStart = edge.indexOf("if (action === 'dashboard')", createStart)
  const create = edge.slice(createStart, dashboardStart)
  assert.match(create, /if \(!can\('account\.create'\)\)/)
  assert.match(create, /allowedInputFields/)
  assert.match(create, /loadAssignableRoles\(\)/)
  assert.match(edge, /from\('backend_role_assignment_rules'\)[\s\S]+\.eq\('grantor_role_id', caller\.role_id\)[\s\S]+\.eq\('active', true\)/)
  assert.match(create, /userClient\.rpc\('backend_employee_in_scope'/)
  assert.match(create, /new Set\(\['self'\]\)/)
  assert.match(create, /admin\.auth\.admin\.createUser/)
  assert.match(create, /admin_recovery_finalize_backend_account/)
  assert.match(create, /p_actor_user_id:userData\.user\.id/)
  assert.match(create, /admin\.auth\.admin\.deleteUser\(authUserId\)/)
  assert.doesNotMatch(create, /create_backend_batch|body\.accounts|listUsers/)
  assert.doesNotMatch(create, /assigned_teams/)
})

test('recovery backend creation is deterministic and reconciles every mutation fault', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const migration = await read('../../supabase/migrations/20260829104500_recovery_backend_auth_identity_lookup.sql')
  const createStart = edge.indexOf("if (action === 'create_backend')")
  const dashboardStart = edge.indexOf("if (action === 'dashboard')", createStart)
  const create = edge.slice(createStart, dashboardStart)

  assert.match(edge, /npm:@supabase\/supabase-js@2\.112\.3/)
  assert.match(create, /const internalEmail = `\$\{username\}@\$\{RECOVERY_AUTH_DOMAIN\}`/)
  assert.doesNotMatch(create, /randomUUID/)
  assert.match(create, /app_metadata:\{[\s\S]+wfh_provisioning:RECOVERY_PROVISIONING_MARKER[\s\S]+wfh_login_username:username/)
  assert.match(create, /admin_recovery_find_backend_auth_identity/)
  assert.match(create, /createError \|\| !authUserId[\s\S]+findProvisionedAuthId\(\)/)
  assert.match(create, /admin\.auth\.admin\.updateUserById\(authUserId, \{ password \}\)/)
  const secondIpGate = create.indexOf('await enforceAdminRequestIp')
  const secondSessionGate = create.indexOf("userClient.rpc('admin_access_session_allowed')", secondIpGate)
  const firstAuthMutation = create.indexOf('admin.auth.admin.createUser')
  assert.ok(secondIpGate > 0 && secondSessionGate > secondIpGate && firstAuthMutation > secondSessionGate)
  assert.match(create, /PROVISION_CURRENT_SESSION/)

  for (const mutation of [
    'admin.auth.admin.createUser',
    "admin.rpc('admin_recovery_finalize_backend_account'",
    'admin.auth.admin.updateUserById',
    'admin.auth.admin.deleteUser',
  ]) {
    const mutationIndex = create.indexOf(mutation)
    assert.ok(mutationIndex > 0, `${mutation} must exist`)
    assert.doesNotMatch(create.slice(Math.max(0, mutationIndex - 80), mutationIndex), /bounded\(\s*$/)
  }

  const finalize = create.indexOf("admin.rpc('admin_recovery_finalize_backend_account'")
  const reconcile = create.indexOf('const { data:committedRows', finalize)
  const rollback = create.indexOf('admin.auth.admin.deleteUser(authUserId)', reconcile)
  assert.ok(finalize > 0 && reconcile > finalize && rollback > reconcile)
  assert.match(create, /if \(committed\) return committedSuccess\(committed, authUserId, true\)/)
  assert.match(create, /newlyCreatedAuthIdentity && databaseDefinitelyRolledBack/)
  assert.match(create, /This branch is forbidden for a reused identity/)
  assert.match(create, /query\.or\(`auth_user_id\.eq\.\$\{authUserId\},login_username\.eq\.\$\{username\}`\)/)

  assert.match(migration, /from auth\.users auth_user/)
  assert.match(migration, /account_created_by_column_missing/)
  assert.match(migration, /backend_username_unique_index_missing/)
  assert.match(migration, /recovery_account_finalizer_missing/)
  assert.match(migration, /lower\(auth_user\.email\) = v_expected_email/)
  assert.match(migration, /raw_app_meta_data ->> 'wfh_provisioning'[\s\S]+wfh_backend_recovery_v1/)
  assert.match(migration, /raw_app_meta_data ->> 'wfh_login_username'/)
  assert.match(migration, /revoke all on function public\.admin_recovery_find_backend_auth_identity[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.admin_recovery_find_backend_auth_identity[\s\S]+to service_role/)
})

test('recovery provisioning fingerprint is a stable server-keyed HMAC over every takeover-sensitive field', async () => {
  const secretKey = 'service-secret-only-test-key'
  const base = {
    actorUserId:'11111111-1111-4111-8111-111111111111',
    username:'supervisor.01',
    roleId:'22222222-2222-4222-8222-222222222222',
    employeeId:'33333333-3333-4333-8333-333333333333',
    dataScope:'own_team',
    otpRequired:true,
    password:'StrongPassword#123',
  }
  const material = recoveryProvisioningMaterial(base)
  const expected = createHmac('sha256', secretKey).update(material).digest('hex')
  const first = await buildRecoveryProvisioningFingerprint(secretKey, base)
  const retry = await buildRecoveryProvisioningFingerprint(secretKey, { ...base })
  assert.equal(first, expected)
  assert.equal(retry, first)
  assert.match(first, /^[0-9a-f]{64}$/)

  for (const changed of [
    { actorUserId:'44444444-4444-4444-8444-444444444444' },
    { username:'supervisor.02' },
    { roleId:'55555555-5555-4555-8555-555555555555' },
    { employeeId:'66666666-6666-4666-8666-666666666666' },
    { dataScope:'self' },
    { otpRequired:false },
    { password:'DifferentPassword#456' },
  ]) {
    const fingerprint = await buildRecoveryProvisioningFingerprint(secretKey, { ...base, ...changed })
    assert.notEqual(fingerprint, first, `fingerprint must bind ${Object.keys(changed)[0]}`)
  }
})

test('recovery identity behavior rejects a different duplicate and resumes only an exact response-loss retry', () => {
  const authUserId = '77777777-7777-4777-8777-777777777777'
  assert.equal(
    recoveryIdentityDisposition({ status:422, code:'email_exists', message:'Email already exists' }, ''),
    'conflict',
  )
  assert.equal(
    recoveryIdentityDisposition({ status:422, message:'User already registered' }, ''),
    'conflict',
  )
  assert.equal(
    recoveryIdentityDisposition(new Error('network response lost after create'), authUserId),
    'reuse',
  )
  assert.equal(
    recoveryIdentityDisposition(new Error('network failed before create'), ''),
    'retry',
  )
})

test('recovery identity lookup requires the exact HMAC and removes the deployed two-argument helper', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const migration = await read('../../supabase/migrations/20260829110000_recovery_backend_auth_identity_fingerprint.sql')
  const createStart = edge.indexOf("if (action === 'create_backend')")
  const dashboardStart = edge.indexOf("if (action === 'dashboard')", createStart)
  const create = edge.slice(createStart, dashboardStart)

  assert.match(edge, /buildRecoveryProvisioningFingerprint\(secretKey, \{[\s\S]+actorUserId:userData\.user\.id[\s\S]+username,[\s\S]+roleId,[\s\S]+employeeId,[\s\S]+dataScope,[\s\S]+otpRequired,[\s\S]+password,/)
  assert.match(create, /p_fingerprint:provisioningFingerprint/)
  assert.match(create, /\[RECOVERY_PROVISIONING_FINGERPRINT_KEY\]:provisioningFingerprint/)
  assert.match(create, /code:'provisioning_fingerprint_conflict'/)
  const conflictReturn = create.indexOf("if (disposition === 'conflict')")
  const passwordMutation = create.indexOf('admin.auth.admin.updateUserById')
  const finalizerMutation = create.indexOf("admin.rpc('admin_recovery_finalize_backend_account'")
  assert.ok(conflictReturn > 0 && passwordMutation > conflictReturn && finalizerMutation > passwordMutation)

  assert.match(migration, /revoke all on function public\.admin_recovery_find_backend_auth_identity\(text, text\)[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(migration, /drop function public\.admin_recovery_find_backend_auth_identity\(text, text\)/)
  assert.match(migration, /create function public\.admin_recovery_find_backend_auth_identity\([\s\S]+p_fingerprint text/)
  assert.match(migration, /v_fingerprint !~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(migration, /raw_app_meta_data ->> 'wfh_provisioning_fingerprint'[\s\S]+v_fingerprint/)
  assert.match(migration, /revoke all on function public\.admin_recovery_find_backend_auth_identity\(text, text, text\)[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.admin_recovery_find_backend_auth_identity\(text, text, text\)[\s\S]+to service_role/)
})

test('recovery account finalization makes access, scope and audit atomic', async () => {
  const migration = await read('../../supabase/migrations/20260829101500_bounded_recovery_backend_accounts.sql')
  const start = migration.indexOf('create or replace function public.admin_recovery_finalize_backend_account')
  const source = migration.slice(start)
  assert.match(source, /set statement_timeout = '4500ms'/)
  assert.match(source, /role_not_assignable/)
  assert.match(source, /permission\.code = 'account\.create'/)
  assert.match(source, /employee_out_of_scope/)
  assert.match(source, /founder_required_for_all_scope/)
  assert.match(source, /insert into public\.user_access/)
  assert.match(source, /perform public\.admin_save_account_access_scope/)
  assert.match(source, /insert into public\.audit_logs[\s\S]+backend_account_create/)
  assert.match(source, /'role_code', v_role_code[\s\S]+'data_scope', p_data_scope/)
  assert.match(source, /account_created_by[\s\S]+p_actor_user_id/)
  assert.match(source, /revoke all on function public\.admin_recovery_finalize_backend_account[\s\S]+from public, anon, authenticated/)
  assert.match(source, /grant execute on function public\.admin_recovery_finalize_backend_account[\s\S]+to service_role/)
})

test('bounded account migration fails quickly and checks every dependency', async () => {
  const migration = await read('../../supabase/migrations/20260829101500_bounded_recovery_backend_accounts.sql')
  assert.match(migration, /set local lock_timeout = '2s'/)
  assert.match(migration, /set local statement_timeout = '15s'/)
  assert.match(migration, /backend_role_assignment_rules_missing/)
  assert.match(migration, /atomic_account_scope_writer_missing/)
  assert.match(migration, /account_recovery_relation_missing/)
})

test('account UI detects recovery mode without restoring the full bootstrap', async () => {
  const page = await read('../pages/AdminUsersPage.jsx')
  assert.match(page, /bootstrap\?\.degraded && \(mayReadRecoveryAccounts \|\| mayReadRecoveryRoles\)/)
  assert.match(page, /action:'account_list'/)
  assert.match(page, /recovery_account_mode/)
  assert.match(page, /account_pagination/)
  assert.match(page, /稳定恢复模式[\s\S]+账号列表固定每页 20 条/)
  assert.match(page, /if \(recoveryAccountMode\)[\s\S]+action:'create_backend'/)
  assert.match(page, /accountModal\.mode === 'create' && !recoveryAccountMode/)
  assert.match(page, /employee_lookup_only:true/)
})
