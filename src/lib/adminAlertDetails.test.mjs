import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  adminAlertAttendanceDetails,
  adminAlertEmployeeHistoryFilters,
  adminAlertEmployeeHireDate,
  adminAlertFollowUpState,
  adminAlertKeyAttendanceEvidence,
  adminAlertReadState,
} from './adminAlertDetails.js'

const employeeHistoryMigration = readFileSync(new URL(
  '../../supabase/migrations/20260826152500_admin_alert_employee_history_filter.sql',
  import.meta.url,
), 'utf8')
const alertCenterComponent = readFileSync(new URL('../components/AdminAlertCenter.jsx', import.meta.url), 'utf8')
const alertCenterStyles = readFileSync(new URL('../styles-admin-alerts.css', import.meta.url), 'utf8')
const followUpMigration = readFileSync(new URL(
  '../../supabase/migrations/20260827073000_admin_alert_follow_up_workflow.sql',
  import.meta.url,
), 'utf8')

test('monthly leave exposes the existing category totals and dated evidence', () => {
  const detail = adminAlertAttendanceDetails({
    alert_type:'monthly_leave',
    payload:{
      public_holiday:3,
      leave:1,
      absence:2,
      half_day:2,
      home_leave_excluded:true,
      events:[
        { date:'2026-08-08', event_kind:'half_day', reason:'Medical appointment', note:'Approved', weight:0.5 },
        { date:'2026-08-02', event_kind:'public_holiday', reason:'排班公休', weight:1 },
      ],
    },
  }, 'zh')

  assert.equal(detail.title, '本月计入休假的日期明细')
  assert.deepEqual(detail.breakdown.map(item => [item.kind, item.count]), [
    ['public_holiday', 3], ['leave', 1], ['absence', 2], ['half_day', 2],
  ])
  assert.equal(detail.events[0].date, '2026-08-02')
  assert.equal(detail.events[1].description, '原因：Medical appointment · 备注：Approved')
  assert.equal(detail.events[1].weight, 0.5)
  assert.equal(detail.homeLeaveExcluded, true)
})

test('weekly absence shows each date and makes a missing reason explicit', () => {
  const detail = adminAlertAttendanceDetails({
    alert_type:'weekly_absence',
    payload:{ events:[
      { date:'2026-08-20', event_kind:'absence', reason:'生病', note:'生病' },
      { date:'2026-08-24', event_kind:'absence' },
    ] },
  }, 'zh')

  assert.equal(detail.title, '缺席日期与原因')
  assert.equal(detail.events[0].description, '原因：生病')
  assert.equal(detail.events[1].description, '未填写原因或备注')
  assert.equal(detail.missingDetails, false)
})

test('consecutive rest shows every public-rest date, reason and note', () => {
  const row = {
    alert_type:'consecutive_rest',
    payload:{ events:[
      { date:'2026-08-21', event_kind:'public_holiday', reason:'排班公休', note:'主管已确认' },
      { date:'2026-08-22', event_kind:'public_holiday', reason:'法定公休', note:'正常排班' },
    ] },
  }
  const detail = adminAlertAttendanceDetails(row, 'zh')

  assert.equal(detail.title, '连续公休日期与原因')
  assert.equal(detail.events.length, 2)
  assert.equal(detail.events[0].reason, '排班公休')
  assert.equal(detail.events[0].note, '主管已确认')
  assert.match(adminAlertKeyAttendanceEvidence(row, 'zh'), /2026-08-21 · 公休 · 原因：排班公休 · 备注：主管已确认/)
  assert.match(followUpMigration, /alert\.alert_type = 'consecutive_rest'[\s\S]{0,100}lower\(record\.event_kind\) = 'public_holiday'/)
  assert.match(followUpMigration, /'reason', ranked\.reason,[\s\S]{0,80}'note', ranked\.note/)
})

test('legacy payloads remain renderable until the enriched refresh runs', () => {
  const detail = adminAlertAttendanceDetails({
    alert_type:'weekly_absence',
    payload:{ days:7, count:2 },
  }, 'en')

  assert.deepEqual(detail.events, [])
  assert.equal(detail.missingDetails, true)
  assert.equal(adminAlertAttendanceDetails({ alert_type:'exam_failed', payload:{} }), null)
})

test('alert table resolves the employee hire date from current and compatible payload fields', () => {
  assert.equal(adminAlertEmployeeHireDate({ hire_date:'2026-03-04T00:00:00Z' }), '2026-03-04')
  assert.equal(adminAlertEmployeeHireDate({ payload:{ employee_hire_date:'2025-12-18' } }), '2025-12-18')
  assert.equal(adminAlertEmployeeHireDate({ payload:{} }), '—')
})

