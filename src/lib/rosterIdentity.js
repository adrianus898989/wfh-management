const text = value => String(value ?? '').trim()

export function normalizeRosterEmployeeId(value) {
  return text(value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .toUpperCase()
    .replace(/\s+/gu, '')
}

export function normalizeRosterName(value) {
  return text(value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
}

// Employee ID is the canonical identity. Name is only a fallback for rows
// whose ID has not been filled in yet; equal names with different IDs remain
// separate people.
export function rosterPersonKey(row) {
  const employeeId = normalizeRosterEmployeeId(row?.employee_id ?? row?.employee_no)
  if (employeeId) return `id:${employeeId}`
  const name = normalizeRosterName(row?.name ?? row?.full_name)
  return name ? `name:${name}` : ''
}

export function uniqueRosterCount(rows) {
  return new Set((rows || []).map(rosterPersonKey).filter(Boolean)).size
}
