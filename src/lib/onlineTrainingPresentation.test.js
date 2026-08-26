import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {
  employeeTrainingTableRow,
  selectedTrainingHistoryRow,
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

test('history selection keeps a selected row and safely falls back to the latest row',()=>{
  const rows=[{id:'latest',report_date:'2026-08-25'},{id:'older',report_date:'2026-08-24'}]
  assert.equal(selectedTrainingHistoryRow(rows,'older')?.id,'older')
  assert.equal(selectedTrainingHistoryRow(rows,'missing')?.id,'latest')
  assert.equal(selectedTrainingHistoryRow([],''),null)
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
