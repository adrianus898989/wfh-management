import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(
  new URL('../../supabase/migrations/20260827142000_exam_high_risk_audit_wrappers.sql', import.meta.url),
  'utf8',
)

const wrapperBody = signature => {
  const start = migration.indexOf(`create function public.${signature}`)
  assert.notEqual(start, -1, `missing wrapper ${signature}`)
  const end = migration.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `missing wrapper terminator ${signature}`)
  return migration.slice(start, end)
}

test('exam audit migration refuses to wrap changed permission or scope guards', () => {
  for (const marker of [
    'admin_exam_delete_question_audit_prerequisite_changed',
    'admin_exam_delete_assignment_audit_prerequisite_changed',
    'admin_exam_grade_answer_audit_prerequisite_changed',
    'exam.question_bank.delete',
    'exam_team_in_scope',
    'exam_assignment_target_in_scope',
    'exam.grading.grade',
    'exam_employee_in_scope',
  ]) assert.ok(migration.includes(marker), `missing prerequisite marker ${marker}`)
})

test('retained mutation implementations are private and wrappers keep current-session checks', () => {
  for (const name of [
    'admin_exam_delete_question',
    'admin_exam_delete_assignment',
    'admin_exam_grade_answer',
  ]) {
    assert.match(migration, new RegExp(`alter function public\\.${name}\\([^)]*\\)[\\s\\S]+rename to ${name}_audit_inner_v1`))
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}_audit_inner_v1\\([^)]*\\)[\\s\\S]{0,120}from public,anon,authenticated,service_role`))
    assert.match(wrapperBody(name), /current_app_session_is_valid\('admin'\)/)
    assert.match(wrapperBody(name), new RegExp(`public\\.${name}_audit_inner_v1\\(`))
  }
})

test('question deletion, assignment deletion and grading write transactional audit records', () => {
  assert.equal((migration.match(/insert into public\.audit_logs\(/g) || []).length, 3)
  assert.match(wrapperBody('admin_exam_delete_question'), /'exam_question_bank','delete_question'/)
  assert.match(wrapperBody('admin_exam_delete_assignment'), /'exam_question_bank','delete_assignment'/)
  assert.match(wrapperBody('admin_exam_grade_answer'), /'exam_grading','grade_answer'/)
  assert.match(wrapperBody('admin_exam_grade_answer'), /from public\.exam_sessions exam_session/)
})

test('grading audit projects only review metadata, never answer content or attachments', () => {
  const grade = wrapperBody('admin_exam_grade_answer')
  assert.match(grade, /'grade_status'/)
  assert.match(grade, /'awarded_score'/)
  assert.match(grade, /'grader_feedback'/)
  assert.doesNotMatch(grade, /answer_text|attachments/)
})
