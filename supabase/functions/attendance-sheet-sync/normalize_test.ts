import {
  ALLOWED_SOURCES,
  type AnnualSourceConfig,
  normalizeSnapshot,
  sha256Hex,
} from "./normalize.ts";

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

const annualConfig = (sourceKey: string): AnnualSourceConfig => {
  const config = ALLOWED_SOURCES.find((candidate) => candidate.sourceKey === sourceKey);
  if (!config || config.mode !== "annual") throw new Error(`missing annual source ${sourceKey}`);
  return config;
};

const annualSourcePayload = (config: AnnualSourceConfig) => ({
  source_key: config.sourceKey,
  spreadsheet_id: config.spreadsheetId,
  sheet_gid: config.sheetGid,
  tab_name: config.tabName,
  leave_sheet_gid: config.leaveSheetGid,
  leave_tab_name: config.leaveTabName,
  adjustment_sheet_gid: config.adjustmentSheetGid,
  adjustment_tab_name: config.adjustmentTabName,
});

function annualMatrices(
  config: AnnualSourceConfig,
  attendanceRows: string[][],
  adjustmentRows: string[][],
  metadataRows: string[][] = [],
  leaveRows: string[][] = [],
  adjustmentSchema: "with_category" | "legacy_without_category" | "philippines" =
    config.layout === "home_ph" ? "philippines" : "with_category",
) {
  const attendanceHeader = Array(config.maxColumns).fill("");
  attendanceHeader[config.nameColumn] = "姓名";
  attendanceHeader[config.employeeNoColumn] = "ID";
  for (let day = 1; day < config.maxColumns - config.dayStartColumn; day += 1) {
    attendanceHeader[config.dayStartColumn + day - 1] = String(day);
  }
  const adjustmentMonth = Array(config.adjustmentColumns).fill("");
  adjustmentMonth[0] = `${Number(config.month.slice(5))}月份`;
  const adjustmentHeader = config.layout === "home_ph"
    ? ["姓名", "ID", "金额1-15", "类型", "金额16-末", "类型", "备注1-15", "备注16-末", "日期"]
    : adjustmentSchema === "legacy_without_category"
      ? ["姓名", "ID", "奖金", "扣除", "", "备注", "日期"]
      : ["姓名", "ID", "奖金", "扣除", "类型", "备注", "日期"];
  const normalizedAdjustmentRows = adjustmentRows.map((row) =>
    config.layout !== "home_ph" && row.length === 6
      ? [...row.slice(0, 4), adjustmentSchema === "legacy_without_category" ? "" : "测试类型", ...row.slice(4)]
      : row
  );
  const metadataHeader = config.layout === "home_ph"
    ? [
      "__sync_first_half_external_id", "__sync_first_half_origin", "__sync_first_half_revision",
      "__sync_second_half_external_id", "__sync_second_half_origin", "__sync_second_half_revision",
    ]
    : ["__sync_external_id", "__sync_origin", "__sync_revision"];
  const adjustmentDataRowCount = Math.max(normalizedAdjustmentRows.length, metadataRows.length);
  const adjustmentData = Array.from({ length: adjustmentDataRowCount }, (_, index) => {
    const row = normalizedAdjustmentRows[index] ?? [];
    return [...row, ...Array(Math.max(config.adjustmentColumns - row.length, 0)).fill("")]
      .slice(0, config.adjustmentColumns);
  });
  const metadataData = Array.from({ length: adjustmentDataRowCount }, (_, index) => {
    const row = metadataRows[index] ?? [];
    return [...row, ...Array(Math.max(config.adjustmentMetadataColumns - row.length, 0)).fill("")]
      .slice(0, config.adjustmentMetadataColumns);
  });
  return {
    attendance: [attendanceHeader, ...attendanceRows.map((row) => [
      ...row,
      ...Array(Math.max(config.maxColumns - row.length, 0)).fill(""),
    ].slice(0, config.maxColumns))],
    leaves: [
      [`${Number(config.month.slice(5))}月份`, "", "", "", ""],
      ["日期", "姓名", "ID", "类型", "备注"],
      ...leaveRows.map((row) => [...row, ...Array(Math.max(config.leaveColumns - row.length, 0)).fill("")]
        .slice(0, config.leaveColumns)),
    ],
    adjustments: [adjustmentMonth, adjustmentHeader, ...adjustmentData],
    adjustment_metadata: [Array(config.adjustmentMetadataColumns).fill(""), metadataHeader, ...metadataData],
    adjustment_schema: adjustmentSchema,
  };
}

