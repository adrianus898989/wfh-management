import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  companyAssetCountries,
  companyAssetPage,
  filterCompanyAssetEmployees,
  normalizeCompanyAssetEmployees,
} from './companyAssets.js'

const rows = [
  { id:'2', employee_no:'WD10', full_name:'Beta', hire_date:'2026-02-01T00:00:00Z', country:'越南', work_tg:'beta_tg', status:'active' },
  { id:'1', employee_no:'WD2', full_name:'Alpha', hire_date:'2026-01-01', nationality:'菲律宾', status:'active' },
  { id:'3', employee_no:'TEST001', full_name:'Test', status:'active' },
  { id:'4', employee_no:'WD3', full_name:'Former', status:'resigned' },
  { id:'5', employee_no:'WD4', full_name:'Deleted', status:'active', source_type:'google_deleted' },
]

test('company asset employee list keeps only real active employees and normalizes base fields', () => {
  const normalized = normalizeCompanyAssetEmployees(rows)
  assert.deepEqual(normalized.map(row => row.employee_no), ['WD2', 'WD10'])
  assert.equal(normalized[0].country, '菲律宾')
  assert.equal(normalized[1].hire_date, '2026-02-01')
})

test('company asset search covers employee basics and existing work Telegram', () => {
  const normalized = normalizeCompanyAssetEmployees(rows)
  assert.deepEqual(filterCompanyAssetEmployees(normalized, { keyword:'beta_tg' }).map(row => row.employee_no), ['WD10'])
  assert.deepEqual(filterCompanyAssetEmployees(normalized, { country:'菲律宾' }).map(row => row.employee_no), ['WD2'])
  assert.deepEqual(companyAssetCountries(normalized), ['菲律宾', '越南'])
})

test('company asset pagination clamps the requested page', () => {
  const result = companyAssetPage([{ id:1 }, { id:2 }, { id:3 }], 9, 2)
  assert.equal(result.page, 2)
  assert.equal(result.pages, 2)
  assert.deepEqual(result.rows, [{ id:3 }])
})

test('company asset endpoint is read-only, scoped, and returns only display fields', async () => {
  const source = await readFile(new URL('../../supabase/functions/admin-accounts/index.ts', import.meta.url), 'utf8')
  const actionStart = source.indexOf("if (action === 'company_assets')")
  const actionEnd = source.indexOf("if (action === 'bootstrap')", actionStart)
  assert.ok(actionStart > 0 && actionEnd > actionStart)
  const actionSource = source.slice(actionStart, actionEnd)
  assert.match(actionSource, /can\('user\.view'\)/)
  assert.match(actionSource, /getScopedEmployees\(true\)/)
  assert.match(actionSource, /hire_date:/)
  assert.match(actionSource, /employee_no:/)
  assert.match(actionSource, /full_name:/)
  assert.match(actionSource, /country:/)
  assert.match(actionSource, /work_tg:/)
  assert.doesNotMatch(actionSource, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/)
  assert.doesNotMatch(actionSource, /microsoft|wuying|email_account/i)
})
