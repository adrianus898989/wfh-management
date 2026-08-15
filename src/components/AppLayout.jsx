import React from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const ADMIN_NAV = [
  ['/admin', '首页'],
  ['/admin/employees', '员工管理'],
  ['/admin/schedule', '排班与考勤'],
  ['/admin/daily', '每日工作'],
  ['/admin/training', '培训与考试'],
  ['/admin/payroll', '工资中心'],
  ['/admin/reports', '统计报表'],
  ['/admin/users', '用户与权限'],
]

const STAFF_NAV = [
  ['/staff', '首页'],
  ['/staff/schedule', '我的排班'],
  ['/staff/attendance', '我的出勤'],
  ['/staff/payroll', '我的工资'],
  ['/staff/exams', '我的考试'],
  ['/staff/requests', '我的申请'],
]

export default function AppLayout({ mode, children }) {
  const navigate = useNavigate()
  const nav = mode === 'admin' ? ADMIN_NAV : STAFF_NAV

  const logout = async () => {
    await supabase.auth.signOut()
    navigate(mode === 'admin' ? '/admin/login' : '/staff/login')
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">W</div>
          <div className="sidebar-brand-copy">
            <strong>WFH</strong>
            <small>{mode === 'admin' ? 'MANAGEMENT' : 'STAFF'}</small>
          </div>
        </div>

        <nav className="sidebar-nav">
          {nav.map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/admin' || to === '/staff'}
              className={({ isActive }) => isActive ? 'active' : ''}
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <button className="sidebar-logout" onClick={logout}>退出</button>
      </aside>
      <main className="main">{children}</main>
    </div>
  )
}