async function normalizeAnnual(config: AnnualSourceConfig, values: ReturnType<typeof annualMatrices>, capturedAt = "2026-08-25T01:00:00.000Z") {
  return await normalizeSnapshot({
    request_id: "223e4567-e89b-42d3-a456-426614174000",
    trigger_kind: "change",
    source: annualSourcePayload(config),
    snapshot_hash: await sha256Hex(JSON.stringify(values)),
    captured_at: capturedAt,
    values,
  });
}

Deno.test("allowlists exactly twelve annual September-December logical sources", () => {
  const annual = ALLOWED_SOURCES.filter((candidate) => candidate.mode === "annual");
  assert(annual.length === 12, `expected 12 annual sources, got ${annual.length}`);
  assert(new Set(annual.map((candidate) => candidate.sourceKey)).size === 12, "annual source keys are not unique");
  assert(
    annual.every((candidate) =>
      candidate.currency === (candidate.workbookKey === "home_ph" ? "PHP" : "USD")
    ),
    "annual source allowlist contains the wrong currency",
  );
});

Deno.test("normalizes sparse annual attendance and signed USD adjustments by employee ID", async () => {
  const config = annualConfig("onsite_annual_2026_09");
  const employee = Array(config.maxColumns).fill("");
  employee[config.nameColumn] = "测试员工";
  employee[config.employeeNoColumn] = " WD-100 ";
  employee[config.countryColumn ?? 0] = "越南";
  employee[config.positionColumn] = "财务";
  employee[config.platformColumn] = "测试盘口";
  employee[config.dayStartColumn] = "公";
  employee[config.dayStartColumn + 1] = "旷工";
  employee[config.dayStartColumn + 2] = "正常";
  employee[config.dayStartColumn + 3] = "离";
  const values = annualMatrices(config, [employee], [
    ["测试员工", "WD-100", "100", "-25", "奖罚备注", "2026-09-05"],
    ["零金额", "WD-101", "0", "", "不落库", "2026-09-06"],
  ]);
  const result = await normalizeAnnual(config, values);
  assert(result.sync_contract === "annual_v1", "annual RPC contract was not selected");
  assert(result.rows.length === 5, `expected 5 sparse records, got ${result.rows.length}`);
  assert(result.parse_warning_count === 1, "unknown normal marker should be a single warning");
  assert(result.rows.some((row) => row.event_kind === "public_holiday"), "public holiday shorthand failed");
  assert(result.rows.some((row) => row.event_kind === "absence"), "旷工 did not map to absence");
  assert(result.rows.some((row) => row.kind === "resignation" && row.event_kind === "resignation"), "离职 was not canonical");
  assert(
    result.rows.filter((row) => row.kind !== "adjustment").every((row) => row.currency === null),
    "non-adjustment annual records received a currency",
  );
  const adjustments = result.rows.filter((row) => row.kind === "adjustment");
  assert(adjustments.length === 2, "zero/blank adjustment was persisted");
  assert(adjustments[0].employee_no_raw === "WD-100", "employee ID was not preserved for primary matching");
  assert(adjustments.some((row) => row.amount === 100 && row.event_kind === "bonus"), "positive amount was not bonus");
  assert(adjustments.some((row) => row.amount === -25 && row.event_kind === "deduction"), "negative amount was not deduction");
  assert(adjustments.every((row) => row.reason === "测试类型"), "standard 类型 was not persisted as reason");
  assert(adjustments.every((row) => row.raw_values.currency === "USD"), "onsite currency audit was not USD");
  assert(adjustments.every((row) => row.currency === "USD"), "onsite allowlisted currency was not normalized");
});

Deno.test("休假填表 is authoritative over the monthly grid and preserves the note", async () => {
  const config = annualConfig("home_vimm_annual_2026_09");
  const employee = Array(config.maxColumns).fill("");
  employee[config.nameColumn] = "Leave Employee";
  employee[config.employeeNoColumn] = "LEAVE-1";
  employee[config.dayStartColumn + 4] = "公休";
  const values = annualMatrices(
    config,
    [employee],
    [],
    [],
    [["2026-09-05", "Leave Employee", "LEAVE-1", "请假", "medical appointment"]],
  );
  const result = await normalizeAnnual(config, values);
  const rows = result.rows.filter((row) => row.event_date === "2026-09-05");
  assert(rows.length === 1, "monthly grid duplicated the authoritative leave row");
  assert(rows[0].event_kind === "leave", "leave type did not override the grid status");
  assert(rows[0].reason === "请假" && rows[0].note === "medical appointment", "leave explanation was lost");
  assert(rows[0].raw_values.source_tab === "休假填表", "leave provenance was not preserved");
});

