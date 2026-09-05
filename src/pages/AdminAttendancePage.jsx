import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Pagination } from '../components/DataPageControls'
import AdminModuleNav from '../components/AdminModuleNav'
import { useAppToast } from '../components/AppToastProvider'
import { attendanceAmount, attendanceCurrencySummary, attendanceKindLabel, attendanceSourceGroupLabel } from '../components/AttendanceRecords'
import { adminLocalPageTabs, adminTabParams, adminTabSlug, canonicalAdminTab } from '../config/navigation'
import { PERMISSIONS } from '../config/permissions'
import { withMonthlyAttendanceLockRetry } from '../lib/adminAttendanceLockRetry'
import { ATTENDANCE_AUTO_REFRESH_MS, attendanceSyncMeta as syncMeta, attendanceVisibleRefreshDue } from '../lib/attendanceSyncState'
import { adjustmentCategory, adjustmentReason } from '../lib/adjustmentPresentation'
import { useAdminAccess } from '../lib/adminAccess'
import { businessMonthIso, businessTodayIso, businessTodayRange } from '../lib/adminQueryDefaults'
import { supabase } from '../lib/supabase'
import { EmployeeDrawer } from './AdminEmployeesPage'

const TABS=['排班表','出勤表','今日考勤','考勤记录','请假审批','奖金 / 扣款']
const ATTENDANCE_TOAST_MODULE='排班与考勤'
const ATTENDANCE_EVENT_KINDS=new Set(['public_holiday','home_leave','leave','half_day','absence','absent','resignation'])
const text=value=>String(value??'').trim()
const MISSING_TEAM_LABELS=new Set(['未分配团队','未匹配团队','未分团队','未分类','—','-'])
const organizationName=value=>{
  if(!value)return ''
  if(typeof value==='object')return organizationName(value.name||value.team_name||value.teamName||value.label)
  return text(value).normalize('NFKC').replace(/\s+/g,' ')
}
const scheduleTeamName=(row,profile={})=>{
  const values=[
    row?.team_name,row?.team,row?.employee_team_name,row?.profile_team_name,
    row?.employee?.team_name,row?.employee?.team,row?.employee?.teams,
    row?.employee_profile?.team_name,row?.employee_profile?.team,row?.employee_profile?.teams,
    row?.profile?.team_name,row?.profile?.team,row?.profile?.teams,row?.teams,
    profile?.team_name,profile?.team,profile?.teams,
  ]
  return values.map(organizationName).find(value=>value&&!MISSING_TEAM_LABELS.has(value))||''
}
const scheduleTeamKey=value=>organizationName(value).toLocaleLowerCase().replace(/\s+/g,'')
const todayIso=businessTodayIso
const emptyFilters=()=>({search:'',employee_no:'',employee_name:'',date_from:'',date_to:'',source_month:'',source_group:'',work_mode:'',event_kind:'',employee_status:'',currency:'',team:'',position:'',country:'',platform:'',manager:'',match_status:''})
const tabFilters=tab=>{
  const next={
    ...emptyFilters(),
    ...(['今日考勤','考勤记录','请假审批','奖金 / 扣款'].includes(tab)?businessTodayRange():{}),
  }
  if(tab==='请假审批')next.event_kind='leave'
  return next
}
const requestTab=tab=>!['排班表','出勤表'].includes(tab)
const tabScope=tab=>tab==='奖金 / 扣款'?'adjustment':'attendance'
const employeeTypeLabel=row=>{
  const explicit=text(row?.employment_type)
  const mapped={home_ph:'纯居家菲律宾',home_vn:'纯居家',home_id:'纯居家',home_mm:'纯居家',onsite_to_home:'现场转居家'}[explicit.toLowerCase()]
  if(explicit)return mapped||explicit
  return text(row?.source_group).toLowerCase()==='onsite_to_home'?'现场转居家':'纯居家'
}
const employeeStatusLabel=value=>({active:'在职',probation:'试用',suspended:'停用',inactive:'停用',resigned:'离职',unmatched:'未匹配'}[text(value).toLowerCase()]||text(value)||'—')
const employeeWorkMode=row=>{
  const values=[row?.work_mode,row?.source_group,row?.employment_type,row?.employee_type].map(value=>text(value).toLowerCase()).filter(Boolean)
  return values.some(value=>value==='onsite_to_home'||value.includes('现场转居家')||value.includes('onsite'))?'onsite_to_home':'home'
}
const employeeWorkModeLabel=row=>employeeWorkMode(row)==='onsite_to_home'?'现场转居家':'纯居家'
const PHILIPPINES_COUNTRY=/(^|\b)(PH|PHL|PHILIPPINES?|FILIPINO)($|\b)|菲律宾|菲律賓/i
const philippinesEmployee=row=>{
  const country=text(row?.country||row?.nationality)
  if(PHILIPPINES_COUNTRY.test(country))return true
  const employmentType=text(row?.employment_type||row?.employee_type).toLowerCase()
  return employmentType==='home_ph'||/home[_\s-]*ph\b|纯居家[^\n]*菲律宾籍|純居家[^\n]*菲律賓籍|纯居家菲律宾|純居家菲律賓/.test(employmentType)
}
const adjustmentCurrency=row=>employeeWorkMode(row)==='onsite_to_home'?'USD':philippinesEmployee(row)?'PHP':'USD'
const formatNumber=value=>{
  const number=Number(value)
  return Number.isFinite(number)?number.toLocaleString('zh-CN',{maximumFractionDigits:2}):text(value)||'0'
}
const message=error=>error?.message||String(error||'读取失败')
const optionEntries=(values,labeler=value=>value)=>(values||[]).map((item,index)=>{
  if(item&&typeof item==='object'){
    const value=text(item.value??item.key??item.code??item.name??item.label)
    return {value,label:text(item.label??item.title??item.name)||labeler(value),key:`${value}-${index}`}
  }
  const value=text(item)
  return {value,label:labeler(value),key:`${value}-${index}`}
}).filter(item=>item.value)

const normalizeAttendanceRows=rows=>(rows||[]).map(row=>{
  const normalized={...row,employment_type:row.employment_type||row.employee_type||''}
  const eventKind=text(normalized.event_kind).toLowerCase()
  const isAdjustment=normalized.scope==='adjustment'||normalized.kind==='adjustment'||['bonus','reward','deduction','penalty'].includes(eventKind)
  const raw=normalized.raw_values&&typeof normalized.raw_values==='object'&&!Array.isArray(normalized.raw_values)?normalized.raw_values:{}
  return isAdjustment?{...normalized,currency:text(normalized.currency)||text(raw.currency)||adjustmentCurrency(normalized)}:normalized
})

const adjustmentRaw=row=>row?.raw_values&&typeof row.raw_values==='object'&&!Array.isArray(row.raw_values)?row.raw_values:{}
const managedAdjustment=row=>text(adjustmentRaw(row).sync_protocol)==='adjustment-v1'&&Boolean(adjustmentRaw(row).external_id||row?.external_id)
const adjustmentSyncState=row=>{
  if(!managedAdjustment(row))return {key:'readonly',label:'历史记录 · 只读'}
  const state=text(adjustmentRaw(row).google_sync_state).toLowerCase()
  if(state==='synced')return {key:'synced',label:'Google 已同步'}
  if(state==='failed')return {key:'failed',label:'Google 同步失败'}
  return {key:'pending',label:'Google 待同步'}
}

const syncTime=value=>text(value).replace('T',' ').slice(0,19)
const SyncIndicator=({sync})=><div className={`attendance-sync-indicator ${sync?.status||'idle'}`} title={sync?.detail||'等待后端返回同步状态'}><i aria-hidden="true"/><span>{sync?.label||'等待同步状态'}</span>{sync?.last&&<time>{sync?.lastLabel?`${sync.lastLabel} · `:''}{syncTime(sync.last)}</time>}</div>
const AttendanceSyncNotice=({sync})=>sync?.status==='protected'?<div className="attendance-sync-protected" role="status"><div><b>同步受保护，当前展示已保存数据</b><span>{sync.detail}</span></div>{sync.last&&<time>{sync.lastLabel||'保护触发'}：{syncTime(sync.last)}</time>}</div>:null

