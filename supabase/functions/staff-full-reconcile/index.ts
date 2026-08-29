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
import {
  isTerminalBankRequestSuccess,
  normalizeStaffFullReconcileRequest,
  staffFullReconcileSecretIsValid,
} from "./protocol.ts";

const MAX_REQUEST_BYTES = 512 * 1024;
const LEASE_TTL_SECONDS = 30;
const RPC_TIMEOUT_MS = 12_000;

const response = (body: unknown, status = 200, extraHeaders: HeadersInit = {}) => new Response(
  JSON.stringify(body),
  {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-sync-secret",
      "access-control-allow-methods": "POST, OPTIONS",
      ...Object.fromEntries(new Headers(extraHeaders).entries()),
    },
  },
);

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return response({ ok: true });
  if (request.method !== "POST") return response({ ok: false, error: "method_not_allowed" }, 405);

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return response({ ok: false, error: "payload_too_large" }, 413);
  }

  let normalized;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
      return response({ ok: false, error: "payload_too_large" }, 413);
    }
    const body = JSON.parse(raw);
    const authenticated = await staffFullReconcileSecretIsValid(
      Deno.env.get("STAFF_SHEET_SYNC_SECRET") ?? "",
      request.headers.get("x-sync-secret") ?? "",
      body,
    );
    if (!authenticated) return response({ ok: false, error: "unauthorized" }, 401);
    normalized = await normalizeStaffFullReconcileRequest(body);
  } catch (error) {
    const message = error instanceof SyntaxError
      ? "malformed_json"
      : error instanceof Error ? error.message : "invalid_request";
    const safe = /^(malformed_json|invalid_|missing_employee_(binding|name)$)/.test(message)
      ? message
      : "invalid_request";
    return response({ ok: false, error: safe }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return response({ ok: false, error: "sync_request_failed" }, 500);
  }
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-staff-full-reconcile": "staff-full-reconcile-v4" } },
  });
  let lease: SheetSyncLease | null = null;
  let preserveLeaseUntilExpiry = false;

  try {
    // Share the existing staff-sheet-sync lease with the onsite writer. This
    // avoids a schema-wide lease change and prevents the two legacy tabs from
    // updating profile tables concurrently.
    const claim = await claimSheetSyncLease(client, "staff-sheet-sync", LEASE_TTL_SECONDS);
    if (!claim.acquired) {
      return response(
        { ok: false, error: "sync_busy", retry_after_seconds: claim.retryAfterSeconds },
        503,
        { "retry-after": String(claim.retryAfterSeconds) },
      );
    }
    lease = claim.lease;

    const { data, error } = await sheetSyncRpcWithDeadline<Record<string, unknown>>(
      client,
      "ingest_staff_full_reconcile_v4",
      {
        p_request_id: normalized.requestId,
        p_payload_hash: normalized.payloadHash,
        p_payload: normalized.rpcPayload,
      },
      RPC_TIMEOUT_MS,
    );
    if (error) throw new SheetSyncRpcError("staff_full_reconcile_rpc_failed", error);
    if (!isTerminalBankRequestSuccess(data)) {
      const retryable = data?.retryable === true;
      return response(
        data && typeof data === "object" ? data : { ok: false, error: "database_ingest_failed" },
        retryable ? 503 : 422,
        retryable ? { "retry-after": "5" } : {},
      );
    }
    return response(data);
  } catch (error) {
    if (error instanceof SheetSyncDeadlineError) {
      preserveLeaseUntilExpiry = true;
      console.error("staff-full-reconcile deadline", { rpc: error.rpcName });
      return response({ ok: false, error: "database_timeout" }, 503, { "retry-after": "30" });
    }
    if (error instanceof SheetSyncRpcError && sheetSyncDatabaseErrorIsRetryable(error)) {
      return response({ ok: false, error: "sync_busy" }, 503, { "retry-after": "5" });
    }
    console.error("staff-full-reconcile failed", {
      error: error instanceof Error ? error.name : "unexpected_error",
    });
    return response({ ok: false, error: "sync_request_failed" }, 500);
  } finally {
    if (lease && !preserveLeaseUntilExpiry) {
      try {
        await releaseSheetSyncLease(client, lease);
      } catch (error) {
        console.warn("staff-full-reconcile lease_release_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }
});