Deno.test("legacy six-column standard adjustments remain readable without shifting note/date", async () => {
  const config = annualConfig("onsite_annual_2026_09");
  const values = annualMatrices(
    config,
    [],
    [["Legacy", "LEG-1", "", "-10", "late 10 minutes", "2026-09-06"]],
    [],
    [],
    "legacy_without_category",
  );
  const result = await normalizeAnnual(config, values);
  const adjustment = result.rows.find((row) => row.kind === "adjustment");
  assert(adjustment?.event_date === "2026-09-06", "legacy date shifted columns");
  assert(adjustment?.note === "late 10 minutes", "legacy note shifted columns");
  assert(adjustment?.reason === "扣款" && adjustment.raw_values.raw_type === "扣款", "legacy type fallback failed");
});

Deno.test("Philippines half-month amounts create two stable PHP records with paired notes", async () => {
  const config = annualConfig("home_ph_annual_2026_09");
  const values = annualMatrices(config, [], [[
    "PH EMPLOYEE", "PH-100", "300", "绩效奖金", "-50", "迟到 / 超时",
    "first note", "second note", "09/15/2026",
  ]]);
  const result = await normalizeAnnual(config, values);
  assert(result.rows.length === 2, "PH half-month amounts did not create two records");
  const first = result.rows.find((row) => row.raw_values.source_slot === "first_half");
  const second = result.rows.find((row) => row.raw_values.source_slot === "second_half");
  assert(first?.amount === 300 && first.note === "first note" && first.event_kind === "bonus", "first half mapping failed");
  assert(second?.amount === -50 && second.note === "second note" && second.event_kind === "deduction", "second half mapping failed");
  assert(first?.reason === "绩效奖金" && second?.reason === "迟到 / 超时", "PH 类型 mapping failed");
  assert(first?.event_date === second?.event_date, "PH half-month records did not share the row date");
  assert(first?.source_item_key !== second?.source_item_key, "PH half-month stable keys collided");
  assert(first?.raw_values.currency === "PHP" && second?.raw_values.currency === "PHP", "PH currency audit was not PHP");
  assert(first?.currency === "PHP" && second?.currency === "PHP", "PH allowlisted currency was not normalized");
});

Deno.test("standard managed metadata suppresses the whole adjustment row", async () => {
  const config = annualConfig("onsite_annual_2026_09");
  const values = annualMatrices(config, [], [
    ["MANAGED", "WD-M", "100", "-20", "owned by adjustment-v1", "2026-09-05"],
    ["UNMANAGED", "WD-U", "30", "", "annual-owned", "2026-09-06"],
  ], [
    ["7985fb59-b915-47e9-a115-feacc3ab52a1", "supabase", "2"],
    ["", "", ""],
  ]);
  const result = await normalizeAnnual(config, values);
  const adjustments = result.rows.filter((row) => row.kind === "adjustment");
  assert(adjustments.length === 1, "managed standard row was duplicated by annual sync");
  assert(adjustments[0].employee_no_raw === "WD-U", "unmanaged standard row was skipped");
});

Deno.test("Philippines managed metadata suppresses slots independently", async () => {
  const config = annualConfig("home_ph_annual_2026_10");
  const values = annualMatrices(config, [], [[
    "PH", "PH-SLOT", "300", "奖励", "-50", "迟到 / 超时",
    "managed first", "annual second", "2026-10-20",
  ]], [[
    "7985fb59-b915-47e9-a115-feacc3ab52a1", "google", "4", "", "", "",
  ]]);
  const result = await normalizeAnnual(config, values);
  const adjustments = result.rows.filter((row) => row.kind === "adjustment");
  assert(adjustments.length === 1, "PH managed slot did not suppress exactly one record");
  assert(adjustments[0].raw_values.source_slot === "second_half", "wrong PH slot survived");
  assert(adjustments[0].amount === -50, "unmanaged PH slot amount changed");
});

Deno.test("fails closed on partial or invalid managed metadata", async () => {
  const standard = annualConfig("home_vimm_annual_2026_11");
  const partial = annualMatrices(standard, [], [[
    "A", "ID-A", "12", "", "n", "2026-11-03",
  ]], [["7985fb59-b915-47e9-a115-feacc3ab52a1", "", "1"]]);
  let partialRejected = false;
  try {
    await normalizeAnnual(standard, partial);
  } catch (error) {
    partialRejected = error instanceof Error && error.message.startsWith("adjustment_metadata_invalid:");
  }
  assert(partialRejected, "partial standard metadata was accepted");

  const ph = annualConfig("home_ph_annual_2026_12");
  const invalidSecondSlot = annualMatrices(ph, [], [[
    "B", "ID-B", "10", "奖励", "20", "奖励", "a", "b", "2026-12-20",
  ]], [[
    "7985fb59-b915-47e9-a115-feacc3ab52a1", "google", "1",
    "not-a-uuid", "supabase", "2",
  ]]);
  let phRejected = false;
  try {
    await normalizeAnnual(ph, invalidSecondSlot);
  } catch (error) {
    phRejected = error instanceof Error && error.message.startsWith("adjustment_metadata_invalid:");
  }
  assert(phRejected, "invalid PH slot metadata was accepted");
});

