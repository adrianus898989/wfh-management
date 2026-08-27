import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const usersPage = await readFile(new URL('../pages/AdminUsersPage.jsx', import.meta.url), 'utf8')

test('assigned account scope keeps compact checkboxes separate from form text inputs', () => {
  assert.match(usersPage, /input\.scope-check\[type="checkbox"\]\{width:16px!important;height:16px!important;/)
  assert.match(usersPage, /className="scope-check" type="checkbox"/)
  assert.match(usersPage, /checked=\{scopeTeamIdSet\.has\(team\.id\)\}/)
  assert.match(usersPage, /checked=\{scopePositionIdSet\.has\(position\.id\)\}/)
  assert.match(usersPage, /checked=\{scopeEmployeeIdSet\.has\(employee\.id\)\}/)
})

test('assigned teams, narrowing positions and employee exceptions expose complete controls', () => {
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
  assert.match(usersPage, /“指定员工”是额外例外/)
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
  assert.match(usersPage, /岗位只能收窄已选团队，请先选择至少一个团队/)
})

test('account search leaves room for adjacent actions instead of consuming the toolbar', () => {
  assert.match(usersPage, /\.access-searchbar\{display:grid;grid-template-columns:minmax\(240px,420px\) auto auto auto;/)
  assert.match(usersPage, /\.access-searchbar\{[^}]+justify-content:start/)
})
