const text = value => String(value ?? '').trim()

export const COMPANY_ASSET_TABS = {
  HARDWARE: 'hardware',
  SOFTWARE: 'software',
}

export const COMPANY_HARDWARE_TABS = {
  PHONE: 'phone',
  COMPUTER: 'computer',
}

export function normalizeCompanyAssetEmployees(rows = []) {
  return rows
    .filter(row => {
      const employeeNo = text(row?.employee_no).toUpperCase()
      return text(row?.status).toLowerCase() === 'active' &&
        employeeNo &&
        !['SYSTEM', 'ADMIN'].includes(employeeNo) &&
        !employeeNo.startsWith('TEST') &&
        text(row?.source_type) !== 'google_deleted'
    })
    .map(row => ({
      ...row,
      id: text(row.id),
      employee_no: text(row.employee_no),
      full_name: text(row.full_name),
      hire_date: text(row.hire_date).slice(0, 10),
      country: text(row.country || row.nationality),
      work_tg: text(row.work_tg),
    }))
    .sort((a, b) => a.employee_no.localeCompare(b.employee_no, 'en', { numeric:true }))
}

export function filterCompanyAssetEmployees(rows = [], { keyword = '', country = '' } = {}) {
  const normalizedKeyword = text(keyword).toLowerCase()
  const normalizedCountry = text(country).toLowerCase()
  return rows.filter(row => {
    if (normalizedCountry && text(row.country).toLowerCase() !== normalizedCountry) return false
    if (!normalizedKeyword) return true
    return [row.hire_date, row.employee_no, row.full_name, row.country, row.work_tg]
      .map(text)
      .join(' ')
      .toLowerCase()
      .includes(normalizedKeyword)
  })
}

export function companyAssetCountries(rows = []) {
  return [...new Set(rows.map(row => text(row.country)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export function companyAssetPage(rows = [], page = 1, pageSize = 30) {
  const size = Math.max(1, Number(pageSize) || 30)
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const safePage = Math.min(pages, Math.max(1, Number(page) || 1))
  const offset = (safePage - 1) * size
  return { page:safePage, pages, rows:rows.slice(offset, offset + size) }
}
