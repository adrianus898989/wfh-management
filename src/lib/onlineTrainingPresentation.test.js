import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {
  employeeTrainerReviewRows,
  employeeTrainingTableRow,
  mergeTrainerIdentityDirectory,
  selectedTrainingHistoryRow,
  trainerIdentityCandidates,
  trainerTrainingTableRow,
} from './onlineTrainingPresentation.js'

test('employee daily-report table keeps the requested employee-first columns',()=>{
  assert.deepEqual(employeeTrainingTableRow({
    employee_id:'uuid-1',hire_date:'2026-01-13',employee_no:'CJ00007',employee_name:'Dohren',
    team_name:'AR印尼',position_name:'彩金',trainer_name:'小王',report_count:'7',recorded_days:'6',
    missing_days:'1',last_report_date:'2026-08-25',
  }),{
    key:'uuid-1',hireDate:'2026-01-13',employeeNo:'CJ00007',name:'Dohren',team:'AR印尼',position:'彩金',
    trainer:'小王',reportCount:7,recordedDays:6,missingDays:1,lastReportDate:'2026-08-25',
  })
})

test('trainer table does not invent an employee id or hire date from trainees',()=>{
  const row=trainerTrainingTableRow({
    trainer_key:'trainer-a',trainer_name:'Trainer A',team_names:['AR印度'],position_names:['线上培训'],
    report_count:2,recorded_days:2,employee_count:5,last_report_date:'2026-08-25',
  })
  assert.equal(row.employeeNo,'')
  assert.equal(row.hireDate,'')
  assert.deepEqual(row.teams,['AR印度'])
})

test('trainer identity lookup is batched by trainer key and keeps trainer fields separate from trainees',()=>{
  assert.deepEqual(trainerIdentityCandidates([
    {trainer_key:'trainer-a',trainer_employee_no:'CJ00007',trainer_name:'Trainer A'},
    {trainer_key:'trainer-a',trainer_employee_no:'TRAINEE-1',trainer_name:'Duplicate group'},
    {trainer_key:'trainer-b',trainer_name:'Trainer B'},
  ]),[
    {trainer_key:'trainer-a',trainer_employee_no:'CJ00007',trainer_name:'Trainer A'},
    {trainer_key:'trainer-b',trainer_employee_no:'',trainer_name:'Trainer B'},
  ])
})

test('authoritative trainer directory fills id and hire date without replacing unresolved fallbacks',()=>{
  const rows=mergeTrainerIdentityDirectory([
    {trainer_key:'trainer-a',trainer_employee_no:'',trainer_hire_date:'',trainer_name:'Trainer A'},
    {trainer_key:'trainer-b',trainer_employee_no:'AUTHOR-1',trainer_hire_date:'',trainer_name:'Trainer B'},
  ],[
    {trainer_key:'trainer-a',employee_no:'CJ00007',hire_date:'2026-01-13'},
    {trainer_key:'trainer-b',employee_no:null,hire_date:null},
  ])
  assert.equal(rows[0].trainer_employee_no,'CJ00007')
  assert.equal(rows[0].trainer_hire_date,'2026-01-13')
  assert.equal(rows[1].trainer_employee_no,'AUTHOR-1')
  assert.equal(rows[1].trainer_hire_date,'')
})

test('history selection keeps a selected row and safely falls back to the latest row',()=>{
  const rows=[{id:'latest',report_date:'2026-08-25'},{id:'older',report_date:'2026-08-24'}]
  assert.equal(selectedTrainingHistoryRow(rows,'older')?.id,'older')
  assert.equal(selectedTrainingHistoryRow(rows,'missing')?.id,'latest')
  assert.equal(selectedTrainingHistoryRow([],''),null)
})

test('teacher review adapter selects the employee and preserves report context',()=>{
  const rows=employeeTrainerReviewRows([{
    id:'report-1',report_date:'2026-08-26',title:'日报 A',author_name:'Trainer A',updated_at:'2026-08-26T12:00:00Z',
    report_summary:'团队整体正常',members:[
      {id:'member-a',employee_id:'employee-a',attendance_status:'normal',work_details:'完成培训',performance:'积极',issues:'无',follow_up:'继续跟进',metrics:{response_time:'12 秒'}},
      {id:'member-b',employee_id:'employee-b',attendance_status:'rest',status_note:'公休'},
    ],
  }],'employee-a')
  assert.equal(rows.length,1)
  assert.equal(rows[0].key,'member-a')
  assert.equal(rows[0].reportDate,'2026-08-26')
  assert.equal(rows[0].trainerName,'Trainer A')
  assert.equal(rows[0].workDetails,'完成培训')
  assert.equal(rows[0].responseTime,'12 秒')
  assert.equal(rows[0].reportSummary,'团队整体正常')
})

test('hire-date migration only projects the authoritative candidate value',()=>{
  const migration=readFileSync(new URL(
    '../../supabase/migrations/20260826151000_online_training_hire_date_output.sql',
    import.meta.url,
  ),'utf8')
  assert.match(migration,/pg_get_functiondef\(v_function\)/)
  assert.match(migration,/candidate\.trainer_name,[\\n\s]+candidate\.hire_date,[\\n\s]+candidate\.is_current_roster/)
  assert.doesNotMatch(migration,/\b(?:grant|revoke)\b/i)
  assert.doesNotMatch(migration,/alter\s+function|rename\s+to/i)
  assert.doesNotMatch(migration,/period_from\s+(?:as\s+)?hire_date/i)
  const sqlRegression=readFileSync(new URL(
    '../../supabase/tests/online_training_hire_date_output.sql',
    import.meta.url,
  ),'utf8')
  assert.match(sqlRegression,/candidate\.hire_date/)
  assert.match(sqlRegression,/current_app_session_is_valid/)
  assert.match(sqlRegression,/has_function_privilege\('authenticated'/)
})

test('trainer identity migration keeps the resolver bounded and enforces a nonblank report summary',()=>{
  const migration=readFileSync(new URL(
    '../../supabase/migrations/20260826164800_online_training_trainer_identity_summary_guard.sql',
    import.meta.url,
  ),'utf8')
  assert.match(migration,/online_training_resolve_trainer_identities/)
  assert.match(migration,/jsonb_array_length\(p_candidates\) > 200/)
  assert.match(migration,/employee_lifecycle_events/)
  assert.match(migration,/online_training_identity_key\(employee\.employee_no\)/)
  assert.match(migration,/online_training_identity_key\(employee\.full_name\)/)
  assert.match(migration,/count\(distinct lifecycle\.employee_id\) = 1/)
  assert.match(migration,/count\(distinct public\.online_training_identity_key/)
  assert.match(migration,/online_training_report_summary_required/)
  assert.match(migration,/nullif\(btrim\(coalesce\(p_report->>'report_summary'/)
  assert.match(migration,/online_training_employee_in_scope/)
  assert.match(migration,/online_training_save_report_scope_legacy/)
  const sqlRegression=readFileSync(new URL(
    '../../supabase/tests/online_training_trainer_identity_summary_guard.sql',
    import.meta.url,
  ),'utf8')
  assert.match(sqlRegression,/has_function_privilege/)
  assert.match(sqlRegression,/current_app_session_is_valid/)
  assert.match(sqlRegression,/online_training_report_summary_required/)
})
