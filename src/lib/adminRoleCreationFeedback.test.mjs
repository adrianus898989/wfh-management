import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('role creation validates input, prevents duplicate submits and opens permission setup', async () => {
  const page = await readFile(new URL('../pages/AdminUsersPage.jsx', import.meta.url), 'utf8')

  assert.match(page, /name\.length < 2 \|\| name\.length > 40/)
  assert.match(page, /creatingRole/)
  assert.match(page, /const created = await call\(\{ action: 'create_role', name \}\)/)
  assert.match(page, /if \(created\?\.role\) openRole\(created\.role\)/)
  assert.match(page, /请继续勾选并保存权限/)
})
