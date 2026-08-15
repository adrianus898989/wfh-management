import React from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const enc = value => encodeURIComponent(value)

const ADMIN_NAV = [
  { to:'/admin', label:'首页', icon:'⌂' },
  { to:'/admin/employees', label:'员工管理', icon:'人', children:[
    ['员工档案', `/admin/employees?tab=${enc('员工档案')}`],
    ['团队管理', `/admin/employees?tab=${enc('团队管理')}`],
    ['岗位管理', `/admin/employees?tab=${enc('岗位管理')}`],
    ['入离职记录', `/admin/employees?tab=${enc('入离职记录')}`],
  ]},
  { to:'/admin/schedule', label:'排班与考勤', icon:'班', children:[
    ['排班表', `/admin/schedule?tab=${enc('排班表')}`],
    ['今日考勤', `/admin/schedule?tab=${enc('今日考勤')}`],
    ['考勤记录', `/admin/schedule?tab=${enc('考勤记录')}`],
    ['请假审批', `/admin/schedule?tab=${enc('请假审批')}`],
    ['换班记录', `/admin/schedule?tab=${enc('换班记录')}`],
  ]},
  { to:'/admin/daily', label:'每日工作', icon:'日', children:[
    ['组长日报', `/admin/daily?tab=${enc('组长日报')}`],
    ['培训日报', `/admin/daily?tab=${enc('培训日报')}`],
    ['交接事项', `/admin/daily?tab=${enc('交接事项')}`],
    ['异常问题', `/admin/daily?tab=${enc('异常问题')}`],
    ['奖惩记录', `/admin/daily?tab=${enc('奖惩记录')}`],
  ]},
  { to:'/admin/training', label:'培训与考试', icon:'训', children:[
    ['考试概览', `/admin/training?tab=${enc('考试概览')}`],
    ['考试记录', `/admin/training?tab=${enc('考试记录')}`],
    ['题库', `/admin/training?tab=${enc('题库')}`],
    ['创建 / 分配考试', `/admin/training?tab=${enc('创建 / 分配考试')}`],
    ['人工批改', `/admin/training?tab=${enc('人工批改')}`],
    ['成绩统计', `/admin/training?tab=${enc('成绩统计')}`],
  ]},
  { to:'/admin/payroll', label:'工资中心', icon:'薪', children:[
    ['工资计算', `/admin/payroll?tab=${enc('工资计算')}`],
    ['待复核', `/admin/payroll?tab=${enc('待复核')}`],
    ['已发布', `/admin/payroll?tab=${enc('已发布')}`],
    ['工资规则', `/admin/payroll?tab=${enc('工资规则')}`],
    ['导出记录', `/admin/payroll?tab=${enc('导出记录')}`],
  ]},
  { to:'/admin/reports', label:'统计报表', icon:'报', children:[
    ['排班运营统计', `/admin/reports?tab=${enc('排班运营统计')}`],
    ['人员统计', `/admin/reports?tab=${enc('人员统计')}`],
    ['出勤统计', `/admin/reports?tab=${enc('出勤统计')}`],
    ['工资统计', `/admin/reports?tab=${enc('工资统计')}`],
    ['离职率', `/admin/reports?tab=${enc('离职率')}`],
    ['账号统计', `/admin/reports?tab=${enc('账号统计')}`],
  ]},
  { to:'/admin/users', label:'用户与权限', icon:'权' },
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
  const location = useLocation()

  const logout = async () => {
    await supabase.auth.signOut()
    navigate(mode === 'admin' ? '/admin/login' : '/staff/login')
  }

  const groupActive = item =>
    item.to === '/admin'
      ? location.pathname === '/admin'
      : location.pathname.startsWith(item.to)

  const activeTab = new URLSearchParams(location.search).get('tab')

  return (
    <div className="app-shell">
      <aside className="sidebar pro-sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">W</div>
          <div className="sidebar-brand-copy">
            <strong>WFH</strong>
            <small>{mode === 'admin' ? 'MANAGEMENT' : 'STAFF'}</small>
          </div>
        </div>

        {mode === 'admin' ? (
          <nav className="sidebar-nav sidebar-nav-pro">
            {ADMIN_NAV.map(item => {
              const active = groupActive(item)
              return (
                <div className={`nav-group ${active ? 'active-group' : ''}`} key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/admin'}
                    className={({ isActive }) => isActive || active ? 'active nav-parent' : 'nav-parent'}
                  >
                    <span className="nav-icon">{item.icon}</span>
                    <span className="nav-parent-label">{item.label}</span>
                    {item.children && <span className="nav-chevron">{active ? '⌄' : '›'}</span>}
                  </NavLink>

                  {item.children && active && (
                    <div className="nav-children">
                      {item.children.map(([label, to], index) => {
                        const targetTab = new URL(to, 'https://wfh.local').searchParams.get('tab')
                        const childActive = activeTab ? activeTab === targetTab : index === 0
                        return (
                          <NavLink key={label} to={to} className={childActive ? 'active-child' : ''}>
                            <span className="child-dot" />
                            {label}
                          </NavLink>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </nav>
        ) : (
          <nav className="sidebar-nav">
            {STAFF_NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/staff'} className={({ isActive }) => isActive ? 'active' : ''}>
                {label}
              </NavLink>
            ))}
          </nav>
        )}

        <div className="sidebar-footnote">{mode === 'admin' ? 'ADMIN CONSOLE' : 'EMPLOYEE PORTAL'}</div>
        <button className="sidebar-logout" onClick={logout}>退出登录</button>
      </aside>
      <main className="main">{children}</main>
    </div>
  )
}
