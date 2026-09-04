import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('employee directory uses the current online training teacher instead of the team leader', async () => {
  const page = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
  const edge = await readFile(new URL('../../supabase/functions/admin-employees/index.ts', import.meta.url), 'utf8')
  const writeEdge = await readFile(new URL('../../supabase/functions/admin-employee-write/index.ts', import.meta.url), 'utf8')
  const migration = await readFile(new URL('../../supabase/migrations/20260827152000_backend_scope_position_intersection.sql', import.meta.url), 'utf8')

  assert.match(page, /<th\b[^>]*>老师<\/th>/)
  assert.match(page, /r\.online_trainer\|\|r\.trainer_name\|\|'-'/)
  assert.match(page, /filters\.teacher/)
  assert.match(page, /meta\.options\?\.trainers/)
  assert.match(edge, /leader_name,trainer_name,online_trainer/)
  assert.match(edge, /admin_scope_current_employee_directory/)
  assert.match(edge, /function overlayCurrentOrganization/)
  assert.match(edge, /onlineTrainer:text\(row\.online_trainer\)/)
  assert.match(edge, /const onlineTrainer=organization\.onlineTrainer\|\|null/)
  assert.match(edge, /online_trainer:onlineTrainer[\s\S]*trainer_name:onlineTrainer/)
  assert.match(edge, /rows\.map\(\(r:any\)=>overlayCurrentOrganization\(r,scope\)\)\.forEach/)
  assert.match(edge, /const rows=\(rawRows\|\|\[\]\)\.map\(\(row:any\)=>overlayCurrentOrganization\(row,scope\)\)/)
  assert.match(edge, /const employee=overlayCurrentOrganization\(rawEmployee,scope\)/)
  assert.match(edge, /trainers:sorted\(sets\.online_trainer\)/)
  assert.match(edge, /currentRosterEmployeeIdsForOrganizationFilters/)
  assert.match(edge, /text\(f\.teacher \|\| f\.leader\)/)
  assert.match(edge, /const constrainedEmployeeIds=organizationEmployeeIds[\s\S]+readEmployeeRowsInBatches\([\s\S]+\.in\("id",batch\)/)
  assert.doesNotMatch(edge, /online_trainer\.ilike/)
  assert.doesNotMatch(edge, /trainer_name\.ilike/)
  assert.doesNotMatch(edge, /if \(teamIds\.length\) q = q\.in\("team_id",teamIds\)/)

  assert.match(migration, /nullif\(btrim\(directory\.online_trainer\), ''\) online_trainer/)
  assert.match(migration, /'online_trainer', scope_row\.online_trainer/)

  assert.match(writeEdge, /function limitedWritablePositionOptions/)
  assert.match(writeEdge, /caller\.roleCode==="founder"\|\|caller\.access\.data_scope==="all"\) return null/)
  assert.match(writeEdge, /user_scope_team_filters/)
  assert.match(writeEdge, /user_scope_position_filters/)
  assert.match(writeEdge, /selectedTeams\.has\(text\(row\?\.team_id\)\)/)
  assert.match(writeEdge, /selectedPositions\.size===0\|\|selectedPositions\.has\(text\(row\?\.position_id\)\)/)
  assert.match(writeEdge, /const scopedRows=await limitedWritablePositionOptions\(service,caller\)/)
  assert.match(writeEdge, /scope_filtered:true/)
  assert.match(writeEdge, /scope_filtered:true[\s\S]*sendSheet\(\{action:"get_master_position_options"\}\)/)
})
