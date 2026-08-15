import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase()
}

function isActiveEmployee(row) {
  const s = normalizeStatus(row?.status)
  return !['left', 'resigned', 'inactive', 'terminated', '离职', '停用'].includes(s)
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
      try {
        const { data, error } = await supabase.functions.invoke('admin-accounts', {
          body: { action: 'bootstrap' }
        })

        if (error || data?.error) {
          throw new Error(data?.error || error?.message || '读取失败')
        }

        if (alive) setData(data)
      } catch (e) {
        if (alive) setError(e.message || '读取失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()

    return () => { alive = false }
  }, [])

  const dashboard = useMemo(() => {
    const employees = data?.employees || []
    const activeEmployees = employees.filter(isActiveEmployee)
    const backendAccounts = data?.backend_accounts || []
    const employeeAccounts = data?.employee_accounts || []

    const staffAccountIds = new Set(
      employeeAccounts
        .map(x => x.employee_id)
        .filter(Boolean)
    )

    const teamRows = groupCount(activeEmployees, e => e?.teams?.name)
    const positionRows = groupCount(activeEmployees, e => e?.positions?.name)

    return {
      total: employees.length,
      active: activeEmployees.length,
      teams: teamRows.length,
      backendAccounts: backendAccounts.length,
      staffAccounts: employeeAccounts.length,
      pendingStaffAccounts: Math.max(
        0,
        activeEmployees.filter(e => !staffAccountIds.has(e.id)).length
      ),
      teamRows,
      positionRows
    }
  }, [data])

  if (loading) {
    return (
      <div className="dash-page">
        <DashboardStyles />
        <div className="dash-loading">读取中...</div>
      </div>
    )
  }

  return (
    <div className="dash-page">
      <DashboardStyles />

      <div className="dash-head">
        <div>
          <div className="dash-kicker">Dashboard</div>
          <h1>员工总览</h1>
        </div>
        <div className="dash-date">
          {new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
          }).format(new Date())}
        </div>
      </div>

      {error && (
        <div className="dash-error">
          {error}
        </div>
      )}

      <div className="dash-cards">
        <Metric label="员工总数" value={dashboard.total} />
        <Metric label="在职员工" value={dashboard.active} />
        <Metric label="团队数量" value={dashboard.teams} />
        <Metric label="员工账号" value={dashboard.staffAccounts} />
        <Metric label="后台账号" value={dashboard.backendAccounts} />
        <Metric label="待开通账号" value={dashboard.pendingStaffAccounts} />
      </div>

      <div className="dash-grid">
        <Section title="团队人数分布">
          {dashboard.teamRows.length === 0
            ? <Empty />
            : <Bars rows={dashboard.teamRows} total={dashboard.active || 1} />
          }
        </Section>

        <Section title="岗位分布">
          {dashboard.positionRows.length === 0
            ? <Empty />
            : <Bars rows={dashboard.positionRows} total={dashboard.active || 1} />
          }
        </Section>
      </div>

      <div className="dash-grid bottom">
        <Section title="账号概况">
          <div className="account-summary">
            <SummaryLine label="员工前端已开通" value={dashboard.staffAccounts} />
            <SummaryLine label="待开通员工账号" value={dashboard.pendingStaffAccounts} />
            <SummaryLine label="后台管理账号" value={dashboard.backendAccounts} />
          </div>
        </Section>

        <Section title="人员概况">
          <div className="account-summary">
            <SummaryLine label="全部员工档案" value={dashboard.total} />
            <SummaryLine label="当前在职" value={dashboard.active} />
            <SummaryLine label="已设置团队" value={dashboard.active - (dashboard.teamRows.find(x => x.name === '未设置')?.count || 0)} />
          </div>
        </Section>
      </div>
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{Number(value || 0).toLocaleString()}</div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  )
}

