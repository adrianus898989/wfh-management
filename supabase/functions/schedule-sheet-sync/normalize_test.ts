import { normalizeSnapshot, SCHEDULE_HEADERS, SCHEDULE_SOURCE, sha256Hex } from "./normalize.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const source = {
  source_key: SCHEDULE_SOURCE.sourceKey,
  spreadsheet_id: SCHEDULE_SOURCE.spreadsheetId,
  sheet_gid: SCHEDULE_SOURCE.sheetGid,
  tab_name: SCHEDULE_SOURCE.tabName,
};

const payloadFor = async (values: string[][], overrides: Record<string, unknown> = {}) => ({
  request_id: "123e4567-e89b-42d3-a456-426614174000",
  trigger_kind: "change",
  source,
  snapshot_hash: await sha256Hex(JSON.stringify(values)),
  captured_at: "2026-08-24T01:02:03.000Z",
  values,
  ...overrides,
});

Deno.test("normalizes the exact private schedule A:M mapping", async () => {
  const values = [
    [...SCHEDULE_HEADERS],
    ["负责人甲", "现场培训乙", "线上组长丙", "线上培训丁", "一组", "AR印度", " Alice ", " wd001 ", "白班 Day", "印度", "客服", "MZPLAY", "日报"],
  ];
  const result = await normalizeSnapshot(await payloadFor(values));
  assert(result.rows.length === 1, "expected one roster row");
  assert(result.rows[0].source_row === 2, "source row mismatch");
  assert(result.rows[0].employee_id === "WD001", "employee id normalization mismatch");
  assert(result.rows[0].responsible === "负责人甲", "responsible mapping mismatch");
  assert(result.rows[0].work_content === "日报", "work content mapping mismatch");
});

Deno.test("keeps named rows without IDs in the durable snapshot and warns", async () => {
  const values = [
    [...SCHEDULE_HEADERS],
    ["", "", "", "", "", "AR印度", "待补ID员工", "", "夜班", "印度", "客服", "MZPLAY", ""],
    ["", "", "", "", "", "AR印度", "正常员工", "WD002", "夜班", "印度", "客服", "MZPLAY", ""],
  ];
  const result = await normalizeSnapshot(await payloadFor(values));
  assert(result.rows.length === 2, "named rows should be preserved");
  assert(result.parse_warning_count === 1, "missing ID should produce a warning");
});

Deno.test("rejects duplicate non-empty employee IDs", async () => {
  const values = [
    [...SCHEDULE_HEADERS],
    ["", "", "", "", "", "AR印度", "员工甲", "WD002", "夜班", "印度", "客服", "MZPLAY", ""],
    ["", "", "", "", "", "AR印度", "员工乙", " wd002 ", "夜班", "印度", "客服", "MZPLAY", ""],
  ];
  let rejected = false;
  try {
    await normalizeSnapshot(await payloadFor(values));
  } catch (error) {
    rejected = error instanceof Error && error.message === "snapshot_duplicate_employee_id_3";
  }
  assert(rejected, "duplicate employee ID was accepted");
});

Deno.test("rejects a changed payload with a reused hash", async () => {
  const original = [[...SCHEDULE_HEADERS], ["", "", "", "", "", "T", "A", "WD1", "白班", "PH", "客服", "P", ""]];
  const changed = [[...SCHEDULE_HEADERS], ["", "", "", "", "", "T", "B", "WD1", "白班", "PH", "客服", "P", ""]];
  let rejected = false;
  try {
    await normalizeSnapshot(await payloadFor(changed, {
      snapshot_hash: await sha256Hex(JSON.stringify(original)),
    }));
  } catch (error) {
    rejected = error instanceof Error && error.message === "snapshot_hash_mismatch";
  }
  assert(rejected, "mismatched hash was accepted");
});

Deno.test("rejects column drift and non-allowlisted source metadata", async () => {
  const badHeaders = [...SCHEDULE_HEADERS];
  badHeaders[7] = "员工编号";
  let headerRejected = false;
  try {
    await normalizeSnapshot(await payloadFor([badHeaders, ["", "", "", "", "", "T", "A", "WD1", "", "", "", "", ""]]));
  } catch (error) {
    headerRejected = error instanceof Error && error.message === "sheet_header_mismatch_column_8";
  }
  assert(headerRejected, "header drift was accepted");

  const values = [[...SCHEDULE_HEADERS], ["", "", "", "", "", "T", "A", "WD1", "", "", "", "", ""]];
  let sourceRejected = false;
  try {
    await normalizeSnapshot(await payloadFor(values, {
      source: { ...source, spreadsheet_id: "not-allowlisted" },
    }));
  } catch (error) {
    sourceRejected = error instanceof Error && error.message === "source_not_allowlisted";
  }
  assert(sourceRejected, "non-allowlisted source was accepted");
});

Deno.test("rejects an empty authoritative roster", async () => {
  const values = [[...SCHEDULE_HEADERS]];
  let rejected = false;
  try {
    await normalizeSnapshot(await payloadFor(values));
  } catch (error) {
    rejected = error instanceof Error && error.message === "snapshot_has_no_roster_rows";
  }
  assert(rejected, "empty roster was accepted");
});
