export const PARSER_VERSION = "2026-annual-sep-dec-v5";

type TriggerKind = "change" | "daily_reconcile" | "manual";
type SourceGroup = "home" | "onsite_to_home";
type AnnualLayout = "onsite" | "home_vimm" | "home_ph";

export type LegacySourceConfig = {
  mode: "legacy";
  sourceKey: "home_2026_08" | "onsite_2026_08";
  spreadsheetId: string;
  sheetGid: string;
  tabName: "休假填表";
  sourceGroup: SourceGroup;
  maxRows: number;
  allowedDateFrom: "2026-08-01";
  allowedDateToExclusive: "2026-10-01";
};

export type AnnualSourceConfig = {
  mode: "annual";
  sourceKey: string;
  workbookKey: "onsite" | "home_vimm" | "home_ph";
  spreadsheetId: string;
  sheetGid: string;
  tabName: string;
  leaveSheetGid: string;
  leaveTabName: "休假填表";
  leaveMaxRows: number;
  leaveColumns: 5;
  adjustmentSheetGid: string;
  adjustmentTabName: "奖惩填表";
  sourceGroup: SourceGroup;
  currency: "USD" | "PHP";
  month: `2026-${"09" | "10" | "11" | "12"}`;
  layout: AnnualLayout;
  maxRows: number;
  maxColumns: number;
  adjustmentMaxRows: number;
  adjustmentColumns: 7 | 9;
  adjustmentMetadataColumns: 3 | 6;
  nameColumn: number;
  employeeNoColumn: number;
  countryColumn: number | null;
  fixedCountry: string | null;
  positionColumn: number;
  platformColumn: number;
  dayStartColumn: number;
};

export type SourceConfig = LegacySourceConfig | AnnualSourceConfig;

