import {
  HOME_ROSTER_HEADERS,
  HOME_ROSTER_SOURCE,
  normalizeSnapshot,
  PARSER_VERSION,
  SCHEDULE_ROSTER_HEADERS,
  SCHEDULE_ROSTER_SOURCE,
  sha256Hex,
  SnapshotValidationError,
} from "./normalize.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const homeSource = {
  source_key: HOME_ROSTER_SOURCE.sourceKey,
  spreadsheet_id: HOME_ROSTER_SOURCE.spreadsheetId,
  sheet_gid: HOME_ROSTER_SOURCE.sheetGid,
  tab_name: HOME_ROSTER_SOURCE.tabName,
};

const scheduleSource = {
  source_key: SCHEDULE_ROSTER_SOURCE.sourceKey,
  spreadsheet_id: SCHEDULE_ROSTER_SOURCE.spreadsheetId,
  sheet_gid: SCHEDULE_ROSTER_SOURCE.sheetGid,
  tab_name: SCHEDULE_ROSTER_SOURCE.tabName,
};

const homeValues = (rows: string[][]) => [
  ["", "居家在职资料", ...Array(14).fill("")],
  [...HOME_ROSTER_HEADERS],
  ...rows.map((row) => [...row]),
];

const scheduleValues = (rows: string[][]) => [
  [...SCHEDULE_ROSTER_HEADERS],
  ...rows.map((row) => [...row]),
];

const homeSemanticProjection = (values: string[][], dateValues: string[][]) => {
  let end = values.length;
  while (end > HOME_ROSTER_SOURCE.headerRow) {
    const row = values[end - 1].slice(0, 12);
    const dates = dateValues[end - 1] ?? ["", ""];
    if (row.some((cell) => String(cell ?? "").trim()) || dates.some((cell) => String(cell ?? "").trim())) break;
    end -= 1;
  }
  return {
    values: values.slice(0, end).map((row) => row.slice(0, 12)),
    date_values: dateValues.slice(0, end),
  };
};

const payloadFor = async (
  home: string[][],
  schedule: string[][],
  homeDates: string[][],
  overrides: Record<string, unknown> = {},
) => {
  const homeHash = await sha256Hex(JSON.stringify({ values: home, date_values: homeDates }));
  const homeSemanticHash = await sha256Hex(JSON.stringify(homeSemanticProjection(home, homeDates)));
  const scheduleHash = await sha256Hex(JSON.stringify(schedule));
  return {
    request_id: "123e4567-e89b-42d3-a456-426614174000",
    trigger_kind: "change",
    captured_at: "2026-08-25T01:02:03.000Z",
    snapshot_hash: await sha256Hex(JSON.stringify({ home: homeSemanticHash, schedule: scheduleHash })),
    sources: {
      home_roster: { source: homeSource, snapshot_hash: homeHash, values: home, date_values: homeDates },
      schedule_roster: { source: scheduleSource, snapshot_hash: scheduleHash, values: schedule },
    },
    ...overrides,
  };
};

const baseHomeRows = [[
  "AR印度", "JAICLUB/OKWIN", "出款", "早班Day", "菲律宾", "Alice A", "wd001",
  "2026年8月1日", "", "tg-alice", "account-a", "", "970", "", "5000", "3000",
]];

const baseScheduleRows = [[
  "负责人甲", "现场培训乙", "线上组长丙", "线上培训丁", "出款组1", "AR印度", "Alice A", "WD001",
  "白班 Day", "菲律宾", "助理", "所有盘口", "居家工单",
]];

Deno.test("normalizes the atomic home and schedule snapshot", async () => {
  const home = homeValues(baseHomeRows);
  const schedule = scheduleValues(baseScheduleRows);
  const dateValues = [["", ""], ["", ""], ["2026-08-01", ""]];
  const result = await normalizeSnapshot(await payloadFor(home, schedule, dateValues));
  assert(PARSER_VERSION === "employee-master-dual-source-v1", "database parser contract drifted");
  assert(result.parser_version === PARSER_VERSION, "payload parser version mismatch");
  assert(result.home_rows.length === 1, "home row count mismatch");
  assert(result.schedule_rows.length === 1, "schedule row count mismatch");
  assert(result.home_rows[0].employee_id === "WD001", "home ID was not normalized");
  assert(result.home_rows[0].hire_date === "2026-08-01", "home hire date mismatch");
  assert(result.home_rows[0].explicitly_resigned === false, "active row was marked resigned");
  assert(result.schedule_rows[0].position === "助理", "schedule position mismatch");
  assert(result.home_rows[0].shift === "白班 Day", "home shift alias was not canonicalized");
  assert(result.schedule_rows[0].shift === "白班 Day", "schedule shift alias was not canonicalized");
});

