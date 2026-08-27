import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const riskFunction = await readFile(
  new URL('../../supabase/functions/admin-employee-risk-list/index.ts', import.meta.url),
  'utf8',
)
const employeeWrite = await readFile(
  new URL('../../supabase/functions/admin-employee-write/index.ts', import.meta.url),
  'utf8',
)

test('risk-filtered employee lists enforce sensitive view permission for filters and output', () => {
  assert.match(
    riskFunction,
    /const canViewEmployeeSensitive = await permissionAllowed\(service, current, 'sensitive\.employee\.view'\)/,
  )
  assert.match(
    riskFunction,
    /if \(canViewEmployeeSensitive && text\(filters\.work_tg\)\) query = query\.ilike\('work_tg'/,
  )
  assert.match(
    riskFunction,
    /if \(canViewEmployeeSensitive && text\(filters\.backend_account\)\) query = query\.ilike\('backend_accounts'/,
  )
  assert.match(
    riskFunction,
    /work_tg: canViewEmployeeSensitive \? employee\.work_tg : \(employee\.work_tg \? '\*\*\*\*' : null\)/,
  )
  assert.match(
    riskFunction,
    /backend_accounts: canViewEmployeeSensitive \? employee\.backend_accounts : \(employee\.backend_accounts \? '\*\*\*\*' : null\)/,
  )
})

test('audit redaction masks sensitive ancestor paths including nested before/after objects', () => {
  assert.match(employeeWrite, /pathSegments\.includes\("work_tg"\)/)
  assert.match(employeeWrite, /pathSegments\.includes\("backend_accounts"\)/)
  assert.match(employeeWrite, /if\(contactSensitive&&!canViewContact\) return "\*\*\*"/)
  assert.match(employeeWrite, /const nextHint=keyHint\?`\$\{keyHint\}\.\$\{key\}`:key/)
})
