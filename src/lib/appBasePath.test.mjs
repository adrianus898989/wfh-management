import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APP_BASE_URL,
  APP_ROUTER_BASENAME,
  appPathFromBrowserPath,
  appPathnameForBase,
  internalPortalPath,
  normalizeAppBaseUrl,
  portalAuthStorageKey,
  portalModeFromAppPath,
  portalModeFromBrowserPath,
  publicPortalTarget,
} from './appBasePath.js'

test('app base normalization is stable for root and GitHub Pages paths', () => {
  assert.equal(normalizeAppBaseUrl('/'), '/')
  assert.equal(normalizeAppBaseUrl('/wfh-management/'), '/wfh-management/')
  assert.equal(normalizeAppBaseUrl('wfh-management'), '/wfh-management/')
  assert.equal(normalizeAppBaseUrl('//wfh-management///'), '/wfh-management/')
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
