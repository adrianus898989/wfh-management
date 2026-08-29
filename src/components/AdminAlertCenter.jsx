import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Pagination } from './DataPageControls'
import { useAdminAccess } from '../lib/adminAccess'
import { useAdminI18n } from '../lib/adminI18n'
import {
  ADMIN_ALERT_GROUPS,
  ADMIN_ALERT_PERMISSIONS,
  ADMIN_ALERT_TYPES,
  adminAlertPendingReason,
  visibleAdminAlertTypes,
} from '../lib/adminAlertCatalog'
import { adminAlertEmployeeTarget, adminAlertTarget } from '../lib/adminAlertRoutes'
import {
  adminAlertAttendanceDetails,
  adminAlertEmployeeHistoryFilters,
  adminAlertEmployeeHireDate,
  adminAlertErrorFrequencyDetails,
  adminAlertFollowUpState,
  adminAlertKeyAttendanceEvidence,
  adminAlertMonthlyLeaveRule,
  adminAlertReadState,
} from '../lib/adminAlertDetails'
import {
  ADMIN_ALERT_BADGE_CACHE_FRESH_MS,
  ADMIN_ALERT_BADGE_PRELOAD_JITTER_MS,
  ADMIN_ALERT_BADGE_REFRESH_JITTER_MS,
  ADMIN_ALERT_BADGE_REQUEST_TIMEOUT_MS,
  acquireAdminAlertBadgePreloadLease,
  adminAlertBadgeRefreshDelay,
  adminAlertBadgeStorageKey,
  classifyAdminAlertBadgeFailure,
  readAdminAlertBadgeCache,
  releaseAdminAlertBadgePreloadLease,
  writeAdminAlertBadgeCache,
} from '../lib/adminAlertBadgePreload'
import { supabase } from '../lib/supabase'
import '../styles-admin-alerts.css'

const ALERT_PERMISSIONS = ADMIN_ALERT_PERMISSIONS
const TYPE_META = ADMIN_ALERT_TYPES

const SEVERITY_META = {
  info: { zh:'通知', en:'Notice' },
  warning: { zh:'预警', en:'Warning' },
  critical: { zh:'重点预警', en:'Critical' },
}

const ALERT_RULE_COPY = {
  payout_change: { zh:'提交收款资料修改后即时提醒。', en:'Alerts immediately after a payment-details change is submitted.' },
  resigned_account_active: { zh:'离职员工仍存在启用中的登录账号。', en:'A resigned employee still has an enabled login.' },
  late_timeout_frequency: { zh:'7 天内迟到或超时相关扣款达到 3 次。', en:'At least 3 late or timeout deductions within 7 days.' },
  consecutive_rest: { zh:'连续公休达到 2 天。', en:'At least 2 consecutive public rest days.' },
  weekly_absence: { zh:'7 天内缺席达到 2 天。', en:'At least 2 absence days within 7 days.' },
  monthly_leave: { zh:'现场转居家超过 2 天、纯居家超过 4 天预警；未核验分类保守沿用旧上限 5 天。半天按 0.5 天，回家不计。', en:'Warn above 2 days for onsite-to-home and above 4 for pure-home; unverified classifications retain the legacy 5-day limit. Half days count as 0.5 and home leave is excluded.' },
  error_spike: { zh:'3 天内错误记录达到 6 笔。', en:'At least 6 error records within 3 days.' },
  deduction_frequency: { zh:'7 天内扣款达到 4 次。', en:'At least 4 deductions within 7 days.' },
  exam_failed: { zh:'最近一次已评分考试未达到及格线。', en:'The latest graded exam did not reach the pass score.' },
}

const clean = value => String(value ?? '').trim()
const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0
const countText = value => numeric(value).toLocaleString(undefined, { maximumFractionDigits:1 })
const eventName = (row, locale) => TYPE_META[row?.alert_type]?.[locale] || clean(row?.alert_type) || '—'
const severityName = (row, locale) => SEVERITY_META[row?.severity]?.[locale] || clean(row?.severity) || '—'
const formatTime = (value, locale) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return clean(value)
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'zh-CN', {
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false,
  }).format(date)
}

const alertDetailsTarget = row => {
  const target = adminAlertTarget(row?.alert_type)
  if (!row?.id || row?.alert_type === 'payout_change') return target
  return `${target}${target.includes('?') ? '&' : '?'}alert=${encodeURIComponent(row.id)}`
}

const alertErrorMessage = (error, locale, fallback) => {
  const failure = classifyAdminAlertBadgeFailure(error)
  const raw = clean(error?.message)
  const messages = {
    not_authenticated: { zh:'请重新登录后再试。', en:'Please sign in again.' },
    session_not_current: { zh:'当前登录会话已失效，请重新登录。', en:'Your session has expired. Please sign in again.' },
    permission_denied: { zh:'当前账号没有查看这些预警的权限。', en:'This account cannot view these warnings.' },
    alert_not_found_or_out_of_scope: { zh:'预警不存在或已不在当前管理范围内。', en:'The warning is unavailable or outside your scope.' },
    invalid_alert_action: { zh:'不支持这个预警处理操作。', en:'This warning action is not supported.' },
    handling_note_required: { zh:'标记已处理前，请填写跟进结果。', en:'Enter the follow-up result before marking this warning handled.' },
    handling_note_too_long: { zh:'处理说明不能超过 2000 个字符。', en:'The handling note cannot exceed 2,000 characters.' },
    alert_confirmation_required: { zh:'请先确认跟进，再标记为已处理。', en:'Confirm the follow-up before marking it handled.' },
  }
  if (failure.auth === 'unauthorized') return messages.not_authenticated[locale]
  if (failure.auth === 'forbidden') return messages.permission_denied[locale]
  if (messages[raw]) return messages[raw][locale]
  // Supabase's SDK wrapper text is diagnostic, not actionable UI copy. Keep
  // alert failures inside the alert surface and use the localized operation
  // fallback while retaining useful server-provided messages.
  if (!raw || /^edge function returned a non-2xx status code$/i.test(raw)) return fallback
  return raw
}

