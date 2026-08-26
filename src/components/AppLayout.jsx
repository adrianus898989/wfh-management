import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { signOutAppSession, supabase } from '../lib/supabase'
import { StaffLanguageSwitcher, useStaffLocale } from '../lib/staffI18n'
import { AdminLanguageSwitcher, useAdminI18n } from '../lib/adminI18n'
import { adminNavigation, adminRouteAccess, adminTargetMatches, requestedAdminRoute, requestedStaffGroup, staffNavigation, staffTargetMatches } from '../config/navigation'
import { AdminAccessProvider } from '../lib/adminAccess'
import { AdminAlertBell } from './AdminAlertCenter'

const navKey = item => item.id || item.to
const navUrl = to => new URL(to, 'https://wfh.local')

export default function AppLayout({ mode, children }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { t, resetLocale } = useStaffLocale()
  const { t: adminT } = useAdminI18n()
  const [adminAccess,setAdminAccess] = useState({loading:mode==='admin',founder:false,permissions:[],error:''})
  const [accessRetryKey,setAccessRetryKey] = useState(0)
  const [staffIdentity,setStaffIdentity] = useState('')

  useEffect(()=>{
    if(mode!=='staff')return undefined
    let alive=true
    const applyIdentity=user=>{
      if(!alive)return
      const email=String(user?.email||'').trim()
      const username=String(user?.user_metadata?.username||'').trim()
      setStaffIdentity(email||username)
    }
    supabase.auth.getSession().then(({data})=>applyIdentity(data?.session?.user)).catch(()=>{})
    const {data:listener}=supabase.auth.onAuthStateChange((_event,session)=>applyIdentity(session?.user))
    return()=>{
      alive=false
      listener?.subscription?.unsubscribe()
    }
  },[mode])

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
        roleCode:data?.caller?.role_code||'',
        employeeId:data?.caller?.employee_id||'',
        dataScope:data?.caller?.data_scope||'',
        teamId:data?.caller?.team_id||'',
        positionId:data?.caller?.position_id||'',
        error:'',
      })
    })()
    return()=>{alive=false}
  },[mode,accessRetryKey])

  const permissionSet=new Set(adminAccess.permissions)
  const permissionAllowed=code=>adminAccess.founder||permissionSet.has('*')||permissionSet.has(code)
  const navAllowed=item=>{
    if(item.allPermissions?.some(code=>!permissionAllowed(code)))return false
    return !item.permissions?.length||item.permissions.some(permissionAllowed)
  }
  const visibleAdminNav=adminAccess.loading||adminAccess.error?[]:adminNavigation.map(item=>item.children?({...item,children:item.children.filter(navAllowed)}):item).filter(item=>navAllowed(item)&&(!item.children||item.children.length))
  const requestedAdminItem=mode==='admin'?requestedAdminRoute(location.pathname,location.search):null
  const requestedAdminAllowed=Boolean(requestedAdminItem&&navAllowed(requestedAdminItem))
  const firstAllowedAdminTarget=visibleAdminNav.reduce((target,item)=>target||(item.children?.[0]?.to||item.to),'')
  const requestedAdminGroup=adminNavigation.find(item=>item.children&&item.id===requestedAdminItem?.groupId)
  const samePageCandidates=adminRouteAccess.filter(item=>navUrl(item.to).pathname===location.pathname&&item!==requestedAdminItem&&navAllowed(item))
  const samePageFallback=(requestedAdminItem
    ? samePageCandidates.find(item=>navUrl(item.to).searchParams.has('tab'))
    : samePageCandidates.find(item=>!navUrl(item.to).searchParams.has('tab'))
  )||samePageCandidates[0]
  const routeFallbackTarget=samePageFallback?.to||requestedAdminGroup?.children?.find(navAllowed)?.to||firstAllowedAdminTarget

  const pathGroup = requestedAdminGroup?.id || null
  const [openGroup,setOpenGroup] = useState(pathGroup)
  const staffGroup = mode==='staff' ? requestedStaffGroup(location.pathname, location.search) : null
  const [openStaffGroup,setOpenStaffGroup] = useState(staffGroup?.id || null)

  useEffect(()=>{
    setOpenGroup(pathGroup)
  },[pathGroup])

  useEffect(()=>{
    if (staffGroup?.children?.length) setOpenStaffGroup(staffGroup.id)
  },[staffGroup?.id])

  useEffect(()=>{
    if(mode!=='admin'||adminAccess.loading||adminAccess.error||requestedAdminAllowed)return
    if(routeFallbackTarget)navigate(routeFallbackTarget,{replace:true})
  },[mode,adminAccess.loading,adminAccess.error,adminAccess.founder,adminAccess.permissions.join('|'),requestedAdminAllowed,routeFallbackTarget,location.pathname,location.search,navigate])

  const logout = async()=>{
    await signOutAppSession()
    if (mode === 'staff') resetLocale()
    navigate(mode==='admin'?'/admin/login':'/staff/login')
  }

  const clickParent = item=>{
    const key=navKey(item)
    setOpenGroup(current=>current===key ? null : key)
  }

  const adminMain = adminAccess.loading
    ? <div className="center-screen">{adminT('权限读取中…')}</div>
    : adminAccess.error
      ? <div className="center-screen auth-retry"><div><strong>{adminT('权限读取失败')}</strong><p>{adminAccess.error}</p><button type="button" onClick={()=>setAccessRetryKey(value=>value+1)}>{adminT('重试')}</button></div></div>
      : !requestedAdminAllowed
        ? <div className="center-screen">{adminT(routeFallbackTarget?'正在打开可访问页面…':'当前账号尚未配置可访问页面')}</div>
        : <AdminAccessProvider access={adminAccess}>{children}</AdminAccessProvider>

  return (
    <div className="app-shell">
      <aside className={`sidebar pro-sidebar ${mode==='staff'?'staff-sidebar':''}`}>
        <div className="sidebar-brand">
          <div className="sidebar-logo">W</div>
          <div className="sidebar-brand-copy"><strong>WFH</strong><small>{mode==='admin'?'MANAGEMENT':'STAFF'}</small></div>
          {mode==='admin'&&<AdminAlertBell access={adminAccess}/>}
        </div>

        {mode==='admin' ? <nav className="sidebar-nav sidebar-nav-pro">
          {visibleAdminNav.map(item=>{
            const key = navKey(item)
            const expanded = openGroup===key

            if(!item.children) return (
              <Link key={key} to={item.to} className={adminTargetMatches(item.to,location.pathname,location.search)?'active nav-parent':'nav-parent'}>
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-parent-label">{adminT(item.label)}</span>
              </Link>
            )

            return <div className={`nav-group ${pathGroup===key?'active-group':''}`} key={key}>
              <button type="button" className={`nav-parent nav-parent-button ${pathGroup===key?'active':''}`} aria-expanded={expanded} onClick={()=>clickParent(item)}>
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-parent-label">{adminT(item.label)}</span>
                <span className="nav-chevron">{expanded?'⌄':'›'}</span>
              </button>

              {expanded && <div className="nav-children">
                {item.children.map(child=>{
                  const childActive = adminTargetMatches(child.to,location.pathname,location.search)
                  return <Link key={child.label} to={child.to} className={childActive?'active-child':''}>
                    <span className="child-dot"/>{adminT(child.label)}
                  </Link>
                })}
              </div>}
            </div>
          })}
        </nav> : <nav className="sidebar-nav staff-sidebar-nav">
          {staffNavigation.map(item=>{
            const key=navKey(item)
            if(!item.children)return <Link key={key} to={item.to} className={staffTargetMatches(item.to,location.pathname,location.search)?'active':''}>{t(item.key,item.label)}</Link>
            const expanded=openStaffGroup===key
            const active=staffGroup?.id===key
            return <div className={`nav-group staff-nav-group ${active?'active-group':''}`} key={key}>
              <button type="button" className={`nav-parent nav-parent-button ${active?'active':''}`} aria-expanded={expanded} onClick={()=>setOpenStaffGroup(current=>current===key?null:key)}>
                <span className="nav-parent-label">{t(item.key,item.label)}</span>
                <span className="nav-chevron">{expanded?'⌄':'›'}</span>
              </button>
              {expanded&&<div className="nav-children">{item.children.map(child=>{
                const childActive=staffTargetMatches(child.to,location.pathname,location.search)
                return <Link key={child.to} to={child.to} className={childActive?'active-child':''}><span className="child-dot"/>{t(child.key,child.label)}</Link>
              })}</div>}
            </div>
          })}
          <a className="staff-policy-link" href="https://official.wfh-policy.workers.dev" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.75h7.2L18 7.55v12.7H7z"/><path d="M14 3.75v4h4M9.5 12h6M9.5 15.5h4.25"/></svg>
            <span>WFH Policy</span>
            <span className="staff-policy-external" aria-hidden="true">↗</span>
          </a>
        </nav>}

        {mode==='staff'&&<div className="staff-sidebar-footer">
          {staffIdentity&&<div className="staff-sidebar-account" title={staffIdentity}>
            <span className="staff-sidebar-account-avatar" aria-hidden="true">{staffIdentity.slice(0,1).toUpperCase()}</span>
            <strong>{staffIdentity}</strong>
          </div>}
          <StaffLanguageSwitcher className="sidebar-language-switcher" />
        </div>}
        {mode==='admin'&&<AdminLanguageSwitcher className="sidebar-language-switcher" />}
        {mode==='admin'&&adminAccess.error&&<div className="sidebar-access-error" title={adminAccess.error}>{adminT('权限目录读取失败')}</div>}
        <div className="sidebar-footnote">{mode==='admin'?'ADMIN CONSOLE':t('nav.employeePortal','员工门户')}</div>
        <button className="sidebar-logout" onClick={logout}>{mode==='admin'?adminT('退出登录'):t('nav.signOut','退出登录')}</button>
      </aside>
      <main className="main">
        {mode === 'admin' ? adminMain : children}
      </main>
    </div>
  )
}
