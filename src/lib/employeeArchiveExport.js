const text = value => String(value ?? '').trim()

export const EMPLOYEE_ARCHIVE_EXPORT_COLUMNS = [
  ['risk_label', '等级'],
  ['total_error_count', '累计错误'],
  ['employee_no', '员工ID'],
  ['full_name', '姓名'],
  ['country', '员工国家'],
  ['team', '团队'],
  ['teacher', '老师'],
  ['position', '岗位'],
  ['shift', '班次'],
  ['employment_type', '员工类型'],
  ['status', '状态'],
  ['hire_date', '入职日期'],
  ['tenure', '入职时长'],
  ['created_at', '录入时间'],
  ['operator_account', '操作人账号'],
  ['profile_status', '资料'],
  ['account_status', '员工端账号'],
  ['work_tg', '工作TG'],
  ['backend_accounts', '后台账号'],
]

// Quoting every value keeps commas, line breaks and leading zeroes intact.
// The apostrophe also prevents spreadsheet formula execution for user-entered
// fields while remaining unobtrusive in Excel-compatible CSV readers.
export const employeeArchiveCsvCell = value => {
  let safe = text(value)
  if (/^[=+\-@]/.test(safe)) safe = `'${safe}`
  return `"${safe.replace(/"/g, '""')}"`
}

export const employeeArchiveCsv = rows => {
  const header = EMPLOYEE_ARCHIVE_EXPORT_COLUMNS.map(([, label]) => employeeArchiveCsvCell(label))
  const body = (rows || []).map(row => EMPLOYEE_ARCHIVE_EXPORT_COLUMNS.map(([key]) => employeeArchiveCsvCell(row?.[key])))
  return `\uFEFF${[header, ...body].map(columns => columns.join(',')).join('\r\n')}`
}

export const employeeArchiveExportFilename = (date = new Date()) => {
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((value, index) => String(value).padStart(index ? 2 : 4, '0'))
  return `员工档案_当前筛选_${parts.join('-')}.csv`
}
