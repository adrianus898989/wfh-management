import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [granular, feedback, recovery] = await Promise.all([
  readFile(new URL('../../supabase/migrations/20260827113000_granular_admin_page_permissions.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20260905043121_exam_grader_feedback_images.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20260905051127_restore_exam_session_detail_granular_permissions.sql', import.meta.url), 'utf8'),
])

test('original granular bridge authorized all three current detail surfaces', () => {
  const start=granular.indexOf("select pg_get_functiondef('public.admin_exam_session_detail(uuid)'::regprocedure)")
  const end=granular.indexOf("select pg_get_functiondef('public.admin_legacy_exam_session_detail(uuid)'::regprocedure)",start)
  assert.notEqual(start,-1)
  assert.notEqual(end,-1)
  const bridge=granular.slice(start,end)
  for(const permission of ['exam.records.view','employee.directory.view','exam.grading.view']) {
    assert.ok(bridge.includes(permission),`missing ${permission} from original bridge`)
  }
})

test('feedback projection contains images and scope but regressed to legacy permission codes', () => {
  const start=feedback.indexOf('create or replace function public.admin_exam_session_detail(p_session_id uuid)')
  const end=feedback.indexOf('create or replace function public.admin_exam_project_session_detail',start)
  assert.notEqual(start,-1)
  assert.notEqual(end,-1)
  const definition=feedback.slice(start,end)
  assert.match(definition,/grader_feedback_attachments/)
  assert.match(definition,/session_private\.exam_employee_in_scope\(v_employee_id\)/)
  assert.match(definition,/public\.exam_is_admin\('exam\.view'\)/)
  assert.match(definition,/public\.exam_is_admin\('exam\.grade'\)/)
})

test('corrective migration restores granular permissions without replacing projection or scope', () => {
  assert.match(recovery,/to_regprocedure\('public\.admin_exam_session_detail\(uuid\)'\)/)
  assert.match(recovery,/pg_get_functiondef\([\s\S]+admin_exam_session_detail\(uuid\)/)
  assert.match(recovery,/grader_feedback_attachments/)
  assert.match(recovery,/session_private\.exam_employee_in_scope\(v_employee_id\)/)
  assert.match(recovery,/public\.exam_is_admin\(''exam\.view''\)[\s\S]+public\.has_permission\(''exam\.records\.view''\)[\s\S]+public\.has_permission\(''employee\.directory\.view''\)/)
  assert.match(recovery,/public\.exam_is_admin\(''exam\.grade''\)[\s\S]+public\.has_permission\(''exam\.grading\.view''\)/)
  assert.match(recovery,/revoke all on function public\.admin_exam_session_detail\(uuid\)[\s\S]+from public, anon, authenticated, service_role/)
  assert.doesNotMatch(recovery,/grant execute on function public\.admin_exam_session_detail\(uuid\)/)
  assert.doesNotMatch(recovery,/create or replace function public\.admin_exam_session_detail/)
})

test('grading-only image reads stop after the actionable grading queue', () => {
  assert.match(recovery,/exam_feedback_storage_view_permission_recovery/)
  for(const guard of [
    "session_private.current_app_session_is_valid(''admin'')",
    'session_private.exam_employee_in_scope(session_row.employee_id)',
    "public.has_permission(''exam.records.view'')",
    "public.has_permission(''employee.directory.view'')",
    "public.has_permission(''exam.grading.view'')",
  ]) assert.ok(recovery.includes(guard),`missing storage read prerequisite ${guard}`)
  assert.match(recovery,/v_old_status_guard constant text :=[\s\S]+submitted'', ''grading'', ''graded/)
  assert.match(recovery,/execute replace\([\s\S]+v_old_status_guard,[\s\S]+session_row\.status in \(''submitted'', ''grading''\)/)
  assert.match(recovery,/revoke all on function session_private\.exam_feedback_storage_can_view\(text\)[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(recovery,/grant execute on function session_private\.exam_feedback_storage_can_view\(text\)[\s\S]+to authenticated/)
})
