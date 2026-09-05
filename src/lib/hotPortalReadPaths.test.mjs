import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL(
  '../../supabase/migrations/20260905191500_optimize_hot_portal_read_paths.sql',
  import.meta.url,
), 'utf8')

test('hot portal migration is bounded, transactional, and does not mask runtime latency', () => {
  assert.match(migration, /^begin;/)
  assert.match(migration, /set local lock_timeout = '500ms'/)
  assert.match(migration, /set local statement_timeout = '15s'/)
  assert.match(migration, /commit;\s*$/)
  assert.doesNotMatch(migration, /alter function[\s\S]+set statement_timeout/i)
  assert.doesNotMatch(migration, /cron\.(?:schedule|unschedule|alter_job)/)
  assert.doesNotMatch(migration, /pg_stat_statements_reset|terminate_backend|cancel_backend/)
  assert.doesNotMatch(migration, /ibvntgtydsavdiyqekrq|CS000673/i)
})

test('staff attendance uses the maintained identity cache and its reverse partial index', () => {
  assert.match(migration, /historical_employee_aliases_cache_employee_no_idx/)
  assert.match(migration, /\(employee_no_key, name_key\)/)
  assert.match(migration, /where identity_count = 1[\s\S]+employee_no_key is not null/)
  assert.match(migration, /v_enabled_cache_triggers <> 3/)
  assert.match(migration, /from attendance_private\.historical_employee_aliases_cache identity_alias/)
  assert.match(migration, /staff_attendance_alias_cache_patch_failed/)
  assert.match(migration, /staff_attendance_cache_installation_mismatch/)
})

test('recent staff errors are employee-bounded without changing latest-revision semantics', () => {
  assert.match(migration, /attendance_private\.staff_recent_error_rows\(\s*p_employee_no text/)
  assert.match(migration, /target_keys as materialized/)
  assert.match(migration, /error_row\.employee_no = params\.employee_no/)
  assert.match(migration, /cross join lateral/)
  assert.match(migration, /error_row\.record_key = target\.record_key/)
  assert.match(migration, /order by error_row\.synced_at desc, error_row\.source_row desc/)
  assert.match(migration, /where latest\.employee_no = params\.employee_no/)
  assert.match(migration, /from attendance_private\.staff_recent_error_rows\(c\.employee_no\)/)
  assert.match(migration, /from public\.report_employee_errors_v/)
})

test('target-key/lateral strategy equals global latest view filtered by employee', () => {
  const rows = [
    { recordKey: 'same', employeeNo: 'E1', syncedAt: 10, sourceRow: 1 },
    { recordKey: 'same', employeeNo: 'E1', syncedAt: 20, sourceRow: 2 },
    // A later reassignment must suppress the older E1 revision.
    { recordKey: 'moved', employeeNo: 'E1', syncedAt: 10, sourceRow: 3 },
    { recordKey: 'moved', employeeNo: 'E2', syncedAt: 30, sourceRow: 4 },
    { recordKey: 'other', employeeNo: 'E2', syncedAt: 40, sourceRow: 5 },
  ]
  const target = 'E1'
  const newest = values => [...values].sort((a, b) =>
    b.syncedAt - a.syncedAt || b.sourceRow - a.sourceRow
  )[0]

  const baseline = [...new Set(rows.map(row => row.recordKey))]
    .map(key => newest(rows.filter(row => row.recordKey === key)))
    .filter(row => row.employeeNo === target)

  const targetKeys = [...new Set(
    rows.filter(row => row.employeeNo === target).map(row => row.recordKey),
  )]
  const bounded = targetKeys
    .map(key => newest(rows.filter(row => row.recordKey === key)))
    .filter(row => row.employeeNo === target)

  assert.deepEqual(bounded, baseline)
  assert.deepEqual(bounded.map(row => row.recordKey), ['same'])
})

test('trainer identity comparisons and cache lookups have expression indexes', () => {
  assert.match(migration, /report_employee_directory_cache_employee_no_trim_idx/)
  assert.match(migration, /employee_error_summary_employee_no_trim_idx/)
  assert.match(migration, /user_access_online_training_email_identity_idx/)
  assert.match(migration, /public\.online_training_identity_key\(login_email\)/)
  assert.match(migration, /public\.online_training_identity_key\(candidate\.employee_no\)/)
  assert.match(migration, /public\.online_training_identity_key\(candidate\.full_name\)/)
  assert.match(migration, /public\.online_training_identity_key\([\s\S]+trainer_access\.login_username/)
  assert.match(migration, /public\.online_training_identity_key\([\s\S]+trainer_access\.login_email/)
  assert.match(migration, /pg_catalog\.strpos\(v_patched, 'lower\(regexp_replace\('/)
})

test('private helper and attendance implementation retain least-privilege ACLs', () => {
  assert.match(
    migration,
    /revoke all on function attendance_private\.staff_recent_error_rows\(text\)[\s\S]+from public, anon, authenticated, service_role/,
  )
  assert.match(
    migration,
    /revoke all on function attendance_private\.staff_attendance_home\(text\)[\s\S]+from public, anon, authenticated;[\s\S]+grant execute on function attendance_private\.staff_attendance_home\(text\)[\s\S]+to service_role/,
  )
  assert.match(
    migration,
    /has_function_privilege\([\s\S]+?'authenticated',[\s\S]+?'attendance_private\.staff_attendance_home\(text\)'[\s\S]+?'execute'[\s\S]+?\)/,
  )
  assert.match(
    migration,
    /not pg_catalog\.has_function_privilege\([\s\S]+?'service_role',[\s\S]+?'attendance_private\.staff_attendance_home\(text\)'[\s\S]+?'execute'[\s\S]+?\)/,
  )
})

test('admin dashboard and scope functions are intentionally not rewritten here', () => {
  assert.doesNotMatch(migration, /pg_get_functiondef\(\s*'public\.admin_home_dashboard/)
  assert.doesNotMatch(migration, /pg_get_functiondef\(\s*'public\.admin_scope_current_employee_directory/)
  assert.doesNotMatch(migration, /create or replace function public\.admin_(?:home_dashboard|scope_current_employee_directory)/)
})
