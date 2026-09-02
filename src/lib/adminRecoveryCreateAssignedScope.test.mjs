import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8')

test('recovery create exposes the same bounded scope selector and sends its complete boundary', async () => {
  const edge = await read('../../supabase/functions/admin-accounts/recovery.ts')
  const page = await read('../pages/AdminUsersPage.jsx')
  const migration = await read('../../supabase/migrations/20260831113000_recovery_backend_create_assigned_scope.sql')

  const directoryStart = edge.indexOf("if (action === 'scope_directory')")
  const accountListStart = edge.indexOf("if (action === 'account_list')", directoryStart)
  const directory = edge.slice(directoryStart, accountListStart)
  assert.match(directory, /create_mode/)
  assert.match(directory, /can\('account\.create'\)/)
  assert.match(directory, /admin_recovery_new_backend_scope_directory/)
  assert.match(directory, /RECOVERY_CREATE_SCOPE_DIRECTORY/)

  const createStart = edge.indexOf("if (action === 'create_backend')")
  const dashboardStart = edge.indexOf("if (action === 'dashboard')", createStart)
  const create = edge.slice(createStart, dashboardStart)
  assert.match(create, /supportedDataScopes\.add\('assigned_teams'\)/)
  assert.match(create, /assigned_scope_requires_team/)
  assert.match(create, /admin_recovery_finalize_backend_account_v2/)
  assert.match(create, /p_team_ids:teamIds[\s\S]+p_position_ids:positionIds[\s\S]+p_employee_ids:employeeIds/)

  assert.match(page, /createMode = accountModal\?\.mode === 'create'/)
  assert.match(page, /createMode,/)
  assert.match(page, /recoveryAccountMode && canManageScope && form\.data_scope === 'assigned_teams'/)
  assert.match(page, /fetchRecoveryScopeDirectory\(\{[\s\S]+includeSelection:false[\s\S]+createMode/)
  assert.match(page, /team_ids:form\.team_ids[\s\S]+position_ids:form\.position_ids[\s\S]+employee_ids:form\.employee_ids/)

  assert.match(migration, /create or replace function public\.admin_recovery_new_backend_scope_directory/)
  assert.match(migration, /permission\.code in \('\*', 'account\.create'\)/)
  assert.match(migration, /permission\.code in \('\*', 'scope\.manage'\)/)
  assert.match(migration, /scope_private\.current_employee_scope_directory\(\)/)
  assert.match(migration, /create_assigned_scope/)
  assert.match(migration, /FUNCTION public\.admin_recovery_finalize_backend_account\(p_auth_user_id uuid, p_employee_id uuid, p_role_id uuid, p_login_username text, p_login_email text, p_otp_required boolean, p_data_scope text, p_actor_user_id uuid\)/)
  assert.match(migration, /FUNCTION public\.admin_recovery_finalize_backend_account_v2\(p_auth_user_id uuid, p_employee_id uuid, p_role_id uuid, p_login_username text, p_login_email text, p_otp_required boolean, p_data_scope text, p_actor_user_id uuid, p_team_ids uuid\[\], p_position_ids uuid\[\], p_employee_ids uuid\[\]\)/)
  assert.match(migration, /assigned_scope_requires_team/)
  assert.match(migration, /position_filter_not_in_selected_current_team/)
  assert.match(migration, /employee_filter_not_in_selected_current_team/)
  assert.match(migration, /admin_recovery_finalize_backend_account_v2/)
  assert.match(migration, /revoke all on function public\.admin_recovery_finalize_backend_account_v2[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.admin_recovery_finalize_backend_account_v2[\s\S]+to service_role/)
})
