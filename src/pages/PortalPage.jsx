import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { EmployeeConnectivityPanel } from '../components/ConnectivityRecords'
import { StaffPayrollWorkspace } from './StaffPayrollPage'
import { useStaffLocale } from '../lib/staffI18n'

const inactiveStatuses = ['left', 'resigned', 'inactive', 'suspended', 'terminated', '离职', '停用']
const text = v => String(v ?? '').trim()

const currentStaffShift = (profile = {}, schedule = {}, fallback) => {
  const liveShift = text(
    profile.current_shift
    || profile.schedule_shift
    || profile.schedule_shift_name
    || schedule.current_shift
    || schedule.shift_name
    || schedule.shift,
  )
  if (liveShift) return liveShift
  return text(profile.shift_name) || fallback
}

const staffPaymentMode = payment => {
  const descriptor = text(`${text(payment?.payment_mode)} ${text(payment?.transfer_using)}`).toLowerCase()
  if (/(usdt|trc\s*-?20|erc\s*-?20|crypto|虚拟币|泰达币)/i.test(descriptor)) return 'usdt'
  if (descriptor) return 'bank_wallet'
  if (!payment?.bank_account_masked && payment?.usdt_address_masked) return 'usdt'
  return 'bank_wallet'
}

function isActive(row) {
  return !inactiveStatuses.includes(text(row?.status).toLowerCase())
}

function groupCount(rows, getter) {
  const map = new Map()
  rows.forEach(row => {
    const name = getter(row) || '未设置'
    map.set(name, (map.get(name) || 0) + 1)
  })
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

export const AdminHome = () => {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data, error } = await supabase.functions.invoke('admin-accounts', {
        body: { action: 'dashboard' },
      })
      if (!alive) return
      if (error || data?.error) setError(data?.error || error?.message || '读取失败')
      else setData(data)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [])

  const view = useMemo(() => {
    const employees = data?.employees || []
    const active = employees.filter(isActive)
    const accountSummary = data?.account_summary || null
    const accounts = accountSummary?.can_view_staff_accounts ? accountSummary : null
    const today = dashboardToday()
    const thirtyDaysAgo = dashboardAddDays(today, -29)
    const hires30 = employees.filter(e => dateOnly(e.hire_date) >= thirtyDaysAgo && dateOnly(e.hire_date) <= today)
    const resignations30 = employees.filter(e => dateOnly(e.resign_date) >= thirtyDaysAgo && dateOnly(e.resign_date) <= today)
    const completeProfiles = active.filter(e => [
      e.hire_date,
      e.country || e.nationality,
      e.employment_type,
      e?.teams?.name,
      e?.positions?.name,
    ].every(value => text(value)))
    const recentHires = active
      .filter(e => e.hire_date)
      .sort((a,b) => text(b.hire_date).localeCompare(text(a.hire_date)))
      .slice(0,6)
    const movement = dashboardMonths(today).map(month => ({
      ...month,
      hires: employees.filter(e => dateOnly(e.hire_date).startsWith(month.key)).length,
      resignations: employees.filter(e => dateOnly(e.resign_date).startsWith(month.key)).length,
    }))

    return {
      total: employees.length,
      active: active.length,
      teams: groupCount(active, e => e?.teams?.name),
      positions: groupCount(active, e => e?.positions?.name),
      types: groupCount(active, e => e?.employment_type),
      countries: groupCount(active, e => e?.country || e?.nationality),
      hires30: hires30.length,
      resignations30: resignations30.length,
      profileCompletion: active.length ? Math.round(completeProfiles.length / active.length * 100) : 0,
      accounts,
      accountSummary,
      canViewEmployees: Boolean(data?.dashboard_access?.employee_metrics),
      movement,
      recentHires,
    }
  }, [data])

  return (
    <div className="content-page dashboard-page pro-dashboard">
      <div className="dashboard-head dashboard-head-pro">
        <div>
          <div className="dashboard-kicker">MANAGEMENT OVERVIEW</div>
          <h1>综合 Dashboard</h1>
        </div>
        <div className="dashboard-date">
          {new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date())}
        </div>
      </div>

      {error && <div className="page-error">{error}</div>}

      {!loading && !data ? <DashboardLoadUnavailable /> : !loading && !view.canViewEmployees ? <DashboardAccessLimited summary={view.accountSummary} access={data.dashboard_access} /> : <>
      <div className="kpi-grid kpi-grid-pro dashboard-kpi-grid">
        <Kpi label="在职员工" value={loading ? '—' : view.active} hint={`范围内共 ${view.total} 笔员工资料`} icon="人" />
        <Kpi label="团队总数" value={loading ? '—' : view.teams.length} hint="按当前管理范围统计" icon="组" tone="violet" />
        <Kpi label="近 30 天入职" value={loading ? '—' : view.hires30} hint="取员工主档入职日期" icon="入" tone="green" />
        <Kpi label="近 30 天离职" value={loading ? '—' : view.resignations30} hint="取员工主档离职日期" icon="离" tone="orange" />
        <Kpi label="资料完整率" value={loading ? '—' : `${view.profileCompletion}%`} hint="日期、国家、类型、团队、岗位" icon="档" tone="cyan" />
        {view.accounts
          ? <Kpi label="员工账号覆盖" value={loading ? '—' : `${view.accounts.staff_accounts}/${view.accounts.active_staff_scope}`} hint={`待开通 ${view.accounts.pending_staff_accounts} 个`} icon="账" tone="indigo" />
          : <Kpi label="岗位种类" value={loading ? '—' : view.positions.length} hint="当前员工主档岗位" icon="岗" tone="indigo" />}
      </div>

      <div className="dashboard-grid dashboard-grid-pro">
        <DashboardCard title="近 6 个月人员变化" meta="员工主档日期" className="dashboard-span-8 dashboard-trend-card">
          <MovementChart rows={view.movement} />
        </DashboardCard>

        <DashboardCard title="员工类型构成" meta="在职员工" className="dashboard-span-4">
          <DonutChart rows={view.types} total={view.active} />
        </DashboardCard>

        <DashboardCard title="团队人数排名" meta="TOP 8" className="dashboard-span-6">
          <BarList rows={view.teams} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="岗位分布" meta="TOP 8" className="dashboard-span-6">
          <BarList rows={view.positions} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="最近入职" meta="最新 6 人" className="dashboard-span-8">
          {view.recentHires.length ? (
            <div className="recent-list">
              {view.recentHires.map(e => (
                <div className="recent-row" key={e.id}>
                  <div><strong>{e.full_name}</strong><span>{e.employee_no}</span></div>
                  <div><span>{e?.teams?.name || '未匹配团队'}</span><b>{text(e.hire_date).slice(0,10)}</b></div>
                </div>
              ))}
            </div>
          ) : <div className="empty-state compact">暂无日期资料</div>}
        </DashboardCard>

        {view.accounts ? <DashboardCard title="账号开通情况" meta="权限范围内" className="dashboard-span-4">
          <AccountCoverage summary={view.accounts} active={view.accounts.active_staff_scope} />
        </DashboardCard> : <DashboardCard title="国家 / 国籍分布" meta="TOP 8" className="dashboard-span-4">
          <BarList rows={view.countries} total={view.active || 1} />
        </DashboardCard>}
      </div>
      </>}
    </div>
  )
}

