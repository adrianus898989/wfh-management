import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const app = await readFile(new URL('../App.jsx', import.meta.url), 'utf8')
const main = await readFile(new URL('../main.jsx', import.meta.url), 'utf8')
const topbar = await readFile(new URL('../components/AdminTopbar.jsx', import.meta.url), 'utf8')

test('admin and staff navigation retain one protected portal shell', () => {
  assert.match(app, /import \{ Navigate, Outlet, Route, Routes, useLocation \}/)
  assert.match(app, /function PortalShell\(\{ mode \}\)[\s\S]*<Protected mode=\{mode\}>[\s\S]*<AppLayout mode=\{mode\}><Outlet \/><\/AppLayout>/)
  assert.match(app, /<Route path="\/admin" element=\{<PortalShell mode="admin" \/>\}>[\s\S]*<Route path="employees" element=\{<AdminEmployeesPage \/>\}/)
  assert.match(app, /<Route path="\/staff" element=\{<PortalShell mode="staff" \/>\}>[\s\S]*<Route path="rewards" element=\{<StaffHome mode="rewards" \/>\}/)
  assert.doesNotMatch(app, /path="\/admin\/employees" element=\{<Protected/)
  assert.doesNotMatch(app, /path="\/staff\/rewards" element=\{<Protected/)
})

test('route pages are lazy while each portal shell remains mounted', () => {
  assert.match(app, /const lazyRoute = \(loader, exportName = 'default'\)/)
  assert.match(app, /const AdminEmployeesPage = lazyRoute\(\(\) => import\('\.\/pages\/AdminEmployeesPage'\)\)/)
  assert.match(app, /const StaffPayrollPage = lazyRoute\(\(\) => import\('\.\/pages\/StaffPayrollPage'\)\)/)
  assert.match(app, /const StaffHome = lazyRoute\(\(\) => import\('\.\/pages\/PortalPage'\), 'StaffHome'\)/)
  assert.doesNotMatch(app, /^import AdminEmployeesPage from/m)
  assert.doesNotMatch(app, /^import StaffPayrollPage from/m)
})

test('admin-only legacy enhancers never load for staff paths', () => {
  assert.match(main, /const isAdminRuntime = runtimeAppPath === '\/admin' \|\| runtimeAppPath\.startsWith\('\/admin\/'\)/)
  assert.match(main, /if \(configured && isAdminRuntime\) \{[\s\S]+import\('\.\/uiV2714Enhancer'\)/)
})

test('presence refreshes coalesce focus and visibility events', () => {
  assert.match(topbar, /const countFlightRef = useRef\(null\)/)
  assert.match(topbar, /const currentFlight = countFlightRef\.current[\s\S]{0,80}return currentFlight\.promise/)
  assert.match(topbar, /if \(countFlightRef\.current === entry\) countFlightRef\.current = null/)
  assert.match(topbar, /presenceJitter\(PRESENCE_INITIAL_JITTER_MS\)/)
})
