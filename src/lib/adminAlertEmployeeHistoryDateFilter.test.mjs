import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const component=fs.readFileSync(new URL('../components/AdminAlertCenter.jsx',import.meta.url),'utf8')
const migration=fs.readFileSync(new URL('../../supabase/migrations/20260830162000_admin_alert_history_date_window.sql',import.meta.url),'utf8')

test('employee warning history sends date filters to the scoped server page',()=>{
  assert.match(component,/loadAlertPage\(\{[\s\S]{0,260}date_from:clean\(nextFilters\.date_from\)[\s\S]{0,120}date_to:clean\(nextFilters\.date_to\)/)
})

test('alert history date filtering uses overlapping warning windows before pagination',()=>{
  assert.match(migration,/v_date_from date :=[\s\S]+v_date_to date :=/)
  assert.match(migration,/coalesce\(alert\.window_end, alert\.last_seen_at::date, alert\.first_seen_at::date\) >= v_date_from/)
  assert.match(migration,/coalesce\(alert\.window_start, alert\.first_seen_at::date, alert\.last_seen_at::date\) <= v_date_to/)
  assert.match(migration,/alert\.window_start::text[\s\S]+alert\.last_seen_at::date::text/)
  assert.match(migration,/revoke all on function alerts_private\.admin_alert_center_page_fast[\s\S]+authenticated, service_role/)
})
