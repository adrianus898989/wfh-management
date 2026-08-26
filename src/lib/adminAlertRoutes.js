export function adminAlertTarget(alertType) {
  return alertType === 'payout_change'
    ? `/admin/payroll?tab=${encodeURIComponent('申请记录')}`
    : `/admin/employees?tab=${encodeURIComponent('预警记录')}`
}

export function adminAlertEmployeeTarget(employeeId) {
  return `/admin/employees?tab=${encodeURIComponent('预警记录')}&employee=${encodeURIComponent(String(employeeId || ''))}`
}