function alertCopy(row, locale) {
  const name = clean(row?.employee_name) || clean(row?.employee_no) || (locale === 'en' ? 'Employee' : '员工')
  const count = countText(row?.occurrence_count)
  if (row?.alert_type === 'monthly_leave') {
    const rule = adminAlertMonthlyLeaveRule(row, locale)
    return locale === 'en'
      ? { title:'Monthly leave warning', message:`${name} has ${count} counted leave days this month, above the ${countText(rule.allowedDays)}-day limit (home leave excluded).` }
      : { title:clean(row?.title) || '当月休假天数预警', message:`${name} 本月累计休假 ${count} 天，已超过 ${countText(rule.allowedDays)} 天上限（回家不计）。` }
  }
  if (locale !== 'en') return { title:clean(row?.title) || eventName(row, locale), message:clean(row?.message) || '—' }
  switch (row?.alert_type) {
    case 'payout_change': return row?.payload?.fulfillment_status === 'mismatch'
      ? { title:'Approved payment details do not match', message:`${name}'s saved payment details differ from the approved request.` }
      : { title:'Payment details awaiting review', message:`${name} submitted a payment-details change.` }
    case 'error_spike': return { title:'Three-day error warning', message:`${name} has ${count} error records in the last 3 days.` }
    case 'deduction_frequency': return { title:'Seven-day deduction warning', message:`${name} received ${count} deductions in the last 7 days.` }
    case 'late_timeout_frequency': return { title:'Late / timeout frequency warning', message:`${name} has ${count} late or timeout-related deductions in the last 7 days.` }
    case 'consecutive_rest': return { title:'Consecutive rest-day warning', message:`${name} is marked for ${count} consecutive public rest days.` }
    case 'weekly_absence': return { title:'Weekly absence warning', message:`${name} was absent ${count} days in the last 7 days.` }
    case 'exam_failed': return { title:'Latest exam failed', message:`${name}'s latest graded exam did not pass${row?.payload?.percentage == null ? '.' : ` (${countText(row.payload.percentage)}%).`}` }
    case 'resigned_account_active': return { title:'Resigned account not recovered', message:`${name} is resigned but still has ${count} enabled login mapping(s).` }
    default: return { title:clean(row?.title) || eventName(row, locale), message:clean(row?.message) || '—' }
  }
}

function AlertAttendanceDetails({ row, locale }) {
  const detail = adminAlertAttendanceDetails(row, locale)
  if (!detail) return null
  return <section className={`admin-alert-attendance-detail ${detail.kind}`} data-admin-i18n-skip>
    <div className="admin-alert-attendance-title">
      <h4>{detail.title}</h4>
      {detail.limitLabel
        ? <strong>{detail.limitLabel}</strong>
        : detail.homeLeaveExcluded && <strong>{locale === 'en' ? 'Home leave is excluded from the total' : '回家不计入休假总数'}</strong>}
      {detail.qualityLabel && <strong>{detail.qualityLabel}</strong>}
    </div>
    {detail.breakdown.length > 0 && <div className="admin-alert-attendance-breakdown">
      {detail.breakdown.map(item => <span key={item.kind}><b>{item.label}</b> {countText(item.count)} {item.unit}{item.kind === 'half_day' && (locale === 'en' ? ` (${countText(item.count * 0.5)} days counted)` : `（计 ${countText(item.count * 0.5)} 天）`)}</span>)}
    </div>}
    {detail.missingDetails
      ? <p className="admin-alert-attendance-missing">{locale === 'en' ? 'The dated detail is waiting for the next warning-data refresh.' : '具体日期和原因将在下一次预警数据刷新后补齐。'}</p>
      : <div className="admin-alert-attendance-events">
        <div className="admin-alert-attendance-events-head" aria-hidden="true">
          <span>{locale === 'en' ? 'Date' : '异常日期'}</span><span>{locale === 'en' ? 'Type' : '类型'}</span><span>{locale === 'en' ? 'Reason' : '原因'}</span><span>{locale === 'en' ? 'Note' : '备注'}</span>
        </div>
        <ul>{detail.events.map((event, index) => <li key={`${event.date}:${event.eventKind}:${index}`}>
          <time data-label={locale === 'en' ? 'Date' : '异常日期'}>{event.date}</time>
          <strong data-label={locale === 'en' ? 'Type' : '类型'} className={event.eventKind}>{event.kindLabel}</strong>
          <span data-label={locale === 'en' ? 'Reason' : '原因'}>{event.reason || (locale === 'en' ? 'Not entered' : '未填写')}</span>
          <span data-label={locale === 'en' ? 'Note' : '备注'}>{event.note || (locale === 'en' ? 'Not entered' : '未填写')}</span>
        </li>)}</ul>
      </div>}
  </section>
}

function AlertErrorFrequencyDetails({ row, locale }) {
  const detail = adminAlertErrorFrequencyDetails(row, locale)
  if (!detail) return null
  return <section className="admin-alert-attendance-detail error-frequency" data-admin-i18n-skip>
    <div className="admin-alert-attendance-title"><h4>{detail.title}</h4><strong>{detail.note}</strong></div>
    <div className="admin-alert-attendance-breakdown">{detail.rules.map(rule => <span key={rule.days} className={rule.triggered ? 'triggered' : ''}><b>{rule.label}</b> {rule.result}{rule.triggered ? (locale === 'en' ? ' · Triggered' : ' · 已触发') : ''}</span>)}</div>
  </section>
}

async function loadAlertPage(filters, page, pageSize, signal = null) {
  const query = supabase.rpc('admin_alert_center', {
    p_filters: filters,
    p_page: page,
    p_page_size: pageSize,
  })
  const { data, error } = signal ? await query.abortSignal(signal) : await query
  if (error) throw error
  return data || { rows:[], total:0, pages:1, unread_total:0, active_total:0, type_counts:{} }
}

async function markAlertsRead(alertId = null) {
  const { data, error } = await supabase.rpc('admin_alert_mark_read', { p_alert_id:alertId })
  if (error) throw error
  window.dispatchEvent(new CustomEvent('wfh-admin-alerts-changed'))
  return data
}

async function updateAlertFollowUp(alertId, action, note = null) {
  const { data, error } = await supabase.rpc('admin_alert_update_follow_up', {
    p_alert_id:alertId,
    p_action:action,
    p_note:note,
  })
  if (error) throw error
  window.dispatchEvent(new CustomEvent('wfh-admin-alerts-changed'))
  return data?.follow_up || { status:'pending' }
}

