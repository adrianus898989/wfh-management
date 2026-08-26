export const EMPLOYEE_PORTAL_ACCOUNT_STATE = Object.freeze({
  NOT_OPENED: 'not_opened',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
})

export function employeePortalAccountState(row = {}) {
  if (row.account_opened !== true) return EMPLOYEE_PORTAL_ACCOUNT_STATE.NOT_OPENED
  if (row.account_active === false) return EMPLOYEE_PORTAL_ACCOUNT_STATE.DISABLED
  return EMPLOYEE_PORTAL_ACCOUNT_STATE.ENABLED
}

export function employeePortalAccountPresentation(row = {}) {
  const state = employeePortalAccountState(row)
  if (state === EMPLOYEE_PORTAL_ACCOUNT_STATE.ENABLED) {
    return { state, label:'已开通', className:'status-chip', canGenerateActivationCode:false }
  }
  if (state === EMPLOYEE_PORTAL_ACCOUNT_STATE.DISABLED) {
    return { state, label:'已停用', className:'status-chip off', canGenerateActivationCode:false }
  }
  return { state, label:'未开通', className:'status-chip off', canGenerateActivationCode:true }
}
