const clean = value => String(value ?? '').trim()

export const payrollBatchIdentity = batch => clean(batch?.id)

export const payrollMatchState = row => {
  const match = clean(row?.match_state || row?.identity_match_state).toLowerCase()
  const status = clean(row?.employee_status || row?.status).toLowerCase()
  if (match === 'suspended' || match === 'inactive' || status === 'suspended' || status === 'inactive') return 'suspended'
  if (match === 'resigned' || match === 'historical_resigned' || status === 'resigned' || (!row?.employee_id && row?.departure_date)) return 'resigned'
  if (match === 'active' || match === 'probation' || match === 'employee' || status === 'active' || status === 'probation' || row?.employee_id || row?.matched) return 'active'
  return 'unmatched'
}

export const summarizePayrollRows = rows => (rows || []).reduce((summary, row) => {
  const state = payrollMatchState(row)
  summary[state] += 1
  summary.total += 1
  return summary
}, { active: 0, suspended: 0, resigned: 0, unmatched: 0, total: 0 })
