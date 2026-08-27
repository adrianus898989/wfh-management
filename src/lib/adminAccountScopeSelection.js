const clean = value => String(value || '').trim()

export const currentScopeTeamId = employee => clean(employee?.current_team_id || employee?.team_id)
export const currentScopePositionId = employee => clean(employee?.current_position_id || employee?.position_id)

export function assignedScopeCandidates(employees = [], positions = [], teamIds = []) {
  const selectedTeamIds = new Set((teamIds || []).map(clean).filter(Boolean))
  const eligibleEmployees = selectedTeamIds.size
    ? (employees || []).filter(employee => selectedTeamIds.has(currentScopeTeamId(employee)))
    : []
  const eligiblePositionIds = new Set(eligibleEmployees.map(currentScopePositionId).filter(Boolean))

  return {
    employees: eligibleEmployees,
    positions: (positions || []).filter(position => eligiblePositionIds.has(clean(position?.id))),
    positionIds: eligiblePositionIds,
  }
}

export function pruneAssignedScopeSelection(selection = {}, employees = [], teams = []) {
  const validTeamIds = new Set((teams || []).map(team => clean(team?.id)).filter(Boolean))
  const teamIds = [...new Set((selection.teamIds || []).map(clean).filter(teamId => validTeamIds.has(teamId)))]
  const candidates = assignedScopeCandidates(employees, [], teamIds)
  const eligibleEmployeeIds = new Set(candidates.employees.map(employee => clean(employee?.id)).filter(Boolean))

  return {
    teamIds,
    positionIds: [...new Set((selection.positionIds || []).map(clean).filter(positionId => candidates.positionIds.has(positionId)))],
    employeeIds: [...new Set((selection.employeeIds || []).map(clean).filter(employeeId => eligibleEmployeeIds.has(employeeId)))],
  }
}
