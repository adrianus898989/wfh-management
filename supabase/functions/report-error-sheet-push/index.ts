import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  claimSheetSyncLease,
  releaseSheetSyncLease,
  sheetSyncDatabaseErrorIsRetryable,
  SheetSyncDeadlineError,
  SheetSyncLease,
  SheetSyncRpcError,
  sheetSyncRpcWithDeadline,
} from "../_shared/sheetSyncRuntime.ts";
import {
  normalizeReportErrorPush,
  ReportErrorPushValidationError,
  sha256Hex,
} from "./protocol.ts";

const EXPECTED_TOKEN_SHA256 =
  "32c9484536652a282ba31becb2dde899992a6f7c403c901e0598e9ff5e1340be";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const REPORT_SYNC_JOB = "report-sheet-sync";
const LEASE_TTL_SECONDS = 90;
const ERROR_CHUNK_SIZE = 500;
const RPC_TIMEOUT_MS = 9_000;

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...Object.fromEntries(new Headers(headers).entries()),
      },
    },
  );

function secureEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function syncTokenIsValid(suppliedToken: string) {
  if (!suppliedToken) return false;
  const suppliedHash = await sha256Hex(suppliedToken);
  if (secureEqual(suppliedHash, EXPECTED_TOKEN_SHA256)) return true;

  // The existing WFH System project uses STAFF_SHEET_SYNC_SECRET. Supabase
  // secrets are shared with Edge Functions, so accept that already-authorized
  // writer without copying or exposing its raw value.
  const staffSyncSecret = Deno.env.get("STAFF_SHEET_SYNC_SECRET") ?? "";
  return Boolean(staffSyncSecret) && secureEqual(
    suppliedHash,
    await sha256Hex(staffSyncSecret),
  );
}

