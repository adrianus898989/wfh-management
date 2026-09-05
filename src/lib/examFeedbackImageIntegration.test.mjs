import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [training, employees, staff, portal, styles, migration] = await Promise.all([
  readFile(new URL('../pages/AdminTrainingPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../pages/StaffExamPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../pages/PortalPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../styles-exams.css', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20260905043121_exam_grader_feedback_images.sql', import.meta.url), 'utf8'),
])

const between = (source, start, end) => {
  const from=source.indexOf(start)
  assert.notEqual(from,-1,`missing ${start}`)
  const to=source.indexOf(end,from+start.length)
  assert.notEqual(to,-1,`missing ${end}`)
  return source.slice(from,to)
}

test('admin grading uploads bounded private reply images only when a score is saved', () => {
  const modal=training.slice(training.indexOf('function GradeModal('))
  assert.ok(modal.startsWith('function GradeModal('))
  assert.match(modal,/MAX_EXAM_FEEDBACK_ATTACHMENTS/)
  assert.match(modal,/hydrateExamFeedbackAnswers\(supabase,answers,300\)/)
  assert.match(modal,/authUserId.*session\.id.*a\.answer_id.*crypto\.randomUUID\(\)/s)
  assert.match(modal,/from\(EXAM_FEEDBACK_BUCKET\)\.upload\([^\n]+upsert:false/)
  assert.match(modal,/admin_exam_grade_answer_with_feedback_images/)
  assert.match(modal,/p_feedback_images:feedbackImages/)
  assert.match(modal,/if\(!saved&&uploaded\.length\)await removeFeedbackObjects/)
  assert.match(modal,/removeFeedbackObjects\(removedPaths\)/)
  assert.match(modal,/disabled=\{Boolean\(busy\)\}/)
  assert.ok(modal.indexOf('<GradeFeedbackAttachmentEditor') < modal.indexOf('className="grade-actions"'))
})

test('reply image previews are compact and do not add grading or record table columns', () => {
  assert.match(styles,/\.exam-feedback-attachment-panel\{[^}]*margin:[^}]*padding:/)
  assert.match(styles,/\.exam-feedback-media-grid\{margin-top:0!important\}/)
  assert.match(styles,/@media\(max-width:620px\)[\s\S]+\.exam-feedback-attachment-head/)
  assert.doesNotMatch(styles,/\.exam-feedback-media-grid[^\n]*grid-template-columns:repeat/)
  assert.match(training,/最多 \{MAX_EXAM_FEEDBACK_ATTACHMENTS\} 张，每张不超过 4 MB/)
})

test('all authorized result surfaces sign and display reviewer images without exposing private paths', () => {
  for (const [name, source] of [['grading',training],['employee archive',employees],['staff exams',staff],['staff portal',portal]]) {
    assert.match(source,/hydrateExamFeedbackAnswers\(supabase,\s*(?:result\.)?answers(?:,\s*300)?\)/,`${name} does not hydrate feedback images`)
    assert.match(source,/grader_feedback_attachments/,`${name} does not render feedback attachment metadata`)
  }
  assert.match(staff,/function FeedbackAttachmentMedia/)
  assert.match(portal,/function StaffPortalExamAttachments/)
  assert.match(portal,/hydrateExamAnswersAttachments\(supabase,answers,300\)/)
  assert.doesNotMatch(staff,/src=\{[^}]*\.path/)
  assert.doesNotMatch(portal,/src=\{[^}]*\.path/)
})

test('database keeps reviewer images separate, private, scoped and backward compatible', () => {
  assert.match(migration,/add column if not exists grader_feedback_attachments jsonb/i)
  assert.match(migration,/'exam-feedback-images'[\s\S]+false[\s\S]+4194304/i)
  assert.match(migration,/jsonb_array_length\([^)]*grader_feedback_attachments[^)]*\)\s*<=\s*3/i)
  assert.match(migration,/create or replace function session_private\.exam_feedback_storage_can_upload/i)
  assert.match(migration,/create or replace function session_private\.exam_feedback_storage_can_view/i)
  assert.match(migration,/create or replace function session_private\.exam_feedback_storage_can_delete/i)
  assert.match(migration,/session_private\.current_app_session_is_valid\('admin'\)/i)
  assert.match(migration,/public\.has_permission\('exam\.grading\.grade'\)/i)
  assert.match(migration,/session_private\.exam_employee_in_scope/i)
  assert.match(migration,/v_answer_object_count\s*<\s*6/i)
  assert.match(migration,/grader_feedback_attachments\s*@>/i)
  for (const operation of ['insert','select','delete']) assert.match(migration,new RegExp(`for\\s+${operation}\\s+to\\s+authenticated`,'i'))
  assert.doesNotMatch(migration,/for\s+update\s+to\s+authenticated/i)
  assert.match(migration,/create or replace function public\.admin_exam_grade_answer_with_feedback_images/i)
  assert.match(migration,/perform public\.admin_exam_grade_answer_audit_inner_v1\(/i)
  assert.match(migration,/grant execute on function public\.admin_exam_grade_answer_with_feedback_images\([\s\S]{0,100}jsonb[\s\S]{0,40}to authenticated/i)
  assert.doesNotMatch(migration,/grant execute[\s\S]{0,160}to anon/i)
})

test('current admin and staff detail projections return reviewer images', () => {
  for (const fn of ['admin_exam_session_detail','admin_exam_project_session_detail','staff_exam_result_detail']) {
    assert.ok(migration.includes(fn),`missing ${fn}`)
  }
  assert.ok((migration.match(/'grader_feedback_attachments'/g) || []).length >= 3)
  assert.match(migration,/grader_feedback_attachments[\s\S]{0,100}'\[\]'::jsonb/i)
})
