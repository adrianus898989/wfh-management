import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  examGradeResultCompletesSession,
  isExamGradingSessionCompleteError,
} from './examGradingCompletion.js'

test('the additive grading result identifies the final answer transition', () => {
  assert.equal(examGradeResultCompletesSession({session_status:'graded'}),true)
  assert.equal(examGradeResultCompletesSession({session_status:' GRADED '}),true)
  assert.equal(examGradeResultCompletesSession({session_status:'grading'}),false)
  assert.equal(examGradeResultCompletesSession(null),false)
})

test('only the grading queue terminal error is treated as completed', () => {
  assert.equal(isExamGradingSessionCompleteError({message:'session_not_pending_grading'}),true)
  assert.equal(isExamGradingSessionCompleteError({details:'RPC failed: SESSION_NOT_PENDING_GRADING'}),true)
  assert.equal(isExamGradingSessionCompleteError({message:'permission_denied'}),false)
  assert.equal(isExamGradingSessionCompleteError(null),false)
})

test('corrective migration preserves the five-argument grading contract and adds session status', async () => {
  const migration=await readFile(new URL('../../supabase/migrations/20260905051127_restore_exam_session_detail_granular_permissions.sql',import.meta.url),'utf8')
  assert.match(migration,/alter function public\.admin_exam_grade_answer_with_feedback_images\([\s\S]+rename to admin_exam_grade_answer_with_feedback_images_page_v1/)
  assert.match(migration,/create function public\.admin_exam_grade_answer_with_feedback_images\([\s\S]+p_feedback_images jsonb[\s\S]+admin_exam_grade_answer_with_feedback_images_page_v1\([\s\S]+'session_status'/)
  assert.match(migration,/grant execute on function public\.admin_exam_grade_answer_with_feedback_images\([\s\S]+to authenticated, service_role/)
  assert.match(migration,/rename to admin_exam_grade_answer_integrity_page_v1/)
  const integrityStart=migration.indexOf('create function public.admin_exam_grade_answer_audit_inner_v1(')
  const integrityEnd=migration.indexOf('revoke all on function public.admin_exam_grade_answer_audit_inner_v1',integrityStart)
  const integrity=migration.slice(integrityStart,integrityEnd)
  assert.match(integrity,/v_session_status is null[\s\S]+not in \('submitted', 'grading', 'graded'\)/)
  assert.match(integrity,/p_status is null[\s\S]+p_status not in \('wrong', 'partial', 'correct'\)/)
  assert.match(integrity,/p_score is null[\s\S]+p_score < 0[\s\S]+p_score > v_points/)
  assert.match(integrity,/p_status = 'wrong' and p_score <> 0/)
  assert.match(integrity,/p_status = 'partial' and p_score <> v_points \/ 2/)
  assert.match(integrity,/p_status = 'correct' and p_score <> v_points/)
  assert.ok(integrity.indexOf('from public.exam_sessions session_row')<integrity.indexOf('from public.exam_answers answer\n  where answer.id = p_answer_id\n  for update'))
  assert.match(migration,/exam_feedback_storage_can_upload[\s\S]+session_row\.status in \('submitted', 'grading', 'graded'\)/)
})

test('grading UI closes a completed queue item and suppresses the expected stale-reader error', async () => {
  const source=await readFile(new URL('../pages/AdminTrainingPage.jsx',import.meta.url),'utf8')
  assert.match(source,/data:gradeResult,error:e/)
  assert.match(source,/permissionPage==='grading'&&examGradeResultCompletesSession\(gradeResult\)\)\{await finishCompletedSession\(\);return\}/)
  assert.doesNotMatch(source,/if\(examGradeResultCompletesSession\(gradeResult\)\)\{await finishCompletedSession/)
  assert.match(source,/isExamGradingSessionCompleteError\(loadError\)\)return 'completed'/)
  assert.match(source,/refreshResult==='completed'\)\{await finishCompletedSession\(\);return\}/)
})

test('the grading detail reader remains limited to actionable statuses', async () => {
  const granular=await readFile(new URL('../../supabase/migrations/20260827113000_granular_admin_page_permissions.sql',import.meta.url),'utf8')
  const start=granular.indexOf('create function public.admin_exam_grading_session_detail')
  const end=granular.indexOf('create function public.admin_exam_grading_legacy_detail',start)
  const definition=granular.slice(start,end)
  assert.match(definition,/not in \('submitted','grading'\)/)
  assert.doesNotMatch(definition,/'graded'/)
})
