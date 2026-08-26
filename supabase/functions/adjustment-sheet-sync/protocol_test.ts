import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { normalizeInbound, normalizeReceipts, ROUTES, stableStringify } from "./protocol.ts";

Deno.test("allowlist contains only three workbooks times four months", () => {
  assertEquals(Object.keys(ROUTES).length, 12);
  assertEquals(ROUTES.adjustment_home_ph_2026_12.currency, "PHP");
  assertEquals(ROUTES.adjustment_onsite_2026_09.sheetGid, "1011694934");
  assertEquals(ROUTES.adjustment_home_vim_2026_09.sheetGid, "3368572");
  assertEquals(ROUTES.adjustment_home_ph_2026_09.sheetGid, "687407921");
  assertEquals(ROUTES.adjustment_onsite_2026_09.layout, "standard");
  assertEquals(ROUTES.adjustment_home_ph_2026_09.layout, "philippines");
});

Deno.test("normalizes a Google inbound row and hashes deterministically", async () => {
  const input = {
    request_id: "24d973ec-7b8e-4a1a-84d4-3ac43de746ea",
    source_key: "adjustment_home_ph_2026_09",
    rows: [{
      external_id: "7985fb59-b915-47e9-a115-feacc3ab52a1",
      origin: "google",
      revision: 2,
      source_slot: "first_half",
      event_date: "2026-09-15",
      signed_amount: "-125.499",
      currency: "php",
      employee_no: " ph-12 ",
      employee_name: "Ana",
      category: "迟到 / 超时",
      note: "Late",
      google_row: 8,
    }],
  };
  const first = await normalizeInbound(input);
  const second = await normalizeInbound({ rows: input.rows, source_key: input.source_key, request_id: input.request_id });
  assertEquals(first.payload_hash, second.payload_hash);
  assertEquals(first.rows[0].signed_amount, -125.5);
  assertEquals(first.rows[0].employee_no, "PH-12");
});

Deno.test("rejects wrong month and workbook currency", async () => {
  const base = {
    request_id: "24d973ec-7b8e-4a1a-84d4-3ac43de746ea",
    source_key: "adjustment_onsite_2026_10",
    rows: [{
      external_id: "7985fb59-b915-47e9-a115-feacc3ab52a1", origin: "google", revision: 1,
      source_slot: "primary",
      event_date: "2026-09-30", signed_amount: 10, currency: "USD", employee_no: "A1",
      employee_name: "A", category: "迟到", note: "ok", google_row: 3,
    }],
  };
  await assertRejects(() => normalizeInbound(base), Error, "invalid_event_date");
  base.rows[0].event_date = "2026-10-30";
  base.rows[0].currency = "PHP";
  await assertRejects(() => normalizeInbound(base), Error, "currency_does_not_match_workbook");
});

Deno.test("accepts two independent Philippines slots on the same Google row", async () => {
  const result = await normalizeInbound({
    request_id: "24d973ec-7b8e-4a1a-84d4-3ac43de746ea",
    source_key: "adjustment_home_ph_2026_09",
    rows: [
      {
        external_id: "7985fb59-b915-47e9-a115-feacc3ab52a1", origin: "google", revision: 4,
        source_slot: "first_half", event_date: "2026-09-20", signed_amount: -25,
        currency: "PHP", employee_no: "PH-12", employee_name: "Ana",
        category: "迟到 / 超时", note: "first", google_row: 8,
      },
      {
        external_id: "bd5d7d5d-9f72-42f0-90b2-9484317070f5", origin: "google", revision: 2,
        source_slot: "second_half", event_date: "2026-09-20", signed_amount: 40,
        currency: "PHP", employee_no: "PH-12", employee_name: "Ana",
        category: "奖励", note: "second", google_row: 8,
      },
    ],
  });
  assertEquals(result.rows.map((row) => row.source_slot), ["first_half", "second_half"]);
  assertEquals(result.rows.map((row) => row.category), ["迟到 / 超时", "奖励"]);
  assertEquals(result.rows.map((row) => row.signed_amount), [-25, 40]);
});

Deno.test("requires and preserves 类型 for standard workbook rows", async () => {
  const row = {
    external_id: "7985fb59-b915-47e9-a115-feacc3ab52a1", origin: "google", revision: 1,
    source_slot: "primary", event_date: "2026-09-20", signed_amount: -10,
    currency: "USD", employee_no: "A-1", employee_name: "A", category: "迟到 / 超时",
    note: "late 10 minutes", google_row: 8,
  };
  const payload = {
    request_id: "24d973ec-7b8e-4a1a-84d4-3ac43de746ea",
    source_key: "adjustment_onsite_2026_09",
    rows: [row],
  };
  const normalized = await normalizeInbound(payload);
  assertEquals(normalized.rows[0].category, "迟到 / 超时");
  await assertRejects(
    () => normalizeInbound({ ...payload, rows: [{ ...row, category: "" }] }),
    Error,
    "invalid_adjustment_category",
  );
});

Deno.test("rejects invalid or duplicate source slots and requires employee ID", async () => {
  const row = {
    external_id: "7985fb59-b915-47e9-a115-feacc3ab52a1", origin: "google", revision: 1,
    source_slot: "first_half", event_date: "2026-09-20", signed_amount: 10,
    currency: "PHP", employee_no: "PH-12", employee_name: "Ana", category: "奖励", note: "ok", google_row: 8,
  };
  const payload = {
    request_id: "24d973ec-7b8e-4a1a-84d4-3ac43de746ea",
    source_key: "adjustment_home_ph_2026_09",
    rows: [row],
  };
  await assertRejects(
    () => normalizeInbound({ ...payload, rows: [{ ...row, source_slot: "primary" }] }),
    Error,
    "invalid_source_slot",
  );
  await assertRejects(
    () => normalizeInbound({
      ...payload,
      rows: [row, {
        ...row,
        external_id: "bd5d7d5d-9f72-42f0-90b2-9484317070f5",
        source_slot: "first_half",
      }],
    }),
    Error,
    "invalid_duplicate_source_slot",
  );
  await assertRejects(
    () => normalizeInbound({
      ...payload,
      rows: [row, { ...row }],
    }),
    Error,
    "invalid_duplicate_external_id",
  );
  await assertRejects(
    () => normalizeInbound({ ...payload, rows: [{ ...row, employee_no: "" }] }),
    Error,
    "invalid_inbound_row",
  );
  await assertRejects(
    () => normalizeInbound({ ...payload, rows: [] }),
    Error,
    "invalid_rows",
  );
  await assertRejects(
    () => normalizeInbound({ ...payload, rows: [{ ...row, category: "" }] }),
    Error,
    "invalid_adjustment_category",
  );
});

Deno.test("validates ack receipts", () => {
  assertEquals(normalizeReceipts([{
    outbox_id: "42", external_id: "7985fb59-b915-47e9-a115-feacc3ab52a1",
    revision: 3, status: "ok", sheet_row: 9, sheet_gid: "1", sheet_name: "填表",
  }])[0].sheet_row, 9);
  assertThrows(() => normalizeReceipts([{ outbox_id: "x" }]), Error, "invalid_receipt_identity");
  assertEquals(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});
