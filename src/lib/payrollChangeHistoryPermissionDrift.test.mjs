import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const sql = fs.readFileSync(
  new URL('../../supabase/migrations/20260830111500_repair_payout_change_history_permission_drift.sql', import.meta.url),
  'utf8',
)

test('payment change history reader is repaired to the page-specific permissions', () => {
  assert.match(sql, /admin_payout_change_requests\(text,text,integer,integer\)/i)
  assert.match(sql, /payroll\.change_history\.view/i)
  assert.match(sql, /payroll\.change_history\.review/i)
  assert.match(sql, /pg_get_functiondef/i)
})

test('permission repair preserves the existing reader body instead of replacing its query', () => {
  assert.match(sql, /execute\s+replace/i)
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+function\s+public\.admin_payout_change_requests/i)
})
