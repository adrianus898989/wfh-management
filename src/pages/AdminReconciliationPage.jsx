import React, { useEffect, useMemo, useRef, useState } from 'react'
import AdminModuleNav from '../components/AdminModuleNav'
import { Pagination } from '../components/DataPageControls'
import { supabase } from '../lib/supabase'
import {
  PERSONNEL_RECONCILIATION_VIEWS,
  emptyPersonnelReconciliationResult,
  normalizePersonnelReconciliationResponse,
  personnelReconciliationConfirmationLabel,
  personnelReconciliationErrorMessage,
  personnelReconciliationIssueLabel,
  personnelReconciliationOnsiteAccepted,
  personnelReconciliationOnsiteLabel,
  personnelReconciliationReasonLabel,
  personnelReconciliationRowKey,
  personnelReconciliationSearch,
  personnelReconciliationStatusLabel,
} from '../lib/adminPersonnelReconciliation'
import '../styles-reconciliation.css'

const REQUEST_TIMEOUT_MS = 8000
const FRESHNESS_STALE_AFTER_MS = 36 * 60 * 60 * 1000
const PAGE_SIZE_OPTIONS = [20, 30, 50]
const text = value => String(value ?? '').trim()
const bool = value => value === true

const initialViews = () => Object.fromEntries(PERSONNEL_RECONCILIATION_VIEWS.map(({ key }) => [
  key,
  { ...emptyPersonnelReconciliationResult(key), loading:false, error:'' },
]))

const formatCount = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('zh-CN')
  : '—'

const formatTime = value => {
  if (!text(value)) return '尚无成功对账时间'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return text(value)
  return new Intl.DateTimeFormat('zh-CN', {
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
  }).format(parsed)
}

const freshnessAge = seconds => {
  if (seconds === null || seconds === undefined || typeof seconds === 'boolean') return ''
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 60) return `${Math.floor(value)} 秒前`
  if (value < 3600) return `${Math.floor(value / 60)} 分钟前`
  if (value < 86400) return `${Math.floor(value / 3600)} 小时前`
  return `${Math.floor(value / 86400)} 天前`
}

function StatusChip({ value, tone = '' }) {
  const key = text(value).toLowerCase()
  const resolvedTone = tone || (['active', 'resolved', 'confirmed'].includes(key)
    ? 'ok'
    : ['failed', 'resigned'].includes(key)
      ? 'danger'
      : 'review')
  return <span className={`recon-chip recon-chip-${resolvedTone}`}>{personnelReconciliationStatusLabel(value)}</span>
}

function SourcePresence({ row }) {
  const sources = [
    ['后台首页', bool(row.in_dashboard)],
    ['员工档案页', bool(row.in_employee_page)],
    ['当前目录', bool(row.in_directory)],
    ['Google《居家员工名单》', bool(row.in_home_source)],
    ['汇总表排班', bool(row.in_report)],
    ['员工同步排班', bool(row.in_schedule_source)],
  ]
  return <div className="recon-source-presence">
    {sources.map(([label, present]) => <span className={present ? 'is-present' : 'is-missing'} key={label}>{label} {present ? '有' : '无'}</span>)}
  </div>
}

function PersonCell({ row }) {
  return <div className="recon-person-cell">
    <strong>{row.employee_no || '无员工 ID'}</strong>
    <span>{row.full_name || '姓名待补充'}</span>
  </div>
}

function HeadcountReason({ row }) {
  const aliases = Array.isArray(row.report_person_keys)
    ? row.report_person_keys.map(text).filter(Boolean)
    : []
  return <div className="recon-reason">
    <strong>{personnelReconciliationReasonLabel(row)}</strong>
    {aliases.length > 1&&<small>汇总表 ID：{aliases.join('、')}</small>}
  </div>
}

function HeadcountRows({ rows }) {
  return <div className="recon-table-scroll"><table className="recon-table">
    <thead><tr><th>员工</th><th>主档状态</th><th>页面 / 来源记录</th><th>差异原因</th><th>人员类型</th><th>离职日期</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={personnelReconciliationRowKey(row, index)}>
      <td><PersonCell row={row}/></td>
      <td><StatusChip value={row.status}/></td>
      <td><SourcePresence row={row}/></td>
      <td><HeadcountReason row={row}/></td>
      <td><div className="recon-stacked"><span>{row.employment_type || '—'}</span><small>{row.source_type || '—'}</small></div></td>
      <td>{text(row.resign_date).slice(0, 10) || '—'}</td>
    </tr>)}</tbody>
  </table></div>
}

