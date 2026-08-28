import {
  claimSheetSyncLease,
  SheetSyncRpcError,
  sheetSyncDatabaseErrorIsRetryable,
} from "../_shared/sheetSyncRuntime.ts";
import type {
  SheetSyncLeaseClaim,
  SheetSyncRpcClient,
} from "../_shared/sheetSyncRuntime.ts";

const DEFAULT_MAX_WAIT_MS = 12_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_POLL_JITTER_MS = 250;
const DEFAULT_CLAIM_TIMEOUT_MS = 3_500;
const FINAL_CLAIM_BUDGET_MS = 250;

type AttendanceLeaseWaitOptions = {
  maxWaitMs?: number;
  pollIntervalMs?: number;
  pollJitterMs?: number;
  claimTimeoutMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const sleep = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});

/**
 * Briefly wait for the attendance-wide database lease instead of immediately
 * surfacing expected trigger overlap as a 503. The database lease remains the
 * authority: this helper never runs two ingests concurrently and never turns a
 * busy result into success. Once the bounded wait is exhausted, the caller
 * returns the last busy result so Apps Script keeps the hash pending.
 */
export async function claimAttendanceSheetSyncLeaseWithWait(
  client: SheetSyncRpcClient,
  ttlSeconds: number,
  options: AttendanceLeaseWaitOptions = {},
): Promise<SheetSyncLeaseClaim> {
  const maxWaitMs = Math.max(1, Math.trunc(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS));
  const pollIntervalMs = Math.max(1, Math.trunc(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  ));
  const pollJitterMs = Math.max(0, Math.trunc(
    options.pollJitterMs ?? DEFAULT_POLL_JITTER_MS,
  ));
  const claimTimeoutMs = Math.max(1, Math.trunc(
    options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS,
  ));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const wait = options.sleep ?? sleep;
  const deadline = now() + maxWaitMs;
  let lastBusy: SheetSyncLeaseClaim | null = null;
  let lastRetryableError: SheetSyncRpcError | null = null;

  while (true) {
    const remainingForClaim = deadline - now();
    if (remainingForClaim <= 0) {
      if (lastRetryableError) throw lastRetryableError;
      return lastBusy ?? { acquired: false, lease: null, retryAfterSeconds: 1 };
    }

    try {
      const claim = await claimSheetSyncLease(
        client,
        "attendance-sheet-sync",
        ttlSeconds,
        Math.min(claimTimeoutMs, Math.max(1, remainingForClaim)),
      );
      lastRetryableError = null;
      if (claim.acquired) return claim;
      lastBusy = claim;
    } catch (error) {
      if (!(error instanceof SheetSyncRpcError) || !sheetSyncDatabaseErrorIsRetryable(error)) {
        throw error;
      }
      lastRetryableError = error;
    }

    const remaining = deadline - now();
    // Leave a small portion of the wall-clock budget for one final lease RPC.
    if (remaining <= FINAL_CLAIM_BUDGET_MS) {
      if (lastRetryableError) throw lastRetryableError;
      return lastBusy ?? { acquired: false, lease: null, retryAfterSeconds: 1 };
    }

    const normalizedRandom = Math.min(1, Math.max(0, Number(random()) || 0));
    const jitter = Math.floor(normalizedRandom * pollJitterMs);
    // The database's retry-after can reflect the 90-second crash-recovery TTL.
    // Polling is deliberately capped to this small interval because healthy
    // holders normally release in 3-8 seconds. Jitter prevents a waiter herd.
    const delay = Math.min(
      remaining - FINAL_CLAIM_BUDGET_MS,
      pollIntervalMs + jitter,
    );
    await wait(delay);
  }
}