Deno.test("M:P compensation changes alter raw integrity but not employee-master semantics", async () => {
  const originalHome = homeValues(baseHomeRows);
  const originalDates = [["", ""], ["", ""], ["2026-08-01", ""]];
  const original = await normalizeSnapshot(await payloadFor(
    originalHome,
    scheduleValues(baseScheduleRows),
    originalDates,
  ));

  const changedHome = homeValues([[
    ...baseHomeRows[0].slice(0, 12),
    "different salary", "different raise", "different performance", "different KPI",
  ], [
    "", "", "", "", "", "", "", "", "", "", "", "",
    "M:P-only trailing row", "", "", "",
  ]]);
  const changedDates = [["", ""], ["", ""], ["2026-08-01", ""], ["", ""]];
  const changed = await normalizeSnapshot(await payloadFor(
    changedHome,
    scheduleValues(baseScheduleRows),
    changedDates,
  ));

  assert(original.snapshot_hash === changed.snapshot_hash, "M:P changed the semantic combined hash");
  assert(original.sources.home_roster.snapshot_hash !== changed.sources.home_roster.snapshot_hash,
    "M:P did not remain covered by the raw integrity hash");
  assert(original.sources.home_roster.semantic_snapshot_hash === changed.sources.home_roster.semantic_snapshot_hash,
    "home semantic source hash changed for M:P-only edits");
});

Deno.test("raw formatting churn keeps the canonical database dedupe hash stable", async () => {
  const originalHome = homeValues(baseHomeRows);
  const originalSchedule = scheduleValues(baseScheduleRows);
  const originalDates = [["", ""], ["", ""], ["2026-08-01", ""]];
  const original = await normalizeSnapshot(await payloadFor(
    originalHome,
    originalSchedule,
    originalDates,
  ));

  const formattedHome = homeValues([[
    ...baseHomeRows[0],
  ]]);
  formattedHome[2][3] = " DAY SHIFT ";
  formattedHome[2][5] = "  Alice A  ";
  formattedHome[2][6] = " ｗｄ００１ ";
  formattedHome[2][7] = "08/01/2026";
  const formattedSchedule = scheduleValues([[
    ...baseScheduleRows[0],
  ]]);
  formattedSchedule[1][6] = " Alice A ";
  formattedSchedule[1][7] = " wd001 ";
  formattedSchedule[1][8] = "DAY SHIFT";
  const formatted = await normalizeSnapshot(await payloadFor(
    formattedHome,
    formattedSchedule,
    originalDates,
  ));

  assert(original.sources.home_roster.snapshot_hash !== formatted.sources.home_roster.snapshot_hash,
    "raw home integrity hash did not capture formatting changes");
  assert(original.snapshot_hash === formatted.snapshot_hash,
    "normalized-equivalent rows changed the database dedupe hash");
  assert(original.sources.home_roster.semantic_snapshot_hash === formatted.sources.home_roster.semantic_snapshot_hash,
    "normalized-equivalent home rows changed their canonical hash");
  assert(original.sources.schedule_roster.semantic_snapshot_hash === formatted.sources.schedule_roster.semantic_snapshot_hash,
    "normalized-equivalent schedule rows changed their canonical hash");
});

Deno.test("schedule source row moves and array order do not trigger a database reconciliation", async () => {
  const home = homeValues(baseHomeRows);
  const dates = [["", ""], ["", ""], ["2026-08-01", ""]];
  const first = [
    ...baseScheduleRows[0],
  ];
  const second = [
    "负责人乙", "现场培训丙", "线上组长丁", "线上培训戊", "客服组2", "熊猫PH", "Bob B", "WD002",
    "夜班", "菲律宾", "客服", "PANDA", "居家客服",
  ];
  const original = await normalizeSnapshot(await payloadFor(
    home,
    scheduleValues([first, second]),
    dates,
  ));
  const reordered = await normalizeSnapshot(await payloadFor(
    home,
    scheduleValues([second, first]),
    dates,
  ));

  assert(original.sources.schedule_roster.snapshot_hash !== reordered.sources.schedule_roster.snapshot_hash,
    "raw schedule integrity hash ignored the row movement");
  assert(original.sources.schedule_roster.semantic_snapshot_hash === reordered.sources.schedule_roster.semantic_snapshot_hash,
    "source-row movement changed the canonical schedule hash");
  assert(original.snapshot_hash === reordered.snapshot_hash,
    "source-row movement changed the canonical combined hash");
  assert(original.schedule_rows[0].source_row !== reordered.schedule_rows[1].source_row,
    "test fixture did not actually move the source row");
});