test('bell evidence includes the first abnormal date, reason and remaining dated records', () => {
  const row = {
    alert_type:'weekly_absence',
    payload:{ events:[
      { date:'2026-08-20', event_kind:'absence', reason:'生病', note:'已通知组长' },
      { date:'2026-08-24', event_kind:'absence', reason:'临时缺席' },
    ] },
  }

  assert.equal(
    adminAlertKeyAttendanceEvidence(row, 'zh'),
    '2026-08-20 · 缺席 · 原因：生病 · 备注：已通知组长；另有 1 个异常日期',
  )
  assert.equal(adminAlertKeyAttendanceEvidence({ alert_type:'exam_failed', payload:{} }, 'zh'), '')
})

test('employee warning history uses an exact employee filter and includes resolved incidents', () => {
  assert.deepEqual(adminAlertEmployeeHistoryFilters('  employee-42  '), {
    status:'all',
    employee_id:'employee-42',
  })
  assert.equal(adminAlertEmployeeHistoryFilters(''), null)
})

test('warning read state has explicit localized labels in a dedicated status column', () => {
  assert.deepEqual(adminAlertReadState({ unread:true }, 'zh'), { unread:true, label:'未读' })
  assert.deepEqual(adminAlertReadState({ unread:false }, 'en'), { unread:false, label:'Read' })
  assert.match(alertCenterComponent, /\? 'Summary' : '预警摘要'\}<\/span><span>\{locale === 'en' \? 'Read status' : '状态'\}<\/span>/)
  assert.match(alertCenterComponent, /className="admin-alert-table-summary"[^>]*>\{copy\.message\}<\/span>/)
  assert.match(alertCenterComponent, /className="admin-alert-table-read">[\s\S]{0,180}admin-alert-read-state/)
})

test('only explicit expand controls toggle rows and employee IDs remain selectable', () => {
  assert.doesNotMatch(alertCenterComponent, /<button[^>]+className="admin-alert-table-row"/)
  assert.doesNotMatch(alertCenterComponent, /<button[^>]+className="employee-alert-history-row"/)
  assert.match(alertCenterComponent, /className="admin-alert-table-expand"[^>]+onClick=\{\(\) => toggleRow\(row\)\}/)
  assert.match(alertCenterComponent, /className="employee-alert-history-expand"[^>]+onClick=\{\(\) => toggleRow\(row\)\}/)
  assert.match(alertCenterStyles, /admin-alert-employee-id\{[^}]*user-select:text/)
  assert.match(alertCenterStyles, /grid-template-columns:108px 116px minmax\(145px,.75fr\) 145px 90px 145px minmax\(230px,1.4fr\) 72px 118px 62px/)
})

test('follow-up state reports reader, confirmation, handler and required note', () => {
  const pending = adminAlertFollowUpState({
    readers:[{ auth_user_id:'reader-1', account:'founder', read_at:'2026-08-27T08:00:00Z' }],
  }, 'zh')
  assert.equal(pending.label, '待确认')
  assert.equal(pending.actor, 'founder')

  const handled = adminAlertFollowUpState({
    readers:[{ auth_user_id:'reader-1', account:'founder', read_at:'2026-08-27T08:00:00Z' }],
    follow_up:{
      status:'handled', confirmed_by_name:'manager-a', confirmed_at:'2026-08-27T08:10:00Z',
      handled_by_name:'manager-b', handled_at:'2026-08-27T08:20:00Z', handling_note:'排班录入错误，已修正',
    },
  }, 'zh')
  assert.equal(handled.label, '已处理')
  assert.equal(handled.actor, 'manager-b')
  assert.equal(handled.note, '排班录入错误，已修正')
})

test('follow-up migration keeps private tables and scoped RPC authorization', () => {
  assert.match(followUpMigration, /alter table public\.admin_alert_follow_ups enable row level security/)
  assert.match(followUpMigration, /revoke all on table public\.admin_alert_follow_ups[\s\S]{0,80}from public, anon, authenticated/)
  assert.match(followUpMigration, /current_app_session_is_valid\('admin'\)/)
  assert.match(followUpMigration, /caller_can_view_alert_type\(event\.alert_type\)/)
  assert.match(followUpMigration, /backend_employee_in_scope\(event\.employee_id\)/)
  assert.match(followUpMigration, /handling_note_required/)
  assert.match(followUpMigration, /alert_confirmation_required/)
  assert.match(followUpMigration, /'readers', coalesce/)
  assert.match(followUpMigration, /'follow_up', coalesce/)
  assert.match(followUpMigration, /advisory locks are re-entrant for the owning session/)
})

test('employee warning history keeps the existing session, type permission, and employee scope guards', () => {
  assert.match(employeeHistoryMigration, /current_app_session_is_valid\('admin'\)/)
  assert.match(employeeHistoryMigration, /caller_can_view_alert_type\(event\.alert_type\)/)
  assert.match(employeeHistoryMigration, /backend_employee_in_scope\(event\.employee_id\)/)
  assert.match(employeeHistoryMigration, /alert\.employee_id = v_employee_id/)
  assert.match(employeeHistoryMigration, /from public, anon;/)
  assert.match(employeeHistoryMigration, /to authenticated, service_role;/)
})
