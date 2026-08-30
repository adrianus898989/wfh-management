import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { normalizeEmployeeErrors } from "./errorNormalization.ts";

Deno.test("finance error rows accept the live first-column header a", () => {
  const rows = normalizeEmployeeErrors([{
    a: " ym525030501 ",
    "会员/id /订单号": "ORDER-1",
    "错误备注": "wrong remark",
    "正确操作方式": "double check",
    "错误类型": "错误备注 / Wrong Use Remark",
    "扣分": "1",
    "质检人": "小权",
    "质检时间": "30 August 2026",
    "小组长复审": "小权",
    "质检人对错": "正确",
    "复检时间": "2026/8/30",
  }], "财务质检错误记录/财务质检错误记录");

  assertEquals(rows.length, 1);
  assertEquals(rows[0].employee_id, "YM525030501");
  assertEquals(rows[0].qc_date, "2026-08-30");
  assertEquals(rows[0].review_date, "2026-08-30");
  assertEquals(rows[0].source_row, 2);
  assertMatch(rows[0].record_key, /^YM525030501\|2026-08-30\|[a-z0-9]+$/);
});

Deno.test("canonical employee ID header wins over the compatibility alias", () => {
  const rows = normalizeEmployeeErrors([{
    ID: "WD000253",
    a: "WRONG-ID",
    "错误备注": "delayed confirmation",
  }], "source");

  assertEquals(rows[0].employee_id, "WD000253");
});

Deno.test("rows without an employee ID are not synchronized", () => {
  const rows = normalizeEmployeeErrors([{
    a: "",
    "错误备注": "header or blank row",
  }], "source");

  assertEquals(rows, []);
});
