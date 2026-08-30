import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl=new URL('../../supabase/migrations/20260830143000_attendance_history_identity_cache.sql',import.meta.url)

test('attendance cache swap rewrites FROM targets and expanded source qualifiers',async()=>{
  const migration=await readFile(migrationUrl,'utf8')
  const installStart=migration.indexOf('do $install_attendance_history_cache$')
  const installEnd=migration.indexOf('$install_attendance_history_cache$;',installStart)
  const install=migration.slice(installStart,installEnd)
  const viewPatch=install.slice(0,install.indexOf("execute 'create or replace view"))
  const helperPatch=install.slice(install.indexOf("v_patched := pg_catalog.replace",viewPatch.length))

  assert.match(viewPatch,/'attendance_private\.historical_employee_directory_cache'/)
  assert.match(viewPatch,/'attendance_private\.historical_employee_aliases_cache'/)
  assert.match(viewPatch,/'historical_employee_directory\.'/)
  assert.match(viewPatch,/'historical_employee_directory_cache\.'/)
  assert.match(viewPatch,/'historical_employee_aliases\.'/)
  assert.match(viewPatch,/'historical_employee_aliases_cache\.'/)
  assert.match(helperPatch,/'attendance_private\.historical_employee_directory_cache'/)
  assert.match(helperPatch,/'attendance_private\.historical_employee_aliases_cache'/)
  assert.match(helperPatch,/'historical_employee_directory_cache\.'/)
  assert.match(helperPatch,/'historical_employee_aliases_cache\.'/)
})
