import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const payrollMigration = await readFile(
  new URL('../../supabase/migrations/20260828011000_payroll_safe_legacy_employee_id_fallback.sql', import.meta.url),
  'utf8',
)
const payrollBase = await readFile(
  new URL('../../supabase/migrations/20260826160000_payroll_historical_identity_and_publish_scope.sql', import.meta.url),
  'utf8',
)
const notesMigration = await readFile(
  new URL('../../supabase/migrations/20260828012000_employee_private_notes.sql', import.meta.url),
  'utf8',
)
const notesCompactMigration = await readFile(
  new URL('../../supabase/migrations/20260829170000_employee_private_note_compact_batch_history.sql', import.meta.url),
  'utf8',
)
const employeePage = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
const employeeStyles = await readFile(new URL('../styles-employee-v27.css', import.meta.url), 'utf8')
const permissions = await readFile(new URL('../config/permissions.js', import.meta.url), 'utf8')
const pagePermissions = await readFile(new URL('../config/adminPagePermissions.js', import.meta.url), 'utf8')

const functionBody = (sql, name) => {
  const start = sql.indexOf(`create or replace function ${name}`)
  assert.notEqual(start, -1, `${name} should exist`)
  const next = sql.indexOf('\ncreate or replace function ', start + 1)
  return sql.slice(start, next === -1 ? sql.length : next)
}

test('legacy payroll fallback is insert-only for new upload drafts', () => {
  const trigger = functionBody(payrollMigration, 'payroll_private.classify_payroll_identity')
  assert.match(trigger, /tg_op = 'INSERT'/i)
  assert.match(trigger, /batch\.source_type='upload'/i)
  assert.match(trigger, /batch\.status='draft'/i)
  assert.match(trigger, /batch\.voided_at is null/i)
  assert.doesNotMatch(payrollMigration, /update\s+public\.payroll_payslips/i)
  assert.doesNotMatch(payrollMigration, /batch\s*14|batch_id\s*=\s*14/i)
})

test('legacy payroll fallback requires globally unique name, exact hire date and no identity collision', () => {
  const resolver = functionBody(payrollMigration, 'payroll_private.resolve_legacy_employee_no_identity')
  assert.match(resolver, /count\(\*\) over\(\) as normalized_name_count/i)
  assert.match(resolver, /normalized_name_count = 1/i)
  assert.match(resolver, /p_hire_date is not null/i)
  assert.match(resolver, /candidate\.hire_date = p_hire_date/i)
  assert.match(resolver, /not exists[\s\S]+from public\.employees assigned/i)
  assert.match(resolver, /employee_lifecycle_events lifecycle[\s\S]+note is distinct from '__VOIDED__'/i)
  assert.match(resolver, /lifecycle\.employee_id is distinct from candidate\.id/i)
  assert.match(resolver, /employee_identity_aliases alias[\s\S]+alias\.employee_id is distinct from candidate\.id/i)
})

test('legacy payroll aliases are private, race-safe and auditable while raw IDs stay intact', () => {
  assert.match(payrollMigration, /create table if not exists payroll_private\.employee_identity_aliases/i)
  assert.match(payrollMigration, /alter table payroll_private\.employee_identity_aliases enable row level security/i)
  assert.match(payrollMigration, /revoke all on table payroll_private\.employee_identity_aliases[\s\S]+authenticated,service_role/i)
  assert.match(payrollMigration, /on conflict\(old_employee_no_key\) do update[\s\S]+returning employee_identity_aliases\.employee_id into v_alias_employee_id/i)
  assert.match(payrollMigration, /v_alias_employee_id = v_legacy\.employee_id/i)
  assert.match(payrollMigration, /legacy_old_id_unique_name_hire_date/i)
  assert.match(payrollMigration, /identity_alias_confirmed/i)
  assert.match(payrollMigration, /audit_legacy_payroll_identity_match\(\)[\s\S]+batch\.source_type='upload'[\s\S]+batch\.status='draft'/i)
  assert.match(payrollMigration, /legacy_old_id_matched/i)
  assert.match(payrollBase, /employee_no_raw[\s\S]+nullif\(trim\(v_row->>'employee_no'\),''\)/i)
})

test('private employee notes default to Founder-only dedicated permissions', () => {
  assert.match(notesMigration, /'employee\.private_note\.view'/)
  assert.match(notesMigration, /'employee\.private_note\.manage'/)
  assert.doesNotMatch(notesMigration, /insert into public\.role_permissions/i)
  assert.match(permissions, /EMPLOYEE_PRIVATE_NOTE_VIEW:\s*'employee\.private_note\.view'/)
  assert.match(permissions, /EMPLOYEE_PRIVATE_NOTE_MANAGE:\s*'employee\.private_note\.manage'/)
  assert.match(pagePermissions, /PERMISSIONS\.EMPLOYEE_PRIVATE_NOTE_VIEW/)
  assert.match(pagePermissions, /PERMISSIONS\.EMPLOYEE_PRIVATE_NOTE_MANAGE/)
})

