const text = value => String(value ?? '').trim()

// The source sheet often stores the broad attendance type in `reason`
// (for example "公休") and the useful explanation in `note`.  Employee
// history only needs one compact remark column, so prefer the explanation and
// fall back to the broad reason when no note was supplied.
export const attendanceHistoryRemark = row =>
  text(row?.note) || text(row?.reason) || '—'
