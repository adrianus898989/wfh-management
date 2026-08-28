import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL(
  '../../supabase/migrations/20260828103000_optimize_bounded_attendance_reads.sql',
  import.meta.url,
), 'utf8')

test('shared security-barrier view stays intact while both slow callers are patched', () => {
  assert.match(migration, /security_invoker=true/)
  assert.match(migration, /security_barrier=true/)
  assert.doesNotMatch(migration, /create or replace view attendance_private\.attendance_enriched_records/)
  assert.match(migration, /attendance_private\.admin_attendance_monthly\(jsonb\)/)
  assert.match(migration, /attendance_private\.staff_attendance_home\(text\)/)
  assert.equal((migration.match(/v_old text := 'from attendance_private\.attendance_enriched_records x'/g) || []).length, 2)
  assert.equal((migration.match(/attendance_private\.enrich_attendance_record_ids\(/g) || []).length >= 8, true)
})

test('admin candidate set is bounded to selected month plus prior resignation history', () => {
  assert.match(migration, /candidate\.event_date < v_month_end/)
  assert.match(migration, /candidate\.event_date >= v_month_start/)
  assert.match(migration, /candidate\.kind = 'resignation'/)
  assert.match(migration, /lower\(coalesce\(candidate\.event_kind, ''\)\) = 'resignation'/)
  assert.match(migration, /public\.backend_employee_in_scope\(x\.employee_id\)/)
  assert.match(migration, /public\.backend_employee_in_scope\(e\.id\)/)
  assert.match(migration, /authorized_employee_scope as materialized/)
  assert.match(migration, /authorized\.employee_id = x\.employee_id/)
  assert.match(migration, /authorized\.employee_id = e\.id/)
  assert.match(migration, /effective\.auth_user_id = v_user_id/)
  assert.match(migration, /v_access_scope in \('own_team', 'assigned_teams'\)/)
  assert.match(migration, /attendance\.monthly\.view/)
})

test('staff candidate set remains self-only across employee number and name history', () => {
  assert.match(migration, /candidate\.employee_id = v_employee_id/)
  assert.match(migration, /identity_event\.employee_id = v_employee_id/)
  assert.match(migration, /upper\(pg_catalog\.btrim\(identity_event\.employee_no\)\)/)
  assert.match(migration, /target_employee_numbers as materialized/)
  assert.match(migration, /target_unique_names as materialized/)
  assert.match(migration, /candidate_ids as \(/)
  assert.match(migration, /historical_employee_aliases identity_alias/)
  assert.match(migration, /target_number\.employee_no_key = identity_alias\.employee_no_key/)
  assert.match(migration, /identity_alias\.identity_count = 1/)
  assert.match(migration, /candidate\.match_status = 'unmatched'/)
  assert.match(migration, /candidate\.employee_id is null/)
  assert.match(migration, /public\.employee_lifecycle_events direct_identity/)
  assert.match(migration, /and not exists \([\s\S]*public\.employee_lifecycle_events direct_identity/)
  assert.match(migration, /select candidate\.id from candidate_ids candidate/)
  assert.match(migration, /x\.employee_id = v_employee_id/)
  assert.match(migration, /ua\.employee_portal_enabled = true/)
  assert.match(migration, /current_app_session_is_valid\(''staff''\)/)
})

test('historical enrichment is indexed, lateral, memoizable and inaccessible to app roles', () => {
  assert.match(migration, /left join lateral \([\s\S]*historical_employee_directory/)
  assert.match(migration, /left join lateral \([\s\S]*historical_employee_aliases/)
  assert.match(migration, /history\.employee_no_key = pg_catalog\.upper/)
  assert.match(migration, /alias\.name_key = public\.exam_norm/)
  assert.match(migration, /limit 1/)
  assert.doesNotMatch(migration, /source\.source_key,\s*source\.source_key/)
  assert.doesNotMatch(migration, /attendance_candidate_set_too_large|cardinality\(p_record_ids\) >/)
  assert.match(migration, /revoke all on function attendance_private\.enrich_attendance_record_ids\(uuid\[\]\)[\s\S]*from public, anon, authenticated, service_role/)
  assert.match(migration, /has_function_privilege\([\s\S]*'authenticated'/)
  assert.match(migration, /has_function_privilege\([\s\S]*'service_role'/)
})

test('migration preserves external protocol and cannot mutate cron or alert jobs', () => {
  assert.doesNotMatch(migration, /create or replace function public\.(?:admin_attendance_monthly|staff_attendance_home)/)
  assert.doesNotMatch(migration, /cron\.(?:schedule|unschedule|alter_job)/)
  assert.doesNotMatch(migration, /jobid|jobname|job17|job19|job20/)
  assert.match(migration, /set local lock_timeout = '500ms'/)
  assert.match(migration, /begin;[\s\S]*commit;/)
})
