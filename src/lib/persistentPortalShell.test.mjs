import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const app = await readFile(new URL('../App.jsx', import.meta.url), 'utf8')
const main = await readFile(new URL('../main.jsx', import.meta.url), 'utf8')
const topbar = await readFile(new URL('../components/AdminTopbar.jsx', import.meta.url), 'utf8')

test('admin and staff navigation retain one protected portal shell', () => {
  assert.match(app, /import \{ Navigate, Outlet, Route, Routes, useLocation \}/)
  assert.match(app, /function PortalShell\(\{ mode \}\)[\s\S]*<Protected mode=\{mode\}>[\s\S]*<AppLayout mode=\{mode\}><Outlet \/><\/AppLayout>/)
  assert.match(app, /<Route path="\/workspace" element=\{<PortalShell mode="admin" \/>\}>[\s\S]*<Route path="employees" element=\{<AdminEmployeesPage \/>\}/)
  assert.match(app, /<Route path="\/portal" element=\{<PortalShell mode="staff" \/>\}>[\s\S]*<Route path="rewards" element=\{<StaffHome mode="rewards" \/>\}/)
  assert.doesNotMatch(app, /path="\/admin\/employees" element=\{<Protected/)
  assert.doesNotMatch(app, /path="\/staff\/rewards" element=\{<Protected/)
})

test('route pages are lazy while each portal shell remains mounted', () => {
  assert.match(app, /const lazyRoute = \(loader, exportName = 'default', \{ contentFallback = false \} = \{\}\)/)
  assert.match(app, /const AdminEmployeesPage = lazyAdminRoute\(\(\) => import\('\.\/pages\/AdminEmployeesPage'\)\)/)
  assert.match(app, /const StaffPayrollPage = lazyRoute\(\(\) => import\('\.\/pages\/StaffPayrollPage'\)\)/)
  assert.match(app, /const StaffHome = lazyRoute\(\(\) => import\('\.\/pages\/PortalPage'\), 'StaffHome'\)/)
  assert.doesNotMatch(app, /^import AdminEmployeesPage from/m)
  assert.doesNotMatch(app, /^import StaffPayrollPage from/m)
})

test('authenticated admin shell warms only lazy admin chunks without mounting pages', () => {
  assert.match(app, /LazyRoutePage\.preload = load/)
  assert.match(app, /const ADMIN_ROUTE_PAGES = \[[\s\S]*AdminEmployeesPage[\s\S]*AdminManualPage/)
  assert.match(app, /function AdminRouteChunkWarmup\(\)[\s\S]*await RoutePage\.preload\(\)/)
  assert.match(app, /function AdminRouteChunkWarmup\(\)[\s\S]*requestIdleCallback/)
  assert.match(app, /\{mode==='admin'&&<AdminRouteChunkWarmup\/>\}/)
  const adminPages = app.match(/const ADMIN_ROUTE_PAGES = \[([\s\S]*?)\]/)?.[1] || ''
  assert.doesNotMatch(adminPages, /Staff|Login|Mfa/)
  assert.doesNotMatch(app, /function AdminRouteChunkWarmup\(\)[\s\S]*<RoutePage/)
})

test('nested admin route fallback uses an in-content skeleton instead of a viewport loading screen', () => {
  assert.match(app, /function AdminRouteFallback\(\)[\s\S]*className="admin-route-loading"/)
  assert.match(app, /const lazyAdminRoute = [^\n]+contentFallback:true/)
  assert.doesNotMatch(app, /lazyAdminRoute[\s\S]{0,160}center-screen/)
})

test('admin-only legacy enhancers never load for staff paths', () => {
  assert.match(main, /import \{ APP_ROUTER_BASENAME, shouldLoadAdminEnhancers \} from '\.\/lib\/appBasePath'/)
  assert.match(main, /shouldLoadAdminEnhancers\(window\.location\.pathname\)/)
  assert.match(main, /if \(configured && isAdminRuntime\) \{[\s\S]+import\('\.\/uiV2714Enhancer'\)/)
})

test('presence refreshes coalesce focus and visibility events', () => {
  assert.match(topbar, /const countFlightRef = useRef\(null\)/)
  assert.match(topbar, /const currentFlight = countFlightRef\.current[\s\S]{0,80}return currentFlight\.promise/)
  assert.match(topbar, /if \(countFlightRef\.current === entry\) countFlightRef\.current = null/)
  assert.match(topbar, /presenceJitter\(PRESENCE_INITIAL_JITTER_MS\)/)
})
