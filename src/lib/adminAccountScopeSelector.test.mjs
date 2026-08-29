import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { assignedScopeCandidates, pruneAssignedScopeSelection } from './adminAccountScopeSelection.js'

const usersPage = await readFile(new URL('../pages/AdminUsersPage.jsx', import.meta.url), 'utf8')

test('assigned account scope keeps compact checkboxes separate from form text inputs', () => {
  assert.match(usersPage, /input\.scope-check\[type="checkbox"\]\{width:16px!important;height:16px!important;/)
  assert.match(usersPage, /className="scope-check" type="checkbox"/)
  assert.match(usersPage, /checked=\{scopeTeamIdSet\.has\(team\.id\)\}/)
  assert.match(usersPage, /checked=\{scopePositionIdSet\.has\(position\.id\)\}/)
  assert.match(usersPage, /checked=\{scopeEmployeeIdSet\.has\(employee\.id\)\}/)
})

test('assigned teams, narrowing positions and in-team employee supplements expose complete controls', () => {
  assert.match(usersPage, /aria-label="已选团队"/)
  assert.match(usersPage, /aria-label="已选岗位"/)
  assert.match(usersPage, /aria-label="已选员工"/)
  assert.match(usersPage, /scope_team_selected_only[\s\S]+只看已选/)
  assert.match(usersPage, /scope_position_selected_only[\s\S]+只看已选/)
  assert.match(usersPage, /scope_employee_selected_only[\s\S]+只看已选/)
  assert.match(usersPage, /clearScopeIds\('team_ids'\)/)
  assert.match(usersPage, /clearScopeIds\('position_ids'\)/)
  assert.match(usersPage, /clearScopeIds\('employee_ids'\)/)
  assert.match(usersPage, /基础范围 = 已选团队 ∩ 可选岗位/)
  assert.match(usersPage, /已选团队是硬边界/)
  assert.match(usersPage, /指定员工只能从已选团队内补充/)
})

test('scope selection continues saving database IDs and shows current-roster headcount from bootstrap teams', () => {
  assert.match(usersPage, /team_ids:\s*form\.team_ids/)
  assert.match(usersPage, /position_ids:\s*form\.position_ids/)
  assert.match(usersPage, /employee_ids:\s*form\.employee_ids/)
  assert.match(usersPage, /new Map\(teams\.map\(team => \[team\.id, Number\(team\.member_count\) \|\| 0\]\)\)/)
  assert.match(usersPage, /当前排班 \{teamActiveCounts\.get\(team\.id\) \|\| 0\} 人/)
  assert.match(usersPage, /updateScopeIds\('team_ids', team\.id, event\.target\.checked\)/)
  assert.match(usersPage, /updateScopeIds\('position_ids', position\.id, event\.target\.checked\)/)
  assert.match(usersPage, /updateScopeIds\('employee_ids', employee\.id, event\.target\.checked\)/)
  assert.match(usersPage, /团队是不可越过的数据边界/)
})

test('scope candidates cascade from current roster teams to positions and employees', () => {
  const employees = [
    { id: 'a', current_team_id: 'panda', current_position_id: 'payout' },
    { id: 'b', current_team_id: 'panda', current_position_id: 'service' },
    { id: 'c', current_team_id: 'india', current_position_id: 'payout' },
  ]
  const positions = [{ id: 'payout' }, { id: 'service' }, { id: 'finance' }]
  const candidates = assignedScopeCandidates(employees, positions, ['panda'])
  assert.deepEqual(candidates.employees.map(employee => employee.id), ['a', 'b'])
  assert.deepEqual(candidates.positions.map(position => position.id), ['payout', 'service'])
})

test('scope pruning removes positions and employee supplements outside selected current teams', () => {
  const employees = [
    { id: 'a', current_team_id: 'panda', current_position_id: 'payout' },
    { id: 'b', current_team_id: 'india', current_position_id: 'service' },
  ]
  const result = pruneAssignedScopeSelection({
    teamIds: ['panda'],
    positionIds: ['payout', 'service'],
    employeeIds: ['a', 'b'],
  }, employees, [{ id: 'panda' }, { id: 'india' }])
  assert.deepEqual(result, { teamIds: ['panda'], positionIds: ['payout'], employeeIds: ['a'] })
})

test('account search keeps three explicit fields alongside adjacent actions', () => {
  assert.match(usersPage, /\.access-searchbar\{display:grid;grid-template-columns:repeat\(3,minmax\(160px,1fr\)\) auto auto auto;/)
  assert.match(usersPage, /\.access-searchbar\{[^}]+justify-content:start/)
  assert.match(usersPage, /输入后台用户名[\s\S]+输入员工ID或姓名[\s\S]+输入角色、管理范围或创建人/)
})
