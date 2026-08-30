import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read=relative=>readFile(new URL(relative,import.meta.url),'utf8')
const migrationUrl='../../supabase/migrations/20260830121751_employee_drawer_server_paging.sql'

const functionBody=(source,name,nextName='')=>{
  const start=source.indexOf(`create or replace function public.${name}(`)
  assert.ok(start>=0,`missing ${name}`)
  const end=nextName?source.indexOf(`create or replace function public.${nextName}(`,start):source.indexOf('revoke all on function',start)
  assert.ok(end>start,`missing end of ${name}`)
  return source.slice(start,end)
}

test('employee drawer history readers are authenticated, scoped, bounded, and fail closed',async()=>{
  const migration=await read(migrationUrl)
  const connectivity=functionBody(migration,'admin_employee_connectivity_history_page','admin_employee_payroll_history_page')
  const payroll=functionBody(migration,'admin_employee_payroll_history_page','admin_employee_connectivity_history')

  for(const body of [connectivity,payroll]){
    const auth=body.indexOf('(select auth.uid())')
    const directory=body.indexOf("has_permission('employee.directory.view')")
    const scope=body.indexOf('can_manage_employee(p_employee_id)')
    const firstEmployeeRead=body.indexOf('from public.employees')
    assert.ok(auth>=0&&directory>auth&&scope>directory&&firstEmployeeRead>scope)
    assert.match(body,/security definer[\s\S]+set search_path = ''[\s\S]+set statement_timeout = '3s'/)
    assert.match(body,/p_page_size in \(20,30,50,100\)/)
    assert.match(body,/left\(lower\(btrim\(coalesce\(p_search,''\)\)\),100\)/)
    assert.match(body,/offset \(v_page-1\)\*v_page_size[\s\S]+limit v_page_size/)
    assert.match(body,/'server_paging',true/)
  }

  assert.match(connectivity,/has_permission\('connectivity\.view'\)/)
  assert.ok((connectivity.match(/incident\.employee_id=p_employee_id/g)||[]).length>=2)

  assert.match(payroll,/has_permission\('employee\.directory\.payroll_records\.view'\)/)
  assert.ok((payroll.match(/payslip\.employee_id=p_employee_id/g)||[]).length>=2)
  assert.ok((payroll.match(/batch\.status='published'/g)||[]).length>=2)
  assert.ok((payroll.match(/batch\.voided_at is null/g)||[]).length>=2)
  for(const forbiddenField of ['raw_payload','line_items','card_number','payment_name','payment_method','employee_no_raw']){
    assert.ok(!payroll.includes(forbiddenField),`paged payroll reader must not expose ${forbiddenField}`)
  }

  assert.match(migration,/revoke all on function[\s\S]+from public,anon,authenticated,service_role;/)
  assert.match(migration,/grant execute on function[\s\S]+to authenticated;/)
  assert.doesNotMatch(migration,/grant execute on function[\s\S]+to authenticated,service_role/)
  assert.doesNotMatch(migration,/admin_alert|alert_events|1_day|3_day|7_day/)
})

test('legacy drawer calls return a bounded first page without weakening their guards',async()=>{
  const migration=await read(migrationUrl)
  const connectivity=functionBody(migration,'admin_employee_connectivity_history','admin_employee_payroll_history')
  const payroll=functionBody(migration,'admin_employee_payroll_history')
  for(const body of [connectivity,payroll]){
    assert.match(body,/if \(select auth.uid\(\)\) is null then/)
    assert.match(body,/p_employee_id,null,null,'',1,20/)
  }
})

test('drawer panels use server date/search pagination while preserving staff local filtering',async()=>{
  const source=await read('../components/ConnectivityRecords.jsx')
  assert.match(source,/const DRAWER_HISTORY_PAGE_SIZES=\[20,30,50,100\]/)
  assert.match(source,/employeeId=text\(data\?\.employee_id\)[\s\S]+serverMode=Boolean\(data\?\.server_paging&&employeeId\)/)
  assert.match(source,/rpcName:'admin_employee_connectivity_history_page'/)
  assert.match(source,/rpcName:'admin_employee_payroll_history_page'/)
  assert.match(source,/p_employee_id:targetEmployeeId[\s\S]+p_date_from:nextFilters\.from\|\|null[\s\S]+p_search:text\(nextFilters\.keyword\)[\s\S]+p_page_size:nextSize/)
  assert.match(source,/requestRef\.current\+=1[\s\S]+setRemote\(\{employeeId,data:serverMode\?data:null/)
  assert.match(source,/employeeRef\.current!==targetEmployeeId/)
  assert.match(source,/matchingRemote=remote\.employeeId===employeeId\?remote:null/)
  assert.match(source,/const visibleRows=history\.serverMode\?rows:locallyFilteredRows/)
  assert.match(source,/pageSizeOptions=\{DRAWER_HISTORY_PAGE_SIZES\}/)
  assert.match(source,/日期起[\s\S]+日期止[\s\S]+搜索月份、日期、批次、币种、金额或备注/)
  assert.match(source,/role="alert"/)
})