const LEGACY_SOURCES: readonly LegacySourceConfig[] = [
  {
    mode: "legacy",
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
    mode: "legacy",
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

type AnnualWorkbookDefinition = Omit<AnnualSourceConfig,
  "sourceKey" | "sheetGid" | "tabName" | "month" | "maxColumns"
> & {
  sourcePrefix: string;
  monthGids: Readonly<Record<AnnualSourceConfig["month"], string>>;
};

const ANNUAL_WORKBOOKS: readonly AnnualWorkbookDefinition[] = [
  {
    mode: "annual",
    sourcePrefix: "onsite_annual_2026",
    workbookKey: "onsite",
    spreadsheetId: "1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg",
    leaveSheetGid: "868595464",
    leaveTabName: "休假填表",
    leaveMaxRows: 1600,
    leaveColumns: 5,
    adjustmentSheetGid: "1011694934",
    adjustmentTabName: "奖惩填表",
    sourceGroup: "onsite_to_home",
    currency: "USD",
    layout: "onsite",
    maxRows: 1600,
    adjustmentMaxRows: 1100,
    adjustmentColumns: 7,
    adjustmentMetadataColumns: 3,
    nameColumn: 4,
    employeeNoColumn: 8,
    countryColumn: 5,
    fixedCountry: null,
    positionColumn: 3,
    platformColumn: 2,
    dayStartColumn: 33,
    monthGids: {
      "2026-09": "605098048",
      "2026-10": "938715589",
      "2026-11": "200094426",
      "2026-12": "462628124",
    },
  },
  {
    mode: "annual",
    sourcePrefix: "home_vimm_annual_2026",
    workbookKey: "home_vimm",
    spreadsheetId: "1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ",
    leaveSheetGid: "1582220550",
    leaveTabName: "休假填表",
    leaveMaxRows: 1600,
    leaveColumns: 5,
    adjustmentSheetGid: "3368572",
    adjustmentTabName: "奖惩填表",
    sourceGroup: "home",
    currency: "USD",
    layout: "home_vimm",
    maxRows: 1600,
    adjustmentMaxRows: 1100,
    adjustmentColumns: 7,
    adjustmentMetadataColumns: 3,
    nameColumn: 4,
    employeeNoColumn: 7,
    countryColumn: 5,
    fixedCountry: null,
    positionColumn: 3,
    platformColumn: 2,
    dayStartColumn: 31,
    monthGids: {
      "2026-09": "515895997",
      "2026-10": "2006236394",
      "2026-11": "465666790",
      "2026-12": "527622305",
    },
  },
  {
    mode: "annual",
    sourcePrefix: "home_ph_annual_2026",
    workbookKey: "home_ph",
    spreadsheetId: "1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ",
    leaveSheetGid: "1880767097",
    leaveTabName: "休假填表",
    leaveMaxRows: 1600,
    leaveColumns: 5,
    adjustmentSheetGid: "687407921",
    adjustmentTabName: "奖惩填表",
    sourceGroup: "home",
    currency: "PHP",
    layout: "home_ph",
    maxRows: 1600,
    adjustmentMaxRows: 1100,
    adjustmentColumns: 9,
    adjustmentMetadataColumns: 6,
    nameColumn: 4,
    employeeNoColumn: 5,
    countryColumn: null,
    fixedCountry: "菲律宾",
    positionColumn: 3,
    platformColumn: 2,
    dayStartColumn: 39,
    monthGids: {
      "2026-09": "1827489324",
      "2026-10": "296363311",
      "2026-11": "138573169",
      "2026-12": "787543818",
    },
  },
] as const;

const ANNUAL_MONTHS = ["2026-09", "2026-10", "2026-11", "2026-12"] as const;

const ANNUAL_SOURCES: readonly AnnualSourceConfig[] = ANNUAL_WORKBOOKS.flatMap((workbook) =>
  ANNUAL_MONTHS.map((month) => {
    const days = daysInMonth(month);
    return {
      ...workbook,
      sourceKey: `${workbook.sourcePrefix}_${month.slice(5)}`,
      sheetGid: workbook.monthGids[month],
      tabName: `${Number(month.slice(5))}月`,
      month,
      maxColumns: workbook.dayStartColumn + days + 1,
    };
  })
);

export const ALLOWED_SOURCES: readonly SourceConfig[] = [
  ...LEGACY_SOURCES,
  ...ANNUAL_SOURCES,
];

export type NormalizedRecord = {
  source_block: "attendance" | "resignation" | "adjustment";
  source_row: number;
  source_item_key: string;
  kind: "attendance" | "resignation" | "adjustment";
  event_date: string | null;
  event_kind: string;
  reason: string | null;
  note: string | null;
  amount: number | null;
  raw_amount: string | null;
  currency: "USD" | "PHP" | null;
  employee_no_raw: string | null;
  employee_name_raw: string | null;
  employee_status_raw: string | null;
  team_name_raw: string | null;
  position_name_raw: string | null;
  country_raw: string | null;
  platform_raw: string | null;
  manager_raw: string | null;
  raw_values: Record<string, string>;
  content_hash: string;
  is_mirror: boolean;
  source_updated_at: string;
};

export type NormalizedSnapshot = {
  request_id: string;
  trigger_kind: TriggerKind;
  sync_contract: "august_v1" | "annual_v1";
  source: {
    source_key: string;
    spreadsheet_id: string;
    sheet_gid: string;
    tab_name: string;
    leave_sheet_gid?: string;
    leave_tab_name?: string;
    adjustment_sheet_gid?: string;
    adjustment_tab_name?: string;
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
const headerKey = (value: unknown) => stringValue(value).replace(/[\s\u3000_\-—–/]+/g, "").toLowerCase();

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function daysInMonth(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function sourceFromPayload(value: unknown): SourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_source");
  const source = value as Record<string, unknown>;
  const match = ALLOWED_SOURCES.find((candidate) =>
    candidate.sourceKey === stringValue(source.source_key) &&
    candidate.spreadsheetId === stringValue(source.spreadsheet_id) &&
    candidate.sheetGid === stringValue(source.sheet_gid) &&
    candidate.tabName === stringValue(source.tab_name) &&
    (candidate.mode === "legacy" || (
      candidate.leaveSheetGid === stringValue(source.leave_sheet_gid) &&
      candidate.leaveTabName === stringValue(source.leave_tab_name) &&
      candidate.adjustmentSheetGid === stringValue(source.adjustment_sheet_gid) &&
      candidate.adjustmentTabName === stringValue(source.adjustment_tab_name)
    ))
  );
  if (!match) throw new Error("source_not_allowlisted");
  return match;
}

function assertCellSizes(values: string[][]): void {
  for (const row of values) {
    for (const cell of row) {
      if (cell.length > MAX_CELL_LENGTH) throw new Error("cell_too_large");
    }
  }
}

function normalizeMatrix(value: unknown, maxRows: number, columns: number): string[][] {
  if (!Array.isArray(value)) throw new Error("values_must_be_array");
  if (value.length > maxRows) throw new Error("sheet_row_limit_exceeded");
  const rows = value.map((row) => {
    if (!Array.isArray(row)) throw new Error("sheet_row_must_be_array");
    if (row.length > columns) throw new Error("sheet_column_limit_exceeded");
    const cells = row.map((cell) => String(cell ?? ""));
    while (cells.length < columns) cells.push("");
    return cells;
  });
  assertCellSizes(rows);
  return rows;
}

function assertLegacyHeader(values: string[][]): void {
  if (values.length < 2) throw new Error("sheet_headers_missing");
  const header = values[1] ?? [];
  const expected: Array<[number, RegExp]> = [
    [0, /姓名|name/i], [1, /原因|reason/i], [2, /日期|date/i], [3, /备注|note/i],
    [5, /姓名|name/i], [6, /原因|reason/i], [7, /日期|date/i], [8, /备注|note/i],
    [10, /姓名|name/i], [11, /金额|金額|amount/i], [12, /日期|date/i], [13, /备注|note/i],
  ];
  for (const [column, pattern] of expected) {
    if (!pattern.test(stringValue(header[column]))) throw new Error(`sheet_header_mismatch_column_${column + 1}`);
  }
}

function assertAnnualHeaders(
  attendance: string[][],
  leaves: string[][],
  adjustments: string[][],
  source: AnnualSourceConfig,
  adjustmentSchema: "with_category" | "legacy_without_category" | "philippines",
): void {
  if (attendance.length < 1) throw new Error("sheet_headers_missing");
  const header = attendance[0] ?? [];
  if (!/姓名|name/i.test(stringValue(header[source.nameColumn]))) throw new Error("sheet_header_mismatch_name");
  if (!/^id$/i.test(stringValue(header[source.employeeNoColumn]).replace(/^\t+/, ""))) {
    throw new Error("sheet_header_mismatch_employee_id");
  }
  for (let day = 1; day <= daysInMonth(source.month); day += 1) {
    if (stringValue(header[source.dayStartColumn + day - 1]) !== String(day)) {
      throw new Error(`sheet_header_mismatch_day_${day}`);
    }
  }

  if (leaves.length < 2) throw new Error("leave_headers_missing");
  const monthNumber = String(Number(source.month.slice(5)));
  if (!new RegExp(`^${monthNumber}月份?$`).test(stringValue(leaves[0]?.[0]))) {
    throw new Error("leave_month_header_mismatch");
  }
  const leaveHeader = leaves[1] ?? [];
  const expectedLeave = ["日期", "姓名", "ID", "类型", "备注"];
  for (let column = 0; column < expectedLeave.length; column += 1) {
    if (headerKey(leaveHeader[column]) !== headerKey(expectedLeave[column])) {
      throw new Error(`leave_header_mismatch_column_${column + 1}`);
    }
  }

  if (adjustments.length < 2) throw new Error("adjustment_headers_missing");
  if (!new RegExp(`^${monthNumber}月份?$`).test(stringValue(adjustments[0]?.[0]))) {
    throw new Error("adjustment_month_header_mismatch");
  }
  const adjustmentHeader = adjustments[1] ?? [];
  if (!/姓名|name/i.test(stringValue(adjustmentHeader[0]))) throw new Error("adjustment_header_mismatch_name");
  if (!/^id$/i.test(stringValue(adjustmentHeader[1]).replace(/^\t+/, ""))) {
    throw new Error("adjustment_header_mismatch_employee_id");
  }
  if (source.layout === "home_ph") {
    const expected: Array<[number, RegExp]> = [
      [2, /金额.*1\s*[-–—至]\s*15|amount.*1\s*[-–—to]+\s*15/i],
      [3, /类型|類型|type|category/i],
      [4, /金额.*16\s*[-–—至]\s*末|amount.*16/i],
      [5, /类型|類型|type|category/i],
      [6, /备注.*1\s*[-–—至]\s*15|note.*1\s*[-–—to]+\s*15/i],
      [7, /备注.*16\s*[-–—至]\s*末|note.*16/i],
      [8, /日期|date/i],
    ];
    for (const [column, pattern] of expected) {
      if (!pattern.test(stringValue(adjustmentHeader[column]))) {
        throw new Error(`adjustment_header_mismatch_column_${column + 1}`);
      }
    }
  } else {
    const expected: Array<[number, RegExp]> = adjustmentSchema === "legacy_without_category"
      ? [[2, /奖金|獎金|bonus/i], [3, /扣除|deduction/i], [5, /备注|note/i], [6, /日期|date/i]]
      : [
        [2, /奖金|獎金|bonus/i], [3, /扣除|deduction/i], [4, /类型|類型|type|category/i],
        [5, /备注|note/i], [6, /日期|date/i],
      ];
    if (adjustmentSchema === "legacy_without_category" && stringValue(adjustmentHeader[4])) {
      throw new Error("adjustment_legacy_category_placeholder_not_empty");
    }
    for (const [column, pattern] of expected) {
      if (!pattern.test(stringValue(adjustmentHeader[column]))) {
        throw new Error(`adjustment_header_mismatch_column_${column + 1}`);
      }
    }
  }
}

function parseDate(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const normalized = raw.replace(/[年月/.]/g, "-").replace(/日/g, "").replace(/\s+/g, "");
  let year: number;
  let month: number;
  let day: number;
  let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else {
    match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (!match) throw new Error(`invalid_date:${raw.slice(0, 40)}`);
    month = Number(match[1]); day = Number(match[2]); year = Number(match[3]);
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 || year > 2200 || candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month || candidate.getUTCDate() !== day
  ) throw new Error(`invalid_date:${raw.slice(0, 40)}`);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseLegacyDate(value: unknown, source: LegacySourceConfig): string | null {
  const date = parseDate(value);
  if (date !== null && (date < source.allowedDateFrom || date >= source.allowedDateToExclusive)) {
    throw new Error(`date_outside_source_window:${stringValue(value).slice(0, 40)}`);
  }
  return date;
}

function parseAnnualDate(value: unknown, source: AnnualSourceConfig): string {
  const date = parseDate(value);
  if (!date) throw new Error("adjustment_date_required");
  if (!date.startsWith(`${source.month}-`)) throw new Error(`date_outside_source_month:${date}`);
  return date;
}

function attendanceEventKind(value: unknown): string {
  const reason = stringValue(value).replace(/[\s._-]+/g, "").toLowerCase();
  if (/^(公|公休|休|publicholiday|rest|restday)$/.test(reason)) return "public_holiday";
  if (/^(回|回家|homeleave|home)$/.test(reason)) return "home_leave";
  if (/^(请|請|请假|請假|休假|leave)$/.test(reason)) return "leave";
  if (/^(半|半天|半日|halfday|half)$/.test(reason)) return "half_day";
  if (/^(缺|旷|曠|旷工|曠工|缺勤|缺席|absence|absent)$/.test(reason)) return "absence";
  if (/^(离|離|离职|離職|resignation|resigned)$/.test(reason)) return "resignation";
  return "other";
}

function parseSignedAmount(value: unknown): { amount: number | null; rawAmount: string | null } {
  const rawAmount = nullableText(value);
  if (!rawAmount) return { amount: null, rawAmount: null };
  let normalized = rawAmount.replace(/[，,\s]/g, "").replace(/[￥¥$₫₱]/g, "");
  if (/^\(.+\)$/.test(normalized)) normalized = `-${normalized.slice(1, -1)}`;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) throw new Error(`invalid_adjustment_amount:${rawAmount.slice(0, 40)}`);
  return { amount, rawAmount };
}

type ManagedMetadataState = "empty" | "managed";

function managedAdjustmentMetadataState(
  triplet: readonly string[],
  physicalRow: number,
  slot: string,
): ManagedMetadataState {
  const values = triplet.map(stringValue);
  if (values.every((value) => !value)) return "empty";
  const revision = Number(values[2]);
  if (
    values.length !== 3 ||
    !UUID_RE.test(values[0]) ||
    !["google", "supabase"].includes(values[1].toLowerCase()) ||
    !/^\d+$/.test(values[2]) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error(`adjustment_metadata_invalid:row_${physicalRow}:${slot}`);
  }
  return "managed";
}

function assertAnnualMetadataHeaders(metadata: string[][], source: AnnualSourceConfig): void {
  if (metadata.length < 2) throw new Error("adjustment_metadata_headers_missing");
  const expected = source.layout === "home_ph"
    ? [
      "__sync_first_half_external_id", "__sync_first_half_origin", "__sync_first_half_revision",
      "__sync_second_half_external_id", "__sync_second_half_origin", "__sync_second_half_revision",
    ]
    : ["__sync_external_id", "__sync_origin", "__sync_revision"];
  const header = metadata[1] ?? [];
  for (let column = 0; column < expected.length; column += 1) {
    if (stringValue(header[column]) !== expected[column]) {
      throw new Error(`adjustment_metadata_header_mismatch_column_${column + 1}`);
    }
  }
}

function identityKey(employeeNo: string | null, name: string | null): string {
  if (employeeNo) return `id:${employeeNo.replace(/\s+/g, "").toUpperCase()}`;
  if (name) return `name:${name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()}`;
  throw new Error("employee_identity_required");
}

async function applyStableIdentity(
  row: Omit<NormalizedRecord, "content_hash" | "source_row" | "source_item_key">,
  logicalKey: string,
): Promise<NormalizedRecord> {
  const stableHash = await sha256Hex(logicalKey);
  const sourceRow = (Number.parseInt(stableHash.slice(0, 8), 16) % 2_000_000_000) + 1;
  // Capture time is delivery metadata. Excluding it means a daily reconciliation
  // of unchanged sheet content performs no record updates.
  const { source_updated_at: _sourceUpdatedAt, ...hashableRow } = row;
  const contentHash = await sha256Hex(JSON.stringify(hashableRow));
  return {
    ...row,
    source_row: sourceRow,
    source_item_key: `v1:${stableHash}`,
    content_hash: contentHash,
  };
}

type RecordWithoutHash = Omit<NormalizedRecord, "content_hash">;

function legacyAuditValues(
  source: LegacySourceConfig,
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

async function normalizeLegacySnapshot(
  payload: Record<string, unknown>,
  source: LegacySourceConfig,
  capturedAt: string,
  snapshotHash: string,
): Promise<{ rows: NormalizedRecord[]; readRowCount: number; warningCount: number }> {
  const rawValues = normalizeMatrix(payload.values, source.maxRows, 14);
  assertLegacyHeader(rawValues);
  if (await sha256Hex(JSON.stringify(rawValues)) !== snapshotHash) throw new Error("snapshot_hash_mismatch");
  const values = rawValues.map((row) => row.map(stringValue));
  const rows: RecordWithoutHash[] = [];
  let warningCount = 0;

  for (let index = 2; index < values.length; index += 1) {
    const cells = values[index];
    const rawCells = rawValues[index];
    const sourceRow = index + 1;
    const attendanceName = nullableText(cells[0]);
    if (attendanceName) {
      const eventKind = attendanceEventKind(cells[1]);
      if (eventKind === "other") warningCount += 1;
      rows.push({
        source_block: "attendance", source_row: sourceRow, source_item_key: "primary", kind: "attendance",
        event_date: parseLegacyDate(cells[2], source), event_kind: eventKind, reason: nullableText(cells[1]),
        note: nullableText(cells[3]), amount: null, raw_amount: null, currency: null, employee_no_raw: null,
        employee_name_raw: attendanceName, employee_status_raw: null, team_name_raw: null,
        position_name_raw: null, country_raw: null, platform_raw: null, manager_raw: null,
        raw_values: legacyAuditValues(source, "attendance", sourceRow, rawCells[0], rawCells[1], rawCells[2], rawCells[3]),
        is_mirror: eventKind === "resignation", source_updated_at: capturedAt,
      });
    }
    const resignationName = nullableText(cells[5]);
    if (resignationName) {
      rows.push({
        source_block: "resignation", source_row: sourceRow, source_item_key: "primary", kind: "resignation",
        event_date: parseLegacyDate(cells[7], source), event_kind: "resignation", reason: nullableText(cells[6]) ?? "离职",
        note: nullableText(cells[8]), amount: null, raw_amount: null, currency: null, employee_no_raw: null,
        employee_name_raw: resignationName, employee_status_raw: null, team_name_raw: null,
        position_name_raw: null, country_raw: null, platform_raw: null, manager_raw: null,
        raw_values: legacyAuditValues(source, "resignation", sourceRow, rawCells[5], rawCells[6], rawCells[7], rawCells[8]),
        is_mirror: false, source_updated_at: capturedAt,
      });
    }
    const adjustmentName = nullableText(cells[10]);
    if (adjustmentName) {
      let parsed: { amount: number | null; rawAmount: string | null };
      try {
        parsed = parseSignedAmount(rawCells[11]);
      } catch (_error) {
        parsed = { amount: null, rawAmount: nullableText(rawCells[11]) };
        warningCount += 1;
      }
      const eventKind = parsed.amount === null || parsed.amount === 0 ? "adjustment" : parsed.amount > 0 ? "bonus" : "deduction";
      rows.push({
        source_block: "adjustment", source_row: sourceRow, source_item_key: "primary", kind: "adjustment",
        event_date: parseLegacyDate(cells[12], source), event_kind: eventKind, reason: null,
        note: nullableText(cells[13]), amount: parsed.amount, raw_amount: parsed.rawAmount, currency: null,
        employee_no_raw: null, employee_name_raw: adjustmentName, employee_status_raw: null,
        team_name_raw: null, position_name_raw: null, country_raw: null, platform_raw: null, manager_raw: null,
        raw_values: legacyAuditValues(source, "adjustment", sourceRow, rawCells[10], "", rawCells[12], rawCells[13], rawCells[11]),
        is_mirror: false, source_updated_at: capturedAt,
      });
    }
  }

  const normalizedRows = await Promise.all(rows.map(async (row) => {
    const { source_updated_at: _sourceUpdatedAt, ...hashableRow } = row;
    return { ...row, content_hash: await sha256Hex(JSON.stringify(hashableRow)) };
  }));
  return { rows: normalizedRows, readRowCount: Math.max(values.length - 2, 0), warningCount };
}

async function normalizeAnnualSnapshot(
  payload: Record<string, unknown>,
  source: AnnualSourceConfig,
  capturedAt: string,
  snapshotHash: string,
): Promise<{ rows: NormalizedRecord[]; readRowCount: number; warningCount: number }> {
  if (!payload.values || typeof payload.values !== "object" || Array.isArray(payload.values)) {
    throw new Error("values_must_be_object");
  }
  const snapshot = payload.values as Record<string, unknown>;
  const adjustmentSchemaSupplied = Object.prototype.hasOwnProperty.call(snapshot, "adjustment_schema");
  const adjustmentSchemaRaw = stringValue(snapshot.adjustment_schema) ||
    (source.layout === "home_ph" ? "philippines" : "with_category");
  if (source.layout === "home_ph" ? adjustmentSchemaRaw !== "philippines" :
    !["with_category", "legacy_without_category"].includes(adjustmentSchemaRaw)) {
    throw new Error("invalid_adjustment_schema");
  }
  const adjustmentSchema = adjustmentSchemaRaw as
    "with_category" | "legacy_without_category" | "philippines";
  const attendanceRaw = normalizeMatrix(snapshot.attendance, source.maxRows, source.maxColumns);
  const leavesRaw = normalizeMatrix(snapshot.leaves, source.leaveMaxRows, source.leaveColumns);
  const adjustmentsRaw = normalizeMatrix(snapshot.adjustments, source.adjustmentMaxRows, source.adjustmentColumns);
  const metadataRaw = normalizeMatrix(
    snapshot.adjustment_metadata,
    source.adjustmentMaxRows,
    source.adjustmentMetadataColumns,
  );
  if (metadataRaw.length !== adjustmentsRaw.length) throw new Error("adjustment_metadata_row_count_mismatch");
  assertAnnualHeaders(attendanceRaw, leavesRaw, adjustmentsRaw, source, adjustmentSchema);
  assertAnnualMetadataHeaders(metadataRaw, source);
  const canonicalSnapshot = {
    attendance: attendanceRaw,
    leaves: leavesRaw,
    adjustments: adjustmentsRaw,
    adjustment_metadata: metadataRaw,
    ...(adjustmentSchemaSupplied ? { adjustment_schema: adjustmentSchema } : {}),
  };
  if (await sha256Hex(JSON.stringify(canonicalSnapshot)) !== snapshotHash) throw new Error("snapshot_hash_mismatch");

  const attendance = attendanceRaw.map((row) => row.map(stringValue));
  const leaves = leavesRaw.map((row) => row.map(stringValue));
  const adjustments = adjustmentsRaw.map((row) => row.map(stringValue));
  const adjustmentMetadata = metadataRaw.map((row) => row.map(stringValue));
  type PendingAnnualRecord = Omit<NormalizedRecord, "content_hash" | "source_row" | "source_item_key">;
  const pending = new Map<string, PendingAnnualRecord>();
  const authoritativeLeaveDays = new Set<string>();
  let warningCount = 0;

  const duplicateBusinessValue = (row: PendingAnnualRecord) => {
    const { raw_values: _rawValues, source_updated_at: _sourceUpdatedAt, ...business } = row;
    return JSON.stringify(business);
  };
  const sourcePhysicalRow = (row: PendingAnnualRecord) => {
    const value = Number.parseInt(stringValue(row.raw_values.source_physical_row), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  };

  const addRecord = (
    row: PendingAnnualRecord,
    logicalKey: string,
  ) => {
    const existing = pending.get(logicalKey);
    if (!existing) {
      pending.set(logicalKey, row);
      return;
    }

    const existingRow = sourcePhysicalRow(existing);
    const duplicateRow = sourcePhysicalRow(row);
    if (duplicateBusinessValue(existing) !== duplicateBusinessValue(row)) {
      const block = row.source_block.replace(/[^a-z_]/g, "") || "record";
      throw new Error(
        `snapshot_duplicate_record_key:${block}:rows_${existingRow}_${duplicateRow}`,
      );
    }

    const duplicateRows = new Set([
      ...stringValue(existing.raw_values.duplicate_source_physical_rows)
        .split(",")
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
      existingRow,
      duplicateRow,
    ]);
    existing.raw_values = {
      ...existing.raw_values,
      duplicate_source_physical_rows: [...duplicateRows]
        .sort((left, right) => left - right)
        .join(","),
    };
    warningCount += 1;
  };

  // The dedicated 休假填表 is the authoritative 9–12 month source. It carries
  // the human-entered type and explanation that the compact monthly grid cannot.
  for (let index = 2; index < leaves.length; index += 1) {
    const row = leaves[index];
    const rawRow = leavesRaw[index];
    if (rawRow.every((cell) => !stringValue(cell))) continue;
    const eventDate = parseAnnualDate(rawRow[0], source);
    const name = nullableText(row[1]);
    const employeeNo = nullableText(row[2]);
    const rawType = nullableText(rawRow[3]);
    if (!name && !employeeNo) throw new Error(`leave_employee_identity_required:row_${index + 1}`);
    if (!rawType) throw new Error(`leave_type_required:row_${index + 1}`);
    const eventKind = attendanceEventKind(rawType);
    if (eventKind === "other") throw new Error(`leave_type_unrecognized:row_${index + 1}`);
    const employeeKey = identityKey(employeeNo, name);
    const dayKey = `${employeeKey}|${eventDate}`;
    authoritativeLeaveDays.add(dayKey);
    const sourceBlock = eventKind === "resignation" ? "resignation" : "attendance";
    const logicalKey = `${sourceBlock}|${employeeKey}|${eventDate}|day`;
    addRecord({
      source_block: sourceBlock,
      kind: sourceBlock,
      event_date: eventDate,
      event_kind: eventKind,
      reason: rawType,
      note: nullableText(rawRow[4]),
      amount: null,
      raw_amount: null,
      currency: null,
      employee_no_raw: employeeNo,
      employee_name_raw: name,
      employee_status_raw: null,
      team_name_raw: null,
      position_name_raw: null,
      country_raw: source.fixedCountry,
      platform_raw: null,
      manager_raw: null,
      raw_values: {
        spreadsheet_id: source.spreadsheetId,
        source_tab: source.leaveTabName,
        source_group_label: source.sourceGroup,
        source_block: sourceBlock,
        source_physical_row: String(index + 1),
        source_month_block: source.month,
        raw_date: rawRow[0] ?? "",
        raw_name: rawRow[1] ?? "",
        raw_employee_no: rawRow[2] ?? "",
        raw_status: rawRow[3] ?? "",
        raw_note: rawRow[4] ?? "",
      },
      is_mirror: false,
      source_updated_at: capturedAt,
    }, logicalKey);
  }

  for (let index = 1; index < attendance.length; index += 1) {
    const row = attendance[index];
    const rawRow = attendanceRaw[index];
    const physicalRow = index + 1;
    const name = nullableText(row[source.nameColumn]);
    const employeeNo = nullableText(row[source.employeeNoColumn]);
    if (!name && !employeeNo) continue;
    const employeeKey = identityKey(employeeNo, name);
    const country = source.fixedCountry ?? nullableText(row[source.countryColumn ?? -1]);
    const position = nullableText(row[source.positionColumn]);
    const platform = nullableText(row[source.platformColumn]);
    for (let day = 1; day <= daysInMonth(source.month); day += 1) {
      const column = source.dayStartColumn + day - 1;
      const rawStatus = rawRow[column] ?? "";
      if (!stringValue(rawStatus)) continue;
      const eventKind = attendanceEventKind(rawStatus);
      if (eventKind === "other") {
        warningCount += 1;
        continue;
      }
      const eventDate = `${source.month}-${String(day).padStart(2, "0")}`;
      if (authoritativeLeaveDays.has(`${employeeKey}|${eventDate}`)) continue;
      const isResignation = eventKind === "resignation";
      const sourceBlock = isResignation ? "resignation" : "attendance";
      // Status is mutable. Keeping it out of the day-event identity turns a
      // 公→请 correction into an update instead of a delete/insert pair.
      const logicalKey = `${sourceBlock}|${employeeKey}|${eventDate}|day`;
      addRecord({
        source_block: sourceBlock,
        kind: sourceBlock,
        event_date: eventDate,
        event_kind: eventKind,
        reason: nullableText(rawStatus),
        note: null,
        amount: null,
        raw_amount: null,
        currency: null,
        employee_no_raw: employeeNo,
        employee_name_raw: name,
        employee_status_raw: null,
        team_name_raw: null,
        position_name_raw: position,
        country_raw: country,
        platform_raw: platform,
        manager_raw: null,
        raw_values: {
          spreadsheet_id: source.spreadsheetId,
          source_tab: source.tabName,
          source_group_label: source.sourceGroup,
          source_block: sourceBlock,
          source_physical_row: String(physicalRow),
          source_column: String(column + 1),
          raw_name: rawRow[source.nameColumn] ?? "",
          raw_employee_no: rawRow[source.employeeNoColumn] ?? "",
          raw_status: rawStatus,
          raw_date: eventDate,
          raw_country: source.fixedCountry ?? (rawRow[source.countryColumn ?? -1] ?? ""),
          raw_position: rawRow[source.positionColumn] ?? "",
          raw_platform: rawRow[source.platformColumn] ?? "",
        },
        is_mirror: false,
        source_updated_at: capturedAt,
      }, logicalKey);
    }
  }

  const adjustmentSlots = source.layout === "home_ph"
    ? [
      { amountColumn: 2, categoryColumn: 3, noteColumn: 6, slot: "first_half", metadataOffset: 0 },
      { amountColumn: 4, categoryColumn: 5, noteColumn: 7, slot: "second_half", metadataOffset: 3 },
    ]
    : [
      {
        amountColumn: 2,
        categoryColumn: adjustmentSchema === "legacy_without_category" ? null : 4,
        noteColumn: 5,
        slot: "bonus_column",
        metadataOffset: 0,
      },
      {
        amountColumn: 3,
        categoryColumn: adjustmentSchema === "legacy_without_category" ? null : 4,
        noteColumn: 5,
        slot: "deduction_column",
        metadataOffset: 0,
      },
    ];
  const dateColumn = source.layout === "home_ph" ? 8 : 6;

  for (let index = 2; index < adjustments.length; index += 1) {
    const row = adjustments[index];
    const rawRow = adjustmentsRaw[index];
    const metadataRow = adjustmentMetadata[index];
    const physicalRow = index + 1;
    const name = nullableText(row[0]);
    const employeeNo = nullableText(row[1]);
    const managedSlots = new Map<number, ManagedMetadataState>();
    for (const slot of adjustmentSlots) {
      if (!managedSlots.has(slot.metadataOffset)) {
        managedSlots.set(
          slot.metadataOffset,
          managedAdjustmentMetadataState(
            metadataRow.slice(slot.metadataOffset, slot.metadataOffset + 3),
            physicalRow,
            slot.slot,
          ),
        );
      }
    }
    const hasAnyAmount = adjustmentSlots.some((slot) => nullableText(rawRow[slot.amountColumn]) !== null);
    const hasUnmanagedAmount = adjustmentSlots.some((slot) =>
      managedSlots.get(slot.metadataOffset) !== "managed" && nullableText(rawRow[slot.amountColumn]) !== null
    );
    if (!name && !employeeNo && !hasAnyAmount) continue;
    if (!hasUnmanagedAmount) continue;
    const employeeKey = identityKey(employeeNo, name);
    for (const slot of adjustmentSlots) {
      if (managedSlots.get(slot.metadataOffset) === "managed") continue;
      const parsed = parseSignedAmount(rawRow[slot.amountColumn]);
      if (parsed.amount === null || parsed.amount === 0) continue;
      const eventDate = parseAnnualDate(rawRow[dateColumn], source);
      const category = slot.categoryColumn === null
        ? (parsed.amount > 0 ? "奖金" : "扣款")
        : nullableText(rawRow[slot.categoryColumn]);
      if (slot.categoryColumn !== null && !category) {
        throw new Error(`adjustment_type_required:row_${physicalRow}`);
      }
      const logicalKey = `adjustment|${employeeKey}|${eventDate}|${slot.slot}`;
      addRecord({
        source_block: "adjustment",
        kind: "adjustment",
        event_date: eventDate,
        event_kind: parsed.amount > 0 ? "bonus" : "deduction",
        reason: category,
        note: nullableText(rawRow[slot.noteColumn]),
        amount: parsed.amount,
        raw_amount: parsed.rawAmount,
        currency: source.currency,
        employee_no_raw: employeeNo,
        employee_name_raw: name,
        employee_status_raw: null,
        team_name_raw: null,
        position_name_raw: null,
        country_raw: source.fixedCountry,
        platform_raw: null,
        manager_raw: null,
        raw_values: {
          spreadsheet_id: source.spreadsheetId,
          source_tab: source.adjustmentTabName,
          source_group_label: source.sourceGroup,
          source_block: "adjustment",
          source_physical_row: String(physicalRow),
          source_month_block: source.month,
          source_slot: slot.slot,
          raw_name: rawRow[0] ?? "",
          raw_employee_no: rawRow[1] ?? "",
          raw_amount: rawRow[slot.amountColumn] ?? "",
          raw_type: category ?? "",
          raw_note: rawRow[slot.noteColumn] ?? "",
          raw_date: rawRow[dateColumn] ?? "",
          currency: source.currency,
        },
        is_mirror: false,
        source_updated_at: capturedAt,
      }, logicalKey);
    }
  }

  return {
    rows: await Promise.all(
      [...pending.entries()].map(([logicalKey, row]) => applyStableIdentity(row, logicalKey)),
    ),
    readRowCount: Math.max(attendance.length - 1, 0) + Math.max(leaves.length - 2, 0) +
      Math.max(adjustments.length - 2, 0),
    warningCount,
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
  const capturedAt = captured.toISOString();

  const result = source.mode === "legacy"
    ? await normalizeLegacySnapshot(payload, source, capturedAt, snapshotHash)
    : await normalizeAnnualSnapshot(payload, source, capturedAt, snapshotHash);

  return {
    request_id: requestId,
    trigger_kind: triggerKind as TriggerKind,
    sync_contract: source.mode === "legacy" ? "august_v1" : "annual_v1",
    source: {
      source_key: source.sourceKey,
      spreadsheet_id: source.spreadsheetId,
      sheet_gid: source.sheetGid,
      tab_name: source.tabName,
      ...(source.mode === "annual" ? {
        leave_sheet_gid: source.leaveSheetGid,
        leave_tab_name: source.leaveTabName,
        adjustment_sheet_gid: source.adjustmentSheetGid,
        adjustment_tab_name: source.adjustmentTabName,
      } : {}),
    },
    snapshot_hash: snapshotHash,
    captured_at: capturedAt,
    read_row_count: result.readRowCount,
    parser_version: PARSER_VERSION,
    parse_warning_count: result.warningCount,
    allow_large_delete: false,
    rows: result.rows,
  };
}
