import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

import {businessMonthIso,businessRecentRange,businessTodayIso,businessTodayRange} from './adminQueryDefaults.js'

const attendancePage=await readFile(new URL('../pages/AdminAttendancePage.jsx',import.meta.url),'utf8')
const connectivityPage=await readFile(new URL('../components/ConnectivityRecords.jsx',import.meta.url),'utf8')
const dataEntryLogs=await readFile(new URL('../components/AdminDataEntryLogs.jsx',import.meta.url),'utf8')
const employeesPage=await readFile(new URL('../pages/AdminEmployeesPage.jsx',import.meta.url),'utf8')
const reportsPage=await readFile(new URL('../pages/AdminReportsPage.jsx',import.meta.url),'utf8')
const trainingPage=await readFile(new URL('../pages/AdminTrainingPage.jsx',import.meta.url),'utf8')
const onlineTrainingPage=await readFile(new URL('../pages/OnlineTrainingPage.jsx',import.meta.url),'utf8')

test('admin detail defaults use the Manila business date at timezone boundaries',()=>{
  const instant=new Date('2026-08-26T17:30:00.000Z')
  assert.equal(businessTodayIso(instant),'2026-08-27')
  assert.equal(businessMonthIso(instant),'2026-08')
  assert.deepEqual(businessTodayRange(instant),{date_from:'2026-08-27',date_to:'2026-08-27'})
  assert.deepEqual(businessRecentRange(30,instant),{date_from:'2026-07-29',date_to:'2026-08-27'})
})

test('high-volume attendance detail views are bounded while the employee archive remains paged and unbounded',()=>{
  assert.match(attendancePage,/\['今日考勤','考勤记录','请假审批','奖金 \/ 扣款'\]\.includes\(tab\)\?businessTodayRange\(\):\{\}\)/)
  assert.match(attendancePage,/const monthValue=businessMonthIso/)
  assert.match(connectivityPage,/const initialFilters=\(\)=>\([^\n]*\.\.\.businessRecentRange\(30\)/)
  assert.match(connectivityPage,/const initialRecord=\(\)=>\([^\n]*incident_type:'power_outage'/)
  assert.match(dataEntryLogs,/const initialLogFilters = \(\) => \{[\s\S]*?const day = businessTodayIso\(\)[\s\S]*?dateFrom: day, dateTo: day/)
  assert.match(reportsPage,/const currentDayRange=\(\)=>\{const today=isoToday\(\);return\{from:today,to:today\}\}/)
  assert.match(reportsPage,/const \[range,setRange\]=useState\(currentDayRange\),\[appliedRange,setAppliedRange\]=useState\(currentDayRange\)/)
  assert.match(reportsPage,/function OrdersManualQuery[\s\S]*?useState\(currentMonthRange\)/)
  assert.match(employeesPage,/const blankPeopleFilters=\(\)=>\(\{[^\n]*date_from:'',date_to:''/)
  assert.match(onlineTrainingPage,/import \{businessTodayRange\} from '\.\.\/lib\/adminQueryDefaults'/)
  assert.match(onlineTrainingPage,/const defaultFilters=\(\)=>\{const range=businessTodayRange\(\);return\{\.\.\.EMPTY_FILTERS,from:range\.date_from,to:range\.date_to\}\}/)
  assert.match(trainingPage,/const todaySessionFilters=\(\)=>\{const day=businessTodayIso\(\);return \{\.\.\.blankSessionFilters,dateFrom:day,dateTo:day\}\}/)
  assert.match(trainingPage,/requestedTab==='人工批改'\?blankSessionFilters:todaySessionFilters\(\)/)
  assert.match(trainingPage,/x==='人工批改'\?blankSessionFilters:todaySessionFilters\(\)/)
})

test('resignation records default and reset to today without overwriting selected filters',()=>{
  assert.match(
    employeesPage,
    /const localDateIso = \(\) => \{\s*const d=new Date\(\)\s*return `\$\{d\.getFullYear\(\)\}-\$\{String\(d\.getMonth\(\)\+1\)\.padStart\(2,'0'\)\}-\$\{String\(d\.getDate\(\)\)\.padStart\(2,'0'\)\}`\s*\}/,
  )
  assert.match(
    employeesPage,
    /const blankHistoryFilters=\(\)=>\{\s*const today=localDateIso\(\)\s*return \{employee_no:'',full_name:'',team:'',position:'',country:'',reason:'',date_from:today,date_to:today\}\s*\}/,
  )
  assert.equal((employeesPage.match(/useState\(blankHistoryFilters\)/g)||[]).length,2)
  assert.match(
    employeesPage,
    /const applyHistoryFilters=\(\)=>\{\s*const next=\{\.\.\.historyDraftFilters\}\s*setHistoryFilters\(next\)[\s\S]*?loadHistory\(1,historyPageSize,next\)\s*\}/,
  )
  assert.match(
    employeesPage,
    /const resetHistoryFilters=\(\)=>\{\s*const next=blankHistoryFilters\(\)\s*setHistoryDraftFilters\(next\)\s*setHistoryFilters\(next\)[\s\S]*?loadHistory\(1,historyPageSize,next\)\s*\}/,
  )
  assert.match(employeesPage,/tab==='离职记录'\) jobs\.push\(loadHistory\(historyPage,historyPageSize,historyFilters,\{silent\}\)\)/)
  assert.match(
    employeesPage,
    /if\(!canViewResignations\|\|tab!=='离职记录'\) return\s*const t=setTimeout\(\(\)=>\{ setHistoryPage\(1\); loadHistory\(1,historyPageSize,historyFilters\) \},80\)/,
  )
})

test('monthly attendance keeps pagination metadata during refresh and clamps only after loading',()=>{
  assert.match(attendancePage,/setState\(current=>\(\{\.\.\.current,loading:true,error:''\}\)\)/)
  assert.doesNotMatch(attendancePage,/loading:true,error:'',people:\[\],overview:null,total:0,pages:1/)
  assert.match(attendancePage,/status:applied\.employee_status,[\s\S]*?page,[\s\S]*?page_size:pageSize/)
  assert.match(attendancePage,/if\(!state\.loading&&page>pages\)setPage\(pages\)/)
})
