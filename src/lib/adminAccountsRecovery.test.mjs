import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildRecoveryProvisioningFingerprint,
  recoveryIdentityDisposition,
  recoveryProvisioningMaterial,
} from '../../supabase/functions/_shared/recoveryProvisioningFingerprint.js'
import { accountControlPatch, patchAccountRows } from './adminAccountRowUpdate.js'

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8')

test('recovery account edge keeps bootstrap read-only and opens only explicitly bounded recovery operations', async () => {
  const source = await read('../../supabase/functions/admin-accounts/recovery.ts')
  assert.match(source, /'account_list', 'staff_account_list', 'create_backend',[\s\S]+\.\.\.RECOVERY_ACCOUNT_ACTIONS, \.\.\.RECOVERY_ACTIVATION_ACTIONS, \.\.\.RECOVERY_STAFF_ACCOUNT_ACTIONS/)
  assert.match(source, /const RECOVERY_ACCOUNT_ACTIONS = \[[\s\S]+toggle_active[\s\S]+toggle_otp[\s\S]+reset_password[\s\S]+reset_mfa/)
  assert.match(source, /bootstrap[\s\S]+read-only alias of `access`/)
  assert.match(source, /temporarily_paused_for_database_recovery/)
  assert.match(source, /preserve_session:\s*true/)
  assert.doesNotMatch(source, /getAllEmployeeRows|admin_scope_current_employee_directory|loadEffectiveEmployeeScope/)
  assert.doesNotMatch(source, /auth\.admin\.(listUsers|listUserById)/)
  const listStart = source.indexOf("if (action === 'account_list')")
  const controlStart = source.indexOf('if (RECOVERY_ACCOUNT_ACTIONS.includes(action))', listStart)
  const listSource = source.slice(listStart, controlStart)
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
  assert.match(source, /verifyRequestUser\(userClient, \{ action, requestId \}\)/)
  assert.match(source, /for \(let attempt = 1; attempt <= 2; attempt \+= 1\)/)
  assert.match(source, /AUTH_VERIFICATION_RETRY_DELAY_MS = 250/)
  assert.match(source, /status === 401 \|\| status === 403\) return lastResult/)
  assert.match(source, /return retryable\(req, '登录服务暂时繁忙，请稍后重试', 'auth_verification_temporarily_unavailable'\)/)
  assert.match(source, /admin-accounts auth verification unavailable/)
  assert.match(source, /request_id:requestId \|\| null/)
  assert.match(source, /retryable: true,[\s\S]+preserve_session: true/)
  assert.match(source, /DEPENDENCY_TIMEOUT_MS = 8_000/)
  assert.match(source, /typeof \(operation as any\)\?\.abortSignal === 'function'/)
  assert.match(source, /\(operation as any\)\.abortSignal\(controller\.signal\)/)
  assert.match(source, /controller\?\.abort\(\)/)
})

