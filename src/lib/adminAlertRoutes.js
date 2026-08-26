export function adminAlertTarget(alertType) {
  return alertType === 'payout_change'
    ? `/admin/payroll?tab=${encodeURIComponent('收款资料审核')}`
    : `/admin/employees?tab=${encodeURIComponent('预警记录')}`
}

export function adminAlertEmployeeTarget(employeeId) {
  return `/admin/employees?tab=${encodeURIComponent('员工档案')}&employee=${encodeURIComponent(String(employeeId || ''))}`
}
