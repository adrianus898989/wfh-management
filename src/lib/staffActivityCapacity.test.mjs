import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const portal = await readFile(new URL('../pages/PortalPage.jsx', import.meta.url), 'utf8')
const migration = await readFile(new URL('../../supabase/migrations/20260830170500_staff_activity_optional_attendance.sql', import.meta.url), 'utf8')

test('staff home explicitly omits duplicate activity attendance work', () => {
  assert.match(portal, /staff_activity_home', \{ p_include_attendance:false \}/)
  assert.match(portal, /\['PGRST202', '42883'\]\.includes\(code\)/)
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
