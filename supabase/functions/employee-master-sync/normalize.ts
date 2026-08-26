// The payload schema is unchanged; keep the database contract version at v1
// while the parser reconciles duplicate identities deterministically.
export const PARSER_VERSION = "employee-master-dual-source-v1";

export const HOME_ROSTER_SOURCE = Object.freeze({
  sourceKey: "home_employee_roster_current",
  spreadsheetId: "1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8",
  sheetGid: "970844334",
  tabName: "在职名单 Current Staff List",
  snapshotSource: "居家员工名单/在职名单 Current Staff List",
  maxRows: 5000,
  maxColumns: 16,
  headerRow: 2,
});

export const SCHEDULE_ROSTER_SOURCE = Object.freeze({
  sourceKey: "home_schedule_roster_current",
  spreadsheetId: "1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA",
  sheetGid: "1457335551",
  tabName: "填表",
  snapshotSource: "居家排班表/填表",
  maxRows: 3500,
  maxColumns: 13,
  headerRow: 1,
});

export const HOME_ROSTER_HEADERS = Object.freeze([
  "盘口国家",
  "盘口岗位Platformposition",
  "岗位",
  "班次",
  "国家country",
  "名字Name",
  "ID",
  "入职日期hiredateY/M/D",
  "离职日期",
  "工作飞机WorkTG",
  "后台账号",
  "离职原因Reason",
  "底薪",
  "涨底薪",
  "绩效",
  "KPI",
]);

export const SCHEDULE_ROSTER_HEADERS = Object.freeze([
  "负责人",
  "现场培训",
  "线上组长",
  "线上培训",
  "组别",
  "团队",
  "姓名",
  "ID",
  "班次",
  "国家",
  "岗位",
  "盘口",
  "工作内容",
]);

type SourceMetadata = {
  source_key: string;
  spreadsheet_id: string;
  sheet_gid: string;
  tab_name: string;
};

export type NormalizedHomeRosterRow = {
  source_row: number;
  team: string;
  platform: string;
  position: string;
  shift: string;
  country: string;
  name: string;
  name_key: string;
  employee_id: string;
  hire_date: string;
  resign_date: string;
  work_tg: string;
  backend_accounts: string;
  resign_reason: string;
  explicitly_resigned: boolean;
  resignation_signal: "date" | "account_marker" | "none";
};

export type NormalizedScheduleRosterRow = {
  source_row: number;
  responsible: string;
  onsite_trainer: string;
  online_leader: string;
  online_trainer: string;
  group: string;
  team: string;
  name: string;
  name_key: string;
  employee_id: string;
  shift: string;
  country: string;
  position: string;
  platform: string;
  work_content: string;
  onsite_marker: boolean;
};

export type NormalizedEmployeeMasterSnapshot = {
  request_id: string;
  trigger_kind: "change" | "manual";
  captured_at: string;
  parser_version: typeof PARSER_VERSION;
  snapshot_hash: string;
  parse_warning_count: number;
  sources: {
    home_roster: SourceMetadata & {
      snapshot_hash: string;
      semantic_snapshot_hash: string;
      read_row_count: number;
      roster_row_count: number;
    };
    schedule_roster: SourceMetadata & {
      snapshot_hash: string;
      semantic_snapshot_hash: string;
      read_row_count: number;
      roster_row_count: number;
    };
  };
  home_rows: NormalizedHomeRosterRow[];
  schedule_rows: NormalizedScheduleRosterRow[];
};

export class SnapshotValidationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "SnapshotValidationError";
    this.code = code;
    this.details = details;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const MAX_CELL_LENGTH = 40_000;

const rawString = (value: unknown) => String(value ?? "");
const trimmed = (value: unknown) => rawString(value).trim();
const normalizedHeader = (value: unknown) => trimmed(value).replace(/[\s\n\r]+/g, "");

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeEmployeeId(value: unknown): string {
  const result = trimmed(value)
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .toUpperCase()
    .replace(/\s+/gu, "");
  if (result.length > 100) throw new SnapshotValidationError("employee_id_too_long");
  return result;
}