function IssueRows({ rows }) {
  return <div className="recon-table-scroll"><table className="recon-table">
    <thead><tr><th>员工</th><th>差异类型</th><th>具体原因</th><th>来源位置</th><th>主档状态</th><th>处理状态</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={personnelReconciliationRowKey(row, index)}>
      <td><PersonCell row={row}/></td>
      <td><div className="recon-reason"><strong>{personnelReconciliationIssueLabel(row)}</strong></div></td>
      <td>{personnelReconciliationReasonLabel(row)}</td>
      <td><div className="recon-stacked"><span>员工主表行 {row.home_source_row || '—'}</span><span>排班行 {row.schedule_source_row || '—'}</span></div></td>
      <td><StatusChip value={row.status}/></td>
      <td><StatusChip value={row.diagnostic_status || 'needs_review'}/></td>
    </tr>)}</tbody>
  </table></div>
}

function OnsiteConfirmation({ row }) {
  const markers = []
  if (row.confirmed_onsite) markers.push('已确认现场')
  if (row.managed_external) markers.push('管理范围内外部人员')
  if (row.source_onsite_marker || row.classification === 'onsite_marker') markers.push('源表现场标记')
  if (row.schedule_backfill) markers.push('排班补录')
  return <div className="recon-onsite-confirmation">
    {(markers.length ? markers : ['尚无确认标记']).map(marker => <span key={marker}>{marker}</span>)}
    {row.confirmation&&<small>{personnelReconciliationConfirmationLabel(row.confirmation)}</small>}
  </div>
}

function OnsiteRows({ rows }) {
  return <div className="recon-table-scroll"><table className="recon-table">
    <thead><tr><th>员工</th><th>现场分类</th><th>团队 / 岗位</th><th>班次</th><th>确认依据</th><th>排班来源行</th><th>状态</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={personnelReconciliationRowKey(row, index)}>
      <td><PersonCell row={row}/></td>
      <td><span className={`recon-chip recon-chip-${personnelReconciliationOnsiteAccepted(row) ? 'ok' : 'review'}`}>{personnelReconciliationOnsiteLabel(row)}</span></td>
      <td><div className="recon-stacked"><strong>{row.team || '团队待补充'}</strong><span>{row.position || '岗位待补充'}</span></div></td>
      <td>{row.shift || '—'}</td>
      <td><OnsiteConfirmation row={row}/></td>
      <td>{row.source_row || '—'}</td>
      <td><StatusChip value={row.status}/></td>
    </tr>)}</tbody>
  </table></div>
}

const VIEW_ROWS = {
  headcount:HeadcountRows,
  issues:IssueRows,
  onsite:OnsiteRows,
}

function SummaryCard({ label, value, note, tone = '' }) {
  return <article className={`recon-summary-card ${tone ? `is-${tone}` : ''}`}>
    <span>{label}</span>
    <strong>{formatCount(value)}</strong>
    <small>{note}</small>
  </article>
}

