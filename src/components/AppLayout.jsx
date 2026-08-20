import React, { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const enc = value => encodeURIComponent(value)

const ADMIN_NAV = [
  { to:'/admin', label:'首页', icon:'⌂' },
  { to:'/admin/employees', label:'员工管理', icon:'人', children:[
    ['员工档案', `/admin/employees?tab=${enc('员工档案')}`],
    ['人员分析', `/admin/employees?tab=${enc('人员分析')}`],
    ['团队管理', `/admin/employees?tab=${enc('团队管理')}`],
    ['岗位管理', `/admin/employees?tab=${enc('岗位管理')}`],
    ['离职记录', `/admin/employees?tab=${enc('离职记录')}`],
  ]},
  { to:'/admin/reports', label:'统计报表', icon:'报', children:[
    ['总汇', `/admin/reports?tab=${enc('总汇')}`],
    ['人员', `/admin/reports?tab=${enc('人员')}`],
    ['排班表', `/admin/reports?tab=${enc('排班表')}`],
    ['盘口人数', `/admin/reports?tab=${enc('盘口人数')}`],
    ['统计', `/admin/reports?tab=${enc('统计')}`],
    ['错误统计', `/admin/reports?tab=${enc('错误统计')}`],
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
  { to:'/admin/training', label:'培训与考试', icon:'训' },
  { to:'/admin/payroll', label:'工资中心', icon:'薪' },
  { to:'/admin/users', label:'用户与权限', icon:'权' },
]

const STAFF_NAV = [
  ['/staff','首页'], ['/staff/schedule','我的排班'], ['/staff/attendance','我的出勤'],
  ['/staff/payroll','我的工资'], ['/staff/exams','我的考试'], ['/staff/requests','我的申请'],
]

export default function AppLayout({ mode, children }) {
  const navigate = useNavigate()
  const location = useLocation()

  const childPath = to => new URL(to,'https://wfh.local').pathname
  const groupActive = item => location.pathname.startsWith(item.to) || item.children?.some(([,to])=>{
    const path=childPath(to)
    return location.pathname===path || location.pathname.startsWith(`${path}/`)
  })
  const pathGroup = ADMIN_NAV.find(x => x.children && groupActive(x))?.to || null
  const [openGroup,setOpenGroup] = useState(pathGroup)

  useEffect(()=>{
    if (pathGroup && openGroup && openGroup !== pathGroup) setOpenGroup(pathGroup)
    if (!pathGroup && openGroup) setOpenGroup(null)
  },[location.pathname])

  const logout = async()=>{
    await supabase.auth.signOut()
    navigate(mode==='admin'?'/admin/login':'/staff/login')
  }

  const activeTab = new URLSearchParams(location.search).get('tab')

  const clickParent = item=>{
    setOpenGroup(openGroup===item.to ? null : item.to)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar pro-sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">W</div>
          <div className="sidebar-brand-copy"><strong>WFH</strong><small>{mode==='admin'?'MANAGEMENT':'STAFF'}</small></div>
        </div>

        {mode==='admin' ? <nav className="sidebar-nav sidebar-nav-pro">
          {ADMIN_NAV.map(item=>{
            const active = item.to==='/admin' ? location.pathname==='/admin' : groupActive(item)
            const expanded = openGroup===item.to

            if(!item.children) return (
              <NavLink key={item.to} to={item.to} end={item.to==='/admin'} className={({isActive})=>isActive?'active nav-parent':'nav-parent'}>
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-parent-label">{item.label}</span>
              </NavLink>
            )

            return <div className="nav-group" key={item.to}>
              <button type="button" className="nav-parent nav-parent-button" aria-expanded={expanded} onClick={()=>clickParent(item)}>
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-parent-label">{item.label}</span>
                <span className="nav-chevron">{expanded?'⌄':'›'}</span>
              </button>

              {expanded && <div className="nav-children">
                {item.children.map(([label,to],index)=>{
                  const target = new URL(to,'https://wfh.local')
                  const targetTab = target.searchParams.get('tab')
                  const samePath = location.pathname===target.pathname || location.pathname.startsWith(`${target.pathname}/`)
                  const childActive = samePath && (targetTab ? (activeTab ? activeTab===targetTab : index===0) : true)
                  return <NavLink key={label} to={to} className={childActive?'active-child':''}>
                    <span className="child-dot"/>{label}
                  </NavLink>
                })}
              </div>}
            </div>
          })}
        </nav> : <nav className="sidebar-nav">
          {STAFF_NAV.map(([to,label])=><NavLink key={to} to={to} end={to==='/staff'} className={({isActive})=>isActive?'active':''}>{label}</NavLink>)}
        </nav>}

        <div className="sidebar-footnote">{mode==='admin'?'ADMIN CONSOLE':'EMPLOYEE PORTAL'}</div>
        <button className="sidebar-logout" onClick={logout}>退出登录</button>
      </aside>
      <main className="main">{children}</main>
    </div>
  )
}
