import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  normalizeReportErrorPush,
  REPORT_ERROR_PUSH_VERSION,
  REPORT_ERROR_SOURCE,
  ReportErrorPushValidationError,
  sha256Hex,
} from "./protocol.ts";

const NOW = new Date("2026-08-30T16:00:00.000Z");

async function payload(values: unknown[][]) {
  return {
    protocol_version: REPORT_ERROR_PUSH_VERSION,
    request_id: "e1c2234a-d3f6-454d-9551-15eaa9c42e2b",
    captured_at: "2026-08-30T15:59:00.000Z",
    snapshot_hash: await sha256Hex(JSON.stringify(values)),
    source: REPORT_ERROR_SOURCE,
    values,
  };
}

Deno.test("private finance rows are mapped by position and normalized", async () => {
  const values = [[
    "YM525030501",
    "ORDER-1",
    "50",
    "wrong remark",
    "double check",
    "错误备注",
    "1",
    "小权",
    "30 August 2026",
    "小权",
    "正确",
    "2026/8/30",
  ]];
  const result = await normalizeReportErrorPush(await payload(values), NOW);

  assertEquals(result.rawRowCount, 1);
  assertEquals(result.rows.length, 1);
  assertEquals(result.rows[0].employee_id, "YM525030501");
  assertEquals(result.rows[0].qc_date, "2026-08-30");
  assertEquals(result.rows[0].source_row, 2);
});

Deno.test("source metadata is an exact allowlist", async () => {
  const value: Record<string, any> = await payload([[
    "WD000253",
    "",
    "",
    "note",
  ]]);
  value.source = { ...REPORT_ERROR_SOURCE, spreadsheet_id: "attacker-sheet" };

  await assertRejects(
    () => normalizeReportErrorPush(value, NOW),
    ReportErrorPushValidationError,
    "source_spreadsheet_id_not_allowlisted",
  );
});

Deno.test("empty snapshots and hash drift are rejected before writes", async () => {
  const empty = await payload([]);
  await assertRejects(
    () => normalizeReportErrorPush(empty, NOW),
    ReportErrorPushValidationError,
    "empty_snapshot_rejected",
  );

  const value: Record<string, any> = await payload([[
    "WD000253",
    "",
    "",
    "note",
  ]]);
  value.snapshot_hash = "0".repeat(64);
  await assertRejects(
    () => normalizeReportErrorPush(value, NOW),
    ReportErrorPushValidationError,
    "snapshot_hash_mismatch",
  );
});
