import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  VISIBLE_DATA_REFRESH_MS,
  visibleDataRefreshDue,
} from './visibleDataRefresh.js'

test('background refresh runs only for a visible online idle page after two minutes', () => {
  const lastRefreshAt = 10_000
  const dueAt = lastRefreshAt + VISIBLE_DATA_REFRESH_MS
  const common = { lastRefreshAt, now:dueAt }

  assert.equal(visibleDataRefreshDue({ ...common, visibilityState:'hidden' }), false)
  assert.equal(visibleDataRefreshDue({ ...common, visibilityState:'visible', online:false }), false)
  assert.equal(visibleDataRefreshDue({ ...common, visibilityState:'visible', pending:true }), false)
  assert.equal(visibleDataRefreshDue({ ...common, visibilityState:'visible', enabled:false }), false)
  assert.equal(visibleDataRefreshDue({ ...common, visibilityState:'visible', now:dueAt - 1 }), false)
  assert.equal(visibleDataRefreshDue({ ...common, visibilityState:'visible' }), true)
})

test('shared hook coalesces visibility, focus, online and interval wakeups', async () => {
  const source = await readFile(new URL('./visibleDataRefresh.js', import.meta.url), 'utf8')
  assert.match(source, /Boolean\(valueOf\(config\.pending\)\) \|\| Boolean\(ownedFlight\)/)
  assert.match(source, /lastRefreshAt = Math\.max\(lastAttemptAtRef\.current, lastCompleted\)/)
  assert.match(source, /addEventListener\('visibilitychange', onVisible\)/)
  assert.match(source, /addEventListener\('focus', onFocus\)/)
  assert.match(source, /addEventListener\('online', onOnline\)/)
  assert.match(source, /setInterval\(\(\) => attempt\('interval'\)/)
})

test('key admin and staff pages use the same bounded refresh policy', async () => {
  const files = await Promise.all([
    '../pages/PortalPage.jsx',
    '../pages/AdminEmployeesPage.jsx',
    '../pages/AdminAttendancePage.jsx',
    '../pages/AdminReportsPage.jsx',
    '../pages/AdminReconciliationPage.jsx',
    '../pages/AdminTrainingPage.jsx',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')))

  for (const source of files) assert.match(source, /useVisibleDataRefresh/)
  const staff = files[0]
  assert.match(staff, /background:true/)
  assert.match(staff, /if \(!background\) \{[\s\S]*setLoading\(true\)/)
  assert.match(staff, /if \(staffHomeFlightRef\.current\) return staffHomeFlightRef\.current/)
})
