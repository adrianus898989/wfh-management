import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { EmployeeConnectivityPanel } from '../components/ConnectivityRecords'
import { StaffPayrollWorkspace } from './StaffPayrollPage'
import { useStaffLocale } from '../lib/staffI18n'

const inactiveStatuses = ['left', 'resigned', 'inactive', 'terminated', '离职', '停用']
const text = v => String(v ?? '').trim()

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
        body: { action: 'bootstrap' },
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
    const staffAccounts = data?.employee_accounts || []
    const backendAccounts = data?.backend_accounts || []
    const staffIds = new Set(staffAccounts.map(x => x.employee_id).filter(Boolean))
    const onsite = active.filter(e => ['onsite', '现场人员'].includes(text(e.source_type)) || text(e.employment_type) === '现场人员')
    const needsProfile = active.filter(e => text(e.profile_status).startsWith('needs_'))
    const recentHires = active
      .filter(e => e.hire_date)
      .sort((a,b) => text(b.hire_date).localeCompare(text(a.hire_date)))
      .slice(0,6)

    return {
      total: employees.length,
      active: active.length,
      teams: groupCount(active, e => e?.teams?.name),
      positions: groupCount(active, e => e?.positions?.name),
      types: groupCount(active, e => e?.employment_type),
      countries: groupCount(active, e => e?.country || e?.nationality),
      staffAccounts: staffAccounts.length,
      backendAccounts: backendAccounts.length,
      pendingAccounts: active.filter(e => !staffIds.has(e.id)).length,
      onsite: onsite.length,
      needsProfile: needsProfile.length,
      recentHires,
    }
  }, [data])

  return (
    <div className="content-page dashboard-page pro-dashboard">
      <div className="dashboard-head dashboard-head-pro">
        <div>
          <div className="dashboard-kicker">MANAGEMENT OVERVIEW</div>
          <h1>综合 Dashboard</h1>
          <p className="page-subtitle">员工主档、团队与账号数据已接入；出勤、日报、工资等未接模块保持“—”，不显示假数据。</p>
        </div>
        <div className="dashboard-date">
          {new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date())}
        </div>
      </div>

      {error && <div className="page-error">{error}</div>}

      <div className="quick-actions">
        <Link to="/admin/employees" className="quick-action primary-quick">查看员工档案</Link>
        <Link to="/admin/schedule" className="quick-action">查看排班</Link>
        <Link to="/admin/daily" className="quick-action">每日工作</Link>
        <Link to="/admin/reports" className="quick-action">统计报表</Link>
      </div>

      <div className="kpi-grid kpi-grid-pro">
        <Kpi label="员工总数" value={loading ? '—' : view.total} hint="当前数据库" />
        <Kpi label="在职员工" value={loading ? '—' : view.active} hint="排除离职/停用" />
        <Kpi label="团队数" value={loading ? '—' : view.teams.length} hint="已匹配团队" />
        <Kpi label="现场 / 补录" value={loading ? '—' : view.onsite} hint="来自排班补录" />
        <Kpi label="待补资料" value={loading ? '—' : view.needsProfile} hint="需要人工完善" tone="warn" />
        <Kpi label="员工账号" value={loading ? '—' : view.staffAccounts} hint="已开通 Portal" />
        <Kpi label="待开通账号" value={loading ? '—' : view.pendingAccounts} hint="可生成激活码" />
        <Kpi label="后台账号" value={loading ? '—' : view.backendAccounts} hint="管理端账号" />
      </div>

      <div className="dashboard-grid">
        <DashboardCard title="团队人数分布" meta="TOP 8">
          <BarList rows={view.teams} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="员工类型" meta="当前主档">
          <BarList rows={view.types} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="国家 / 国籍分布" meta="TOP 8">
          <BarList rows={view.countries} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="岗位分布" meta="TOP 8">
          <BarList rows={view.positions} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="今日出勤" meta="等待出勤表接入">
          <CompactStats rows={[
            ['正常', '—'], ['请假', '—'], ['公休', '—'], ['回家', '—'], ['缺席', '—']
          ]} />
        </DashboardCard>

        <DashboardCard title="待处理" meta="后续工作流">
          <CompactStats rows={[
            ['请假审批', '—'], ['日报未提交', '—'], ['待接收交接', '—'], ['资料修改', '—'], ['待发布工资', '—']
          ]} />
        </DashboardCard>

        <DashboardCard title="最近入职" meta="已录入日期">
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

        <DashboardCard title="系统接入状态" meta="当前阶段">
          <CompactStats rows={[
            ['员工主档', loading ? '读取中' : '已接入'],
            ['团队 / 岗位', loading ? '读取中' : '已接入'],
            ['排班关系', '部分已接入'],
            ['出勤 / 请假', '待接入'],
            ['日报 / 交接', '待接入'],
          ]} />
        </DashboardCard>
      </div>
    </div>
  )
}

