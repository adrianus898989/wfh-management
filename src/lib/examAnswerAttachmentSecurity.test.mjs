import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(
  new URL('../../supabase/migrations/20260903160414_exam_answer_image_attachments.sql', import.meta.url),
  'utf8',
)
const privateGuardsMigration = await readFile(
  new URL('../../supabase/migrations/20260903160836_exam_answer_storage_private_guards.sql', import.meta.url),
  'utf8',
)
const cleanupVisibilityMigration = await readFile(
  new URL('../../supabase/migrations/20260903161231_exam_answer_storage_cleanup_visibility.sql', import.meta.url),
  'utf8',
)
const quotaMigration = await readFile(
  new URL('../../supabase/migrations/20260903161848_exam_answer_storage_upload_quota.sql', import.meta.url),
  'utf8',
)
const sessionQuotaLockMigration = await readFile(
  new URL('../../supabase/migrations/20260903162124_exam_answer_storage_session_quota_lock.sql', import.meta.url),
  'utf8',
)
const canonicalizationMigration = await readFile(
  new URL('../../supabase/migrations/20260903161952_exam_answer_attachment_canonicalization.sql', import.meta.url),
  'utf8',
)
const atomicSubmitMigration = await readFile(
  new URL('../../supabase/migrations/20260903162636_exam_answer_atomic_final_submit.sql', import.meta.url),
  'utf8',
)
const legacySubmitGuardMigration = await readFile(
  new URL('../../supabase/migrations/20260903163335_exam_legacy_submit_guard.sql', import.meta.url),
  'utf8',
)

const functionBody = name => {
  const start = migration.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `missing ${name}`)
  const next = migration.indexOf('\ncreate or replace function ', start + 1)
  const policy = migration.indexOf('\ndrop policy ', start + 1)
  const end = [next, policy].filter(index => index > start).sort((a, b) => a - b)[0] ?? migration.length
  return migration.slice(start, end)
}

test('exam answer images use a bounded private bucket and authenticated-only policies', () => {
  assert.match(migration, /'exam-answer-images',[\s\S]*false,[\s\S]*4194304/i)
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) assert.ok(migration.includes(`'${type}'`))
  for (const operation of ['insert', 'select', 'delete']) {
    assert.match(migration, new RegExp(`create policy exam_answer_images_[a-z]+[\\s\\S]+for ${operation} to authenticated`, 'i'))
  }
  assert.doesNotMatch(migration, /create policy exam_answer_images_[a-z]+\s+on storage\.objects for update/i)
  assert.doesNotMatch(migration, /grant execute[\s\S]{0,180}to anon/i)
})

