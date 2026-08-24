export const PARSER_VERSION = "2026-08-a-n-v1";

export type SourceConfig = {
  sourceKey: "home_2026_08" | "onsite_2026_08";
  spreadsheetId: string;
  sheetGid: string;
  tabName: "休假填表";
  sourceGroup: "home" | "onsite_to_home";
  maxRows: number;
  allowedDateFrom: "2026-08-01";
  allowedDateToExclusive: "2026-10-01";
};

export const ALLOWED_SOURCES: readonly SourceConfig[] = [
  {
    sourceKey: "home_2026_08",
    spreadsheetId: "10H-0oYe-D6v3xRu9vGxatizi4P11J8WYk20s3_XPus8",
    sheetGid: "2111783822",
    tabName: "休假填表",
    sourceGroup: "home",
    maxRows: 3000,
    allowedDateFrom: "2026-08-01",
    allowedDateToExclusive: "2026-10-01",
  },
  {
    sourceKey: "onsite_2026_08",
    spreadsheetId: "100xfv19w6zD1bdK0MVLd5kdQtOp8obzrBvI8eE2OUZo",
    sheetGid: "1309516899",
    tabName: "休假填表",
    sourceGroup: "onsite_to_home",
    maxRows: 1000,
    allowedDateFrom: "2026-08-01",
    allowedDateToExclusive: "2026-10-01",
  },
] as const;

export type NormalizedRecord = {
  source_block: "attendance" | "resignation" | "adjustment";
  source_row: number;
  source_item_key: "primary";
  kind: "attendance" | "resignation" | "adjustment";
  event_date: string | null;
  event_kind: string;
  reason: string | null;
  note: string | null;
  amount: number | null;
  raw_amount: string | null;
  employee_no_raw: null;
  employee_name_raw: string;
  employee_status_raw: null;
  team_name_raw: null;
  position_name_raw: null;
  country_raw: null;
  platform_raw: null;
  manager_raw: null;
  raw_values: Record<string, string>;
  content_hash: string;
  is_mirror: boolean;
  source_updated_at: string;
};

export type NormalizedSnapshot = {
  request_id: string;
  trigger_kind: "change" | "daily_reconcile" | "manual";
  source: {
    source_key: SourceConfig["sourceKey"];
    spreadsheet_id: string;
    sheet_gid: string;
    tab_name: SourceConfig["tabName"];
  };
  snapshot_hash: string;
  captured_at: string;
  read_row_count: number;
  parser_version: string;
  parse_warning_count: number;
  allow_large_delete: false;
  rows: NormalizedRecord[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const MAX_CELL_LENGTH = 40_000;

const stringValue = (value: unknown) => String(value ?? "").trim();
const nullableText = (value: unknown) => stringValue(value) || null;

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sourceFromPayload(value: unknown): SourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_source");
  const source = value as Record<string, unknown>;
  const match = ALLOWED_SOURCES.find((candidate) =>
    candidate.sourceKey === stringValue(source.source_key) &&
    candidate.spreadsheetId === stringValue(source.spreadsheet_id) &&
    candidate.sheetGid === stringValue(source.sheet_gid) &&
    candidate.tabName === stringValue(source.tab_name)
  );
  if (!match) throw new Error("source_not_allowlisted");
  return match;
}

function assertHeader(values: string[][]): void {
  if (values.length < 2) throw new Error("sheet_headers_missing");
  const header = values[1] ?? [];
  const expected: Array<[number, RegExp]> = [
    [0, /姓名|name/i],
    [1, /原因|reason/i],
    [2, /日期|date/i],
    [3, /备注|note/i],
    [5, /姓名|name/i],
    [6, /原因|reason/i],
    [7, /日期|date/i],
    [8, /备注|note/i],
    [10, /姓名|name/i],
    [11, /金额|金額|amount/i],
    [12, /日期|date/i],
    [13, /备注|note/i],
  ];
  for (const [column, pattern] of expected) {
    if (!pattern.test(stringValue(header[column]))) throw new Error(`sheet_header_mismatch_column_${column + 1}`);
  }
}

function parseSheetDate(value: unknown, source: SourceConfig): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const normalized = raw
    .replace(/[年月/.]/g, "-")
    .replace(/日/g, "")
    .replace(/\s+/g, "");
  let year: number;
  let month: number;
  let day: number;
  let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (!match) throw new Error(`invalid_date:${raw.slice(0, 40)}`);
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 || year > 2200 ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) throw new Error(`invalid_date:${raw.slice(0, 40)}`);
  const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (isoDate < source.allowedDateFrom || isoDate >= source.allowedDateToExclusive) {
    throw new Error(`date_outside_source_window:${raw.slice(0, 40)}`);
  }
  return isoDate;
}

