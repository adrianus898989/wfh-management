import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  claimSheetSyncLease,
  releaseSheetSyncLease,
  SheetSyncDeadlineError,
  SheetSyncLease,
  SheetSyncRpcError,
  sheetSyncDatabaseErrorIsRetryable,
  sheetSyncRpcWithDeadline,
} from "../_shared/sheetSyncRuntime.ts";
import { normalizeSnapshot, sha256Hex, SnapshotValidationError } from "./normalize.ts";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const LEASE_TTL_SECONDS = 90;
const RPC_TIMEOUT_MS = 45_000;
// The raw credential belongs only in Google Apps Script Properties. Keep this
// digest aligned with the existing private sheet push endpoints during rollout.
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

  const suppliedToken = request.headers.get("x-employee-master-sync-token") ?? "";
  if (!suppliedToken) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  const suppliedTokenHash = await sha256Hex(suppliedToken);
  if (!constantTimeEqual(suppliedTokenHash, EXPECTED_TOKEN_SHA256)) {
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
  const service = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-employee-master-sync": "dual-source-v1" } },
  });
  let lease: SheetSyncLease | null = null;
  let preserveLeaseUntilExpiry = false;

  try {
    const claim = await claimSheetSyncLease(service, "employee-master-sync", LEASE_TTL_SECONDS);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new SnapshotValidationError("malformed_json");
    }
    const normalized = await normalizeSnapshot(parsed);

    const { data, error } = await sheetSyncRpcWithDeadline(service, "ingest_employee_master_snapshot", {
      p_payload: normalized,
    }, RPC_TIMEOUT_MS);
    if (error) {
      console.error("employee-master-sync rpc_failed", {
        request_id: normalized.request_id,
        code: error.code,
      });
      if (sheetSyncDatabaseErrorIsRetryable(error)) {
        return jsonResponse(
          { ok: false, error: "sync_busy", request_id: normalized.request_id },
          503,
          { "retry-after": "5" },
        );
      }
      return jsonResponse({ ok: false, error: "database_ingest_failed", request_id: normalized.request_id }, 500);
    }
    if (!data?.ok) {
      console.error("employee-master-sync ingest_rejected", {
        request_id: normalized.request_id,
        run_id: data?.run_id,
        error_code: data?.error_code,
      });
      return jsonResponse({
        ok: false,
        error: "database_ingest_rejected",
        error_code: data?.error_code,
        request_id: normalized.request_id,
        run_id: data?.run_id,
      }, 422);
    }
    return jsonResponse(data);
  } catch (error) {
    if (error instanceof SheetSyncDeadlineError) {
      preserveLeaseUntilExpiry = true;
      console.error("employee-master-sync deadline", { rpc: error.rpcName });
      return jsonResponse({ ok: false, error: "database_timeout" }, 503, { "retry-after": "45" });
    }
    if (error instanceof SheetSyncRpcError && sheetSyncDatabaseErrorIsRetryable(error)) {
      return jsonResponse({ ok: false, error: "sync_busy" }, 503, { "retry-after": "5" });
    }
    if (error instanceof SnapshotValidationError) {
      console.error("employee-master-sync validation_failed", {
        code: error.code,
        details: error.details,
      });
      return jsonResponse({ ok: false, error: error.code, details: error.details }, 400);
    }
    const message = error instanceof Error ? error.message : "unexpected_error";
    console.error("employee-master-sync request_failed", { error: message });
    return jsonResponse({ ok: false, error: "sync_request_failed" }, 500);
  } finally {
    if (lease && !preserveLeaseUntilExpiry) {
      try {
        await releaseSheetSyncLease(service, lease);
      } catch (error) {
        console.warn("employee-master-sync lease_release_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }
});
