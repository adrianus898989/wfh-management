const clean = value => String(value ?? '').trim()
const searchKey = value => clean(value).normalize('NFKC').toLowerCase().replace(/[\s_\-\/()（）.：:#]+/g, '')

const PAYROLL_BATCH_STATUS_LABELS = {
  draft: '待发布',
  published: '已发布',
  archived: '已归档',
  voided: '已作废',
}

export const payrollBatchIdentity = batch => clean(batch?.id)

export const payrollBatchLifecycleState = batch => {
  if (batch?.voided_at) return 'voided'
  return clean(batch?.status).toLowerCase() || 'unknown'
}

export const filterPayrollBatches = (batches, { search = '', status = 'all' } = {}) => {
  const expectedStatus = clean(status).toLowerCase() || 'all'
  const needle = searchKey(search)
  return (batches || []).filter(batch => {
    const lifecycleState = payrollBatchLifecycleState(batch)
    if (expectedStatus !== 'all' && lifecycleState !== expectedStatus) return false
    if (!needle) return true
    const searchable = searchKey([
      payrollBatchIdentity(batch),
      batch?.source_file_name,
      batch?.title,
      batch?.period_start,
      batch?.currency,
      batch?.created_by_name,
      batch?.updated_by_name,
      batch?.published_by_name,
      lifecycleState,
      PAYROLL_BATCH_STATUS_LABELS[lifecycleState],
    ].join(' '))
    return searchable.includes(needle)
  })
}

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