export default function AdminAttendancePage(){
  const [params,setParams]=useSearchParams()
  const access=useAdminAccess()
  const {notify}=useAppToast()
  const canViewAdjustmentBonus=access.hasPermission(PERMISSIONS.ADJUSTMENT_BONUS_VIEW)
  const canViewAdjustmentDeduction=access.hasPermission(PERMISSIONS.ADJUSTMENT_DEDUCTION_VIEW)
  const canViewAdjustments=access.hasPermission(PERMISSIONS.ADJUSTMENT_PAGE_VIEW)&&(canViewAdjustmentBonus||canViewAdjustmentDeduction)
  const requestedRouteTab=params.get('tab')
  const requestedTab=canonicalAdminTab('/admin/schedule',requestedRouteTab)
  const visibleTabs=access.loading?[]:TABS.filter(value=>{
    if(value==='排班表')return access.hasPermission(PERMISSIONS.SCHEDULE_ROSTER_VIEW)
    if(value==='出勤表')return access.hasPermission(PERMISSIONS.ATTENDANCE_MONTHLY_VIEW)
    if(value==='今日考勤')return access.hasPermission(PERMISSIONS.ATTENDANCE_TODAY_VIEW)
    if(value==='考勤记录')return access.hasPermission(PERMISSIONS.ATTENDANCE_RECORDS_VIEW)
    if(value==='请假审批')return access.hasPermission(PERMISSIONS.ATTENDANCE_LEAVE_VIEW)
    if(value==='奖金 / 扣款')return canViewAdjustments
    return false
  })
  const tab=access.loading?(TABS.includes(requestedTab)?requestedTab:TABS[0]):(visibleTabs.includes(requestedTab)?requestedTab:(visibleTabs[0]||''))
  const [draft,setDraft]=useState(()=>tabFilters(tab))
  const [applied,setApplied]=useState(()=>tabFilters(tab))
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(30)
  const [state,setState]=useState({loading:false,error:'',data:null})
  const [advanced,setAdvanced]=useState(true)
  const [refreshKey,setRefreshKey]=useState(0)
  const [recordDetail,setRecordDetail]=useState(null)
  const [employeeDetail,setEmployeeDetail]=useState(null)
  const [employeeDetailLoading,setEmployeeDetailLoading]=useState(false)
  const [employeeError,setEmployeeError]=useState('')
  const [adjustmentEditor,setAdjustmentEditor]=useState(null)
  const [adjustmentNotice,setAdjustmentNotice]=useState(null)
  const employeeRequest=useRef(0)
  const mainReadIntentRef=useRef('')

  const setTab=value=>{if(visibleTabs.includes(value))setParams(value===TABS[0]?{}:adminTabParams('/admin/schedule',value))}
  useEffect(()=>{
    if(access.loading||!tab)return
    const desiredRouteTab=tab===TABS[0]?null:adminTabSlug('/admin/schedule',tab)
    if(requestedRouteTab===desiredRouteTab)return
    setParams(desiredRouteTab?{tab:desiredRouteTab}:{},{replace:true})
  },[access.loading,access.founder,access.permissionKey,requestedRouteTab,tab,setParams])
  useEffect(()=>{
    const next=tabFilters(tab)
    setDraft(next);setApplied(next);setPage(1);setState({loading:false,error:'',data:null});setEmployeeError('');setAdjustmentEditor(null);setAdjustmentNotice(null)
  },[tab])

  useEffect(()=>{
    if(access.loading||!tab||!requestTab(tab))return undefined
    let alive=true
    const requestedOperation=mainReadIntentRef.current
    mainReadIntentRef.current=''
    const load=async()=>{
      setState(current=>({...current,loading:true,error:''}))
      try{
        const filters={...applied,full_name:applied.employee_name,status:applied.employee_status,scope:tabScope(tab),page,page_size:pageSize}
        if(tab==='今日考勤')filters.date_from=filters.date_to=todayIso()
        if(tab==='请假审批'&&!filters.event_kind)filters.event_kind='leave'
        const rpcName=tab==='今日考勤'?'admin_attendance_today_page':tab==='考勤记录'?'admin_attendance_records_page':tab==='请假审批'?'admin_attendance_leave_page':'admin_adjustment_page'
        const {data,error}=await supabase.rpc(rpcName,{p_filters:filters})
        if(error)throw error
        if(!alive)return
        const result=data||{rows:[],page,pages:1,total:0,page_size:pageSize}
        setState({loading:false,error:'',data:result})
        const pages=Math.max(1,Number(result.pages||1))
        if(page>pages)setPage(pages)
      }catch(error){
        if(!alive)return
        const reason=message(error)
        setState(current=>({loading:false,error:reason,data:current.data}))
        if(requestedOperation)notify({
          type:'error',module:ATTENDANCE_TOAST_MODULE,operation:requestedOperation,reason,
          dedupeKey:'attendance:records:read:error',
          retry:()=>{mainReadIntentRef.current='刷新考勤数据';setRefreshKey(value=>value+1)},retryLabel:'重试',
        })
      }
    }
    load()
    return()=>{alive=false}
  },[access.loading,access.founder,access.permissionKey,tab,applied,page,pageSize,refreshKey])

  const query=()=>{mainReadIntentRef.current='查询考勤数据';setApplied({...draft});setPage(1);setRefreshKey(value=>value+1)}
  const reset=()=>{mainReadIntentRef.current='重置考勤查询';const next=tabFilters(tab);setDraft(next);setApplied(next);setPage(1);setRefreshKey(value=>value+1)}
  const refreshMainList=(operation='刷新考勤数据')=>{mainReadIntentRef.current=operation;setRefreshKey(value=>value+1)}
  const revealSavedAdjustment=result=>{
    const next={
      ...tabFilters('奖金 / 扣款'),
      employee_no:text(result?.employee_no).toUpperCase(),
      date_from:text(result?.event_date).slice(0,10),
      date_to:text(result?.event_date).slice(0,10),
    }
    setAdjustmentEditor(null)
    setAdjustmentNotice({syncState:result?.sync_state||'pending'})
    mainReadIntentRef.current='保存后刷新奖金 / 扣款'
    setDraft(next);setApplied(next);setPage(1);setRefreshKey(value=>value+1)
    notify({
      type:'success',module:ATTENDANCE_TOAST_MODULE,operation:'保存奖金 / 扣款',
      reason:result?.sync_state==='synced'?'Supabase 已保存，Google 已同步。':'Supabase 已保存，Google 正在等待同步。',
      dedupeKey:'attendance:adjustment:save:success',
    })
  }
  const openEmployee=async row=>{
    if(!canViewEmployeeDirectory||!row.employee_id)return
    const sequence=++employeeRequest.current
    setEmployeeError('')
    setEmployeeDetail({employee:{id:row.employee_id,employee_no:row.employee_no,full_name:row.full_name,status:row.employee_status,teams:{name:row.team_name},positions:{name:row.position_name}},missing_fields:[]})
    setEmployeeDetailLoading(true)
    try{
      const {data,error}=await supabase.functions.invoke('admin-employees',{body:{action:'detail',employee_id:row.employee_id}})
      if(sequence!==employeeRequest.current)return
      if(error||data?.error)throw error||new Error(message(data.error))
      setEmployeeDetail(data)
    }catch(error){
      if(sequence!==employeeRequest.current)return
      const reason=`员工档案读取失败：${message(error)}`
      setEmployeeDetail(null);setEmployeeError(reason)
      notify({
        type:'error',module:ATTENDANCE_TOAST_MODULE,operation:'读取员工档案',reason,
        dedupeKey:'attendance:employee-detail:read:error',retry:()=>openEmployee(row),retryLabel:'重试',
      })
    }finally{
      if(sequence===employeeRequest.current)setEmployeeDetailLoading(false)
    }
  }

  const data=state.data||{}
  const rows=useMemo(()=>normalizeAttendanceRows(data.rows||[]),[data.rows])
  const options=data.options||{}
  const subtitle=tab==='排班表'?'按团队和班次快速查看当前人员安排。':tab==='出勤表'?'固定员工资料，横向查看每月 1–31 日出勤记录。':tab==='奖金 / 扣款'?'奖金、扣款与币种清晰分列。':'集中查看员工考勤、请假与离职记录。'
  const pageChrome=adminLocalPageTabs('/admin/schedule',visibleTabs,tab)
  const sectionTitle=pageChrome.active.sectionLabel||'排班与考勤'
  const pageTitle=pageChrome.active.itemLabel||tab
  const canViewEmployeeDirectory=access.hasPermission(PERMISSIONS.EMPLOYEE_DIRECTORY_VIEW)
  const canCreateAdjustment=access.hasPermission(PERMISSIONS.ADJUSTMENT_PAGE_CREATE)&&(canViewAdjustmentBonus||canViewAdjustmentDeduction)
  const canEditAdjustment=access.hasPermission(PERMISSIONS.ADJUSTMENT_PAGE_EDIT)

  return <div className="content-page attendance-page">
    <header className="attendance-page-head">
      <div><small>ATTENDANCE OPERATIONS</small><h1>{sectionTitle}</h1><p>{pageTitle}{subtitle?` · ${subtitle}`:''}</p></div>
      <div className="attendance-head-actions">
        {tab==='奖金 / 扣款'&&canCreateAdjustment&&<button type="button" className="attendance-adjustment-create" onClick={()=>setAdjustmentEditor({mode:'create',row:null})}>＋ 新增奖金 / 扣款</button>}
        {requestTab(tab)&&<button type="button" onClick={()=>refreshMainList()} disabled={state.loading}>{state.loading?'刷新中…':'刷新数据'}</button>}
      </div>
    </header>

    <AdminModuleNav />

    {access.loading&&<div className="attendance-table-state">正在读取页面权限…</div>}
    {!access.loading&&!tab&&<div className="attendance-error" role="alert"><span>当前账号没有排班与考勤页面权限。</span></div>}

    {employeeError&&<div className="attendance-error" role="alert"><span>{employeeError}</span><button type="button" onClick={()=>setEmployeeError('')}>×</button></div>}
    {tab==='排班表'&&<SchedulePane/>}
    {tab==='出勤表'&&<AttendanceMatrixPane/>}

    {requestTab(tab)&&<>
      {tab==='请假审批'&&<div className="attendance-readonly-notice"><b>当前为记录视图</b><span>页面默认筛选“请假”，也可以切换公休、回家、半天等真实类别。</span></div>}
      {tab==='今日考勤'&&<div className="attendance-context-note"><b>{todayIso()}</b><span>仅显示今天已经登记的记录；没有记录不等同于正常出勤。</span></div>}
      {tab==='奖金 / 扣款'&&adjustmentNotice&&<div className={`attendance-adjustment-notice ${adjustmentNotice.syncState==='synced'?'synced':'pending'}`} role="status"><div><b>Supabase 已保存</b><span>{adjustmentNotice.syncState==='synced'?'Google 已同步':'Google 待同步；脚本写入并回执后，刷新即可看到“已同步”。'}</span></div><button type="button" onClick={()=>setAdjustmentNotice(null)} aria-label="关闭提示">×</button></div>}
      <AttendanceFilters tab={tab} draft={draft} setDraft={setDraft} options={options} advanced={advanced} setAdvanced={setAdvanced} loading={state.loading} sync={syncMeta(data)} canViewAdjustmentBonus={canViewAdjustmentBonus} canViewAdjustmentDeduction={canViewAdjustmentDeduction} onQuery={query} onReset={reset}/>
      {state.error&&<div className="attendance-error" role="alert"><span>考勤数据读取失败：{state.error}</span><button type="button" onClick={()=>refreshMainList('重试考勤查询')}>重试</button></div>}
      <AttendanceSummary scope={tabScope(tab)} summary={data.summary||{}} total={Number(data.total||0)} canViewAdjustmentBonus={canViewAdjustmentBonus} canViewAdjustmentDeduction={canViewAdjustmentDeduction}/>
      <AttendanceTable rows={rows} scope={tabScope(tab)} loading={state.loading} hasData={Boolean(state.data)} onEmployee={canViewEmployeeDirectory?openEmployee:null} onDetail={setRecordDetail} canEditAdjustment={canEditAdjustment} onEditAdjustment={row=>setAdjustmentEditor({mode:'edit',row})}/>
      <Pagination page={Number(data.page||page)} pages={Math.max(1,Number(data.pages||1))} total={Number(data.total||0)} pageSize={Number(data.page_size||pageSize)} loading={state.loading} onPage={next=>{mainReadIntentRef.current='查询考勤分页';setPage(next);setRefreshKey(value=>value+1)}} onPageSize={next=>{mainReadIntentRef.current='调整考勤分页';setPageSize(next);setPage(1);setRefreshKey(value=>value+1)}}/>
    </>}

    {recordDetail&&<AttendanceRecordModal row={recordDetail} adjustment={tabScope(tab)==='adjustment'} onClose={()=>setRecordDetail(null)}/>}
    {adjustmentEditor&&<AdjustmentEditorModal record={adjustmentEditor.row} canViewBonus={canViewAdjustmentBonus} canViewDeduction={canViewAdjustmentDeduction} onClose={()=>setAdjustmentEditor(null)} onSaved={revealSavedAdjustment} onRefreshConfirm={()=>refreshMainList('刷新奖金 / 扣款结果')}/>}
    {employeeDetail&&<EmployeeDrawer key={employeeDetail?.employee?.id||employeeDetail?.employee?.employee_no||employeeDetail?.id||'attendance-employee'} detail={employeeDetail} loading={employeeDetailLoading} readOnly onClose={()=>{employeeRequest.current+=1;setEmployeeDetail(null);setEmployeeDetailLoading(false)}}/>}
  </div>
}

