import {
  buildGoogleSyncEnvelope,
  googleSyncIdempotencyKey,
  teamWriteDecision,
} from "./index.ts";

function assertEquals(actual: unknown, expected: unknown, label: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${label}: expected ${right}, received ${left}`);
  }
}

Deno.test("market metadata never becomes a team write decision", () => {
  assertEquals(
    teamWriteDecision({
      market_country: "Series A",
      market_position: "Platform X",
    }),
    { provided: false, teamId: "" },
    "market-only patch",
  );
  assertEquals(
    teamWriteDecision({ team_id: "team-123", market_country: "Series A" }),
    { provided: true, teamId: "team-123" },
    "explicit team patch",
  );
  assertEquals(
    teamWriteDecision({ team_id: "" }),
    { provided: true, teamId: "" },
    "explicit team clear",
  );
});

Deno.test("Google payload envelope adds server-controlled compatibility fields", () => {
  const payload = {
    action: "upsert_employee",
    request_id: "caller-value",
    idempotency_key: "caller-value",
    employee: { employee_no: "A001", full_name: "Alice" },
  };
  const result = buildGoogleSyncEnvelope(
    payload,
    "request-123",
    "staff-sheet-v1:abc",
  );
  assertEquals(result, {
    action: "upsert_employee",
    employee: { employee_no: "A001", full_name: "Alice" },
    request_id: "request-123",
    idempotency_key: "staff-sheet-v1:abc",
  }, "Google request body");
  assertEquals(payload.request_id, "caller-value", "input remains unchanged");
});

Deno.test("Google idempotency key is stable for equivalent payloads", async () => {
  const first = await googleSyncIdempotencyKey({
    action: "upsert_employee",
    employee: { full_name: "Alice", employee_no: "A001" },
  });
  const reordered = await googleSyncIdempotencyKey({
    employee: { employee_no: "A001", full_name: "Alice" },
    action: "upsert_employee",
    request_id: "a-retry-request",
    idempotency_key: "caller-supplied",
  });
  const changed = await googleSyncIdempotencyKey({
    action: "upsert_employee",
    employee: { employee_no: "A001", full_name: "Alicia" },
  });
  assertEquals(reordered, first, "equivalent retry key");
  if (changed === first) {
    throw new Error(
      "meaningful payload changes must change the idempotency key",
    );
  }
});
