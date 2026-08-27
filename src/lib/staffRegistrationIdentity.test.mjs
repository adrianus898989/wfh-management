import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260827061000_allow_separate_backend_and_staff_accounts.sql'), 'utf8')
const portalConstraint = fs.readFileSync(path.join(root, 'supabase/migrations/20260827062500_prevent_hybrid_user_access.sql'), 'utf8')
const register = fs.readFileSync(path.join(root, 'supabase/functions/register-employee/index.ts'), 'utf8')
const adminAccounts = fs.readFileSync(path.join(root, 'supabase/functions/admin-accounts/index.ts'), 'utf8')
const staffRegister = fs.readFileSync(path.join(root, 'src/pages/StaffRegisterPage.jsx'), 'utf8')

test('backend and staff identities are unique independently', () => {
  assert.match(migration, /drop constraint if exists user_access_employee_id_key/i)
  assert.match(migration, /where employee_id is not null and backend_enabled = true/i)
  assert.match(migration, /where employee_id is not null and employee_portal_enabled = true/i)
})

test('one login identity cannot grant both backend and staff portals', () => {
  assert.match(portalConstraint, /check \(not \(backend_enabled = true and employee_portal_enabled = true\)\)/i)
})

test('self registration only treats an existing staff identity as already linked', () => {
  assert.match(register, /eq\('employee_id', employee\.id\)\.eq\('employee_portal_enabled', true\)\.maybeSingle\(\)/)
  assert.match(register, /accessError\.code === '23505'/)
  assert.match(staffRegister, /functions\.invoke\('register-employee'/)
})

test('admin account creation and activation codes also ignore a separate backend identity', () => {
  const staffChecks = adminAccounts.match(/eq\('employee_id', [^)]+\)\.eq\('employee_portal_enabled', true\)\.maybeSingle\(\)/g) || []
  assert.ok(staffChecks.length >= 2, 'create_staff and generate_activation_code must both filter staff identities')
})
