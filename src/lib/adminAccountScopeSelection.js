const clean = value => String(value || '').trim()

export const currentScopeTeamId = employee => clean(employee?.current_team_id || employee?.team_id)
export const currentScopePositionId = employee => clean(employee?.current_position_id || employee?.position_id)

export function assignedScopeCandidates(employees = [], positions = [], teamIds = []) {
  const selectedTeamIds = new Set((teamIds || []).map(clean).filter(Boolean))
  const eligibleEmployees = selectedTeamIds.size
    ? (employees || []).filter(employee => selectedTeamIds.has(currentScopeTeamId(employee)))
    : []
  const eligiblePositionIds = new Set(eligibleEmployees.map(currentScopePositionId).filter(Boolean))

  const eligiblePositions = (positions || []).filter(position => {
    const positionTeamIds = Array.isArray(position?.team_ids)
      ? position.team_ids.map(clean).filter(Boolean)
      : []
    if (positionTeamIds.length) return positionTeamIds.some(teamId => selectedTeamIds.has(teamId))
    return eligiblePositionIds.has(clean(position?.id))
  })

  const candidatePositionIds = (positions || []).length
    ? new Set(eligiblePositions.map(position => clean(position?.id)).filter(Boolean))
    : eligiblePositionIds

  return {
    employees: eligibleEmployees,
    positions: eligiblePositions,
    positionIds: candidatePositionIds,
  }
}

export function pruneAssignedScopeSelection(selection = {}, employees = [], teams = [], positions = []) {
  const validTeamIds = new Set((teams || []).map(team => clean(team?.id)).filter(Boolean))
  const teamIds = [...new Set((selection.teamIds || []).map(clean).filter(teamId => validTeamIds.has(teamId)))]
  const candidates = assignedScopeCandidates(employees, positions, teamIds)
  const eligibleEmployeeIds = new Set(candidates.employees.map(employee => clean(employee?.id)).filter(Boolean))

  return {
    teamIds,
    positionIds: [...new Set((selection.positionIds || []).map(clean).filter(positionId => candidates.positionIds.has(positionId)))],
    employeeIds: [...new Set((selection.employeeIds || []).map(clean).filter(employeeId => eligibleEmployeeIds.has(employeeId)))],
  }
}