Deno.test("real schedule group and work-content changes remain hash-significant", async () => {
  const home = homeValues(baseHomeRows);
  const dates = [["", ""], ["", ""], ["2026-08-01", ""]];
  const originalSchedule = scheduleValues(baseScheduleRows);
  const original = await normalizeSnapshot(await payloadFor(home, originalSchedule, dates));

  const changedGroupRows = baseScheduleRows.map((row) => [...row]);
  changedGroupRows[0][4] = "出款组2";
  const changedGroup = await normalizeSnapshot(await payloadFor(
    home,
    scheduleValues(changedGroupRows),
    dates,
  ));
  assert(original.sources.schedule_roster.semantic_snapshot_hash !== changedGroup.sources.schedule_roster.semantic_snapshot_hash,
    "a real schedule group change was excluded from the canonical hash");

  const changedWorkRows = baseScheduleRows.map((row) => [...row]);
  changedWorkRows[0][12] = "现场人员-不同工作内容";
  const changedWork = await normalizeSnapshot(await payloadFor(
    home,
    scheduleValues(changedWorkRows),
    dates,
  ));
  assert(original.sources.schedule_roster.semantic_snapshot_hash !== changedWork.sources.schedule_roster.semantic_snapshot_hash,
    "a real work-content change was excluded from the canonical hash");
});

Deno.test("keeps explicit resignation signals instead of trusting the tab title", async () => {
  const home = homeValues([
    ["AR印度", "P", "客服", "白班", "菲律宾", "Date resigned", "WD002", "", "2026年 08月 12日", "", "", "reason", "", "", "", ""],
    ["AR印度", "P", "客服", "白班", "菲律宾", "Account resigned", "WD003", "", "", "", "辞职", "terminated", "", "", "", ""],
    ...baseHomeRows,
  ]);
  const schedule = scheduleValues(baseScheduleRows);
  const dateValues = [["", ""], ["", ""], ["", "2026-08-12"], ["", ""], ["2026-08-01", ""]];
  const result = await normalizeSnapshot(await payloadFor(home, schedule, dateValues));
  assert(result.home_rows[0].resignation_signal === "date", "date resignation was missed");
  assert(result.home_rows[1].resignation_signal === "account_marker", "account marker resignation was missed");
});

Deno.test("does not treat negative resignation phrases as explicit resignation", async () => {
  const negativeMarkers = ["未离职", "非離職", "not-resigned", "not terminated"];
  const home = homeValues([
    ...negativeMarkers.map((marker, index) => [
      "AR印度", "P", "客服", "白班", "菲律宾", `Active ${index}`, `WD-NOT-${index}`,
      "", "", "", marker, "", "", "", "", "",
    ]),
    ...baseHomeRows,
  ]);
  const schedule = scheduleValues(baseScheduleRows);
  const dateValues = [
    ["", ""], ["", ""],
    ...negativeMarkers.map(() => ["", ""]),
    ["2026-08-01", ""],
  ];
  const result = await normalizeSnapshot(await payloadFor(home, schedule, dateValues));
  assert(result.home_rows.slice(0, negativeMarkers.length).every((row) => !row.explicitly_resigned),
    "a negative resignation phrase was treated as resigned");
});

Deno.test("normalizes NFKC employee IDs and removes zero-width characters", async () => {
  const home = homeValues([[
    "AR印度", "P", "客服", "白班", "菲律宾", "NFKC employee", "ｗｄ\u200b００９",
    "", "", "", "", "", "", "", "", "",
  ]]);
  const schedule = scheduleValues([[
    "", "", "", "", "", "AR印度", "NFKC employee", "WD009", "DAY SHIFT",
    "菲律宾", "客服", "P", "",
  ]]);
  const dateValues = [["", ""], ["", ""], ["", ""]];
  const result = await normalizeSnapshot(await payloadFor(home, schedule, dateValues));
  assert(result.home_rows[0].employee_id === "WD009", "home NFKC/zero-width ID normalization failed");
  assert(result.schedule_rows[0].employee_id === "WD009", "schedule normalized ID mismatch");
});