function attendanceEventKind(value: unknown): string {
  const reason = stringValue(value).replace(/\s+/g, "").toLowerCase();
  if (/^(公休|publicholiday)$/.test(reason)) return "public_holiday";
  if (/^(回家|homeleave)$/.test(reason)) return "home_leave";
  if (/^(请假|請假|休假|leave)$/.test(reason)) return "leave";
  if (/^(半天|半日|halfday)$/.test(reason)) return "half_day";
  if (/^(旷工|曠工|缺勤|absence|absent)$/.test(reason)) return "absence";
  if (/^(离职|離職|resignation|resigned)$/.test(reason)) return "resignation";
  return "other";
}

function parseSignedAmount(value: unknown): { amount: number | null; rawAmount: string | null; warning: boolean } {
  const rawAmount = nullableText(value);
  if (!rawAmount) return { amount: null, rawAmount: null, warning: false };
  let normalized = rawAmount
    .replace(/[，,\s]/g, "")
    .replace(/[￥¥$₫]/g, "");
  if (/^\(.+\)$/.test(normalized)) normalized = `-${normalized.slice(1, -1)}`;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return { amount: null, rawAmount, warning: true };
  return { amount, rawAmount, warning: false };
}

function assertCellSizes(values: string[][]): void {
  for (const row of values) {
    for (const cell of row) {
      if (cell.length > MAX_CELL_LENGTH) throw new Error("cell_too_large");
    }
  }
}

type RecordWithoutHash = Omit<NormalizedRecord, "content_hash">;

function baseAuditValues(
  source: SourceConfig,
  block: NormalizedRecord["source_block"],
  row: number,
  name: string,
  rawReason: string,
  rawDate: string,
  rawNote: string,
  rawAmount = "",
): Record<string, string> {
  return {
    spreadsheet_id: source.spreadsheetId,
    source_tab: source.tabName,
    source_group_label: source.sourceGroup,
    source_block: block,
    source_row: String(row),
    raw_name: name,
    raw_reason: rawReason,
    raw_date: rawDate,
    raw_note: rawNote,
    raw_amount: rawAmount,
  };
}

