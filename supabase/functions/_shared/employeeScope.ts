export type EffectiveEmployeeScope =
  | { mode: "all"; employeeIds: string[] }
  | { mode: "limited"; employeeIds: string[] };

const clean = (value: unknown) => String(value ?? "").trim();

/**
 * Resolve the server-authoritative backend employee boundary.
 *
 * The database function uses the current roster for own-team access and the
 * materialized team/position intersection plus explicit employee exceptions
 * for assigned scopes. Edge functions must not reconstruct those rules from
 * historical employees.team_id / position_id columns.
 */
export async function loadEffectiveEmployeeScope(
  service: any,
  userId: string,
  access: any,
  roleCode: string,
): Promise<EffectiveEmployeeScope> {
  if (clean(roleCode) === "founder" || clean(access?.data_scope) === "all") {
    return { mode: "all", employeeIds: [] };
  }

  const employeeIds: string[] = [];
  const pageSize = 1000;
  let complete = false;
  for (let offset = 0; offset < 50000; offset += pageSize) {
    const { data, error } = await service
      .rpc("admin_scope_effective_employee_ids", {
        p_auth_user_id: userId,
      })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error("SCOPE_SERVICE_UNAVAILABLE");
    const page = (data || []).map((row: any) => clean(row.employee_id)).filter(Boolean);
    employeeIds.push(...page);
    if (page.length < pageSize) {
      complete = true;
      break;
    }
  }

  // Never turn an unexpectedly large scope into a silently truncated allow
  // list.  Failing closed is safer and makes the capacity issue observable.
  if (!complete) throw new Error("SCOPE_RESULT_LIMIT_EXCEEDED");

  return { mode: "limited", employeeIds: [...new Set(employeeIds)] };
}

export function applyEffectiveEmployeeScope(
  query: any,
  scope: EffectiveEmployeeScope,
  column = "id",
) {
  if (scope.mode === "all") return query;
  return scope.employeeIds.length
    ? query.in(column, scope.employeeIds)
    : query.eq(column, "00000000-0000-0000-0000-000000000000");
}

export function effectiveEmployeeIdSet(scope: EffectiveEmployeeScope) {
  return scope.mode === "all" ? null : new Set(scope.employeeIds);
}