export function normalizeShift(value: unknown): string {
  const raw = trimmed(value).normalize("NFKC").replace(/\s+/gu, " ");
  if (!raw) return "";
  const compact = raw.toUpperCase().replace(/[\s_\-/]+/gu, "");
  if (["DAYSHIFT", "DAYSHIFTT", "早班DAY", "白班DAY", "早班", "白班"].includes(compact)) {
    return "白班 Day";
  }
  if (["NIGHTSHIFT", "NIGHSHIFT", "NIGHTSHIFTT", "晚班NIGHT", "夜班NIGHT", "晚班", "夜班"].includes(compact)) {
    return "夜班 Night";
  }
  if (/^(?:MIDSHIFT|MIDSHFFT|中班MID|中班)$/.test(compact)) return "中班 Mid";
  const midTime = compact.match(/(?:中班MID|MID)(11(?::?00|:?30)|12(?::?00|:?30)|13:?00)/);
  if (midTime) {
    const digits = midTime[1].replace(":", "");
    return `中班 MID ${digits.slice(0, 2)}:${digits.slice(2)}`;
  }
  return raw;
}

export function normalizeNameKey(value: unknown): string {
  return trimmed(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function assertSource(value: unknown, expected: typeof HOME_ROSTER_SOURCE | typeof SCHEDULE_ROSTER_SOURCE): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SnapshotValidationError("invalid_source", { source: expected.sourceKey });
  }
  const source = value as Record<string, unknown>;
  if (
    trimmed(source.source_key) !== expected.sourceKey ||
    trimmed(source.spreadsheet_id) !== expected.spreadsheetId ||
    trimmed(source.sheet_gid) !== expected.sheetGid ||
    trimmed(source.tab_name) !== expected.tabName
  ) {
    throw new SnapshotValidationError("source_not_allowlisted", { source: expected.sourceKey });
  }
}

function normalizeValues(value: unknown, maxRows: number, maxColumns: number, source: string): string[][] {
  if (!Array.isArray(value)) throw new SnapshotValidationError("values_must_be_array", { source });
  if (value.length > maxRows) throw new SnapshotValidationError("sheet_row_limit_exceeded", { source, max_rows: maxRows });
  return value.map((row, rowIndex) => {
    if (!Array.isArray(row)) throw new SnapshotValidationError("sheet_row_must_be_array", { source, row: rowIndex + 1 });
    if (row.length > maxColumns) {
      throw new SnapshotValidationError("sheet_column_limit_exceeded", { source, row: rowIndex + 1, max_columns: maxColumns });
    }
    const cells = row.map(rawString);
    while (cells.length < maxColumns) cells.push("");
    for (let column = 0; column < cells.length; column += 1) {
      if (cells[column].length > MAX_CELL_LENGTH) {
        throw new SnapshotValidationError("cell_too_large", { source, row: rowIndex + 1, column: column + 1 });
      }
    }
    return cells;
  });
}

function assertHeaders(values: string[][], headers: readonly string[], headerRow: number, source: string): void {
  const actual = values[headerRow - 1];
  if (!actual) throw new SnapshotValidationError("sheet_headers_missing", { source, row: headerRow });
  for (let column = 0; column < headers.length; column += 1) {
    if (normalizedHeader(actual[column]) !== normalizedHeader(headers[column])) {
      throw new SnapshotValidationError("sheet_header_mismatch", {
        source,
        row: headerRow,
        column: column + 1,
        expected: headers[column],
      });
    }
  }
}

// Compensation columns M:P remain part of the raw A:P integrity hash and
// header validation, but they do not feed the employee master. Excluding them
// from this semantic projection prevents unrelated pay edits from triggering a
// Supabase reconciliation. Trailing rows populated only in M:P are excluded as
// well, so extending those columns cannot change the combined semantic hash.
function homeSemanticProjection(values: string[][], dateValues: string[][]) {
  let end = values.length;
  while (end > HOME_ROSTER_SOURCE.headerRow) {
    const row = values[end - 1].slice(0, 12);
    const dates = dateValues[end - 1] ?? ["", ""];
    if (row.some((cell) => trimmed(cell)) || dates.some((cell) => trimmed(cell))) break;
    end -= 1;
  }
  return {
    values: values.slice(0, end).map((row) => row.slice(0, 12)),
    date_values: dateValues.slice(0, end),
  };
}

