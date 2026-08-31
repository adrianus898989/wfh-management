export const EMPLOYEE_FILTER_PREVIEW_VALUE = 'employees-filter-v1'

const normalizePath = value => {
  const path = String(value || '/').replace(/\/+$/, '')
  return path || '/'
}

export function employeeFilterPreviewEnabled({ pathname = '', search = '' } = {}) {
  if (normalizePath(pathname) !== '/admin/employees') return false
  const requested = new URLSearchParams(String(search || '')).getAll('preview')
  return requested.length === 1 && requested[0] === EMPLOYEE_FILTER_PREVIEW_VALUE
}
