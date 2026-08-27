import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { partitionCurrentTeamIds } from '../../supabase/functions/admin-accounts/scope.ts'

const migration = await readFile(
  new URL('../../supabase/migrations/20260827152000_backend_scope_position_intersection.sql', import.meta.url),
  'utf8',
)
const edge = await readFile(
  new URL('../../supabase/functions/admin-accounts/index.ts', import.meta.url),
  'utf8',
)
const usersPage = await readFile(new URL('../pages/AdminUsersPage.jsx', import.meta.url), 'utf8')

test('current team ID partition cleans, deduplicates and separates stale grants', () => {
  assert.deepEqual(
    partitionCurrentTeamIds(
      ['current-b', 'stale-a', 'current-b', '', null, ' current-a ', 'stale-a'],
      ['current-a', 'current-b'],
    ),
    {
      currentTeamIds: ['current-b', 'current-a'],
      staleTeamIds: ['stale-a'],
    },
  )
  assert.deepEqual(partitionCurrentTeamIds(null, ['current-a']), {
    currentTeamIds: [],
    staleTeamIds: [],
  })
})

test('database directory derives current team and canonical position from the latest roster', () => {
  assert.match(migration, /where directory\.source_kind = 'roster'/)
  assert.match(migration, /create or replace function scope_private\.current_employee_scope_directory\(\)/)
  assert.match(migration, /join canonical_team on canonical_team\.team_key = roster\.team_key/)
  assert.match(migration, /join canonical_position on canonical_position\.position_key = roster\.position_key/)
  assert.match(migration, /\(array_agg\(position\.id order by position\.id\)\)\[1\] position_id/)
  assert.match(migration, /'ambiguous_position_names'/)
  assert.match(migration, /delete from public\.user_scope_teams legacy/)
})

test('strict employee organization directory RPC is service-only', () => {
  assert.match(migration, /security definer[\s\S]+set search_path = ''/)
  assert.match(migration, /revoke all on function public\.admin_scope_current_employee_directory\(\)[\s\S]+from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.admin_scope_current_employee_directory\(\)[\s\S]+to service_role/)
})

test('admin account bootstrap and save use strict current assignments and one atomic RPC', () => {
  assert.match(edge, /admin\.rpc\('admin_scope_current_employee_directory'\)/)
  assert.match(edge, /if \(!currentAssignments\.length\) throw new Error\('当前排班组织目录为空或全部未匹配，已停止账号范围授权'\)/)
  assert.match(edge, /currentAssignments/)
  assert.match(edge, /scope_positions:/)
  assert.match(edge, /admin_save_account_access_scope/)
  assert.match(edge, /p_position_ids:/)
  assert.match(edge, /scopeDirectoryDiagnostics/)
})

test('delegated scopes are structurally contained, not only current-row subsets', () => {
  assert.match(edge, /async function scopeStructureWithinCaller/)
  assert.match(edge, /targetTeamIds\.every\(teamId => scope\.callerScopeTeamIds\.has\(teamId\)\)/)
  assert.match(edge, /targetPositionIds\.every\(positionId => scope\.callerScopePositionIds\.has\(positionId\)\)/)
  assert.match(edge, /targetEmployeeIds\.every\(employeeId => scope\.callerScopeEmployeeIds\.has\(employeeId\)\)/)
  assert.match(edge, /targetDataScope === 'own_team'[\s\S]+return false/)
  assert.match(edge, /activeCaller\.data_scope === 'assigned_teams'[\s\S]+scope\.callerScopeEmployeeIds\.has\(targetEmployeeId\)/)
  assert.match(edge, /activeCaller\.data_scope === 'self' \|\| activeCaller\.data_scope === 'own_team'\) return false/)
  assert.match(edge, /await scopeStructureWithinCaller/)
})

test('limited managers can still manage staff-only accounts inside employee scope', () => {
  assert.match(edge, /const isStaffPortalAccount = !targetAccess\.backend_enabled[\s\S]{0,140}targetAccess\.employee_portal_enabled/)
  assert.match(edge, /if \(!isStaffPortalAccount && !await targetEffectiveScopeWithinCaller/)
  assert.match(edge, /Staff-only accounts cannot read backend modules/)
})

test('account editor explains current organization cleanup and the intersection-plus-exception rule', () => {
  assert.match(usersPage, /const staleScopeTeams = data\?\.stale_scope_teams \|\| \[\]/)
  assert.match(usersPage, /removedStaleTeamIds/)
  assert.match(usersPage, /旧名、已移除或当前无排班成员的历史团队，已从本次选择中剔除；保存后不会恢复/)
  assert.match(usersPage, /团队清单只读取当前居家排班 \/ 当前组织目录/)
  assert.match(usersPage, /基础范围 = 已选团队 ∩ 可选岗位/)
  assert.match(usersPage, /指定员工（额外例外）/)
  assert.match(usersPage, /Number\(team\.member_count\) \|\| 0/)
})
