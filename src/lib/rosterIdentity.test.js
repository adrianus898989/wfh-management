import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { rosterPersonKey, uniqueRosterCount } from './rosterIdentity.js'

test('roster count uses employee ID first and name only when ID is missing', () => {
  const rows = Array.from({ length: 1084 }, (_, index) => ({
    employee_id: `EMP${String(index + 1).padStart(4, '0')}`,
    name: index < 2 ? '玉' : `员工${index + 1}`,
  }))
  rows.push({ employee_id: ' emp0074 ', name: 'AKI' })
  rows.push({ employee_id: '', name: '待补ID甲' })
  rows.push({ employee_id: '', name: '待补ID乙' })

  assert.equal(rows.length, 1087)
  assert.equal(uniqueRosterCount(rows), 1086)
  assert.notEqual(rosterPersonKey(rows[0]), rosterPersonKey(rows[1]), '同名但不同 ID 必须保留为两个人')
})

test('missing-ID fallback normalizes equivalent name formatting', () => {
  assert.equal(
    rosterPersonKey({ employee_id: '', name: '  Alice   Tan ' }),
    rosterPersonKey({ employee_id: '', name: 'Alice Tan' }),
  )
})

test('reports endpoint uses the same identity rule for totals and grouped statistics', async () => {
  const source = await readFile(new URL('../../supabase/functions/admin-reports/index.ts', import.meta.url), 'utf8')
  assert.match(source, /stats:\{people:uniquePeople\(roster\)/)
  assert.match(source, /const identity=rosterPersonKey\(r\)/)
  assert.doesNotMatch(source, /stats:\{people:new Set\(roster\.map\(\(r:any\)=>text\(r\.name\)\)/)
})
