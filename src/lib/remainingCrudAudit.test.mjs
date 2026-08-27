import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(
  new URL('../../supabase/migrations/20260827144000_remaining_crud_audit_wrappers.sql', import.meta.url),
  'utf8',
)

const wrapperBody = signature => {
  const start = migration.indexOf(`create function public.${signature}`)
  assert.notEqual(start, -1, `missing wrapper ${signature}`)
  const end = migration.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `missing wrapper terminator ${signature}`)
  return migration.slice(start, end)
}

test('remaining CRUD audit migration verifies deployed delegates, guards, and result shape', () => {
  for (const marker of [
    'admin_exam_save_question_audit_prerequisite_changed',
    'admin_exam_create_assignment_audit_prerequisite_changed',
    'admin_exam_create_assignment_result_prerequisite_changed',
    'admin_exam_save_assignment_audit_prerequisite_changed',
    'admin_connectivity_create_audit_prerequisite_changed',
    'admin_connectivity_create_result_prerequisite_changed',
    'admin_exam_save_question_page_v1',
    'exam_team_in_scope',
    'admin_exam_create_assignment_page_v1',
    'admin_exam_save_assignment_page_v1',
    'exam_assignment_target_in_scope',
    'employee_ops_private.admin_connectivity_create',
    'public.can_manage_employee',
    'employee_connectivity_incidents',
  ]) assert.ok(migration.includes(marker), `missing prerequisite marker ${marker}`)
})

test('retained implementations are private and wrappers require the current admin session', () => {
  for (const name of [
    'admin_exam_save_question',
    'admin_exam_create_assignment',
    'admin_exam_save_assignment',
    'admin_connectivity_create',
  ]) {
    assert.match(migration, new RegExp(`alter function public\\.${name}\\(jsonb\\)[\\s\\S]+rename to ${name}_audit_inner_v1`))
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}_audit_inner_v1\\(jsonb\\)[\\s\\S]{0,120}from public,anon,authenticated,service_role`))
    assert.match(wrapperBody(name), /current_app_session_is_valid\('admin'\)/)
    assert.match(wrapperBody(name), new RegExp(`public\\.${name}_audit_inner_v1\\(`))
  }
})

test('question save, both assignment paths, and connectivity create write transactional audit rows', () => {
  assert.equal((migration.match(/insert into public\.audit_logs\(/g) || []).length, 4)
  const question = wrapperBody('admin_exam_save_question')
  const legacyAssignment = wrapperBody('admin_exam_create_assignment')
  const assignment = wrapperBody('admin_exam_save_assignment')
  assert.match(question, /'exam'/)
  assert.match(question, /'create_question'/)
  assert.match(question, /'update_question'/)
  assert.match(assignment, /'exam'/)
  assert.match(assignment, /'create_assignment'/)
  assert.match(assignment, /'update_assignment'/)
  assert.match(legacyAssignment, /'exam','create_assignment'/)
  assert.match(wrapperBody('admin_connectivity_create'), /'connectivity','create_incident'/)
  for (const name of [
    'admin_exam_save_question',
    'admin_exam_create_assignment',
    'admin_exam_save_assignment',
    'admin_connectivity_create',
  ]) assert.match(wrapperBody(name), /audit_result_invalid/)
})

test('audit payloads project metadata without question content or connectivity evidence', () => {
  const question = wrapperBody('admin_exam_save_question')
  const legacyAssignment = wrapperBody('admin_exam_create_assignment')
  const assignment = wrapperBody('admin_exam_save_assignment')
  const connectivity = wrapperBody('admin_connectivity_create')

  for (const marker of ['external_key', 'team_name', 'position_name', 'revision', 'sync_status']) {
    assert.ok(question.includes(`'${marker}'`), `missing question metadata ${marker}`)
  }
  assert.doesNotMatch(question, /question_en|question_zh|question_vi|image_urls/)

  for (const marker of ['title', 'employee_id', 'pass_score', 'max_attempts', 'status']) {
    assert.ok(assignment.includes(`'${marker}'`), `missing assignment metadata ${marker}`)
    assert.ok(legacyAssignment.includes(`'${marker}'`), `missing legacy assignment metadata ${marker}`)
  }
  assert.doesNotMatch(assignment, /question_rules/)
  assert.doesNotMatch(legacyAssignment, /question_rules/)

  for (const marker of ['employee_no', 'incident_date', 'incident_type', 'duration_minutes']) {
    assert.ok(connectivity.includes(`'${marker}'`), `missing connectivity metadata ${marker}`)
  }
  assert.doesNotMatch(connectivity, /attachments|details|evidence_url/)
})

test('public wrappers retain authenticated and service-role grants', () => {
  for (const name of [
    'admin_exam_save_question',
    'admin_exam_create_assignment',
    'admin_exam_save_assignment',
    'admin_connectivity_create',
  ]) {
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\(jsonb\\)[\\s\\S]{0,80}to authenticated,service_role`))
  }
})
