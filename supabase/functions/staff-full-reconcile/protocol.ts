export const STAFF_FULL_RECONCILE_MAX_BATCH = 8;
export const STAFF_BANK_BINDING_HEADER = "__WFH员工ID";

export type BankSyncItem = {
  row_number: number;
  row: Record<string, unknown>;
  source_name_count?: number;
};

export type NormalizedStaffFullReconcileRequest = {
  action: "bank_row_changed" | "bank_batch_changed" | "bank_binding_dry_run";
  items: BankSyncItem[];
  requestId: string;
  payloadHash: string;
  rpcPayload: Record<string, unknown>;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().filter((key) => source[key] !== undefined).map((key) => (
    `${JSON.stringify(key)}:${stableStringify(source[key])}`
  )).join(",")}}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function secureEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function staffFullReconcileSecretIsValid(
  expectedSecret: string,
  headerSecret: string,
  body: unknown,
): Promise<boolean> {
  const expected = String(expectedSecret ?? "");
  const supplied = String(headerSecret || object(body).secret || "");
  if (!expected || !supplied) return false;
  return secureEqual(await sha256Hex(supplied), await sha256Hex(expected));
}

function normalizeItem(value: unknown, action: string): BankSyncItem {
  const item = object(value);
  const rowNumber = Number(item.row_number ?? 0);
  if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 1_000_000) {
    throw new Error("invalid_row_number");
  }
  const row = object(item.row);
  if (Object.keys(row).length === 0) throw new Error("invalid_row");
  const binding = text(row[STAFF_BANK_BINDING_HEADER]);
  // Writes always require the hidden binding. The dry-run is the only path
  // allowed to plan a binding from a name, and it also requires the caller to
  // prove that the normalized name occurs exactly once in the whole source
  // sheet. The database independently requires a unique employee-name match.
  if (action !== "bank_binding_dry_run" && !binding) {
    throw new Error("missing_employee_binding");
  }
  if (action === "bank_binding_dry_run") {
    const sourceNameCount = Number(item.source_name_count ?? 0);
    if (!Number.isInteger(sourceNameCount) || sourceNameCount < 1 || sourceNameCount > 1_000_000) {
      throw new Error("invalid_source_name_count");
    }
    if (!text(row["FULL NAME / 姓名"])) throw new Error("missing_employee_name");
    return { row_number: rowNumber, row, source_name_count: sourceNameCount };
  }
  return { row_number: rowNumber, row };
}

export async function normalizeStaffFullReconcileRequest(
  value: unknown,
): Promise<NormalizedStaffFullReconcileRequest> {
  const body = object(value);
  const action = text(body.action).toLowerCase();
  if (action !== "bank_row_changed" && action !== "bank_batch_changed" && action !== "bank_binding_dry_run") {
    throw new Error("invalid_action");
  }
  const rawItems = action === "bank_batch_changed" || action === "bank_binding_dry_run"
    ? (Array.isArray(body.items) ? body.items : [])
    : [body];
  if (rawItems.length < 1 || rawItems.length > STAFF_FULL_RECONCILE_MAX_BATCH) {
    throw new Error("invalid_batch_size");
  }
  const items = rawItems.map((item) => normalizeItem(item, action));
  const rpcPayload = {
    protocol_version: "staff-full-reconcile-v4",
    action,
    items,
  };
  const payloadHash = await sha256Hex(stableStringify(rpcPayload));
  const suppliedRequestId = text(body.request_id);
  if (suppliedRequestId && !/^[A-Za-z0-9._:-]{8,128}$/.test(suppliedRequestId)) {
    throw new Error("invalid_request_id");
  }
  const requestId = suppliedRequestId || `bank-v4:${payloadHash}`;
  return { action, items, requestId, payloadHash, rpcPayload };
}

export function isTerminalBankRequestSuccess(value: unknown): boolean {
  const body = object(value);
  if (body.ok !== true || body.paused === true || body.error) return false;
  if (body.dry_run === true) return body.write_performed === false;
  if (body.completed === true && typeof body.write_performed === "boolean") return true;
  return body.write_performed === true;
}