function Bars({ rows, total }) {
  return (
    <div className="bar-list">
      {rows.slice(0, 8).map(row => {
        const pct = Math.max(3, Math.round((row.count / total) * 100))
        return (
          <div className="bar-row" key={row.name}>
            <div className="bar-meta">
              <span>{row.name}</span>
              <strong>{row.count}</strong>
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SummaryLine({ label, value }) {
  return (
    <div className="summary-line">
      <span>{label}</span>
      <strong>{Number(value || 0).toLocaleString()}</strong>
    </div>
  )
}

function Empty() {
  return <div className="dash-empty">暂无数据</div>
}

export const StaffHome = () => (
  <div className="content-page">
    <div className="page-head">
      <div>
        <h1>我的首页</h1>
      </div>
    </div>

    <div className="card-grid">
      <div className="module-card"><strong>我的排班</strong></div>
      <div className="module-card"><strong>我的出勤</strong></div>
      <div className="module-card"><strong>我的工资</strong></div>
      <div className="module-card"><strong>我的考试</strong></div>
      <div className="module-card"><strong>我的申请</strong></div>
    </div>
  </div>
)

export const ComingSoon = ({ title }) => (
  <div className="content-page">
    <div className="page-head">
      <div><h1>{title}</h1></div>
    </div>
  </div>
)

function DashboardStyles() {
  return (
    <style>{`
      .dash-page{
        padding:30px;
        max-width:1600px;
        margin:0 auto;
      }
      .dash-head{
        display:flex;
        justify-content:space-between;
        align-items:flex-end;
        margin-bottom:22px;
      }
      .dash-kicker{
        color:#7c8ca3;
        font-size:11px;
        font-weight:800;
        letter-spacing:.12em;
        text-transform:uppercase;
        margin-bottom:5px;
      }
      .dash-head h1{
        margin:0;
        font-size:30px;
        letter-spacing:-.04em;
      }
      .dash-date{
        color:#8b98aa;
        font-size:12px;
      }
      .dash-error{
        background:#fff2f2;
        color:#bd4141;
        border:1px solid #f0cece;
        border-radius:10px;
        padding:10px 12px;
        margin-bottom:14px;
        font-size:12px;
      }
      .dash-cards{
        display:grid;
        grid-template-columns:repeat(6,minmax(0,1fr));
        gap:12px;
        margin-bottom:14px;
      }
      .metric-card{
        background:#fff;
        border:1px solid #e3e9f1;
        border-radius:14px;
        padding:17px 16px;
        box-shadow:0 5px 18px rgba(35,53,80,.035);
      }
      .metric-label{
        color:#7d8b9f;
        font-size:11px;
        font-weight:700;
      }
      .metric-value{
        color:#17243b;
        font-size:27px;
        font-weight:850;
        letter-spacing:-.04em;
        margin-top:7px;
      }
      .dash-grid{
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:14px;
        margin-top:14px;
      }
      .dash-grid.bottom{
        grid-template-columns:1fr 1fr;
      }
      .dash-section{
        background:#fff;
        border:1px solid #e3e9f1;
        border-radius:14px;
        padding:18px;
        min-height:260px;
      }
      .dash-section-head{
        display:flex;
        align-items:center;
        justify-content:space-between;
        margin-bottom:16px;
      }
      .dash-section h2{
        margin:0;
        font-size:14px;
        letter-spacing:-.01em;
      }
      .bar-list{
        display:flex;
        flex-direction:column;
        gap:13px;
      }
      .bar-row{
        min-width:0;
      }
      .bar-meta{
        display:flex;
        justify-content:space-between;
        gap:10px;
        font-size:12px;
        margin-bottom:6px;
      }
      .bar-meta span{
        color:#5f6f84;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
      }
      .bar-meta strong{
        color:#24324a;
      }
      .bar-track{
        height:7px;
        border-radius:999px;
        background:#edf1f6;
        overflow:hidden;
      }
      .bar-fill{
        height:100%;
        border-radius:999px;
        background:linear-gradient(90deg,#2d66d7,#5884e8);
      }
      .account-summary{
        display:flex;
        flex-direction:column;
      }
      .summary-line{
        display:flex;
        justify-content:space-between;
        align-items:center;
        padding:14px 0;
        border-bottom:1px solid #eef2f6;
        font-size:13px;
      }
      .summary-line:last-child{
        border-bottom:0;
      }
      .summary-line span{
        color:#68778b;
      }
      .summary-line strong{
        font-size:16px;
      }
      .dash-empty,.dash-loading{
        color:#97a3b3;
        font-size:12px;
        padding:25px 0;
      }
      @media(max-width:1200px){
        .dash-cards{grid-template-columns:repeat(3,1fr)}
      }
      @media(max-width:800px){
        .dash-page{padding:18px}
        .dash-cards{grid-template-columns:repeat(2,1fr)}
        .dash-grid,.dash-grid.bottom{grid-template-columns:1fr}
      }
    `}</style>
  )
}