function normalizeDate(value: unknown, source: string, row: number, column: number): string {
  const input = trimmed(value).replace(/\s+/g, "");
  if (!input) return "";
  let year = 0;
  let month = 0;
  let day = 0;
  let match = input.match(/^(\d{4})年(\d{1,2})月(\d{1,2})(?:日)?$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = input.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (match) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    } else {
      match = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (match) {
        month = Number(match[1]);
        day = Number(match[2]);
        year = Number(match[3]);
      }
    }
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    !year || !month || !day ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    throw new SnapshotValidationError("sheet_date_invalid", { source, row, column });
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function hasResignedAccountMarker(value: unknown): boolean {
  const marker = trimmed(value).normalize("NFKC").toLocaleLowerCase("en-US");
  if (!marker) return false;
  const compact = marker.replace(/[\s_\-‐‑‒–—―]+/gu, "");
  if (/(?:未|非)(?:辞职|辭職|离职|離職)/u.test(compact)) return false;
  if (/(?:not|non)(?:resigned|terminated)/i.test(compact)) return false;

  const tokens = marker
    .split(/[\s,，;；|/\\:：()（）\[\]【】{}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.some((token) => /^(?:已)?(?:辞职|辭職|离职|離職)$|^(?:resigned|terminated)$/iu.test(token));
}

function hasOnsiteMarker(value: unknown): boolean {
  return /现场人员/.test(trimmed(value).normalize("NFKC"));
}

function snapshotObject(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SnapshotValidationError("invalid_snapshot_source", { source: key });
  }
  return value as Record<string, unknown>;
}

async function normalizeHomeRoster(value: unknown) {
  const input = snapshotObject(value, "home_roster");
  assertSource(input.source, HOME_ROSTER_SOURCE);
  const values = normalizeValues(input.values, HOME_ROSTER_SOURCE.maxRows, HOME_ROSTER_SOURCE.maxColumns, "home_roster");
  assertHeaders(values, HOME_ROSTER_HEADERS, HOME_ROSTER_SOURCE.headerRow, "home_roster");

  if (!Array.isArray(input.date_values) || input.date_values.length !== values.length) {
    throw new SnapshotValidationError("home_date_values_invalid", { expected_rows: values.length });
  }
  const dateValues = input.date_values.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 2) {
      throw new SnapshotValidationError("home_date_values_invalid", { row: index + 1 });
    }
    return row.map(rawString);
  });

  const expectedHash = trimmed(input.snapshot_hash).toLowerCase();
  if (!SHA256_RE.test(expectedHash)) throw new SnapshotValidationError("invalid_source_snapshot_hash", { source: "home_roster" });
  const actualHash = await sha256Hex(JSON.stringify({ values, date_values: dateValues }));
  if (actualHash !== expectedHash) throw new SnapshotValidationError("snapshot_hash_mismatch", { source: "home_roster" });
  const semanticHash = await sha256Hex(JSON.stringify(homeSemanticProjection(values, dateValues)));

  const rows: NormalizedHomeRosterRow[] = [];
  const seen = new Map<string, number>();
  let warnings = 0;
  for (let index = HOME_ROSTER_SOURCE.headerRow; index < values.length; index += 1) {
    const cells = values[index].map(trimmed);
    const sourceRow = index + 1;
    const name = cells[5];
    const employeeId = normalizeEmployeeId(cells[6]);
    if (!name && !employeeId) continue;
    if (!name) throw new SnapshotValidationError("home_row_missing_name", { row: sourceRow, employee_id: employeeId });

    const hireDate = normalizeDate(dateValues[index][0], "home_roster", sourceRow, 8);
    const resignDate = normalizeDate(dateValues[index][1], "home_roster", sourceRow, 9);
    const accountMarker = hasResignedAccountMarker(cells[10]);
    const explicitlyResigned = Boolean(resignDate || accountMarker);
    if (!employeeId) {
      if (!explicitlyResigned) throw new SnapshotValidationError("home_active_row_missing_employee_id", { row: sourceRow });
      warnings += 1;
    } else if (seen.has(employeeId)) {
      throw new SnapshotValidationError("home_duplicate_employee_id", {
        employee_id: employeeId,
        rows: [seen.get(employeeId), sourceRow],
      });
    } else {
      seen.set(employeeId, sourceRow);
    }

    rows.push({
      source_row: sourceRow,
      team: cells[0],
      platform: cells[1],
      position: cells[2],
      shift: normalizeShift(cells[3]),
      country: cells[4],
      name,
      name_key: normalizeNameKey(name),
      employee_id: employeeId,
      hire_date: hireDate,
      resign_date: resignDate,
      work_tg: cells[9],
      backend_accounts: cells[10],
      resign_reason: cells[11],
      explicitly_resigned: explicitlyResigned,
      resignation_signal: resignDate ? "date" : accountMarker ? "account_marker" : "none",
    });
  }
  if (!rows.length) throw new SnapshotValidationError("home_roster_empty");
  if (!rows.some((row) => row.employee_id && !row.explicitly_resigned)) {
    throw new SnapshotValidationError("home_active_roster_empty");
  }
  return { rows, warnings, hash: expectedHash, semanticHash, readRowCount: values.length };
}

