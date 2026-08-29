import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  adminAlertAttendanceDetails,
  adminAlertMonthlyLeaveRule,
} from './adminAlertDetails.js'

const migration = readFileSync(new URL(
  '../../supabase/migrations/20260829153000_split_monthly_leave_threshold_by_source.sql',
  import.meta.url,
), 'utf8')
const boundedRefreshMigration = readFileSync(new URL(
  '../../supabase/migrations/20260827231500_admin_alert_bounded_refresh_groups.sql',
  import.meta.url,
), 'utf8')
const alertCenter = readFileSync(new URL(
  '../components/AdminAlertCenter.jsx',
  import.meta.url,
), 'utf8')

test('monthly-leave migration patches one reviewed block and preserves bounded refresh guards', () => {
  const oldBlock = migration.match(/\$old_monthly_leave\$\n([\s\S]*?)\$old_monthly_leave\$;/)?.[1]
  assert.ok(oldBlock, 'reviewed old monthly-leave block is missing')
  assert.equal(boundedRefreshMigration.includes(oldBlock), true)
  assert.match(migration, /'alerts_private\.refresh_alert_group\(text\)'::regprocedure/)
  assert.match(migration, /pg_get_functiondef\(v_signature\)/)
  assert.match(migration, /v_old_hits <> 1 or v_new_hits <> 0/)
  assert.match(migration, /v_old_hits <> 0[\s\S]{0,80}v_new_hits <> 1/)
  assert.match(migration, /statement_timeout=6s/)
  assert.match(migration, /lock_timeout=500ms/)
  assert.match(migration, /pg_try_advisory_xact_lock/)
  assert.match(migration, /hashtextextended\(''alerts_private\.refresh_alerts'', 0\)/)
  assert.match(migration, /alerts_private\.enrich_attendance_alert_details\(\)/)
  assert.match(migration, /where v_group <> ''access_exam''/)
  assert.match(migration, /having count\(distinct error\.record_key\) >= 6/)
  assert.doesNotMatch(migration, /cron\.(?:schedule|alter_job|unschedule)/)
})

test('monthly-leave routing is source-first, type-exact, half-day aware, and country independent', () => {
  assert.match(migration, /join public\.attendance_sheet_sources source on source\.id = record\.source_id/)
  assert.match(migration, /evidence\.source_group_min = 'onsite_to_home'/)
  assert.match(migration, /evidence\.source_group_min = 'home'/)
  assert.match(migration, /= '现场转居家'/)
  assert.match(migration, /'纯居家菲律宾', '纯居家（越南\/缅甸\/印尼等）'/)
  assert.match(migration, /where classified\.occurrence_count > classified\.allowed_days/)
  assert.match(migration, /day\.event_kind = 'half_day' then 0\.5 else 1/)
  assert.match(migration, /'home_leave_excluded', true/)
  assert.match(migration, /then 2[\s\S]{0,420}then 4[\s\S]{0,80}else 5/)
  assert.match(migration, /'classification_quality', qualified\.classification_quality/)
  assert.match(migration, /'classification_issue', qualified\.classification_issue/)
  assert.match(migration, /'classification_source', 'attendance_sheet_sources\.source_group\+employees\.employment_type'/)
  assert.match(migration, /case when qualified\.occurrence_count >= 8 then 'critical'/)
  assert.doesNotMatch(migration, /employee\.country|qualified\.country|record\.country/)
})

test('monthly-leave payload exposes the routed limits and conservative fallback', () => {
  const onsite = adminAlertMonthlyLeaveRule({
    alert_type:'monthly_leave',
    payload:{
      allowed_days:2,
      trigger_at:3,
      work_mode:'onsite_to_home',
      source_group:'onsite_to_home',
      classification_quality:'verified',
    },
  }, 'zh')
  assert.equal(onsite.allowedDays, 2)
  assert.equal(onsite.triggerAt, 3)
  assert.match(onsite.limitLabel, /现场转居家.*超过 2 天/)
  assert.equal(onsite.qualityLabel, '')

  const home = adminAlertMonthlyLeaveRule({
    alert_type:'monthly_leave',
    payload:{ allowed_days:4, trigger_at:5, work_mode:'home', source_group:'home' },
  }, 'en')
  assert.equal(home.allowedDays, 4)
  assert.equal(home.triggerAt, 5)
  assert.match(home.limitLabel, /Pure-home: warn above 4/)

  const fallback = adminAlertMonthlyLeaveRule({
    alert_type:'monthly_leave',
    payload:{
      allowed_days:5,
      trigger_at:6,
      work_mode:'legacy_fallback',
      source_group:'mixed',
      classification_quality:'fallback',
      classification_issue:'mixed_source_group',
    },
  }, 'zh')
  assert.equal(fallback.allowedDays, 5)
  assert.equal(fallback.sourceGroup, 'mixed')
  assert.equal(fallback.classificationIssue, 'mixed_source_group')
  assert.match(fallback.qualityLabel, /保守沿用旧上限/)
})

test('legacy payloads stay readable while current alert copy uses payload limits', () => {
  const legacy = adminAlertAttendanceDetails({
    alert_type:'monthly_leave',
    payload:{ threshold:5, home_leave_excluded:true },
  }, 'zh')
  assert.equal(legacy.monthlyRule.allowedDays, 5)
  assert.match(legacy.limitLabel, /超过 5 天/)

  assert.match(alertCenter, /adminAlertMonthlyLeaveRule\(row, locale\)/)
  assert.match(alertCenter, /countText\(rule\.allowedDays\)/)
  assert.match(alertCenter, /现场转居家超过 2 天、纯居家超过 4 天预警/)
  assert.doesNotMatch(alertCenter, /本月休假超过 5 天；半天按 0\.5 天/)
})
