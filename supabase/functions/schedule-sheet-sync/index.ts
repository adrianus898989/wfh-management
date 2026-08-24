import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { normalizeSnapshot, sha256Hex } from "./normalize.ts";

const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
// The raw high-entropy token remains only in Google Script Properties. This is
// the same committed digest used by the attendance push endpoint, allowing the
// trusted operator to reuse that existing raw token without exposing it here.
const EXPECTED_TOKEN_SHA256 = "32c9484536652a282ba31becb2dde899992a6f7c403c901e0598e9ff5e1340be";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
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

  // Authenticate before reading/parsing the request body. Google Apps Script
  // cannot mint a Supabase user JWT, so this function is deployed with
  // verify_jwt=false and uses this dedicated high-entropy credential instead.
  const suppliedToken = request.headers.get("x-schedule-sync-token") ?? "";
  if (!suppliedToken) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  const suppliedTokenHash = await sha256Hex(suppliedToken);
  if (!constantTimeEqual(suppliedTokenHash, EXPECTED_TOKEN_SHA256)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
  }

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
    }
    const normalized = await normalizeSnapshot(JSON.parse(rawBody));

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("runtime_credentials_unavailable");

    const service = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "x-schedule-sync": "private-roster-v1" } },
    });
    const { data, error } = await service.rpc("ingest_schedule_roster_snapshot", {
      p_payload: normalized,
    });
    if (error) {
      console.error("schedule-sheet-sync rpc_failed", {
        request_id: normalized.request_id,
        code: error.code,
      });
      return jsonResponse({ ok: false, error: "database_ingest_failed", request_id: normalized.request_id }, 500);
    }
    if (!data?.ok) {
      console.error("schedule-sheet-sync ingest_rejected", {
        request_id: normalized.request_id,
        run_id: data?.run_id,
        error_code: data?.error_code,
      });
      return jsonResponse({
        ok: false,
        error: "database_ingest_rejected",
        request_id: normalized.request_id,
        run_id: data?.run_id,
      }, 422);
    }
    return jsonResponse(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected_error";
    const clientSafe = /^(invalid_|source_not_allowlisted|sheet_|snapshot_|values_|cell_|payload_)/.test(message)
      ? message
      : "sync_request_failed";
    console.error("schedule-sheet-sync request_failed", { error: message });
    return jsonResponse({ ok: false, error: clientSafe }, 400);
  }
});