async function normalizeScheduleRoster(value: unknown) {
  const input = snapshotObject(value, "schedule_roster");
  assertSource(input.source, SCHEDULE_ROSTER_SOURCE);
  const values = normalizeValues(input.values, SCHEDULE_ROSTER_SOURCE.maxRows, SCHEDULE_ROSTER_SOURCE.maxColumns, "schedule_roster");
  assertHeaders(values, SCHEDULE_ROSTER_HEADERS, SCHEDULE_ROSTER_SOURCE.headerRow, "schedule_roster");

  const expectedHash = trimmed(input.snapshot_hash).toLowerCase();
  if (!SHA256_RE.test(expectedHash)) throw new SnapshotValidationError("invalid_source_snapshot_hash", { source: "schedule_roster" });
  const actualHash = await sha256Hex(JSON.stringify(values));
  if (actualHash !== expectedHash) throw new SnapshotValidationError("snapshot_hash_mismatch", { source: "schedule_roster" });

  const rows: NormalizedScheduleRosterRow[] = [];
  const employeeIdIndexes = new Map<string, number>();
  const missingIdNameIndexes = new Map<string, number>();
  let warnings = 0;
  for (let index = SCHEDULE_ROSTER_SOURCE.headerRow; index < values.length; index += 1) {
    const cells = values[index].map(trimmed);
    const sourceRow = index + 1;
    const name = cells[6];
    const employeeId = normalizeEmployeeId(cells[7]);
    if (!name && !employeeId) continue;
    if (!name) throw new SnapshotValidationError("schedule_row_missing_name", { row: sourceRow, employee_id: employeeId });
    const onsiteMarker = hasOnsiteMarker(cells[12]);
    const row: NormalizedScheduleRosterRow = {
      source_row: sourceRow,
      responsible: cells[0],
      onsite_trainer: cells[1],
      online_leader: cells[2],
      online_trainer: cells[3],
      group: cells[4],
      team: cells[5],
      name,
      name_key: normalizeNameKey(name),
      employee_id: employeeId,
      shift: normalizeShift(cells[8]),
      country: cells[9],
      position: cells[10],
      platform: cells[11],
      work_content: cells[12],
      onsite_marker: onsiteMarker,
    };

    if (employeeId) {
      const existingIndex = employeeIdIndexes.get(employeeId);
      if (existingIndex !== undefined) {
        const existing = rows[existingIndex];
        if (existing.name_key !== row.name_key) {
          throw new SnapshotValidationError("schedule_duplicate_employee_id_name_conflict", {
            employee_id: employeeId,
            rows: [existing.source_row, sourceRow],
          });
        }
        // Later rows are the current assignment in this append-style roster.
        rows[existingIndex] = row;
        warnings += 1;
        continue;
      }
      employeeIdIndexes.set(employeeId, rows.length);
    } else {
      const existingIndex = missingIdNameIndexes.get(row.name_key);
      warnings += 1;
      if (existingIndex !== undefined) {
        rows[existingIndex] = row;
        continue;
      }
      missingIdNameIndexes.set(row.name_key, rows.length);
    }

    rows.push(row);
  }
  if (!rows.length) throw new SnapshotValidationError("schedule_roster_empty");
  if (!rows.some((row) => row.employee_id)) throw new SnapshotValidationError("schedule_employee_ids_missing");
  return { rows, warnings, hash: expectedHash, semanticHash: expectedHash, readRowCount: values.length };
}

