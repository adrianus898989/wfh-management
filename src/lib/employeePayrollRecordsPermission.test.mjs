import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(relative,import.meta.url),'utf8')

const migrationUrl='../../supabase/migrations/20260828173000_employee_payroll_records_explicit_permission.sql'

test('payroll records use a new explicit permission with no legacy grant inheritance', async () => {
  const [permissions,pagePermissions,roleCatalog,migration]=await Promise.all([
    read('../config/permissions.js'),
    read('../config/adminPagePermissions.js'),
    read('../config/rolePermissionCatalog.js'),
    read(migrationUrl),
  ])

  assert.match(permissions,/EMPLOYEE_DIRECTORY_PAYROLL_RECORDS_VIEW:\s*'employee\.directory\.payroll_records\.view'/)
  assert.match(pagePermissions,/employee_directory:[^\n]+EMPLOYEE_DIRECTORY_PAYROLL_RECORDS_VIEW/)
  assert.doesNotMatch(pagePermissions,/employee_directory:[^\n]+EMPLOYEE_DIRECTORY_PAYROLL_HISTORY_VIEW/)

  assert.match(roleCatalog,/LEGACY_IMPLEMENTATION_CODES[\s\S]+employee\.directory\.payroll_history\.view/)

  assert.match(migration,/employee\.directory\.payroll_records\.view'[\s\S]+true\s*\)/)
  assert.doesNotMatch(migration,/insert\s+into\s+public\.(?:role_permissions|user_permission_overrides)/i)
  assert.doesNotMatch(migration,/has_permission\('employee\.directory\.payroll_history\.view'\)/)
  assert.doesNotMatch(migration,/has_permission\('payroll\.view'\)/)
})

test('employee drawer hides salary records and clears cached rows when permission is absent', async () => {
  const source=await read('../pages/AdminEmployeesPage.jsx')
  const start=source.indexOf('export function EmployeeDrawer')
  const end=source.indexOf('function EmployeeTrainerReviewPanel',start)
  const drawer=source.slice(start,end)

  assert.match(drawer,/canViewPayrollRecords=adminAccess\.hasPermission\(PERMISSIONS\.EMPLOYEE_DIRECTORY_PAYROLL_RECORDS_VIEW\)/)
  assert.match(drawer,/\['payroll','工资记录',canViewPayrollRecords\]/)
  assert.doesNotMatch(drawer,/EMPLOYEE_DIRECTORY_PAYROLL_HISTORY_VIEW/)
  assert.match(drawer,/if\(!canViewPayrollRecords\)\{\s*setPayrollData\(null\);setPayrollError\(''\);setPayrollLoading\(false\)/)
  assert.match(drawer,/if\(!e\.id\|\|activeSection!==['"]payroll['"]\)return[\s\S]+supabase\.rpc\('admin_employee_payroll_history'/)
  assert.match(drawer,/activeSection==='payroll'&&canViewPayrollRecords&&<EmployeePayrollHistoryPanel/)
})

test('payroll RPC fails closed on permission and scope and returns a minimal published projection', async () => {
  const migration=await read(migrationUrl)
  const functionStart=migration.indexOf('create or replace function public.admin_employee_payroll_history')
  const functionEnd=migration.indexOf('revoke all on function public.admin_employee_payroll_history',functionStart)
  const body=migration.slice(functionStart,functionEnd)

  const authGate=body.indexOf("auth.uid()) is null")
  const directoryGate=body.indexOf("has_permission('employee.directory.view')")
  const salaryGate=body.indexOf("has_permission('employee.directory.payroll_records.view')")
  const scopeGate=body.indexOf('can_manage_employee(p_employee_id)')
  const firstPayrollRead=body.indexOf('from public.payroll_payslips')
  assert.ok(authGate>=0&&directoryGate>authGate&&salaryGate>directoryGate&&scopeGate>salaryGate&&firstPayrollRead>scopeGate)

  assert.match(body,/batch\.status='published'/)
  assert.match(body,/batch\.voided_at is null/)
  assert.match(body,/limit 120/)
  for(const forbiddenField of ['raw_payload','line_items','card_number','payment_name','payment_method','employee_no_raw']){
    assert.ok(!body.includes(forbiddenField),`RPC must not return unused sensitive field ${forbiddenField}`)
  }
  assert.doesNotMatch(body,/admin_employee_payroll_history_page_v1|payroll_private\.admin_employee_payroll_history/)
  assert.match(migration,/revoke all on function public\.admin_employee_payroll_history_page_v1\(uuid\)[\s\S]+service_role/)
  assert.match(migration,/revoke all on function payroll_private\.admin_employee_payroll_history\(uuid\)[\s\S]+service_role/)
})

test('browser roles cannot bypass salary APIs through direct table reads', async () => {
  const migration=await read(migrationUrl)
  for(const table of [
    'payroll_batches',
    'payroll_payslips',
    'employee_compensation_settings',
    'employee_compensation_legacy',
  ]){
    assert.match(migration,new RegExp(`alter table public\\.${table} enable row level security`))
    assert.match(migration,new RegExp(`revoke all on table[\\s\\S]+public\\.${table}[\\s\\S]+from public,anon,authenticated`))
  }
  assert.doesNotMatch(migration,/grant\s+select[\s\S]+to\s+(?:public|anon|authenticated)/i)
})

test('founder remains authorized through the central permission helper', async () => {
  const sessionMigration=await read('../../supabase/migrations/20260824190000_current_session_policy_enforcement.sql')
  const start=sessionMigration.indexOf('create or replace function public.has_permission')
  const end=sessionMigration.indexOf('create or replace function public.daily_work_is_active_backend',start)
  const helper=sessionMigration.slice(start,end)
  assert.match(helper,/if public\.is_founder\(\) then\s*return true;/)
})