function DashboardLoadUnavailable() {
  return <DashboardCard title="首页数据暂不可用" meta="未显示估算值" className="dashboard-access-card">
    <div className="dashboard-access-copy"><span>!</span><div><strong>没有可安全展示的实时结果</strong><p>请稍后重新打开首页。读取失败时系统不会用 0 或示例数字代替真实员工及账号数据。</p></div></div>
  </DashboardCard>
}

function DashboardAccessLimited({ summary, access }) {
  const hasAccountMetrics = access?.staff_account_metrics || access?.backend_account_metrics
  return <div className="dashboard-limited">
    {hasAccountMetrics && <div className="kpi-grid kpi-grid-pro dashboard-kpi-grid dashboard-limited-kpis">
      {access?.staff_account_metrics && <Kpi label="范围内在职员工" value={Number(summary?.active_staff_scope || 0)} hint="账号覆盖率服务端分母" icon="人" />}
      {access?.staff_account_metrics && <Kpi label="已开通员工账号" value={Number(summary?.staff_accounts || 0)} hint="有效员工前端账号" icon="账" tone="green" />}
      {access?.staff_account_metrics && <Kpi label="待开通员工账号" value={Number(summary?.pending_staff_accounts || 0)} hint="范围内在职员工" icon="待" tone="orange" />}
      {access?.backend_account_metrics && <Kpi label="有效后台账号" value={Number(summary?.backend_accounts || 0)} hint="当前管理范围" icon="管" tone="violet" />}
    </div>}
    <DashboardCard title="数据权限说明" meta="按角色授权" className="dashboard-access-card">
      <div className="dashboard-access-copy"><span>权</span><div><strong>当前角色未获员工数据查看权限</strong><p>首页不会用 0 模拟员工总数或人员分布。勾选“查看员工（employee.view）”后，这里会显示范围内的实时员工、团队、岗位及人员变化数据。</p></div></div>
    </DashboardCard>
  </div>
}

function Kpi({ label, value, hint, tone, icon }) {
  return (
    <div className={`kpi-card kpi-card-pro ${tone ? `kpi-${tone}` : ''}`}>
      <div className="kpi-icon" aria-hidden="true">{icon}</div>
      <div className="kpi-card-copy"><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>
    </div>
  )
}

function DashboardCard({ title, meta, children, className = '' }) {
  return (
    <section className={`dashboard-card dashboard-card-pro ${className}`}>
      <div className="card-head"><h2>{title}</h2><span>{meta}</span></div>
      {children}
    </section>
  )
}

function BarList({ rows, total }) {
  if (!rows?.length) return <div className="empty-state compact">暂无数据</div>
  return (
    <div className="bar-list">
      {rows.slice(0,8).map(row => (
        <div className="bar-row" key={row.name}>
          <div className="bar-meta"><span>{row.name}</span><strong>{row.count}</strong></div>
          <div className="bar-track"><div className="bar-fill" style={{ width:`${Math.max(3, Math.round(row.count/total*100))}%` }} /></div>
        </div>
      ))}
    </div>
  )
}

const dashboardToday = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

const dashboardAddDays = (value, days) => {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const dateOnly = value => /^\d{4}-\d{2}-\d{2}/.test(text(value)) ? text(value).slice(0, 10) : ''

const dashboardMonths = today => {
  const current = new Date(`${today.slice(0, 7)}-01T12:00:00Z`)
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(current)
    date.setUTCMonth(date.getUTCMonth() - (5 - index))
    return {
      key: date.toISOString().slice(0, 7),
      label: `${date.getUTCMonth() + 1}月`,
    }
  })
}

