import React, { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { signOutAppSession, supabase } from '../lib/supabase'
import { StaffLanguageSwitcher, useStaffLocale } from '../lib/staffI18n'
import { adminNavigation, staffNavigation } from '../config/navigation'
import { AdminAccessProvider } from '../lib/adminAccess'

export default function AppLayout({ mode, children }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { t, resetLocale } = useStaffLocale()
  const [adminAccess,setAdminAccess] = useState({loading:mode==='admin',founder:false,permissions:[],error:''})

  useEffect(()=>{
    if(mode!=='admin')return undefined
    let alive=true
    setAdminAccess(current=>({...current,loading:true,error:''}))
    ;(async()=>{
      const {data,error}=await supabase.functions.invoke('admin-accounts',{body:{action:'access'}})
      if(!alive)return
      if(error||data?.error){
        setAdminAccess({loading:false,founder:false,permissions:[],error:data?.error||error?.message||'权限读取失败'})
        return
      }
      setAdminAccess({
        loading:false,
        founder:Boolean(data?.caller?.is_founder),
        permissions:Array.isArray(data?.caller?.permissions)?data.caller.permissions:[],
        error:'',
      })
    })()
    return()=>{alive=false}
  },[mode])

  const permissionSet=new Set(adminAccess.permissions)
  const permissionAllowed=code=>adminAccess.founder||permissionSet.has('*')||permissionSet.has(code)
  const navAllowed=item=>{
    if(item.allPermissions?.some(code=>!permissionAllowed(code)))return false
    return !item.permissions?.length||item.permissions.some(permissionAllowed)
  }
  const visibleAdminNav=adminAccess.loading?[adminNavigation[0]]:adminNavigation.map(item=>item.children?({...item,children:item.children.filter(navAllowed)}):item).filter(item=>navAllowed(item)&&(!item.children||item.children.length))

  const childPath = to => new URL(to,'https://wfh.local').pathname
  const groupActive = item => location.pathname.startsWith(item.to) || item.children?.some(child=>{
    const path=childPath(child.to)
    return location.pathname===path || location.pathname.startsWith(`${path}/`)
  })
  const pathGroup = adminNavigation.find(x => x.children && groupActive(x))?.to || null
  const [openGroup,setOpenGroup] = useState(pathGroup)

  useEffect(()=>{
    if (pathGroup && openGroup && openGroup !== pathGroup) setOpenGroup(pathGroup)
    if (!pathGroup && openGroup) setOpenGroup(null)
  },[location.pathname])

  useEffect(()=>{
    if(mode!=='admin'||adminAccess.loading||adminAccess.error||location.pathname==='/admin')return
    const group=adminNavigation.find(item=>item.children&&location.pathname===childPath(item.to))
    if(!group)return
    const activeTab=new URLSearchParams(location.search).get('tab')
    const requested=group.children.find((child,index)=>{
      const target=new URL(child.to,'https://wfh.local')
      const targetTab=target.searchParams.get('tab')
      return target.pathname===location.pathname&&(targetTab?targetTab===activeTab:(!activeTab&&index===0))
    })||group.children[0]
    if(requested&&navAllowed(requested))return
    const fallback=group.children.find(navAllowed)
    navigate(fallback?.to||'/admin',{replace:true})
  },[mode,adminAccess.loading,adminAccess.error,adminAccess.founder,adminAccess.permissions.join('|'),location.pathname,location.search])

  const logout = async()=>{
    await signOutAppSession()
    if (mode === 'staff') resetLocale()
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
          {visibleAdminNav.map(item=>{
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
                {item.children.map((child,index)=>{
                  const target = new URL(child.to,'https://wfh.local')
                  const targetTab = target.searchParams.get('tab')
                  const samePath = location.pathname===target.pathname || location.pathname.startsWith(`${target.pathname}/`)
                  const childActive = samePath && (targetTab ? (activeTab ? activeTab===targetTab : index===0) : true)
                  return <NavLink key={child.label} to={child.to} className={childActive?'active-child':''}>
                    <span className="child-dot"/>{child.label}
                  </NavLink>
                })}
              </div>}
            </div>
          })}
        </nav> : <nav className="sidebar-nav">
          {staffNavigation.map(item=><NavLink key={item.to} to={item.to} end={item.to==='/staff'} className={({isActive})=>isActive?'active':''}>{t(item.key,item.label)}</NavLink>)}
        </nav>}

        {mode==='staff'&&<StaffLanguageSwitcher className="sidebar-language-switcher" />}
        {mode==='admin'&&adminAccess.error&&<div className="sidebar-access-error" title={adminAccess.error}>权限目录读取失败</div>}
        <div className="sidebar-footnote">{mode==='admin'?'ADMIN CONSOLE':t('nav.employeePortal','员工门户')}</div>
        <button className="sidebar-logout" onClick={logout}>{mode==='admin'?'退出登录':t('nav.signOut','退出登录')}</button>
      </aside>
      <main className="main">
        {mode === 'admin' ? <AdminAccessProvider access={adminAccess}>{children}</AdminAccessProvider> : children}
      </main>
    </div>
  )
}
