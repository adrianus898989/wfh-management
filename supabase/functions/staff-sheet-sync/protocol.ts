export const STAFF_SYNC_MAX_BATCH = 8;

export const STAFF_SHEETS = {
  current: "在职名单 Current Staff List",
  onsite: "现场转居家",
  bank: "银行信息",
} as const;

export type StaffSyncRoute = "employee-master" | "bank-v2" | "onsite-v20";

export type StaffSyncItem = {
  sheet_name: string;
  row_number: number;
  row: Record<string, unknown>;
  audit_context: Record<string, unknown>;
};

export type NormalizedStaffSyncRequest = {
  action: "sheet_row_changed" | "sheet_batch_sync";
  route: StaffSyncRoute;
  items: StaffSyncItem[];
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

export async function staffSyncSecretIsValid(
  expectedSecret: string,
  headerSecret: string,
  body: unknown,
): Promise<boolean> {
  const expected = String(expectedSecret ?? "");
  const supplied = String(headerSecret || object(body).secret || "");
  if (!expected || !supplied) return false;
  return secureEqual(await sha256Hex(supplied), await sha256Hex(expected));
}

function normalizeItem(value: unknown, forcedSheet = ""): StaffSyncItem {
  const item = object(value);
  const sheetName = forcedSheet || text(item.sheet_name);
  const rowNumber = Number(item.row_number ?? 0);
  if (!sheetName) throw new Error("invalid_sheet_name");
  if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 1_000_000) {
    throw new Error("invalid_row_number");
  }
  const row = object(item.row);
  if (Object.keys(row).length === 0) throw new Error("invalid_row");
  return {
    sheet_name: sheetName,
    row_number: rowNumber,
    row,
    audit_context: object(item.audit_context),
  };
}

function resolveRoute(action: string, sheetNames: string[]): StaffSyncRoute {
  if (action === "schedule_row_changed" || action === "schedule_batch_sync") {
    return "employee-master";
  }
  if (action === "bank_row_changed" || action === "bank_batch_changed") {
    return "bank-v2";
  }
  if (sheetNames.length !== 1) throw new Error("mixed_sources_not_allowed");
  const sheetName = sheetNames[0];
  if (sheetName === STAFF_SHEETS.current || sheetName === "填表") return "employee-master";
  if (sheetName === STAFF_SHEETS.bank) return "bank-v2";
  if (sheetName === STAFF_SHEETS.onsite) return "onsite-v20";
  throw new Error("unsupported_sheet");
}

export async function normalizeStaffSyncRequest(
  value: unknown,
): Promise<NormalizedStaffSyncRequest> {
  const body = object(value);
  const rawAction = text(body.action || "sheet_row_changed").toLowerCase();
  const accepted = new Set([
    "sheet_row_changed",
    "sheet_batch_sync",
    "schedule_row_changed",
    "schedule_batch_sync",
    "bank_row_changed",
    "bank_batch_changed",
  ]);
  if (!accepted.has(rawAction)) throw new Error("invalid_action");

  const isBatch = rawAction.endsWith("batch_sync") || rawAction.endsWith("batch_changed");
  const rawItems = isBatch
    ? (Array.isArray(body.items) ? body.items : [])
    : [body];
  if (rawItems.length < 1 || rawItems.length > STAFF_SYNC_MAX_BATCH) {
    throw new Error("invalid_batch_size");
  }

  const forcedSheet = rawAction.startsWith("schedule_")
    ? "填表"
    : rawAction.startsWith("bank_")
    ? STAFF_SHEETS.bank
    : "";
  const items = rawItems.map((item) => normalizeItem(item, forcedSheet));
  const sheetNames = Array.from(new Set(items.map((item) => item.sheet_name)));
  const route = resolveRoute(rawAction, sheetNames);
  const action = isBatch ? "sheet_batch_sync" : "sheet_row_changed";
  const rpcPayload = {
    protocol_version: "staff-sheet-sync-v20",
    action,
    items,
  };
  const payloadHash = await sha256Hex(stableStringify(rpcPayload));
  const suppliedRequestId = text(body.request_id);
  if (suppliedRequestId && !/^[A-Za-z0-9._:-]{8,128}$/.test(suppliedRequestId)) {
    throw new Error("invalid_request_id");
  }
  const requestId = suppliedRequestId || `staff-v20:${payloadHash}`;

  return { action, route, items, requestId, payloadHash, rpcPayload };
}

export function isStrictSuccess(value: unknown): boolean {
  const body = object(value);
  return body.ok === true && body.paused !== true && !body.error;
}
