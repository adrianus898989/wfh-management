const clean = value => String(value ?? '').trim()

const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0

const KIND_META = {
  public_holiday: { zh:'公休', en:'Rest day' },
  leave: { zh:'请假', en:'Leave' },
  absence: { zh:'缺席', en:'Absence' },
  half_day: { zh:'半天', en:'Half day' },
  home_leave: { zh:'回家', en:'Home leave' },
}

const isRecord = value => Boolean(value && typeof value === 'object' && !Array.isArray(value))

function eventDescription(event, locale) {
  const reason = clean(event.reason)
  const note = clean(event.note)
  if (!reason && !note) {
    return locale === 'en' ? 'No reason or note was entered.' : '未填写原因或备注'
  }
  if (reason && note && reason !== note) {
    return locale === 'en'
      ? `Reason: ${reason} · Note: ${note}`
      : `原因：${reason} · 备注：${note}`
  }
  return `${locale === 'en' ? 'Reason' : '原因'}：${reason || note}`
}

function normalizeEvents(payload, locale) {
  if (!Array.isArray(payload.events)) return []
  return payload.events.flatMap(value => {
    if (!isRecord(value)) return []
    const date = clean(value.date)
    const eventKind = clean(value.event_kind).toLowerCase()
    if (!date || !KIND_META[eventKind]) return []
    return [{
      date,
      eventKind,
      kindLabel:KIND_META[eventKind][locale] || KIND_META[eventKind].zh,
      reason:clean(value.reason),
      note:clean(value.note),
      description:eventDescription(value, locale),
      weight:numeric(value.weight || (eventKind === 'half_day' ? 0.5 : 1)),
    }]
  }).sort((a, b) => a.date.localeCompare(b.date) || a.eventKind.localeCompare(b.eventKind))
}

export function adminAlertAttendanceDetails(row, locale='zh') {
  if (!['consecutive_rest', 'weekly_absence', 'monthly_leave'].includes(row?.alert_type)) return null
  const payload = isRecord(row?.payload) ? row.payload : {}
  const events = normalizeEvents(payload, locale)
  const monthly = row.alert_type === 'monthly_leave'
  const consecutiveRest = row.alert_type === 'consecutive_rest'
  return {
    kind:row.alert_type,
    title:monthly
      ? (locale === 'en' ? 'Dates counted toward this month' : '本月计入休假的日期明细')
      : consecutiveRest
        ? (locale === 'en' ? 'Consecutive rest dates and reasons' : '连续公休日期与原因')
        : (locale === 'en' ? 'Absence dates and reasons' : '缺席日期与原因'),
    events,
    missingDetails:events.length === 0,
    homeLeaveExcluded:monthly && payload.home_leave_excluded !== false,
    breakdown:monthly ? [
      { kind:'public_holiday', label:KIND_META.public_holiday[locale], count:numeric(payload.public_holiday), unit:locale === 'en' ? 'days' : '天' },
      { kind:'leave', label:KIND_META.leave[locale], count:numeric(payload.leave), unit:locale === 'en' ? 'days' : '天' },
      { kind:'absence', label:KIND_META.absence[locale], count:numeric(payload.absence), unit:locale === 'en' ? 'days' : '天' },
      { kind:'half_day', label:KIND_META.half_day[locale], count:numeric(payload.half_day), unit:locale === 'en' ? 'entries' : '次' },
    ] : [],
  }
}