function Kpi({ label, value, hint, tone }) {
  return (
    <div className={`kpi-card kpi-card-pro ${tone ? `kpi-${tone}` : ''}`}>
      <div className="kpi-label-row"><span>{label}</span><i /></div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  )
}

function DashboardCard({ title, meta, children }) {
  return (
    <section className="dashboard-card dashboard-card-pro">
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

function CompactStats({ rows }) {
  return (
    <div className="compact-stats">
      {rows.map(([label,value]) => (
        <div className="compact-stat" key={label}><span>{label}</span><strong>{value}</strong></div>
      ))}
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
    const [{ data: result, error: loadError }, { data: activityResult, error: activityError }] = await Promise.all([
      supabase.rpc('staff_portal_home'),
      supabase.rpc('staff_activity_home'),
    ])
    if (loadError) setError(loadError.message || t('portal.profileLoadFailed', 'Failed to load profile'))
    else setData(result)
    setActivity(activityError
      ? { loading: false, error: activityError.message || t('portal.activityLoadFailed', 'Failed to load attendance and connectivity records'), data: null }
      : { loading: false, error: '', data: activityResult || null })
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
  const attendance = activity.data?.attendance || {}
  const connectivity = activity.data?.connectivity || {}
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
    [t('profile.shift', 'Shift'), p.shift_name],
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
      <div><small>{t('portal.workspace', 'MY WORKSPACE')}</small><h1>{p.full_name || t('portal.myHome', 'My workspace')}</h1><p>{p.employee_no || '—'} · {p.team_name || t('portal.teamUnset', 'Team not set')} · {p.position_name || t('portal.positionUnset', 'Position not set')}</p><div className="staff-hero-tags"><span>{p.shift_name || t('portal.shiftUnset', 'Shift not set')}</span><span>{staffTenure(p.hire_date, t)}</span></div></div>
      <button onClick={load}>↻ {t('portal.refresh', 'Refresh')}</button>
    </header>
    {error && <div className="exam-error">{error}<button onClick={() => setError('')}>×</button></div>}
    <section className="staff-dashboard-metrics">
      <div><span>{t('portal.monthErrors', 'Errors this month')}</span><strong>{summary.month_error_count || 0}</strong><small>{t('portal.totalErrors', 'Total {count}', { count: summary.total_error_count || 0 })}</small></div>
      <div><span>{t('portal.examRecords', 'Exam records')}</span><strong>{exam.total || 0}</strong><small>{t('portal.passedTimes', 'Passed {count} times', { count: exam.passed || 0 })}</small></div>
      <div><span>{t('portal.averageScore', 'Average score')}</span><strong>{exam.average || 0}%</strong><small>{t('portal.gradedTimes', 'Graded {count} times', { count: exam.completed || 0 })}</small></div>
      <div><span>{t('portal.monthAbsent', 'Absent this month')}</span><strong>{activity.loading ? '—' : attendance.summary?.month_absent || 0}</strong><small>{t('portal.attendanceRecords', 'Attendance records')}</small></div>
      <div><span>{t('portal.monthLeave', 'Leave this month')}</span><strong>{activity.loading ? '—' : attendance.summary?.month_leave || 0}</strong><small>{t('portal.leaveDays', 'Leave / rest days')}</small></div>
      <div><span>{t('portal.connectivity', 'Power / internet')}</span><strong>{activity.loading ? '—' : connectivity.total || 0}</strong><small>{t('portal.powerInternetCounts', 'Power {power} · Internet {internet}', { power: connectivity.power || 0, internet: connectivity.internet || 0 })}</small></div>
    </section>
    <nav className="staff-profile-tabs">{tabs.map(([key, label]) => <button key={key} className={activeSection === key ? 'active' : ''} onClick={() => setActiveSection(key)}>{label}</button>)}</nav>
    {activeSection === 'info' && <div className="staff-portal-columns"><div className="staff-profile-stack">
      <section className="staff-profile-panel"><header><div><small>{t('decor.profile', 'PERSONAL PROFILE')}</small><h2>{t('profile.title', 'Personal information')}</h2></div><span>{t('profile.private', 'Only you can view')}</span></header><div className="staff-profile-fields">{fields.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value || '—'}</strong></div>)}</div></section>
      <section className="staff-payment-panel"><header><div><small>{t('decor.payment', 'PAYMENT & CONTACT')}</small><h2>{t('payment.title', 'Payment & contact')}</h2></div><span>🔒 {t('payment.protected', 'Safely hidden')}</span></header><div className="staff-payment-grid">
        <div><span>{t('payment.method', 'Payment method')}</span><strong>{pay.transfer_using || pay.payment_mode || '—'}</strong></div><div><span>{t('payment.accountName', 'Account name')}</span><strong>{pay.account_name || '—'}</strong></div>
        <div className="staff-sensitive-row"><span>{t('payment.bankAccount', 'Bank / wallet account')}</span><strong>{revealed.bank_account || pay.bank_account_masked || '—'}</strong>{pay.bank_account_masked && <button onClick={() => toggleSensitive('bank_account')} disabled={revealLoading === 'bank_account'}>{revealLoading === 'bank_account' ? t('payment.reading', 'Loading') : revealed.bank_account ? t('common.hide', 'Hide') : t('common.view', 'View')}</button>}</div>
        <div className="staff-sensitive-row"><span>{t('payment.usdt', 'USDT address')}</span><strong>{revealed.usdt_address || pay.usdt_address_masked || '—'}</strong>{pay.usdt_address_masked && <button onClick={() => toggleSensitive('usdt_address')} disabled={revealLoading === 'usdt_address'}>{revealLoading === 'usdt_address' ? t('payment.reading', 'Loading') : revealed.usdt_address ? t('common.hide', 'Hide') : t('common.view', 'View')}</button>}</div>
        <div><span>{t('payment.phone', 'Phone')}</span><strong>{pay.contact_phone || '—'}</strong></div><div><span>WhatsApp</span><strong>{pay.whatsapp_number || '—'}</strong></div><div><span>Facebook</span><strong>{pay.facebook || '—'}</strong></div><div><span>{t('payment.address', 'Contact address')}</span><strong>{pay.employee_address || '—'}</strong></div>
      </div></section>
    </div><section className="staff-quick-panel"><header><small>{t('decor.quick', 'QUICK ACCESS')}</small><h2>{t('quick.title', 'Quick access')}</h2></header><Link to="/staff/exams"><b>{t('quick.takeExam', 'Take an exam')}</b><span>{t('quick.chooseExam', 'Choose an exam →')}</span></Link><Link to="/staff/schedule"><b>{t('quick.schedule', 'Schedule')}</b><span>{t('quick.viewSchedule', 'View my schedule →')}</span></Link><Link to="/staff/attendance"><b>{t('quick.attendance', 'Attendance')}</b><span>{t('quick.viewAttendance', 'View my attendance →')}</span></Link></section></div>}
    {activeSection === 'errors' && <section className="staff-own-errors"><header><div><small>{t('decor.errors', 'ERROR RECORDS')}</small><h2>{t('errors.title', 'Error records')}</h2></div><span>{t('common.totalItems', 'Total {count}', { count: errorHistory.total || 0 })}</span></header>{errorsLoading ? <div className="staff-history-empty">{t('errors.loading', 'Loading error records…')}</div> : errors.length ? <><div className="staff-error-list">{errors.map((row, index) => <article key={row.record_key || `${row.qc_date}-${index}`}><div className="staff-error-date"><b>{staffDate(row.qc_date)}</b><span>{row.error_type || t('errors.uncategorized', 'Uncategorized error')}</span></div><div><small>{t('errors.details', 'What happened')}</small><p>{row.error_note || '—'}</p></div><div><small>{t('errors.correctAction', 'Correct action')}</small><p>{row.correct_action || '—'}</p></div><span className="staff-error-score">{row.score ? t('common.points', '{count} points', { count: row.score }) : '—'}</span></article>)}</div><div className="staff-error-pager"><button disabled={errorPage <= 1} onClick={() => setErrorPage(value => Math.max(1, value - 1))}>{t('common.previous', 'Previous')}</button><span>{t('common.page', 'Page {page} / {pages}', { page: errorHistory.page || 1, pages: errorHistory.pages || 1 })}</span><button disabled={errorPage >= (errorHistory.pages || 1)} onClick={() => setErrorPage(value => value + 1)}>{t('common.next', 'Next')}</button></div></> : <div className="staff-history-empty">{t('errors.none', 'No error records linked to your employee ID.')}</div>}</section>}
    {activeSection === 'exams' && <section className="staff-portal-exams"><header><div><small>{t('decor.exams', 'EXAM RESULTS')}</small><h2>{t('exams.title', 'Exam results')}</h2></div><span>{t('exams.sourceSummary', 'New system {current} · Legacy {legacy}', { current: exam.current || 0, legacy: exam.legacy || 0 })}</span></header>{examRows.length ? <div className="staff-portal-exam-list">{examRows.map(row => <article key={`${row.source_system}-${row.id}`}><div><span className={`exam-source-badge ${row.source_system === 'legacy' ? 'legacy' : 'current'}`}>{row.source_label || t('exams.current', 'New system')}</span><strong>{row.title}</strong><small>{t('exams.attempt', 'Attempt {attempt} · {date}', { attempt: row.attempt_no, date: staffDateTime(row.submitted_at || row.started_at, locale) })}</small></div><div><b>{row.percentage == null ? t('exams.pending', 'Pending grading') : `${Number(row.earned_score || 0).toLocaleString(localeCode(locale))}/${Number(row.total_score || 100).toLocaleString(localeCode(locale))} · ${Number(row.percentage).toFixed(1)}%`}</b><small>{staffExamBreakdown(row, t)}</small></div><button onClick={() => openExam(row)}>{t('exams.viewPaper', 'View answers')}</button></article>)}</div> : <div className="staff-history-empty">{t('exams.none', 'No exam records yet.')}</div>}</section>}
    {activeSection === 'attendance' && <StaffAttendancePanel data={attendance} loading={activity.loading} error={activity.error} t={t} />}
    {activeSection === 'connectivity' && <EmployeeConnectivityPanel data={connectivity} loading={activity.loading} error={activity.error} t={t} />}
    {activeSection === 'payroll' && <StaffPayrollWorkspace embedded />}
    {examDetail && <StaffPortalExamModal detail={examDetail} loading={examDetailLoading} error={examDetailError} onClose={() => setExamDetail(null)} t={t} locale={locale} />}
  </div>
}

function StaffAttendancePanel({ data, loading, error, t }) {
  const rows = data?.rows || []
  const summary = data?.summary || {}
  const label = value => ({
    normal: t('attendance.normal', 'Present'),
    rest: t('attendance.rest', 'Rest day'),
    absent: t('attendance.absent', 'Absent'),
    leave: t('attendance.leave', 'Leave'),
    late: t('attendance.late', 'Late'),
  }[String(value || '').toLowerCase()] || value || '—')
  return <section className="staff-activity-panel"><header><div><small>{t('decor.attendance', 'ATTENDANCE')}</small><h2>{t('attendance.title', 'Attendance')}</h2></div><span>{t('common.totalItems', 'Total {count}', { count: data?.total || 0 })}</span></header><div className="staff-activity-summary"><div><span>{label('normal')}</span><strong>{summary.normal || 0}</strong></div><div><span>{label('rest')}</span><strong>{summary.rest || 0}</strong></div><div><span>{label('absent')}</span><strong>{summary.absent || 0}</strong></div><div><span>{label('leave')}</span><strong>{summary.leave || 0}</strong></div></div>{loading ? <div className="staff-history-empty">{t('attendance.loading', 'Loading attendance…')}</div> : error ? <div className="staff-history-empty">{error}</div> : rows.length ? <div className="staff-attendance-list">{rows.map(row => <article key={row.id}><strong>{row.report_date}</strong><span className={`staff-attendance-status ${row.attendance_status}`}>{label(row.attendance_status)}</span><span>{row.shift_name || '—'}</span><span>{row.status_note || '—'}</span></article>)}</div> : <div className="staff-history-empty">{t('attendance.none', 'No attendance records yet.')}</div>}</section>
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
