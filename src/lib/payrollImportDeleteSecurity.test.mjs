import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8')
const [
  page,
  permissions,
  pagePermissions,
  migration,
  coexistenceMigration,
  staffMigration,
  employeePayrollMigration,
] = await Promise.all([
  read('../pages/AdminPayrollPage.jsx'),
  read('../config/permissions.js'),
  read('../config/adminPagePermissions.js'),
  read('../../supabase/migrations/20260830093000_payroll_import_record_safe_delete.sql'),
  read('../../supabase/migrations/20260830153000_payroll_published_stream_isolation.sql'),
  read('../../supabase/migrations/20260826160000_payroll_historical_identity_and_publish_scope.sql'),
  read('../../supabase/migrations/20260828173000_employee_payroll_records_explicit_permission.sql'),
])

const functionBody = (source, signature, nextMarker) => {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `missing ${signature}`)
  const end = nextMarker ? source.indexOf(nextMarker, start + signature.length) : source.length
  assert.ok(end > start, `missing boundary after ${signature}`)
  return source.slice(start, end)
}

const deleteRpc = functionBody(
  migration,
  'create or replace function public.admin_payroll_delete_record(',
  '-- Retain legacy RPC names',
)
const softDelete = functionBody(
  migration,
  'create or replace function payroll_private.admin_payroll_soft_delete_record(',
  'revoke all on function payroll_private.admin_payroll_soft_delete_record',
)
const restoreRpc = functionBody(
  migration,
  'create or replace function public.admin_payroll_restore_batch(',
  'revoke all on function public.admin_payroll_pending_page',
)
const coexistenceRestoreRpc = functionBody(
  coexistenceMigration,
  'create or replace function public.admin_payroll_restore_batch(',
  'revoke all on function payroll_private.payroll_population_key',
)

test('payroll import deletion is a separate sensitive permission with no implicit role grant', () => {
  assert.match(permissions, /PAYROLL_IMPORT_HISTORY_DELETE:\s*'payroll\.import_history\.delete'/)
  assert.match(pagePermissions, /payroll_history:[\s\S]+PAYROLL_IMPORT_HISTORY_DELETE/)
  assert.match(migration, /values\('payroll\.import_history\.delete','删除工资导入记录','payroll',true\)/)
  assert.doesNotMatch(migration, /insert into public\.role_permissions[\s\S]+payroll\.import_history\.delete/i)
})

test('database delete and restore require Founder or explicit delete permission plus full scope', () => {
  for (const rpc of [deleteRpc, restoreRpc]) {
    assert.match(rpc, /auth\.uid\(\) is null|v_user is null/)
    assert.match(rpc, /current_app_session_is_valid\('admin'\)/)
    assert.match(rpc, /public\.is_founder\(\)[\s\S]+public\.has_permission\('payroll\.import_history\.delete'\)/)
    assert.match(rpc, /admin_payroll_has_full_scope\(\)[\s\S]+payroll_all_scope_required/)
    assert.doesNotMatch(rpc, /payroll\.import_history\.edit/)
  }
  assert.match(migration, /revoke all on function public\.admin_payroll_pending_page\(bigint\)[\s\S]+public\.admin_payroll_delete_record\(bigint,text,text\)[\s\S]+from public,anon,authenticated/)
  assert.match(migration, /grant execute on function public\.admin_payroll_pending_page\(bigint\)[\s\S]+public\.admin_payroll_delete_record\(bigint,text,text\)[\s\S]+to authenticated,service_role/)
})

test('business deletion supports every lifecycle state without deleting payroll rows', () => {
  assert.match(softDelete, /v_batch\.status not in \('draft','published','archived'\)/)
  assert.match(softDelete, /when v_batch\.status = 'published' then 'DELETE PUBLISHED #' \|\| p_batch_id::text/)
  assert.match(softDelete, /set status = 'archived'[\s\S]+voided_at = v_now[\s\S]+voided_prior_status = v_batch\.status/)
  assert.match(softDelete, /'delete_import_record'[\s\S]+'actor_name',v_actor_name[\s\S]+'acted_at',v_now[\s\S]+'reason',btrim\(p_reason\)/)
  assert.match(softDelete, /'recoverable',true[\s\S]+'physical_delete',false[\s\S]+'published_withdrawal',v_batch\.status = 'published'/)
  assert.doesNotMatch(softDelete, /delete\s+from\s+public\.payroll_(?:batches|payslips|audit_log)/i)
})

test('published deletion leaves staff readers and restore preserves same-month document coexistence', () => {
  assert.match(softDelete, /set status = 'archived'/)
  assert.match(staffMigration, /join public\.payroll_batches batch on batch\.id = payslip\.batch_id and batch\.status = 'published'/)
  assert.match(employeePayrollMigration, /batch\.status='published'[\s\S]+batch\.voided_at is null/)
  assert.match(coexistenceRestoreRpc, /v_batch\.voided_prior_status in \('draft','published','archived'\)/)
  assert.doesNotMatch(coexistenceRestoreRpc, /published_restore_conflict|conflict_batch/)
  assert.match(coexistenceRestoreRpc, /'published_coexistence',true/)
  assert.match(coexistenceRestoreRpc, /'restore_deleted_import_record'[\s\S]+'deleted_by_name',v_batch\.voided_by_name[\s\S]+'deleted_at',v_batch\.voided_at/)
})

test('normal history is active-only while deleted records have an explicit recoverable filter', () => {
  assert.match(migration, /\(\(batch\.voided_at is not null\) = p_deleted_only\)/)
  assert.match(migration, /admin_payroll_granular_page_filtered\([\s\S]+p_status,p_batch_id,p_include_rows,false/)
  assert.match(migration, /'batches',coalesce\(v_active->'batches','\[\]'::jsonb\)[\s\S]+'deleted_batches',coalesce\(v_deleted->'batches','\[\]'::jsonb\)/)
  assert.match(migration, /limit 200/)
  assert.match(migration, /payroll_batches_active_history_idx[\s\S]+where voided_at is null/)
  assert.match(migration, /payroll_batches_deleted_history_idx[\s\S]+where voided_at is not null/)
})

test('frontend hides delete and restore actions unless the explicit permission is present', () => {
  assert.match(page, /canDelete=\{Boolean\(canMutateWholePayroll&&state\.data\?\.permissions\?\.delete&&access\.hasPermission\(PERMISSIONS\.PAYROLL_IMPORT_HISTORY_DELETE\)\)\}/)
  assert.match(page, /if\(batch\?\.voided_at\)return canDelete\?'恢复记录':''/)
  assert.match(page, /canDelete&&!selected\.voided_at[\s\S]+删除记录（可恢复）/)
  assert.match(page, /canDelete&&selected\.voided_at[\s\S]+恢复记录/)
  assert.match(page, /DELETE PUBLISHED #\$\{batchId\}/)
  assert.match(page, /admin_payroll_delete_record/)
  assert.match(page, /deletedBatches=\{state\.data\?\.deleted_batches\|\|\[\]\}/)
  assert.match(page, /value="voided">已删除（可恢复）/)
})

test('migration is bounded against production lock and statement waits', () => {
  assert.match(migration, /^begin;[\s\S]+set local lock_timeout = '5s';[\s\S]+set local statement_timeout = '60s';/)
})