function AttendanceFilters({tab,draft,setDraft,options,advanced,setAdvanced,loading,sync,canViewAdjustmentBonus,canViewAdjustmentDeduction,onQuery,onReset}){
  const update=(key,value)=>setDraft(current=>({...current,[key]:value}))
  const allowedKinds=tab==='奖金 / 扣款'?new Set([canViewAdjustmentBonus&&'bonus',canViewAdjustmentDeduction&&'deduction'].filter(Boolean)):ATTENDANCE_EVENT_KINDS
  const kindOptions=optionEntries(options.event_kinds,attendanceKindLabel).filter(item=>allowedKinds.has(item.value.toLowerCase())).map(item=>({...item,label:attendanceKindLabel(item.value)}))
  if(draft.event_kind&&allowedKinds.has(draft.event_kind.toLowerCase())&&!kindOptions.some(item=>item.value===draft.event_kind))kindOptions.unshift({value:draft.event_kind,label:attendanceKindLabel(draft.event_kind),key:`selected-${draft.event_kind}`})
  const allKindsLabel=tab!=='奖金 / 扣款'||(canViewAdjustmentBonus&&canViewAdjustmentDeduction)?'全部类别':canViewAdjustmentBonus?'全部奖金':'全部扣款'
  const select=(label,key,values,allLabel,labeler)=><label><span>{label}</span><select value={draft[key]} onChange={event=>update(key,event.target.value)}><option value="">{allLabel}</option>{optionEntries(values,labeler).map(item=><option value={item.value} key={item.key}>{item.label}</option>)}</select></label>
  return <section className="attendance-filter-card">
    <div className="attendance-filter-main">
      <label className="attendance-search attendance-search-id"><span>员工 ID</span><div><i>⌕</i><input value={draft.employee_no} onChange={event=>update('employee_no',event.target.value)} onKeyDown={event=>event.key==='Enter'&&onQuery()} placeholder="输入员工 ID"/></div></label>
      <label className="attendance-search attendance-search-name"><span>员工姓名</span><div><i>⌕</i><input value={draft.employee_name} onChange={event=>update('employee_name',event.target.value)} onKeyDown={event=>event.key==='Enter'&&onQuery()} placeholder="输入姓名"/></div></label>
      <label className="attendance-search attendance-search-content"><span>{tab==='奖金 / 扣款'?'原因':'原因 / 备注'}</span><div><i>⌕</i><input value={draft.search} onChange={event=>update('search',event.target.value)} onKeyDown={event=>event.key==='Enter'&&onQuery()} placeholder={tab==='奖金 / 扣款'?'搜索原因内容':'搜索原因或备注内容'}/></div></label>
      <button type="button" className="primary-action" onClick={onQuery} disabled={loading}>{loading?'查询中…':'查询'}</button>
      <button type="button" className="secondary-action" onClick={onReset} disabled={loading}>重置</button>
      <button type="button" className="attendance-filter-toggle" onClick={()=>setAdvanced(value=>!value)}>{advanced?'收起筛选':'更多筛选'}</button>
    </div>
    {advanced&&<div className="attendance-filter-grid">
      <label><span>日期起</span><input type="date" value={draft.date_from} disabled={tab==='今日考勤'} onChange={event=>update('date_from',event.target.value)}/></label>
      <label><span>日期止</span><input type="date" value={draft.date_to} disabled={tab==='今日考勤'} onChange={event=>update('date_to',event.target.value)}/></label>
      <label><span>员工类型</span><select value={draft.source_group} onChange={event=>update('source_group',event.target.value)}><option value="">全部员工类型</option><option value="home">纯居家</option><option value="onsite_to_home">现场转居家</option>{optionEntries(options.source_groups,attendanceSourceGroupLabel).filter(item=>!['home','onsite_to_home'].includes(item.value)).map(item=><option value={item.value} key={item.key}>{item.label}</option>)}</select></label>
      <label><span>记录类别</span><select value={allowedKinds.has(draft.event_kind.toLowerCase())?draft.event_kind:''} onChange={event=>update('event_kind',event.target.value)}><option value="">{allKindsLabel}</option>{kindOptions.map(item=><option key={item.key} value={item.value}>{item.label}</option>)}</select></label>
      {tab==='奖金 / 扣款'&&<label><span>币种</span><select value={draft.currency} onChange={event=>update('currency',event.target.value)}><option value="">全部币种（USD + PHP）</option><option value="USD">USD · 美元</option><option value="PHP">PHP · 菲律宾比索</option></select></label>}
      <label><span>员工状态</span><select value={draft.employee_status} onChange={event=>update('employee_status',event.target.value)}><option value="">全部员工状态</option><option value="active">在职</option><option value="probation">试用</option><option value="resigned">离职</option><option value="inactive">停用</option><option value="unmatched">未匹配</option></select></label>
      {select('团队','team',options.teams,'全部团队')}
      {select('岗位','position',options.positions,'全部岗位')}
      {select('员工国家','country',options.countries,'全部国家')}
      {select('盘口 / 平台','platform',options.platforms,'全部盘口')}
      {select('负责人','manager',options.managers,'全部负责人')}
    </div>}
    {sync?.last&&<div className="attendance-filter-foot"><SyncIndicator sync={sync}/><span>页面数据来自 Supabase；这里显示最近一次 Google 表格同步结果。</span></div>}
  </section>
}

function AttendanceSummary({scope,summary,total,canViewAdjustmentBonus,canViewAdjustmentDeduction}){
  const currencySummary=attendanceCurrencySummary(summary)
  const money=(currency,key)=>currencySummary[currency]?`${currency} ${formatNumber(currencySummary[currency]?.[key]||0)}`:'—'
  const count=(currency,key)=>currencySummary[currency]?currencySummary[currency]?.[key]||0:'—'
  const items=scope==='adjustment'?
    [['记录总数',total],...(canViewAdjustmentBonus?[['USD 奖金',`${count('USD','bonus_count')} 笔 · ${money('USD','bonus_total')}`,'positive'],['PHP 奖金',`${count('PHP','bonus_count')} 笔 · ${money('PHP','bonus_total')}`,'positive']]:[]),...(canViewAdjustmentDeduction?[['USD 扣款',`${count('USD','deduction_count')} 笔 · ${money('USD','deduction_total')}`,'negative'],['PHP 扣款',`${count('PHP','deduction_count')} 笔 · ${money('PHP','deduction_total')}`,'negative']]:[]),...(canViewAdjustmentBonus&&canViewAdjustmentDeduction?[['USD 净额',money('USD','net_amount')],['PHP 净额',money('PHP','net_amount')]]:[]),['待核对记录',summary.unmatched||0,'warning'],['币种待核对',summary.currency_review_count||0,'warning'],['金额未解析',summary.incomplete||0,'warning']]:
    [['记录总数 / Records',total],['公休 / Rest day',summary.public_holiday||0],['回家 / Home leave',summary.home_leave||0],['请假 / Leave',summary.leave||0,'warning'],['半天 / Half day',summary.half_day||0,'warning'],['缺席 / Absent',summary.absence||0,'negative'],['离职 / Resigned',summary.resignation||0]]
  return <section className="attendance-summary-grid">{items.map(([label,value,tone])=><div key={label} className={tone||''}><span>{label}</span><strong>{value}</strong></div>)}</section>
}

function AttendanceTable({rows,scope,loading,hasData,onEmployee,onDetail,canEditAdjustment,onEditAdjustment}){
  const adjustment=scope==='adjustment'
  return <section className={`attendance-table-card ${loading&&hasData?'is-loading':''}`}>
    <header><div><h2>{adjustment?'奖金 / 扣款明细':'考勤记录明细'}</h2><p>{adjustment?'Supabase 保存与 Google 写入状态分开显示；仅协议内新增记录可以编辑。':'日期、员工、组织和说明各自独立成列；点击原因或备注可查看完整文字。'}</p></div><span>{loading?'读取中…':`${rows.length} 条 / 本页`}</span></header>
    {!hasData&&loading?<div className="attendance-table-state">正在读取记录…</div>:!rows.length?<div className="attendance-table-state">当前筛选条件下暂无记录</div>:<div className="attendance-table-scroll"><table className={adjustment?'attendance-detail-table adjustment':'attendance-detail-table'}>
      {adjustment&&<colgroup><col className="adjustment-date-col"/><col className="adjustment-hire-col"/><col className="adjustment-employee-col"/><col className="adjustment-type-col"/><col className="adjustment-status-col"/><col className="adjustment-organization-col"/><col className="adjustment-category-col"/><col className="adjustment-money-col"/><col className="adjustment-note-col"/><col className="adjustment-action-col"/></colgroup>}
      {!adjustment&&<colgroup><col className="attendance-date-col"/><col className="attendance-hire-col"/><col className="attendance-id-col"/><col className="attendance-name-col"/><col className="attendance-type-col"/><col className="attendance-country-col"/><col className="attendance-status-col"/><col className="attendance-team-col"/><col className="attendance-position-col"/><col className="attendance-reason-col"/><col className="attendance-note-col"/></colgroup>}
      <thead>{adjustment?<tr><th>日期</th><th>入职日期</th><th>员工</th><th>员工类型 / 国家</th><th>状态</th><th>团队 / 岗位</th><th>类型</th><th>奖惩金额</th><th>原因</th><th>同步 / 操作</th></tr>:<tr><th>日期</th><th>入职日期</th><th>员工 ID</th><th>姓名</th><th>员工类型</th><th>国家</th><th>状态</th><th>团队</th><th>岗位</th><th>原因</th><th>备注</th></tr>}</thead>
      <tbody>{rows.map((row,index)=>{const sync=adjustmentSyncState(row);return <tr key={row.id||`${row.source_key}-${row.source_row}-${index}`}>
        <td className={adjustment?'attendance-adjustment-date-cell':''}><div className="attendance-event-cell"><strong>{row.event_date||'—'}</strong>{!adjustment&&<span className={`attendance-kind kind-${text(row.event_kind).toLowerCase()}`}>{attendanceKindLabel(row.event_kind)}</span>}{!adjustment&&row.is_mirror&&<em>镜像</em>}</div></td>
        <td><span className="attendance-hire-date">{text(row.hire_date).slice(0,10)||'—'}</span></td>
        {adjustment?<><td><div className="attendance-employee-cell">{row.employee_id&&onEmployee?<button type="button" onClick={()=>onEmployee(row)}>{row.employee_no||'未编号'}</button>:<strong>{row.employee_no||(row.employee_id?'未编号':'未匹配')}</strong>}<span>{row.full_name||'—'}</span></div></td><td><div className="attendance-stack"><strong>{employeeTypeLabel(row)}</strong><span>{row.country||'—'}</span></div></td></>:<><td className="attendance-employee-id-cell">{row.employee_id&&onEmployee?<button type="button" onClick={()=>onEmployee(row)}>{row.employee_no||'未编号'}</button>:<strong>{row.employee_no||(row.employee_id?'未编号':'未匹配')}</strong>}</td><td className="attendance-name-cell">{row.full_name||'—'}</td><td>{employeeTypeLabel(row)}</td><td>{row.country||'—'}</td></>}
        <td><div className="attendance-status-stack"><span className={`attendance-employee-status ${text(row.employee_status).toLowerCase()}`}>{employeeStatusLabel(row.employee_status)}</span>{row.needs_review&&<span className="attendance-review-badge" title="员工身份尚未唯一确认，需要人工核对员工ID或姓名">待核对</span>}</div></td>
        {adjustment?<td><div className="attendance-stack"><strong>{row.team_name||'—'}</strong><span>{row.position_name||'—'}</span></div></td>:<><td>{row.team_name||'—'}</td><td>{row.position_name||'—'}</td></>}
        {adjustment&&<td className="attendance-adjustment-category-cell"><span className="attendance-adjustment-category" title={adjustmentCategory(row)}>{adjustmentCategory(row)}</span></td>}
        {adjustment&&<td className="attendance-adjustment-money-cell"><div className="attendance-adjustment-money"><span className={`attendance-kind kind-${text(row.event_kind).toLowerCase()}`}>{attendanceKindLabel(row.event_kind)}</span><div className={`attendance-amount ${text(row.event_kind).toLowerCase()}`}><strong>{attendanceAmount(row)}</strong>{row.raw_amount&&text(row.raw_amount)!==text(row.amount)&&<span>原值 {row.raw_amount}</span>}</div></div></td>}
        {!adjustment&&<td><button type="button" className="attendance-copy-button" title="查看完整原因" onClick={()=>onDetail(row)}>{row.reason||'—'}</button></td>}
        <td className={adjustment?'attendance-adjustment-note-cell':''}><button type="button" className={`attendance-copy-button note${adjustment?' adjustment-note':''}`} title={adjustment?'点击查看完整原因':'点击查看完整备注'} onClick={()=>onDetail(row)}>{adjustment?adjustmentReason(row):(row.note||'—')}</button></td>
        {adjustment&&<td className="attendance-adjustment-action-cell"><span className={`attendance-adjustment-sync ${sync.key}`}>{sync.label}</span>{canEditAdjustment&&managedAdjustment(row)&&<button type="button" className="attendance-adjustment-edit" onClick={()=>onEditAdjustment(row)}>编辑</button>}</td>}
      </tr>})}</tbody>
    </table></div>}
    {loading&&hasData&&<div className="attendance-loading-overlay">正在更新结果…</div>}
  </section>
}

