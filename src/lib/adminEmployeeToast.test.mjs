import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page=await readFile(new URL('../pages/AdminEmployeesPage.jsx',import.meta.url),'utf8')

const section=(start,end)=>{
  const from=page.indexOf(start)
  const to=page.indexOf(end,from)
  assert.ok(from>=0&&to>from,`missing source section: ${start}`)
  return page.slice(from,to)
}

test('employee page publishes global outcomes while retaining durable local errors',()=>{
  assert.match(page,/import \{ useAppToast \} from '\.\.\/components\/AppToastProvider'/)
  assert.match(page,/const \{notify\}=useAppToast\(\)/)
  assert.match(page,/const publishEmployeeFailure=[\s\S]*type:'error'[\s\S]*dedupeKey:employeeToastDedupeKey/)
  assert.match(page,/const publishEmployeeSuccess=[\s\S]*type:'success'[\s\S]*dedupeKey:employeeToastDedupeKey/)

  assert.match(page,/className="page-error employee-notice"/)
  assert.match(page,/setDetailError\(message\)[\s\S]*publishEmployeeFailure\('读取员工详情'/)
  assert.match(page,/EmployeeExamDetailModal detail=\{examDetail\} loading=\{detailLoading\} error=\{detailError\}/)
  assert.match(page,/employee-private-note-message/)
})

test('only explicit employee reads announce failures',()=>{
  assert.match(page,/loadBootstrap=async\([^\n]*announceFailure=false/)
  assert.match(page,/loadPeopleAnalytics=async\([^\n]*announceFailure=false/)
  assert.match(page,/loadHistory=async\([^\n]*announceFailure=false/)
  assert.match(page,/loadAudit=async\([^\n]*announceFailure=false/)

  const routeDetail=section("useEffect(()=>{\n    if(!canViewEmployees||!requestedEmployeeId",'const writeEmployee=async')
  assert.doesNotMatch(routeDetail,/publishEmployeeFailure|notify\(/)

  const initialDirectory=section("if(adminAccess.loading||tab!=='员工档案'||!canViewEmployees)return", "if(adminAccess.loading||!['人员分析','操作日志'].includes(tab))return")
  assert.doesNotMatch(initialDirectory,/announceFailure:true/)
  assert.match(page,/refreshEmployeeDataRef\.current\?\.\(\{silent:true\}\)\.catch/)

  assert.match(page,/applyEmployeeFilters=[\s\S]{0,240}loadList\(1,pageSize,\{nextFilters:next,announceFailure:true\}\)/)
  assert.match(page,/applyAnalysisFilters=[\s\S]{0,620}loadPeopleAnalytics\(next,\{announceFailure:true\}\)/)
  assert.match(page,/employee-refresh-action" onClick=\{\(\)=>refreshEmployeeData\(\{announceFailure:true\}\)\}/)
  assert.match(page,/load\(\{clear:true\}\)/)
  assert.match(page,/onClick=\{\(\)=>load\(\{announceFailure:true\}\)\}>重新读取内部备注|onClick=\{\(\)=>load\(\{announceFailure:true\}\)\}>重新读取/)

  const historyLoad=section('const loadHistory=async','const loadAudit=async')
  assert.match(historyLoad,/const readIntent=historyReadIntentRef\.current\s*historyReadIntentRef\.current=''\s*const shouldAnnounceFailure=/)
  assert.ok(historyLoad.indexOf("historyReadIntentRef.current='' ".trim())<historyLoad.indexOf("await invoke({action:'history_list'"))

  const directoryQueue=section('const enqueueEmployeeDirectoryRequest=request','const loadBootstrap=async')
  assert.match(directoryQueue,/if\(state\.inFlight===task\)\{state\.inFlight=null;state\.activeKey='';state\.pending=null\}/)
})

test('employee mutation retries only refresh confirmation and name partial-success stages',()=>{
  assert.match(page,/const refreshMutationConfirmation=\(\)=>refreshEmployeeDataRef\.current\?\.\(\{announceFailure:true\}\)/)
  assert.match(page,/const publishMutationFailure=[\s\S]{0,260}retry:refreshMutationConfirmation,retryLabel:'刷新确认'/)
  assert.doesNotMatch(page,/retry:\s*(?:async\s*)?\(\)\s*=>\s*(?:saveEmployee|submitResign|submitResignEdit|submitRestore|submitCancelHire|writeEmployee|invoke)\s*\(/)
  assert.doesNotMatch(page,/retry:\s*(?:saveEmployee|submitResign|submitResignEdit|submitRestore|submitCancelHire|writeEmployee|invoke)\b/)

  const save=section('const saveEmployee=async','const openHistoryDetail=async')
  assert.match(save,/publishEmployeeSuccess\(operation/)
  assert.match(save,/failureOperation=rollbackOk\?'同步新增员工':'撤销未同步新增员工'/)
  assert.match(save,/failureOperation='同步员工修改'/)
  assert.match(save,/failureOperation='刷新新增员工结果'/)
  assert.match(save,/failureOperation='读取修改后员工详情'/)

  assert.match(page,/failureOperation='同步离职记录修改'/)
  assert.match(page,/failureOperation='同步员工离职'/)
  assert.match(page,/failureOperation='同步恢复在职'/)
  assert.match(page,/failureOperation='同步撤销入职'/)
  assert.match(page,/publishEmployeeSuccess\('办理离职'/)
  assert.match(page,/publishEmployeeSuccess\('恢复员工在职'/)
  assert.match(page,/publishEmployeeSuccess\('撤销员工入职'/)

  assert.match(page,/const pageMountedRef=useRef\(true\)/)
  assert.match(page,/return\(\)=>\{pageMountedRef\.current=false;refreshEmployeeDataRef\.current=null;historyReadIntentRef\.current=''\}/)
  assert.match(save,/const data=await writeEmployee\(payload\)\s*if\(!pageMountedRef\.current\|\|employeeBootstrapRef\.current\.epoch!==operationEpoch\)return/)
  assert.match(page,/const data=await invoke\(\{[\s\S]{0,360}if\(!pageMountedRef\.current\)return[\s\S]{0,100}setEditResignModal\(null\)/)
  assert.match(page,/function EmployeePrivateNotesPanel[\s\S]*if\(!mountedRef\.current\|\|requestRef\.current!==requestId/)
})

test('explicit detail and export failures have safe read retries',()=>{
  assert.match(page,/publishEmployeeFailure\('读取员工详情',[\s\S]{0,180}retry:\(\)=>openDetail\(row\)/)
  assert.match(page,/publishEmployeeFailure\('读取人员分析明细',[\s\S]{0,260}retry:\(\)=>openAnalysisDetail/)
  assert.match(page,/operation:'读取考试详情'[\s\S]{0,180}retry:\(\)=>openExam\(row\)/)

  const exportSource=section('const exportEmployeeArchive=async','const pages=')
  assert.match(exportSource,/publishEmployeeFailure\('导出员工档案',message/)
  assert.match(exportSource,/retry:exportEmployeeArchive/)
  assert.match(exportSource,/setError\(message\)/)
})
