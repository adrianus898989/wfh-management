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

test('order snapshot guard rejects empty and unexpectedly small snapshots', () => {
  assert.equal(ORDER_SNAPSHOT_MIN_RETAINED_PERCENT, 80)
  assert.throws(
    () => assertOrderSnapshotSafe({ sourceSheet: '工作表4', incomingRows: 0, baselineRows: 100 }),
    /order_sheet_snapshot_empty/,
  )
  assert.throws(
    () => assertOrderSnapshotSafe({ sourceSheet: '填表', incomingRows: 79, baselineRows: 100 }),
    /order_sheet_snapshot_below_baseline/,
  )
  assert.deepEqual(
    assertOrderSnapshotSafe({ sourceSheet: '填表', incomingRows: 80, baselineRows: 100 }),
    { incoming_rows: 80, baseline_rows: 100, minimum_rows: 80, minimum_retained_percent: 80 },
  )
})
test('report Edge validates each source before the first destructive chunk RPC', () => {
  const sourceLoop = edge.indexOf('for (const sourceSheet of ORDER_SHEETS)')
  const guard = edge.indexOf('assertOrderSnapshotSafe({', sourceLoop)
  const chunkRpc = edge.indexOf("'sync_report_order_chunk'", sourceLoop)

  assert.ok(sourceLoop >= 0)
  assert.ok(guard > sourceLoop && guard < chunkRpc)
  assert.match(edge, /select\('source_sheet,chunk_index,content_hash,row_count'\)/)
  assert.match(edge, /baselineRows\.set\(sourceSheet, previousRows \+ Math\.max/)
})