function AttendanceRecordModal({row,adjustment,onClose}){
  return <div className="modal-mask attendance-main-modal-mask" onMouseDown={onClose}><div className="attendance-main-modal" role="dialog" aria-modal="true" aria-labelledby="attendance-main-modal-title" onMouseDown={event=>event.stopPropagation()}>
    <header><div><small>ATTENDANCE DETAIL</small><h2 id="attendance-main-modal-title">{attendanceKindLabel(row.event_kind)} · 完整记录</h2><p>{row.event_date||'—'} · {row.employee_no||'未匹配'} · {row.full_name||'—'}</p></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>
    <div className="attendance-modal-facts">
      <span><small>入职日期</small><b>{text(row.hire_date).slice(0,10)||'—'}</b></span><span><small>员工类型 / 国家</small><b>{[employeeTypeLabel(row),row.country].filter(Boolean).join(' · ')||'—'}</b></span><span><small>员工状态</small><b>{employeeStatusLabel(row.employee_status)}</b></span><span><small>团队 / 岗位</small><b>{[row.team_name,row.position_name].filter(Boolean).join(' · ')||'—'}</b></span>{adjustment&&<><span><small>类型</small><b>{adjustmentCategory(row)}</b></span><span><small>金额 / 原值</small><b>{attendanceAmount(row)}{row.raw_amount?` · ${row.raw_amount}`:''}</b></span></>}
    </div>
    {adjustment?<section><small>完整原因</small><p>{adjustmentReason(row)}</p></section>:<>
      <section><small>完整原因</small><p>{row.reason||'—'}</p></section>
      <section><small>完整备注</small><p>{row.note||'—'}</p></section>
    </>}
    <footer><button type="button" className="secondary-action" onClick={onClose}>关闭</button></footer>
  </div></div>
}

function AdjustmentEditorModal({record,canViewBonus=false,canViewDeduction=false,onClose,onSaved,onRefreshConfirm}){
  const {notify}=useAppToast()
  const editing=Boolean(record)
  const raw=adjustmentRaw(record)
  const inferredWorkbook=text(raw.workbook_key)||(
    text(record?.source_key).includes('home_ph')?'home_ph':
    text(record?.source_key).includes('home_vim')?'home_vim':'onsite'
  )
  const inferredMonth=text(raw.source_month)||text(record?.event_date).slice(0,7)||'2026-09'
  const workbookCurrencies={onsite:'USD',home_vim:'USD',home_ph:'PHP'}
  const [draft,setDraft]=useState(()=>({
    workbook_key:inferredWorkbook,
    source_month:inferredMonth,
    employee_no:text(record?.employee_no),
    event_date:text(record?.event_date).slice(0,10)||`${inferredMonth}-01`,
    amount:record?.amount==null?'':String(record.amount),
    currency:text(raw.currency||record?.currency)||workbookCurrencies[inferredWorkbook],
    category:text(raw.category||record?.reason),
    note:text(record?.note),
  }))
  const [state,setState]=useState({loading:true,saving:false,error:'',options:{workbooks:[],months:[],employees:[]}})

  useEffect(()=>{
    let alive=true
    const load=async()=>{
      try{
        const {data,error}=await supabase.rpc('admin_adjustment_editor_options',{p_search:'',p_limit:200})
        if(error)throw error
        if(alive)setState(current=>({...current,loading:false,options:data||current.options}))
      }catch(error){
        if(alive)setState(current=>({...current,loading:false,error:`编辑选项读取失败：${message(error)}`}))
      }
    }
    load()
    return()=>{alive=false}
  },[])

  const update=(key,value)=>setDraft(current=>{
    if(key==='workbook_key')return {...current,workbook_key:value,currency:workbookCurrencies[value]||''}
    if(key==='source_month')return {...current,source_month:value,event_date:`${value}-01`}
    return {...current,[key]:value}
  })
  const employees=state.options.employees||[]
  const selectedEmployee=employees.find(employee=>text(employee.employee_no).toUpperCase()===text(draft.employee_no).toUpperCase())
  const workbooks=(state.options.workbooks||[]).length?state.options.workbooks:[
    {key:'onsite',label:'现场转居家',currency:'USD'},
    {key:'home_vim',label:'居家越南 / 印尼 / 缅甸',currency:'USD'},
    {key:'home_ph',label:'居家菲律宾',currency:'PHP'},
  ]
  const months=(state.options.months||[]).length?state.options.months:['2026-09','2026-10','2026-11','2026-12']
  const monthEnd=['09','11'].includes(draft.source_month.slice(5,7))?'30':'31'
  const amountMin=canViewBonus&&!canViewDeduction?'0.01':'-100000000'
  const amountMax=canViewDeduction&&!canViewBonus?'-0.01':'100000000'
  const amountRule=canViewBonus&&canViewDeduction
    ?'正数 = 奖金，负数 = 扣除；币种由所选工作簿固定，不能手动混用。'
    :canViewBonus
      ?'当前权限只可录入或编辑奖金，金额必须为正数。'
      :'当前权限只可录入或编辑扣款，金额必须为负数。'

  const submit=async event=>{
    event.preventDefault()
    const numericAmount=Number(draft.amount)
    if((numericAmount>0&&!canViewBonus)||(numericAmount<0&&!canViewDeduction)){
      const reason=canViewBonus?'当前账号只有奖金权限，不能保存扣款。':'当前账号只有扣款权限，不能保存奖金。'
      setState(current=>({...current,saving:false,error:`保存失败：${reason}`}))
      return
    }
    setState(current=>({...current,saving:true,error:''}))
    const currentRevision=Number(record?.sync_revision)||Number(raw.revision)||0
    const payload={
      ...(editing?{id:record.id,expected_revision:currentRevision}:{}),
      workbook_key:draft.workbook_key,
      source_month:draft.source_month,
      employee_no:text(draft.employee_no).toUpperCase(),
      event_date:draft.event_date,
      amount:draft.amount,
      currency:draft.currency,
      category:text(draft.category),
      note:text(draft.note),
    }
    try{
      const {data,error}=await supabase.rpc('admin_adjustment_upsert',{p_payload:payload})
      if(error||!data?.ok)throw error||new Error(message(data?.error||'未知错误'))
      setState(current=>({...current,saving:false}))
      onSaved({...data,event_date:draft.event_date,employee_no:payload.employee_no})
    }catch(error){
      const detail=message(error)
      const explanation=detail.includes('adjustment_revision_conflict')?'这条记录已被其他操作更新，请关闭窗口、刷新后再编辑。':detail
      const reason=`保存失败：${explanation}`
      setState(current=>({...current,saving:false,error:reason}))
      notify({
        type:'error',module:ATTENDANCE_TOAST_MODULE,operation:editing?'编辑奖金 / 扣款':'新增奖金 / 扣款',reason,
        dedupeKey:`attendance:adjustment:${editing?'update':'create'}:error`,
        retry:onRefreshConfirm,retryLabel:'刷新确认',
      })
    }
  }

  return <div className="modal-mask attendance-main-modal-mask" onMouseDown={state.saving?undefined:onClose}><form className="attendance-main-modal adjustment-editor-modal" role="dialog" aria-modal="true" aria-labelledby="adjustment-editor-title" onMouseDown={event=>event.stopPropagation()} onSubmit={submit}>
    <header><div><small>ADJUSTMENT EDITOR</small><h2 id="adjustment-editor-title">{editing?'编辑奖金 / 扣款':'新增奖金 / 扣款'}</h2><p>先保存 Supabase，再由每分钟同步任务写入指定 Google 月份区块。</p></div><button type="button" aria-label="关闭" disabled={state.saving} onClick={onClose}>×</button></header>
    <div className="adjustment-editor-callout"><b>金额与权限规则</b><span>{amountRule}</span></div>
    {state.error&&<div className="attendance-error adjustment-editor-error" role="alert"><span>{state.error}</span></div>}
    <div className="adjustment-editor-grid">
      <label><span>来源工作簿 / 范围 <em>必填</em></span><select value={draft.workbook_key} disabled={editing||state.loading||state.saving} onChange={event=>update('workbook_key',event.target.value)}>{workbooks.map(item=><option value={item.key} key={item.key}>{item.label}</option>)}</select>{editing&&<small>编辑时不可移动到另一份表</small>}</label>
      <label><span>月份 <em>必填</em></span><select value={draft.source_month} disabled={editing||state.loading||state.saving} onChange={event=>update('source_month',event.target.value)}>{months.map(month=><option value={month} key={month}>{month}</option>)}</select>{editing&&<small>编辑时不可移动月份</small>}</label>
      <label><span>员工 ID <em>必填</em></span><input list="adjustment-employee-options" value={draft.employee_no} disabled={state.saving} onChange={event=>update('employee_no',event.target.value)} placeholder="输入或选择员工 ID" required/><datalist id="adjustment-employee-options">{employees.map(employee=><option value={employee.employee_no} key={employee.id}>{employee.full_name} · {employee.team_name||'未分团队'}</option>)}</datalist><small>{selectedEmployee?`${selectedEmployee.full_name} · ${selectedEmployee.position_name||'未设岗位'}`:'保存时会再次核对员工与管理范围'}</small></label>
      <label><span>日期 <em>必填</em></span><input type="date" min={`${draft.source_month}-01`} max={`${draft.source_month}-${monthEnd}`} value={draft.event_date} disabled={state.saving} onChange={event=>update('event_date',event.target.value)} required/></label>
      <label><span>币种 <em>固定</em></span><input value={draft.currency} readOnly aria-readonly="true"/></label>
      <label><span>金额 <em>必填</em></span><input type="number" step="0.01" min={amountMin} max={amountMax} value={draft.amount} disabled={state.saving} onChange={event=>update('amount',event.target.value)} placeholder={canViewBonus&&canViewDeduction?'例如 50 或 -20':canViewBonus?'例如 50':'例如 -20'} required/><small>{Number(draft.amount)>0?'将记录为奖金':Number(draft.amount)<0?'将记录为扣除':'不能填写 0'}</small></label>
      <label><span>类型 <em>必填</em></span><input maxLength="200" value={draft.category} disabled={state.saving} onChange={event=>update('category',event.target.value)} placeholder="例如：迟到 / 超时、质量奖励" required/><small>{draft.workbook_key==='home_ph'?'保存到菲律宾九列表的“类型”列；日期仍按上下半月区块同步':'保存到 Google 表格的“类型”列，也可在后台搜索'}</small></label>
      <label className="adjustment-editor-note"><span>原因 <em>必填</em></span><textarea rows="4" maxLength="4000" value={draft.note} disabled={state.saving} onChange={event=>update('note',event.target.value)} placeholder="说明奖金或扣除原因" required/><small>保存到 Google 表格的“备注”列</small></label>
    </div>
    <footer><div><b>保存结果会明确分两步显示</b><span>Supabase 已保存 → Google 待同步 / 已同步</span></div><button type="button" className="secondary-action" disabled={state.saving} onClick={onClose}>取消</button><button type="submit" className="primary-action" disabled={state.loading||state.saving}>{state.saving?'正在保存 Supabase…':editing?'保存修改':'保存并进入同步队列'}</button></footer>
  </form></div>
}

