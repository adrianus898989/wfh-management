import { normalizeSnapshot, sha256Hex } from "./normalize.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const source = {
  source_key: "onsite_2026_08",
  spreadsheet_id: "100xfv19w6zD1bdK0MVLd5kdQtOp8obzrBvI8eE2OUZo",
  sheet_gid: "1309516899",
  tab_name: "休假填表",
};

const headers = [
  ["休假", "", "", "", "", "离职", "", "", "", "", "奖罚", "", "", ""],
  ["姓名", "原因", "日期", "备注", "", "姓名", "原因", "日期", "备注", "", "姓名", "金额", "日期", "备注"],
];

Deno.test("normalizes signed adjustments, blank amounts, and resignation mirrors", async () => {
  const values = [
    ...headers,
    ["A", "公休", "2026-8-1", "n1", "", "B", "离职", "2026/8/2", "n2", "", "C", "-1,250", "2026.8.3", "n3"],
    ["D", "离职", "2026年8月4日", "n4", "", "", "", "", "", "", "E", "", "", "missing amount"],
  ];
  const result = await normalizeSnapshot({
    request_id: "123e4567-e89b-42d3-a456-426614174000",
    trigger_kind: "change",
    source,
    snapshot_hash: await sha256Hex(JSON.stringify(values)),
    captured_at: "2026-08-24T01:02:03.000Z",
    values,
  });
  assert(result.rows.length === 5, "expected five normalized records");
  assert(result.rows[0].event_kind === "public_holiday", "public holiday mapping failed");
  assert(result.rows[1].kind === "resignation" && !result.rows[1].is_mirror, "canonical resignation failed");
  assert(result.rows[2].amount === -1250 && result.rows[2].event_kind === "deduction", "signed deduction failed");
  assert(result.rows[3].is_mirror && result.rows[3].event_kind === "resignation", "attendance mirror failed");
  assert(result.rows[4].amount === null && result.rows[4].event_kind === "adjustment", "blank adjustment failed");
});

Deno.test("rejects a non-allowlisted source before normalization", async () => {
  const values = headers;
  let rejected = false;
  try {
    await normalizeSnapshot({
      request_id: "123e4567-e89b-42d3-a456-426614174000",
      trigger_kind: "change",
      source: { ...source, spreadsheet_id: "not-allowed" },
      snapshot_hash: await sha256Hex(JSON.stringify(values)),
      captured_at: "2026-08-24T01:02:03.000Z",
      values,
    });
  } catch (error) {
    rejected = error instanceof Error && error.message === "source_not_allowlisted";
  }
  assert(rejected, "non-allowlisted source was accepted");
});

Deno.test("capture timestamps do not change per-record content hashes", async () => {
  const values = [...headers, ["A", "回家", "2026-8-1", "", "", "", "", "", "", "", "", "", "", ""]];
  const base = {
    request_id: "123e4567-e89b-42d3-a456-426614174000",
    trigger_kind: "daily_reconcile",
    source,
    snapshot_hash: await sha256Hex(JSON.stringify(values)),
    values,
  };
  const first = await normalizeSnapshot({ ...base, captured_at: "2026-08-24T01:02:03.000Z" });
  const second = await normalizeSnapshot({ ...base, captured_at: "2026-08-24T02:03:04.000Z" });
  assert(first.rows[0].content_hash === second.rows[0].content_hash, "capture time changed content identity");
});

Deno.test("verifies the untrimmed padded A:N snapshot before parsing", async () => {
  const shortRow = ["  A  ", "回家", "2026-8-1", "  note  "];
  const paddedRow = [...shortRow, ...Array(10).fill("")];
  const result = await normalizeSnapshot({
    request_id: "123e4567-e89b-42d3-a456-426614174000",
    trigger_kind: "change",
    source,
    snapshot_hash: await sha256Hex(JSON.stringify([...headers, paddedRow])),
    captured_at: "2026-08-24T01:02:03.000Z",
    values: [...headers, shortRow],
  });
  assert(result.rows[0].employee_name_raw === "A", "normalized name was not trimmed");
  assert(result.rows[0].note === "note", "normalized note was not trimmed");
  assert(result.rows[0].raw_values.raw_name === "  A  ", "raw name spacing was not preserved");
  assert(result.rows[0].raw_values.raw_note === "  note  ", "raw note spacing was not preserved");
});

Deno.test("preserves valid spillover dates from the August source sheet", async () => {
  const values = [...headers, ["A", "请假", "2026-09-01", "", "", "", "", "", "", "", "", "", "", ""]];
  const result = await normalizeSnapshot({
    request_id: "123e4567-e89b-42d3-a456-426614174000",
    trigger_kind: "change",
    source,
    snapshot_hash: await sha256Hex(JSON.stringify(values)),
    captured_at: "2026-08-24T01:02:03.000Z",
    values,
  });
  assert(result.rows[0].event_date === "2026-09-01", "valid spillover date was not preserved");
});

Deno.test("rejects dates at the exclusive October boundary", async () => {
  const values = [...headers, ["A", "请假", "2026-10-01", "", "", "", "", "", "", "", "", "", "", ""]];
  let rejected = false;
  try {
    await normalizeSnapshot({
      request_id: "123e4567-e89b-42d3-a456-426614174000",
      trigger_kind: "change",
      source,
      snapshot_hash: await sha256Hex(JSON.stringify(values)),
      captured_at: "2026-08-24T01:02:03.000Z",
      values,
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.startsWith("date_outside_source_window:");
  }
  assert(rejected, "exclusive October boundary was accepted");
});

Deno.test("rejects an impossible calendar date", async () => {
  const values = [...headers, ["A", "请假", "2026-02-30", "", "", "", "", "", "", "", "", "", "", ""]];
  let rejected = false;
  try {
    await normalizeSnapshot({
      request_id: "123e4567-e89b-42d3-a456-426614174000",
      trigger_kind: "change",
      source,
      snapshot_hash: await sha256Hex(JSON.stringify(values)),
      captured_at: "2026-08-24T01:02:03.000Z",
      values,
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.startsWith("invalid_date:");
  }
  assert(rejected, "impossible date was accepted");
});
