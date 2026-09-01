import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const edge = await readFile(new URL('../../supabase/functions/admin-employee-stats/index.ts', import.meta.url), 'utf8')
const page = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')

const between = (value, start, end) => {
  const from = value.indexOf(start)
  const to = value.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `missing section ${start}`)
  return value.slice(from, to)
}

test('lightweight employee overview returns yesterday and previous-seven-day comparisons', () => {
  const lifecycle = between(edge, 'function lifecycleKpis(', 'async function fetchPresenceCandidates(')

  assert.match(edge, /const deltaPct=\(current:number,previous:number\)=>previous===0\?\(current===0\?0:100\)/)
  assert.match(lifecycle, /previous7From=isoAdd\(today,-13\),previous7To=isoAdd\(today,-7\)/)
  assert.match(lifecycle, /today_join_delta:todayJoin-yesterdayJoin/)
  assert.match(lifecycle, /today_resign_delta:todayResign-yesterdayResign/)
  assert.match(lifecycle, /join_7d_delta_pct:deltaPct\(join7,previousJoin7\)/)
  assert.match(lifecycle, /resign_7d_delta_pct:deltaPct\(resign7,previousResign7\)/)
})

test('employee archive cards prefer lightweight overview comparisons without requesting analytics', () => {
  const loadOverview = between(page, 'const loadArchiveStats=async', 'const loadPeopleAnalytics=async')
  const cards = between(page, '<div className="module-summary-grid employee-summary-grid employee-kpi-grid archive-kpi-strip">', '</div>')

  assert.match(loadOverview, /functions\.invoke\('admin-employee-stats',\{body:\{action:'overview',today\}\}\)/)
  assert.doesNotMatch(loadOverview, /action:'analytics'/)
  assert.match(cards, /compare=\{archiveStats\.kpis\?\.today_join_delta\?\?analytics\.kpis\?\.today_join_delta\}/)
  assert.match(cards, /compare=\{archiveStats\.kpis\?\.today_resign_delta\?\?analytics\.kpis\?\.today_resign_delta\}/)
  assert.match(cards, /compare=\{archiveStats\.kpis\?\.join_7d_delta_pct\?\?analytics\.kpis\?\.join_7d_delta_pct\}/)
  assert.match(cards, /compare=\{archiveStats\.kpis\?\.resign_7d_delta_pct\?\?analytics\.kpis\?\.resign_7d_delta_pct\}/)
})
