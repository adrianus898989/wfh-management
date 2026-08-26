import {
  decideBackendDataScope,
  delegatedBackendDataScopeError,
} from "./scope.ts";

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
};

Deno.test("linked backend accounts preserve an explicit all scope", () => {
  const decision = decideBackendDataScope("all", "employee-cj00104");
  assertEquals(decision.ok, true, "all scope was rejected");
  if (decision.ok) {
    assertEquals(decision.dataScope, "all", "all scope was coerced");
  }
});

Deno.test("linked backend accounts preserve every explicit scope", () => {
  for (const scope of ["self", "own_team", "assigned_teams"] as const) {
    const decision = decideBackendDataScope(scope, "employee-id");
    assertEquals(decision.ok, true, `${scope} was rejected`);
    if (decision.ok) {
      assertEquals(decision.dataScope, scope, `${scope} was changed`);
    }
  }
});

Deno.test("only employee-dependent scopes require a linked employee", () => {
  for (const scope of ["self", "own_team"] as const) {
    const decision = decideBackendDataScope(scope, "");
    assertEquals(decision.ok, false, `${scope} accepted a missing employee`);
    if (!decision.ok) {
      assertEquals(
        decision.reason,
        "employee_required",
        `${scope} returned the wrong error`,
      );
    }
  }

  for (const scope of ["all", "assigned_teams"] as const) {
    const decision = decideBackendDataScope(scope, "");
    assertEquals(
      decision.ok,
      true,
      `${scope} incorrectly required an employee`,
    );
  }
});

Deno.test("unknown scopes fail closed", () => {
  const decision = decideBackendDataScope("organization_plus", "employee-id");
  assertEquals(decision.ok, false, "unknown scope was accepted");
  if (!decision.ok) {
    assertEquals(
      decision.reason,
      "invalid_scope",
      "unknown scope returned the wrong error",
    );
  }
});

Deno.test("only Founder can delegate all scope", () => {
  assertEquals(
    delegatedBackendDataScopeError(false, "all", "employee-id"),
    "founder_required",
    "a non-Founder could delegate all scope",
  );
  assertEquals(
    delegatedBackendDataScopeError(true, "all", "employee-id"),
    null,
    "Founder could not delegate all scope",
  );
});

Deno.test("non-Founder delegation still requires an employee link", () => {
  assertEquals(
    delegatedBackendDataScopeError(false, "assigned_teams", ""),
    "employee_required",
    "a non-Founder could delegate scope without an employee link",
  );
});