function AlertFollowUpPanel({ row, locale, onUpdated }) {
  const workflow = adminAlertFollowUpState(row, locale)
  const [note, setNote] = useState(workflow.note)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setNote(workflow.note)
    setError('')
  }, [row.id, workflow.status, workflow.note])

  const submit = async action => {
    if (!onUpdated || busy) return
    if (action === 'handle' && !clean(note)) {
      setError(locale === 'en' ? 'Enter the follow-up result first.' : '请先填写跟进结果。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const followUp = await updateAlertFollowUp(row.id, action, action === 'handle' ? clean(note) : null)
      onUpdated(followUp)
    } catch (cause) {
      setError(alertErrorMessage(cause, locale, locale === 'en' ? 'Unable to update the follow-up.' : '预警跟进状态更新失败'))
    } finally {
      setBusy(false)
    }
  }

  return <section className="admin-alert-follow-up" data-admin-i18n-skip>
    <header>
      <div><h4>{locale === 'en' ? 'Read and handling audit' : '读取与处理记录'}</h4><p>{locale === 'en' ? 'Reading, confirmation and handling are recorded separately from automatic warning resolution.' : '读取、确认跟进、人工处理与系统自动解除分别记录。'}</p></div>
      <b className={workflow.status}>{workflow.label}</b>
    </header>
    <div className="admin-alert-follow-up-audit">
      <div><strong>{locale === 'en' ? 'Read by' : '读取账号'}</strong>{workflow.readers.length
        ? <ul>{workflow.readers.map(reader => <li key={`${reader.authUserId}:${reader.readAt}`}><b>{reader.account}</b><time>{formatTime(reader.readAt, locale)}</time></li>)}</ul>
        : <span>{locale === 'en' ? 'No reader recorded' : '尚无读取记录'}</span>}</div>
      <div><strong>{locale === 'en' ? 'Confirmed by' : '确认账号'}</strong>{workflow.confirmedBy
        ? <span><b>{workflow.confirmedBy}</b><time>{formatTime(workflow.confirmedAt, locale)}</time></span>
        : <span>{locale === 'en' ? 'Awaiting confirmation' : '待确认跟进'}</span>}</div>
      <div><strong>{locale === 'en' ? 'Handled by' : '处理账号'}</strong>{workflow.handledBy
        ? <span><b>{workflow.handledBy}</b><time>{formatTime(workflow.handledAt, locale)}</time></span>
        : <span>{locale === 'en' ? 'Not handled' : '尚未处理'}</span>}</div>
    </div>
    {workflow.status === 'handled' && !onUpdated && <div className="admin-alert-follow-up-note"><strong>{locale === 'en' ? 'Follow-up result' : '跟进结果'}</strong><p>{workflow.result || '—'}</p></div>}
    {onUpdated && workflow.status === 'pending' && <div className="admin-alert-follow-up-actions"><p>{locale === 'en' ? 'Confirm that someone has taken ownership of this warning.' : '确认后表示已有账号接手跟进此预警。'}</p><button type="button" onClick={() => submit('confirm')} disabled={busy}>{busy ? (locale === 'en' ? 'Saving…' : '保存中…') : (locale === 'en' ? 'Confirm follow-up' : '确认跟进')}</button></div>}
    {onUpdated && workflow.status !== 'pending' && <div className="admin-alert-follow-up-editor">
      <label><span>{locale === 'en' ? 'Follow-up result' : '跟进结果'} <b>*</b></span><textarea value={note} maxLength={2000} onChange={event => setNote(event.target.value)} placeholder={locale === 'en' ? 'Record the verified cause, result and action taken…' : '填写核实原因、跟进结果和处理方式…'} /></label>
      <div><small>{clean(note).length}/2000</small><button type="button" onClick={() => submit('handle')} disabled={busy}>{busy ? (locale === 'en' ? 'Saving…' : '保存中…') : workflow.status === 'handled' ? (locale === 'en' ? 'Update result' : '更新跟进结果') : (locale === 'en' ? 'Mark handled' : '标记已处理')}</button></div>
    </div>}
    {error && <p className="admin-alert-follow-up-error">{error}</p>}
  </section>
}

