import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { normalizeInbound, normalizeReceipts, requireUuid, sha256Hex } from "./protocol.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;
const EXPECTED_TOKEN_SHA256 = "32c9484536652a282ba31becb2dde899992a6f7c403c901e0598e9ff5e1340be";
const SAFE_RPC_ERRORS = [
  "employee_not_found",
  "canonical_employee_id_ambiguous",
  "external_id_route_mismatch",
  "external_id_source_slot_mismatch",
  "google_source_slot_identity_conflict",
] as const;

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});

function secureEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function rpcFailure(prefix: string, error: { code?: string; message?: string }): never {
  const message = String(error.message ?? "");
  const safe = SAFE_RPC_ERRORS.find((candidate) => message.includes(candidate));
  throw new Error(safe ?? `${prefix}:${error.code ?? "unknown"}`);
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return response({ ok: false, error: "method_not_allowed" }, 405);
  const expectedHash = (Deno.env.get("ADJUSTMENT_SYNC_TOKEN_SHA256") ?? EXPECTED_TOKEN_SHA256).trim().toLowerCase();
  const token = request.headers.get("x-adjustment-sync-token") ?? "";
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || !token || !secureEqual(await sha256Hex(token), expectedHash)) {
    return response({ ok: false, error: "unauthorized" }, 401);
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return response({ ok: false, error: "payload_too_large" }, 413);
  }

  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
      return response({ ok: false, error: "payload_too_large" }, 413);
    }
    const body = JSON.parse(raw) as Record<string, unknown>;
    const action = String(body.action ?? "").trim().toLowerCase();
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) throw new Error("runtime_credentials_unavailable");
    const client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "x-adjustment-sync": "adjustment-v1" } },
    });

    if (action === "pull") {
      const workerId = requireUuid(body.worker_id, "worker_id");
      const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 100);
      const { data, error } = await client.rpc("claim_adjustment_sheet_outbox", {
        p_worker_id: workerId,
        p_limit: Math.trunc(limit),
        p_lease_seconds: 90,
      });
      if (error) rpcFailure("rpc_pull", error);
      return response(data);
    }

    if (action === "ack") {
      const workerId = requireUuid(body.worker_id, "worker_id");
      const receipts = normalizeReceipts(body.receipts);
      const { data, error } = await client.rpc("ack_adjustment_sheet_outbox", {
        p_worker_id: workerId,
        p_receipts: receipts,
      });
      if (error) rpcFailure("rpc_ack", error);
      return response(data);
    }

    if (action === "inbound") {
      const payload = await normalizeInbound(body);
      const { data, error } = await client.rpc("ingest_adjustment_sheet_inbound", { p_payload: payload });
      if (error) rpcFailure("rpc_inbound", error);
      return response(data);
    }

    return response({ ok: false, error: "invalid_action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected_error";
    const safe = /^(invalid_|source_not_allowlisted|currency_does_not_match_workbook|employee_not_found|canonical_employee_id_ambiguous|external_id_|google_source_slot_identity_conflict)/.test(message)
      ? message
      : "sync_request_failed";
    console.error("adjustment-sheet-sync failed", { error: message.split(":")[0] });
    return response({ ok: false, error: safe }, safe === "sync_request_failed" ? 500 : 400);
  }
});