Deno.test("keeps same-ID rows when cross-source names differ", async () => {
  const home = homeValues(baseHomeRows);
  const schedule = scheduleValues([[...baseScheduleRows[0].slice(0, 6), "Different Person", ...baseScheduleRows[0].slice(7)]]);
  const dateValues = [["", ""], ["", ""], ["2026-08-01", ""]];
  const result = await normalizeSnapshot(await payloadFor(home, schedule, dateValues));
  assert(result.home_rows[0].employee_id === "WD001", "home identity was not retained");
  assert(result.home_rows[0].name === "Alice A", "official home name was changed");
  assert(result.schedule_rows[0].employee_id === "WD001", "schedule identity was not retained");
  assert(result.schedule_rows[0].name === "Different Person", "schedule source evidence was changed");
});

Deno.test("allows a historical resigned row without ID but rejects an active one", async () => {
  const resigned = homeValues([
    ["AR印度", "P", "客服", "白班", "菲律宾", "Old employee", "", "", "2026-01-02", "", "", "", "", "", "", ""],
    ...baseHomeRows,
  ]);
  const schedule = scheduleValues(baseScheduleRows);
  const resignedDates = [["", ""], ["", ""], ["", "2026-01-02"], ["2026-08-01", ""]];
  const result = await normalizeSnapshot(await payloadFor(resigned, schedule, resignedDates));
  assert(result.parse_warning_count >= 1, "historical missing ID did not warn");

  const active = homeValues([
    ["AR印度", "P", "客服", "白班", "菲律宾", "Active employee", "", "", "", "", "", "", "", "", "", ""],
    ...baseHomeRows,
  ]);
  const activeDates = [["", ""], ["", ""], ["", ""], ["2026-08-01", ""]];
  let error: unknown;
  try {
    await normalizeSnapshot(await payloadFor(active, schedule, activeDates));
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof SnapshotValidationError && error.code === "home_active_row_missing_employee_id", "active missing ID was accepted");
});

Deno.test("keeps the latest schedule assignment for a repeated ID", async () => {
  const home = homeValues(baseHomeRows);
  const schedule = scheduleValues([
    ["", "", "", "", "审单财务组1", "熊猫PH", "AKI", "FZ526082415", "白班", "菲律宾", "客服", "学熊猫PH", ""],
    ["", "", "", "", "客服组43", "熊猫PH", "AKI", " fz526082415 ", "白班", "菲律宾", "客服", "AA45/F75", ""],
  ]);
  const dateValues = [["", ""], ["", ""], ["2026-08-01", ""]];
  const result = await normalizeSnapshot(await payloadFor(home, schedule, dateValues));
  assert(result.schedule_rows.length === 1, "duplicate identity was not collapsed");
  assert(result.schedule_rows[0].source_row === 3, "latest schedule row was not retained");
  assert(result.schedule_rows[0].group === "客服组43", "latest assignment was not retained");
  assert(result.parse_warning_count >= 1, "resolved duplicate should warn");
});

Deno.test("rejects source drift and a changed payload with a reused hash", async () => {
  const home = homeValues(baseHomeRows);
  const schedule = scheduleValues(baseScheduleRows);
  const dateValues = [["", ""], ["", ""], ["2026-08-01", ""]];
  const sourceDrift = await payloadFor(home, schedule, dateValues);
  (sourceDrift.sources.home_roster as any).source = { ...homeSource, spreadsheet_id: "wrong" };
  let sourceError: unknown;
  try {
    await normalizeSnapshot(sourceDrift);
  } catch (caught) {
    sourceError = caught;
  }
  assert(sourceError instanceof SnapshotValidationError && sourceError.code === "source_not_allowlisted", "source drift was accepted");

  const changed = await payloadFor(home, schedule, dateValues);
  changed.sources.schedule_roster.values[1][6] = "Changed Name";
  let hashError: unknown;
  try {
    await normalizeSnapshot(changed);
  } catch (caught) {
    hashError = caught;
  }
  assert(hashError instanceof SnapshotValidationError && hashError.code === "snapshot_hash_mismatch", "reused hash was accepted");
});