function MovementChart({ rows }) {
  const width = 680
  const height = 205
  const padding = { top: 18, right: 18, bottom: 36, left: 30 }
  const maxValue = Math.max(1, ...(rows || []).flatMap(row => [Number(row.hires || 0), Number(row.resignations || 0)]))
  const x = index => padding.left + index * ((width - padding.left - padding.right) / Math.max(1, rows.length - 1))
  const y = value => padding.top + (maxValue - Number(value || 0)) / maxValue * (height - padding.top - padding.bottom)
  const points = key => rows.map((row, index) => `${x(index)},${y(row[key])}`).join(' ')
  const area = key => `${padding.left},${height - padding.bottom} ${points(key)} ${x(rows.length - 1)},${height - padding.bottom}`

  return <div className="movement-chart">
    <div className="movement-legend"><span className="hire">入职</span><span className="resign">离职</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="最近六个月入职及离职人数趋势">
      {[0, .25, .5, .75, 1].map(ratio => <line key={ratio} x1={padding.left} x2={width - padding.right} y1={padding.top + ratio * (height - padding.top - padding.bottom)} y2={padding.top + ratio * (height - padding.top - padding.bottom)} className="chart-grid-line" />)}
      <polygon points={area('hires')} className="chart-area hire" />
      <polyline points={points('hires')} className="chart-line hire" />
      <polyline points={points('resignations')} className="chart-line resign" />
      {rows.map((row, index) => <g key={row.key}>
        <circle cx={x(index)} cy={y(row.hires)} r="4" className="chart-dot hire"><title>{row.label}入职 {row.hires} 人</title></circle>
        <circle cx={x(index)} cy={y(row.resignations)} r="4" className="chart-dot resign"><title>{row.label}离职 {row.resignations} 人</title></circle>
        <text x={x(index)} y={height - 12} textAnchor="middle">{row.label}</text>
      </g>)}
    </svg>
  </div>
}

const dashboardChartColors = ['#3973df', '#7458df', '#22a47a', '#e29b32', '#27a8c7', '#e36579', '#73859e', '#9b6bd2']

function DonutChart({ rows, total }) {
  if (!rows?.length || !total) return <div className="empty-state compact">暂无员工类型资料</div>
  let cursor = 0
  const segments = rows.slice(0, 8).map((row, index) => {
    const start = cursor
    cursor += row.count / total * 100
    return `${dashboardChartColors[index]} ${start}% ${cursor}%`
  })
  return <div className="donut-layout">
    <div className="donut-chart" style={{ background: `conic-gradient(${segments.join(',')})` }}><div><strong>{total}</strong><span>在职员工</span></div></div>
    <div className="donut-legend">{rows.slice(0, 8).map((row, index) => <div key={row.name}><i style={{ background: dashboardChartColors[index] }} /><span title={row.name}>{row.name}</span><strong>{row.count}</strong></div>)}</div>
  </div>
}

function AccountCoverage({ summary, active }) {
  const opened = Number(summary?.staff_accounts || 0)
  const pending = Number(summary?.pending_staff_accounts || 0)
  const rate = active ? Math.min(100, Math.round(opened / active * 100)) : 0
  return (
    <div className="account-coverage">
      <div className="coverage-ring" style={{ '--coverage': `${rate * 3.6}deg` }}><div><strong>{rate}%</strong><span>开通率</span></div></div>
      <div className="coverage-stats">
        <div><span>已开通员工账号</span><strong>{opened}</strong></div>
        <div><span>待开通员工账号</span><strong>{pending}</strong></div>
        <div><span>有效后台账号</span><strong>{Number(summary?.backend_accounts || 0)}</strong></div>
      </div>
    </div>
  )
}

const staffTenure = (date, t) => {
  if (!date) return '—'
  const start = new Date(`${date}T00:00:00`)
  const days = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000))
  const years = Math.floor(days / 365)
  const months = Math.floor((days % 365) / 30)
  const rest = days - years * 365 - months * 30
  return `${years ? t('tenure.years', '{years}y ', { years }) : ''}${t('tenure.duration', '{months}m {days}d · {total} days', { months, days: rest, total: days })}`
}

