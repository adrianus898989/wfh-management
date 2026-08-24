import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { normalizeSnapshot, sha256Hex } from "./normalize.ts";

const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
// This committed SHA-256 digest is the sole authoritative credential for this
// deployment. The corresponding high-entropy raw token remains outside source
// control. Rotation requires changing this digest and deploying new code.
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

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
    }
    const payload = JSON.parse(rawBody);
    const normalized = await normalizeSnapshot(payload);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("runtime_credentials_unavailable");

    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "x-attendance-sync": "august-2026-v1" } },
    });
    const { data, error } = await client.rpc("ingest_august_attendance_snapshot", {
      p_payload: normalized,
    });
    if (error) {
      console.error("attendance-sheet-sync rpc_failed", {
        request_id: normalized.request_id,
        source_key: normalized.source.source_key,
        code: error.code,
      });
      return jsonResponse({ ok: false, error: "database_ingest_failed", request_id: normalized.request_id }, 500);
    }
    if (!data?.ok) {
      console.error("attendance-sheet-sync ingest_rejected", {
        request_id: normalized.request_id,
        source_key: normalized.source.source_key,
        run_id: data?.run_id,
      });
      return jsonResponse(data, 422);
    }
    return jsonResponse(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected_error";
    const clientSafe = /^(invalid_|source_not_allowlisted|sheet_|snapshot_|values_|cell_|date_|payload_|sheet_row_|sheet_column_)/.test(message)
      ? message
      : "sync_request_failed";
    console.error("attendance-sheet-sync request_failed", { error: message });
    return jsonResponse({ ok: false, error: clientSafe }, 400);
  }
});
