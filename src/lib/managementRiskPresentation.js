const number = value => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const isoLocal = value => {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function managementRiskDatePreset(preset, now = new Date()) {
  const end = new Date(now)
  end.setHours(12, 0, 0, 0)
  const start = new Date(end)
  if (preset === 'month') start.setDate(1)
  else start.setDate(start.getDate() - (preset === '90d' ? 89 : 29))
  return { date_from:isoLocal(start), date_to:isoLocal(end) }
}

export const MANAGEMENT_RISK_BANDS = Object.freeze({
  critical:{ label:'重点复核', className:'critical' },
  high_signal:{ label:'重点复核', className:'critical' },
  high:{ label:'高关注', className:'high' },
  elevated_signal:{ label:'高关注', className:'high' },
  attention:{ label:'需关注', className:'attention' },
  medium:{ label:'需关注', className:'attention' },
  stable:{ label:'相对稳定', className:'stable' },
  baseline_signal:{ label:'相对稳定', className:'stable' },
  low:{ label:'相对稳定', className:'stable' },
})

export function managementRiskBand(row = {}) {
  const flags = Array.isArray(row.sample_flags) ? row.sample_flags : []
  if (row.sample_warning || flags.length) return { label:'样本不足', className:'sample', title:flags.join('；') || '样本量较小，只作提示' }
  const score = number(row.risk_score)
  const key = String(row.risk_band || '').trim().toLowerCase()
    || (score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 20 ? 'attention' : 'stable')
  return { ...(MANAGEMENT_RISK_BANDS[key] || MANAGEMENT_RISK_BANDS.stable), title:'风险分是归一化关注信号，不是定责结论' }
}

export function managementRiskOrganizationRows(data = {}, dimension = 'teams') {
  const rows = data?.organization?.[dimension]
  return Array.isArray(rows) ? rows : []
}

export function managementRiskOptions(data = {}, key) {
  const rows = Array.isArray(data?.options?.[key]) ? data.options[key] : []
  const field = key === 'teams' ? 'team_name' : key === 'groups' ? 'group_name' : 'manager_name'
  return [...new Set(rows.map(item => String(
    typeof item === 'string' ? item : item?.[field] || item?.name || item?.value || '',
  ).trim()).filter(Boolean))]
}

export function managementRiskTrendRows(data = {}) {
  if (Array.isArray(data?.trend)) return data.trend
  const daily = Array.isArray(data?.trend?.daily) ? data.trend.daily : []
  const weekly = Array.isArray(data?.trend?.weekly) ? data.trend.weekly : []
  const days = number(data?.period?.days)
  return days > 62 && weekly.length ? weekly : daily
}

export function managementRiskRowName(row = {}, dimension = 'teams') {
  if (dimension === 'managers') return String(row.manager_name || row.name || '未设置负责人')
  if (dimension === 'groups') return String(row.group_name || row.name || '未设置组别')
  return String(row.team_name || row.name || '未设置团队')
}

export function managementRiskIncidentTotal(row = {}) {
  return number(row.total_negative_events ?? row.negative_events)
    || number(row.error_events) + number(row.exam_failures) + number(row.attendance_issues) + number(row.deductions)
}