function hash32(input: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

Deno.serve(async (request: Request) => {
  const startedAt = Date.now();
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  // Authenticate before parsing a source payload. This raw token already lives
  // in the trusted private-sheet Apps Script project; only its digest is here.
  const suppliedToken = request.headers.get("x-report-error-sync-token") ?? "";
  if (!await syncTokenIsValid(suppliedToken)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return json({ ok: false, error: "payload_too_large" }, 413);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "sync_request_failed" }, 500);
  }
  const service = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { "x-report-error-sync": "private-sheet-push-v1" } },
  });
  let lease: SheetSyncLease | null = null;
  let preserveLeaseUntilExpiry = false;

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return json({ ok: false, error: "payload_too_large" }, 413);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new ReportErrorPushValidationError("malformed_json");
    }
    const snapshot = await normalizeReportErrorPush(parsed);

    // Share the scheduled report writer's lease: a source push can never race
    // the cron fetch/finalize path for the same chunk namespace.
    const claim = await claimSheetSyncLease(
      service,
      REPORT_SYNC_JOB,
      LEASE_TTL_SECONDS,
    );
    if (!claim.acquired) {
      return json(
        {
          ok: false,
          error: "sync_busy",
          retry_after_seconds: claim.retryAfterSeconds,
        },
        503,
        { "retry-after": String(claim.retryAfterSeconds) },
      );
    }
    lease = claim.lease;

    const { data: currentRows, error: currentError } = await service
      .from("report_error_sync_chunks")
      .select("chunk_index,content_hash,row_count,synced_at")
      .eq("source_name", snapshot.sourceName);
    if (currentError) {
      throw new Error(`current_error_chunks:${currentError.code ?? "unknown"}`);
    }

    const currentCount = (currentRows ?? []).reduce(
      (total: number, row: Record<string, unknown>) =>
        total + Number(row.row_count ?? 0),
      0,
    );
    const latestCurrentSync = (currentRows ?? [])
      .map((row: Record<string, unknown>) =>
        Date.parse(String(row.synced_at ?? ""))
      )
      .filter(Number.isFinite)
      .sort((left: number, right: number) => right - left)[0] ?? 0;
    if (
      latestCurrentSync &&
      Date.parse(snapshot.capturedAt) < latestCurrentSync - 5 * 60_000
    ) {
      return json({
        ok: false,
        error: "stale_snapshot",
        request_id: snapshot.requestId,
      }, 409);
    }
    const deleteCount = Math.max(0, currentCount - snapshot.rows.length);
    if (
      !snapshot.allowLargeDelete && currentCount >= 20 && deleteCount >= 20 &&
      snapshot.rows.length < Math.ceil(currentCount * 0.6)
    ) {
      return json({
        ok: false,
        error: "snapshot_shrink_requires_manual_override",
        request_id: snapshot.requestId,
        current_rows: currentCount,
        next_rows: snapshot.rows.length,
      }, 422);
    }

    const current = new Map<number, string>((currentRows ?? []).map(
      (
        row: Record<string, unknown>,
      ) => [Number(row.chunk_index), String(row.content_hash ?? "")],
    ));
    const chunks: Array<Array<Record<string, unknown>>> = [];
    for (
      let index = 0;
      index < snapshot.rows.length;
      index += ERROR_CHUNK_SIZE
    ) {
      chunks.push(snapshot.rows.slice(index, index + ERROR_CHUNK_SIZE));
    }
    const changes = chunks
      .map((rows, chunkIndex) => ({
        rows,
        chunkIndex,
        contentHash: hash32(JSON.stringify(rows)),
      }))
      .filter((change) =>
        current.get(change.chunkIndex) !== change.contentHash
      );

    for (const change of changes) {
      const { error } = await sheetSyncRpcWithDeadline(
        service,
        "sync_report_employee_error_chunk",
        {
          p_source_name: snapshot.sourceName,
          p_chunk_index: change.chunkIndex,
          p_chunk_size: ERROR_CHUNK_SIZE,
          p_content_hash: change.contentHash,
          p_rows: change.rows,
        },
        RPC_TIMEOUT_MS,
      );
      if (error) {
        throw new SheetSyncRpcError(
          `report_error_push_chunk_${change.chunkIndex}`,
          error,
        );
      }
    }
    const { data: finalized, error: finalizeError } =
      await sheetSyncRpcWithDeadline<{
        deleted_rows?: number;
      }>(
        service,
        "finalize_report_employee_error_sync",
        { p_source_name: snapshot.sourceName, p_chunk_count: chunks.length },
        RPC_TIMEOUT_MS,
      );
    if (finalizeError) {
      throw new SheetSyncRpcError("report_error_push_finalize", finalizeError);
    }

    // Keep the snapshot mirror aligned for diagnostics. The detail generation
    // changes immediately; the existing 10-minute report cron then rebuilds
    // employee summaries without ever needing anonymous access to this sheet.
    const now = new Date().toISOString();
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const { error } = await service.from("report_sheet_snapshot_chunks")
        .upsert({
          source: snapshot.sourceName,
          chunk_index: chunkIndex,
          payload: chunk,
          row_count: chunk.length,
          content_hash: hash32(JSON.stringify(chunk)),
          synced_at: now,
        }, { onConflict: "source,chunk_index" });
      if (error) {
        throw new Error(
          `snapshot_chunk_${chunkIndex}:${error.code ?? "unknown"}`,
        );
      }
    }
    const { error: staleSnapshotError } = await service
      .from("report_sheet_snapshot_chunks")
      .delete()
      .eq("source", snapshot.sourceName)
      .gte("chunk_index", chunks.length);
    if (staleSnapshotError) {
      throw new Error(
        `snapshot_finalize:${staleSnapshotError.code ?? "unknown"}`,
      );
    }

    return json({
      ok: true,
      request_id: snapshot.requestId,
      source: snapshot.sourceName,
      raw_rows: snapshot.rawRowCount,
      normalized_rows: snapshot.rows.length,
      dropped_rows: snapshot.droppedRowCount,
      changed_chunks: changes.length,
      deleted_rows: Number(finalized?.deleted_rows ?? 0),
      summary_refresh_due_within_seconds: 600,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    if (error instanceof ReportErrorPushValidationError) {
      return json({
        ok: false,
        error: error.code,
        duration_ms: Date.now() - startedAt,
      }, 400);
    }
    if (error instanceof SheetSyncDeadlineError) {
      preserveLeaseUntilExpiry = true;
      return json(
        {
          ok: false,
          error: "database_timeout",
          duration_ms: Date.now() - startedAt,
        },
        503,
        {
          "retry-after": String(LEASE_TTL_SECONDS),
        },
      );
    }
    if (
      error instanceof SheetSyncRpcError &&
      sheetSyncDatabaseErrorIsRetryable(error)
    ) {
      return json(
        { ok: false, error: "sync_busy", duration_ms: Date.now() - startedAt },
        503,
        {
          "retry-after": "10",
        },
      );
    }
    console.error("report-error-sheet-push failed", {
      error: error instanceof Error ? error.name : "unexpected_error",
    });
    return json({
      ok: false,
      error: "sync_request_failed",
      duration_ms: Date.now() - startedAt,
    }, 500);
  } finally {
    if (lease && !preserveLeaseUntilExpiry) {
      try {
        await releaseSheetSyncLease(service, lease);
      } catch {
        console.warn("report-error-sheet-push lease_release_failed");
      }
    }
  }
});
