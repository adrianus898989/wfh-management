import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const page = fs.readFileSync(path.join(root, 'src/pages/OnlineTrainingPage.jsx'), 'utf8')
const employeePage = fs.readFileSync(path.join(root, 'src/pages/AdminEmployeesPage.jsx'), 'utf8')
const manual = fs.readFileSync(path.join(root, 'src/config/pageDescriptions.js'), 'utf8')
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260827153000_online_training_not_started_status.sql'), 'utf8')

test('training editor exposes a no-reason not-started status only before hire date', () => {
  assert.match(page, /not_started:\{label:'未入',tone:'violet'\}/)
  assert.match(page, /REASON_REQUIRED=new Set\(\['leave','absent','transferred'\]\)/)
  assert.doesNotMatch(page, /REASON_REQUIRED=new Set\([^\n]*not_started/)
  assert.match(page, /canUseNotStarted=Boolean\(hireDate&&reportDate&&reportDate<hireDate\)/)
  assert.match(page, /disabled=\{value==='not_started'&&!canUseNotStarted/)
  assert.match(page, /attendance_status==='not_started'&&editor\.draft\.report_date>=hireDate/)
  assert.match(page, /员工档案缺少入职日期，不能选择未入/)
})

test('not-started status is visible in detail, history, statistics and the manual', () => {
  assert.match(page, /not_started_count:statusDates\.not_started\.size/)
  assert.match(page, /未入 \{counts\.not_started\|\|0\}/)
  assert.match(page, /<small>未入<\/small><b>\{summary\.not_started_count\}<\/b>/)
  assert.match(employeePage, /not_started:'未入'/)
  assert.match(manual, /尚未到入职日期的员工可记录为“未入”/)
  assert.match(manual, /“未入”和公休无需填写原因/)
})

test('database writer and summary RPCs enforce and return the new status', () => {
  assert.match(migration, /attendance_status in \([\s\S]*'not_started'/)
  assert.match(migration, /v_report_date >= v_employee\.hire_date/)
  assert.match(migration, /v_report_date is null/)
  assert.match(migration, /''hire_date'', s\.hire_date/)
  assert.match(migration, /online_training_search_reports[\s\S]*''hire_date'', employee\.hire_date/)
  assert.match(migration, /online_training_list[\s\S]*''hire_date'', employee\.hire_date/)
  assert.match(migration, /history\.attendance_status = ''not_started''/)
  assert.match(migration, /member\.attendance_status = ''not_started''/)
  assert.match(migration, /report\.not_started_count/)
})