test('upload and delete guards bind user, live session, question and immutable namespace', () => {
  const upload = functionBody('exam_answer_storage_can_upload')
  const remove = functionBody('exam_answer_storage_can_delete')
  for (const body of [upload, remove]) {
    assert.match(body, /current_app_session_is_valid\('staff'\)/)
    assert.match(body, /cardinality\(v_parts\)<>4/)
    assert.match(body, /v_parts\[1\]<>v_user_id::text/)
    assert.match(body, /status='in_progress'/)
    assert.match(body, /expires_at>now\(\)/)
    assert.match(body, /exam_staff_context\(\)/)
    assert.match(body, /jsonb_array_elements\(v_session\.question_snapshot\)/)
  }
  assert.match(upload, /random|\[0-9a-f\]\{8\}/i)
  assert.match(remove, /not exists\([\s\S]+answer\.attachments @>/i)
})

test('read guard requires an exact database reference and scoped page permission', () => {
  const view = functionBody('exam_answer_storage_can_view')
  assert.match(view, /answer\.attachments @> jsonb_build_array\(jsonb_build_object\('path'/)
  assert.match(view, /current_app_session_is_valid\('staff'\)/)
  assert.match(view, /session_row\.auth_user_id=\(select auth\.uid\(\)\)/)
  assert.match(view, /current_app_session_is_valid\('admin'\)/)
  assert.match(view, /exam_employee_in_scope\(session_row\.employee_id\)/)
  for (const permission of ['exam.records.view', 'exam.grading.view', 'employee.directory.view']) {
    assert.ok(view.includes(`public.has_permission('${permission}')`), `missing ${permission}`)
  }
  assert.match(view, /exam\.grading\.view'[\s\S]+session_row\.status in \('submitted','grading'\)/)
})

test('database validation accepts only real owned image objects with safe metadata', () => {
  const validator = functionBody('validate_exam_answer_attachments')
  assert.match(migration, /exam_answers_attachments_gin[\s\S]+jsonb_path_ops/)
  assert.match(validator, /jsonb_array_length\(new\.attachments\)>6/)
  assert.match(validator, /v_item \- array\['path','name','size','type'\]/)
  assert.match(validator, /count\(\*\)<>count\(distinct item->>'path'\)/)
  assert.match(validator, /from storage\.objects object_row/)
  assert.match(validator, /object_row\.bucket_id='exam-answer-images'/)
  assert.match(validator, /v_object\.owner_id[\s\S]+v_session\.auth_user_id::text/)
  assert.match(validator, /v_object\.object_size[\s\S]+v_size/)
  assert.match(validator, /v_object\.object_type[\s\S]+v_type/)
  assert.match(migration, /before insert or update of session_id,question_id,attachments on public\.exam_answers/)
})

test('staff APIs preserve attachments but never persist signed URLs', () => {
  const save = functionBody('staff_exam_save_answer')
  const drafts = functionBody('staff_exam_answer_attachments')
  const result = functionBody('staff_exam_result_detail')
  assert.match(save, /jsonb_build_object\([\s\S]+'path'[\s\S]+'name'[\s\S]+'size'[\s\S]+'type'/)
  assert.doesNotMatch(save, /'url'/)
  assert.match(save, /attachments=excluded\.attachments/)
  assert.match(drafts, /jsonb_object_agg\(answer\.question_id::text,answer\.attachments\)/)
  assert.match(result, /'attachments',coalesce\(ans\.attachments,'\[\]'::jsonb\)/)
  assert.match(migration, /grant execute on function public\.staff_exam_answer_attachments\(uuid\)[\s\S]+to authenticated/)
})

test('storage policy guards finish outside the API-exposed public schema', () => {
  for (const signature of [
    'exam_answer_storage_can_upload(text)',
    'exam_answer_storage_can_view(text)',
    'exam_answer_storage_can_delete(text, text)',
  ]) {
    assert.ok(
      privateGuardsMigration.includes(`alter function public.${signature}`),
      `missing private move for ${signature}`,
    )
  }
  for (const guard of [
    'exam_answer_storage_can_upload(name)',
    'exam_answer_storage_can_view(name)',
    'exam_answer_storage_can_delete(name, owner_id)',
  ]) {
    assert.ok(
      privateGuardsMigration.includes(`session_private.${guard}`),
      `policy does not use private guard ${guard}`,
    )
  }
  assert.doesNotMatch(privateGuardsMigration, /grant usage on schema session_private/i)
  assert.doesNotMatch(privateGuardsMigration, /grant execute[\s\S]{0,180}to anon/i)
})

test('detached staff images remain selectable only through the same narrow delete guard', () => {
  assert.match(cleanupVisibilityMigration, /create policy exam_answer_images_read[\s\S]+for select[\s\S]+to authenticated/i)
  assert.match(cleanupVisibilityMigration, /session_private\.exam_answer_storage_can_view\(name\)/)
  assert.match(cleanupVisibilityMigration, /or session_private\.exam_answer_storage_can_delete\(name, owner_id\)/)
  assert.doesNotMatch(cleanupVisibilityMigration, /to anon|to public/i)
})

test('direct Storage uploads are serialized and bounded outside the UI', () => {
  assert.match(quotaMigration, /pg_catalog\.pg_advisory_xact_lock/)
  assert.match(quotaMigration, /object_row\.bucket_id='exam-answer-images'/)
  assert.match(quotaMigration, /v_question_object_count<8 and v_session_object_count<112/)
  assert.match(quotaMigration, /status='in_progress'/)
  assert.match(quotaMigration, /expires_at>now\(\)/)
  assert.match(quotaMigration, /expires_at>now\(\)-interval '24 hours'/)
  assert.match(quotaMigration, /not exists\([\s\S]+answer\.attachments @>/)
  assert.match(sessionQuotaLockMigration, /pg_catalog\.format\('%s\/%s',v_user_id,v_session_id\)/)
  assert.doesNotMatch(sessionQuotaLockMigration, /pg_catalog\.format\('%s\/%s\/%s',v_user_id,v_session_id,v_question_id\)/)
})

test('the trigger stores canonical metadata rather than padded validated input', () => {
  assert.match(canonicalizationMigration, /into new\.attachments/)
  assert.match(canonicalizationMigration, /'path',btrim\(attachment\.item->>'path'\)/)
  assert.match(canonicalizationMigration, /'name',btrim\(attachment\.item->>'name'\)/)
  assert.match(canonicalizationMigration, /'type',lower\(btrim\(attachment\.item->>'type'\)\)/)
  assert.match(canonicalizationMigration, /length\(attachment\.item->>'name'\)>512/)
  assert.match(canonicalizationMigration, /count\(\*\)<>count\(distinct item->>'path'\)/)
})

test('final answer save and submission are atomic across the expiry boundary', () => {
  assert.match(atomicSubmitMigration, /create or replace function public\.staff_exam_submit_with_answer/)
  assert.match(atomicSubmitMigration, /current_app_session_is_valid\('staff'\)/)
  assert.match(atomicSubmitMigration, /session_row\.employee_id=v_context\.employee_id/)
  assert.match(atomicSubmitMigration, /expires_at>now\(\)-interval '30 seconds'/)
  assert.match(atomicSubmitMigration, /when p_attachments is null then public\.exam_answers\.attachments/)
  assert.match(atomicSubmitMigration, /insert into public\.exam_answers[\s\S]+update public\.exam_sessions[\s\S]+status='submitted'/)
  assert.match(atomicSubmitMigration, /grant execute on function public\.staff_exam_submit_with_answer\(uuid,uuid,text,jsonb\)[\s\S]+to authenticated/)
  assert.doesNotMatch(atomicSubmitMigration, /grant execute[\s\S]{0,180}to anon/)
})

test('the legacy submit endpoint cannot bypass the current staff lease or expiry grace', () => {
  assert.match(legacySubmitGuardMigration, /create or replace function public\.staff_exam_submit\(p_session_id uuid\)/)
  assert.match(legacySubmitGuardMigration, /current_app_session_is_valid\('staff'\)/)
  assert.match(legacySubmitGuardMigration, /session_row\.auth_user_id=\(select auth\.uid\(\)\)/)
  assert.match(legacySubmitGuardMigration, /session_row\.employee_id=v_context\.employee_id/)
  assert.match(legacySubmitGuardMigration, /session_row\.status='in_progress'/)
  assert.match(legacySubmitGuardMigration, /session_row\.expires_at>now\(\)-interval '30 seconds'/)
  assert.match(legacySubmitGuardMigration, /grant execute on function public\.staff_exam_submit\(uuid\)[\s\S]+to authenticated/)
  assert.doesNotMatch(legacySubmitGuardMigration, /grant execute[\s\S]{0,180}to anon/)
})
