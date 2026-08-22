import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

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

const staffTenure = date => {
  if (!date) return '—'
  const start = new Date(`${date}T00:00:00`), days = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000))
  const years = Math.floor(days / 365), months = Math.floor((days % 365) / 30), rest = days - years * 365 - months * 30
  return `${years ? `${years}年 ` : ''}${months}个月 ${rest}天 · 共 ${days} 天`
}

const staffDate = value => value ? String(value).slice(0,10) : '—'

export const StaffHome = () => {
  const [data,setData] = useState(null), [loading,setLoading] = useState(true), [error,setError] = useState('')
  const load = async () => {
    setLoading(true); setError('')
    const { data:result,error:loadError } = await supabase.rpc('staff_portal_home')
    if(loadError)setError(loadError.message || '个人资料读取失败'); else setData(result)
    setLoading(false)
  }
  useEffect(()=>{load()},[])
  if(loading)return <div className="staff-portal-page"><div className="staff-portal-loading">正在读取我的资料…</div></div>
  const p=data?.profile||{}, summary=data?.error_summary||{}, exam=data?.exam_summary||{}, errors=data?.recent_errors||[]
  const fields=[['员工ID',p.employee_no],['员工国家',p.country||p.nationality],['员工类型',p.employment_type],['状态',p.status==='active'?'在职':p.status],['入职日期',staffDate(p.hire_date)],['入职时长',staffTenure(p.hire_date)],['团队',p.team_name],['组别',p.group_name],['岗位',p.position_name],['班次',p.shift_name],['负责人 / 组长',p.person_in_charge||p.leader_name],['培训老师',p.online_trainer||p.trainer_name],['盘口 / 平台',p.platform_scope],['工作内容',p.work_content]]
  return <div className="staff-portal-page">
    <header className="staff-portal-hero"><div className="staff-avatar">{(p.full_name||'W').slice(0,1).toUpperCase()}</div><div><small>MY WORKSPACE</small><h1>{p.full_name||'我的首页'}</h1><p>{p.employee_no||'—'} · {p.team_name||'未设置团队'} · {p.position_name||'未设置岗位'}</p><div className="staff-hero-tags"><span>{p.shift_name||'班次未设置'}</span><span>{staffTenure(p.hire_date)}</span></div></div><button onClick={load}>↻ 刷新资料</button></header>
    {error&&<div className="exam-error">{error}<button onClick={()=>setError('')}>×</button></div>}
    <section className="staff-dashboard-metrics"><div><span>累计错误</span><strong>{summary.total_error_count||0}</strong><small>仅本人可见</small></div><div><span>本月错误</span><strong>{summary.month_error_count||0}</strong><small>近30天 {summary.last_30d_error_count||0} 笔</small></div><div><span>考试记录</span><strong>{exam.total||0}</strong><small>通过 {exam.passed||0} 次</small></div><div><span>平均成绩</span><strong>{exam.average||0}%</strong><small>已批改 {exam.completed||0} 次</small></div></section>
    <div className="staff-portal-columns"><section className="staff-profile-panel"><header><div><small>PERSONAL PROFILE</small><h2>我的员工档案</h2></div><span>敏感资料已隐藏</span></header><div className="staff-profile-fields">{fields.map(([label,value])=><div key={label}><span>{label}</span><strong>{value||'—'}</strong></div>)}</div></section>
    <section className="staff-quick-panel"><header><small>QUICK ACCESS</small><h2>快捷入口</h2></header><Link to="/staff/exams"><b>我的考试</b><span>参加岗位考试、查看历史成绩 →</span></Link><Link to="/staff/schedule"><b>我的排班</b><span>查看本人排班 →</span></Link><Link to="/staff/attendance"><b>我的出勤</b><span>查看本人出勤 →</span></Link></section></div>
    <section className="staff-own-errors"><header><div><small>MY ERROR RECORDS</small><h2>我的错误记录</h2><p>只显示与你员工ID关联的记录。</p></div><span>{errors.length} 条最近记录</span></header>{errors.length?<div className="staff-error-list">{errors.map((row,index)=><article key={`${row.qc_date}-${index}`}><div className="staff-error-date"><b>{staffDate(row.qc_date)}</b><span>{row.error_type||'未分类错误'}</span></div><div><small>错误情况</small><p>{row.error_note||'—'}</p></div><div><small>正确处理方式</small><p>{row.correct_action||'—'}</p></div><span className="staff-error-score">{row.score==null?'—':`${row.score} 分`}</span></article>)}</div>:<div className="staff-history-empty">目前没有与你员工ID关联的错误记录。</div>}</section>
  </div>
}

export const ComingSoon = ({ title }) => (
  <div className="content-page">
    <div className="page-toolbar"><h1>{title}</h1></div>
    <div className="data-card"><div className="empty-state">暂无数据</div></div>
  </div>
)
