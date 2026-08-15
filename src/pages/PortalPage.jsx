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

export const StaffHome = () => (
  <div className="content-page">
    <div className="page-toolbar"><h1>我的首页</h1></div>
    <div className="staff-home-grid">
      {['我的排班','我的出勤','我的工资','我的考试','我的申请'].map(x => <div className="staff-home-card" key={x}>{x}</div>)}
    </div>
  </div>
)

export const ComingSoon = ({ title }) => (
  <div className="content-page">
    <div className="page-toolbar"><h1>{title}</h1></div>
    <div className="data-card"><div className="empty-state">暂无数据</div></div>
  </div>
)
