export type WorkbookKey = "onsite" | "home_vim" | "home_ph";
export type SourceSlot = "primary" | "first_half" | "second_half";

export type Route = {
  sourceKey: string;
  workbookKey: WorkbookKey;
  month: string;
  spreadsheetId: string;
  sheetGid: string;
  currency: "USD" | "PHP";
  layout: "standard" | "philippines";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTHS = ["2026-09", "2026-10", "2026-11", "2026-12"] as const;
const WORKBOOKS = {
  onsite: {
    spreadsheetId: "1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg",
    sheetGid: "1011694934",
    currency: "USD",
    layout: "standard",
  },
  home_vim: {
    spreadsheetId: "1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ",
    sheetGid: "3368572",
    currency: "USD",
    layout: "standard",
  },
  home_ph: {
    spreadsheetId: "1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ",
    sheetGid: "687407921",
    currency: "PHP",
    layout: "philippines",
  },
} as const;

export const ROUTES: Readonly<Record<string, Route>> = Object.freeze(
  Object.fromEntries(Object.entries(WORKBOOKS).flatMap(([workbookKey, workbook]) =>
    MONTHS.map((month) => {
      const sourceKey = `adjustment_${workbookKey}_${month.replace("-", "_")}`;
      return [sourceKey, {
        sourceKey,
        workbookKey: workbookKey as WorkbookKey,
        month,
        ...workbook,
      }];
    })
  )),
);

const text = (value: unknown) => String(value ?? "").trim();

function requireSourceSlot(value: unknown, route: Route): SourceSlot {
  const sourceSlot = text(value).toLowerCase();
  if (route.layout === "standard" && sourceSlot === "primary") return sourceSlot;
  if (route.layout === "philippines" && (sourceSlot === "first_half" || sourceSlot === "second_half")) {
    return sourceSlot;
  }
  throw new Error("invalid_source_slot");
}

export function requireUuid(value: unknown, field: string): string {
  const normalized = text(value).toLowerCase();
  if (!UUID.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
}

function requireDate(value: unknown, month: string): string {
  const normalized = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || normalized.slice(0, 7) !== month) {
    throw new Error("invalid_event_date");
  }
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new Error("invalid_event_date");
  }
  return normalized;
}

function requireAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100_000_000) {
    throw new Error("invalid_signed_amount");
  }
  return Math.round(amount * 100) / 100;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stable(nested)]));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stable(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function normalizeInbound(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_payload");
  const payload = value as Record<string, unknown>;
  const requestId = requireUuid(payload.request_id, "request_id");
  const sourceKey = text(payload.source_key);
  const route = ROUTES[sourceKey];
  if (!route) throw new Error("source_not_allowlisted");
  if (!Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 200) {
    throw new Error("invalid_rows");
  }

  const seenExternalIds = new Set<string>();
  const seenCoordinates = new Set<string>();
  const rows = payload.rows.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid_inbound_row");
    const row = entry as Record<string, unknown>;
    const origin = text(row.origin).toLowerCase();
    if (origin !== "google" && origin !== "supabase") throw new Error("invalid_origin");
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid_revision");
    const currency = text(row.currency).toUpperCase();
    if (currency !== route.currency) throw new Error("currency_does_not_match_workbook");
    const note = text(row.note);
    const category = text(row.category);
    const employeeName = text(row.employee_name);
    const employeeNo = text(row.employee_no).toUpperCase();
    if (!note || note.length > 4000 || !employeeName || !employeeNo || employeeNo.length > 100) {
      throw new Error("invalid_inbound_row");
    }
    if (category.length > 200 || !category) {
      throw new Error("invalid_adjustment_category");
    }
    const googleRow = Number(row.google_row);
    if (!Number.isSafeInteger(googleRow) || googleRow < 3) throw new Error("invalid_google_row");
    const externalId = requireUuid(row.external_id, "external_id");
    const sourceSlot = requireSourceSlot(row.source_slot, route);
    const coordinate = `${googleRow}:${sourceSlot}`;
    if (seenExternalIds.has(externalId)) throw new Error("invalid_duplicate_external_id");
    if (seenCoordinates.has(coordinate)) throw new Error("invalid_duplicate_source_slot");
    seenExternalIds.add(externalId);
    seenCoordinates.add(coordinate);
    return {
      external_id: externalId,
      origin,
      revision,
      source_slot: sourceSlot,
      event_date: requireDate(row.event_date, route.month),
      signed_amount: requireAmount(row.signed_amount),
      currency,
      employee_no: employeeNo,
      employee_name: employeeName,
      category: category || null,
      note,
      google_row: googleRow,
    };
  });

  const payloadHash = await sha256Hex(stableStringify({ source_key: sourceKey, rows }));
  return {
    request_id: requestId,
    source_key: sourceKey,
    payload_hash: payloadHash,
    rows,
  };
}

export function normalizeReceipts(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid_receipts");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid_receipt");
    const receipt = entry as Record<string, unknown>;
    const outboxId = text(receipt.outbox_id);
    const revision = Number(receipt.revision);
    const status = text(receipt.status).toLowerCase();
    if (!/^\d+$/.test(outboxId) || !Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("invalid_receipt_identity");
    }
    if (!(["ok", "retry", "fatal"] as string[]).includes(status)) throw new Error("invalid_receipt_status");
    const normalized: Record<string, unknown> = {
      outbox_id: outboxId,
      external_id: requireUuid(receipt.external_id, "external_id"),
      revision,
      status,
    };
    if (status === "ok") {
      const sheetRow = Number(receipt.sheet_row);
      if (!Number.isSafeInteger(sheetRow) || sheetRow < 3) throw new Error("invalid_google_row");
      normalized.sheet_row = sheetRow;
      normalized.sheet_gid = text(receipt.sheet_gid);
      normalized.sheet_name = text(receipt.sheet_name).slice(0, 200);
    } else {
      normalized.error = text(receipt.error).slice(0, 1000) || "google_write_failed";
    }
    return normalized;
  });
}
