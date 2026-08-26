export const BACKEND_DATA_SCOPES = [
  "all",
  "own_team",
  "assigned_teams",
  "self",
] as const;

export type BackendDataScope = typeof BACKEND_DATA_SCOPES[number];

export type BackendDataScopeDecision =
  | { ok: true; dataScope: BackendDataScope }
  | { ok: false; reason: "invalid_scope" | "employee_required" };

const clean = (value: unknown) => String(value ?? "").trim();

/**
 * Preserve the administrator's explicit scope selection. Employee linkage is
 * only a prerequisite for the two scopes whose meaning depends on that link;
 * it must never silently coerce `all` or `assigned_teams` to `own_team`.
 */
export function decideBackendDataScope(
  requestedScope: unknown,
  employeeId: unknown,
): BackendDataScopeDecision {
  const candidate = clean(requestedScope) || "own_team";
  if (!(BACKEND_DATA_SCOPES as readonly string[]).includes(candidate)) {
    return { ok: false, reason: "invalid_scope" };
  }

  const dataScope = candidate as BackendDataScope;
  if (
    (dataScope === "self" || dataScope === "own_team") && !clean(employeeId)
  ) {
    return { ok: false, reason: "employee_required" };
  }

  return { ok: true, dataScope };
}

export function delegatedBackendDataScopeError(
  isFounder: boolean,
  dataScope: unknown,
  employeeId: unknown,
): "founder_required" | "employee_required" | null {
  if (!isFounder && clean(dataScope) === "all") return "founder_required";
  if (!isFounder && !clean(employeeId)) return "employee_required";
  return null;
}
