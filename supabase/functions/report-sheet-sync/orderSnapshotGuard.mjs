export const ORDER_SNAPSHOT_MIN_RETAINED_PERCENT = 80

const count = value => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}
/**
 * Reject a transient empty/partial Google snapshot before any destructive
 * chunk reconciliation starts. A new source has no baseline, but it must still
 * contain at least one eligible order row.
 */
export function assertOrderSnapshotSafe({
  sourceSheet,
  incomingRows,
  baselineRows,
  minimumRetainedPercent = ORDER_SNAPSHOT_MIN_RETAINED_PERCENT,
}) {
  const incoming = count(incomingRows)
  const baseline = count(baselineRows)
  const retainedPercent = count(minimumRetainedPercent)

  if (incoming === 0) {
    throw new Error(`order_sheet_snapshot_empty:${sourceSheet}`)
  }

  const minimumRows = baseline > 0
    ? Math.ceil((baseline * retainedPercent) / 100)
    : 0
  if (baseline > 0 && incoming < minimumRows) {
    throw new Error(
      `order_sheet_snapshot_below_baseline:${sourceSheet}:incoming=${incoming}:baseline=${baseline}:minimum=${minimumRows}`,
    )
  }

  return {
    incoming_rows: incoming,
    baseline_rows: baseline,
    minimum_rows: minimumRows,
    minimum_retained_percent: retainedPercent,
  }
}
