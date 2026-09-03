const text = value => String(value ?? '').trim()

const finiteNumber = value => {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'string' && !value.trim()) return null
  if (typeof value === 'object') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const count = value => {
  const number = finiteNumber(value)
  return number === null ? null : Math.max(0, Math.trunc(number))
}

const positiveInteger = (value, fallback) => {
  const number = finiteNumber(value)
  return number === null ? fallback : Math.max(1, Math.trunc(number))
}

export const PERSONNEL_RECONCILIATION_VIEWS = Object.freeze([
  Object.freeze({ key:'headcount', label:'人数差异', unit:'人', empty:'当前没有符合条件的人数差异。' }),
  Object.freeze({ key:'issues', label:'来源待核对', unit:'项', empty:'当前没有待核对的来源问题。' }),
  Object.freeze({ key:'onsite', label:'现场人员', unit:'人', empty:'当前没有符合条件的现场人员。' }),
])

export const PERSONNEL_RECONCILIATION_VIEW_KEYS = Object.freeze(
  PERSONNEL_RECONCILIATION_VIEWS.map(item => item.key),
)

const HEADCOUNT_REASON_LABELS = Object.freeze({
  dashboard_only:'仅在 Dashboard 今日在职口径',
  directory_only:'仅在员工档案口径',
  master_only_missing_schedule:'员工主档在职，但当前排班没有',
  home_only_missing_schedule:'员工主表已有，等待排班分配',
  schedule_only:'排班存在，但员工主档没有',
  unapproved_schedule_only:'排班独有人尚未确认身份',
  future_hire:'未来入职日期尚未生效',
  probation_status_difference:'试用状态造成口径差异',
  status_mismatch:'员工状态与来源记录不一致',
  resigned_still_scheduled:'员工已离职，但排班仍存在',
  home_resigned_but_still_scheduled:'居家名单已离职，但排班仍存在',
  missing_current_roster_assignment:'缺少当前排班团队或岗位',
  active_home_employee_not_yet_scheduled:'员工主表在职，当前排班尚未分配',
  missing_from_both_complete_sources:'后台主档仍为在职，但两份当前来源未确认到同一人（系统未自动改状态）',
  future_resignation_removed_from_schedule_early:'离职日期尚未生效，但已提前从当前排班移除',
  home_source_resigned_profile_still_active:'居家名单已标离职，但后台主档仍为在职',
})

const ISSUE_LABELS = Object.freeze({
  cross_source_name_mismatch:'两份员工来源姓名不一致',
  home_only_missing_schedule:'员工主表已有，等待排班分配',
  home_resigned_but_still_scheduled:'居家名单已离职，但排班仍存在',
  pending_manual_review:'来源状态待确认（不直接计入人数误差）',
  schedule_only_missing_onsite_marker:'排班身份或现场标记需核对',
  schedule_duplicate_employee_id_quarantined:'排班内员工 ID 重复，已隔离',
  temporary_and_official_records_both_exist:'临时 ID 与正式 ID 记录同时存在',
  source_sync_failed:'来源同步失败',
  source_sync_partial:'来源仅部分同步',
  source_error_rows:'来源含错误行',
  source_ambiguous_identity:'有记录匹配到多名员工',
  source_unmatched_identity:'有记录无法匹配员工',
  source_parse_warning:'来源格式需要核对',
  schedule_backfill_requires_review:'排班补录身份需核对',
})

const ONSITE_CLASSIFICATION_LABELS = Object.freeze({
  confirmed_onsite:'已确认现场人员',
  managed_external:'管理范围内外部人员',
  onsite_marker:'源表标记现场人员',
  source_onsite_marker:'源表标记现场人员',
  schedule_backfill:'排班补录人员',
})

const ACCEPTED_ONSITE_CLASSIFICATIONS = new Set([
  'confirmed_onsite',
  'managed_external',
  'onsite_marker',
  'source_onsite_marker',
])

const STATUS_LABELS = Object.freeze({
  active:'在职',
  probation:'试用',
  suspended:'停用',
  disabled:'停用',
  inactive:'非在职',
  resigned:'离职',
  needs_review:'待核对',
  failed:'同步失败',
  partial:'部分完成',
  resolved:'已确认',
  confirmed:'已确认',
})

const CONFIRMATION_LABELS = Object.freeze({
  manual_confirmation:'后台人工确认',
  managed_external_approval:'已纳入管理范围',
  source_sheet_marker:'Google 排班现场标记',
})

export function personnelReconciliationReasonLabel(row) {
  return text(row?.reason_label)
    || HEADCOUNT_REASON_LABELS[text(row?.reason_code)]
    || ISSUE_LABELS[text(row?.issue_code)]
    || '待核对'
}

export function personnelReconciliationIssueLabel(row) {
  return ISSUE_LABELS[text(row?.issue_code)] || '来源差异'
}

export function personnelReconciliationStatusLabel(value) {
  const key = text(value).toLowerCase()
  return STATUS_LABELS[key] || text(value) || '—'
}

export function personnelReconciliationOnsiteLabel(row) {
  const key = text(row?.classification)
  if (ONSITE_CLASSIFICATION_LABELS[key]) return ONSITE_CLASSIFICATION_LABELS[key]
  if (row?.confirmed_onsite === true) return ONSITE_CLASSIFICATION_LABELS.confirmed_onsite
  if (row?.managed_external === true) return ONSITE_CLASSIFICATION_LABELS.managed_external
  if (row?.source_onsite_marker === true) return ONSITE_CLASSIFICATION_LABELS.source_onsite_marker
  if (row?.schedule_backfill === true) return ONSITE_CLASSIFICATION_LABELS.schedule_backfill
  return '现场身份待确认'
}

