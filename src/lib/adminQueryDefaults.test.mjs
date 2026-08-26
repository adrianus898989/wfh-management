import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

import {businessMonthIso,businessTodayIso,businessTodayRange} from './adminQueryDefaults.js'

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
})

test('high-volume attendance detail views are bounded while the employee archive remains paged and unbounded',()=>{
  assert.match(attendancePage,/\['今日考勤','考勤记录','请假审批','奖金 \/ 扣款'\]\.includes\(tab\)\?businessTodayRange\(\):\{\}\)/)
  assert.match(attendancePage,/const monthValue=businessMonthIso/)
  assert.match(connectivityPage,/const initialFilters=\(\)=>\([^\n]*\.\.\.businessTodayRange\(\)/)
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

test('monthly attendance keeps pagination metadata during refresh and clamps only after loading',()=>{
  assert.match(attendancePage,/setState\(current=>\(\{\.\.\.current,loading:true,error:''\}\)\)/)
  assert.doesNotMatch(attendancePage,/loading:true,error:'',people:\[\],overview:null,total:0,pages:1/)
  assert.match(attendancePage,/status:applied\.employee_status,[\s\S]*?page,[\s\S]*?page_size:pageSize/)
  assert.match(attendancePage,/if\(!state\.loading&&page>pages\)setPage\(pages\)/)
})
