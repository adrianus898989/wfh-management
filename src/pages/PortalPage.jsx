import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const inactiveStatuses = ['left', 'resigned', 'inactive', 'terminated', '离职', '停用']

function isActive(row) {
  return !inactiveStatuses.includes(String(row?.status || '').trim().toLowerCase())
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

      if (error || data?.error) {
        setError(data?.error || error?.message || '读取失败')
      } else {
        setData(data)
      }
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

    return {
      total: employees.length,
      active: active.length,
      teams: groupCount(active, e => e?.teams?.name),
      positions: groupCount(active, e => e?.positions?.name),
      staffAccounts: staffAccounts.length,
      backendAccounts: backendAccounts.length,
      pendingAccounts: active.filter(e => !staffIds.has(e.id)).length,
    }
  }, [data])

  return (
    <div className="content-page dashboard-page">
      <div className="dashboard-head">
        <div>
          <div className="dashboard-kicker">DASHBOARD</div>
          <h1>员工总览</h1>
        </div>
        <div className="dashboard-date">
          {new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date())}
        </div>
      </div>

      {error && <div className="page-error">{error}</div>}

      <div className="kpi-grid">
        <Kpi label="员工总数" value={loading ? '—' : view.total} />
        <Kpi label="在职员工" value={loading ? '—' : view.active} />
        <Kpi label="今日在岗" value="—" />
        <Kpi label="请假 / 公休" value="—" />
        <Kpi label="回家" value="—" />
        <Kpi label="缺席" value="—" />
        <Kpi label="待审批" value="—" />
        <Kpi label="后台账号" value={loading ? '—' : view.backendAccounts} />
      </div>

      <div className="dashboard-grid">
        <DashboardCard title="团队人数分布">
          <BarList rows={view.teams} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="岗位分布">
          <BarList rows={view.positions} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="今日出勤">
          <CompactStats rows={[
            ['正常', '—'],
            ['请假', '—'],
            ['公休', '—'],
            ['回家', '—'],
            ['缺席', '—'],
          ]} />
        </DashboardCard>

        <DashboardCard title="待处理">
          <CompactStats rows={[
            ['请假审批', '—'],
            ['资料修改', '—'],
            ['收款资料修改', '—'],
            ['投诉 / 申诉', '—'],
            ['待发布工资', '—'],
          ]} />
        </DashboardCard>

        <DashboardCard title="账号概况">
          <CompactStats rows={[
            ['员工账号', loading ? '—' : view.staffAccounts],
            ['待开通账号', loading ? '—' : view.pendingAccounts],
            ['后台账号', loading ? '—' : view.backendAccounts],
          ]} />
        </DashboardCard>

        <DashboardCard title="人员动态">
          <CompactStats rows={[
            ['今日入职', '—'],
            ['最近离职', '—'],
            ['培训 / 考试异常', '—'],
          ]} />
        </DashboardCard>
      </div>
    </div>
  )
}

function Kpi({ label, value }) {
  return (
    <div className="kpi-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function DashboardCard({ title, children }) {
  return (
    <section className="dashboard-card">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function BarList({ rows, total }) {
  if (!rows?.length) return <div className="empty-state compact">暂无数据</div>

  return (
    <div className="bar-list">
      {rows.slice(0, 8).map(row => (
        <div className="bar-row" key={row.name}>
          <div className="bar-meta"><span>{row.name}</span><strong>{row.count}</strong></div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${Math.max(3, Math.round(row.count / total * 100))}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function CompactStats({ rows }) {
  return (
    <div className="compact-stats">
      {rows.map(([label, value]) => (
        <div className="compact-stat" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  )
}

export const StaffHome = () => (
  <div className="content-page">
    <div className="page-toolbar"><h1>我的首页</h1></div>
    <div className="staff-home-grid">
      {['我的排班', '我的出勤', '我的工资', '我的考试', '我的申请'].map(x => (
        <div className="staff-home-card" key={x}>{x}</div>
      ))}
    </div>
  </div>
)

export const ComingSoon = ({ title }) => (
  <div className="content-page">
    <div className="page-toolbar"><h1>{title}</h1></div>
    <div className="data-card">
      <div className="empty-state">暂无数据</div>
    </div>
  </div>
)