Deno.test("Philippines non-zero half-month amount requires its own 类型", async () => {
  const config = annualConfig("home_ph_annual_2026_11");
  const values = annualMatrices(config, [], [[
    "PH", "PH-TYPE", "100", "", "-20", "迟到 / 超时", "first", "second", "2026-11-10",
  ]]);
  let rejected = false;
  try {
    await normalizeAnnual(config, values);
  } catch (error) {
    rejected = error instanceof Error && error.message === "adjustment_type_required:row_3";
  }
  assert(rejected, "PH amount without its paired 类型 was accepted");
});

Deno.test("managed metadata is part of the annual snapshot hash", async () => {
  const config = annualConfig("onsite_annual_2026_12");
  const values = annualMatrices(config, [], [[
    "A", "ID-A", "10", "", "n", "2026-12-03",
  ]], [["7985fb59-b915-47e9-a115-feacc3ab52a1", "google", "1"]]);
  const originalHash = await sha256Hex(JSON.stringify(values));
  values.adjustment_metadata[2][2] = "2";
  let rejected = false;
  try {
    await normalizeSnapshot({
      request_id: "223e4567-e89b-42d3-a456-426614174000",
      trigger_kind: "change",
      source: annualSourcePayload(config),
      snapshot_hash: originalHash,
      captured_at: "2026-08-25T01:00:00.000Z",
      values,
    });
  } catch (error) {
    rejected = error instanceof Error && error.message === "snapshot_hash_mismatch";
  }
  assert(rejected, "metadata change did not invalidate the snapshot hash");
});

Deno.test("annual record identity does not depend on the physical source row", async () => {
  const config = annualConfig("home_vimm_annual_2026_10");
  const employee = Array(config.maxColumns).fill("");
  employee[config.nameColumn] = "ROW SHIFT";
  employee[config.employeeNoColumn] = "SHIFT-1";
  employee[config.dayStartColumn] = "请";
  const beforeValues = annualMatrices(config, [employee], []);
  const afterValues = annualMatrices(config, [Array(config.maxColumns).fill(""), employee], []);
  const before = await normalizeAnnual(config, beforeValues);
  const after = await normalizeAnnual(config, afterValues);
  assert(before.rows[0].source_item_key === after.rows[0].source_item_key, "physical row changed stable item key");
  assert(before.rows[0].source_row === after.rows[0].source_row, "physical row changed stable synthetic row");
});

Deno.test("annual capture timestamps do not change record content hashes", async () => {
  const config = annualConfig("home_vimm_annual_2026_11");
  const values = annualMatrices(config, [], [["A", "ID-A", "12", "", "n", "2026-11-03"]]);
  const first = await normalizeAnnual(config, values, "2026-08-25T01:00:00.000Z");
  const second = await normalizeAnnual(config, values, "2026-08-25T02:00:00.000Z");
  assert(first.rows[0].content_hash === second.rows[0].content_hash, "capture time changed annual content hash");
});

Deno.test("rejects a lookalike annual source and reports source_not_allowlisted", async () => {
  const config = annualConfig("home_ph_annual_2026_12");
  const values = annualMatrices(config, [], []);
  let rejected = false;
  try {
    await normalizeSnapshot({
      request_id: "223e4567-e89b-42d3-a456-426614174000",
      trigger_kind: "change",
      source: { ...annualSourcePayload(config), adjustment_sheet_gid: "wrong-gid" },
      snapshot_hash: await sha256Hex(JSON.stringify(values)),
      captured_at: "2026-08-25T01:00:00.000Z",
      values,
    });
  } catch (error) {
    rejected = error instanceof Error && error.message === "source_not_allowlisted";
  }
  assert(rejected, "lookalike annual source was accepted or returned an unclear error");
});

Deno.test("rejects non-zero annual adjustments without an in-month date", async () => {
  const config = annualConfig("onsite_annual_2026_12");
  const values = annualMatrices(config, [], [["A", "ID-A", "10", "", "missing date", ""]]);
  let rejected = false;
  try {
    await normalizeAnnual(config, values);
  } catch (error) {
    rejected = error instanceof Error && error.message === "adjustment_date_required";
  }
  assert(rejected, "dated adjustment validation did not fail closed");
});
