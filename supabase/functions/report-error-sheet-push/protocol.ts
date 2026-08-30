import { normalizeEmployeeErrors } from "../report-sheet-sync/errorNormalization.ts";

export const REPORT_ERROR_PUSH_VERSION = "report-error-sheet-push-v1";
export const REPORT_ERROR_SOURCE = Object.freeze({
  source_name: "财务质检错误记录/财务质检错误记录",
  spreadsheet_id: "125rN-PXjjWMe4SnYjruGlQ_NdZUb5hI7dXUUBjqe7bY",
  sheet_gid: "0",
  tab_name: "财务质检错误记录",
});
export const REPORT_ERROR_COLUMN_COUNT = 12;
export const REPORT_ERROR_MAX_ROWS = 5_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class ReportErrorPushValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "ReportErrorPushValidationError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredText(value: unknown, code: string, maxLength = 500) {
  const result = String(value ?? "").trim();
  if (!result || result.length > maxLength) {
    throw new ReportErrorPushValidationError(code);
  }
  return result;
}

function normalizeCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new ReportErrorPushValidationError("invalid_cell_value");
  }
  const result = String(value);
  if (result.length > 20_000) {
    throw new ReportErrorPushValidationError("cell_value_too_large");
  }
  return result;
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function positionMappedRow(values: string[]) {
  return {
    ID: values[0],
    "会员/id /订单号": values[1],
    "金额": values[2],
    "错误备注": values[3],
    "正确操作方式": values[4],
    "错误类型": values[5],
    "扣分": values[6],
    "质检人": values[7],
    "质检时间": values[8],
    "小组长复审": values[9],
    "质检人对错": values[10],
    "复检时间": values[11],
  };
}

export type NormalizedReportErrorPush = {
  protocolVersion: string;
  requestId: string;
  capturedAt: string;
  snapshotHash: string;
  allowLargeDelete: boolean;
  sourceName: string;
  rawRowCount: number;
  droppedRowCount: number;
  rows: ReturnType<typeof normalizeEmployeeErrors>;
};

export async function normalizeReportErrorPush(
  value: unknown,
  now = new Date(),
): Promise<NormalizedReportErrorPush> {
  if (!record(value)) {
    throw new ReportErrorPushValidationError("invalid_payload");
  }
  if (value.protocol_version !== REPORT_ERROR_PUSH_VERSION) {
    throw new ReportErrorPushValidationError("invalid_protocol_version");
  }
  const requestId = requiredText(value.request_id, "invalid_request_id", 64);
  if (!UUID_RE.test(requestId)) {
    throw new ReportErrorPushValidationError("invalid_request_id");
  }

  const capturedAt = requiredText(value.captured_at, "invalid_captured_at", 64);
  const capturedTime = Date.parse(capturedAt);
  if (!Number.isFinite(capturedTime)) {
    throw new ReportErrorPushValidationError("invalid_captured_at");
  }
  if (
    capturedTime > now.getTime() + 10 * 60_000 ||
    capturedTime < now.getTime() - 24 * 60 * 60_000
  ) {
    throw new ReportErrorPushValidationError("captured_at_out_of_range");
  }

  if (!record(value.source)) {
    throw new ReportErrorPushValidationError("invalid_source");
  }
  for (const [key, expected] of Object.entries(REPORT_ERROR_SOURCE)) {
    if (
      requiredText(value.source[key], `invalid_source_${key}`, 200) !== expected
    ) {
      throw new ReportErrorPushValidationError(`source_${key}_not_allowlisted`);
    }
  }

  if (!Array.isArray(value.values) || value.values.length === 0) {
    throw new ReportErrorPushValidationError("empty_snapshot_rejected");
  }
  if (value.values.length > REPORT_ERROR_MAX_ROWS) {
    throw new ReportErrorPushValidationError("snapshot_row_limit_exceeded");
  }
  const values = value.values.map((row) => {
    if (!Array.isArray(row) || row.length > REPORT_ERROR_COLUMN_COUNT) {
      throw new ReportErrorPushValidationError("invalid_snapshot_row");
    }
    const normalized = row.map(normalizeCell);
    while (normalized.length < REPORT_ERROR_COLUMN_COUNT) normalized.push("");
    return normalized;
  });
  const snapshotHash = requiredText(
    value.snapshot_hash,
    "invalid_snapshot_hash",
    64,
  ).toLowerCase();
  if (
    !SHA256_RE.test(snapshotHash) ||
    snapshotHash !== await sha256Hex(JSON.stringify(values))
  ) {
    throw new ReportErrorPushValidationError("snapshot_hash_mismatch");
  }

  const rows = normalizeEmployeeErrors(
    values.map(positionMappedRow),
    REPORT_ERROR_SOURCE.source_name,
  );
  const droppedRowCount = values.length - rows.length;
  if (rows.length === 0) {
    throw new ReportErrorPushValidationError(
      "empty_normalized_snapshot_rejected",
    );
  }
  if (droppedRowCount > Math.max(5, Math.ceil(values.length * 0.1))) {
    throw new ReportErrorPushValidationError("too_many_invalid_rows");
  }

  return {
    protocolVersion: REPORT_ERROR_PUSH_VERSION,
    requestId,
    capturedAt: new Date(capturedTime).toISOString(),
    snapshotHash,
    allowLargeDelete: value.allow_large_delete === true,
    sourceName: REPORT_ERROR_SOURCE.source_name,
    rawRowCount: values.length,
    droppedRowCount,
    rows,
  };
}