export default function AdminReconciliationPage() {
  const [activeView, setActiveView] = useState('headcount')
  const [draftSearch, setDraftSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [pageSize, setPageSize] = useState(30)
  const [views, setViews] = useState(initialViews)
  const [summary, setSummary] = useState(null)
  const [freshness, setFreshness] = useState(null)
  const [clock, setClock] = useState(() => Date.now())
  const requestRefs = useRef(Object.fromEntries(PERSONNEL_RECONCILIATION_VIEWS.map(({ key }) => [key, 0])))
  const controllerRefs = useRef({})
  const metadataRequestRef = useRef(0)
  const successfulViewsRef = useRef(new Set())

  const load = async ({
    view = activeView,
    page = views[view]?.page || 1,
    size = pageSize,
    search = appliedSearch,
  } = {}) => {
    const requestId = (requestRefs.current[view] || 0) + 1
    const metadataRequestId = metadataRequestRef.current + 1
    requestRefs.current[view] = requestId
    metadataRequestRef.current = metadataRequestId
    controllerRefs.current[view]?.abort()
    const controller = new AbortController()
    controllerRefs.current[view] = controller
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    setViews(current => ({
      ...current,
      [view]:{ ...current[view], loading:true, error:'' },
    }))
    try {
      const query = supabase.rpc('admin_personnel_reconciliation', {
        p_view:view,
        p_filters:{ search:personnelReconciliationSearch(search) },
        p_page:page,
        p_page_size:size,
      })
      const { data, error } = await query.abortSignal(controller.signal)
      if (error) throw error
      if (requestId !== requestRefs.current[view]) return false
      const result = normalizePersonnelReconciliationResponse(data, view, size)
      if (!result.rows.length && result.total > 0 && result.page < page) {
        return load({ view, page:result.page, size, search })
      }
      successfulViewsRef.current.add(view)
      setViews(current => ({
        ...current,
        [view]:{ ...result, loading:false, error:'' },
      }))
      if (metadataRequestId === metadataRequestRef.current) {
        setSummary(result.summary)
        setFreshness(result.freshness)
      }
      return true
    } catch (error) {
      if (requestId !== requestRefs.current[view]) return false
      const timedOut = controller.signal.aborted
      setViews(current => ({
        ...current,
        [view]:{
          ...current[view],
          loading:false,
          error:personnelReconciliationErrorMessage(error, { timedOut }),
        },
      }))
      return false
    } finally {
      window.clearTimeout(timer)
      if (controllerRefs.current[view] === controller) delete controllerRefs.current[view]
    }
  }

  useEffect(() => {
    void load({ view:'headcount', page:1, size:pageSize, search:'' })
    return () => {
      PERSONNEL_RECONCILIATION_VIEWS.forEach(({ key }) => {
        requestRefs.current[key] = (requestRefs.current[key] || 0) + 1
        controllerRefs.current[key]?.abort()
      })
      metadataRequestRef.current += 1
      controllerRefs.current = {}
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  const current = views[activeView]
  const Rows = VIEW_ROWS[activeView]
  const currentMeta = PERSONNEL_RECONCILIATION_VIEWS.find(item => item.key === activeView)
  const searchPlaceholder = activeView === 'onsite'
    ? '员工 ID / 姓名 / 团队 / 岗位 / 班次'
    : activeView === 'headcount'
      ? '员工 ID / 姓名 / 差异原因'
      : '员工 ID / 姓名'
  const lastRefresh = freshness?.finished_at || freshness?.captured_at
  const reportRefresh = freshness?.report_synced_at
  const lastRefreshTime = lastRefresh ? new Date(lastRefresh).getTime() : Number.NaN
  const reportedAge = freshness?.age_seconds === null || freshness?.age_seconds === undefined
    ? Number.NaN
    : Number(freshness.age_seconds)
  const ageSeconds = Number.isFinite(lastRefreshTime)
    ? Math.max(0, Math.floor((clock - lastRefreshTime) / 1000))
    : (Number.isFinite(reportedAge) ? reportedAge : null)
  const ageLabel = freshnessAge(ageSeconds)
  const reportRefreshTime = reportRefresh ? new Date(reportRefresh).getTime() : Number.NaN
  const reportAgeSeconds = Number.isFinite(reportRefreshTime)
    ? Math.max(0, Math.floor((clock - reportRefreshTime) / 1000))
    : null
  const reportAgeLabel = freshnessAge(reportAgeSeconds)
  const freshnessIsStale = freshness?.is_stale === true
    || freshness?.report_is_stale === true
    || (ageSeconds !== null && ageSeconds * 1000 >= FRESHNESS_STALE_AFTER_MS)
    || (reportAgeSeconds !== null && reportAgeSeconds * 1000 >= FRESHNESS_STALE_AFTER_MS)
  const tabCounts = useMemo(() => ({
    headcount:summary?.headcount_total,
    issues:summary?.issue_total,
    onsite:summary?.onsite_total,
  }), [summary])

  const selectView = view => {
    if (view === activeView) return
    const activeController = controllerRefs.current[activeView]
    if (activeController) {
      requestRefs.current[activeView] = (requestRefs.current[activeView] || 0) + 1
      activeController.abort()
      delete controllerRefs.current[activeView]
      setViews(current => ({
        ...current,
        [activeView]:{ ...current[activeView], loading:false },
      }))
    }
    setActiveView(view)
    if (!successfulViewsRef.current.has(view)) {
      void load({ view, page:1, size:pageSize, search:appliedSearch })
    }
  }
  const query = () => {
    const search = personnelReconciliationSearch(draftSearch)
    setDraftSearch(search)
    setAppliedSearch(search)
    void load({ view:activeView, page:1, size:pageSize, search })
  }
  const reset = () => {
    setDraftSearch('')
    setAppliedSearch('')
    void load({ view:activeView, page:1, size:pageSize, search:'' })
  }

  return <div className="content-page reconciliation-page">
    <header className="recon-page-head">
      <div><div className="module-kicker">WORKFORCE RECONCILIATION</div><h1>人员对账</h1><p>把后台首页、员工档案页、汇总表排班与同步来源放在同一处核对；已确认现场人员单独列出，不计入待处理误差。</p></div>
      <button type="button" className="recon-refresh" onClick={() => load()} disabled={current.loading}>{current.loading ? '读取中…' : '↻ 重新读取结果'}</button>
    </header>

    <AdminModuleNav/>

    <section className="recon-policy-note" aria-label="人数对账规则">
      <strong>人数误差只核对今天应计人员：</strong>
      <span>未来入职不计入；员工离职后，只要居家名单已标离职且已从当前排班、汇总移除，就只保留后台历史档案，不再算误差；现场人员在独立页签展示。</span>
    </section>

    <section className={`recon-freshness ${freshnessIsStale ? 'is-stale' : ''}`} aria-live="polite">
      <div><i aria-hidden="true"/><strong>{freshnessIsStale ? '对账数据可能已过期' : '最近一次对账'}</strong><span>{formatTime(lastRefresh)}{ageLabel ? ` · ${ageLabel}` : ''}</span></div>
      <div><span>Google《居家员工名单》 {formatCount(freshness?.home_rows)} 行</span><span>员工同步排班 {formatCount(freshness?.schedule_rows)} 行</span><span>汇总表快照 {formatCount(freshness?.report_rows)} 行 · {formatTime(reportRefresh)}{reportAgeLabel ? ` · ${reportAgeLabel}` : ''}</span>{freshness?.run_id&&<span>批次 {freshness.run_id}</span>}</div>
    </section>

    <section className="recon-summary-grid" aria-label="人数统计口径">
      <SummaryCard label="后台首页当前在职" value={summary?.dashboard_effective_active} note="与首页卡片使用同一今日生效口径"/>
      <SummaryCard label="员工档案页在职" value={summary?.directory_effective_active} note="按马尼拉今日与当前组织目录"/>
      <SummaryCard label="员工档案当前目录（来源）" value={summary?.directory_total} note="来源原始人数，可能含未来入职或待移除记录"/>
      <SummaryCard label="汇总表排班人数（来源）" value={summary?.report_total} note="来源原始人数；不直接等于今天应计在职" tone="schedule"/>
    </section>

    <section className="recon-workspace">
      <nav className="recon-tabs" aria-label="人员对账分类">
        {PERSONNEL_RECONCILIATION_VIEWS.map(item => <button type="button" className={activeView === item.key ? 'active' : ''} aria-current={activeView === item.key ? 'page' : undefined} key={item.key} onClick={() => selectView(item.key)}>
          <span>{item.label}</span><b>{formatCount(tabCounts[item.key])}</b>
        </button>)}
      </nav>

      <div className="recon-toolbar">
        <label><span>搜索当前分类</span><input value={draftSearch} maxLength={120} onChange={event => setDraftSearch(event.target.value)} onKeyDown={event => event.key === 'Enter' && query()} placeholder={searchPlaceholder}/></label>
        <div><button type="button" className="primary" onClick={query} disabled={current.loading}>查询</button><button type="button" onClick={reset} disabled={current.loading}>重置</button></div>
      </div>

      {current.error&&<div className="recon-error" role="alert"><span>{current.error}</span><button type="button" onClick={() => load()}>重试</button></div>}
      {current.loading&&<div className="recon-loading-note" role="status"><span className="recon-spinner" aria-hidden="true"/>正在读取最新对账结果{current.loaded ? '，当前保留显示上次结果。' : '…'}</div>}

      <div className="recon-results-head"><div><h2>{currentMeta.label}</h2><p>{activeView === 'onsite' ? '已确认现场或管理范围内人员属于正常名单，不计入误差。' : activeView === 'issues' ? '这里是来源提示，不等于人数误差；同一员工可能有多项记录。' : '仅展示今天应计人员的真实差异；未来入职不计入，已完成排班移除的离职人员只保留历史档案。'}</p></div>{current.loaded&&<strong>{formatCount(current.total)} {currentMeta.unit}</strong>}</div>
      {!current.loaded
        ? current.error
          ? null
          : <div className="recon-initial-placeholder"><span/><span/><span/></div>
        : current.rows.length
          ? <Rows rows={current.rows}/>
          : <div className="recon-empty">{currentMeta.empty}</div>}

      {current.loaded&&<Pagination
        page={current.page}
        pages={current.pages}
        total={current.total}
        pageSize={current.pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        loading={current.loading}
        onPage={nextPage => load({ view:activeView, page:nextPage, size:current.pageSize, search:appliedSearch })}
        onPageSize={nextSize => {
          setPageSize(nextSize)
          void load({ view:activeView, page:1, size:nextSize, search:appliedSearch })
        }}
      />}
    </section>
  </div>
}
