import { adminTabSlug } from '../config/navigation.js'

const adminTabTarget = (pathname, canonicalTab) =>
  `${pathname}?tab=${encodeURIComponent(adminTabSlug(pathname, canonicalTab))}`

export function adminAlertTarget(alertType) {
  return alertType === 'payout_change'
    ? adminTabTarget('/admin/payroll', '申请记录')
    : adminTabTarget('/admin/employees', '预警记录')
}

export function adminAlertEmployeeTarget(employeeId) {
  return `${adminTabTarget('/admin/employees', '预警记录')}&employee=${encodeURIComponent(String(employeeId || ''))}`
}
