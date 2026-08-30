import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterEmployeeErrorHistory,
  filterEmployeeExamHistory,
  filterEmployeePayrollHistory,
} from './employeeRecordFilters.js'

test('error history supports date range and typed date search',()=>{
  const rows=[
    {id:1,qc_date:'2026-08-21',error_type:'Wrong process',qc_person:'YM1'},
    {id:2,qc_date:'2026-07-04',error_type:'Wrong reply',qc_person:'YM2'},
  ]
  assert.deepEqual(filterEmployeeErrorHistory(rows,{dateFrom:'2026-08-01',dateTo:'2026-08-31'}).map(row=>row.id),[1])
  assert.deepEqual(filterEmployeeErrorHistory(rows,{query:'2026-07-04'}).map(row=>row.id),[2])
})

test('exam history matches any lifecycle date and searchable fields',()=>{
  const rows=[
    {id:1,title:'彩金考试',started_at:'2026-08-27T15:00:00Z',graded_at:'2026-08-28T09:00:00Z',grader_name:'阿荣',passed:true},
    {id:2,title:'出款考试',started_at:'2026-07-20T15:00:00Z',grader_name:'阿明',passed:false},
    {id:3,title:'待批改考试',started_at:'2026-08-29T15:00:00Z',grader_name:'',passed:null},
  ]
  assert.deepEqual(filterEmployeeExamHistory(rows,{dateFrom:'2026-08-28',dateTo:'2026-08-28'}).map(row=>row.id),[1])
  assert.deepEqual(filterEmployeeExamHistory(rows,{query:'2026-07-20'}).map(row=>row.id),[2])
  assert.deepEqual(filterEmployeeExamHistory(rows,{query:'阿荣'}).map(row=>row.id),[1])
  assert.deepEqual(filterEmployeeExamHistory(rows,{query:'未通过'}).map(row=>row.id),[2])
})

test('payroll month filtering preserves every published document including same-month records',()=>{
  const rows=[
    {id:'july-a',period_start:'2026-07-01',title:'7月1-15工资',currency:'PHP',total_pay:12610,status:'published'},
    {id:'july-b',period_start:'2026-07-16',title:'7月16-31工资',currency:'PHP',total_pay:16580,status:'published'},
    {id:'june',period_start:'2026-06-01',title:'6月工资',currency:'PHP',total_pay:14000,status:'published'},
  ]
  assert.deepEqual(filterEmployeePayrollHistory(rows,{from:'2026-07-01',to:'2026-07-31'}).map(row=>row.id),['july-a','july-b'])
  assert.deepEqual(filterEmployeePayrollHistory(rows,{keyword:'7月16-31'}).map(row=>row.id),['july-b'])
  assert.equal(filterEmployeePayrollHistory(rows,{}).length,3)
})