test('private note tables are not directly exposed and retain append-only body revisions', () => {
  assert.match(notesMigration, /create schema if not exists employee_private/i)
  assert.match(notesMigration, /revoke all on schema employee_private from public,anon,authenticated,service_role/i)
  assert.match(notesMigration, /alter table employee_private\.employee_notes enable row level security/i)
  assert.match(notesMigration, /alter table employee_private\.employee_note_revisions enable row level security/i)
  assert.match(notesMigration, /revoke all on table employee_private\.employee_notes,[\s\S]+from public,anon,authenticated,service_role/i)
  assert.match(notesMigration, /constraint employee_private_note_revision_unique unique\(note_id,version\)/i)
  assert.doesNotMatch(notesMigration, /delete from employee_private\.employee_notes/i)
  assert.doesNotMatch(notesMigration, /function public\.[^(]*private_note_delete/i)
})

test('every private note RPC enforces admin session, dedicated permission and employee scope', () => {
  for (const name of [
    'public.admin_employee_private_notes',
    'public.admin_employee_private_note_create',
    'public.admin_employee_private_note_update',
    'public.admin_employee_private_note_archive',
  ]) {
    const body = functionBody(notesMigration, name)
    assert.match(body, /current_app_session_is_valid\('admin'\)/i)
    assert.match(body, /employee\.private_note\.(?:view|manage)/i)
    assert.match(body, /can_manage_employee/i)
  }
  const update = functionBody(notesMigration, 'public.admin_employee_private_note_update')
  const archive = functionBody(notesMigration, 'public.admin_employee_private_note_archive')
  for (const body of [update, archive]) {
    assert.match(body, /p_expected_version/i)
    assert.match(body, /for update/i)
    assert.match(body, /private_note_version_conflict/i)
  }
  assert.match(notesMigration, /grant execute on function public\.admin_employee_private_notes[\s\S]+to authenticated/i)
})

test('public note audit stores only non-reversible metadata, never a body or body hash', () => {
  const metadata = functionBody(notesMigration, 'employee_private.note_audit_metadata')
  assert.match(metadata, /'content_length',char_length\(coalesce\(p_note_text,''\)\)/i)
  assert.doesNotMatch(metadata, /(?:md5|digest|content_hash)/i)
  const auditedFunctions = {
    create_private_note: 'public.admin_employee_private_note_create',
    update_private_note: 'public.admin_employee_private_note_update',
    archive_private_note: 'public.admin_employee_private_note_archive',
  }
  for (const [action, functionName] of Object.entries(auditedFunctions)) {
    assert.ok(notesMigration.includes(`'${action}'`), `missing audit action ${action}`)
    const actionAt = notesMigration.indexOf(`'${action}'`)
    const insertAt = notesMigration.lastIndexOf('insert into public.audit_logs', actionAt)
    const insertEnd = notesMigration.indexOf(');', actionAt) + 2
    const auditBlock = notesMigration.slice(insertAt, insertEnd)
    assert.doesNotMatch(auditBlock, /'note_text'/i, `${action} must not write a note_text field to public audit`)
    assert.match(auditBlock, /(?:v_metadata|note_audit_metadata)/i)
    assert.match(functionBody(notesMigration, functionName), /note_audit_metadata/i)
  }
  assert.match(notesMigration, /审计不保存正文/g)
})

test('employee drawer embeds a compact note summary in basic information without a separate tab', () => {
  assert.match(employeePage, /canViewPrivateNotes=adminAccess\.hasAnyPermission\(\[PERMISSIONS\.EMPLOYEE_PRIVATE_NOTE_VIEW,PERMISSIONS\.EMPLOYEE_PRIVATE_NOTE_MANAGE\]\)/)
  assert.doesNotMatch(employeePage, /\['private_notes','内部备注',canViewPrivateNotes\]/)
  assert.doesNotMatch(employeePage, /activeSection==='private_notes'/)
  assert.match(employeePage, /<InfoPanel title="基本资料"[\s\S]+<EmployeePrivateNoteSummary employeeId=\{e\.id\} canManage=\{canManagePrivateNotes\}/)
  assert.match(employeePage, /employee-private-note-summary-copy/)
  assert.match(employeeStyles, /-webkit-line-clamp:2/)
  assert.match(employeePage, /管理备注':'查看备注/)
  assert.match(employeePage, /admin_employee_private_notes/)
  assert.match(employeePage, /admin_employee_private_note_create/)
  assert.match(employeePage, /admin_employee_private_note_update/)
  assert.match(employeePage, /admin_employee_private_note_archive/)
  assert.match(employeePage, /const requestRef=useRef\(0\)/)
  assert.match(employeePage, /const mountedRef=useRef\(true\)/)
  assert.match(employeePage, /requestRef\.current!==requestId\|\|employeeRef\.current!==targetEmployeeId/)
  assert.match(employeePage, /setState\(\{loading:Boolean\(employeeId\),error:'',rows:\[\],total:0\}\)/)
  assert.match(employeePage, /<EmployeePrivateNotesPanel employeeId=\{employeeId\} canManage=\{canManage\}/)
})

test('private note history stays private, scoped and append-only', () => {
  const history = functionBody(notesCompactMigration, 'public.admin_employee_private_note_history')
  assert.match(notesCompactMigration, /employee_private_note_revisions_employee_history_idx/i)
  assert.match(history, /current_app_session_is_valid\('admin'\)/i)
  assert.match(history, /employee\.private_note\.(?:view|manage)/i)
  assert.match(history, /can_manage_employee\(p_employee_id\)/i)
  assert.match(history, /employee_private\.employee_note_revisions/i)
  assert.match(notesCompactMigration, /revoke all on function public\.admin_employee_private_note_history[\s\S]+from public,anon,authenticated/i)
  assert.match(notesCompactMigration, /grant execute on function public\.admin_employee_private_note_history[\s\S]+to authenticated/i)
  assert.doesNotMatch(notesCompactMigration, /delete from employee_private\./i)
  assert.match(employeePage, /查看完整修改历史/)
  assert.match(employeePage, /admin_employee_private_note_history/)
  assert.match(employeePage, /changed_by_username/)
  assert.match(employeePage, /function EmployeePrivateNoteHistory\(\{employeeId,refreshToken=0\}\)/)
  assert.match(employeePage, /\[employeeId,page,refreshToken,retryToken\]/)
  assert.match(employeePage, /setHistoryRevision\(value=>value\+1\)/)
  assert.match(employeePage, /<EmployeePrivateNoteHistory employeeId=\{employeeId\} refreshToken=\{historyRevision\}\/>/)
})

test('batch notes are scope checked, replay safe, append-only and expose partial failures', () => {
  const batch = functionBody(notesCompactMigration, 'public.admin_employee_private_note_batch_create')
  assert.match(notesCompactMigration, /employee_private_notes_batch_request_employee_uidx/i)
  assert.match(batch, /current_app_session_is_valid\('admin'\)/i)
  assert.match(batch, /has_permission\('employee\.private_note\.manage'\)/i)
  assert.match(batch, /can_manage_employee\(v_employee\)/i)
  assert.match(batch, /cardinality\(p_employee_ids\)[\s\S]+between 1 and 50/i)
  assert.match(batch, /batch_request_key=p_request_key/i)
  assert.match(batch, /idempotent_replay/i)
  assert.match(batch, /request_key_payload_conflict/i)
  assert.match(batch, /v_failures:=v_failures\|\|jsonb_build_array/i)
  assert.match(batch, /insert into employee_private\.employee_notes/i)
  assert.match(batch, /insert into employee_private\.employee_note_revisions/i)
  assert.match(batch, /insert into public\.audit_logs/i)
  assert.doesNotMatch(batch, /update employee_private\.employee_notes/i)
  assert.doesNotMatch(batch, /delete from/i)
  assert.match(employeePage, /admin_employee_private_note_batch_create/)
  assert.match(employeePage, /失败清单/)
  assert.match(employeePage, /可使用相同防重编号重试，不会重复新增已成功的备注/)
  assert.match(employeePage, /不会替换或覆盖任何旧备注/)
})

test('batch note selection and write controls are hidden without manage permission', () => {
  assert.match(employeePage, /canManagePrivateNotes=adminAccess\.hasPermission\(PERMISSIONS\.EMPLOYEE_PRIVATE_NOTE_MANAGE\)/)
  assert.match(employeePage, /canManagePrivateNotes&&selectedPrivateNoteCount>0/)
  assert.match(employeePage, /canManagePrivateNotes&&<th className="employee-note-select-cell"/)
  assert.match(employeePage, /canManagePrivateNotes&&<td className="employee-note-select-cell"/)
  assert.match(employeePage, /selectedPrivateNoteCount>=50/)
})

test('only the employee detail mask loses backdrop blur', () => {
  assert.match(employeeStyles, /\.detail-mask\{[^}]*background:rgba\(16,29,48,\.18\)!important;[^}]*backdrop-filter:none!important;[^}]*-webkit-backdrop-filter:none!important;/)
  assert.doesNotMatch(employeeStyles, /\.modal-mask\{[^}]*backdrop-filter:none/i)
})
