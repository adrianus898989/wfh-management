import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  adminAlertAdjustmentDetails,
  adminAlertAttendanceDetails,
  adminAlertEmployeeHistoryFilters,
  adminAlertEmployeeHireDate,
  adminAlertErrorFrequencyDetails,
  adminAlertFollowUpState,
  adminAlertKeyAdjustmentEvidence,
  adminAlertKeyEvidence,
  adminAlertKeyAttendanceEvidence,
  adminAlertReadState,
} from './adminAlertDetails.js'
import {
  ADMIN_ALERT_BADGE_CACHE_FRESH_MS,
  ADMIN_ALERT_BADGE_MAX_BACKOFF_MS,
  ADMIN_ALERT_BADGE_REFRESH_MS,
  acquireAdminAlertBadgePreloadLease,
  adminAlertBadgeRefreshDelay,
  adminAlertBadgeStorageKey,
  classifyAdminAlertBadgeFailure,
  readAdminAlertBadgeCache,
  releaseAdminAlertBadgePreloadLease,
  writeAdminAlertBadgeCache,
} from './adminAlertBadgePreload.js'

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
const teamColumnsMigration = readFileSync(new URL(
  '../../supabase/migrations/20260827115000_admin_alert_team_and_follow_up_columns.sql',
  import.meta.url,
), 'utf8')
const currentRosterTeamMigration = readFileSync(new URL(
  '../../supabase/migrations/20260827155000_admin_alert_current_roster_team.sql',
  import.meta.url,
), 'utf8')
const errorFrequencyMigration = readFileSync(new URL(
  '../../supabase/migrations/20260827165000_admin_alert_error_frequency_thresholds.sql',
  import.meta.url,
), 'utf8')
const stableAlertRestoreMigration = readFileSync(new URL(
  '../../supabase/migrations/20260827200500_restore_stable_alerts.sql',
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

test('late-timeout warning exposes the existing production reasons immediately', () => {
  const row = {
    alert_type:'late_timeout_frequency',
    occurrence_count:3,
    payload:{
      days:7,
      threshold:3,
      count:3,
      reasons:['late 1mn and 9s', 'overbreak 5mins 43 secs', 'late 1mn and 9s'],
    },
  }
  const detail = adminAlertAdjustmentDetails(row, 'zh')

  assert.equal(detail.title, '预警区间内迟到 / 超时扣款明细')
  assert.equal(detail.summary, '3 笔；预警阈值 3 笔')
  assert.deepEqual(detail.reasons, ['late 1mn and 9s', 'overbreak 5mins 43 secs'])
  assert.equal(detail.legacyReasonsOnly, true)
  assert.equal(detail.missingDetails, false)
  assert.equal(adminAlertKeyAdjustmentEvidence(row, 'zh'), 'late 1mn and 9s；另有 1 个原因')
  assert.equal(adminAlertKeyEvidence(row, 'zh'), 'late 1mn and 9s；另有 1 个原因')
})

test('enriched late-timeout evidence is bounded, dated and includes amount and reason', () => {
  const row = {
    alert_type:'late_timeout_frequency',
    payload:{ threshold:3, count:14, reasons:['legacy fallback'], events:Array.from({ length:14 }, (_, index) => ({
      date:`2026-08-${String(index + 1).padStart(2, '0')}`,
      event_kind:'deduction',
      currency:'usd',
      amount:-(index + 1),
      reason:`Late ${index + 1}`,
      note:index === 13 ? 'latest note' : '',
    })) },
  }
  const detail = adminAlertAdjustmentDetails(row, 'en')

  assert.equal(detail.events.length, 12)
  assert.equal(detail.events[0].date, '2026-08-14')
  assert.equal(detail.events[0].currency, 'USD')
  assert.equal(detail.events[0].amount, -14)
  assert.deepEqual(detail.reasons, [])
  assert.equal(detail.legacyReasonsOnly, false)
  assert.match(adminAlertKeyAdjustmentEvidence(row, 'en'), /^2026-08-14 · USD -14 · Reason: Late 14 · Note: latest note; 11 more matching records$/)
  assert.equal(adminAlertAdjustmentDetails({ alert_type:'monthly_leave', payload:{} }), null)
})

test('late-timeout detail panel is rendered in both alert records and employee history', () => {
  assert.match(alertCenterComponent, /function AlertAdjustmentDetails/)
  assert.equal((alertCenterComponent.match(/<AlertAdjustmentDetails row=\{row\} locale=\{locale\}\/\>/g) || []).length, 2)
  assert.match(alertCenterComponent, /本次预警匹配到的原因/)
  assert.match(alertCenterComponent, /扣款日期/)
  assert.match(alertCenterStyles, /admin-alert-adjustment-reasons/)
})

test('error-frequency details expose all three thresholds and triggered rules', () => {
  const detail = adminAlertErrorFrequencyDetails({
    alert_type:'error_spike',
    payload:{ rules:[
      { days:1, threshold:5, count:2, triggered:false },
      { days:3, threshold:5, count:5, triggered:true },
      { days:7, threshold:10, count:8, triggered:false },
    ] },
  }, 'zh')

  assert.equal(detail.title, '错误频率检测明细')
  assert.equal(detail.note, '任意一条规则达到阈值即产生预警。')
  assert.deepEqual(detail.rules.map(rule => [rule.label, rule.result, rule.triggered]), [
    ['1天', '2 / 5 笔错误', false],
    ['3天', '5 / 5 笔错误', true],
    ['7天', '8 / 10 笔错误', false],
  ])
  assert.equal(adminAlertErrorFrequencyDetails({ alert_type:'weekly_absence' }), null)
})

test('legacy error-frequency payload keeps its historical threshold readable', () => {
  const detail = adminAlertErrorFrequencyDetails({
    alert_type:'error_spike', occurrence_count:6,
    payload:{ days:3, threshold:6, count:6 },
  }, 'en')

  assert.deepEqual(detail.rules.map(rule => [rule.label, rule.result, rule.triggered]), [
    ['3 days', '6 / 6 errors', true],
  ])
})

test('error-frequency migration is server-authoritative, deduplicated and scope-safe', () => {
  assert.match(errorFrequencyMigration, /error_frequency_candidates\(v_today\)/)
  assert.match(errorFrequencyMigration, /count_1d >= 5/)
  assert.match(errorFrequencyMigration, /count_3d >= 5/)
  assert.match(errorFrequencyMigration, /count_7d >= 10/)
  assert.match(errorFrequencyMigration, /not exists \([\s\S]{0,220}newer\.record_key = error\.record_key/)
  assert.match(errorFrequencyMigration, /'error_spike:' \|\| frequency\.employee_id::text/)
  assert.match(errorFrequencyMigration, /revoke all on function alerts_private\.error_frequency_candidates\(date\)[\s\S]{0,80}from public, anon, authenticated/)
  assert.match(alertCenterComponent, /3 天内错误记录达到 6 笔/)
  assert.doesNotMatch(alertCenterComponent, /1 天 5 笔、3 天 5 笔或 7 天 10 笔错误/)
  assert.match(alertCenterComponent, /<AlertErrorFrequencyDetails row=\{row\} locale=\{locale\}\/>/)
})

test('alert bell preloads only a bounded summary and keeps rows click-loaded', () => {
  const bell = alertCenterComponent.slice(
    alertCenterComponent.indexOf('export function AdminAlertBell'),
    alertCenterComponent.indexOf('export function EmployeeAlertHistoryPanel'),
  )
  assert.doesNotMatch(bell, /setInterval\(/)
  assert.doesNotMatch(bell, /addEventListener\('focus'/)
  assert.match(bell, /summaryOnly \? 1 : 8/)
  assert.match(bell, /setTimeout\(runSummary/)
  assert.match(bell, /document\.visibilityState !== 'visible'/)
  assert.match(bell, /load\(\{ kind:'summary', quiet:true \}\)/)
  assert.match(bell, /onClick=\{\(\) => \{ setOpen\(value => !value\); if \(!open\) load\(\{ kind:'details' \}\) \}\}/)
  assert.match(bell, /error:summaryOnly[\s\S]{0,100}\? current\.error/)
  assert.doesNotMatch(bell, /signOut|clearSession|removeItem\([^)]*auth/i)
})

test('alert badge cache and lease coalesce permission-success preloads across tabs', () => {
  const values = new Map()
  const storage = {
    getItem:key => values.get(key) || null,
    setItem:(key, value) => values.set(key, value),
    removeItem:key => values.delete(key),
  }
  const access = {
    authUserId:'admin-1', dataScope:'assigned_teams', teamId:'team-1',
    permissions:['alert.view', 'alert.error_spike.view'],
  }
  const key = adminAlertBadgeStorageKey(access)
  assert.ok(key.includes('admin-1'))
  assert.notEqual(key, adminAlertBadgeStorageKey({ ...access, permissions:['alert.view'] }))

  assert.equal(writeAdminAlertBadgeCache(storage, key, { unread:7, active:9 }, 100_000), true)
  assert.deepEqual(readAdminAlertBadgeCache(storage, key, 100_001), {
    unread:7, active:9, updatedAt:100_000, fresh:true,
  })
  assert.equal(readAdminAlertBadgeCache(storage, key, 100_000 + ADMIN_ALERT_BADGE_CACHE_FRESH_MS + 1)?.fresh, false)

  const first = acquireAdminAlertBadgePreloadLease(storage, key, { now:200_000, random:() => 0.1 })
  assert.ok(first)
  assert.equal(acquireAdminAlertBadgePreloadLease(storage, key, { now:200_001, random:() => 0.2 }), '')
  assert.equal(releaseAdminAlertBadgePreloadLease(storage, key, 'not-owner'), false)
  assert.equal(releaseAdminAlertBadgePreloadLease(storage, key, first), true)
})

test('badge refresh is five-minute setTimeout scheduling with bounded failure backoff', () => {
  assert.equal(adminAlertBadgeRefreshDelay(0, () => 0), ADMIN_ALERT_BADGE_REFRESH_MS)
  assert.equal(adminAlertBadgeRefreshDelay(1, () => 0), ADMIN_ALERT_BADGE_REFRESH_MS * 2)
  assert.equal(adminAlertBadgeRefreshDelay(2, () => 0), ADMIN_ALERT_BADGE_MAX_BACKOFF_MS)
  assert.equal(adminAlertBadgeRefreshDelay(20, () => 0), ADMIN_ALERT_BADGE_MAX_BACKOFF_MS)
  assert.equal(adminAlertBadgeRefreshDelay(2, () => 0.999), ADMIN_ALERT_BADGE_MAX_BACKOFF_MS)
})

test('badge failures distinguish 401/403 while 503 and timeout stay transient', () => {
  assert.deepEqual(classifyAdminAlertBadgeFailure({ status:401 }), {
    status:401, auth:'unauthorized', timedOut:false, transient:false,
  })
  assert.deepEqual(classifyAdminAlertBadgeFailure({ context:{ status:403 } }), {
    status:403, auth:'forbidden', timedOut:false, transient:false,
  })
  assert.deepEqual(classifyAdminAlertBadgeFailure({ status:503 }), {
    status:503, auth:'', timedOut:false, transient:true,
  })
  assert.deepEqual(classifyAdminAlertBadgeFailure({ code:'ADMIN_ALERT_BADGE_TIMEOUT' }), {
    status:0, auth:'', timedOut:true, transient:true,
  })
})

test('stable alert restore rolls back experimental thresholds and keeps refresh manual', () => {
  assert.match(stableAlertRestoreMigration, /count\(distinct error\.record_key\) >= 6/)
  assert.match(stableAlertRestoreMigration, /replace\([\s\S]{0,180}v_experimental_block[\s\S]{0,80}v_previous_block/)
  assert.match(stableAlertRestoreMigration, /cron\.unschedule\(jobid\)/)
  assert.doesNotMatch(stableAlertRestoreMigration, /cron\.schedule\(/)
  assert.match(stableAlertRestoreMigration, /admin_alert_center_page_v1/)
  assert.match(stableAlertRestoreMigration, /current_app_session_is_valid\('admin'\)/)
  assert.match(stableAlertRestoreMigration, /scope_private\.current_employee_scope_directory\(\)/)
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
  assert.match(alertCenterComponent, /\? 'Summary' : '预警摘要'\}<\/span><span>\{locale === 'en' \? 'Read status' : '阅读状态'\}<\/span><span>\{locale === 'en' \? 'Follow-up status' : '跟进状态'\}<\/span>/)
  assert.match(alertCenterComponent, /className="admin-alert-table-summary"[^>]*>\{copy\.message\}<\/span>/)
  assert.match(alertCenterComponent, /className="admin-alert-table-read">[\s\S]{0,180}admin-alert-read-state/)
})

test('only explicit expand controls toggle rows and employee IDs remain selectable', () => {
  assert.doesNotMatch(alertCenterComponent, /<button[^>]+className="admin-alert-table-row"/)
  assert.doesNotMatch(alertCenterComponent, /<button[^>]+className="employee-alert-history-row"/)
  assert.match(alertCenterComponent, /className="admin-alert-table-expand"[^>]+onClick=\{\(\) => toggleRow\(row\)\}/)
  assert.match(alertCenterComponent, /className="employee-alert-history-expand"[^>]+onClick=\{\(\) => toggleRow\(row\)\}/)
  assert.match(alertCenterStyles, /admin-alert-employee-id\{[^}]*user-select:text/)
  assert.match(alertCenterStyles, /grid-template-columns:78px 82px minmax\(96px,.72fr\)[^}]+minmax\(105px,.78fr\) 78px 62px/)
  assert.match(alertCenterStyles, /admin-alert-record-table\{[^}]*overflow-x:hidden/)
  assert.match(alertCenterStyles, /admin-alert-table-head>span:last-child\{text-align:center\}/)
  assert.match(alertCenterStyles, /admin-alert-table-expand\{[^}]*justify-content:center/)
  assert.doesNotMatch(alertCenterStyles, /min-width:1640px/)
})

test('follow-up state keeps reader, status and result independently addressable', () => {
  const pending = adminAlertFollowUpState({
    readers:[{ auth_user_id:'reader-1', account:'founder', read_at:'2026-08-27T08:00:00Z' }],
  }, 'zh')
  assert.equal(pending.label, '待跟进')
  assert.equal(pending.reader, 'founder')
  assert.equal(pending.result, '')
  assert.equal(pending.actor, '')
  assert.equal(pending.followUpAccount, '')

  const handled = adminAlertFollowUpState({
    readers:[{ auth_user_id:'reader-1', account:'founder', read_at:'2026-08-27T08:00:00Z' }],
    follow_up:{
      status:'handled', confirmed_by_name:'manager-a', confirmed_at:'2026-08-27T08:10:00Z',
      handled_by_name:'manager-b', handled_at:'2026-08-27T08:20:00Z', handling_note:'排班录入错误，已修正',
    },
  }, 'zh')
  assert.equal(handled.label, '已处理')
  assert.equal(handled.reader, 'founder')
  assert.equal(handled.actor, 'manager-b')
  assert.equal(handled.followUpAccount, 'manager-b')
  assert.equal(handled.note, '排班录入错误，已修正')
  assert.equal(handled.result, '排班录入错误，已修正')
})

test('warning table places team after name and separates read state from actual follow-up account', () => {
  assert.match(alertCenterComponent, /\? 'Name' : '姓名'\}<\/span><span>\{locale === 'en' \? 'Team' : '团队'\}<\/span>/)
  assert.match(alertCenterComponent, /className="admin-alert-table-team"[^>]*>\{row\.team_name \|\| '—'\}<\/span>/)
  assert.match(alertCenterComponent, /className="admin-alert-table-followup"[\s\S]{0,180}>\{workflow\.label\}<\/small><\/span>/)
  assert.match(alertCenterComponent, /className="admin-alert-table-result"[^>]*>[\s\S]{0,80}\{workflow\.result \|\| '—'\}<\/span>/)
  assert.match(alertCenterComponent, /\? 'Follow-up account' : '跟进账号'/)
  assert.match(alertCenterComponent, /className="admin-alert-table-followup-account"[^>]*>[\s\S]{0,100}\{workflow\.followUpAccount \|\| '—'\}<\/span>/)
  assert.doesNotMatch(alertCenterComponent, /className="admin-alert-table-followup-account"[^>]*>[\s\S]{0,180}workflow\.reader/)
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

test('team enrichment preserves the granular alert reader security boundary', () => {
  assert.match(teamColumnsMigration, /auth\.uid\(\) is null[\s\S]{0,80}not_authenticated/)
  assert.match(teamColumnsMigration, /current_app_session_is_valid\('admin'\)/)
  assert.match(teamColumnsMigration, /has_permission\('alert\.view'\)/)
  assert.match(teamColumnsMigration, /caller_can_view_alert_type\('payout_change'\)/)
  assert.match(teamColumnsMigration, /admin_alert_center_page_v1\([\s\S]{0,100}p_filters/)
  assert.match(teamColumnsMigration, /jsonb_array_elements\([\s\S]{0,120}v_result->'rows'/)
  assert.match(teamColumnsMigration, /left join public\.employees employee[\s\S]{0,160}left join public\.teams team/)
  assert.match(teamColumnsMigration, /'team_name',[\s\S]{0,180}team\.name[\s\S]{0,120}employee\.group_name/)
  assert.match(teamColumnsMigration, /order by item\.ordinality/)
  assert.match(teamColumnsMigration, /revoke all on function public\.admin_alert_center\(jsonb, integer, integer\)[\s\S]{0,120}from public, anon/)
  assert.match(teamColumnsMigration, /grant execute on function public\.admin_alert_center\(jsonb, integer, integer\)[\s\S]{0,100}to authenticated, service_role/)
  const alertReaderWrapper = teamColumnsMigration.slice(
    teamColumnsMigration.indexOf('create or replace function public.admin_alert_center'),
    teamColumnsMigration.indexOf('-- Keep the granular workflow implementation'),
  )
  assert.match(alertReaderWrapper, /admin_alert_center_page_v1\([\s\S]{0,100}p_filters/)
  assert.doesNotMatch(alertReaderWrapper, /from public\.admin_alert_events/)
  assert.match(followUpMigration, /public\.backend_employee_in_scope\(event\.employee_id\)/)
})

test('warning team enrichment follows the strict current roster after transfers', () => {
  assert.match(currentRosterTeamMigration, /scope_private\.current_employee_scope_directory\(\)/)
  assert.match(currentRosterTeamMigration, /directory\.employee_id::text/)
  assert.match(currentRosterTeamMigration, /team\.id = directory\.current_team_id/)
  assert.match(currentRosterTeamMigration, /replace\(v_definition, v_old_join, v_new_join\)/)
  assert.match(currentRosterTeamMigration, /position\('employee\.team_id' in v_definition\) > 0/)
  assert.match(currentRosterTeamMigration, /position\('employee\.group_name' in v_definition\) > 0/)
  assert.match(currentRosterTeamMigration, /admin_alert_team_enrichment_definition_changed/)
})

test('follow-up wrapper writes an atomic centralized operation log after scoped mutation', () => {
  assert.match(teamColumnsMigration, /create or replace function public\.admin_alert_update_follow_up\(/)
  assert.match(teamColumnsMigration, /current_app_session_is_valid\('admin'\)/)
  assert.match(teamColumnsMigration, /has_permission\('alert\.follow_up'\)/)
  assert.match(teamColumnsMigration, /v_result := public\.admin_alert_update_follow_up_page_v1\([\s\S]{0,900}insert into public\.audit_logs/)
  assert.match(teamColumnsMigration, /actor_user_id,employee_id,module,action,record_id/)
  assert.match(teamColumnsMigration, /'alerts'[\s\S]{0,120}'follow_up_confirm'[\s\S]{0,80}'follow_up_handle'/)
  assert.match(teamColumnsMigration, /'actor',v_actor_name[\s\S]{0,120}'result_summary',v_result_summary/)
  assert.match(teamColumnsMigration, /left\(coalesce\([\s\S]{0,180}handling_note[\s\S]{0,160}\),500\)/)
  const wrapper=teamColumnsMigration.slice(teamColumnsMigration.indexOf('create or replace function public.admin_alert_update_follow_up'))
  assert.doesNotMatch(wrapper,/exception\s+when/)
})

test('employee warning history keeps the existing session, type permission, and employee scope guards', () => {
  assert.match(employeeHistoryMigration, /current_app_session_is_valid\('admin'\)/)
  assert.match(employeeHistoryMigration, /caller_can_view_alert_type\(event\.alert_type\)/)
  assert.match(employeeHistoryMigration, /backend_employee_in_scope\(event\.employee_id\)/)
  assert.match(employeeHistoryMigration, /alert\.employee_id = v_employee_id/)
  assert.match(employeeHistoryMigration, /from public, anon;/)
  assert.match(employeeHistoryMigration, /to authenticated, service_role;/)
})
