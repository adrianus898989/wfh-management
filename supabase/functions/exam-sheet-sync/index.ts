import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SHEET_ID = "12kErprGLOnqhA35B4AStu9dcpGKDVCBBHdVT89RDTjc";
const SHEET_NAME = "Sheet1";

const text = (value: unknown) => String(value ?? "").trim();
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_NAME)}&range=A1:K`;
    const response = await fetch(url, { headers: { "user-agent": "WFH-Exam-Sync/1.0" } });
    if (!response.ok) throw new Error(`Google Sheet HTTP ${response.status}`);
    const raw = await response.text();
    const match = raw.match(/google\.visualization\.Query\.setResponse\((.*)\);?\s*$/s);
    if (!match) throw new Error("Google Sheet response format is invalid");
    const table = JSON.parse(match[1]).table;
    // GViz exposes row 1 as column labels, so table.rows already starts at sheet row 2.
    const sourceRows = Array.isArray(table?.rows) ? table.rows : [];
    const rows = sourceRows.flatMap((row: { c?: Array<{ v?: unknown }> }, index: number) => {
      const cells = row.c ?? [];
      const value = (column: number) => cells[column]?.v;
      const seriesName = text(value(0));
      const positionName = text(value(1));
      const teamName = text(value(10));
      const points = Number(value(5));
      const difficulty = Number(value(6));
      const questionEn = text(value(2));
      const questionZh = text(value(3));
      const questionVi = text(value(4));
      if (!teamName || !seriesName || !positionName || ![5, 10, 20].includes(points) || ![1, 2, 3].includes(difficulty) || !(questionEn || questionZh || questionVi)) return [];
      const sheetRow = index + 2;
      return [{
        external_key: `GS-${String(sheetRow).padStart(6, "0")}`,
        sheet_row: sheetRow,
        series_name: seriesName,
        position_name: positionName,
        team_name: teamName,
        question_en: questionEn,
        question_zh: questionZh,
        question_vi: questionVi,
        points,
        difficulty,
        image_urls: [value(7), value(8), value(9)].map(text).filter(Boolean),
      }];
    });

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase runtime credentials are unavailable");
    const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data, error } = await client.rpc("sync_exam_questions_from_sheet", { p_rows: rows, p_read_count: sourceRows.length });
    if (error) throw error;
    return jsonResponse({ ok: true, ...data });
  } catch (error) {
    console.error("exam-sheet-sync", error);
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
