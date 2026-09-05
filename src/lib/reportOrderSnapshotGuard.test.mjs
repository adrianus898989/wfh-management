import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ORDER_SNAPSHOT_MIN_RETAINED_PERCENT,
  assertOrderSnapshotSafe,
} from '../../supabase/functions/report-sheet-sync/orderSnapshotGuard.mjs'

const edgePath = fileURLToPath(new URL(
  '../../supabase/functions/report-sheet-sync/index.ts',
  import.meta.url,
))
const edge = readFileSync(edgePath, 'utf8')

function between(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('order snapshot guard rejects empty and unexpectedly small snapshots', () => {
  assert.equal(ORDER_SNAPSHOT_MIN_RETAINED_PERCENT, 80)
  assert.throws(
    () => assertOrderSnapshotSafe({ sourceSheet: '工作表4', incomingRows: 0, baselineRows: 100 }),
    /order_sheet_snapshot_empty/,
  )
  assert.throws(
    () => assertOrderSnapshotSafe({ sourceSheet: '工作表4', incomingRows: 79, baselineRows: 100 }),
    /order_sheet_snapshot_below_baseline/,
  )
  assert.deepEqual(
    assertOrderSnapshotSafe({ sourceSheet: '工作表4', incomingRows: 80, baselineRows: 100 }),
    { incoming_rows: 80, baseline_rows: 100, minimum_rows: 80, minimum_retained_percent: 80 },
  )
})
test('工作表4 remains a guarded full snapshot before destructive chunk RPCs', () => {
  const fullSync = between(
    edge,
    'async function syncGuardedFullOrderSheet(',
    'async function syncRollingOrderSheet(',
  )
  const guard = fullSync.indexOf('assertOrderSnapshotSafe({')
  const chunkRpc = fullSync.indexOf("'sync_report_order_chunk'")

  assert.ok(guard >= 0 && guard < chunkRpc)
  assert.match(fullSync, /const sourceSheet = FULL_ORDER_SHEET/)
  assert.match(fullSync, /baselineRows = \(existingRows \|\| \[\]\)\.reduce/)
  assert.match(fullSync, /for \(const row of existingRows \|\| \[\]\)[\s\S]*changes\.push\(\{ chunkIndex, hash, rows \}\)/)
  assert.doesNotMatch(fullSync, /sync_report_order_rolling_month/)
  assert.match(edge, /select\('source_sheet,chunk_index,content_hash,row_count'\)/)
  assert.match(edge, /\.eq\('source_sheet', FULL_ORDER_SHEET\)/)
})

test('填表 replaces only present, unfinalized months and preserves absent months', () => {
  const markerRead = between(
    edge,
    'async function loadRollingOrderMarkers(',
    'async function syncRollingOrderSheet(',
  )
  const rollingSync = between(
    edge,
    'async function syncRollingOrderSheet(',
    'async function syncOrderSheets(',
  )
  const wrapper = between(edge, 'async function syncOrderSheets(', 'Deno.serve(')
  const renewIndex = rollingSync.indexOf('await renewLease()', rollingSync.indexOf('for (const [month, rows] of months)'))
  const rpcIndex = rollingSync.indexOf("'sync_report_order_rolling_month'")

  assert.match(markerRead, /'report_order_rolling_month_markers'/)
  assert.match(markerRead, /ORDER_MARKERS_RPC_TIMEOUT_MS/)
  assert.match(markerRead, /await renewLease\(\)/)
  assert.match(markerRead, /month_key:[\s\S]*content_hash:[\s\S]*row_count:[\s\S]*finalized_through:/)
  assert.equal((rollingSync.match(/loadRollingOrderMarkers\(service, renewLease\)/g) || []).length, 1)
  assert.match(rollingSync, /\[\.\.\.parsed\.rowsByMonth\.entries\(\)\]/)
  assert.match(rollingSync, /row\.work_date > finalizedThrough/)
  assert.match(rollingSync, /rows\.length > 0 \|\| monthEndDate\(month\) <= finalizedThrough/)
  assert.match(rollingSync, /skipped_finalized_rows: skippedFinalizedRows/)
  assert.match(rollingSync, /cleared_finalized_months: monthResults\.filter\(result => result\.rows === 0\)\.length/)
  assert.match(rollingSync, /preserves_absent_months: true/)
  assert.match(rollingSync, /contentHash = await sha256\(JSON\.stringify\(rows\)\)/)
  assert.match(rollingSync, /marker\.content_hash === contentHash[\s\S]*marker\.row_count === rows\.length[\s\S]*marker\.finalized_through === finalizedThrough/)
  assert.match(rollingSync, /if \(markerMatches\)[\s\S]*write_skipped: true,[\s\S]*continue[\s\S]*'sync_report_order_rolling_month'/)
  assert.ok(renewIndex >= 0 && renewIndex < rpcIndex)
  assert.match(rollingSync, /p_month: month,[\s\S]*p_content_hash: contentHash,[\s\S]*p_rows: rows/)
  assert.match(rollingSync, /ORDER_MONTH_RPC_TIMEOUT_MS/)
  assert.match(rollingSync, /marker_skipped_months:[\s\S]*written_months:/)
  assert.doesNotMatch(rollingSync, /assertOrderSnapshotSafe/)
  assert.doesNotMatch(rollingSync, /sync_report_order_chunk/)
  assert.doesNotMatch(rollingSync, /delete-missing-months phase:[\s\S]*\.delete\(/)
  assert.match(rollingSync, /Missing months[\s\S]*are never enumerated here/)
  assert.match(wrapper, /syncRollingOrderSheet\([\s\S]*fullResult\.latest_date/)
  assert.match(wrapper, /const results = \[fullResult, rollingResult\]/)
})

test('private finance errors are consumed from the authenticated push, never a public proxy', () => {
  assert.match(edge, /const PUBLIC_ERROR_SOURCES = \[/)
  assert.match(edge, /name: '效率表\/员工错误'/)
  assert.doesNotMatch(edge, /opensheet\.elk\.sh\/125rN-PXjjWMe4SnYjruGlQ_NdZUb5hI7dXUUBjqe7bY/)
  assert.match(edge, /const errors = await loadAllSyncedErrors\(service\)/)
})
