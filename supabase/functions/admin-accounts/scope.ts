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

const cleanList = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(clean).filter(Boolean))];
};

export type CurrentTeamIdPartition = {
  currentTeamIds: string[];
  staleTeamIds: string[];
};

export type CurrentScopeAssignment = {
  employee_id?: unknown;
  team_id?: unknown;
  position_id?: unknown;
};

export type AssignedScopeBoundaryDecision =
  | {
    ok: true;
    teamIds: string[];
    positionIds: string[];
    employeeIds: string[];
    effectiveEmployeeIds: string[];
  }
  | {
    ok: false;
    reason:
      | "team_required"
      | "team_not_current"
      | "position_not_in_selected_team"
      | "employee_not_in_selected_team"
      | "empty_effective_scope";
    invalidId?: string;
  };

/**
 * Enforce the durable boundary for a manually assigned backend scope.
 *
 * Selected teams are always the hard ceiling. Positions narrow employees
 * inside those teams, while explicitly selected employees may supplement a
 * position filter only when their current roster team is still selected.
 * Historical employee.team_id / position_id values are deliberately ignored.
 */
export function validateAssignedScopeBoundary(
  teamIds: unknown,
  positionIds: unknown,
  employeeIds: unknown,
  currentAssignments: CurrentScopeAssignment[],
): AssignedScopeBoundaryDecision {
  const selectedTeamIds = cleanList(teamIds);
  const selectedPositionIds = cleanList(positionIds);
  const selectedEmployeeIds = cleanList(employeeIds);
  if (!selectedTeamIds.length) return { ok: false, reason: "team_required" };

  const teamSet = new Set(selectedTeamIds);
  const positionSet = new Set(selectedPositionIds);
  const employeeSet = new Set(selectedEmployeeIds);
  const assignments = currentAssignments.map((assignment) => ({
    employeeId: clean(assignment?.employee_id),
    teamId: clean(assignment?.team_id),
    positionId: clean(assignment?.position_id),
  })).filter((assignment) => assignment.employeeId && assignment.teamId);

  for (const teamId of selectedTeamIds) {
    if (!assignments.some((assignment) => assignment.teamId === teamId)) {
      return { ok: false, reason: "team_not_current", invalidId: teamId };
    }
  }

  for (const positionId of selectedPositionIds) {
    if (!assignments.some((assignment) =>
      teamSet.has(assignment.teamId) && assignment.positionId === positionId
    )) {
      return {
        ok: false,
        reason: "position_not_in_selected_team",
        invalidId: positionId,
      };
    }
  }

  for (const employeeId of selectedEmployeeIds) {
    if (!assignments.some((assignment) =>
      assignment.employeeId === employeeId && teamSet.has(assignment.teamId)
    )) {
      return {
        ok: false,
        reason: "employee_not_in_selected_team",
        invalidId: employeeId,
      };
    }
  }

  const effectiveEmployeeIds = assignments.filter((assignment) => {
    if (!teamSet.has(assignment.teamId)) return false;
    return !positionSet.size || positionSet.has(assignment.positionId) ||
      employeeSet.has(assignment.employeeId);
  }).map((assignment) => assignment.employeeId);

  const uniqueEffectiveIds = [...new Set(effectiveEmployeeIds)];
  if (!uniqueEffectiveIds.length) {
    return { ok: false, reason: "empty_effective_scope" };
  }

  return {
    ok: true,
    teamIds: selectedTeamIds,
    positionIds: selectedPositionIds,
    employeeIds: selectedEmployeeIds,
    effectiveEmployeeIds: uniqueEffectiveIds,
  };
}

/**
 * Split an account's requested/persisted team IDs against the current roster
 * directory. Historical IDs are never silently treated as current grants.
 */
export function partitionCurrentTeamIds(
  teamIds: unknown,
  allowedCurrentTeamIds: Iterable<unknown>,
): CurrentTeamIdPartition {
  const allowed = new Set(
    [...allowedCurrentTeamIds].map(clean).filter(Boolean),
  );
  const currentTeamIds: string[] = [];
  const staleTeamIds: string[] = [];

  for (const teamId of cleanList(teamIds)) {
    (allowed.has(teamId) ? currentTeamIds : staleTeamIds).push(teamId);
  }

  return { currentTeamIds, staleTeamIds };
}

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
