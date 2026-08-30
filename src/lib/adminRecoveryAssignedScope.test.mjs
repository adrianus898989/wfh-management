import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8')

test('recovery edge exposes a bounded current-organization scope directory', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const directoryStart = edge.indexOf("if (action === 'scope_directory')")
  const accountListStart = edge.indexOf("if (action === 'account_list')", directoryStart)
  const directory = edge.slice(directoryStart, accountListStart)

  assert.ok(directoryStart > 0 && accountListStart > directoryStart)
  assert.match(directory, /can\('account\.edit'\) \|\| !can\('scope\.manage'\)/)
  assert.match(directory, /recoveryBackendActionAllowed\(targetAuthUserId, 'account\.edit'\)/)
  assert.match(directory, /admin_recovery_account_scope_directory/)
  assert.match(directory, /RECOVERY_SCOPE_TEAM_LIMIT/)
  assert.match(edge, /supported_edit_data_scopes:supportedEditDataScopes/)
  assert.match(edge, /recovery_scope_editor:recoveryScopeEditor/)
})

test('recovery assigned-scope save sends all filters only to the v2 atomic writer', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const updateStart = edge.indexOf("if (action === 'update_backend')")
  const nextAction = edge.indexOf("if (action === 'toggle_active' || action === 'toggle_otp')", updateStart)
  const update = edge.slice(updateStart, nextAction)

  assert.match(update, /team_ids', 'position_ids', 'employee_ids'/)
  assert.match(update, /hasScopeFilters/)
  assert.match(update, /can\('scope\.manage'\)/)
  assert.match(update, /admin_recovery_update_backend_account_v2/)
  assert.match(update, /p_team_ids:teamIds/)
  assert.match(update, /p_position_ids:positionIds/)
  assert.match(update, /p_employee_ids:employeeIds/)
  assert.match(update, /admin_recovery_update_backend_account'/)
})

test('database recovery editor validates the hard team boundary and stays service-only', async () => {
  const migration = await read('../../supabase/migrations/20260830163000_recovery_backend_assigned_scope_editor.sql')
  const directoryStart = migration.indexOf('create or replace function public.admin_recovery_account_scope_directory')
  const updateStart = migration.indexOf('create or replace function public.admin_recovery_update_backend_account_v2')
  const directory = migration.slice(directoryStart, updateStart)
  const update = migration.slice(updateStart)

  assert.match(directory, /scope_private\.current_employee_scope_directory\(\)/)
  assert.match(directory, /employee\.status = 'active'/)
  assert.match(directory, /permission\.code in \('\*', 'account\.edit'\)/)
  assert.match(directory, /permission\.code in \('\*', 'scope\.manage'\)/)
  assert.match(directory, /v_actor_scope is distinct from 'all'/)
  assert.match(directory, /limit 100/)
  assert.match(directory, /limit 200/)
  assert.match(directory, /revoke all on function public\.admin_recovery_account_scope_directory[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(directory, /grant execute on function public\.admin_recovery_account_scope_directory[\s\S]+to service_role/)

  assert.match(update, /scope_manage_required/)
  assert.match(update, /auth_user_id in \(p_actor_user_id, p_target_user_id\)[\s\S]+order by access\.auth_user_id[\s\S]+for update/)
  assert.match(update, /assigned_scope_requires_team/)
  assert.match(update, /team_filter_not_in_current_roster/)
  assert.match(update, /position_filter_not_in_selected_current_team/)
  assert.match(update, /employee_filter_not_in_selected_current_team/)
  assert.match(update, /public\.admin_save_account_access_scope\(/)
  assert.match(update, /delete from public\.app_session_leases[\s\S]+delete from auth\.sessions/)
  assert.match(update, /insert into public\.audit_logs[\s\S]+backend_account_scope_update/)
  assert.match(update, /revoke all on function public\.admin_recovery_update_backend_account_v2[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(update, /grant execute on function public\.admin_recovery_update_backend_account_v2[\s\S]+to service_role/)
})

test('recovery account modal loads and searches scope candidates on demand', async () => {
  const page = await read('../pages/AdminUsersPage.jsx')
  const selection = await read('./adminAccountScopeSelection.js')

  assert.match(page, /fetchRecoveryScopeDirectory/)
  assert.match(page, /includeSelection:true/)
  assert.match(page, /includeSelection:false/)
  assert.match(page, /scope_directory_loaded/)
  assert.match(page, /recovery_scope_editor/)
  assert.match(page, /form\.data_scope === 'assigned_teams' && canManageScope/)
  assert.match(page, /team_ids:form\.team_ids/)
  assert.match(page, /position_ids:form\.position_ids/)
  assert.match(page, /employee_ids:form\.employee_ids/)
  assert.match(page, /当前排班标准团队、岗位和员工候选/)
  assert.match(selection, /position\?\.team_ids/)
  assert.match(selection, /some\(teamId => selectedTeamIds\.has\(teamId\)\)/)
})