export async function normalizeSnapshot(input: unknown): Promise<NormalizedSnapshot> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_payload");
  const payload = input as Record<string, unknown>;
  const requestId = stringValue(payload.request_id);
  if (!UUID_RE.test(requestId)) throw new Error("invalid_request_id");
  const triggerKind = stringValue(payload.trigger_kind || "change");
  if (!["change", "daily_reconcile", "manual"].includes(triggerKind)) throw new Error("invalid_trigger_kind");
  const source = sourceFromPayload(payload.source);
  const snapshotHash = stringValue(payload.snapshot_hash).toLowerCase();
  if (!SHA256_RE.test(snapshotHash)) throw new Error("invalid_snapshot_hash");
  const captured = new Date(stringValue(payload.captured_at));
  if (!Number.isFinite(captured.getTime())) throw new Error("invalid_captured_at");
  if (!Array.isArray(payload.values)) throw new Error("values_must_be_array");
  if (payload.values.length > source.maxRows) throw new Error("sheet_row_limit_exceeded");

  const rawValues = payload.values.map((row) => {
    if (!Array.isArray(row)) throw new Error("sheet_row_must_be_array");
    if (row.length > 14) throw new Error("sheet_column_limit_exceeded");
    const cells = row.map((cell) => String(cell ?? ""));
    while (cells.length < 14) cells.push("");
    return cells;
  });
  assertCellSizes(rawValues);
  assertHeader(rawValues);
  // Hash the display strings byte-for-byte as Apps Script sent them. Trimming
  // before this check would reject legitimate leading/trailing sheet spaces.
  const computedHash = await sha256Hex(JSON.stringify(rawValues));
  if (computedHash !== snapshotHash) throw new Error("snapshot_hash_mismatch");
  const values = rawValues.map((row) => row.map(stringValue));

  const rows: RecordWithoutHash[] = [];
  let parseWarningCount = 0;
  for (let index = 2; index < values.length; index += 1) {
    const cells = values[index];
    const rawCells = rawValues[index];
    const sourceRow = index + 1;

    const attendanceName = stringValue(cells[0]);
    if (attendanceName) {
      const rawName = rawCells[0];
      const rawReason = rawCells[1];
      const rawDate = rawCells[2];
      const rawNote = rawCells[3];
      const eventKind = attendanceEventKind(rawReason);
      if (eventKind === "other") parseWarningCount += 1;
      rows.push({
        source_block: "attendance",
        source_row: sourceRow,
        source_item_key: "primary",
        kind: "attendance",
        event_date: parseSheetDate(rawDate, source),
        event_kind: eventKind,
        reason: nullableText(rawReason),
        note: nullableText(rawNote),
        amount: null,
        raw_amount: null,
        employee_no_raw: null,
        employee_name_raw: attendanceName,
        employee_status_raw: null,
        team_name_raw: null,
        position_name_raw: null,
        country_raw: null,
        platform_raw: null,
        manager_raw: null,
        raw_values: baseAuditValues(source, "attendance", sourceRow, rawName, rawReason, rawDate, rawNote),
        is_mirror: eventKind === "resignation",
        source_updated_at: captured.toISOString(),
      });
    }

    const resignationName = stringValue(cells[5]);
    if (resignationName) {
      const rawName = rawCells[5];
      const rawReason = rawCells[6];
      const rawDate = rawCells[7];
      const rawNote = rawCells[8];
      rows.push({
        source_block: "resignation",
        source_row: sourceRow,
        source_item_key: "primary",
        kind: "resignation",
        event_date: parseSheetDate(rawDate, source),
        event_kind: "resignation",
        reason: nullableText(rawReason) ?? "离职",
        note: nullableText(rawNote),
        amount: null,
        raw_amount: null,
        employee_no_raw: null,
        employee_name_raw: resignationName,
        employee_status_raw: null,
        team_name_raw: null,
        position_name_raw: null,
        country_raw: null,
        platform_raw: null,
        manager_raw: null,
        raw_values: baseAuditValues(source, "resignation", sourceRow, rawName, rawReason, rawDate, rawNote),
        is_mirror: false,
        source_updated_at: captured.toISOString(),
      });
    }

    const adjustmentName = stringValue(cells[10]);
    if (adjustmentName) {
      const rawName = rawCells[10];
      const rawAmountValue = rawCells[11];
      const rawDate = rawCells[12];
      const rawNote = rawCells[13];
      const { amount, rawAmount, warning } = parseSignedAmount(rawAmountValue);
      if (warning) parseWarningCount += 1;
      const eventKind = amount === null || amount === 0 ? "adjustment" : amount > 0 ? "bonus" : "deduction";
      rows.push({
        source_block: "adjustment",
        source_row: sourceRow,
        source_item_key: "primary",
        kind: "adjustment",
        event_date: parseSheetDate(rawDate, source),
        event_kind: eventKind,
        reason: null,
        note: nullableText(rawNote),
        amount,
        raw_amount: rawAmount,
        employee_no_raw: null,
        employee_name_raw: adjustmentName,
        employee_status_raw: null,
        team_name_raw: null,
        position_name_raw: null,
        country_raw: null,
        platform_raw: null,
        manager_raw: null,
        raw_values: baseAuditValues(
          source,
          "adjustment",
          sourceRow,
          rawName,
          "",
          rawDate,
          rawNote,
          rawAmountValue,
        ),
        is_mirror: false,
        source_updated_at: captured.toISOString(),
      });
    }
  }

  const normalizedRows: NormalizedRecord[] = await Promise.all(rows.map(async (row) => {
    // Capture time is audit metadata, not sheet content. Excluding it keeps an
    // unchanged daily reconciliation from rewriting every record.
    const { source_updated_at: _sourceUpdatedAt, ...hashableRow } = row;
    return {
      ...row,
      content_hash: await sha256Hex(JSON.stringify(hashableRow)),
    };
  }));

  return {
    request_id: requestId,
    trigger_kind: triggerKind as NormalizedSnapshot["trigger_kind"],
    source: {
      source_key: source.sourceKey,
      spreadsheet_id: source.spreadsheetId,
      sheet_gid: source.sheetGid,
      tab_name: source.tabName,
    },
    snapshot_hash: snapshotHash,
    captured_at: captured.toISOString(),
    read_row_count: Math.max(values.length - 2, 0),
    parser_version: PARSER_VERSION,
    parse_warning_count: parseWarningCount,
    allow_large_delete: false,
    rows: normalizedRows,
  };
}
