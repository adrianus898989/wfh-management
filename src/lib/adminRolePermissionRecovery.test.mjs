import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8')

test('recovery role permission mutation is Founder-only, field-whitelisted and hard-bounded', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const start = edge.indexOf("if (action === 'save_role_permissions')")
  const end = edge.indexOf("if (action === 'account_list')", start)
  const writer = edge.slice(start, end)

  assert.ok(start > 0 && end > start)
  assert.match(edge, /RECOVERY_ROLE_PERMISSION_WRITE_LIMIT = 500/)
  assert.match(writer, /if \(!isFounder\)/)
  assert.match(writer, /new Set\(\['action', 'role_id', 'permission_ids'\]\)/)
  assert.match(writer, /rawPermissionIds\.length > RECOVERY_ROLE_PERMISSION_WRITE_LIMIT/)
  assert.match(writer, /new Set\(permissionIds\)\.size !== permissionIds\.length/)
  assert.match(writer, /admin\.rpc\('admin_recovery_save_role_permissions'/)
  assert.match(writer, /p_actor_user_id:userData\.user\.id/)
  assert.match(writer, /RECOVERY_ROLE_PERMISSION_SAVE/)
  assert.doesNotMatch(writer, /from\('(?:employees|teams|positions|role_permissions)'\)/)
  assert.doesNotMatch(writer, /\.insert\(|\.update\(|\.delete\(/)
})

test('atomic recovery writer rechecks Founder, locks one role and audits the bounded diff', async () => {
  const migration = await read('../../supabase/migrations/20260829113000_recovery_founder_role_permission_write.sql')
  const functionStart = migration.indexOf('create or replace function public.admin_recovery_save_role_permissions')
  const writer = migration.slice(functionStart)

  assert.ok(functionStart > 0)
  assert.match(writer, /security definer[\s\S]+set search_path = ''/i)
  assert.match(writer, /set statement_timeout = '3500ms'/)
  assert.match(writer, /set lock_timeout = '1500ms'/)
  assert.match(writer, /cardinality\(v_input_ids\) > 500/)
  assert.match(writer, /actor_role\.code[\s\S]+v_actor_role_code <> 'founder'/)
  assert.match(writer, /where role\.id = p_role_id[\s\S]+for no key update/)
  assert.match(writer, /v_target_role_code = 'founder'[\s\S]+v_target_system_locked[\s\S]+not v_target_active/)
  assert.match(writer, /v_hidden_legacy_codes/)
  assert.match(writer, /'adjustment\.page\.approve'/)
  assert.match(writer, /'role\.manage'/)
  assert.match(writer, /insert into public\.role_permissions[\s\S]+delete from public\.role_permissions/)
  assert.match(writer, /insert into public\.audit_logs[\s\S]+'role_permissions_update'/)
  assert.match(writer, /revoke all on function public\.admin_recovery_save_role_permissions\(uuid, uuid, uuid\[\]\)[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(writer, /grant execute on function public\.admin_recovery_save_role_permissions\(uuid, uuid, uuid\[\]\)[\s\S]+to service_role/)
  assert.doesNotMatch(writer, /public\.(?:employees|teams|positions|user_scope_employees|current_employee_scope_directory)/)
})

test('recovery UI enables only permission selection and save for Founder', async () => {
  const page = await read('../pages/AdminUsersPage.jsx')

  assert.match(page, /recoveryRolePermissionsWritable = Boolean\([\s\S]+recoveryRoleMode && callerFounder && data\?\.role_permissions_writable/)
  assert.match(page, /canSaveRolePermissions = Boolean\([\s\S]+callerFounder && \(!recoveryRoleMode \|\| recoveryRolePermissionsWritable\)/)
  assert.match(page, /if \(!roleModal \|\| !canSaveRolePermissions\) return/)
  assert.match(page, /recoveryRoleMode && \(roleModal\.role\.system_locked \|\| roleModal\.role\.active === false\)/)
  assert.match(page, /if \(!recoveryRoleMode && !roleModal\.role\.system_locked[\s\S]+action: 'rename_role'/)
  assert.match(page, /if \(recoveryRoleMode && Array\.isArray\(savedResult\?\.saved\?\.permission_ids\)\)/)
  assert.match(page, /if \(!canSaveRolePermissions\) return/)
  assert.match(page, /recoveryTargetLocked = Boolean\(/)
  assert.match(page, /roleReadOnly = !canSaveRolePermissions \|\| roleIsLocked \|\| recoveryTargetLocked/)
  assert.match(page, /disabled=\{roleReadOnly\|\|recoveryRoleMode\|\|roleModal\.role\.system_locked\}/)
  assert.match(page, /callerFounder && !recoveryRoleMode[\s\S]+新增角色/)
  assert.match(page, /callerFounder&&!recoveryRoleMode&&!role\.system_locked[\s\S]+删除角色/)
})
