import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isMissingRpcSignature } from './rpcCompatibility.js'

const portal = await readFile(new URL('../pages/PortalPage.jsx', import.meta.url), 'utf8')
const migration = await readFile(new URL('../../supabase/migrations/20260830170500_staff_activity_optional_attendance.sql', import.meta.url), 'utf8')
const progressiveMigration = await readFile(new URL('../../supabase/migrations/20260905192000_staff_home_progressive_loading.sql', import.meta.url), 'utf8')
const rpcCompatibility = await readFile(new URL('./rpcCompatibility.js', import.meta.url), 'utf8')

test('staff home explicitly omits duplicate activity attendance work', () => {
  assert.match(portal, /staff_activity_home', \{ p_include_attendance:false \}/)
  assert.match(rpcCompatibility, /\['PGRST202', '42883'\]\.includes\(code\)/)
  assert.match(portal, /permission\/session failures must remain failures/)
})

test('the compact overload keeps current-session enforcement and bounded connectivity rows', () => {
  assert.match(migration, /create or replace function public\.staff_activity_home\(\s*p_include_attendance boolean/)
  assert.match(migration, /set local lock_timeout = '1s'/)
  assert.match(migration, /current_app_session_is_valid\('staff'\)/)
  assert.match(migration, /if coalesce\(p_include_attendance, true\) then[\s\S]+staff_activity_home\(\)/)
  assert.match(migration, /where incident\.employee_id = v_employee_id[\s\S]+limit 120/)
  assert.doesNotMatch(migration, /online_training_report_members/)
  assert.match(migration, /revoke all on function employee_ops_private\.staff_activity_home\(boolean\)[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.staff_activity_home\(boolean\) to authenticated/)
})

test('staff home commits profile, activity and attendance responses independently', () => {
  assert.match(portal, /const staffPortalFlightRef = useRef\(null\)/)
  assert.match(portal, /const staffActivityFlightRef = useRef\(null\)/)
  assert.match(portal, /const staffAttendanceFlightRef = useRef\(null\)/)
  assert.match(portal, /await compactStaffPortalHome\(includeExamHistory\)[\s\S]+setData\(result\)/)
  assert.match(portal, /await compactStaffActivitySummary\(\)[\s\S]+setActivity\(/)
  assert.match(portal, /await compactStaffAttendanceSummary\(month\)[\s\S]+setSelfAttendance\(/)
  assert.doesNotMatch(portal, /const \[\s*\{ data:result, error:loadError \},[\s\S]+await Promise\.all/)
  assert.match(portal, /if \(loading && !data\) return/)
})

test('initial staff login defers dashboard summaries until the compact profile settles', () => {
  assert.match(portal, /const loadInitial = async \(\) => \{[\s\S]+const portalRequest = loadPortal/)
  assert.match(portal, /const portalResponse = await portalRequest[\s\S]+activityDetailRequest \|\| loadActivity\(\{ background:true \}\)/)
  assert.match(portal, /const portalResponse = await portalRequest[\s\S]+attendanceDetailRequest \|\| loadAttendance\(\{ background:true \}\)/)
  assert.match(portal, /const activityDetailRequest = directActivity \? loadActivity\(\{ includeDetail:true \}\) : null/)
  assert.match(portal, /const attendanceDetailRequest = directAttendance \? loadAttendance\(\{ includeDetail:true \}\) : null/)
  assert.match(portal, /staffHomeMountedRef\.current=true\s+void loadInitial\(\)/)
  assert.doesNotMatch(portal, /staffHomeMountedRef\.current=true\s+void load\(\)/)
})

test('dashboard reads summaries and detail tabs opt in to complete payloads', () => {
  assert.match(portal, /supabase\.rpc\('staff_portal_home', \{ p_include_exam_history:includeExamHistory \}\)/)
  assert.match(portal, /supabase\.rpc\('staff_activity_summary'\)/)
  assert.match(portal, /supabase\.rpc\('staff_attendance_summary', \{ p_month:month \}\)/)
  assert.match(portal, /includeExamHistory:activeSection === 'exams'/)
  assert.match(portal, /includeDetail:activeSection === 'connectivity'/)
  assert.match(portal, /includeDetail:activeSection === 'attendance'/)
  assert.match(portal, /data\?\.payload_scope\?\.exam_history/)
  assert.match(portal, /activity\.data\?\.detail_level === 'full'/)
  assert.match(portal, /selfAttendance\.data\?\.detail_level === 'full'/)
  assert.match(portal, /activeSection !== 'exams' \|\| loading \|\| !data \|\| data\?\.payload_scope\?\.exam_history/)
  assert.doesNotMatch(portal, /activeSection !== 'exams' \|\| loading \|\| error/)
})

test('rolling deploy fallback accepts only a missing target RPC signature', () => {
  assert.equal(isMissingRpcSignature({
    code:'PGRST202',
    message:'Could not find the function public.staff_activity_summary in the schema cache',
  }, 'staff_activity_summary'), true)
  assert.equal(isMissingRpcSignature({
    code:'42883',
    message:'function public.staff_attendance_summary(text) does not exist',
  }, 'staff_attendance_summary'), true)
  assert.equal(isMissingRpcSignature({
    code:'42501',
    message:'permission denied for function staff_activity_summary',
  }, 'staff_activity_summary'), false)
  assert.equal(isMissingRpcSignature({
    code:'P0001',
    message:'session_not_current',
  }, 'staff_activity_summary'), false)
  assert.equal(isMissingRpcSignature({
    code:'42883',
    message:'function attendance_private.internal_dependency() does not exist',
  }, 'staff_activity_summary'), false)
})

test('detail selection during a summary flight queues a full read instead of being swallowed', () => {
  assert.match(portal, /staffPortalHistoryFlightRef\.current[\s\S]+staffPortalFlightRef\.current\.then\(response =>/)
  assert.match(portal, /staffActivityDetailFlightRef\.current[\s\S]+staffActivityFlightRef\.current\.then\(response =>/)
  assert.match(portal, /staffAttendanceDetailFlightRef\.current[\s\S]+staffAttendanceFlightRef\.current\.then\(response =>/)
  assert.match(portal, /response\?\.data\?\.payload_scope\?\.exam_history/)
  assert.match(portal, /response\?\.data\?\.detail_level === 'full'/)
})

test('progressive staff RPCs retain current-session self scope and omit unused detail reads', () => {
  assert.match(progressiveMigration, /public\.staff_portal_home\(p_include_exam_history boolean\)/)
  assert.match(progressiveMigration, /'recent_errors', '\[\]'::jsonb/)
  assert.match(progressiveMigration, /attendance_private\.staff_recent_error_rows\(c\.employee_no\)/)
  assert.match(progressiveMigration, /from public\.report_employee_errors_v/)
  assert.match(progressiveMigration, /public\.online_training_identity_key\(/)
  assert.match(progressiveMigration, /case when coalesce\(p_include_exam_history, false\) then/)
  assert.match(progressiveMigration, /create or replace function public\.staff_activity_summary\(\)/)
  assert.match(progressiveMigration, /'rows', '\[\]'::jsonb/)
  assert.doesNotMatch(progressiveMigration, /recent_connectivity as materialized/)
  assert.match(progressiveMigration, /create or replace function public\.staff_attendance_summary\([\s\S]+p_month text default null/)
  assert.match(progressiveMigration, /session_private\.current_app_session_is_valid\('staff'\)/)
  assert.match(progressiveMigration, /access\.auth_user_id = v_user_id/)
  assert.match(progressiveMigration, /candidate\.event_date >= v_month_start/)
  assert.match(progressiveMigration, /candidate\.event_date < v_month_end/)
  assert.equal((progressiveMigration.match(/candidate\.raw_values->>'sync_presence' is distinct from 'protected_missing'/g) || []).length, 3)
  assert.match(progressiveMigration, /attendance_private\.enrich_attendance_record_ids/)
  assert.match(progressiveMigration, /attendance_private\.historical_employee_aliases_cache identity_alias/)
  assert.doesNotMatch(progressiveMigration, /attendance_private\.historical_employee_aliases identity_alias/)
  assert.match(progressiveMigration, /enriched\.employee_id = v_employee_id[\s\S]+enriched\.employee_id is null/)
  assert.doesNotMatch(progressiveMigration, /staff_(?:activity|attendance)_summary\([^)]*employee/)
  assert.match(progressiveMigration, /progressive_staff_home_security_verification_failed/)
  assert.equal((progressiveMigration.match(/procedure\.proconfig @> array\['search_path=""'\]::text\[\]/g) || []).length, 3)
})