test('online presence recovery separates bounded counts from an authorised detail page', async () => {
  const source = await read('../../supabase/functions/admin-accounts/recovery.ts')
  assert.match(source, /if \(!can\('account\.online_presence\.view'\)\)/)
  assert.match(source, /userClient\.rpc\('admin_online_presence_counts_allowed'\)/)
  const presenceStart = source.indexOf("if (action === 'online_presence')")
  const listStart = source.indexOf("if (action === 'staff_account_list')", presenceStart)
  const presenceSource = source.slice(presenceStart, listStart)
  const rowsStart = presenceSource.indexOf('if (includeRows)')
  const permissionStart = presenceSource.indexOf("if (!can('account.online_presence.view'))", rowsStart)
  const countGuardStart = presenceSource.indexOf("userClient.rpc('admin_online_presence_counts_allowed')")
  assert.ok(rowsStart >= 0 && permissionStart > rowsStart && countGuardStart > rowsStart)
  assert.doesNotMatch(presenceSource, /backend_account\.view|staff_account\.view|employee\.directory\.view/)
  assert.match(source, /select\('user_id', \{ count:'exact', head:true \}\)\.eq\('portal','admin'\)/)
  assert.match(source, /select\('user_id', \{ count:'exact', head:true \}\)\.eq\('portal','staff'\)/)
  assert.match(source, /admin:\{ count:Number\(adminCountResult\.count \|\| 0\), rows:\[\] \}/)
  assert.match(source, /staff:\{ count:Number\(staffCountResult\.count \|\| 0\), rows:\[\] \}/)
  assert.match(source, /const includeRows = body\?\.include_rows === true/)
  assert.match(source, /userClient\.rpc\('admin_online_presence_page_v1'/)
  assert.match(source, /p_page_size:pageSize/)
  assert.match(source, /PRESENCE_DETAIL_TIMEOUT_MS = 4_000/)
  assert.match(source, /count_only:true/)
  assert.match(source, /count_only:false/)
})

test('recovery role page is bounded, Founder-write/others-read-only and never loads the employee scope directory', async () => {
  const source = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const page = await read('../pages/AdminUsersPage.jsx')
  const roleStart = source.indexOf("if (action === 'role_list')")
  const roleSaveStart = source.indexOf("if (action === 'save_role_permissions')", roleStart)
  const roleSource = source.slice(roleStart, roleSaveStart)
  assert.match(roleSource, /if \(!can\('role\.view'\)\)/)
  assert.match(source, /RECOVERY_ROLE_LIMIT = 100/)
  assert.match(source, /RECOVERY_PERMISSION_LIMIT = 500/)
  assert.match(source, /RECOVERY_ROLE_PERMISSION_LIMIT = 5_000/)
  assert.match(roleSource, /from\('roles'\)[\s\S]+from\('permissions'\)[\s\S]+from\('role_permissions'\)/)
  assert.match(roleSource, /recovery_role_mode:true/)
  assert.match(roleSource, /role_permissions_writable:isFounder/)
  assert.doesNotMatch(roleSource, /employees|teams|positions|current_employee_scope_directory|create_role|save_role_permissions/)
  assert.match(page, /fetchRecoveryRoles = \(\) => call\(\{ action:'role_list' \}\)/)
  assert.match(page, /const recoveryRoleMode = Boolean\(data\?\.recovery_role_mode\)/)
  assert.match(page, /recoveryRolePermissionsWritable = Boolean\(/)
  assert.match(page, /roleReadOnly = !canSaveRolePermissions \|\| roleIsLocked/)
  assert.match(page, /callerFounder && !recoveryRoleMode/)
  assert.match(page, /Founder 可勾选并保存现有角色权限，其他账号保持只读/)
})

test('recovery account list is bounded, field-whitelisted and creator-private', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const migration = await read('../../supabase/migrations/20260829101500_bounded_recovery_backend_accounts.sql')
  assert.match(edge, /const DEFAULT_ACCOUNT_PAGE_SIZE = 20/)
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
  assert.match(create, /supportedDataScopes\.add\('assigned_teams'\)/)
  assert.match(create, /team_ids', 'position_ids', 'employee_ids'/)
  assert.match(create, /assigned_scope_requires_team/)
  assert.match(create, /admin\.auth\.admin\.createUser/)
  assert.match(create, /admin_recovery_finalize_backend_account_v2/)
  assert.match(create, /p_actor_user_id:userData\.user\.id/)
  assert.match(create, /admin\.auth\.admin\.deleteUser\(authUserId\)/)
  assert.doesNotMatch(create, /create_backend_batch|body\.accounts|listUsers/)
  assert.match(create, /p_team_ids:teamIds/)
  assert.match(create, /p_position_ids:positionIds/)
  assert.match(create, /p_employee_ids:employeeIds/)
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
    "admin.rpc('admin_recovery_finalize_backend_account_v2'",
    'admin.auth.admin.updateUserById',
    'admin.auth.admin.deleteUser',
  ]) {
    const mutationIndex = create.indexOf(mutation)
    assert.ok(mutationIndex > 0, `${mutation} must exist`)
    assert.doesNotMatch(create.slice(Math.max(0, mutationIndex - 80), mutationIndex), /bounded\(\s*$/)
  }

  const finalize = create.indexOf("admin.rpc('admin_recovery_finalize_backend_account_v2'")
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

  const assigned = {
    ...base,
    dataScope:'assigned_teams',
    teamIds:['team-b', 'team-a'],
    positionIds:['position-a'],
    employeeIds:['employee-a'],
  }
  const assignedFingerprint = await buildRecoveryProvisioningFingerprint(secretKey, assigned)
  assert.notEqual(assignedFingerprint, first)
  assert.equal(
    assignedFingerprint,
    await buildRecoveryProvisioningFingerprint(secretKey, { ...assigned, teamIds:['team-a', 'team-b', 'team-a'] }),
  )
  assert.notEqual(
    assignedFingerprint,
    await buildRecoveryProvisioningFingerprint(secretKey, { ...assigned, employeeIds:['employee-b'] }),
  )
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

  assert.match(edge, /buildRecoveryProvisioningFingerprint\(secretKey, \{[\s\S]+actorUserId:userData\.user\.id[\s\S]+username,[\s\S]+roleId,[\s\S]+employeeId,[\s\S]+dataScope,[\s\S]+teamIds:[\s\S]+positionIds:[\s\S]+employeeIds:[\s\S]+otpRequired,[\s\S]+password,/)
  assert.match(create, /p_fingerprint:provisioningFingerprint/)
  assert.match(create, /\[RECOVERY_PROVISIONING_FINGERPRINT_KEY\]:provisioningFingerprint/)
  assert.match(create, /code:'provisioning_fingerprint_conflict'/)
  const conflictReturn = create.indexOf("if (disposition === 'conflict')")
  const passwordMutation = create.indexOf('admin.auth.admin.updateUserById')
  const finalizerMutation = create.indexOf("admin.rpc('admin_recovery_finalize_backend_account_v2'")
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
  assert.match(page, /bootstrap\?\.degraded && \(mayReadRecoveryAccounts \|\| mayReadRecoveryStaffAccounts \|\| mayReadRecoveryRoles\)/)
  assert.match(page, /action:'account_list'/)
  assert.match(page, /recovery_account_mode/)
  assert.match(page, /account_pagination/)
  assert.match(page, /稳定恢复模式[\s\S]+账号列表支持完整分页/)
  assert.match(page, /if \(recoveryAccountMode\)[\s\S]+action:'create_backend'/)
  assert.match(page, /accountModal\.mode === 'create' && !recoveryAccountMode/)
  assert.match(page, /employee_lookup_only:true/)
})

test('recovery staff account tab keeps its bounded reader separate from the single-account delete action', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const page = await read('../pages/AdminUsersPage.jsx')
  const migration = await read('../../supabase/migrations/20260902111024_restore_bounded_recovery_staff_accounts.sql')
  const staffStart = edge.indexOf("if (action === 'staff_account_list')")
  const deleteStart = edge.indexOf("if (action === 'delete_staff_account')", staffStart)
  const staffSource = edge.slice(staffStart, deleteStart)

  assert.match(staffSource, /can\('staff_account\.view'\)/)
  assert.match(staffSource, /userClient\.rpc\('admin_staff_accounts_page_v1'/)
  assert.doesNotMatch(staffSource, /auth\.admin|\.insert\(|\.update\(|\.delete\(/)
  assert.match(staffSource, /recovery_staff_account_mode:true/)
  assert.match(page, /fetchRecoveryStaffAccounts/)
  assert.match(page, /key === 'staff' && recoveryStaffAccountMode/)
  assert.match(page, /!recoveryStaffAccountMode && callerCan\('user\.account\.create'\)/)
  assert.match(page, /!recoveryStaffAccountMode && callerCan\('staff_account\.mfa_reset'\)/)
  assert.match(page, /员工前端账号支持受权限分页查看、搜索，以及逐个删除登录账号/)
  assert.match(page, /onPage=\{nextPage => refreshRecoveryStaffAccountPage/)

  assert.match(migration, /session_private\.current_app_session_is_valid\('admin'\)/)
  assert.match(migration, /public\.has_permission\('staff_account\.view'\)/)
  assert.match(migration, /public\.user_scope_employees/)
  assert.match(migration, /set statement_timeout = '3500ms'/)
  assert.match(migration, /limit v_page_size/)
  assert.match(migration, /revoke all on function public\.admin_staff_accounts_page_v1/)
  assert.match(migration, /grant execute on function public\.admin_staff_accounts_page_v1[\s\S]+to authenticated/)
})

test('recovery permission overrides preserve exact grants when wildcard access is denied', async () => {
  const source = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const canStart = source.indexOf('const can = (code: string)')
  const canEnd = source.indexOf('const delegatedRecoveryAccounts', canStart)
  const effectiveCan = source.slice(canStart, canEnd)

  assert.ok(canStart > 0 && canEnd > canStart)
  assert.match(effectiveCan, /!deniedPermissions\.has\(code\)/)
  assert.match(effectiveCan, /permissions\.has\(code\)/)
  assert.match(effectiveCan, /!deniedPermissions\.has\('\*'\) && permissions\.has\('\*'\)/)
  assert.doesNotMatch(effectiveCan, /!deniedPermissions\.has\('\*'\)\s*&&\s*!deniedPermissions\.has\(code\)/)
})

test('recovery staff deletion is exact, staff-only, fail-closed and outcome-reconciled', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const migration = await read('../../supabase/migrations/20260902120253_recovery_staff_account_safe_delete.sql')
  const deleteStart = edge.indexOf("if (action === 'delete_staff_account')")
  const backendStart = edge.indexOf("if (action === 'account_list')", deleteStart)
  const deletion = edge.slice(deleteStart, backendStart)

  assert.match(edge, /const RECOVERY_STAFF_ACCOUNT_ACTIONS = \['delete_staff_account'\]/)
  assert.match(edge, /supported_staff_account_actions:can\('staff_account\.view'\) && can\('user\.account\.delete'\)/)
  assert.match(deletion, /new Set\(\[[\s\S]+'expected_login_email'[\s\S]+'expected_employee_no'/)
  assert.match(deletion, /admin_recovery_prepare_staff_account_delete_v1/)
  assert.match(deletion, /admin\.auth\.admin\.getUserById\(targetAuthUserId\)/)
  assert.match(deletion, /clean\(authUser\.email\)\.toLowerCase\(\) !== expectedLoginEmail/)
  const prepare = deletion.indexOf("admin_recovery_prepare_staff_account_delete_v1")
  const exactAuthRead = deletion.indexOf('admin.auth.admin.getUserById(targetAuthUserId)', prepare)
  const secondGate = deletion.indexOf('await recheckRecoveryMutationGate()', exactAuthRead)
  const reprepare = deletion.indexOf("admin_recovery_prepare_staff_account_delete_v1", secondGate)
  const hardDelete = deletion.indexOf('admin.auth.admin.deleteUser(targetAuthUserId, false)', reprepare)
  const reconcile = deletion.indexOf('RECOVERY_STAFF_ACCOUNT_DELETE_RECONCILE', hardDelete)
  const finalize = deletion.indexOf('admin_recovery_finalize_staff_account_delete_v1', reconcile)
  assert.ok(prepare > 0 && exactAuthRead > prepare && secondGate > exactAuthRead)
  assert.ok(reprepare > secondGate && hardDelete > reprepare && reconcile > hardDelete && finalize > reconcile)
  assert.match(deletion, /clean\(reprepared\.operation_id\) !== operationId/)
  assert.match(deletion, /staff_account_delete_outcome_unknown/)
  assert.match(deletion, /staff_account_delete_finalize_pending/)
  assert.doesNotMatch(edge.match(/const RECOVERY_ACCOUNT_ACTIONS = \[[\s\S]*?\]/)?.[0] || '', /delete/)

  const tableStart = migration.indexOf('create table if not exists scope_private.recovery_staff_account_delete_operations')
  const prepareStart = migration.indexOf('create or replace function public.admin_recovery_prepare_staff_account_delete_v1')
  const finalizeStart = migration.indexOf('create or replace function public.admin_recovery_finalize_staff_account_delete_v1')
  const tableSource = migration.slice(tableStart, prepareStart)
  const prepareSource = migration.slice(prepareStart, finalizeStart)
  const finalizeSource = migration.slice(finalizeStart)
  assert.match(tableSource, /event_type in \('prepared', 'finalized'\)/)
  assert.match(tableSource, /recovery_staff_delete_ledger_is_immutable/)
  assert.match(tableSource, /before update or delete on scope_private\.recovery_staff_account_delete_operations/)
  assert.doesNotMatch(tableSource, /target_auth_user_id[^\n]+references auth\.users/i)
  assert.match(prepareSource, /array\['staff_account\.view', 'user\.account\.delete'\]/)
  assert.match(prepareSource, /v_actor_role_code <> 'founder'/)
  assert.match(prepareSource, /permission\.code = v_required_permission/)
  assert.match(prepareSource, /permission\.code = '\*'/)
  assert.match(prepareSource, /target\.backend_enabled = false[\s\S]+target\.employee_portal_enabled = true/)
  assert.match(prepareSource, /target_role\.code = 'employee'/)
  assert.match(prepareSource, /v_target_email is distinct from v_expected_email[\s\S]+v_target_employee_no is distinct from v_expected_employee_no/)
  assert.match(prepareSource, /public\.user_scope_employees scoped_employee/)
  assert.match(prepareSource, /stored\.owner_id = p_target_user_id::text/)
  const storageGuard = prepareSource.indexOf('staff_account_owns_storage_objects')
  const deactivate = prepareSource.indexOf('set active = false')
  assert.ok(storageGuard > 0 && deactivate > storageGuard)
  assert.match(prepareSource, /delete from public\.app_session_leases/)
  assert.match(prepareSource, /delete from auth\.sessions/)
  assert.match(finalizeSource, /exists \(select 1 from auth\.users auth_user where auth_user\.id = p_target_user_id\)/)
  assert.match(finalizeSource, /on conflict \(operation_id, event_type\) do nothing/)
  assert.match(finalizeSource, /'account_delete'/)
  assert.match(finalizeSource, /'employee_profile_retained', true/)
  assert.match(finalizeSource, /revoke all on function public\.admin_recovery_prepare_staff_account_delete_v1[\s\S]+service_role/)
  assert.match(finalizeSource, /grant execute on function public\.admin_recovery_prepare_staff_account_delete_v1[\s\S]+to service_role/)
  assert.match(finalizeSource, /revoke all on function public\.admin_recovery_finalize_staff_account_delete_v1[\s\S]+service_role/)
  assert.match(finalizeSource, /grant execute on function public\.admin_recovery_finalize_staff_account_delete_v1[\s\S]+to service_role/)
})

test('recovery activation-code generation is one-employee, atomic, scoped and plaintext-free', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const firstMigration = await read('../../supabase/migrations/20260902152000_recovery_activation_code_atomic.sql')
  const migration = await read('../../supabase/migrations/20260902154500_recovery_activation_code_service_boundary.sql')
  const actionStart = edge.indexOf("if (action === 'generate_activation_code')")
  const nextAction = edge.indexOf("if (action === 'online_presence')", actionStart)
  const action = edge.slice(actionStart, nextAction)

  assert.match(edge, /const RECOVERY_ACTIVATION_ACTIONS = \['generate_activation_code'\]/)
  assert.match(edge, /\.\.\.RECOVERY_ACCOUNT_ACTIONS, \.\.\.RECOVERY_ACTIVATION_ACTIONS, \.\.\.RECOVERY_STAFF_ACCOUNT_ACTIONS/)
  assert.match(action, /can\('user\.activation\.generate'\)/)
  assert.match(action, /new Set\(\['action', 'employee_no', 'valid_hours'\]\)/)
  assert.match(action, /await recheckRecoveryMutationGate\(\)/)
  assert.match(edge, /normalize\('NFKC'\)[\s\S]+replace\(\/\[\\u200B[\s\S]+\\s\]\+\/gu, ''\)/)
  assert.doesNotMatch(edge.match(/const normalizeEmployeeNo[\s\S]+?\.toUpperCase\(\)/)?.[0] || '', /\[\^A-Z0-9\]/)
  assert.match(action, /admin\.rpc\('admin_recovery_generate_activation_code_v2'/)
  assert.match(action, /p_actor_user_id:userData\.user\.id/)
  assert.match(action, /p_actor_session_id:jwtSessionId\(authorization\)/)
  assert.match(action, /p_code_hash:await sha256\(activationCode\)/)
  assert.match(action, /p_code_hint:activationCode\.slice\(-4\)/)
  assert.doesNotMatch(action, /admin\.from\('employees'\)|getScopedEmployees|admin_scope_current_employee_directory/)

  assert.match(firstMigration, /create unique index if not exists employee_activation_codes_code_hash_unique_idx/)
  assert.match(firstMigration, /revoke all on function public\.generate_employee_activation_code\(text,integer\)[\s\S]+authenticated/)
  assert.match(migration, /drop function public\.admin_recovery_generate_activation_code_v1/)
  assert.match(migration, /security definer[\s\S]+set search_path = ''[\s\S]+set statement_timeout = '3000ms'/i)
  assert.match(migration, /public\.app_session_leases[\s\S]+auth\.sessions[\s\S]+lease\.user_id = p_actor_user_id[\s\S]+lease\.session_id = p_actor_session_id/)
  assert.match(migration, /permission\.code = 'user\.activation\.generate'/)
  assert.match(migration, /permission\.code = '\*'/)
  assert.match(migration, /public\.employee_master_normalize_id\(employee\.employee_no\) = v_normalized_employee_no/)
  assert.match(migration, /employee\.status = 'active'/)
  assert.match(migration, /v_actor_scope in \('own_team', 'assigned_teams'\)[\s\S]+public\.user_scope_employees/)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /employee_portal_enabled = true/)
  assert.match(migration, /update public\.employee_activation_codes[\s\S]+insert into public\.employee_activation_codes/)
  assert.match(migration, /insert into public\.audit_logs/)
  assert.doesNotMatch(migration, /'activation_code'[\s\S]{0,80}jsonb_build_object/i)
  assert.match(migration, /without storing plaintext/)
  assert.match(migration, /grant execute on function public\.admin_recovery_generate_activation_code_v2[\s\S]+to service_role/)
  assert.match(migration, /revoke all on function public\.admin_recovery_generate_activation_code_v2[\s\S]+authenticated/)
  const sessionError = action.indexOf('/session_not_current/i.test(message)')
  const permissionError = action.indexOf("code === '42501'", sessionError)
  assert.ok(sessionError > 0 && permissionError > sessionError)
})

test('staff Auth hard deletion preserves historical exam assignments by nulling their actor reference', async () => {
  const migration = await read('../../supabase/migrations/20260902120311_preserve_exam_assignments_on_auth_delete.sql')
  assert.match(migration, /column_info\.column_name = 'updated_by'/)
  assert.match(migration, /v_nullable is distinct from 'YES'/)
  assert.match(migration, /drop constraint if exists exam_assignments_updated_by_fkey/)
  assert.match(migration, /foreign key \(updated_by\)[\s\S]+references auth\.users\(id\)[\s\S]+on delete set null[\s\S]+not valid/)
  assert.match(migration, /validate constraint exam_assignments_updated_by_fkey/)
})

test('recovery account controls are exact-permission, capability-gated and page-stable', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const page = await read('../pages/AdminUsersPage.jsx')
  assert.match(edge, /RECOVERY_ACCOUNT_ACTION_PERMISSION[\s\S]+toggle_active:'account\.disable'[\s\S]+toggle_otp:'account\.otp_toggle'[\s\S]+reset_password:'account\.reset_password'[\s\S]+reset_mfa:'backend_account\.mfa_reset'/)
  assert.match(edge, /supportedRecoveryAccountActions[\s\S]+filter\(accountAction => can\(RECOVERY_ACCOUNT_ACTION_PERMISSION\[accountAction\]\)\)/)
  assert.match(edge, /supported_account_actions:supportedRecoveryAccountActions/)
  assert.match(edge, /const requiredPermission = RECOVERY_ACCOUNT_ACTION_PERMISSION\[action\]/)
  assert.match(edge, /admin_recovery_backend_action_allowed/)
  assert.match(edge, /recheckRecoveryMutationGate\(\)/)
  assert.match(edge, /admin_recovery_set_backend_account_control/)
  assert.match(edge, /admin_recovery_finalize_backend_auth_control/)
  assert.match(edge, /targetAuthUserId === userData\.user\.id/)
  assert.match(edge, /target\.role_code === 'founder'/)
  assert.match(edge, /factorIds\.length > 10/)
  assert.match(edge, /password_reset_outcome_unknown/)
  assert.match(edge, /preserve_session:true/)
  assert.match(page, /recoveryAccountActions = new Set\(data\?\.supported_account_actions \|\| \[\]\)/)
  assert.match(page, /recoveryCan\('toggle_active'\)/)
  assert.match(page, /recoveryCan\('toggle_otp'\)/)
  assert.match(page, /recoveryCan\('reset_password'\)/)
  assert.match(page, /recoveryCan\('reset_mfa'\)/)
  assert.match(page, /recoveryCan = action => Boolean\(recoveryAccountMode && recoveryAccountActions\.has\(action\)\)/)
  assert.match(page, /setData\(current => patchAccountRows\(current, a\.auth_user_id, controls/)
  assert.match(page, /requestedPage > lastPage/)
  assert.match(page, /!founder && canResetBackendPassword/)
  assert.match(page, /!founder && canResetBackendMfa/)
})

test('single-account controls patch only their row and never reload the whole account page', async () => {
  const page = await read('../pages/AdminUsersPage.jsx')
  const regularEdge = await read('../../supabase/functions/admin-accounts/index.ts')
  const otpStart = page.indexOf('const toggleOtp = async')
  const activeStart = page.indexOf('const toggleActive = async', otpStart)
  const passwordStart = page.indexOf('const resetPassword = async', activeStart)
  const otpSource = page.slice(otpStart, activeStart)
  const activeSource = page.slice(activeStart, passwordStart)
  for (const source of [otpSource, activeSource]) {
    assert.match(source, /setMutatingAccountId\(a\.auth_user_id\)/)
    assert.match(source, /patchAccountRows/)
    assert.doesNotMatch(source, /await (?:load|refreshRecoveryAccountPage)\(/)
  }
  assert.match(regularEdge, /saved: \{ auth_user_id: target, otp_required: required \}/)
  assert.match(regularEdge, /saved: \{ auth_user_id: target, active \}/)
  assert.match(page, /access-account-row-mutating/)
  assert.match(page, /OTP 设置失败：/)
  assert.match(page, /账号状态修改失败：/)
})

test('row patching is immutable, authoritative and keeps bounded pagination coherent', () => {
  const original = {
    backend_accounts:[{ auth_user_id:'backend-1', active:true, otp_required:false, label:'kept' }],
    employee_accounts:[{ auth_user_id:'staff-1', active:false }],
    account_pagination:{ total:7, page:1 },
  }
  const authoritative = accountControlPatch(
    { active:false, otp_required:true, ignored:'server-only-field' },
    { active:true },
  )
  assert.deepEqual(authoritative, { active:false, otp_required:true })
  const backend = patchAccountRows(original, 'backend-1', authoritative, -1)
  assert.notEqual(backend, original)
  assert.deepEqual(backend.backend_accounts[0], {
    auth_user_id:'backend-1', active:false, otp_required:true, label:'kept',
  })
  assert.equal(backend.account_pagination.total, 6)
  assert.equal(original.backend_accounts[0].active, true)
  assert.equal(original.account_pagination.total, 7)
  const staff = patchAccountRows(original, 'staff-1', { active:true })
  assert.equal(staff.employee_accounts[0].active, true)
  assert.equal(staff.backend_accounts[0], original.backend_accounts[0])
})

test('delegated recovery account search has complete server-side status filtering', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const page = await read('../pages/AdminUsersPage.jsx')
  const migration = await read('../../supabase/migrations/20260829130000_delegate_recovery_backend_account_controls.sql')
  assert.match(edge, /const status = clean\(body\?\.status \|\| 'all'\)/)
  assert.match(edge, /admin_recovery_backend_accounts_page/)
  assert.match(edge, /supported_account_filters:delegatedRecoveryAccounts \? \['status'\] : \[\]/)
  assert.match(page, /status:String\(search\?\.status \|\| 'all'\)/)
  assert.match(page, /<option value="active">/)
  assert.match(page, /<option value="inactive">/)
  assert.match(migration, /v_status not in \('all', 'active', 'inactive'\)/)
  assert.match(migration, /v_status = 'active' and access\.active/)
  assert.match(migration, /v_status = 'inactive' and not access\.active/)
  assert.match(migration, /v_page_size constant integer := 20/)
  assert.match(migration, /set statement_timeout = '2500ms'/)
})

test('delegated recovery account list supports bounded page sizes and complete navigation', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const page = await read('../pages/AdminUsersPage.jsx')
  const migration = await read('../../supabase/migrations/20260829160000_recovery_backend_account_page_sizes.sql')
  assert.match(edge, /ACCOUNT_PAGE_SIZE_OPTIONS = new Set\(\[20, 30, 50, 100, 200\]\)/)
  assert.match(edge, /admin_recovery_backend_accounts_page_v2/)
  assert.match(edge, /p_page_size:pageSize/)
  assert.match(edge, /invalid_account_page_size/)
  assert.match(edge, /supported_account_page_sizes:delegatedRecoveryAccounts/)
  assert.match(page, /supportedAccountPageSizes = Array\.isArray/)
  assert.match(page, /pageSizeOptions=\{supportedAccountPageSizes\}/)
  assert.match(page, /onPage=\{nextPage => refreshRecoveryAccountPage/)
  assert.match(page, /onPageSize=\{nextPageSize => refreshRecoveryAccountPage\(accessSearchQuery, 1, nextPageSize\)\}/)
  assert.match(page, /fetchRecoveryAccounts\(blankAccessSearch\(\), 1, accountPageSize, \{[\s\S]+employee_lookup_only:true/)
  assert.match(migration, /v_page_size not in \(20, 30, 50, 100, 200\)/)
  assert.match(migration, /limit v_page_size/)
  assert.match(migration, /set statement_timeout = '3000ms'/)
  assert.match(migration, /revoke all on function public\.admin_recovery_backend_accounts_page_v2[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.admin_recovery_backend_accounts_page_v2[\s\S]+to service_role/)
})

test('delegated recovery authorization is service-only and enforced before Auth mutations', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const migration = await read('../../supabase/migrations/20260829130000_delegate_recovery_backend_account_controls.sql')
  assert.match(migration, /v_actor_scope is distinct from 'all'/)
  assert.match(migration, /permission\.code in \('\*', p_required_permission\)/)
  assert.doesNotMatch(migration, /if v_actor_has_wildcard then return true/)
  assert.match(migration, /return \(v_subset and v_strictly_lower\)[\s\S]+v_explicitly_delegated and not v_target_has_override_expansion/)
  assert.match(migration, /v_target_role_code = 'founder'/)
  assert.match(migration, /create or replace function public\.admin_recovery_backend_action_allowed/)
  assert.match(migration, /revoke all on function public\.admin_recovery_backend_action_allowed[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.admin_recovery_backend_action_allowed[\s\S]+to service_role/)
  const preflightIndex = edge.indexOf("admin.rpc('admin_recovery_backend_action_allowed'")
  const passwordMutationIndex = edge.indexOf('admin.auth.admin.updateUserById', preflightIndex)
  const mfaMutationIndex = edge.indexOf('admin.auth.admin.mfa.listFactors', preflightIndex)
  assert.ok(preflightIndex > 0 && passwordMutationIndex > preflightIndex && mfaMutationIndex > preflightIndex)
})

test('recovery account control migration keeps state, leases and audit atomic', async () => {
  const migration = await read('../../supabase/migrations/20260829123000_recovery_founder_backend_account_controls.sql')
  assert.match(migration, /admin_recovery_set_backend_account_control/)
  assert.match(migration, /actor_role\.code = 'founder'/)
  assert.match(migration, /for update of target/)
  assert.match(migration, /v_target_role_code = 'founder'/)
  assert.match(migration, /update public\.user_access target[\s\S]+delete from public\.app_session_leases[\s\S]+insert into public\.audit_logs/)
  assert.match(migration, /admin_recovery_finalize_backend_auth_control/)
  assert.match(migration, /must_change_password = true/)
  assert.match(migration, /revoke all on function public\.admin_recovery_set_backend_account_control[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.admin_recovery_set_backend_account_control[\s\S]+to service_role/)
})
