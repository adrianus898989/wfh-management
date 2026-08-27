import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')

test('employee detail imports the shared alert permission catalog it renders', () => {
  assert.match(source, /import\s+\{\s*ADMIN_ALERT_PERMISSIONS\s*\}\s+from\s+'\.\.\/lib\/adminAlertCatalog'/)
  assert.match(source, /hasAnyPermission\(ADMIN_ALERT_PERMISSIONS\)/)
})

test('activation action stays visible when the access context grants it before metadata finishes loading', () => {
  assert.match(source, /canGenerateActivationCode=adminAccess\.hasPermission\(PERMISSIONS\.USER_ACTIVATION_GENERATE\)/)
  assert.match(source, /meta\.actions\?\.can_generate_activation_code\|\|canGenerateActivationCode/)
})
