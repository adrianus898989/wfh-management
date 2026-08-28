import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  releaseSheetSyncLease,
  SheetSyncDeadlineError,
  SheetSyncRpcError,
  sheetSyncDatabaseErrorIsRetryable,
  sheetSyncRpcWithDeadline,
} from "../_shared/sheetSyncRuntime.ts";
import type { SheetSyncLease } from "../_shared/sheetSyncRuntime.ts";
import { claimAttendanceSheetSyncLeaseWithWait } from "./leaseWait.ts";
import { normalizeSnapshot, sha256Hex } from "./normalize.ts";

const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
const LEASE_TTL_SECONDS = 90;
const RPC_TIMEOUT_MS = 45_000;
// This committed SHA-256 digest is the sole authoritative credential for this
// deployment. The corresponding high-entropy raw token remains outside source
// control. Rotation requires changing this digest and deploying new code.
const EXPECTED_TOKEN_SHA256 = "32c9484536652a282ba31becb2dde899992a6f7c403c901e0598e9ff5e1340be";

const jsonResponse = (body: unknown, status = 200, extraHeaders: HeadersInit = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...Object.fromEntries(new Headers(extraHeaders).entries()),
  },
});

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);

  const expectedTokenHash = EXPECTED_TOKEN_SHA256;
  const suppliedToken = request.headers.get("x-attendance-sync-token") ?? "";
  if (!/^[0-9a-f]{64}$/.test(expectedTokenHash) || !suppliedToken) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  const suppliedTokenHash = await sha256Hex(suppliedToken);
  if (!constantTimeEqual(suppliedTokenHash, expectedTokenHash)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "sync_request_failed" }, 500);
  }
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-attendance-sync": "private-sheet-v1" } },
  });
  let lease: SheetSyncLease | null = null;
  let preserveLeaseUntilExpiry = false;

  try {
    const claim = await claimAttendanceSheetSyncLeaseWithWait(client, LEASE_TTL_SECONDS);
    if (!claim.acquired) {
      return jsonResponse(
        { ok: false, error: "sync_busy", retry_after_seconds: claim.retryAfterSeconds },
        503,
        { "retry-after": String(claim.retryAfterSeconds) },
      );
    }
    lease = claim.lease;

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
    }
    const payload = JSON.parse(rawBody);
    const normalized = await normalizeSnapshot(payload);

    const rpcClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: {
        "x-attendance-sync": normalized.sync_contract === "annual_v1"
          ? "annual-2026-v2"
          : "august-2026-v1",
      } },
    });
    const rpcName = normalized.sync_contract === "annual_v1"
      ? "ingest_annual_attendance_snapshot"
      : "ingest_august_attendance_snapshot";
    const { data, error } = await sheetSyncRpcWithDeadline(rpcClient, rpcName, {
      p_payload: normalized,
    }, RPC_TIMEOUT_MS);
    if (error) {
      console.error("attendance-sheet-sync rpc_failed", {
        request_id: normalized.request_id,
        source_key: normalized.source.source_key,
        code: error.code,
      });
      if (sheetSyncDatabaseErrorIsRetryable(error)) {
        return jsonResponse(
          { ok: false, error: "sync_busy", request_id: normalized.request_id },
          503,
          { "retry-after": "5" },
        );
      }
      const safeDatabaseMessage = String(error.message ?? "").match(
        /\b(source_not_configured|request_id_reuse_mismatch|stale_snapshot|empty_snapshot_requires_manual_override|large_delete_requires_manual_override)\b/,
      )?.[1];
      if (safeDatabaseMessage) {
        return jsonResponse({ ok: false, error: safeDatabaseMessage, request_id: normalized.request_id }, 422);
      }
      return jsonResponse({ ok: false, error: "database_ingest_failed", request_id: normalized.request_id }, 500);
    }
    if (!data?.ok) {
      console.error("attendance-sheet-sync ingest_rejected", {
        request_id: normalized.request_id,
        source_key: normalized.source.source_key,
        run_id: data?.run_id,
      });
      const deterministicRejection = new Set([
        "stale_snapshot",
        "empty_snapshot_requires_manual_override",
        "large_delete_requires_manual_override",
      ]).has(String(data?.error ?? ""));
      // The ingest procedure deliberately hides unexpected SQL details behind
      // `ingest_failed`. Treat that generic result as retryable: returning 422
      // would make Apps Script block this content hash permanently.
      if (deterministicRejection) return jsonResponse(data, 422);
      return jsonResponse({
        ...(data && typeof data === "object" ? data : { ok: false, error: "database_ingest_failed" }),
        // A failed run is itself idempotently persisted under request_id. The
        // retry therefore needs a fresh request ID; network/timeout failures do
        // not set this flag and safely keep reusing the original request ID.
        retry_with_new_request_id: true,
      }, 500);
    }
    return jsonResponse(data);
  } catch (error) {
    if (error instanceof SheetSyncDeadlineError) {
      preserveLeaseUntilExpiry = true;
      console.error("attendance-sheet-sync deadline", { rpc: error.rpcName });
      return jsonResponse({ ok: false, error: "database_timeout" }, 503, { "retry-after": "45" });
    }
    if (error instanceof SheetSyncRpcError && sheetSyncDatabaseErrorIsRetryable(error)) {
      return jsonResponse({ ok: false, error: "sync_busy" }, 503, { "retry-after": "5" });
    }
    const message = error instanceof Error ? error.message : "unexpected_error";
    const isClientError = /^(invalid_|source_not_allowlisted|sheet_|snapshot_|values_|cell_|date_|payload_|adjustment_|employee_identity_|sheet_row_|sheet_column_)/.test(message);
    const clientSafe = isClientError ? message : "sync_request_failed";
    console.error("attendance-sheet-sync request_failed", { error: message });
    // Configuration/runtime failures must remain retryable by Apps Script. Only
    // deterministic payload or source-validation failures are blocked by hash.
    return jsonResponse({ ok: false, error: clientSafe }, isClientError ? 400 : 500);
  } finally {
    if (lease && !preserveLeaseUntilExpiry) {
      try {
        await releaseSheetSyncLease(client, lease);
      } catch (error) {
        console.warn("attendance-sheet-sync lease_release_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }
});
