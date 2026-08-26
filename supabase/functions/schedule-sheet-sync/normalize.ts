// The payload schema is unchanged; keep the database contract version at v1
// while the parser reconciles duplicate identities deterministically.
export const PARSER_VERSION = "schedule-roster-a-m-v1";

export const SCHEDULE_SOURCE = Object.freeze({
  sourceKey: "home_roster_current",
  spreadsheetId: "1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA",
  sheetGid: "1457335551",
  tabName: "填表",
  snapshotSource: "居家排班表/填表",
  maxRows: 3500,
  maxColumns: 13,
});

export const SCHEDULE_HEADERS = Object.freeze([
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

export type NormalizedScheduleRow = {
  source_row: number;
  responsible: string;
  onsite_trainer: string;
  online_leader: string;
  online_trainer: string;
  group: string;
  team: string;
  name: string;
  employee_id: string;
  shift: string;
  country: string;
  position: string;
  platform: string;
  work_content: string;
};

export type NormalizedScheduleSnapshot = {
  request_id: string;
  trigger_kind: "change" | "manual";
  source: {
    source_key: typeof SCHEDULE_SOURCE.sourceKey;
    spreadsheet_id: typeof SCHEDULE_SOURCE.spreadsheetId;
    sheet_gid: typeof SCHEDULE_SOURCE.sheetGid;
    tab_name: typeof SCHEDULE_SOURCE.tabName;
  };
  snapshot_hash: string;
  captured_at: string;
  read_row_count: number;
  parser_version: typeof PARSER_VERSION;
  parse_warning_count: number;
  rows: NormalizedScheduleRow[];
};

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

function assertAllowlistedSource(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_source");
  const source = value as Record<string, unknown>;
  if (
    trimmed(source.source_key) !== SCHEDULE_SOURCE.sourceKey ||
    trimmed(source.spreadsheet_id) !== SCHEDULE_SOURCE.spreadsheetId ||
    trimmed(source.sheet_gid) !== SCHEDULE_SOURCE.sheetGid ||
    trimmed(source.tab_name) !== SCHEDULE_SOURCE.tabName
  ) throw new Error("source_not_allowlisted");
}

function assertHeaders(values: string[][]): void {
  if (values.length < 1) throw new Error("sheet_headers_missing");
  const actual = values[0] ?? [];
  for (let column = 0; column < SCHEDULE_HEADERS.length; column += 1) {
    if (normalizedHeader(actual[column]) !== normalizedHeader(SCHEDULE_HEADERS[column])) {
      throw new Error(`sheet_header_mismatch_column_${column + 1}`);
    }
  }
}

function assertCellSizes(values: string[][]): void {
  for (const row of values) {
    for (const cell of row) {
      if (cell.length > MAX_CELL_LENGTH) throw new Error("cell_too_large");
    }
  }
}

function normalizeEmployeeId(value: unknown): string {
  return trimmed(value).toUpperCase().replace(/\s+/g, "");
}

export async function normalizeSnapshot(input: unknown): Promise<NormalizedScheduleSnapshot> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_payload");
  const payload = input as Record<string, unknown>;
  const requestId = trimmed(payload.request_id);
  if (!UUID_RE.test(requestId)) throw new Error("invalid_request_id");

  const triggerKind = trimmed(payload.trigger_kind || "change");
  if (triggerKind !== "change" && triggerKind !== "manual") throw new Error("invalid_trigger_kind");
  assertAllowlistedSource(payload.source);

  const snapshotHash = trimmed(payload.snapshot_hash).toLowerCase();
  if (!SHA256_RE.test(snapshotHash)) throw new Error("invalid_snapshot_hash");
  const capturedAt = new Date(trimmed(payload.captured_at));
  if (!Number.isFinite(capturedAt.getTime())) throw new Error("invalid_captured_at");

  if (!Array.isArray(payload.values)) throw new Error("values_must_be_array");
  if (payload.values.length > SCHEDULE_SOURCE.maxRows) throw new Error("sheet_row_limit_exceeded");

  const rawValues = payload.values.map((row) => {
    if (!Array.isArray(row)) throw new Error("sheet_row_must_be_array");
    if (row.length > SCHEDULE_SOURCE.maxColumns) throw new Error("sheet_column_limit_exceeded");
    const cells = row.map(rawString);
    while (cells.length < SCHEDULE_SOURCE.maxColumns) cells.push("");
    return cells;
  });
  assertCellSizes(rawValues);
  assertHeaders(rawValues);

  // Apps Script hashes the exact display strings. Verify before trimming or
  // normalizing any cell so a modified payload cannot reuse a valid hash.
  const computedHash = await sha256Hex(JSON.stringify(rawValues));
  if (computedHash !== snapshotHash) throw new Error("snapshot_hash_mismatch");

  const rows: NormalizedScheduleRow[] = [];
  const employeeIdIndexes = new Map<string, number>();
  const missingIdNameIndexes = new Map<string, number>();
  let parseWarningCount = 0;
  for (let index = 1; index < rawValues.length; index += 1) {
    const cells = rawValues[index].map(trimmed);
    const name = cells[6];
    const employeeId = normalizeEmployeeId(cells[7]);
    if (!name || ["null", "undefined"].includes(name.toLowerCase())) {
      if (employeeId) throw new Error(`snapshot_row_missing_name_${index + 1}`);
      continue;
    }
    // Keep named source rows even while an employee ID is being filled in. The
    // durable snapshot/report view must stay faithful to the private sheet;
    // only ID-backed rows are eligible for employee-directory matching. A
    // complete ID-column outage is rejected below and the database removal
    // guard rejects a large partial outage before replacing the last snapshot.
    const row: NormalizedScheduleRow = {
      source_row: index + 1,
      responsible: cells[0],
      onsite_trainer: cells[1],
      online_leader: cells[2],
      online_trainer: cells[3],
      group: cells[4],
      team: cells[5],
      name,
      employee_id: employeeId,
      shift: cells[8],
      country: cells[9],
      position: cells[10],
      platform: cells[11],
      work_content: cells[12],
    };

    if (employeeId) {
      const existingIndex = employeeIdIndexes.get(employeeId);
      if (existingIndex !== undefined) {
        // The live sheet contains historical duplicate assignments for the
        // same person. Keep the latest/current source row deterministically,
        // but never merge two different names behind one employee ID.
        const existing = rows[existingIndex];
        if (existing.name.trim().toLocaleUpperCase("en") !== name.trim().toLocaleUpperCase("en")) {
          throw new Error(
            `snapshot_duplicate_employee_id_name_conflict_rows_${existing.source_row}_${index + 1}`,
          );
        }
        rows[existingIndex] = row;
        parseWarningCount += 1;
        continue;
      }
      employeeIdIndexes.set(employeeId, rows.length);
    } else {
      const nameIdentity = name.toLocaleUpperCase("en").replace(/\s+/g, " ");
      const existingIndex = missingIdNameIndexes.get(nameIdentity);
      parseWarningCount += 1;
      if (existingIndex !== undefined) {
        rows[existingIndex] = row;
        continue;
      }
      missingIdNameIndexes.set(nameIdentity, rows.length);
    }

    rows.push(row);
  }
  if (rows.length === 0) throw new Error("snapshot_has_no_roster_rows");
  if (!rows.some((row) => row.employee_id)) throw new Error("snapshot_has_no_employee_ids");

  return {
    request_id: requestId,
    trigger_kind: triggerKind,
    source: {
      source_key: SCHEDULE_SOURCE.sourceKey,
      spreadsheet_id: SCHEDULE_SOURCE.spreadsheetId,
      sheet_gid: SCHEDULE_SOURCE.sheetGid,
      tab_name: SCHEDULE_SOURCE.tabName,
    },
    snapshot_hash: snapshotHash,
    captured_at: capturedAt.toISOString(),
    read_row_count: rawValues.length,
    parser_version: PARSER_VERSION,
    parse_warning_count: parseWarningCount,
    rows,
  };
}