export function personnelReconciliationOnsiteAccepted(row) {
  const key = text(row?.classification)
  return ACCEPTED_ONSITE_CLASSIFICATIONS.has(key)
    || row?.confirmed_onsite === true
    || row?.managed_external === true
    || row?.source_onsite_marker === true
}

export function personnelReconciliationConfirmationLabel(value) {
  const key = text(value)
  return CONFIRMATION_LABELS[key] || (key ? '已记录确认依据' : '')
}

export function personnelReconciliationRowKey(row, index = 0) {
  return text(row?.row_key)
    || text(row?.issue_id)
    || [text(row?.employee_id), text(row?.employee_no), text(row?.source_row), index].join(':')
}

export function personnelReconciliationSearch(value) {
  return text(value).slice(0, 120)
}

export function emptyPersonnelReconciliationResult(view = 'headcount', pageSize = 30) {
  const safeView = PERSONNEL_RECONCILIATION_VIEW_KEYS.includes(view) ? view : 'headcount'
  return {
    contractVersion:1,
    view:safeView,
    rows:[],
    total:0,
    page:1,
    pages:1,
    pageSize:Math.min(50, positiveInteger(pageSize, 30)),
    loaded:false,
  }
}

export function normalizePersonnelReconciliationResponse(payload, requestedView = 'headcount', requestedPageSize = 30) {
  const raw = payload && typeof payload === 'object' ? payload : {}
  const returnedView = text(raw.view)
  const view = PERSONNEL_RECONCILIATION_VIEW_KEYS.includes(returnedView)
    ? returnedView
    : (PERSONNEL_RECONCILIATION_VIEW_KEYS.includes(requestedView) ? requestedView : 'headcount')
  const pageSize = Math.min(50, positiveInteger(raw.page_size, requestedPageSize))
  const total = count(raw.total) ?? 0
  const page = positiveInteger(raw.page, 1)
  const pages = Math.max(1, positiveInteger(raw.pages, Math.ceil(total / pageSize) || 1))
  const summary = raw.summary && typeof raw.summary === 'object' ? raw.summary : {}
  const freshness = raw.freshness && typeof raw.freshness === 'object' ? raw.freshness : {}

  return {
    contractVersion:positiveInteger(raw.contract_version, 1),
    view,
    rows:Array.isArray(raw.rows)
      ? raw.rows.map(row => ({
        ...row,
        full_name:text(row?.full_name) || text(row?.employee_name),
      }))
      : [],
    total,
    page:Math.min(page, pages),
    pages,
    pageSize,
    loaded:true,
    summary:{
      dashboard_active:count(summary.dashboard_active),
      effective_active:count(summary.effective_active),
      dashboard_effective_active:count(summary.dashboard_effective_active),
      directory_effective_active:count(summary.directory_effective_active),
      directory_total:count(summary.directory_total),
      schedule_unique_total:count(summary.schedule_unique_total),
      report_total:count(summary.report_total),
      headcount_total:count(summary.headcount_total),
      issue_total:count(summary.issue_total),
      onsite_total:count(summary.onsite_total),
    },
    freshness:{
      run_id:text(freshness.run_id),
      captured_at:text(freshness.captured_at),
      finished_at:text(freshness.finished_at),
      home_rows:count(freshness.home_rows),
      schedule_rows:count(freshness.schedule_rows),
      report_source:text(freshness.report_source),
      report_synced_at:text(freshness.report_synced_at),
      report_rows:count(freshness.report_rows),
      report_is_stale:freshness.report_is_stale === true,
      report_age_seconds:count(freshness.report_age_seconds),
      is_stale:freshness.is_stale === true,
      age_seconds:count(freshness.age_seconds),
    },
  }
}

export function personnelReconciliationErrorMessage(error, { timedOut = false } = {}) {
  if (timedOut) return '人员对账读取超时，已保留上次结果，请稍后重试。'
  const code = text(error?.code)
  const message = text(error?.message)
  const details = text(error?.details)
  const raw = `${code} ${message} ${details}`.toLowerCase()

  if (/not_authenticated|jwt|unauthorized|session_not_current|admin_session_required|登录|会话/.test(raw)) {
    return '登录状态已失效，请重新登录后再查看人员对账。'
  }
  if (/42501|permission|denied|forbidden|reconciliation\.view|can_manage_employee|权限/.test(raw)) {
    return '当前账号没有“人员对账”查看权限，请联系有权限的管理员。'
  }
  if (/pgrst202|function.+not found|schema cache|admin_personnel_reconciliation/.test(raw)) {
    return '人员对账服务正在更新，请稍后刷新再试。'
  }
  if (/57014|statement timeout|canceling statement|timeout|aborted/.test(raw)) {
    return '人员对账读取超时，已保留上次结果，请稍后重试。'
  }
  if (/failed to fetch|network|load failed|fetch/.test(raw)) {
    return '网络暂时不稳定，已保留上次结果，请检查网络后重试。'
  }
  return '人员对账暂时无法读取，已保留上次结果，请稍后重试。'
}
