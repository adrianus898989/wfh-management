import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APP_BASE_URL,
  APP_PORTAL_MODE,
  APP_ROUTER_BASENAME,
  appPortalModeAllowed,
  appPathFromBrowserPath,
  appPathnameForBase,
  defaultAppPortalMode,
  effectiveAppPortalMode,
  effectivePortalModeFromAppPath,
  effectivePortalModeFromBrowserPath,
  internalPortalPath,
  normalizeAppBaseUrl,
  normalizeAppPortalMode,
  portalAuthStorageKey,
  portalModeFromAppPath,
  portalModeFromBrowserPath,
  publicPortalTarget,
  shouldLoadAdminEnhancers,
} from './appBasePath.js'

test('app base normalization is stable for root and GitHub Pages paths', () => {
  assert.equal(normalizeAppBaseUrl('/'), '/')
  assert.equal(normalizeAppBaseUrl('/wfh-management/'), '/wfh-management/')
  assert.equal(normalizeAppBaseUrl('wfh-management'), '/wfh-management/')
  assert.equal(normalizeAppBaseUrl('//wfh-management///'), '/wfh-management/')
})

test('split-host portal mode is strict and defaults to the combined fallback build', () => {
  assert.equal(normalizeAppPortalMode('admin'), 'admin')
  assert.equal(normalizeAppPortalMode(' STAFF '), 'staff')
  assert.equal(normalizeAppPortalMode('unexpected'), 'both')
  assert.equal(APP_PORTAL_MODE, 'both')
  assert.equal(defaultAppPortalMode(), 'staff')
  assert.equal(appPortalModeAllowed('admin'), true)
  assert.equal(appPortalModeAllowed('staff'), true)
  assert.equal(appPortalModeAllowed('unexpected'), false)
})

test('split-host builds force cross-portal and unknown paths into their own namespace', () => {
  for (const path of ['/portal/login', '/staff/exams', '/', '/unknown']) {
    assert.equal(effectivePortalModeFromAppPath(path, 'admin'), 'admin', path)
  }
  for (const path of ['/workspace/login', '/admin/users', '/', '/unknown']) {
    assert.equal(effectivePortalModeFromAppPath(path, 'staff'), 'staff', path)
  }

  assert.equal(effectiveAppPortalMode('staff', 'admin'), 'admin')
  assert.equal(effectiveAppPortalMode('admin', 'staff'), 'staff')
  assert.equal(effectiveAppPortalMode('admin', 'both'), 'admin')
  assert.equal(effectiveAppPortalMode('staff', 'both'), 'staff')
  assert.equal(
    portalAuthStorageKey(effectivePortalModeFromBrowserPath('/portal/login', '/', 'admin')),
    'wfh-admin-auth-token',
  )
  assert.equal(
    portalAuthStorageKey(effectivePortalModeFromBrowserPath('/workspace/login', '/', 'staff')),
    'wfh-staff-auth-token',
  )
  assert.equal(
    effectivePortalModeFromBrowserPath('/wfh-management/admin', '/wfh-management/', 'staff'),
    'staff',
  )
  assert.equal(shouldLoadAdminEnhancers('/workspace/login', '/', 'staff'), false)
  assert.equal(shouldLoadAdminEnhancers('/admin/users', '/', 'staff'), false)
  assert.equal(shouldLoadAdminEnhancers('/portal/login', '/', 'admin'), true)
  assert.equal(shouldLoadAdminEnhancers('/', '/', 'admin'), true)
  assert.equal(shouldLoadAdminEnhancers('/workspace/login', '/', 'both'), true)
  assert.equal(shouldLoadAdminEnhancers('/portal/login', '/', 'both'), false)
})

test('friendly and legacy portal prefixes map to strict internal modes at exact boundaries', () => {
  for (const path of ['/workspace','/workspace/login','/admin','/admin/mfa']) {
    assert.equal(portalModeFromAppPath(path), 'admin', path)
  }
  for (const path of ['/portal','/portal/register','/staff','/staff/exams']) {
    assert.equal(portalModeFromAppPath(path), 'staff', path)
  }
  for (const path of ['/workspace-x','/portal-old','/administrator','/staffing','/']) {
    assert.equal(portalModeFromAppPath(path), null, path)
  }
})

test('host base removal keeps GitHub Pages and root-host portal classification equivalent', () => {
  assert.equal(appPathFromBrowserPath('/wfh-management/workspace/mfa', '/wfh-management/'), '/workspace/mfa')
  assert.equal(portalModeFromBrowserPath('/wfh-management/workspace/mfa', '/wfh-management/'), 'admin')
  assert.equal(portalModeFromBrowserPath('/wfh-management/portal/login', '/wfh-management/'), 'staff')
  assert.equal(portalModeFromBrowserPath('/wfh-management/workspace-x', '/wfh-management/'), null)
  assert.equal(portalModeFromBrowserPath('/workspace/login', '/'), 'admin')
})

test('public targets preserve suffix, query and hash while internal routes remain permission-compatible', () => {
  assert.equal(publicPortalTarget('/admin/employees?tab=alerts#row'), '/workspace/employees?tab=alerts#row')
  assert.equal(publicPortalTarget('/staff/exams?attempt=1#question'), '/portal/exams?attempt=1#question')
  assert.equal(publicPortalTarget('admin', 'login'), '/workspace/login')
  assert.equal(publicPortalTarget('staff', '/register?invite=1#code'), '/portal/register?invite=1#code')
  assert.equal(internalPortalPath('/workspace/employees?tab=alerts#row'), '/admin/employees?tab=alerts#row')
  assert.equal(internalPortalPath('/portal/payroll'), '/staff/payroll')
  assert.equal(publicPortalTarget('/workspace-x?tab=1'), '/workspace-x?tab=1')
})

test('admin and staff auth storage namespaces remain independent', () => {
  assert.equal(portalAuthStorageKey('admin'), 'wfh-admin-auth-token')
  assert.equal(portalAuthStorageKey('staff'), 'wfh-staff-auth-token')
  assert.notEqual(portalAuthStorageKey('admin'), portalAuthStorageKey('staff'))
})

test('application paths are derived from the selected host base', () => {
  assert.equal(appPathnameForBase('admin/employees', '/'), '/admin/employees')
  assert.equal(
    appPathnameForBase('/admin/employees', '/wfh-management/'),
    '/wfh-management/admin/employees',
  )
  assert.equal(APP_BASE_URL, '/')
  assert.equal(APP_ROUTER_BASENAME, '/')
})
