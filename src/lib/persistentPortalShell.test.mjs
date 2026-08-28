import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const app = await readFile(new URL('../App.jsx', import.meta.url), 'utf8')
const topbar = await readFile(new URL('../components/AdminTopbar.jsx', import.meta.url), 'utf8')

test('admin and staff navigation retain one protected portal shell', () => {
  assert.match(app, /import \{ Navigate, Outlet, Route, Routes, useLocation \}/)
  assert.match(app, /function PortalShell\(\{ mode \}\)[\s\S]*<Protected mode=\{mode\}>[\s\S]*<AppLayout mode=\{mode\}><Outlet \/><\/AppLayout>/)
  assert.match(app, /<Route path="\/admin" element=\{<PortalShell mode="admin" \/>\}>[\s\S]*<Route path="employees" element=\{<AdminEmployeesPage \/>\}/)
  assert.match(app, /<Route path="\/staff" element=\{<PortalShell mode="staff" \/>\}>[\s\S]*<Route path="rewards" element=\{<StaffHome mode="rewards" \/>\}/)
  assert.doesNotMatch(app, /path="\/admin\/employees" element=\{<Protected/)
  assert.doesNotMatch(app, /path="\/staff\/rewards" element=\{<Protected/)
})

test('presence refreshes coalesce focus and visibility events', () => {
  assert.match(topbar, /const requestInFlight = useRef\(false\)/)
  assert.match(topbar, /if \(requestInFlight\.current\) return\s+requestInFlight\.current = true/)
  assert.match(topbar, /finally \{\s+requestInFlight\.current = false\s+\}/)
})
