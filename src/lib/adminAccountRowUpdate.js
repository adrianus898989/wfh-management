const ACCOUNT_CONTROL_FIELDS = ['active', 'otp_required']

export function accountControlPatch(saved, fallback = {}) {
  const patch = {}
  for (const field of ACCOUNT_CONTROL_FIELDS) {
    const value = saved?.[field]
    if (typeof value === 'boolean') patch[field] = value
    else if (typeof fallback?.[field] === 'boolean') patch[field] = fallback[field]
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