export function AdminAlertBell({ access }) {
  const { locale } = useAdminI18n()
  const navigate = useNavigate()
  const rootRef = useRef(null)
  const requestRef = useRef(0)
  const flightRef = useRef(null)
  const mountedRef = useRef(false)
  const cacheKeyRef = useRef('')
  const failureCountRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [state, setState] = useState({ loading:false, error:'', rows:[], unread:0, active:0 })
  const enabled = Boolean(access && !access.loading && !access.error && (
    access.founder || access.permissions?.includes('*') || access.permissions?.includes('alert.view')
  ))
  const canMarkRead = Boolean(access?.founder || access?.permissions?.includes('*') || access?.permissions?.includes('alert.mark_read'))
  const badgeCacheKey = adminAlertBadgeStorageKey(access)

  const load = ({ kind='details', quiet=false } = {}) => {
    if (!enabled) return Promise.resolve(false)
    const summaryOnly = kind === 'summary'
    const currentFlight = flightRef.current
    if (currentFlight) {
      if (summaryOnly || currentFlight.kind === 'details') return currentFlight.promise
      // A click always wins over the lightweight preload. The detail response
      // also carries the current summary, so running both would only add load.
      requestRef.current += 1
      currentFlight.controller.abort()
      flightRef.current = null
    }
    const requestId = ++requestRef.current
    const controller = new AbortController()
    if (!quiet) setState(current => ({ ...current, loading:true, error:'' }))
    const entry = { kind, controller, promise:null, timer:0, timedOut:false }
    entry.timer = window.setTimeout(() => {
      entry.timedOut = true
      controller.abort()
    }, ADMIN_ALERT_BADGE_REQUEST_TIMEOUT_MS)
    const promise = (async () => {
      try {
        // The mount/periodic path requests the smallest supported page and
        // discards its row. Full notification rows remain click-loaded.
        const data = await loadAlertPage({ status:'active' }, 1, summaryOnly ? 1 : 8, controller.signal)
        if (!mountedRef.current || requestId !== requestRef.current) return false
        const summary = { unread:numeric(data.unread_total), active:numeric(data.active_total) }
        failureCountRef.current = 0
        setState(current => summaryOnly
          ? { ...current, loading:false, error:'', ...summary }
          : { loading:false, error:'', rows:Array.isArray(data.rows) ? data.rows : [], ...summary })
        let storage = null
        try { storage = window.localStorage } catch { storage = null }
        writeAdminAlertBadgeCache(storage, cacheKeyRef.current, summary)
        return true
      } catch (error) {
        if ((controller.signal.aborted && !entry.timedOut) || !mountedRef.current || requestId !== requestRef.current) return false
        const handledError = entry.timedOut
          ? Object.assign(new Error('ADMIN_ALERT_BADGE_TIMEOUT'), { code:'ADMIN_ALERT_BADGE_TIMEOUT' })
          : error
        const failure = classifyAdminAlertBadgeFailure(handledError)
        if (summaryOnly) failureCountRef.current = Math.min(2, failureCountRef.current + 1)
        // Background summary failures (including 503 and client timeout) keep
        // both the last badge and the existing rows. Only an explicit click
        // surfaces a read error. 401/403 wording remains distinct, while the
        // shared authenticated fetch owns any session verification.
        setState(current => ({
          ...current,
          loading:false,
          error:summaryOnly
            ? current.error
            : failure.transient
              ? (locale === 'en' ? 'Unable to load notifications.' : '通知读取失败')
              : alertErrorMessage(handledError, locale, locale === 'en' ? 'Unable to load notifications.' : '通知读取失败'),
        }))
        return false
      } finally {
        window.clearTimeout(entry.timer)
        if (flightRef.current === entry) flightRef.current = null
      }
    })()
    entry.promise = promise
    flightRef.current = entry
    return promise
  }

  useEffect(() => {
    if (!enabled) return undefined
    mountedRef.current = true
    cacheKeyRef.current = badgeCacheKey
    let storage = null
    try { storage = window.localStorage } catch { storage = null }
    let timer = 0
    let stopped = false

    const applyCachedSummary = cached => {
      if (!cached || stopped) return
      setState(current => ({ ...current, unread:cached.unread, active:cached.active }))
    }
    const clearTimer = () => {
      window.clearTimeout(timer)
      timer = 0
    }
    const schedule = delay => {
      clearTimer()
      if (stopped || document.visibilityState !== 'visible') return
      timer = window.setTimeout(runSummary, Math.max(0, delay))
    }
    const scheduleFromCache = cached => {
      if (!cached?.fresh) {
        schedule(Math.floor(Math.random() * ADMIN_ALERT_BADGE_PRELOAD_JITTER_MS))
        return
      }
      schedule(
        Math.max(0, cached.updatedAt + ADMIN_ALERT_BADGE_CACHE_FRESH_MS - Date.now())
        + Math.floor(Math.random() * ADMIN_ALERT_BADGE_REFRESH_JITTER_MS),
      )
    }
    const runSummary = async () => {
      if (stopped || document.visibilityState !== 'visible') return
      const latest = readAdminAlertBadgeCache(storage, badgeCacheKey)
      if (latest?.fresh) {
        applyCachedSummary(latest)
        scheduleFromCache(latest)
        return
      }

      const token = badgeCacheKey && storage
        ? acquireAdminAlertBadgePreloadLease(storage, badgeCacheKey)
        : 'no-shared-storage'
      if (!token) {
        // Another visible tab owns this cycle. Its cache write will update this
        // tab through the storage event; this fallback stays deliberately slow.
        schedule(adminAlertBadgeRefreshDelay(0))
        return
      }
      const succeeded = await load({ kind:'summary', quiet:true })
      if (badgeCacheKey && storage) releaseAdminAlertBadgePreloadLease(storage, badgeCacheKey, token)
      if (!stopped) schedule(adminAlertBadgeRefreshDelay(succeeded ? 0 : failureCountRef.current))
    }

    const cached = readAdminAlertBadgeCache(storage, badgeCacheKey)
    applyCachedSummary(cached)
    scheduleFromCache(cached)

    // Alert mutations request a near-term summary refresh. They never load
    // rows in the background and coalesce with any in-flight detail request.
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        schedule(Math.floor(Math.random() * ADMIN_ALERT_BADGE_PRELOAD_JITTER_MS))
      }
    }
    const storageChanged = event => {
      if (!badgeCacheKey || event.key !== badgeCacheKey) return
      const next = readAdminAlertBadgeCache(storage, badgeCacheKey)
      if (!next) return
      failureCountRef.current = 0
      applyCachedSummary(next)
      scheduleFromCache(next)
    }
    const visibilityChanged = () => {
      if (document.visibilityState !== 'visible') {
        clearTimer()
        if (flightRef.current?.kind === 'summary') flightRef.current.controller.abort()
        return
      }
      const latest = readAdminAlertBadgeCache(storage, badgeCacheKey)
      applyCachedSummary(latest)
      scheduleFromCache(latest)
    }
    window.addEventListener('wfh-admin-alerts-changed', refresh)
    window.addEventListener('storage', storageChanged)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      stopped = true
      mountedRef.current = false
      requestRef.current += 1
      clearTimer()
      flightRef.current?.controller.abort()
      flightRef.current = null
      window.removeEventListener('wfh-admin-alerts-changed', refresh)
      window.removeEventListener('storage', storageChanged)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [enabled, locale, badgeCacheKey])

  useEffect(() => {
    if (!open && flightRef.current?.kind === 'details') {
      requestRef.current += 1
      flightRef.current.controller.abort()
      flightRef.current = null
      setState(current => ({ ...current, loading:false }))
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const close = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return
      setOpen(false)
      rootRef.current?.querySelector('.admin-alert-bell-button')?.focus()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  if (!enabled) return null
  const openAlert = async row => {
    try {
      if (canMarkRead && row.unread) {
        await markAlertsRead(row.id)
        setState(current => ({
          ...current,
          unread:Math.max(0, current.unread - 1),
          rows:current.rows.map(item => String(item.id) === String(row.id) ? { ...item, unread:false } : item),
        }))
      }
    } catch { /* navigation remains available */ }
    setOpen(false)
    navigate(alertDetailsTarget(row))
  }
  const markAll = async () => {
    try {
      await markAlertsRead()
      setState(current => ({ ...current, unread:0, rows:current.rows.map(row => ({ ...row, unread:false })) }))
    } catch (error) {
      setState(current => ({ ...current, error:alertErrorMessage(error, locale, locale === 'en' ? 'The operation failed.' : '操作失败') }))
    }
  }

  return <div className="admin-alert-bell" ref={rootRef}>
    <button type="button" className="admin-alert-bell-button" aria-label={locale === 'en' ? `Notifications, ${state.unread} unread` : `消息通知，${state.unread} 条未读`} aria-expanded={open} aria-controls="admin-alert-popover" onClick={() => { setOpen(value => !value); if (!open) load({ kind:'details' }) }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.8 10.2c0-3.2 1.8-5.4 5.2-5.4s5.2 2.2 5.2 5.4v3.2l1.6 2.4H5.2l1.6-2.4z"/><path d="M10 18.1c.4.7 1.1 1.1 2 1.1s1.6-.4 2-1.1"/></svg>
      {state.unread > 0 && <b aria-live="polite">{state.unread > 99 ? '99+' : state.unread}</b>}
    </button>
    {open && <section id="admin-alert-popover" className="admin-alert-popover" role="dialog" aria-modal="false" aria-label={locale === 'en' ? 'Notifications' : '消息通知'}>
      <header><div><strong>{locale === 'en' ? 'Notifications' : '消息通知'}</strong><small>{locale === 'en' ? `${state.active} active warnings` : `${state.active} 条进行中预警`}</small></div>{canMarkRead && state.unread > 0 && <button type="button" onClick={markAll}>{locale === 'en' ? 'Mark all read' : '全部已读'}</button>}</header>
      {state.error && <div className="admin-alert-popover-error">{state.error}</div>}
      {state.loading && !state.rows.length ? <div className="admin-alert-popover-empty">{locale === 'en' ? 'Loading…' : '读取中…'}</div>
        : !state.rows.length ? <div className="admin-alert-popover-empty">{locale === 'en' ? 'No active warnings' : '暂无进行中的预警'}</div>
          : <div className="admin-alert-popover-list">{state.rows.map(row => {
            const meta = TYPE_META[row.alert_type] || { icon:'警', tone:'blue' }
            const copy = alertCopy(row, locale)
            const evidence = adminAlertKeyAttendanceEvidence(row, locale)
            return <button type="button" key={row.id} className={row.unread ? 'unread' : ''} onClick={() => openAlert(row)}>
              <span className={`admin-alert-icon ${meta.tone}`} aria-hidden="true">{meta.icon}</span>
              <span data-admin-i18n-skip><strong>{copy.title}</strong><small>{evidence || copy.message}</small><em>{formatTime(row.last_seen_at, locale)} · {locale === 'en' ? 'Open details' : '打开详情'}</em></span>
              {row.unread && <i aria-hidden="true" />}
            </button>
          })}</div>}
      <footer><button type="button" onClick={() => { setOpen(false); navigate(adminAlertTarget('warning')) }}>{locale === 'en' ? 'View all warnings' : '查看全部预警记录'} <span>→</span></button></footer>
    </section>}
  </div>
}

export function EmployeeAlertHistoryPanel({ employeeId }) {
  const access = useAdminAccess()
  const { locale } = useAdminI18n()
  const requestRef = useRef(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [expandedId, setExpandedId] = useState('')
  const [state, setState] = useState({ loading:true, error:'', rows:[], total:0, pages:1 })
  const filters = useMemo(() => adminAlertEmployeeHistoryFilters(employeeId), [employeeId])

  const load = async (nextPage=page, nextSize=pageSize) => {
    if (!filters) {
      setState({ loading:false, error:'', rows:[], total:0, pages:1 })
      return
    }
    const requestId = ++requestRef.current
    setState(current => ({ ...current, loading:true, error:'' }))
    try {
      const data = await loadAlertPage(filters, nextPage, nextSize)
      if (requestId !== requestRef.current) return
      setState({
        loading:false,
        error:'',
        rows:Array.isArray(data.rows) ? data.rows : [],
        total:numeric(data.total),
        pages:Math.max(1, numeric(data.pages)),
      })
    } catch (error) {
      if (requestId !== requestRef.current) return
      setState(current => ({
        ...current,
        loading:false,
        error:alertErrorMessage(error, locale, locale === 'en' ? 'Unable to load employee warning history.' : '员工预警历史读取失败'),
      }))
    }
  }

  useEffect(() => {
    setPage(1)
    setExpandedId('')
    setState({ loading:true, error:'', rows:[], total:0, pages:1 })
    load(1, pageSize)
    return () => { requestRef.current += 1 }
  }, [employeeId, locale])

  const toggleRow = async row => {
    const opening = String(expandedId) !== String(row.id)
    setExpandedId(opening ? String(row.id) : '')
    if (!opening || !row.unread || !access.hasPermission('alert.mark_read')) return
    try {
      await markAlertsRead(row.id)
      setState(current => ({
        ...current,
        rows:current.rows.map(item => String(item.id) === String(row.id) ? { ...item, unread:false } : item),
      }))
    } catch (error) {
      setState(current => ({
        ...current,
        error:alertErrorMessage(error, locale, locale === 'en' ? 'Unable to mark this warning as read.' : '预警已读状态更新失败'),
      }))
    }
  }

  return <section className="detail-panel employee-alert-history-panel">
    <div className="detail-panel-head">
      <div><h3>{locale === 'en' ? 'Warning history' : '员工预警记录'}</h3><p>{locale === 'en' ? 'Only warnings visible within your current permissions and employee scope are shown.' : '仅显示当前账号权限与员工范围内可查看的历史预警。'}</p></div>
      <span className="employee-exam-count">{state.total} {locale === 'en' ? 'records' : '条'}</span>
    </div>
    {state.error && <div className="employee-alert-history-error">{state.error}</div>}
    {state.loading && !state.rows.length
      ? <div className="employee-exam-empty">{locale === 'en' ? 'Loading warning history…' : '正在读取预警历史…'}</div>
      : !state.rows.length
        ? <div className="employee-exam-empty">{locale === 'en' ? 'No warning history.' : '暂无预警记录'}</div>
        : <div className="employee-alert-history-table">
          <div className="employee-alert-history-head" aria-hidden="true">
            <span>{locale === 'en' ? 'Time' : '时间'}</span><span>{locale === 'en' ? 'Type' : '类型'}</span><span>{locale === 'en' ? 'Summary / reason' : '摘要 / 原因'}</span><span>{locale === 'en' ? 'Level' : '级别'}</span><span>{locale === 'en' ? 'Read / details' : '已读 / 详情'}</span>
          </div>
          {state.rows.map(row => {
            const meta = TYPE_META[row.alert_type] || { icon:'警', tone:'blue' }
            const copy = alertCopy(row, locale)
            const evidence = adminAlertKeyAttendanceEvidence(row, locale)
            const readState = adminAlertReadState(row, locale)
            const expanded = String(expandedId) === String(row.id)
            return <article className={`employee-alert-history-item ${readState.unread ? 'unread' : ''} ${expanded ? 'expanded' : ''}`} key={row.id}>
              <div className="employee-alert-history-row">
                <time data-label={locale === 'en' ? 'Time' : '时间'} data-admin-i18n-skip>{formatTime(row.is_active ? row.last_seen_at : row.resolved_at, locale)}</time>
                <span data-label={locale === 'en' ? 'Type' : '类型'} className="employee-alert-history-type"><i className={`admin-alert-category-dot ${meta.tone}`} />{meta[locale] || eventName(row, locale)}</span>
                <span data-label={locale === 'en' ? 'Summary / reason' : '摘要 / 原因'} className="employee-alert-history-summary" data-admin-i18n-skip><strong>{copy.title}</strong><small>{evidence || copy.message}</small></span>
                <span data-label={locale === 'en' ? 'Level' : '级别'}><i className={`admin-alert-severity ${row.severity}`}>{severityName(row, locale)}</i>{!row.is_active && <i className="admin-alert-resolved">{locale === 'en' ? 'Resolved' : '已解除'}</i>}</span>
                <span data-label={locale === 'en' ? 'Read / details' : '已读 / 详情'}><b className={`admin-alert-read-state ${readState.unread ? 'unread' : 'read'}`}>{readState.label}</b><button type="button" className="employee-alert-history-expand" aria-expanded={expanded} onClick={() => toggleRow(row)}>{expanded ? (locale === 'en' ? 'Collapse' : '收起') : (locale === 'en' ? 'Open' : '展开')}<i className="employee-alert-history-chevron" aria-hidden="true">⌄</i></button></span>
              </div>
              {expanded && <div className="employee-alert-history-expanded">
                <p data-admin-i18n-skip>{copy.message}</p>
                <AlertAttendanceDetails row={row} locale={locale}/>
                <AlertErrorFrequencyDetails row={row} locale={locale}/>
                <AlertFollowUpPanel row={row} locale={locale}/>
                <div className="admin-alert-expanded-meta"><span>{locale === 'en' ? 'Warning window' : '预警区间'} <b data-admin-i18n-skip>{row.window_start || '—'}{row.window_end && row.window_end !== row.window_start ? ` → ${row.window_end}` : ''}</b></span><span>{locale === 'en' ? 'First detected' : '首次检测'} <b data-admin-i18n-skip>{formatTime(row.first_seen_at, locale)}</b></span><span>{locale === 'en' ? 'Last updated' : '最后更新'} <b data-admin-i18n-skip>{formatTime(row.last_seen_at, locale)}</b></span></div>
              </div>}
            </article>
          })}
        </div>}
    {state.total > 0 && <Pagination
      page={page}
      pages={state.pages}
      total={state.total}
      pageSize={pageSize}
      loading={state.loading}
      onPage={next => { setPage(next); load(next, pageSize) }}
      onPageSize={next => { setPageSize(next); setPage(1); load(1, next) }}
    />}
  </section>
}

export function AdminAlertRecordsPage() {
  const access = useAdminAccess()
  const { locale } = useAdminI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const requestRef = useRef(0)
  const latestRef = useRef(null)
  const recordsRef = useRef(null)
  const requestedAlertRef = useRef('')
  const canViewEmployees = access.hasPermission('employee.directory.view')
  const canMarkRead = access.hasPermission('alert.mark_read')
  const canFollowUp = access.hasPermission('alert.follow_up')
  const [draft, setDraft] = useState({ search:'', status:'active', alert_type:'', group:'all', severity:'', unread_only:false })
  const [filters, setFilters] = useState(draft)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(30)
  const [state, setState] = useState({ loading:true, error:'', rows:[], total:0, pages:1, active:0, unread:0, typeCounts:{} })
  const [ruleDialog, setRuleDialog] = useState(null)
  const [expandedId, setExpandedId] = useState(() => new URLSearchParams(location.search).get('alert') || '')
  latestRef.current = { page, pageSize, filters }

  const requestedAlertId = useMemo(() => new URLSearchParams(location.search).get('alert') || '', [location.search])

  const typeOptions = useMemo(() => visibleAdminAlertTypes(access, {
    readyOnly:true,
    group:draft.group,
  }), [access.permissionKey, access.founder, draft.group])
  const categoryOptions = useMemo(() => visibleAdminAlertTypes(access, {
    group:draft.group,
  }), [access.permissionKey, access.founder, draft.group])
  const groupOptions = useMemo(() => Object.entries(ADMIN_ALERT_GROUPS).filter(([group]) => (
    group === 'all' || visibleAdminAlertTypes(access, { group }).length > 0
  )), [access.permissionKey, access.founder])

  const load = async (nextPage=page, nextSize=pageSize, nextFilters=filters) => {
    const requestId = ++requestRef.current
    setState(current => ({ ...current, loading:true, error:'' }))
    try {
      const data = await loadAlertPage(nextFilters, nextPage, nextSize)
      if (requestId !== requestRef.current) return
      const serverPages = Math.max(1, numeric(data.pages))
      if (nextPage > serverPages) {
        setPage(serverPages)
        await load(serverPages, nextSize, nextFilters)
        return
      }
      setState({ loading:false, error:'', rows:Array.isArray(data.rows) ? data.rows : [], total:numeric(data.total), pages:serverPages, active:numeric(data.active_total), unread:numeric(data.unread_total), typeCounts:data.type_counts || {} })
    } catch (error) {
      if (requestId !== requestRef.current) return
      setState(current => ({ ...current, loading:false, error:alertErrorMessage(error, locale, locale === 'en' ? 'Unable to load warning records.' : '预警记录读取失败') }))
    }
  }

  useEffect(() => {
    const initial = latestRef.current
    load(initial.page, initial.pageSize, initial.filters)
    const refresh = () => {
      const latest = latestRef.current
      load(latest.page, latest.pageSize, latest.filters)
    }
    window.addEventListener('wfh-admin-alerts-changed', refresh)
    return () => {
      requestRef.current += 1
      window.removeEventListener('wfh-admin-alerts-changed', refresh)
    }
  }, [access.permissionKey, locale])

  useEffect(() => {
    if (!requestedAlertId || requestedAlertRef.current === requestedAlertId || !state.rows.some(row => String(row.id) === requestedAlertId)) return
    requestedAlertRef.current = requestedAlertId
    setExpandedId(requestedAlertId)
    window.requestAnimationFrame(() => recordsRef.current?.scrollIntoView({ behavior:'smooth', block:'start' }))
  }, [requestedAlertId, state.rows])

  const apply = () => { setFilters({ ...draft }); setPage(1); load(1, pageSize, draft) }
  const reset = () => {
    const next = { search:'', status:'active', alert_type:'', group:'all', severity:'', unread_only:false }
    setDraft(next); setFilters(next); setPage(1); load(1, pageSize, next)
  }
  const selectGroup = group => {
    const next = { ...draft, group, alert_type:'' }
    setDraft(next); setFilters(next); setPage(1); load(1, pageSize, next)
  }
  const selectCategory = (type, meta) => {
    if (!meta.ready) {
      setRuleDialog({ kind:'pending', entries:[[type, meta]] })
      return
    }
    const next = { ...draft, group:meta.group, alert_type:type }
    setDraft(next); setFilters(next); setPage(1); load(1, pageSize, next)
    window.requestAnimationFrame(() => recordsRef.current?.scrollIntoView({ behavior:'smooth', block:'start' }))
  }
  const showActive = ({ unreadOnly=false } = {}) => {
    const next = { search:'', status:'active', alert_type:'', group:'all', severity:'', unread_only:unreadOnly }
    setDraft(next); setFilters(next); setPage(1); load(1, pageSize, next)
    window.requestAnimationFrame(() => recordsRef.current?.scrollIntoView({ behavior:'smooth', block:'start' }))
  }
  const markOne = async row => {
    try { await markAlertsRead(row.id) }
    catch (error) { setState(current => ({ ...current, error:alertErrorMessage(error, locale, locale === 'en' ? 'The operation failed.' : '操作失败') })) }
  }
  const markAll = async () => {
    try { await markAlertsRead() }
    catch (error) { setState(current => ({ ...current, error:alertErrorMessage(error, locale, locale === 'en' ? 'The operation failed.' : '操作失败') })) }
  }
  const toggleRow = row => {
    const opening = String(expandedId) !== String(row.id)
    setExpandedId(opening ? String(row.id) : '')
    if (opening && row.unread && canMarkRead) markOne(row)
  }
  const updateRowFollowUp = (alertId, followUp) => {
    setState(current => ({
      ...current,
      rows:current.rows.map(item => String(item.id) === String(alertId) ? { ...item, follow_up:followUp } : item),
    }))
  }

  return <section className="admin-alert-records-page">
    <header className="admin-alert-records-head">
      <div><small>{locale === 'en' ? 'WARNING RECORDS' : '预警记录 · 新列表'}</small><h2>{locale === 'en' ? 'Employee warning records' : '员工预警记录表'}</h2><p>{locale === 'en' ? 'Employee IDs stay selectable. Only the Open / Collapse control toggles details.' : '员工 ID 可直接选择复制；只有点击“展开 / 收起”才会切换详情。'}</p></div>
      <div><button type="button" className="secondary-action" onClick={() => setRuleDialog({ kind:'all', entries:visibleAdminAlertTypes(access) })}>{locale === 'en' ? 'Rules' : '规则说明'}</button><button type="button" className="secondary-action" onClick={() => load(page, pageSize, filters)} disabled={state.loading}>{state.loading ? (locale === 'en' ? 'Refreshing…' : '刷新中…') : (locale === 'en' ? 'Refresh' : '↻ 刷新')}</button>{canMarkRead && state.unread > 0 && <button type="button" className="primary-action" title={locale === 'en' ? 'Marks every active warning in the current account scope as read.' : '把当前账号权限范围内所有进行中预警标为已读。'} onClick={markAll}>{locale === 'en' ? 'Mark all read' : '全部标为已读'}</button>}</div>
    </header>

    <div className="admin-alert-summary-strip" aria-label={locale === 'en' ? 'Warning summary' : '预警汇总'}>
      <button type="button" onClick={() => showActive()}><span>{locale === 'en' ? 'Active' : '进行中'}</span><strong>{state.active}</strong></button>
      <button type="button" className="unread" onClick={() => showActive({ unreadOnly:true })}><span>{locale === 'en' ? 'Unread' : '未读'}</span><strong>{state.unread}</strong></button>
      <button type="button" onClick={() => setRuleDialog({ kind:'ready', entries:visibleAdminAlertTypes(access, { readyOnly:true }) })}><span>{locale === 'en' ? 'Enabled rules' : '已启用规则'}</span><strong>{visibleAdminAlertTypes(access, { readyOnly:true }).length}</strong></button>
    </div>

    <section className="admin-alert-category-panel" aria-label={locale === 'en' ? 'Warning categories' : '预警子分类'}>
      <nav className="admin-alert-group-nav" aria-label={locale === 'en' ? 'Warning category groups' : '预警分类导航'}>
        {groupOptions.map(([group, meta]) => <button type="button" key={group} className={draft.group === group ? 'active' : ''} aria-current={draft.group === group ? 'page' : undefined} onClick={() => selectGroup(group)}>{meta[locale]}</button>)}
      </nav>
      <div className="admin-alert-category-grid">
        {categoryOptions.map(([type, meta]) => {
          const pendingReason = adminAlertPendingReason(meta, locale)
          return <button type="button" key={type} className={`${draft.alert_type === type ? 'active' : ''} ${meta.ready ? 'ready' : 'pending'}`} title={pendingReason || ''} onClick={() => selectCategory(type, meta)}>
            <span className={`admin-alert-category-dot ${meta.tone}`} aria-hidden="true" />
            <b>{meta[locale]}</b>
            <strong>{meta.ready ? numeric(state.typeCounts[type]) : '—'}</strong>
          </button>
        })}
      </div>
    </section>

    <div className="admin-alert-filter-card">
      <label><span>{locale === 'en' ? 'Employee / warning' : '员工 / 预警内容'}</span><input value={draft.search} onChange={event => setDraft(current => ({ ...current, search:event.target.value }))} onKeyDown={event => { if (event.key === 'Enter') apply() }} placeholder={locale === 'en' ? 'Employee ID, name or warning' : '员工ID、姓名或预警内容'} /></label>
      <label><span>{locale === 'en' ? 'Status' : '状态'}</span><select value={draft.status} onChange={event => setDraft(current => ({ ...current, status:event.target.value }))}><option value="active">{locale === 'en' ? 'Active' : '进行中'}</option><option value="resolved">{locale === 'en' ? 'Resolved' : '已解除'}</option><option value="all">{locale === 'en' ? 'All' : '全部'}</option></select></label>
      <label><span>{locale === 'en' ? 'Type' : '预警类型'}</span><select value={draft.alert_type} onChange={event => setDraft(current => ({ ...current, alert_type:event.target.value }))}><option value="">{locale === 'en' ? 'All types' : '全部类型'}</option>{typeOptions.map(([type, meta]) => <option key={type} value={type}>{meta[locale]}</option>)}</select></label>
      <label><span>{locale === 'en' ? 'Severity' : '级别'}</span><select value={draft.severity} onChange={event => setDraft(current => ({ ...current, severity:event.target.value }))}><option value="">{locale === 'en' ? 'All levels' : '全部级别'}</option>{Object.entries(SEVERITY_META).map(([value, meta]) => <option value={value} key={value}>{meta[locale]}</option>)}</select></label>
      <label className="admin-alert-unread-toggle"><input type="checkbox" checked={draft.unread_only} onChange={event => setDraft(current => ({ ...current, unread_only:event.target.checked }))}/><span>{locale === 'en' ? 'Unread only' : '只看未读'}</span></label>
      <div className="admin-alert-filter-actions"><button type="button" className="primary-action" onClick={apply}>{locale === 'en' ? 'Search' : '查询'}</button><button type="button" className="secondary-action" onClick={reset}>{locale === 'en' ? 'Reset' : '重置'}</button></div>
    </div>

    {state.error && <div className="page-error employee-notice">{state.error}</div>}
    <div className="admin-alert-record-table" ref={recordsRef}>
      <div className="admin-alert-table-head" aria-hidden="true">
        <span>{locale === 'en' ? 'Hire date' : '入职日期'}</span><span>{locale === 'en' ? 'Employee ID' : '员工 ID'}</span><span>{locale === 'en' ? 'Name' : '姓名'}</span><span>{locale === 'en' ? 'Team' : '团队'}</span><span>{locale === 'en' ? 'Warning type' : '预警类型'}</span><span>{locale === 'en' ? 'Level' : '级别'}</span><span>{locale === 'en' ? 'Updated' : '更新时间'}</span><span>{locale === 'en' ? 'Summary' : '预警摘要'}</span><span>{locale === 'en' ? 'Read status' : '阅读状态'}</span><span>{locale === 'en' ? 'Follow-up status' : '跟进状态'}</span><span>{locale === 'en' ? 'Follow-up result' : '跟进结果'}</span><span>{locale === 'en' ? 'Follow-up account' : '跟进账号'}</span><span>{locale === 'en' ? 'Details' : '详情'}</span>
      </div>
      {state.loading && !state.rows.length ? <div className="admin-alert-table-loading" aria-label={locale === 'en' ? 'Loading warning records' : '正在读取预警记录'}>{[0,1,2,3].map(item => <span key={item} />)}</div>
        : !state.rows.length ? <div className="empty-state">{locale === 'en' ? 'No matching warnings.' : '暂无符合条件的预警记录。'}</div>
          : state.rows.map(row => {
            const meta = TYPE_META[row.alert_type] || { icon:'警', tone:'blue' }
            const copy = alertCopy(row, locale)
            const readState = adminAlertReadState(row, locale)
            const workflow = adminAlertFollowUpState(row, locale)
            const expanded = String(expandedId) === String(row.id)
            return <article className={`admin-alert-table-item ${row.unread ? 'unread' : ''} ${row.is_active ? 'active' : 'resolved'} ${expanded ? 'expanded' : ''}`} key={row.id} data-alert-id={row.id}>
              <div className="admin-alert-table-row">
                <span data-label={locale === 'en' ? 'Hire date' : '入职日期'} data-admin-i18n-skip>{adminAlertEmployeeHireDate(row)}</span>
                <strong className="admin-alert-employee-id" data-label={locale === 'en' ? 'Employee ID' : '员工 ID'} data-admin-i18n-skip>{row.employee_no || '—'}</strong>
                <span data-label={locale === 'en' ? 'Name' : '姓名'} data-admin-i18n-skip title={row.employee_name || undefined}>{row.employee_name || '—'}</span>
                <span data-label={locale === 'en' ? 'Team' : '团队'} className="admin-alert-table-team" data-admin-i18n-skip title={row.team_name || undefined}>{row.team_name || '—'}</span>
                <span data-label={locale === 'en' ? 'Warning type' : '预警类型'} className="admin-alert-table-type"><i className={`admin-alert-category-dot ${meta.tone}`} />{meta[locale] || eventName(row, locale)}</span>
                <span data-label={locale === 'en' ? 'Level' : '级别'}><i className={`admin-alert-severity ${row.severity}`}>{severityName(row, locale)}</i>{!row.is_active && <i className="admin-alert-resolved">{locale === 'en' ? 'Resolved' : '已解除'}</i>}</span>
                <time data-label={locale === 'en' ? 'Updated' : '更新时间'} data-admin-i18n-skip title={formatTime(row.is_active ? row.last_seen_at : row.resolved_at, locale)}>{formatTime(row.is_active ? row.last_seen_at : row.resolved_at, locale)}</time>
                <span data-label={locale === 'en' ? 'Summary' : '预警摘要'} className="admin-alert-table-summary" data-admin-i18n-skip title={copy.message}>{copy.message}</span>
                <span data-label={locale === 'en' ? 'Read status' : '阅读状态'} className="admin-alert-table-read"><b className={`admin-alert-read-state ${readState.unread ? 'unread' : 'read'}`}>{readState.label}</b></span>
                <span data-label={locale === 'en' ? 'Follow-up status' : '跟进状态'} className="admin-alert-table-followup" data-admin-i18n-skip><small className={workflow.status}>{workflow.label}</small></span>
                <span data-label={locale === 'en' ? 'Follow-up result' : '跟进结果'} className="admin-alert-table-result" data-admin-i18n-skip title={workflow.result || undefined}>{workflow.result || '—'}</span>
                <span data-label={locale === 'en' ? 'Follow-up account' : '跟进账号'} className="admin-alert-table-followup-account" data-admin-i18n-skip title={workflow.followUpAccount || undefined}>{workflow.followUpAccount || '—'}</span>
                <button type="button" className="admin-alert-table-expand" aria-expanded={expanded} onClick={() => toggleRow(row)}>{expanded ? (locale === 'en' ? 'Collapse' : '收起') : (locale === 'en' ? 'Open' : '展开')}<i aria-hidden="true">⌄</i></button>
              </div>
              {expanded && <div className="admin-alert-expanded-panel">
                <div className="admin-alert-expanded-head"><div><span className={`admin-alert-icon ${meta.tone}`} aria-hidden="true">{meta.icon}</span><div><strong data-admin-i18n-skip>{copy.title}</strong><p data-admin-i18n-skip>{copy.message}</p></div></div><div className="admin-alert-record-actions">{row.alert_type === 'payout_change' && row.is_active && <button type="button" className="primary" onClick={() => navigate(adminAlertTarget(row.alert_type))}>{locale === 'en' ? 'Review' : '去审核'}</button>}{canViewEmployees && row.employee_id && <button type="button" onClick={() => navigate(adminAlertEmployeeTarget(row.employee_id))}>{locale === 'en' ? 'Employee file' : '员工档案'}</button>}</div></div>
                <AlertAttendanceDetails row={row} locale={locale}/>
                <AlertErrorFrequencyDetails row={row} locale={locale}/>
                <AlertFollowUpPanel row={row} locale={locale} onUpdated={canFollowUp ? followUp => updateRowFollowUp(row.id, followUp) : undefined}/>
                <div className="admin-alert-expanded-meta"><span>{locale === 'en' ? 'Warning window' : '预警区间'} <b data-admin-i18n-skip>{row.window_start || '—'}{row.window_end && row.window_end !== row.window_start ? ` → ${row.window_end}` : ''}</b></span><span>{locale === 'en' ? 'First detected' : '首次检测'} <b data-admin-i18n-skip>{formatTime(row.first_seen_at, locale)}</b></span><span>{row.is_active ? (locale === 'en' ? 'Last updated' : '最后更新') : (locale === 'en' ? 'Resolved' : '解除时间')} <b data-admin-i18n-skip>{formatTime(row.is_active ? row.last_seen_at : row.resolved_at, locale)}</b></span></div>
              </div>}
            </article>
          })}
    </div>
    <Pagination page={page} pages={state.pages} total={state.total} pageSize={pageSize} loading={state.loading} onPage={next => { setPage(next); load(next, pageSize, filters) }} onPageSize={next => { setPageSize(next); setPage(1); load(1, next, filters) }}/>
    {ruleDialog && <AlertRuleDialog locale={locale} value={ruleDialog} typeCounts={state.typeCounts} onClose={() => setRuleDialog(null)}/>}
  </section>
}

function AlertRuleDialog({ locale, value, typeCounts, onClose }) {
  const dialogRef = useRef(null)
  useEffect(() => {
    const previousFocus = document.activeElement
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || [])
    focusable()[0]?.focus()
    const handleKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      previousFocus?.focus?.()
    }
  }, [onClose])
  const title = value.kind === 'pending'
    ? (locale === 'en' ? 'Rules to complete' : '待完善规则')
    : value.kind === 'ready'
      ? (locale === 'en' ? 'Enabled rules' : '已启用规则')
      : (locale === 'en' ? 'Warning rules' : '预警规则说明')
  return <div className="admin-alert-rule-mask" role="presentation" onMouseDown={onClose}>
    <section ref={dialogRef} className="admin-alert-rule-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={event => event.stopPropagation()}>
      <header><div><h3>{title}</h3>{value.kind === 'pending' && <p>{locale === 'en' ? 'These are planned warnings, not failed synchronizations.' : '这些是尚未完善定义的预警，不是同步失败。'}</p>}</div><button type="button" onClick={onClose} aria-label={locale === 'en' ? 'Close' : '关闭'}>×</button></header>
      <div className="admin-alert-rule-list">{value.entries.map(([type, meta]) => {
        const pending = !meta.ready
        return <article key={type}>
          <span className={`admin-alert-icon ${meta.tone}`} aria-hidden="true">{meta.icon}</span>
          <div><strong>{meta[locale]}</strong><p>{pending ? adminAlertPendingReason(meta, locale) : (ALERT_RULE_COPY[type]?.[locale] || (locale === 'en' ? 'Enabled warning rule.' : '已启用预警规则。'))}</p></div>
          <em className={pending ? 'pending' : 'ready'}>{pending ? (locale === 'en' ? 'To complete' : '待完善') : `${numeric(typeCounts[type])} ${locale === 'en' ? 'active' : '条'}`}</em>
        </article>
      })}</div>
    </section>
  </div>
}
