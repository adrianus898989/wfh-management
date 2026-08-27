import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { partitionCurrentTeamIds } from '../../supabase/functions/admin-accounts/scope.ts'

const migration = await readFile(
  new URL('../../supabase/migrations/20260827111432_admin_account_current_team_scope.sql', import.meta.url),
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

test('database directory derives selectable teams from the current roster and fails closed', () => {
  assert.match(migration, /from public\.teams team[\s\S]+where team\.status = 'active'/)
  assert.match(migration, /where directory\.source_kind = 'roster'/)
  assert.match(migration, /current_teams as materialized[\s\S]+from matched_roster roster[\s\S]+group by roster\.team_id/)
  assert.match(migration, /join current_teams team on team\.id = employee\.team_id/)
  assert.match(migration, /where presence\.last_home_present/)
  assert.match(migration, /report_employee_directory_cache_matches\(v_snapshot\)/)
  assert.match(migration, /jsonb_array_length\(coalesce\(v_directory->'unmatched_team_names'/)
  assert.match(migration, /delete from public\.user_scope_teams scope_row[\s\S]+jsonb_array_elements\(v_directory->'teams'\)/)
})

test('current-team directory RPC is service-only', () => {
  assert.match(migration, /security definer[\s\S]+set search_path = ''/)
  assert.match(migration, /revoke all on function public\.admin_scope_current_team_directory\(\)[\s\S]+from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.admin_scope_current_team_directory\(\)[\s\S]+to service_role/)
})

test('admin account bootstrap and save use the current-team directory on the server', () => {
  assert.match(edge, /admin\.rpc\('admin_scope_current_team_directory'\)/)
  assert.match(edge, /if \(!currentTeams\.length\) throw new Error\('当前排班团队目录为空，已停止账号范围授权'\)/)
  assert.match(edge, /currentTeamIdByEmployeeId\.get\(employee\.id\)/)
  assert.match(edge, /scope\.currentTeams\.filter/)
  assert.match(edge, /scope_teams: currentScopeTeams/)
  assert.match(edge, /stale_scope_teams: staleScopeTeams/)
  assert.match(edge, /选择的团队已不在当前排班目录，请刷新后重新选择/)
})

test('failed updates never restore a historical team grant', () => {
  assert.match(edge, /const previousRestorableScope = \{[\s\S]+teamIds: previousCurrentTeamIds/)
  assert.match(edge, /await restoreScope\(target, previousRestorableScope\)/)
  assert.doesNotMatch(edge, /await restoreScope\(target, previousScope!\)/)
})

test('account editor explains automatic stale-team cleanup and only renders current teams', () => {
  assert.match(usersPage, /const staleScopeTeams = data\?\.stale_scope_teams \|\| \[\]/)
  assert.match(usersPage, /removedStaleTeamIds/)
  assert.match(usersPage, /旧名、已移除或当前无排班成员的历史团队，已从本次选择中剔除；保存后不会恢复/)
  assert.match(usersPage, /团队清单只读取当前居家排班 \/ 当前组织目录/)
  assert.match(usersPage, /Number\(team\.member_count\) \|\| 0/)
})
