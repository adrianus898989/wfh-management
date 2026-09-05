const clean = value => String(value ?? '').trim()

export function examDeleteConfirmationToken(session = {}) {
  const employeeNo = clean(session.employee_no)
  const sessionPrefix = clean(session.id).slice(0, 8)
  return employeeNo && sessionPrefix ? `${employeeNo} ${sessionPrefix}` : ''
}

export function normalizeExamDeleteConfirmation(value) {
  return clean(value).replace(/\s+/g, ' ').toUpperCase()
}

export function examDeleteConfirmationMatches(value, session = {}) {
  const expected = examDeleteConfirmationToken(session)
  return Boolean(expected) && normalizeExamDeleteConfirmation(value) === normalizeExamDeleteConfirmation(expected)
}

export function examDeleteCanonicalConfirmation(session = {}) {
  const token = examDeleteConfirmationToken(session)
  return token ? `删除 ${token}` : ''
}
