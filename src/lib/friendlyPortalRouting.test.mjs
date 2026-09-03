import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('router exposes only friendly portal pages and one-hop legacy replacements', async () => {
  const app = await read('src/App.jsx')

  assert.match(app, /<Route path="\/workspace\/login"/)
  assert.match(app, /<Route path="\/portal\/login"/)
  assert.match(app, /<Route path="\/portal\/register"/)
  assert.match(app, /<Route path="\/workspace\/mfa"/)
  assert.match(app, /<Route path="\/admin\/\*" element=\{<LegacyPortalRedirect \/>\}/)
  assert.match(app, /<Route path="\/staff\/\*" element=\{<LegacyPortalRedirect \/>\}/)
  assert.match(app, /publicPortalTarget\(`\$\{location\.pathname\}\$\{location\.search\}\$\{location\.hash\}`\)/)
  assert.match(app, /<Navigate[\s\S]{0,180}replace/)
})

test('unknown child routes never cross the fixed Supabase portal storage boundary', async () => {
  const app = await read('src/App.jsx')
  const adminShell = app.slice(
    app.indexOf('<Route path="/workspace"'),
    app.indexOf('<Route path="/portal"'),
  )
  const staffShell = app.slice(
    app.indexOf('<Route path="/portal"'),
    app.indexOf('<Route path="*" element={<Navigate', app.indexOf('<Route path="/portal"')) + 90,
  )

  assert.match(adminShell, /<Route path="\*" element=\{<Navigate to=\{publicPortalTarget\('admin'\)\} replace \/>\} \/>/)
  assert.doesNotMatch(adminShell, /publicPortalTarget\('staff'/)
  assert.match(staffShell, /<Route path="\*" element=\{<Navigate to=\{publicPortalTarget\('staff'\)\} replace \/>\} \/>/)
  assert.doesNotMatch(staffShell, /publicPortalTarget\('admin'/)
})

test('startup session namespace is selected centrally before Supabase client creation', async () => {
  const supabase = await read('src/lib/supabase.js')

  assert.match(supabase, /portalModeFromBrowserPath\(browserPath,import\.meta\.env\.BASE_URL\|\|'\/'\)\|\|'staff'/)
  assert.match(supabase, /const AUTH_STORAGE_KEY=portalAuthStorageKey\(portal\)/)
  assert.match(supabase, /storageKey:AUTH_STORAGE_KEY/)
  assert.match(supabase, /body:\{action,portal:normalizedPortal\}/)
  assert.doesNotMatch(supabase, /p_portal:requestedPortal==='workspace'/)
  assert.doesNotMatch(supabase, /portal:normalizedPortal==='workspace'/)
})

test('login, MFA, logout and system-update redirects use friendly paths', async () => {
  const [app, adminLogin, staffLogin, layout, mfa] = await Promise.all([
    read('src/App.jsx'),
    read('src/pages/AdminLoginPage.jsx'),
    read('src/pages/StaffLoginPage.jsx'),
    read('src/components/AppLayout.jsx'),
    read('src/pages/MfaPage.jsx'),
  ])

  assert.match(adminLogin, /appPathname\(publicPortalTarget\('admin','mfa'\)\)/)
  assert.match(adminLogin, /appPathname\(publicPortalTarget\('admin'\)\)/)
  assert.match(staffLogin, /navigate\(publicPortalTarget\('staff'\), \{ replace: true \}\)/)
  assert.match(layout, /navigate\(publicPortalTarget\(mode,'login'\)\)/)
  assert.match(mfa, /navigate\(publicPortalTarget\('admin'\), \{ replace: true \}\)/)
  assert.match(app, /window\.location\.replace\(appPathname\(publicPortalTarget\(portal, 'login'\)\)\)/)
})

test('path-sensitive admin compatibility layers normalize friendly paths with the host base', async () => {
  const sources = await Promise.all([
    read('src/main.jsx'),
    read('src/adminUiV2717Fix.js'),
    read('src/adminFinalV2722.js'),
    read('src/reportErrorsStableV2721.js'),
    read('src/lib/adminI18n.jsx'),
  ])

  assert.match(sources[0], /portalModeFromBrowserPath\(window\.location\.pathname\) === 'admin'/)
  for (const source of sources.slice(1, 4)) assert.match(source, /appPathFromBrowserPath/)
  assert.match(sources[4], /portalModeFromBrowserPath\(window\.location\.pathname\) === 'admin'/)
})