function SchedulePane(){
  const {notify}=useAppToast()
  const blank=()=>({employee_no:'',employee_name:'',work_mode:'',employee_status:'',team:'',group:'',position:'',shift:'',country:'',platform:'',manager:''})
  const [draft,setDraft]=useState(blank)
  const [applied,setApplied]=useState(blank)
  const [refreshKey,setRefreshKey]=useState(0)
  const [selected,setSelected]=useState(null)
  const [state,setState]=useState({loading:true,error:'',rows:[],options:{},summary:{},identityIssues:{},sourceQuality:{},sync:syncMeta({})})
  const readIntentRef=useRef('')
  useEffect(()=>{
    let alive=true
    const requestedOperation=readIntentRef.current
    readIntentRef.current=''
    const load=async()=>{
      setState(current=>({...current,loading:true,error:''}))
      try{
        const serverFilters={...applied,work_mode:applied.work_mode,employment_type:''}
        const {data,error}=await supabase.rpc('admin_attendance_schedule',{p_filters:serverFilters})
        if(error)throw error
        if(!alive)return
        const payload=data||{}
        const rawRows=payload.rows||payload.employees||payload.schedule||[]
        const profiles=[payload.employee_profiles,payload.profiles,payload.employee_directory,payload.directory].find(Array.isArray)||[]
        if(!alive)return
        const profilesById=new Map(profiles.map(profile=>[text(profile.id||profile.employee_id),profile]).filter(([key])=>key))
        const profilesByNo=new Map(profiles.map(profile=>[text(profile.employee_no||profile.staff_id).toUpperCase(),profile]).filter(([key])=>key))
        const refreshedAt=rawRows.map(row=>text(row?.refreshed_at)).filter(Boolean).sort().at(-1)||''
        const rows=rawRows.map((row,index)=>{
          const employeeNo=text(row.employee_no||row.staff_id||row.employee_code)
          const profile=profilesById.get(text(row.employee_id||row.id))||profilesByNo.get(employeeNo.toUpperCase())||{}
          return {
            ...row,
            id:row.id||row.employee_id||`${employeeNo||row.full_name}-${index}`,
            employee_no:employeeNo,
            full_name:row.full_name||row.employee_name||row.name||profile.full_name||'',
            team_name:scheduleTeamName(row,profile)||'未分配团队',
            group_name:row.group_name||row.group||row.team_group||profile.group_name||'',
            shift_name:row.shift_display||row.shift_raw||row.shift_name||row.shift||profile.shift_name||'',
            shift_bucket:row.shift_bucket||shiftTone(row.shift_display||row.shift_raw||row.shift_name||row.shift||profile.shift_name),
            position_name:row.position_name||row.position||profile.position_name||profile.positions?.name||'',
            country:row.country_name||row.country||row.nationality||profile.country||profile.nationality||'',
            platform:row.platform_name||row.platform||row.platform_scope||profile.platform||profile.platform_scope||'',
            manager:row.responsible||row.manager||profile.responsible||profile.manager||profile.leader_name||'',
            work_mode:row.work_mode||row.source_group||profile.work_mode||profile.source_group||employeeWorkMode({...profile,...row}),
          }
        })
        setState({
          loading:false,
          error:'',
          rows,
          options:payload.options||payload.filters||{},
          summary:payload.summary||{},
          identityIssues:payload.identity_issues||{},
          sourceQuality:payload.source_quality||{},
          sync:syncMeta({...payload,refreshed_at:payload.refreshed_at||refreshedAt}),
        })
      }catch(error){
        if(!alive)return
        const reason=message(error)
        setState(current=>({...current,loading:false,error:reason}))
        if(requestedOperation)notify({
          type:'error',module:ATTENDANCE_TOAST_MODULE,operation:requestedOperation,reason,
          dedupeKey:'attendance:schedule:read:error',
          retry:()=>{readIntentRef.current='刷新排班';setRefreshKey(value=>value+1)},retryLabel:'重试',
        })
      }
    }
    load()
    return()=>{alive=false}
  },[applied,refreshKey])
  const optionValues=(key,selector)=>{
    const supplied=state.options?.[key]||state.options?.[`${key}s`]||[]
    const values=[...supplied.map(item=>text(item?.value??item?.name??item?.label??item)),...state.rows.map(selector)]
    return Array.from(new Set(values.map(text).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN'))
  }
  const teams=useMemo(()=>{
    const values=new Map()
    state.rows.forEach(row=>{
      const name=scheduleTeamName(row)||'未分配团队'
      const key=scheduleTeamKey(name)||'__unassigned__'
      if(!values.has(key))values.set(key,name)
    })
    return Array.from(values.values()).sort((a,b)=>a.localeCompare(b,'zh-CN'))
  },[state.rows])
  const groups=useMemo(()=>optionValues('group',row=>row.group_name),[state.options,state.rows])
  const positions=useMemo(()=>optionValues('position',row=>row.position_name),[state.options,state.rows])
  const shifts=useMemo(()=>optionValues('shift',row=>row.shift_name).sort(shiftSort),[state.options,state.rows])
  const countries=useMemo(()=>optionValues('country',row=>row.country),[state.options,state.rows])
  const platforms=useMemo(()=>optionValues('platform',row=>row.platform),[state.options,state.rows])
  const visibleRows=useMemo(()=>state.rows.filter(employee=>{
    const includes=(value,needle)=>!needle||text(value).toLowerCase().includes(text(needle).toLowerCase())
    return includes(employee.employee_no,applied.employee_no)
      &&includes(employee.full_name,applied.employee_name)
      &&(!applied.work_mode||employeeWorkMode(employee)===applied.work_mode)
      &&(!applied.employee_status||text(employee.employee_status).toLowerCase()===text(applied.employee_status).toLowerCase())
      &&(!applied.team||scheduleTeamKey(employee.team_name)===scheduleTeamKey(applied.team))
      &&(!applied.group||text(employee.group_name)===applied.group)
      &&(!applied.position||text(employee.position_name)===applied.position)
      &&(!applied.shift||text(employee.shift_name)===applied.shift)
      &&(!applied.country||text(employee.country)===applied.country)
      &&(!applied.platform||text(employee.platform)===applied.platform)
      &&includes(employee.manager,applied.manager)
  }),[state.rows,applied])
  const counts=useMemo(()=>visibleRows.reduce((result,employee)=>{const key=employee.shift_bucket||shiftTone(employee.shift_name);result[key]=(result[key]||0)+1;return result},{day:0,mid:0,night:0,other:0}),[visibleRows])
  const matrix=useMemo(()=>{
    const teamsMap=new Map()
    visibleRows.forEach(employee=>{
      const teamName=scheduleTeamName(employee)||'未分配团队'
      const teamKey=scheduleTeamKey(teamName)||'__unassigned__'
      if(!teamsMap.has(teamKey))teamsMap.set(teamKey,{team:teamName,day:[],mid:[],night:[],other:[]})
      teamsMap.get(teamKey)[employee.shift_bucket||shiftTone(employee.shift_name)].push(employee)
    })
    return Array.from(teamsMap.values()).sort((a,b)=>a.team.localeCompare(b.team,'zh-CN'))
  },[visibleRows])
  const update=(key,value)=>setDraft(current=>({...current,[key]:value}))
  const apply=()=>{readIntentRef.current='查询排班';setApplied({...draft});setRefreshKey(value=>value+1)}
  const reset=()=>{readIntentRef.current='重置排班查询';const next=blank();setDraft(next);setApplied(next);setRefreshKey(value=>value+1)}
  const refreshSchedule=(operation='刷新排班')=>{readIntentRef.current=operation;setRefreshKey(value=>value+1)}
  const missingEmployeeIds=state.identityIssues?.missing_employee_id||[]
  const unmatchedEmployees=state.identityIssues?.unmatched_employee||[]
  const sourceIncomplete=state.sourceQuality?.healthy===false
  const showUnmatched=()=>{readIntentRef.current='查询未匹配排班资料';const next={...blank(),employee_status:'unmatched'};setDraft(next);setApplied(next);setRefreshKey(value=>value+1)}
  return <>
    <section className="schedule-overview"><div><span>早班 / 白班</span><strong>{counts.day}</strong></div><div><span>中班</span><strong>{counts.mid}</strong></div><div><span>晚班 / 夜班</span><strong>{counts.night}</strong></div><div><span>其他 / 未设置</span><strong>{counts.other}</strong></div></section>
    <section className="attendance-filter-card schedule-search-card">
      <div className="attendance-filter-main">
        <label className="attendance-search attendance-search-id"><span>员工 ID</span><div><i>⌕</i><input value={draft.employee_no} onChange={event=>update('employee_no',event.target.value)} onKeyDown={event=>event.key==='Enter'&&apply()} placeholder="输入员工 ID"/></div></label>
        <label className="attendance-search attendance-search-name"><span>员工姓名</span><div><i>⌕</i><input value={draft.employee_name} onChange={event=>update('employee_name',event.target.value)} onKeyDown={event=>event.key==='Enter'&&apply()} placeholder="输入姓名"/></div></label>
        <button type="button" className="primary-action" onClick={apply} disabled={state.loading}>查询</button><button type="button" className="secondary-action" onClick={reset} disabled={state.loading}>重置</button><button type="button" className="attendance-filter-toggle" onClick={()=>refreshSchedule()} disabled={state.loading}>{state.loading?'读取中…':'刷新排班'}</button>
      </div>
      <div className="attendance-filter-grid schedule-filter-grid">
        <label><span>员工类型</span><select value={draft.work_mode} onChange={event=>update('work_mode',event.target.value)}><option value="">全部员工类型</option><option value="home">纯居家</option><option value="onsite_to_home">现场转居家</option></select></label>
        <label><span>员工状态</span><select value={draft.employee_status} onChange={event=>update('employee_status',event.target.value)}><option value="">全部员工状态</option><option value="active">在职</option><option value="probation">试用</option><option value="suspended">停用</option><option value="resigned">离职</option><option value="unmatched">未匹配</option></select></label>
        <label><span>团队</span><select value={draft.team} onChange={event=>update('team',event.target.value)}><option value="">全部团队</option>{teams.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>组别</span><select value={draft.group} onChange={event=>update('group',event.target.value)}><option value="">全部组别</option>{groups.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>岗位</span><select value={draft.position} onChange={event=>update('position',event.target.value)}><option value="">全部岗位</option>{positions.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>班次</span><select value={draft.shift} onChange={event=>update('shift',event.target.value)}><option value="">全部班次</option>{shifts.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>员工国家</span><select value={draft.country} onChange={event=>update('country',event.target.value)}><option value="">全部国家</option>{countries.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>盘口 / 平台</span><select value={draft.platform} onChange={event=>update('platform',event.target.value)}><option value="">全部盘口</option>{platforms.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>负责人</span><input value={draft.manager} onChange={event=>update('manager',event.target.value)} onKeyDown={event=>event.key==='Enter'&&apply()} placeholder="负责人 / 培训 / 组长"/></label>
      </div>
      <div className="attendance-filter-foot"><SyncIndicator sync={state.sync}/><span>页面查询 Supabase；Google 排班变更由同步任务写入后在此刷新。</span></div>
    </section>
    {!state.loading&&sourceIncomplete&&<section className="schedule-identity-warning source-incomplete" role="alert"><div><strong>Google 排班本次读取不完整</strong><p>当前快照只有 <b>{state.sourceQuality.current_count||0}</b> 人，近期完整值为 <b>{state.sourceQuality.recent_good_peak||0}</b> 人。已启用完整性保护，不会用这份不完整资料回填负责人；请等 Google 表格加载完成后再刷新。</p></div><button type="button" className="secondary-action" onClick={()=>refreshSchedule('重新检查排班')}>重新检查</button></section>}
    {!state.loading&&!sourceIncomplete&&(missingEmployeeIds.length>0||unmatchedEmployees.length>0)&&<section className="schedule-identity-warning" role="status"><div><strong>排班资料需要核对</strong><p>{missingEmployeeIds.length>0?<><b>{missingEmployeeIds.length} 人没有员工 ID</b>：{missingEmployeeIds.slice(0,4).map(item=>`${item.full_name||'未命名'}（Google 第 ${item.source_row||'—'} 行）`).join('、')}{missingEmployeeIds.length>4?`，另 ${missingEmployeeIds.length-4} 人`:''}。</>:null}{unmatchedEmployees.length>missingEmployeeIds.length?` 另有 ${unmatchedEmployees.length-missingEmployeeIds.length} 人有 ID 但未匹配员工档案。`:''}补齐 ID 或员工档案后，人数就能持续保持一致。</p></div><button type="button" className="secondary-action" onClick={showUnmatched}>只看未匹配（{unmatchedEmployees.length}）</button></section>}
    {state.error&&<div className="attendance-error"><span>排班读取失败：{state.error}</span><button type="button" onClick={()=>refreshSchedule('重试排班查询')}>重试</button></div>}
    <section className="attendance-table-card schedule-matrix-card"><header><div><h2>团队 × 班次</h2><p>每格显示总人数与前 6 名，点击格子查看该团队该班次的完整名单。</p></div><span>{state.loading?'读取中…':`${visibleRows.length} 人 · ${matrix.length} 个团队`}</span></header>{state.loading&&!state.rows.length?<div className="attendance-table-state">正在读取排班…</div>:!matrix.length?<div className="attendance-table-state">暂无符合条件的排班员工</div>:<div className="schedule-team-matrix-scroll"><div className="schedule-team-matrix"><div className="schedule-team-row head"><div>团队</div><div>早班 / 白班</div><div>中班</div><div>晚班 / 夜班</div><div>其他 / 未设置</div></div>{matrix.map(teamRow=><div className="schedule-team-row" key={teamRow.team}><div className="schedule-team-name"><strong title={teamRow.team}>{teamRow.team}</strong><span>{teamRow.day.length+teamRow.mid.length+teamRow.night.length+teamRow.other.length} 人</span></div>{['day','mid','night','other'].map(tone=><button type="button" className={`schedule-team-cell ${tone}`} key={tone} onClick={()=>setSelected({team:teamRow.team,tone,people:teamRow[tone]})} disabled={!teamRow[tone].length}><strong>{teamRow[tone].length}<small>人</small></strong><span title={teamRow[tone].map(person=>person.full_name||person.employee_no).join('、')}>{teamRow[tone].slice(0,6).map(person=>person.full_name||person.employee_no).join('、')||'无人排班'}</span>{teamRow[tone].length>6&&<em>另有 {teamRow[tone].length-6} 人</em>}</button>)}</div>)}</div></div>}
      {state.loading&&state.rows.length>0&&<div className="attendance-loading-overlay">正在更新排班…</div>}
    </section>
    {selected&&<ScheduleRosterModal data={selected} onClose={()=>setSelected(null)}/>}
  </>
}

function ScheduleRosterModal({data,onClose}){
  const label={day:'早班 / 白班',mid:'中班',night:'晚班 / 夜班',other:'其他 / 未设置'}[data.tone]||'班次'
  return <div className="modal-mask attendance-main-modal-mask" onMouseDown={onClose}><div className="attendance-main-modal schedule-roster-modal" role="dialog" aria-modal="true" onMouseDown={event=>event.stopPropagation()}><header><div><small>SCHEDULE ROSTER</small><h2>{data.team} · {label}</h2><p>共 {data.people.length} 人</p></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></header><div className="schedule-roster-list">{data.people.map(person=><article key={person.id}><div><strong title={person.full_name||'—'}>{person.full_name||'—'}</strong><span title={`${person.employee_no||'—'} · ${person.group_name||'未分组'}`}>{person.employee_no||'—'} · {person.group_name||'未分组'}</span></div><div><strong title={person.position_name||'—'}>{person.position_name||'—'}</strong><span title={`${person.country||'—'} · ${person.platform||'—'}`}>{person.country||'—'} · {person.platform||'—'}</span></div><div><strong>{text(person.hire_date).slice(0,10)||'—'}</strong><span>入职日期 · {employeeStatusLabel(person.employee_status||person.status)}</span></div><div><strong title={person.manager||'—'}>{person.manager||'—'}</strong><span>负责人 · {employeeWorkModeLabel(person)}</span></div><span className={`schedule-shift ${data.tone}`}>{canonicalShift(person.shift_name)||label}</span></article>)}</div><footer><button type="button" className="secondary-action" onClick={onClose}>关闭</button></footer></div></div>
}

const canonicalShift=value=>{
  const raw=text(value).replace(/\s+/g,' ')
  const compact=raw.replace(/\s+/g,'').toUpperCase()
  if(!compact)return ''
  if(/(DAY|早班|白班)/.test(compact))return '早班 / Day'
  if(/(NIGHT|晚班|夜班)/.test(compact))return '晚班 / Night'
  if(/(MID|中班)/.test(compact))return raw
  return raw
}
const shiftTone=value=>{
  const normalized=canonicalShift(value).toUpperCase()
  if(/(DAY|早班|白班)/.test(normalized))return 'day'
  if(/(NIGHT|晚班|夜班)/.test(normalized))return 'night'
  if(/(MID|中班)/.test(normalized))return 'mid'
  return 'other'
}
const shiftSort=(a,b)=>{
  const rank=value=>({day:0,mid:1,night:2,other:3}[shiftTone(value)]??4)
  return rank(a)-rank(b)||text(a).localeCompare(text(b),'zh-CN')
}

const monthValue=businessMonthIso
const monthMeta=value=>{
  const [year,month]=text(value).split('-').map(Number)
  const safeYear=year||new Date().getFullYear(),safeMonth=month||new Date().getMonth()+1
  const count=new Date(safeYear,safeMonth,0).getDate()
  return {days:Array.from({length:count},(_,index)=>index+1),from:`${safeYear}-${String(safeMonth).padStart(2,'0')}-01`,to:`${safeYear}-${String(safeMonth).padStart(2,'0')}-${String(count).padStart(2,'0')}`}
}
const matrixPersonKey=row=>text(row.employee_id)||text(row.id)||text(row.employee_no).toUpperCase()
const matrixKindMeta=value=>({
  public_holiday:['公','public_holiday'],home_leave:['回','home_leave'],leave:['请','leave'],half_day:['半','half_day'],absence:['缺','absence'],absent:['缺','absence'],resignation:['离','resignation'],
}[text(value).toLowerCase()]||null)

const matrixKinds=['public_holiday','home_leave','leave','half_day','absence','resignation']
const matrixKindKey=value=>{
  const kind=text(value).toLowerCase()
  if(kind==='absent')return 'absence'
  return matrixKinds.includes(kind)?kind:''
}
const dateOnly=value=>{
  const match=text(value).match(/^\d{4}-\d{2}-\d{2}/)
  return match?.[0]||''
}
const matrixRawRecords=(employee,day,month)=>{
  const date=`${month}-${String(day).padStart(2,'0')}`
  const raw=employee.days?.[day]??employee.days?.[String(day)]??employee.days?.[date]??[]
  return Array.isArray(raw)?raw:(raw?[raw]:[])
}
const matrixEventPriority=kind=>({resignation:0,absence:1,leave:2,home_leave:3,public_holiday:4,half_day:5}[matrixKindKey(kind)]??9)
const matrixPrimaryRecord=records=>[...records].sort((a,b)=>matrixEventPriority(a.event_kind||a.kind||a.status)-matrixEventPriority(b.event_kind||b.kind||b.status))[0]||null
const matrixResignationWindow=(employee,month)=>{
  const directStart=dateOnly(employee.resign_date||employee.resignation_date||employee.resigned_at||employee.termination_date||employee.exit_date||employee.last_working_date)
  const directEnd=dateOnly(employee.rehire_date||employee.rehired_at||employee.reactivation_date||employee.return_date)
  const periods=employee.resignation_periods||employee.lifecycle_periods||employee.resigned_ranges||[]
  const normalizedPeriods=(Array.isArray(periods)?periods:[]).map(period=>({start:dateOnly(period.start||period.from||period.resign_date||period.resigned_at),end:dateOnly(period.end||period.to||period.rehire_date||period.rehired_at)})).filter(period=>period.start)
  const eventDates=[]
  Object.entries(employee.days||{}).forEach(([key,value])=>{
    const day=Number(key)||Number(dateOnly(key).slice(-2))
    const records=Array.isArray(value)?value:(value?[value]:[])
    if(day&&records.some(record=>matrixKindKey(record.event_kind||record.kind||record.status)==='resignation'))eventDates.push(`${month}-${String(day).padStart(2,'0')}`)
  })
  const inferredStart=[directStart,...eventDates].filter(Boolean).sort()[0]
  if(inferredStart)normalizedPeriods.push({start:inferredStart,end:directEnd})
  return normalizedPeriods
}
const matrixDayRecords=(employee,day,month)=>{
  const date=`${month}-${String(day).padStart(2,'0')}`
  const records=matrixRawRecords(employee,day,month)
  const resigned=matrixResignationWindow(employee,month).some(period=>date>=period.start&&(!period.end||date<period.end))
  if(!resigned)return records
  const remaining=records.filter(record=>matrixKindKey(record.event_kind||record.kind||record.status)!=='resignation')
  const resignation=records.find(record=>matrixKindKey(record.event_kind||record.kind||record.status)==='resignation')||{event_kind:'resignation',reason:'员工已离职',note:'离职日期起由系统连续标记'}
  return [resignation,...remaining]
}
const matrixEffectiveDayRecords=(employee,day,month)=>{
  const date=`${month}-${String(day).padStart(2,'0')}`
  const raw=employee.effective_days?.[day]??employee.effective_days?.[String(day)]??employee.effective_days?.[date]
  if(raw!==undefined&&raw!==null)return Array.isArray(raw)?raw:(raw?[raw]:[])
  const returnDate=dateOnly(employee.rehire_date||employee.rehired_at||employee.reactivation_date||employee.return_date)
  const candidates=matrixDayRecords(employee,day,month).filter(record=>!(returnDate&&date>=returnDate&&matrixKindKey(record.event_kind||record.kind||record.status)==='resignation'))
  const primary=matrixPrimaryRecord(candidates)
  return primary?[primary]:[]
}
const matrixSummaryFor=(employee,bounds,month)=>{
  const fallback={public_holiday:0,home_leave:0,leave:0,half_day:0,absence:0,resignation:0}
  bounds.days.forEach(day=>{
    const primary=matrixPrimaryRecord(matrixEffectiveDayRecords(employee,day,month))
    const kind=matrixKindKey(primary?.event_kind||primary?.kind||primary?.status)
    if(kind)fallback[kind]+=kind==='half_day'?0.5:1
  })
  return {...fallback,total:matrixKinds.reduce((sum,kind)=>sum+Number(fallback[kind]||0),0)}
}
const matrixSummaryLabels={public_holiday:'公',home_leave:'回',leave:'请',half_day:'半',absence:'缺',resignation:'离'}
const formatDayCount=value=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:1})
const matrixOverviewFor=(people,bounds,month,scope='page')=>{
  const empty=()=>Object.fromEntries(matrixKinds.map(kind=>[kind,{days:0,people:new Set()}]))
  const monthly=empty()
  const daily=bounds.days.map(day=>({day,...empty()}))
  people.forEach((employee,index)=>bounds.days.forEach(day=>{
    const primary=matrixPrimaryRecord(matrixEffectiveDayRecords(employee,day,month))
    const kind=matrixKindKey(primary?.event_kind||primary?.kind||primary?.status)
    if(!kind)return
    const key=matrixPersonKey(employee)||`row-${index}`
    const weight=kind==='half_day'?0.5:1
    monthly[kind].days+=weight
    monthly[kind].people.add(key)
    daily[day-1][kind].days+=weight
    daily[day-1][kind].people.add(key)
  }))
  return {scope,monthly,daily,totalDays:matrixKinds.reduce((sum,kind)=>sum+monthly[kind].days,0),totalPeople:new Set(matrixKinds.flatMap(kind=>[...monthly[kind].people])).size}
}
const matrixOverviewFromPayload=(payload,bounds)=>{
  if(!payload||typeof payload!=='object')return null
  const peopleSet=count=>new Set(Array.from({length:Math.max(0,Number(count)||0)},(_,index)=>index))
  const empty=()=>Object.fromEntries(matrixKinds.map(kind=>[kind,{days:0,people:new Set()}]))
  const monthly=empty()
  matrixKinds.forEach(kind=>{
    const value=payload.monthly?.[kind]
    if(value){monthly[kind]={days:Number(value.days)||0,people:peopleSet(value.people)}}
  })
  const daily=bounds.days.map(day=>{
    const item={day,...empty()}
    matrixKinds.forEach(kind=>{
      const people=Number(payload.daily?.[String(day)]?.[kind])||0
      if(people)item[kind]={days:people,people:peopleSet(people)}
    })
    return item
  })
  return {scope:payload.scope==='filtered'?'filtered':'page',monthly,daily,totalDays:Number(payload.total_days)||0,totalPeople:Number(payload.total_people)||0}
}

function AttendanceMatrixOverview({overview,month}){
  const labels={public_holiday:'公休 / Rest day',home_leave:'回家 / Home leave',leave:'请假 / Leave',half_day:'半天 / Half day',absence:'缺席 / Absent',resignation:'离职 / Resigned'}
  const monthly=matrixKinds.filter(kind=>overview.monthly[kind].days>0)
  const days=overview.daily.filter(day=>matrixKinds.some(kind=>day[kind].days>0))
  const today=todayIso(),todayDay=Number(today.slice(-2))
  const todayItem=month===today.slice(0,7)?overview.daily[todayDay-1]:null
  return <section className="attendance-matrix-overview" aria-label="当前筛选员工的出勤统计">
    <div className="attendance-overview-total"><small>{overview.scope==='filtered'?'当前筛选':'当前页'} · 月度状态</small><strong>{formatDayCount(overview.totalDays)}<em>天</em></strong><span>涉及 {overview.totalPeople} 人</span></div>
    <div className="attendance-overview-monthly">{monthly.length?monthly.map(kind=><span className={kind} key={kind}><b>{labels[kind]}</b><i>{formatDayCount(overview.monthly[kind].days)} 天</i><small>{overview.monthly[kind].people.size} 人</small></span>):<span className="empty">本月暂无异常记录</span>}</div>
    {todayItem&&<div className="attendance-overview-today" aria-label={`${todayDay}日状态人数`}><b>当日 · {todayDay}日</b><div>{matrixKinds.map(kind=><span className={kind} key={kind}><small>{labels[kind]}</small><strong>{todayItem[kind].people.size}<i>人</i></strong></span>)}</div></div>}
    <div className="attendance-overview-daily" aria-label="每日状态人数">{days.length?days.map(item=>{const detail=matrixKinds.filter(kind=>item[kind].people.size).map(kind=>`${labels[kind]} ${item[kind].people.size} 人`).join(' · ');return <span key={item.day} title={`${item.day} 日：${detail}`}><b>{item.day}日</b><i>{detail}</i></span>}):<span className="empty">每日暂无异常</span>}</div>
  </section>
}

async function fetchAttendanceMonth(month,filters={}){
  return withMonthlyAttendanceLockRetry(async()=>{
    const {data,error}=await supabase.rpc('admin_attendance_monthly_page',{p_filters:{month,...filters}})
    if(error)throw error
    return data||{rows:[],options:{}}
  })
}

function AttendanceMatrixPane(){
  const {notify}=useAppToast()
  const [month,setMonth]=useState(monthValue)
  const blank=()=>({employee_no:'',employee_name:'',work_mode:'',employee_status:'',team:'',position:'',country:'',platform:'',manager:''})
  const [draft,setDraft]=useState(blank)
  const [applied,setApplied]=useState(blank)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(30)
  const [refreshKey,setRefreshKey]=useState(0)
  const [dayDetail,setDayDetail]=useState(null)
  const [state,setState]=useState({loading:true,error:'',people:[],options:{},overview:null,sync:syncMeta({}),total:0,pages:1,serverPaged:false})
  const request=useRef(0)
  const readIntentRef=useRef('')
  const loadingRef=useRef(true)
  const lastRefreshAttemptRef=useRef(0)
  const load=async(force=false,announceOperation='')=>{
    const sequence=++request.current
    const requestedOperation=announceOperation||readIntentRef.current
    readIntentRef.current=''
    // Keep the last successful page while the next page is loading. Clearing
    // `pages` to 1 here used to trigger the page-clamp effect immediately,
    // cancelling every request for page 2+ and sending users back to page 1.
    loadingRef.current=true
    setState(current=>({...current,loading:true,error:''}))
    try{
      const payload=await fetchAttendanceMonth(month,{
        ...applied,
        full_name:applied.employee_name,
        source_group:applied.work_mode,
        employment_type:'',
        status:applied.employee_status,
        page,
        page_size:pageSize,
        force_refresh:force,
      })
      if(sequence!==request.current)return
      const rawPeople=payload.rows||payload.employees||[]
      const people=rawPeople.map((person,index)=>({
        ...person,
        id:person.id||person.employee_id||`${person.employee_no||person.full_name}-${index}`,
        employee_no:person.employee_no||person.staff_id||'',
        full_name:person.full_name||person.employee_name||person.name||'',
        team_name:person.team_name||person.team||'',
        position_name:person.position_name||person.position||'',
        platform:person.platform||person.platform_scope||'',
        manager:person.manager||person.responsible||'',
        employee_status:person.employee_status||person.status||'',
        employment_type:person.employment_type||person.employee_type||'',
        days:person.days||person.day_map||person.attendance_days||{},
        effective_days:person.effective_days||person.effectiveDays||{},
      }))
      const serverPaged=payload.page!==undefined||payload.page_size!==undefined||payload.pages!==undefined
      setState({loading:false,error:'',people,options:payload.options||{},overview:payload.overview||null,sync:syncMeta(payload),total:Number(payload.total??people.length),pages:Math.max(1,Number(payload.pages||1)),serverPaged})
    }catch(error){
      if(sequence!==request.current)return
      const reason=message(error)
      setState(current=>({...current,loading:false,error:reason}))
      if(requestedOperation)notify({
        type:'error',module:ATTENDANCE_TOAST_MODULE,operation:requestedOperation,reason,
        dedupeKey:'attendance:monthly:read:error',retry:()=>load(true,'刷新月度出勤'),retryLabel:'重试',
      })
    }finally{
      if(sequence===request.current){
        loadingRef.current=false
        lastRefreshAttemptRef.current=Date.now()
      }
    }
  }
  useEffect(()=>{load()},[month,applied,page,pageSize,refreshKey])
  useEffect(()=>{
    const refreshWhenDue=()=>{
      if(!attendanceVisibleRefreshDue({
        visibilityState:document.visibilityState,
        loading:loadingRef.current,
        lastAttemptAt:lastRefreshAttemptRef.current,
      }))return
      lastRefreshAttemptRef.current=Date.now()
      setRefreshKey(value=>value+1)
    }
    const interval=window.setInterval(refreshWhenDue,ATTENDANCE_AUTO_REFRESH_MS)
    document.addEventListener('visibilitychange',refreshWhenDue)
    return()=>{
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange',refreshWhenDue)
    }
  },[])
  const bounds=useMemo(()=>monthMeta(month),[month])
  const people=useMemo(()=>{
    if(state.serverPaged)return state.people
    const includes=(value,needle)=>!needle||text(value).toLowerCase().includes(text(needle).toLowerCase())
    return state.people.filter(employee=>includes(employee.employee_no,applied.employee_no)
      &&includes(employee.full_name,applied.employee_name)
      &&(!applied.work_mode||employeeWorkMode(employee)===applied.work_mode)
      &&(!applied.employee_status||text(employee.employee_status).toLowerCase()===text(applied.employee_status).toLowerCase())
      &&(!applied.team||text(employee.team_name)===applied.team)
      &&(!applied.position||text(employee.position_name)===applied.position)
      &&(!applied.country||text(employee.country||employee.nationality)===applied.country)
      &&(!applied.platform||text(employee.platform)===applied.platform)
      &&includes(employee.manager,applied.manager)
    ).sort((a,b)=>text(a.team_name).localeCompare(text(b.team_name),'zh-CN')||text(a.full_name).localeCompare(text(b.full_name),'zh-CN'))
  },[state.people,state.serverPaged,applied])
  const optionValues=(key,selector)=>{
    const supplied=state.options?.[key]||state.options?.[`${key}s`]||[]
    const values=supplied.length?supplied.map(item=>text(item?.value??item?.name??item?.label??item)):state.people.map(selector)
    return Array.from(new Set(values.map(text).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN'))
  }
  const teams=useMemo(()=>optionValues('team',employee=>employee.team_name),[state.people,state.options])
  const positions=useMemo(()=>optionValues('position',employee=>employee.position_name),[state.people,state.options])
  const countries=useMemo(()=>optionValues('country',employee=>employee.country||employee.nationality),[state.people,state.options])
  const platforms=useMemo(()=>optionValues('platform',employee=>employee.platform),[state.people,state.options])
  const pages=state.serverPaged?state.pages:Math.max(1,Math.ceil(people.length/pageSize))
  const pagePeople=state.serverPaged?people:people.slice((page-1)*pageSize,page*pageSize)
  const total=state.serverPaged?state.total:people.length
  const overview=useMemo(()=>matrixOverviewFromPayload(state.overview,bounds)||matrixOverviewFor(people,bounds,month,state.serverPaged?'page':'filtered'),[state.overview,state.serverPaged,people,bounds,month])
  useEffect(()=>{if(!state.loading&&page>pages)setPage(pages)},[state.loading,page,pages])
  const update=(key,value)=>setDraft(current=>({...current,[key]:value}))
  const apply=()=>{readIntentRef.current='查询月度出勤';setApplied({...draft});setPage(1);setRefreshKey(value=>value+1)}
  const reset=()=>{readIntentRef.current='重置月度出勤查询';const next=blank();setDraft(next);setApplied(next);setPage(1);setRefreshKey(value=>value+1)}
  return <>
    <section className="attendance-filter-card matrix-toolbar">
      <div className="attendance-filter-main">
        <label className="schedule-inline-filter month"><span>查看月份</span><input type="month" value={month} onChange={event=>{readIntentRef.current='查询月度出勤';setMonth(event.target.value||monthValue());setPage(1)}}/></label>
        <label className="attendance-search attendance-search-id"><span>员工 ID</span><div><i>⌕</i><input value={draft.employee_no} onChange={event=>update('employee_no',event.target.value)} onKeyDown={event=>event.key==='Enter'&&apply()} placeholder="输入员工 ID"/></div></label>
        <label className="attendance-search attendance-search-name"><span>员工姓名</span><div><i>⌕</i><input value={draft.employee_name} onChange={event=>update('employee_name',event.target.value)} onKeyDown={event=>event.key==='Enter'&&apply()} placeholder="输入姓名"/></div></label>
        <button type="button" className="primary-action" onClick={apply} disabled={state.loading}>查询</button><button type="button" className="secondary-action" onClick={reset} disabled={state.loading}>重置</button><button type="button" className="attendance-filter-toggle" onClick={()=>load(true,'刷新月度出勤')} disabled={state.loading}>{state.loading?'读取中…':'刷新结果'}</button>
      </div>
      <div className="attendance-filter-grid matrix-filter-grid">
        <label><span>员工类型</span><select value={draft.work_mode} onChange={event=>update('work_mode',event.target.value)}><option value="">全部员工类型</option><option value="home">纯居家</option><option value="onsite_to_home">现场转居家</option></select></label>
        <label><span>员工状态</span><select value={draft.employee_status} onChange={event=>update('employee_status',event.target.value)}><option value="">全部员工状态</option><option value="active">在职</option><option value="probation">试用</option><option value="suspended">停用</option><option value="resigned">离职</option><option value="unmatched">未匹配</option></select></label>
        <label><span>团队</span><select value={draft.team} onChange={event=>update('team',event.target.value)}><option value="">全部团队</option>{teams.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>岗位</span><select value={draft.position} onChange={event=>update('position',event.target.value)}><option value="">全部岗位</option>{positions.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>员工国家</span><select value={draft.country} onChange={event=>update('country',event.target.value)}><option value="">全部国家</option>{countries.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>盘口 / 平台</span><select value={draft.platform} onChange={event=>update('platform',event.target.value)}><option value="">全部盘口</option>{platforms.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>负责人</span><input value={draft.manager} onChange={event=>update('manager',event.target.value)} onKeyDown={event=>event.key==='Enter'&&apply()} placeholder="负责人 / 培训 / 组长"/></label>
      </div>
      <div className="attendance-filter-foot"><SyncIndicator sync={state.sync}/><span>页面每 2 分钟轻量刷新，并在重新打开标签页时检查；手动刷新仍可立即读取。</span></div>
    </section>
    <AttendanceSyncNotice sync={state.sync}/>
    {state.error&&<div className="attendance-error"><span>月度出勤读取失败：{state.error}</span><button type="button" onClick={()=>load(true,'重试月度出勤查询')}>重试</button></div>}
    {!state.loading&&people.length>0&&<AttendanceMatrixOverview overview={overview} month={month}/>}
    <section className="attendance-table-card attendance-matrix-card"><header><div><h2>{month.replace('-','年')}月出勤表</h2><p>左侧员工资料固定，右侧可横向查看 1–{bounds.days.length} 日；同日多种状态时，离职优先计入总计。</p></div><div className="matrix-legend"><span className="public_holiday">公 公休 / Rest day</span><span className="home_leave">回 回家 / Home leave</span><span className="leave">请 请假 / Leave</span><span className="half_day">半 半天 / Half day</span><span className="absence">缺 缺席 / Absent</span><span className="resignation">离 离职 / Resigned</span></div></header>
      {state.loading&&!state.people.length?<div className="attendance-table-state">正在生成月度出勤表…</div>:!people.length?<div className="attendance-table-state">当前条件下暂无员工</div>:<div className="attendance-matrix-scroll"><table><thead><tr><th className="matrix-sticky matrix-scope">盘口 / 国家</th><th className="matrix-sticky matrix-position">岗位 / 团队</th><th className="matrix-sticky matrix-employee">员工</th><th className="matrix-sticky matrix-hire">入职</th><th className="matrix-sticky matrix-summary">本月统计</th>{bounds.days.map(day=><th className="matrix-day-head" key={day}>{day}</th>)}<th className="matrix-total-head">总计</th></tr></thead><tbody>{pagePeople.map(employee=><AttendanceMatrixRow key={matrixPersonKey(employee)} employee={employee} bounds={bounds} month={month} onDay={setDayDetail}/>)}</tbody></table></div>}
      {state.loading&&state.people.length>0&&<div className="attendance-loading-overlay">正在更新月度出勤…</div>}
    </section>
    {total>0&&<div className="matrix-pagination"><Pagination page={page} pages={pages} total={total} pageSize={pageSize} loading={state.loading} onPage={next=>{readIntentRef.current='查询月度出勤分页';setPage(next);setRefreshKey(value=>value+1)}} onPageSize={next=>{readIntentRef.current='调整月度出勤分页';setPageSize(next);setPage(1);setRefreshKey(value=>value+1)}}/></div>}
    {dayDetail&&<AttendanceDayModal data={dayDetail} onClose={()=>setDayDetail(null)}/>}
  </>
}

function AttendanceMatrixRow({employee,bounds,month,onDay}){
  const summary=matrixSummaryFor(employee,bounds,month)
  const country=employee.country||employee.nationality||'—'
  const status=employeeStatusLabel(employee.employee_status||employee.status)
  const chips=matrixKinds.map(kind=><span className={kind} key={kind} title={`${attendanceKindLabel(kind)} ${formatDayCount(summary[kind])} 天`}><i>{matrixSummaryLabels[kind]}</i>{formatDayCount(summary[kind])}</span>)
  return <tr>
    <td className="matrix-sticky matrix-scope"><strong title={employee.platform||'—'}>{employee.platform||'—'}</strong><span title={`${country} · ${employeeWorkModeLabel(employee)}`}>{country} · {employeeWorkModeLabel(employee)}</span></td>
    <td className="matrix-sticky matrix-position"><strong title={employee.position_name||'—'}>{employee.position_name||'—'}</strong><span title={employee.team_name||'—'}>{employee.team_name||'—'}</span></td>
    <td className="matrix-sticky matrix-employee"><strong title={employee.full_name||'—'}>{employee.full_name||'—'}</strong><span title={`${employee.employee_no||'—'} · ${status}`}>{employee.employee_no||'—'} · {status}</span></td>
    <td className="matrix-sticky matrix-hire"><strong title={text(employee.hire_date).slice(0,10)||'—'}>{text(employee.hire_date).slice(0,10)||'—'}</strong></td>
    <td className="matrix-sticky matrix-summary"><div className="matrix-summary-chips" title={`本月合计 ${formatDayCount(summary.total)} 天`}>{chips}</div></td>
    {bounds.days.map(day=>{
      const date=`${month}-${String(day).padStart(2,'0')}`
      const records=matrixDayRecords(employee,day,month).filter(record=>matrixKindKey(record.event_kind||record.kind||record.status))
      const primaryRecord=matrixPrimaryRecord(matrixEffectiveDayRecords(employee,day,month))
      const primary=primaryRecord&&matrixKindMeta(primaryRecord.event_kind||primaryRecord.kind||primaryRecord.status)
      return <td className="matrix-day-cell" key={day}>{primary?<button type="button" className={primary[1]} aria-label={`${employee.full_name||employee.employee_no} ${date} 查看出勤详情`} title={`${attendanceKindLabel(primaryRecord.event_kind||primaryRecord.kind||primaryRecord.status)}${records.length>1?'（同日其他记录详见详情）':''} · 点击查看完整原因与备注`} onClick={()=>onDay({employee,date,records,effectiveKind:matrixKindKey(primaryRecord.event_kind||primaryRecord.kind||primaryRecord.status)})}>{primary[0]}</button>:<i title="无异常记录">—</i>}</td>
    })}
    <td className="matrix-total-cell" title={`本月统计合计 ${formatDayCount(summary.total)} 天`}><strong>{formatDayCount(summary.total)}</strong><span>天</span></td>
  </tr>
}

function AttendanceDayModal({data,onClose}){
  const employee=data.employee||{}
  const hasResignation=data.effectiveKind==='resignation'
  return <div className="modal-mask attendance-main-modal-mask" onMouseDown={onClose}><div className="attendance-main-modal attendance-day-modal" role="dialog" aria-modal="true" aria-labelledby="attendance-day-modal-title" onMouseDown={event=>event.stopPropagation()}><header><div><small>DAILY ATTENDANCE DETAIL</small><h2 id="attendance-day-modal-title">{data.date} · 出勤详情</h2><p>{employee.employee_no||'—'} · {employee.full_name||'—'}{hasResignation?' · 当日统计按离职计':' '}</p></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></header><div className="attendance-modal-facts"><span><small>入职日期</small><b>{text(employee.hire_date).slice(0,10)||'—'}</b></span><span><small>盘口 / 国家</small><b>{[employee.platform,employee.country||employee.nationality].filter(Boolean).join(' · ')||'—'}</b></span><span><small>岗位 / 团队</small><b>{[employee.position_name,employee.team_name].filter(Boolean).join(' · ')||'—'}</b></span></div><div className="attendance-day-records">{data.records.map((record,index)=><article key={`${record.event_kind||record.kind}-${index}`}><span className={`attendance-kind kind-${text(record.event_kind||record.kind||record.status).toLowerCase()}`}>{attendanceKindLabel(record.event_kind||record.kind||record.status)}</span><div><small>原因</small><p>{record.reason||'—'}</p></div><div><small>备注</small><p>{record.note||'—'}</p></div></article>)}</div><footer><button type="button" className="secondary-action" onClick={onClose}>关闭</button></footer></div></div>
}
