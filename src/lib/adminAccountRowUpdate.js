const ACCOUNT_BOOLEAN_FIELDS = new Set(['active', 'otp_required', 'login_locked'])
const ACCOUNT_NUMBER_FIELDS = new Set(['failed_attempts'])
const ACCOUNT_NULLABLE_TEXT_FIELDS = new Set(['locked_at', 'last_failure_portal'])
const ACCOUNT_CONTROL_FIELDS = [
  ...ACCOUNT_BOOLEAN_FIELDS,
  ...ACCOUNT_NUMBER_FIELDS,
  ...ACCOUNT_NULLABLE_TEXT_FIELDS,
]

export function accountControlPatch(saved, fallback = {}) {
  const patch = {}
  for (const field of ACCOUNT_CONTROL_FIELDS) {
    const savedHasField = Object.prototype.hasOwnProperty.call(saved || {}, field)
    const fallbackHasField = Object.prototype.hasOwnProperty.call(fallback || {}, field)
    if (!savedHasField && !fallbackHasField) continue
    const value = savedHasField ? saved?.[field] : fallbackHasField ? fallback?.[field] : undefined
    if (ACCOUNT_BOOLEAN_FIELDS.has(field) && typeof value === 'boolean') patch[field] = value
    else if (ACCOUNT_NUMBER_FIELDS.has(field) && Number.isFinite(Number(value))) patch[field] = Number(value)
    else if (ACCOUNT_NULLABLE_TEXT_FIELDS.has(field) && (value == null || typeof value === 'string')) patch[field] = value
  }
  return patch
}

export function patchAccountRows(snapshot, authUserId, changes, accountTotalDelta = 0) {
  if (!snapshot || !authUserId) return snapshot
  const patch = accountControlPatch(changes)
  if (!Object.keys(patch).length) return snapshot

  let backendChanged = false
  let staffChanged = false
  const backendAccounts = (snapshot.backend_accounts || []).map(account => {
    if (account?.auth_user_id !== authUserId) return account
    backendChanged = true
    return { ...account, ...patch }
  })
  const employeeAccounts = (snapshot.employee_accounts || []).map(account => {
    if (account?.auth_user_id !== authUserId) return account
    staffChanged = true
    return { ...account, ...patch }
  })
  if (!backendChanged && !staffChanged) return snapshot

  const next = {
    ...snapshot,
    backend_accounts:backendAccounts,
    employee_accounts:employeeAccounts,
  }
  if (backendChanged && accountTotalDelta && snapshot.account_pagination) {
    next.account_pagination = {
      ...snapshot.account_pagination,
      total:Math.max(0, Number(snapshot.account_pagination.total || 0) + accountTotalDelta),
    }
  }
  return next
}