const staffDate = value => value ? String(value).slice(0, 10) : '—'
const staffMonthValue = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}`
}
const localeCode = locale => ({ zh: 'zh-CN', en: 'en-US', vi: 'vi-VN', id: 'id-ID' }[locale] || 'en-US')
const staffDateTime = (value, locale) => value ? new Date(value).toLocaleString(localeCode(locale), { hour12: false }) : '—'
const staffExamBreakdown = (row, t) => {
  if (row?.source_system === 'legacy' && !row?.answer_detail_available) {
    return row?.percentage == null ? t('exam.detailWaiting', 'Per-question detail pending sync') : t('exam.totalOnly', 'Final score saved · per-question detail not synced')
  }
  const answered = Number(row?.answer_detail_count || 0)
  const total = Number(row?.total_question_count || 0)
  const prefix = row?.source_system === 'legacy' && total
    ? t('exam.breakdownAnswered', 'Answered {answered}/{total} · Unanswered {unanswered} · ', { answered, total, unanswered: Number(row?.unanswered_count || Math.max(total - answered, 0)) })
    : ''
  return `${prefix}${t('exam.breakdown', 'Correct {correct} · Partial {partial} · Wrong {wrong} · Pending {pending}', {
    correct: row?.correct_count || 0,
    partial: row?.partial_count || 0,
    wrong: row?.wrong_count || 0,
    pending: row?.pending_count || 0,
  })}`
}

export const StaffHome = () => {
  const { locale, t, adoptCountry } = useStaffLocale()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activity, setActivity] = useState({ loading: true, error: '', data: null })
  const [selfAttendance, setSelfAttendance] = useState({ loading: true, error: '', data: null })
  const [errorHistory, setErrorHistory] = useState({ rows: [], total: 0, page: 1, pages: 1 })
  const [errorPage, setErrorPage] = useState(1)
  const [errorsLoading, setErrorsLoading] = useState(false)
  const [revealed, setRevealed] = useState({})
  const [revealLoading, setRevealLoading] = useState('')
  const [activeSection, setActiveSection] = useState('info')
  const [examDetail, setExamDetail] = useState(null)
  const [examDetailLoading, setExamDetailLoading] = useState(false)
  const [examDetailError, setExamDetailError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    setActivity(current => ({ ...current, loading: true, error: '' }))
    setSelfAttendance(current => ({ ...current, loading: true, error: '' }))
    const [
      { data: result, error: loadError },
      { data: activityResult, error: activityError },
      { data: attendanceResult, error: attendanceError },
    ] = await Promise.all([
      supabase.rpc('staff_portal_home'),
      supabase.rpc('staff_activity_home'),
      supabase.rpc('staff_attendance_home', { p_month: staffMonthValue() }),
    ])
    if (loadError) setError(loadError.message || t('portal.profileLoadFailed', 'Failed to load profile'))
    else setData(result)
    setActivity(activityError
      ? { loading: false, error: activityError.message || t('portal.activityLoadFailed', 'Failed to load attendance and connectivity records'), data: null }
      : { loading: false, error: '', data: activityResult || null })
    setSelfAttendance(attendanceError
      ? { loading: false, error: attendanceError.message || t('portal.activityLoadFailed', 'Failed to load attendance records'), data: null }
      : { loading: false, error: '', data: attendanceResult || null })
    setLoading(false)
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    const country = data?.profile?.country || data?.profile?.nationality
    adoptCountry(country)
  }, [data?.profile?.country, data?.profile?.nationality, adoptCountry])
  useEffect(() => {
    if (activeSection !== 'errors') return undefined
    let alive = true
    ;(async () => {
      setErrorsLoading(true)
      const { data: result, error: loadError } = await supabase.rpc('staff_portal_errors', { p_page: errorPage, p_page_size: 20 })
      if (!alive) return
      if (loadError) setError(loadError.message || t('portal.errorHistoryLoadFailed', 'Failed to load error records'))
      else setErrorHistory(result || { rows: [], total: 0, page: 1, pages: 1 })
      setErrorsLoading(false)
    })()
    return () => { alive = false }
  }, [errorPage, activeSection, t])

  if (loading) return <div className="staff-portal-page"><div className="staff-portal-loading">{t('portal.loadingProfile', 'Loading profile…')}</div></div>

  const p = data?.profile || {}
  const pay = data?.payment || {}
  const summary = data?.error_summary || {}
  const exam = data?.exam_summary || {}
  const errors = errorHistory?.rows || []
  const attendance = selfAttendance.data || {}
  const connectivity = activity.data?.connectivity || {}
  const shiftDisplay = currentStaffShift(p, data?.schedule || data?.current_schedule || {}, t('portal.shiftUnset', 'Shift not set'))
  const paymentMode = staffPaymentMode(pay)
  const toggleSensitive = async field => {
    if (revealed[field]) {
      setRevealed(current => ({ ...current, [field]: '' }))
      return
    }
    setRevealLoading(field)
    setError('')
    const { data: value, error: revealError } = await supabase.rpc('staff_portal_reveal_payment', { p_field: field })
    if (revealError) setError(revealError.message || t('portal.sensitiveLoadFailed', 'Failed to load protected information'))
    else setRevealed(current => ({ ...current, [field]: value || '—' }))
    setRevealLoading('')
  }
  const fields = [
    [t('profile.employeeId', 'Employee ID'), p.employee_no],
    [t('profile.country', 'Country'), p.country || p.nationality],
    [t('profile.employmentType', 'Employee type'), p.employment_type],
    [t('profile.status', 'Status'), p.status === 'active' ? t('profile.active', 'Active') : p.status],
    [t('profile.hireDate', 'Hire date'), staffDate(p.hire_date)],
    [t('profile.tenure', 'Tenure'), staffTenure(p.hire_date, t)],
    [t('profile.team', 'Team'), p.team_name],
    [t('profile.group', 'Group'), p.group_name],
    [t('profile.position', 'Position'), p.position_name],
    [t('profile.shift', 'Shift'), shiftDisplay],
    [t('profile.leader', 'Manager / team leader'), p.person_in_charge || p.leader_name],
    [t('profile.trainer', 'Trainer'), p.online_trainer || p.trainer_name],
    [t('profile.platform', 'Platform'), p.platform_scope],
    [t('profile.workContent', 'Work scope'), p.work_content],
  ]
  const examRows = data?.exam_history || []
  const openExam = async row => {
    setExamDetail({ session: row, answers: [] })
    setExamDetailLoading(true)
    setExamDetailError('')
    const { data: result, error: detailError } = await supabase.rpc('staff_exam_result_detail', { p_session_id: row.id })
    if (detailError) setExamDetailError(detailError.message || t('portal.examDetailLoadFailed', 'Failed to load exam detail'))
    else setExamDetail(result)
    setExamDetailLoading(false)
  }

  const tabs = [
    ['info', t('tab.info', 'Personal information')],
    ['errors', t('tab.errors', 'Error records')],
    ['exams', t('tab.exams', 'Exam results')],
    ['attendance', t('tab.attendance', 'Attendance')],
    ['connectivity', t('tab.connectivity', 'Power / internet records')],
    ['payroll', t('tab.payroll', 'Payslips')],
  ]

  return <div className="staff-portal-page">
    <header className="staff-portal-hero">
      <div className="staff-avatar">{(p.full_name || 'W').slice(0, 1).toUpperCase()}</div>
      <div><small>{t('portal.workspace', 'MY WORKSPACE')}</small><h1>{p.full_name || t('portal.myHome', 'My workspace')}</h1><p>{p.employee_no || '—'} · {p.team_name || t('portal.teamUnset', 'Team not set')} · {p.position_name || t('portal.positionUnset', 'Position not set')}</p><div className="staff-hero-tags"><span>{shiftDisplay}</span><span>{staffTenure(p.hire_date, t)}</span></div></div>
      <button onClick={load}>↻ {t('portal.refresh', 'Refresh')}</button>
    </header>
    {error && <div className="exam-error">{error}<button onClick={() => setError('')}>×</button></div>}
    <section className="staff-dashboard-metrics">
      <div><span>{t('portal.monthErrors', 'Errors this month')}</span><strong>{summary.month_error_count || 0}</strong><small>{t('portal.totalErrors', 'Total {count}', { count: summary.total_error_count || 0 })}</small></div>
      <div><span>{t('portal.examRecords', 'Exam records')}</span><strong>{exam.total || 0}</strong><small>{t('portal.passedTimes', 'Passed {count} times', { count: exam.passed || 0 })}</small></div>
      <div><span>{t('portal.averageScore', 'Average score')}</span><strong>{exam.average || 0}%</strong><small>{t('portal.gradedTimes', 'Graded {count} times', { count: exam.completed || 0 })}</small></div>
      <div><span>{t('portal.monthAbsent', 'Absent this month')}</span><strong>{selfAttendance.loading ? '—' : attendance.summary?.month_absent || 0}</strong><small>{t('portal.attendanceRecords', 'Attendance records')}</small></div>
      <div><span>{t('portal.monthLeave', 'Leave this month')}</span><strong>{selfAttendance.loading ? '—' : attendance.summary?.month_leave || 0}</strong><small>{t('portal.leaveDays', 'Leave / rest days')}</small></div>
      <div><span>{t('portal.connectivity', 'Power / internet')}</span><strong>{activity.loading ? '—' : connectivity.total || 0}</strong><small>{t('portal.powerInternetCounts', 'Power {power} · Internet {internet}', { power: connectivity.power || 0, internet: connectivity.internet || 0 })}</small></div>
    </section>
    <nav className="staff-profile-tabs">{tabs.map(([key, label]) => <button key={key} className={activeSection === key ? 'active' : ''} onClick={() => setActiveSection(key)}>{label}</button>)}</nav>
    {activeSection === 'info' && <div className="staff-portal-columns"><div className="staff-profile-stack">
      <section className="staff-profile-panel"><header><div><small>{t('decor.profile', 'PERSONAL PROFILE')}</small><h2>{t('profile.title', 'Personal information')}</h2></div><span>{t('profile.private', 'Only you can view')}</span></header><div className="staff-profile-fields">{fields.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value || '—'}</strong></div>)}</div></section>
      <section className="staff-payment-panel"><header><div><small>{t('decor.payment', 'PAYMENT & CONTACT')}</small><h2>{t('payment.title', 'Payment & contact')}</h2></div><span>🔒 {t('payment.protected', 'Safely hidden')}</span></header><div className="staff-payment-grid">
        <div><span>{t('payment.method', 'Payment method')}</span><strong>{pay.transfer_using || pay.payment_mode || '—'}</strong></div><div><span>{t('payment.accountName', 'Account name')}</span><strong>{pay.account_name || '—'}</strong></div>
        {paymentMode === 'bank_wallet' && <div className="staff-sensitive-row"><span>{t('payment.bankAccount', 'Bank / wallet account')}</span><strong>{revealed.bank_account || pay.bank_account_masked || '—'}</strong>{pay.bank_account_masked && <button onClick={() => toggleSensitive('bank_account')} disabled={revealLoading === 'bank_account'}>{revealLoading === 'bank_account' ? t('payment.reading', 'Loading') : revealed.bank_account ? t('common.hide', 'Hide') : t('common.view', 'View')}</button>}</div>}
        {paymentMode === 'usdt' && <div className="staff-sensitive-row"><span>{t('payment.usdt', 'USDT address')}</span><strong>{revealed.usdt_address || pay.usdt_address_masked || '—'}</strong>{pay.usdt_address_masked && <button onClick={() => toggleSensitive('usdt_address')} disabled={revealLoading === 'usdt_address'}>{revealLoading === 'usdt_address' ? t('payment.reading', 'Loading') : revealed.usdt_address ? t('common.hide', 'Hide') : t('common.view', 'View')}</button>}</div>}
        <div><span>{t('payment.phone', 'Phone')}</span><strong>{pay.contact_phone || '—'}</strong></div><div><span>WhatsApp</span><strong>{pay.whatsapp_number || '—'}</strong></div><div><span>Facebook</span><strong>{pay.facebook || '—'}</strong></div><div><span>{t('payment.address', 'Contact address')}</span><strong>{pay.employee_address || '—'}</strong></div>
      </div></section>
    </div><section className="staff-quick-panel"><header><small>{t('decor.quick', 'QUICK ACCESS')}</small><h2>{t('quick.title', 'Quick access')}</h2></header><Link to="/staff/exams"><b>{t('quick.takeExam', 'Take an exam')}</b><span>{t('quick.chooseExam', 'Choose an exam →')}</span></Link></section></div>}
    {activeSection === 'errors' && <section className="staff-own-errors"><header><div><small>{t('decor.errors', 'ERROR RECORDS')}</small><h2>{t('errors.title', 'Error records')}</h2></div><span>{t('common.totalItems', 'Total {count}', { count: errorHistory.total || 0 })}</span></header>{errorsLoading ? <div className="staff-history-empty">{t('errors.loading', 'Loading error records…')}</div> : errors.length ? <><div className="staff-error-list">{errors.map((row, index) => <article key={row.record_key || `${row.qc_date}-${index}`}><div className="staff-error-date"><b>{staffDate(row.qc_date)}</b><span>{row.error_type || t('errors.uncategorized', 'Uncategorized error')}</span></div><div><small>{t('errors.details', 'What happened')}</small><p>{row.error_note || '—'}</p></div><div><small>{t('errors.correctAction', 'Correct action')}</small><p>{row.correct_action || '—'}</p></div><span className="staff-error-score">{row.score ? t('common.points', '{count} points', { count: row.score }) : '—'}</span></article>)}</div><div className="staff-error-pager"><button disabled={errorPage <= 1} onClick={() => setErrorPage(value => Math.max(1, value - 1))}>{t('common.previous', 'Previous')}</button><span>{t('common.page', 'Page {page} / {pages}', { page: errorHistory.page || 1, pages: errorHistory.pages || 1 })}</span><button disabled={errorPage >= (errorHistory.pages || 1)} onClick={() => setErrorPage(value => value + 1)}>{t('common.next', 'Next')}</button></div></> : <div className="staff-history-empty">{t('errors.none', 'No error records linked to your employee ID.')}</div>}</section>}
    {activeSection === 'exams' && <section className="staff-portal-exams"><header><div><small>{t('decor.exams', 'EXAM RESULTS')}</small><h2>{t('exams.title', 'Exam results')}</h2></div><span>{t('exams.sourceSummary', 'New system {current} · Legacy {legacy}', { current: exam.current || 0, legacy: exam.legacy || 0 })}</span></header>{examRows.length ? <div className="staff-portal-exam-list">{examRows.map(row => <article key={`${row.source_system}-${row.id}`}><div><span className={`exam-source-badge ${row.source_system === 'legacy' ? 'legacy' : 'current'}`}>{row.source_label || t('exams.current', 'New system')}</span><strong>{row.title}</strong><small>{t('exams.attempt', 'Attempt {attempt} · {date}', { attempt: row.attempt_no, date: staffDateTime(row.submitted_at || row.started_at, locale) })}</small></div><div><b>{row.percentage == null ? t('exams.pending', 'Pending grading') : `${Number(row.earned_score || 0).toLocaleString(localeCode(locale))}/${Number(row.total_score || 100).toLocaleString(localeCode(locale))} · ${Number(row.percentage).toFixed(1)}%`}</b><small>{staffExamBreakdown(row, t)}</small></div><button onClick={() => openExam(row)}>{t('exams.viewPaper', 'View answers')}</button></article>)}</div> : <div className="staff-history-empty">{t('exams.none', 'No exam records yet.')}</div>}</section>}
    {activeSection === 'attendance' && <StaffAttendancePanel data={attendance} loading={selfAttendance.loading} error={selfAttendance.error} profile={p} t={t} locale={locale} />}
    {activeSection === 'connectivity' && <EmployeeConnectivityPanel data={connectivity} loading={activity.loading} error={activity.error} t={t} />}
    {activeSection === 'payroll' && <StaffPayrollWorkspace embedded />}
    {examDetail && <StaffPortalExamModal detail={examDetail} loading={examDetailLoading} error={examDetailError} onClose={() => setExamDetail(null)} t={t} locale={locale} />}
  </div>
}

const staffAttendanceKinds = [
  ['public_holiday', 'attendance.statusCode.publicHoliday', 'R', 'attendance.status.publicHoliday', 'Rest day'],
  ['home_leave', 'attendance.statusCode.home', 'H', 'attendance.status.home', 'Go home'],
  ['leave', 'attendance.statusCode.leave', 'L', 'attendance.status.leave', 'Leave'],
  ['half_day', 'attendance.statusCode.halfDay', '½', 'attendance.status.halfDay', 'Half day'],
  ['absence', 'attendance.statusCode.absence', 'A', 'attendance.status.absence', 'Absent'],
  ['resignation', 'attendance.statusCode.resignation', 'X', 'attendance.status.resignation', 'Resigned'],
]

const staffAttendanceKind = value => {
  const normalized = String(value || '').trim().toLowerCase()
  const kind = normalized === 'absent' ? 'absence' : normalized
  return staffAttendanceKinds.find(([candidate]) => candidate === kind)
}
const staffAttendanceCount = (value, locale) => Number(value || 0).toLocaleString(localeCode(locale), { maximumFractionDigits: 1 })
const staffAttendanceMonthLabel = (month, locale) => {
  const [year, monthNumber] = String(month || '').split('-').map(Number)
  if (!year || !monthNumber) return month || '—'
  return new Intl.DateTimeFormat(localeCode(locale), { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, monthNumber - 1, 1)))
}

function StaffAttendancePanel({ data, loading, error, profile, t, locale }) {
  const [month, setMonth] = useState(data?.month || staffMonthValue())
  const [view, setView] = useState({ data: data || null, loading, error: error || '' })
  const [selectedDay, setSelectedDay] = useState(null)

  useEffect(() => {
    let alive = true
    if (data?.month === month) {
      setView({ data, loading, error: error || '' })
      return () => { alive = false }
    }
    ;(async () => {
      setView(current => ({ ...current, loading: true, error: '' }))
      const { data: result, error: loadError } = await supabase.rpc('staff_attendance_home', { p_month: month })
      if (!alive) return
      setView(loadError
        ? { data: null, loading: false, error: loadError.message || t('portal.activityLoadFailed', 'Failed to load attendance records') }
        : { data: result || null, loading: false, error: '' })
    })()
    return () => { alive = false }
  }, [month, data, loading, error, t])

  const result = view.data || {}
  const employee = result.employee || {}
  const monthSummary = result.month_summary || {}
  const allTimeSummary = result.all_time_summary || {}
  const days = result.days || {}
  const daysInMonth = Number(result.days_in_month || new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate())
  const dayNumbers = Array.from({ length: daysInMonth }, (_, index) => index + 1)
  const fullName = employee.full_name || profile?.full_name || '—'
  const employeeNo = employee.employee_no || profile?.employee_no || '—'
  const hireDate = staffDate(employee.hire_date || profile?.hire_date)
  const monthLabel = staffAttendanceMonthLabel(month, locale)
  const primaryRecord = records => Array.isArray(records) ? records.find(record => staffAttendanceKind(record?.event_kind)) : null

  return <section className="staff-activity-panel staff-self-attendance">
    <header className="staff-self-attendance-head"><div><small>{t('decor.attendance', 'ATTENDANCE')}</small><h2>{t('attendance.selfTitle', 'My attendance')}</h2></div><label><span>{t('attendance.viewMonth', 'View month')}</span><input type="month" value={month} onChange={event => { setSelectedDay(null); setMonth(event.target.value || staffMonthValue()) }} /></label></header>
    <div className="staff-self-attendance-legend">{staffAttendanceKinds.map(([kind, codeKey, codeFallback, labelKey, labelFallback]) => <span className={kind} key={kind}><i>{t(codeKey, codeFallback)}</i>{t(labelKey, labelFallback)}</span>)}</div>
    {view.error && <div className="staff-self-attendance-error">{view.error}</div>}
    <div className="staff-self-summary-groups">
      <StaffAttendanceSummary title={t('attendance.monthSummary', '{month} summary', { month: monthLabel })} summary={monthSummary} t={t} locale={locale} />
      <StaffAttendanceSummary title={t('attendance.cumulativeSummary', 'Cumulative summary (through today)')} summary={allTimeSummary} t={t} locale={locale} />
    </div>
    {view.loading && !view.data ? <div className="staff-history-empty">{t('attendance.loading', 'Loading attendance…')}</div> : <div className="staff-self-attendance-scroll">
      <table><thead><tr><th className="staff-self-identity-head">{t('attendance.myInformation', 'My information')}</th>{dayNumbers.map(day => <th key={day}>{day}</th>)}<th className="staff-self-total-head">{t('attendance.monthTotal', 'Monthly total')}</th></tr></thead><tbody><tr><td className="staff-self-identity"><strong title={fullName}>{fullName}</strong><span>{employeeNo} · {t('attendance.hireDateValue', 'Hired {date}', { date: hireDate })}</span></td>{dayNumbers.map(day => {
        const records = Array.isArray(days[String(day)]) ? days[String(day)] : []
        const record = primaryRecord(records)
        const meta = staffAttendanceKind(record?.event_kind)
        const kind = meta?.[0]
        const visibleRecords = records.filter(item => staffAttendanceKind(item?.event_kind))
        const label = meta ? t(meta[3], meta[4]) : ''
        return <td className="staff-self-day" key={day}>{record && meta ? <button type="button" className={kind} title={`${month}-${String(day).padStart(2, '0')} · ${label} · ${t('attendance.viewDetail', 'View details')}`} onClick={() => setSelectedDay({ date: `${month}-${String(day).padStart(2, '0')}`, records: visibleRecords })}>{t(meta[1], meta[2])}{visibleRecords.length > 1 ? <sup>+{visibleRecords.length - 1}</sup> : null}</button> : <i>—</i>}</td>
      })}<td className="staff-self-total"><strong>{staffAttendanceCount(monthSummary.total_days, locale)}</strong><span>{t('attendance.days', 'days')}</span></td></tr></tbody></table>
      {view.loading && <div className="staff-self-attendance-updating">{t('attendance.updating', 'Updating attendance…')}</div>}
    </div>}
    {selectedDay && <StaffAttendanceDayModal day={selectedDay} employee={{ full_name: fullName, employee_no: employeeNo }} t={t} onClose={() => setSelectedDay(null)} />}
  </section>
}

function StaffAttendanceSummary({ title, summary, t, locale }) {
  return <section className="staff-self-summary"><header><h3>{title}</h3><strong>{staffAttendanceCount(summary?.total_days, locale)}<small>{t('attendance.days', 'days')}</small></strong></header><div>{staffAttendanceKinds.map(([kind, codeKey, codeFallback, labelKey, labelFallback]) => <span className={kind} key={kind}><i>{t(codeKey, codeFallback)}</i><small>{t(labelKey, labelFallback)}</small><b>{staffAttendanceCount(summary?.[kind], locale)}</b></span>)}</div></section>
}

function StaffAttendanceDayModal({ day, employee, t, onClose }) {
  return <div className="modal-mask staff-self-day-mask" onMouseDown={onClose}><div className="staff-self-day-modal" role="dialog" aria-modal="true" aria-labelledby="staff-attendance-day-title" onMouseDown={event => event.stopPropagation()}><header><div><small>{t('attendance.detailKicker', 'MY ATTENDANCE DETAIL')}</small><h2 id="staff-attendance-day-title">{day.date} · {t('attendance.dayDetail', 'Attendance details')}</h2><p>{employee.employee_no} · {employee.full_name}</p></div><button type="button" aria-label={t('common.close', 'Close')} onClick={onClose}>×</button></header><div className="staff-self-day-records">{day.records.map((record, index) => { const meta = staffAttendanceKind(record.event_kind); const kind = meta?.[0]; const syntheticResignation = record.synthetic && kind === 'resignation'; return meta ? <article key={record.id || `${kind}-${index}`}><span className={kind}>{t(meta[3], meta[4])}</span><div><small>{t('attendance.reason', 'Reason')}</small><p>{syntheticResignation ? t('attendance.synthetic.resignation', 'Resigned') : record.reason || '—'}</p></div><div><small>{t('attendance.notes', 'Notes')}</small><p>{syntheticResignation ? t('attendance.synthetic.resignationFromDate', 'Automatically marked from the resignation date') : record.note || '—'}</p></div></article> : null })}</div><footer><button type="button" onClick={onClose}>{t('common.close', 'Close')}</button></footer></div></div>
}

function StaffPortalExamModal({ detail, loading, error, onClose, t, locale }) {
  const session = detail?.session || {}
  const answers = detail?.answers || []
  const questionText = question => {
    if (locale === 'zh') return question.question_zh || question.question_en || question.question_vi
    if (locale === 'vi') return question.question_vi || question.question_en || question.question_zh
    return question.question_en || question.question_vi || question.question_zh
  }
  return <div className="exam-modal-backdrop" onMouseDown={onClose}><div className="exam-modal wide staff-result-modal" onMouseDown={event => event.stopPropagation()}><header><div><small>{t('exam.detailTitle', 'MY EXAM RESULT')}</small><h2>{session.title || t('exams.title', 'Exam results')}</h2><p>{session.source_label || t('exams.current', 'New system')} · {t('exams.attempt', 'Attempt {attempt} · {date}', { attempt: session.attempt_no || '—', date: '' }).replace(/\s*·\s*$/, '')}</p></div><button type="button" className="exam-icon-close" aria-label={t('common.close', 'Close')} onClick={onClose}>×</button></header>{loading ? <div className="staff-history-empty">{t('exam.loadingDetail', 'Loading complete answers…')}</div> : error ? <div className="exam-error">{error}</div> : <><div className="staff-result-summary"><div><span>{t('exam.result', 'Result')}</span><strong>{session.percentage == null ? t('exams.pending', 'Pending grading') : `${Number(session.percentage).toFixed(1)}%`}</strong></div><div><span>{t('exam.score', 'Score')}</span><strong>{session.earned_score == null ? '—' : `${session.earned_score}/${session.total_score}`}</strong></div><div><span>{t('exam.completedAt', 'Completed')}</span><strong>{staffDateTime(session.submitted_at, locale)}</strong></div><div><span>{t('exam.answerSummary', 'Answer summary')}</span><strong>{staffExamBreakdown(session, t)}</strong></div></div><div className="staff-result-list">{answers.length ? answers.map((answer, index) => { const question = answer.question || {}; return <article key={question.id || index}><header><b>{index + 1}</b><div><strong>{questionText(question) || t('exam.questionUnavailable', 'Question content unavailable')}</strong><small>{t('exam.questionPoints', 'This question: {count} points', { count: question.points || 0 })}</small></div><span className={`result-chip ${answer.grade_status === 'correct' ? 'pass' : answer.grade_status === 'partial' ? 'partial' : answer.grade_status === 'wrong' ? 'fail' : 'pending'}`}>{answer.awarded_score == null ? t('exams.pending', 'Pending grading') : `${answer.awarded_score}/${question.points || 0} ${t('common.points', '{count} points', { count: '' }).trim().replace(/^\s+/, '')}`}</span></header><div className="staff-result-answer"><b>{t('exam.myAnswer', 'My answer')}</b><p>{answer.answer_text || t('exam.unanswered', '(Unanswered)')}</p></div>{answer.grader_feedback && <div className="staff-result-feedback"><b>{t('exam.feedback', 'Feedback')}</b><p>{answer.grader_feedback}</p></div>}</article> }) : <div className="staff-history-empty">{t('exam.noAnswers', 'Only the final score is available; per-question answers have not been synced.')}</div>}</div></>}<footer><button type="button" className="exam-footer-close" onClick={onClose}>{t('common.close', 'Close')}</button></footer></div></div>
}

export const ComingSoon = ({ title }) => {
  const { t } = useStaffLocale()
  return <div className="content-page"><div className="page-toolbar"><h1>{title}</h1></div><div className="data-card"><div className="empty-state">{t('common.noData', 'No data yet')}</div></div></div>
}
