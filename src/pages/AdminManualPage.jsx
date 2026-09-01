import React,{useMemo,useState} from 'react'
import {Link} from 'react-router-dom'
import AdminModuleNav from '../components/AdminModuleNav'
import {adminNavigation} from '../config/navigation'
import {adminPagePermissionCodes} from '../config/adminPagePermissions'
import {ADMIN_SECTION_DESCRIPTIONS,adminPageDescription} from '../config/pageDescriptions'
import {useAdminAccess} from '../lib/adminAccess'
import '../styles-admin-manual.css'

const text=value=>String(value??'').trim()
const ACTION_NAMES={
  view:'查看',create:'新增',generate:'生成',submit:'提交',edit:'编辑',change:'修改',review:'复核',
  manage:'管理',approve:'审批',grade:'批改',publish:'发布',export:'导出',delete:'删除',disable:'停用',
  disable_employee:'停用员工账号',reactivate:'恢复',resign:'离职',reset_password:'重置密码',
  otp_toggle:'OTP 开关',mfa_reset:'重置 MFA',follow_up:'跟进',mark_read:'标记已读',general:'通用导出',
}
const DATA_SCOPE_NAMES={all:'全部数据',assigned_teams:'指定团队 / 员工',own_team:'关联员工团队',self:'仅关联员工本人'}

const pagePermissionCodes=item=>{
  const registered=adminPagePermissionCodes(item.pagePermission)
  return [...new Set(registered.length?registered:[...(item.allPermissions||[]),...(item.permissions||[])])]
}

const permissionAction=code=>{
  const parts=text(code).split('.')
  const compound=parts.slice(-2).join('_')
  return ACTION_NAMES[compound]||ACTION_NAMES[parts.at(-1)]||'授权操作'
}

const searchablePage=(page,query)=>{
  if(!query)return true
  const detail=page.detail
  return [page.label,page.sectionLabel,detail.purpose,...detail.dataSources,...detail.filters,...detail.buttons,detail.logs,detail.risks,...page.permissionCodes]
    .join(' ').toLowerCase().includes(query)
}

export default function AdminManualPage(){
  const access=useAdminAccess()
  const [query,setQuery]=useState('')
  const [sectionId,setSectionId]=useState('')

  const allowed=item=>{
    if(item.allPermissions?.length)return access.hasAllPermissions(item.allPermissions)
    return access.hasAnyPermission(item.permissions||[])
  }

  const visibleSections=useMemo(()=>{
    const needle=text(query).toLowerCase()
    return adminNavigation.map(section=>{
      const rawPages=section.children||[section]
      const pages=rawPages.filter(allowed).map(item=>({
        ...item,
        sectionId:section.id,
        sectionLabel:section.label,
        detail:adminPageDescription(item.label),
        permissionCodes:pagePermissionCodes(item),
      })).filter(page=>searchablePage(page,needle))
      return {...section,pages}
    }).filter(section=>(!sectionId||section.id===sectionId)&&section.pages.length)
  },[access.founder,access.permissionKey,query,sectionId])

  const allAccessibleCount=useMemo(()=>adminNavigation.reduce((total,section)=>
    total+(section.children||[section]).filter(allowed).length,0
  ),[access.founder,access.permissionKey])
  const shownCount=visibleSections.reduce((total,section)=>total+section.pages.length,0)
  const grantedActionCount=visibleSections.reduce((total,section)=>total+section.pages.reduce((pageTotal,page)=>
    pageTotal+page.permissionCodes.filter(code=>access.hasPermission(code)).length,0
  ),0)

  return <div className="admin-manual-page">
    <header className="admin-manual-hero">
      <div><span>ADMIN OPERATIONS HANDBOOK</span><h1>后台功能和用途手册</h1><p>这里按当前账号的实际权限展示可访问页面；未授权页面不会出现在手册中。</p></div>
      <div className="admin-manual-scope"><small>当前数据范围</small><strong>{DATA_SCOPE_NAMES[access.dataScope]||access.dataScope||'由账号权限决定'}</strong><span>有效后台会话 · 服务端仍会再次校验</span></div>
    </header>

    <AdminModuleNav/>

    <section className="admin-manual-notice">
      <strong>使用原则</strong>
      <p>先按员工 ID、日期和业务来源核对，再执行新增、编辑、审批、发布、停用或删除。页面按钮可见不代表可以绕过服务端权限；敏感资料只在工作必要范围内查看。</p>
    </section>

    <section className="admin-manual-toolbar" aria-label="手册筛选">
      <label className="admin-manual-search"><span>搜索功能</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="输入页面、数据来源、按钮、权限或风险"/></label>
      <label><span>模块</span><select value={sectionId} onChange={event=>setSectionId(event.target.value)}><option value="">全部可访问模块</option>{adminNavigation.map(section=><option value={section.id} key={section.id}>{section.label}</option>)}</select></label>
      <button type="button" disabled={!query&&!sectionId} onClick={()=>{setQuery('');setSectionId('')}}>清除筛选</button>
    </section>

    <section className="admin-manual-kpis" aria-label="手册统计">
      <div><small>可访问页面</small><strong>{allAccessibleCount}</strong><span>按当前账号权限计算</span></div>
      <div><small>当前显示</small><strong>{shownCount}</strong><span>{visibleSections.length} 个模块</span></div>
      <div><small>已授权动作</small><strong>{grantedActionCount}</strong><span>含页面查看权限</span></div>
    </section>

    {visibleSections.length?<div className="admin-manual-sections">{visibleSections.map(section=><section className="admin-manual-section" key={section.id}>
      <header><div><span className="admin-manual-module-icon">{section.icon}</span><div><h2>{section.label}</h2><p>{ADMIN_SECTION_DESCRIPTIONS[section.id]||'当前账号可访问的页面。'}</p></div></div><strong>{section.pages.length} 页</strong></header>
      <div className="admin-manual-pages">{section.pages.map(page=><details className="admin-manual-page-card" key={page.to} open={Boolean(query)}>
        <summary><div><strong>{page.label}</strong><p>{page.detail.purpose}</p></div><span>查看说明</span></summary>
        <div className="admin-manual-page-body">
          <div className="admin-manual-detail-grid">
            <section><h3>数据来源</h3><ul>{page.detail.dataSources.map(value=><li key={value}>{value}</li>)}</ul></section>
            <section><h3>筛选条件</h3><ul>{page.detail.filters.map(value=><li key={value}>{value}</li>)}</ul></section>
            <section><h3>页面按钮与操作</h3><ul>{page.detail.buttons.map(value=><li key={value}>{value}</li>)}</ul></section>
            <section><h3>日志规则</h3><p>{page.detail.logs}</p></section>
          </div>

          <section className="admin-manual-permissions">
            <h3>权限动作</h3>
            <div>{page.permissionCodes.map(code=>{
              const granted=access.hasPermission(code)
              return <span className={granted?'granted':'not-granted'} key={code}><b>{permissionAction(code)}</b><code>{code}</code><em>{granted?'已授权':'未授权'}</em></span>
            })}</div>
          </section>

          <section className="admin-manual-risk"><h3>风险提示</h3><p>{page.detail.risks}</p></section>
          <footer><span>访问仍受后台会话、数据范围与服务端权限共同限制。</span><Link to={page.to}>打开“{page.label}” →</Link></footer>
        </div>
      </details>)}</div>
    </section>)}</div>:<div className="admin-manual-empty"><strong>没有匹配的可访问页面</strong><p>请清除筛选或更换关键词。</p><button type="button" onClick={()=>{setQuery('');setSectionId('')}}>显示全部</button></div>}
  </div>
}