export function adminAlertErrorFrequencyDetails(row, locale='zh') {
  if (row?.alert_type !== 'error_spike') return null
  const payload = isRecord(row?.payload) ? row.payload : {}
  const rules = Array.isArray(payload.rules)
    ? payload.rules.flatMap(value => {
      if (!isRecord(value)) return []
      const days = numeric(value.days)
      const threshold = numeric(value.threshold)
      if (![1, 3, 7].includes(days) || threshold <= 0) return []
      return [{
        days,
        threshold,
        count:numeric(value.count),
        triggered:Boolean(value.triggered),
      }]
    }).sort((a, b) => a.days - b.days)
    : [{
      days:numeric(payload.days) || 3,
      threshold:numeric(payload.threshold) || 6,
      count:numeric(payload.count ?? row?.occurrence_count),
      triggered:true,
    }]

  return {
    title:locale === 'en' ? 'Error-frequency checks' : '错误频率检测明细',
    note:locale === 'en' ? 'A warning is created when any rule is reached.' : '任意一条规则达到阈值即产生预警。',
    rules:rules.map(rule => ({
      ...rule,
      label:locale === 'en'
        ? `${rule.days} ${rule.days === 1 ? 'day' : 'days'}`
        : `${rule.days}天`,
      result:locale === 'en'
        ? `${rule.count} / ${rule.threshold} errors`
        : `${rule.count} / ${rule.threshold} 笔错误`,
    })),
  }
}

export function adminAlertEmployeeHireDate(row) {
  const payload = isRecord(row?.payload) ? row.payload : {}
  const value = clean(
    row?.hire_date
    || row?.employee_hire_date
    || payload.hire_date
    || payload.employee_hire_date,
  )
  return value ? value.slice(0, 10) : '—'
}

export function adminAlertKeyAttendanceEvidence(row, locale='zh') {
  const detail = adminAlertAttendanceDetails(row, locale)
  if (!detail || detail.events.length === 0) return ''
  const first = detail.events[0]
  const remainder = detail.events.length - 1
  const primary = `${first.date} · ${first.kindLabel} · ${first.description}`
  if (remainder === 0) return primary
  return locale === 'en'
    ? `${primary}; ${remainder} more dated ${remainder === 1 ? 'record' : 'records'}`
    : `${primary}；另有 ${remainder} 个异常日期`
}

export function adminAlertEmployeeHistoryFilters(employeeId) {
  const normalizedEmployeeId = clean(employeeId)
  return normalizedEmployeeId
    ? { status:'all', employee_id:normalizedEmployeeId }
    : null
}

export function adminAlertReadState(row, locale='zh') {
  const unread = Boolean(row?.unread)
  return {
    unread,
    label:locale === 'en'
      ? (unread ? 'Unread' : 'Read')
      : (unread ? '未读' : '已读'),
  }
}

export function adminAlertReaders(row) {
  if (!Array.isArray(row?.readers)) return []
  return row.readers.flatMap(value => {
    if (!isRecord(value)) return []
    const account = clean(value.account)
    const readAt = clean(value.read_at)
    if (!account || !readAt) return []
    return [{
      authUserId:clean(value.auth_user_id),
      account,
      readAt,
    }]
  }).sort((a, b) => b.readAt.localeCompare(a.readAt) || a.account.localeCompare(b.account))
}

export function adminAlertFollowUpState(row, locale='zh') {
  const source = isRecord(row?.follow_up) ? row.follow_up : {}
  const readers = adminAlertReaders(row)
  const status = ['confirmed', 'handled'].includes(source.status) ? source.status : 'pending'
  const confirmedBy = clean(source.confirmed_by_name)
  const handledBy = clean(source.handled_by_name)
  const latestReader = readers[0]?.account || ''
  const result = clean(source.handling_note)
  const labels = locale === 'en'
    ? { pending:'Awaiting follow-up', confirmed:'Confirmed · awaiting handling', handled:'Handled' }
    : { pending:'待跟进', confirmed:'已确认 · 待处理', handled:'已处理' }
  // A reader only opened the warning. The compact table's account column must
  // identify the person who actually accepted or completed the follow-up.
  const followUpAccount = status === 'handled' ? handledBy : status === 'confirmed' ? confirmedBy : ''
  return {
    status,
    label:labels[status],
    reader:latestReader,
    actor:followUpAccount,
    followUpAccount,
    followUpAt:status === 'handled' ? clean(source.handled_at) : status === 'confirmed' ? clean(source.confirmed_at) : '',
    readers,
    confirmedBy,
    confirmedAt:clean(source.confirmed_at),
    handledBy,
    handledAt:clean(source.handled_at),
    note:result,
    result,
  }
}