export async function normalizeSnapshot(input: unknown): Promise<NormalizedEmployeeMasterSnapshot> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SnapshotValidationError("invalid_payload");
  const payload = input as Record<string, unknown>;
  const requestId = trimmed(payload.request_id);
  if (!UUID_RE.test(requestId)) throw new SnapshotValidationError("invalid_request_id");
  const triggerKind = trimmed(payload.trigger_kind || "change");
  if (triggerKind !== "change" && triggerKind !== "manual") throw new SnapshotValidationError("invalid_trigger_kind");
  const capturedAt = new Date(trimmed(payload.captured_at));
  if (!Number.isFinite(capturedAt.getTime())) throw new SnapshotValidationError("invalid_captured_at");

  const sources = snapshotObject(payload.sources, "sources");
  const [home, schedule] = await Promise.all([
    normalizeHomeRoster(sources.home_roster),
    normalizeScheduleRoster(sources.schedule_roster),
  ]);
  const expectedCombinedHash = trimmed(payload.snapshot_hash).toLowerCase();
  if (!SHA256_RE.test(expectedCombinedHash)) throw new SnapshotValidationError("invalid_snapshot_hash");
  const actualCombinedHash = await sha256Hex(JSON.stringify({
    home: home.semanticHash,
    schedule: schedule.semanticHash,
  }));
  if (actualCombinedHash !== expectedCombinedHash) throw new SnapshotValidationError("snapshot_hash_mismatch", { source: "combined" });

  const homeByEmployeeId = new Map(
    home.rows
      .filter((row) => row.employee_id)
      .map((row) => [row.employee_id, row] as const),
  );
  for (const scheduleRow of schedule.rows) {
    if (!scheduleRow.employee_id) continue;
    const homeRow = homeByEmployeeId.get(scheduleRow.employee_id);
    if (homeRow && homeRow.name_key !== scheduleRow.name_key) {
      throw new SnapshotValidationError("cross_source_name_mismatch", {
        employee_id: scheduleRow.employee_id,
        home_row: homeRow.source_row,
        schedule_row: scheduleRow.source_row,
      });
    }
  }

  return {
    request_id: requestId,
    trigger_kind: triggerKind,
    captured_at: capturedAt.toISOString(),
    parser_version: PARSER_VERSION,
    snapshot_hash: expectedCombinedHash,
    parse_warning_count: home.warnings + schedule.warnings,
    sources: {
      home_roster: {
        source_key: HOME_ROSTER_SOURCE.sourceKey,
        spreadsheet_id: HOME_ROSTER_SOURCE.spreadsheetId,
        sheet_gid: HOME_ROSTER_SOURCE.sheetGid,
        tab_name: HOME_ROSTER_SOURCE.tabName,
        snapshot_hash: home.hash,
        semantic_snapshot_hash: home.semanticHash,
        read_row_count: home.readRowCount,
        roster_row_count: home.rows.length,
      },
      schedule_roster: {
        source_key: SCHEDULE_ROSTER_SOURCE.sourceKey,
        spreadsheet_id: SCHEDULE_ROSTER_SOURCE.spreadsheetId,
        sheet_gid: SCHEDULE_ROSTER_SOURCE.sheetGid,
        tab_name: SCHEDULE_ROSTER_SOURCE.tabName,
        snapshot_hash: schedule.hash,
        semantic_snapshot_hash: schedule.semanticHash,
        read_row_count: schedule.readRowCount,
        roster_row_count: schedule.rows.length,
      },
    },
    home_rows: home.rows,
    schedule_rows: schedule.rows,
  };
}
