import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read=relative=>readFile(new URL(relative,import.meta.url),'utf8')
const migrationPath='../../supabase/migrations/20260830121924_employee_profile_server_history_filters.sql'

test('employee drawer histories send exact employee filters and pagination to RPCs',async()=>{
  const source=await read('../components/AttendanceRecords.jsx')
  const drawer=await read('../pages/AdminEmployeesPage.jsx')

  assert.match(source,/admin_employee_attendance_history_filtered/)
  assert.match(source,/admin_employee_adjustment_history_filtered/)
  assert.match(source,/const employeeId=text\(employeeIdValue\)/)
  for(const argument of [
    'p_employee_id:employeeId',
    'p_date_from:appliedFilters.from||null',
    'p_date_to:appliedFilters.to||null',
    'p_search:text(appliedFilters.keyword)||null',
    'p_page:page',
    'p_page_size:pageSize',
  ])assert.ok(source.includes(argument),`missing server argument ${argument}`)
  assert.match(source,/HISTORY_PAGE_SIZES=\[20,30,50,100\]/)
  assert.match(source,/<Pagination[\s\S]+pageSizeOptions=\{HISTORY_PAGE_SIZES\}/)
  assert.doesNotMatch(source,/historyMatches\s*=/)
  assert.match(drawer,/<EmployeeAttendancePanel employeeId=\{e\.id\}\/>/)
  assert.match(drawer,/<EmployeeAdjustmentPanel employeeId=\{e\.id\}/)
  assert.doesNotMatch(drawer,/admin_employee_attendance_history'/)
  assert.doesNotMatch(drawer,/admin_employee_adjustment_history'/)
  assert.doesNotMatch(drawer,/attendanceData|adjustmentData/)
})

test('filtered RPCs fail closed on session, permission and exact employee scope',async()=>{
  const migration=await read(migrationPath)

  for(const functionName of [
    'admin_employee_attendance_history_filtered',
    'admin_employee_adjustment_history_filtered',
  ]){
    const privateStart=migration.indexOf(`create or replace function attendance_private.${functionName}`)
    const privateEnd=migration.indexOf('\ncreate or replace function',privateStart+30)
    const body=migration.slice(privateStart,privateEnd)
    assert.ok(privateStart>=0,`missing ${functionName}`)
    assert.match(body,/auth\.uid\(\)\) is null/)
    assert.match(body,/current_app_session_is_valid\('admin'\)/)
    assert.match(body,/has_permission\('employee\.directory\.view'\)/)
    assert.match(body,/can_manage_employee\(p_employee_id\)/)
    assert.match(body,/x\.employee_id=p_employee_id/)
    assert.match(body,/p_date_from is null or [nv]\.event_date>=p_date_from/)
    assert.match(body,/p_date_to is null or [nv]\.event_date<=p_date_to/)
    assert.match(body,/v_page_size not in \(20,30,50,100\)/)
    assert.ok(body.indexOf('p_date_from is null')<body.indexOf('paged as materialized'))
    assert.ok(body.indexOf('v_search is null')<body.indexOf('paged as materialized'))
  }
})

test('adjustment category permission is applied before all totals and rows',async()=>{
  const migration=await read(migrationPath)
  const start=migration.indexOf('create or replace function attendance_private.admin_employee_adjustment_history_filtered')
  const end=migration.indexOf('\nrevoke all on function attendance_private.admin_employee_attendance_history_filtered',start)
  const body=migration.slice(start,end)
  const categoryFilter=body.indexOf('adjustment_visibility_kind(\n          x.event_kind,x.amount')
  const history=body.indexOf('history as materialized')
  const currencyStats=body.indexOf('currency_stats as materialized')
  const paged=body.indexOf('paged as materialized')

  assert.match(body,/has_permission\('adjustment\.bonus\.view'\)/)
  assert.match(body,/has_permission\('adjustment\.deduction\.view'\)/)
  assert.ok(categoryFilter>=0&&categoryFilter<history&&history<currencyStats&&currencyStats<paged)
  assert.match(body,/case when v_can_bonus then jsonb_build_object\([\s\S]+else '\{\}'::jsonb end/)
  assert.match(body,/case when v_can_deduction then jsonb_build_object\([\s\S]+else '\{\}'::jsonb end/)
  assert.match(body,/case when v_can_bonus and v_can_deduction[\s\S]+jsonb_build_object\('net_amount'/)
  assert.match(body,/'rows',coalesce\(\([\s\S]+jsonb_build_object\([\s\S]+?'category'/)
  assert.doesNotMatch(body,/to_jsonb\(p\)/)
})

test('history row payloads explicitly project only presentation fields',async()=>{
  const migration=await read(migrationPath)
  const attendanceStart=migration.indexOf('create or replace function attendance_private.admin_employee_attendance_history_filtered')
  const adjustmentStart=migration.indexOf('create or replace function attendance_private.admin_employee_adjustment_history_filtered')
  const attendance=migration.slice(attendanceStart,adjustmentStart)
  const adjustment=migration.slice(adjustmentStart,migration.indexOf('\nrevoke all on function attendance_private.admin_employee_attendance_history_filtered',adjustmentStart))

  assert.match(attendance,/jsonb_build_object\([\s\S]+?'id',n\.id[\s\S]+?'event_date',n\.event_date[\s\S]+?'event_kind',n\.normalized_event_kind[\s\S]+?'reason',n\.reason[\s\S]+?'note',n\.note/)
  assert.doesNotMatch(attendance,/to_jsonb\(n\)/)
  assert.doesNotMatch(attendance,/'raw_values'|'source_audit'|'content_hash'/)
  assert.match(adjustment,/jsonb_build_object\([\s\S]+?'id',p\.id[\s\S]+?'employee_no',p\.employee_no[\s\S]+?'full_name',p\.full_name[\s\S]+?'event_date',p\.event_date[\s\S]+?'event_kind',p\.event_kind[\s\S]+?'amount',p\.amount[\s\S]+?'category'/)
  assert.doesNotMatch(adjustment,/to_jsonb\(p\)/)
  assert.doesNotMatch(adjustment,/'raw_values'|'source_audit'|'content_hash'/)
})

test('only public filtered wrappers are executable by browser roles',async()=>{
  const migration=await read(migrationPath)

  assert.match(migration,/revoke all on function attendance_private\.admin_employee_attendance_history_filtered\([\s\S]+from public,anon,authenticated,service_role/)
  assert.match(migration,/revoke all on function attendance_private\.admin_employee_adjustment_history_filtered\([\s\S]+from public,anon,authenticated,service_role/)
  assert.match(migration,/revoke all on function public\.admin_employee_attendance_history_filtered\([\s\S]+from public,anon,authenticated,service_role/)
  assert.match(migration,/revoke all on function public\.admin_employee_adjustment_history_filtered\([\s\S]+from public,anon,authenticated,service_role/)
  assert.match(migration,/grant execute on function public\.admin_employee_attendance_history_filtered\([\s\S]+to authenticated;/)
  assert.match(migration,/grant execute on function public\.admin_employee_adjustment_history_filtered\([\s\S]+to authenticated;/)
  assert.doesNotMatch(migration,/grant execute on function public\.admin_employee_(?:attendance|adjustment)_history_filtered\([\s\S]{0,120}to authenticated,service_role/)
})
