import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Pagination } from '../components/DataPageControls'
import { useAppToast } from '../components/AppToastProvider'
import { ConnectivityRecordsPage, EmployeeConnectivityPanel, EmployeePayrollHistoryPanel, EmployeeProfileMetrics } from '../components/ConnectivityRecords'
import { EmployeeAdjustmentPanel, EmployeeAttendancePanel } from '../components/AttendanceRecords'
import { AdminAlertRecordsPage, EmployeeAlertHistoryPanel } from '../components/AdminAlertCenter'
import AdminDataEntryLogs from '../components/AdminDataEntryLogs'
import AdminModuleNav from '../components/AdminModuleNav'
import { ExamImageGallery } from '../components/ExamImageGallery'
import { adminLocalPageTabs, adminTabParams, adminTabSlug, canonicalAdminTab } from '../config/navigation'
import { PERMISSIONS } from '../config/permissions'
import { useAdminAccess } from '../lib/adminAccess'
import { useAdminI18n } from '../lib/adminI18n'
import { employeePortalAccountPresentation } from '../lib/employeeAccountStatus'
import { ADMIN_ALERT_PERMISSIONS } from '../lib/adminAlertCatalog'
import { employeeArchiveCsv, employeeArchiveExportFilename } from '../lib/employeeArchiveExport'
import { edgeFunctionErrorMessage, readableErrorMessage } from '../lib/edgeFunctionError'
import { employeeTrainerReviewRows } from '../lib/onlineTrainingPresentation'
import { managementRiskDatePreset } from '../lib/managementRiskPresentation'
import ManagementRiskPanel from '../components/ManagementRiskPanel'
import { withAbortTimeout } from '../lib/abortableRequest'
import { employeeProfileMetricSeed, mergeEmployeeDetailRefresh, withEmployeeDetailTimeout } from '../lib/employeeDrawerState'
import { filterEmployeeErrorHistory, filterEmployeeExamHistory } from '../lib/employeeRecordFilters'
import { hydrateExamAnswersAttachments } from '../lib/examAnswerAttachments.js'
import { hydrateExamFeedbackAnswers } from '../lib/examFeedbackAttachments.js'

const EMPLOYEE_TABS = ['员工档案','人员分析','停电 / 断网记录','预警记录','离职记录','操作日志']
const EMPLOYEE_TAB_PERMISSIONS = {
  '员工档案': 'employee.directory.view',
  '人员分析': 'employee.analytics.view',
  '停电 / 断网记录': 'connectivity.view',
  '预警记录': 'alert.view',
  '离职记录': 'employee.resignations.view',
  '操作日志': 'employee.change_history.view',
}

const text = v => String(v ?? '').trim()
const employeeExamAnswerImageLabels={
  imageAlt:'员工答题图片',imageOpen:'点击放大',imageClose:'关闭图片',
  imageFallback:'图片暂时无法预览',imageRetry:'重试预览',imageNumber:count=>`答题图片 ${count}`,
}
function EmployeeExamAnswerImageGallery({attachments}){
  const rows=Array.isArray(attachments)?attachments:[]
  const urls=rows.map(item=>item?.url||'').filter(Boolean)
  if(!rows.length)return null
  return <section className="exam-answer-attachment-block" aria-label={`员工答题图片 · ${rows.length} 张`}><strong>员工答题图片 · {rows.length} 张</strong>{!!urls.length&&<ExamImageGallery urls={urls} labels={employeeExamAnswerImageLabels} className="exam-answer-media-grid"/>}{urls.length<rows.length&&<small className="exam-answer-attachment-unavailable">{rows.length-urls.length} 张图片暂时无法预览，请稍后重试。</small>}</section>
}
const employeeExamFeedbackImageLabels={
  imageAlt:'老师回复图片',imageOpen:'点击放大',imageClose:'关闭图片',
  imageFallback:'图片暂时无法预览',imageRetry:'重试预览',imageNumber:count=>`回复图片 ${count}`,
}
function EmployeeExamFeedbackImageGallery({attachments}){
  const rows=Array.isArray(attachments)?attachments:[]
  const urls=rows.map(item=>item?.url||'').filter(Boolean)
  if(!rows.length)return null
  return <section className="exam-feedback-image-block employee-record" aria-label={`老师回复图片 · ${rows.length} 张`}><strong>老师回复图片 · {rows.length} 张</strong>{!!urls.length&&<ExamImageGallery urls={urls} labels={employeeExamFeedbackImageLabels} className="exam-answer-media-grid exam-feedback-media-grid"/>}{urls.length<rows.length&&<small className="exam-answer-attachment-unavailable">{rows.length-urls.length} 张图片暂时无法预览，请稍后重试。</small>}</section>
}
const employeeRequestError = (error, fallback) => {
  const raw=readableErrorMessage(error)
  if(!raw||raw==='操作失败'||/^edge function returned a non-2xx status code$/i.test(raw)) return fallback
  return raw
}
const employeeDetailPartialError = detail => {
  const sections=[...new Set((detail?.partial_errors||[]).map(text).filter(Boolean))]
  return sections.length?`部分资料读取失败（${sections.join('、')}），已显示其余资料。请重试。`:''
}
const localDateIso = () => {
  const d=new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
const blankAuditFilters = () => {
  const today=localDateIso()
  return {employee_no:'',full_name:'',action:'',actor:'',date_from:today,date_to:today}
}
const isTestEmployeeNo = v => text(v).toUpperCase().startsWith('TEST')
const dedupeAnalysisRows = rows => {
  const map=new Map()
  for(const row of (rows||[])){
    const employeeKey=text(row.employee_no)||text(row.employee_id)||text(row.id)
    const type=text(row.event_type)||'event'
    const date=text(row.date)||text(row.effective_date)||''
    const key=`${employeeKey}|${type}|${date}`
    const prev=map.get(key)
    // Prefer a row that can actually open the employee archive; otherwise keep the newest copy.
    if(!prev || (!prev.employee_id&&row.employee_id)) map.set(key,row)
    else if(prev.employee_id===row.employee_id) map.set(key,row)
  }
  return Array.from(map.values())
}
const BASE_ANALYSIS_VIEWS=['总览','团队分析','岗位分析','国家分析','班次分析','离职分析']
const blankEmployeeFilters=()=>({
  employee_no:'',full_name:'',work_tg:'',backend_account:'',risk_level:'',account_status:'',team:'',position:'',country:'',status:'active',
  employment_type:'',shift_name:'',teacher:'',hire_from:'',hire_to:'',
})
const emptyEmployeeMeta=()=>({
  teams:[],positions:[],position_options:[],total:0,active:0,no_team:0,official_id_pending:0,
  options:{teams:[],positions:[],countries:[],nationalities:[],employment_types:[],shifts:[],groups:[],leaders:[],trainers:[],market_countries:[],market_positions:[],platforms:[]},
  platform_map:[],
  schedule:{teams:[],positions:[],shifts:[],leaders:[],trainers:[],position_stats:[],team_stats:[]},
  permissions:{},actions:{can_create:false,can_edit:false},
})
const EMPLOYEE_EXPORT_PAGE_SIZE=500
const EMPLOYEE_EXPORT_MAX_PAGES=100
const EMPLOYEE_TOAST_MODULE='员工管理'
const employeeToastDedupeKey=(operation,type,scope='')=>['employees',text(operation),text(scope),type].join(':')
const employeeRefreshSucceeded=outcomes=>(outcomes||[]).every(outcome=>outcome!==false)
const MANAGEMENT_RISK_REQUEST_TIMEOUT_MS=12*1000
const MANAGEMENT_RISK_CACHE_TTL_MS=60*1000
const MANAGEMENT_RISK_CACHE_MAX_ENTRIES=8
const blankPeopleFilters=()=>({employee_no:'',full_name:'',work_tg:'',team:'',position:'',country:'',shift_name:'',date_from:'',date_to:''})
const blankManagementRiskFilters=()=>({
  ...managementRiskDatePreset('30d'),team:'',group:'',manager:'',manager_role:'',employee_search:'',
})
const blankResignationAnalyticsFilters=()=>({employee_no:'',full_name:'',team:'',position:'',country:'',reason:'',date_from:'',date_to:''})
const blankHistoryFilters=()=>{
  const today=localDateIso()
  return {employee_no:'',full_name:'',team:'',position:'',country:'',reason:'',date_from:today,date_to:today}
}
const hasFilterValues=filters=>Object.values(filters||{}).some(value=>text(value))
const statusName = s => ({active:'在职',probation:'试用',suspended:'停用',inactive:'停用',resigned:'离职'}[s] || s || '-')
const typeOptions = [
  '纯居家菲律宾',
  '现场转居家',
  '纯居家（越南/缅甸/印尼等）'
]
const legacyType = {
  home_ph:'纯居家菲律宾',
  onsite_to_home:'现场转居家',
  home_vn:'纯居家（越南/缅甸/印尼等）',
  home_id:'纯居家（越南/缅甸/印尼等）',
  home_mm:'纯居家（越南/缅甸/印尼等）',
  '纯居家越南':'纯居家（越南/缅甸/印尼等）',
  '纯居家印尼':'纯居家（越南/缅甸/印尼等）',
  '纯居家缅甸':'纯居家（越南/缅甸/印尼等）',
  '纯居家马来':'纯居家（越南/缅甸/印尼等）',
  '纯居家马来西亚':'纯居家（越南/缅甸/印尼等）',
}
const typeName = v => legacyType[text(v)] || text(v) || '-'
const EMPLOYEE_RISK_META = {
  excellent:{zh:'优秀',en:'Excellent',className:'excellent'},
  normal:{zh:'正常',en:'Normal',className:'normal'},
  attention:{zh:'注意',en:'Attention',className:'attention'},
  watch:{zh:'重点',en:'Priority',className:'watch'},
  high:{zh:'高频',en:'High frequency',className:'high'},
}
const riskKeyFromCount = value => {
  const count=Number(value||0)
  if(count>=31) return 'high'
  if(count>=16) return 'watch'
  if(count>=9) return 'attention'
  if(count>=1) return 'normal'
  return 'excellent'
}
const employeeRiskMeta = row => {
  const hasLiveCount=row?.total_error_count!==null&&row?.total_error_count!==undefined&&text(row.total_error_count)!==''
  // A fresh aggregate count is authoritative; risk_level can be a stale cached label.
  let key=hasLiveCount?riskKeyFromCount(row.total_error_count):text(row?.risk_level)
  return EMPLOYEE_RISK_META[key]||null
}
const canonicalShiftName = v => {
  const raw=text(v).replace(/\s+/g,' ')
  if(!raw) return ''
  const compact=raw.replace(/\s+/g,'').toUpperCase()
  if(['DAYSHIFT','DAYSHIFTT','早班DAY','白班DAY'].includes(compact)) return '白班 Day'
  if(['NIGHTSHIFT','NIGHSHIFT','NIGHTSHIFTT','晚班NIGHT','夜班NIGHT'].includes(compact)) return '夜班 Night'
  if(['MIDSHIFT','MIDSHFFT','中班MID'].includes(compact)) return '中班 Mid'
  if(/中班MID11点/.test(compact)||/MID11:?00/.test(compact)) return '中班 MID 11:00'
  if(/MID11:?30/.test(compact)) return '中班 MID 11:30'
  if(/MID12:?00/.test(compact)) return '中班 MID 12:00'
  if(/MID12:?30/.test(compact)) return '中班 MID 12:30'
  if(/MID13:?00/.test(compact)) return '中班 MID 13:00'
  return raw
}
const cleanShiftOptions = values => {
  const seen=new Set()
  return (values||[]).map(canonicalShiftName).filter(v=>{
    const k=text(v).toUpperCase(); if(!k||seen.has(k)) return false; seen.add(k); return true
  }).sort((a,b)=>a.localeCompare(b,'zh-CN'))
}
const auditActionOptions = [
  {value:'employee_create',label:'新增员工'},{value:'employee_update',label:'编辑员工'},{value:'employee_id_edit',label:'修改员工ID'},
  {value:'resign',label:'办理离职'},{value:'edit_resignation',label:'编辑离职'},{value:'reactivate',label:'恢复在职'},{value:'cancel_hire',label:'撤销入职'},
  {value:'google_employee_create',label:'Google新增'},{value:'google_profile_sync',label:'Google资料同步'},{value:'google_employee_id_edit',label:'Google修改员工ID'},
]
const auditActionLabel = v => auditActionOptions.find(x=>x.value===text(v))?.label || text(v) || '-'
const auditActionValueByLabel = label => auditActionOptions.find(x=>x.label===text(label))?.value || ''
const auditFieldLabel = key => ({
  employee_no:'员工ID',full_name:'姓名',country:'员工国家',nationality:'国籍',employment_type:'员工类型',
  team_id:'团队',position_id:'主档岗位',market_country:'盘口国家',market_position:'盘口岗位',shift_name:'班次',
  status:'状态',work_tg:'工作TG',backend_accounts:'后台账号',hire_date:'入职日期',resign_date:'离职日期',
  last_location:'最后地点',return_date:'回去时间',home_date:'居家时间',platform_scope:'盘口',reason:'离职原因',
  'contact.work_email':'Workfolio 邮箱','contact.telegram_username':'Telegram','contact.zoom_email':'Zoom 邮箱',
  'contact.facebook':'Facebook','contact.whatsapp_phone':'WhatsApp / 手机',
  'compensation.base_salary':'底薪','compensation.daily_rate':'日薪','compensation.performance_default':'默认绩效',
  'compensation.meal_allowance':'餐补','payment.mode':'收款方式','payment.transfer_using':'转账方式',
  'payment.gcash_account':'GCash / 银行账号','payment.gcash_name':'收款姓名','payment.usdt_address':'USDT 地址',
  'payment.contact_phone':'联系电话','payment.whatsapp_number':'收款 WhatsApp','payment.employee_address':'员工地址',
}[key]||key)
const auditBlank = v => v===null||v===undefined||text(v)===''
const auditEntityName = (list,id) => (list||[]).find(x=>text(x.id)===text(id))?.name || text(id)
const auditValueLabel = (key,value,meta) => {
  if(auditBlank(value)) return '空白'
  if(key==='status') return statusName(value)
  if(key==='position_id') return auditEntityName(meta?.positions,value)
  if(key==='team_id') return auditEntityName(meta?.teams,value)
  if(['hire_date','resign_date','return_date','home_date'].includes(key)) return text(value).slice(0,10)
  if(typeof value==='object') return JSON.stringify(value)
  return text(value)
}
const auditPlatformDiff = (before,after) => {
  const split=v=>text(v).split(/[\/，,；;\n\r]+/).map(x=>text(x)).filter(Boolean)
  const a=new Set(split(before)), b=new Set(split(after))
  return {added:[...b].filter(x=>!a.has(x)),removed:[...a].filter(x=>!b.has(x))}
}
function auditChangeRows(row,meta){
  const changes=row?.changes||{}
  const rows=[]
  const push=(label,before,after,kind='change')=>rows.push({label,before,after,kind})
  for(const [key,itemRaw] of Object.entries(changes)){
    const item=itemRaw||{}
    if(key==='created' && item.after && typeof item.after==='object'){
      const x=item.after
      push('新增员工档案','—',`${text(x.employee_no)||row.employee_no||'—'} · ${text(x.full_name)||row.full_name||'—'}${text(x.hire_date)?` · 入职 ${text(x.hire_date).slice(0,10)}`:''}`,'summary')
      continue
    }
    if(key==='employee' && (item.before||item.after)){
      const before=item.before||{}, after=item.after||{}
      if(item.before && !item.after){
        push('撤销员工档案',`${text(before.employee_no)||row.employee_no||'—'} · ${text(before.full_name)||row.full_name||'—'}${text(before.hire_date)?` · 入职 ${text(before.hire_date).slice(0,10)}`:''}`,'已删除','summary')
        continue
      }
      const nestedKeys=Array.from(new Set([...Object.keys(before),...Object.keys(after)]))
      nestedKeys.forEach(nk=>{
        const a=before[nk]??null,b=after[nk]??null
        if(JSON.stringify(a)!==JSON.stringify(b)) push(auditFieldLabel(nk),auditValueLabel(nk,a,meta),auditValueLabel(nk,b,meta))
      })
      continue
    }
    const before=item?.before??null, after=item?.after??null
    if(key==='platform_scope'){
      const diff=auditPlatformDiff(before,after)
      if(diff.added.length) push('盘口新增','—',diff.added.join(' / '),'add')
      if(diff.removed.length) push('盘口移除',diff.removed.join(' / '),'—','remove')
      if(!diff.added.length&&!diff.removed.length) push('盘口',auditValueLabel(key,before,meta),auditValueLabel(key,after,meta))
      continue
    }
    push(auditFieldLabel(key),auditValueLabel(key,before,meta),auditValueLabel(key,after,meta))
  }
  return rows
}
function AuditChanges({row,meta}){
  const rows=auditChangeRows(row,meta)
  if(!rows.length) return <span className="muted">—</span>
  return <div style={{display:'grid',gap:5,minWidth:360,maxWidth:760}}>
    {rows.map((x,i)=><div key={`${x.label}-${i}`} style={{display:'grid',gridTemplateColumns:'120px minmax(0,1fr)',gap:10,alignItems:'start',padding:'5px 8px',border:'1px solid #e7edf6',borderRadius:8,background:'#fbfdff'}}>
      <strong style={{color:'#425b7c'}}>{x.label}</strong>
      <span style={{whiteSpace:'normal',wordBreak:'break-word'}}>{x.kind==='summary'?<><span>{x.before}</span>{x.after&&x.after!=='—'?<><span style={{margin:'0 8px',color:'#94a3b8'}}>→</span><strong>{x.after}</strong></>:null}</>:<><span>{x.before}</span><span style={{margin:'0 8px',color:'#94a3b8'}}>→</span><strong>{x.after}</strong></>}</span>
    </div>)}
  </div>
}
const auditSourceLabel = r => {
  if(text(r?.source).includes('google')) return `Google Sheet${text(r?.metadata?.source_sheet)?` · ${text(r.metadata.source_sheet)}`:''}`
  if(text(r?.source)==='backend') return '后台'
  return text(r?.source)||'—'
}
const operatorDisplay = v => {
  const s=text(v)
  if(!s) return '—'
  if(['Google Sheet','Google Sheet（账号不可用）','Google Sheet（未登记操作人）'].includes(s)) return 'Google Sheet（未登记操作人）'
  return s
}
const eventLabel = v => ({join:'入职',resign:'离职',reactivate:'复职',profile_update:'资料修改'}[v] || v || '-')
const formatDateTime = v => {
  if(!v) return '—'
  const d=new Date(v)
  if(Number.isNaN(d.getTime())) return text(v)
  return d.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})
}

function parseIsoDateOnly(v){
  const raw=text(v).slice(0,10)
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const [y,m,d]=raw.split('-').map(Number)
  const dt=new Date(Date.UTC(y,m-1,d,12))
  return Number.isNaN(dt.getTime())?null:dt
}
function tenureDurationLabel(hireDate,resignDate,status){
  const start=parseIsoDateOnly(hireDate)
  if(!start) return '入职日期待完善'
  const today=new Date()
  const todayUtc=new Date(Date.UTC(today.getFullYear(),today.getMonth(),today.getDate(),12))
  const resign=parseIsoDateOnly(resignDate)
  const end=status==='resigned'&&resign?resign:todayUtc
  const totalDays=Math.floor((end.getTime()-start.getTime())/86400000)
  if(totalDays<0) return `待入职 · 还有 ${Math.abs(totalDays)} 天`
  let years=end.getUTCFullYear()-start.getUTCFullYear()
  let months=end.getUTCMonth()-start.getUTCMonth()
  let days=end.getUTCDate()-start.getUTCDate()
  if(days<0){
    const prevMonthLast=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),0,12)).getUTCDate()
    days+=prevMonthLast
    months-=1
  }
  if(months<0){months+=12;years-=1}
  const parts=[]
  if(years>0) parts.push(`${years}年`)
  if(months>0||years>0) parts.push(`${months}个月`)
  parts.push(`${days}天`)
  return `${parts.join(' ')} · 共 ${totalDays} 天`
}
function tenureCompactLabel(hireDate,resignDate,status){
  const start=parseIsoDateOnly(hireDate)
  if(!start) return '—'
  const now=new Date()
  const todayUtc=new Date(Date.UTC(now.getFullYear(),now.getMonth(),now.getDate(),12))
  const resign=parseIsoDateOnly(resignDate)
  const end=status==='resigned'&&resign?resign:todayUtc
  const totalDays=Math.floor((end.getTime()-start.getTime())/86400000)
  if(totalDays<0) return `待入职 · ${Math.abs(totalDays)}天`
  let months=(end.getUTCFullYear()-start.getUTCFullYear())*12+(end.getUTCMonth()-start.getUTCMonth())
  if(end.getUTCDate()<start.getUTCDate()) months-=1
  months=Math.max(0,months)
  if(months<1) return `${totalDays}天`
  if(months<12) return `${months}个月`
  const years=Math.floor(months/12), rest=months%12
  return rest?`${years}年${rest}个月`:`${years}年`
}
const sheetSyncSucceeded=sync=>Boolean(sync)&&sync.skipped!==true&&sync.ok===true&&sync.body?.ok!==false&&!sync.error
const sheetSyncMessage=sync=>text(sync?.body?.error||sync?.error||sync?.reason||'正式 Google Sheet 写入失败')
const normPlatform = v => text(v).replace(/\s+/g,'').toUpperCase()
const platformRefsFor = (rows,value) => {
  const key=normPlatform(value)
  if(!key) return []
  return (rows||[]).filter(x=>normPlatform(x.platform)===key)
}
const platformRefFor = (rows,value) => platformRefsFor(rows,value)[0] || null

function defaultPaymentMode(type){
  const t=typeName(type)
  if(t==='现场转居家') return 'usdt'
  if(t==='纯居家（越南/缅甸/印尼等）') return 'usdt'
  if(t==='纯居家菲律宾') return 'bank_wallet'
  return ''
}

function isPhpHome(type){
  return typeName(type)==='纯居家菲律宾'
}
function isOnsiteToHome(type){
  return typeName(type)==='现场转居家'
}
function isOtherPureHome(type){
  return typeName(type)==='纯居家（越南/缅甸/印尼等）'
}

function defaultCurrency(type){
  return isPhpHome(type)?'PHP':'USD'
}

function phpSalaryBasis(comp){
  const hasMonthly = text(comp?.base_salary) !== ''
  const hasDaily = text(comp?.daily_rate) !== ''
  if(hasMonthly && !hasDaily) return 'monthly'
  if(hasDaily && !hasMonthly) return 'daily'
  return ''
}

function mergeOptions(options,current){
  const values=[...(options||[])]
  if(text(current) && !values.includes(current)) values.unshift(current)
  return values.filter(Boolean)
}

const isMaskedPlaceholder = value => typeof value==='string' && /(?:\*{2,}|•{2,}|(?:^|\s)x{3,}(?:\s|$))/i.test(value)
const safeFormValue = value => isMaskedPlaceholder(value) ? '' : (value??'')

function employeeWriteCapabilities(source,mode){
  const actions=source?.actions||{}
  const permissions=source?.permissions||{}
  const creating=mode==='create'
  const basic=creating ? actions.can_create===true : actions.can_edit===true
  return {
    basic,
    sensitiveEmployeeView:creating||permissions.sensitive_employee_view===true,
    compensationView:creating
      ? actions.can_create_compensation===true
      : permissions.compensation_view===true,
    paymentView:creating||permissions.sensitive_payment_view===true,
    sensitiveEmployee:creating
      ? actions.can_create_sensitive_employee===true
      : actions.can_edit_sensitive_employee===true||permissions.sensitive_employee_edit===true,
    compensation:creating
      ? actions.can_create_compensation===true
      : actions.can_edit_compensation===true||permissions.compensation_edit===true,
    payment:creating
      ? actions.can_create_payment===true
      : actions.can_edit_payment===true||permissions.sensitive_payment_edit===true,
  }
}

function patchSection(values,prefix,maskedFields,initialValues={},allowedKeys=null){
  return Object.fromEntries(Object.entries(values||{}).filter(([key,value])=>{
    if(allowedKeys&&!allowedKeys.includes(key)) return false
    if(isMaskedPlaceholder(value)) return false
    // A masked value is rendered as an empty control. Unless the operator types
    // a genuine replacement, omission means preserve the server-side value.
    if(maskedFields?.[`${prefix}.${key}`]&&text(value)==='') return false
    if(Object.prototype.hasOwnProperty.call(initialValues||{},key)&&String(value??'')===String(initialValues?.[key]??'')) return false
    return true
  }))
}

function emptyForm(){
  return {
    employee:{
      employee_no:'',full_name:'',country:'',nationality:'',employment_type:'',
      team_id:'',position_id:'',position_name:'',market_country:'',market_position:'',shift_name:'',
      group_name:'',leader_name:'',trainer_name:'',platform_scope:'',work_content:'',
      work_tg:'',backend_accounts:'',hire_date:'',last_location:'',return_date:'',home_date:'',
    },
    contact:{work_email:'',telegram_username:'',zoom_email:'',facebook:'',whatsapp_phone:''},
    compensation:{base_salary:'',daily_rate:'',performance_default:'',meal_allowance:'',currency:'USD',note:'',salary_basis:''},
    payment:{mode:'unknown',transfer_using:'',bank_wallet_account:'',account_name:'',usdt_address:'',contact_phone:'',whatsapp_number:'',employee_address:''},
  }
}

function bundleToForm(detail,capabilities){
  const e=detail?.employee||{}
  const c=detail?.contact||{}
  const p=detail?.payment||{}
  const comp=detail?.compensation||{}
  const maskedFields={}
  const field=(path,value,allowed=true)=>{
    if(isMaskedPlaceholder(value)) maskedFields[path]=true
    return allowed?safeFormValue(value):''
  }
  const form={
    employee:{
      employee_no:e.employee_no||'',full_name:e.full_name||'',country:e.country||'',nationality:e.nationality||'',
      employment_type:e.employment_type||'',team_id:e.team_id||'',position_id:e.position_id||'',position_name:e.positions?.name||'',
      market_country:e.market_country||'',market_position:e.market_position||'',shift_name:e.shift_name||'',
      group_name:e.group_name||'',leader_name:e.leader_name||'',trainer_name:e.trainer_name||'',
      platform_scope:e.platform_scope||'',work_content:e.work_content||'',
      work_tg:field('employee.work_tg',e.work_tg,capabilities?.sensitiveEmployee),
      backend_accounts:field('employee.backend_accounts',e.backend_accounts,capabilities?.sensitiveEmployee),hire_date:text(e.hire_date).slice(0,10),
      last_location:e.last_location||'',return_date:text(e.return_date).slice(0,10),home_date:text(e.home_date).slice(0,10),
    },
    contact:{
      work_email:field('contact.work_email',c.work_email,capabilities?.sensitiveEmployee),
      telegram_username:field('contact.telegram_username',c.telegram_username,capabilities?.sensitiveEmployee),
      zoom_email:field('contact.zoom_email',c.zoom_email,capabilities?.sensitiveEmployee),
      facebook:field('contact.facebook',c.facebook,capabilities?.sensitiveEmployee),
      whatsapp_phone:field('contact.whatsapp_phone',c.whatsapp_phone,capabilities?.sensitiveEmployee),
    },
    compensation:{
      base_salary:field('compensation.base_salary',comp.base_salary,capabilities?.compensation),
      daily_rate:field('compensation.daily_rate',comp.daily_rate,capabilities?.compensation),
      performance_default:field('compensation.performance_default',comp.performance_default,capabilities?.compensation),
      meal_allowance:field('compensation.meal_allowance',comp.meal_allowance,capabilities?.compensation),
      currency:capabilities?.compensation?(comp.currency||defaultCurrency(e.employment_type)):defaultCurrency(e.employment_type),
      note:field('compensation.note',comp.note,capabilities?.compensation),
      salary_basis:capabilities?.compensation&&isPhpHome(e.employment_type)?phpSalaryBasis(comp):'',
    },
    payment:{
      mode:p.mode||defaultPaymentMode(e.employment_type),
      transfer_using:field('payment.transfer_using',p.transfer_using,capabilities?.payment),
      bank_wallet_account:field('payment.bank_wallet_account',p.bank_wallet_account,capabilities?.payment),
      account_name:field('payment.account_name',p.account_name,capabilities?.payment),
      usdt_address:field('payment.usdt_address',p.usdt_address,capabilities?.payment),
      contact_phone:field('payment.contact_phone',p.contact_phone,capabilities?.payment),
      whatsapp_number:field('payment.whatsapp_number',p.whatsapp_number,capabilities?.payment),
      employee_address:field('payment.employee_address',p.employee_address,capabilities?.payment),
    },
  }
  return {form,maskedFields}
}

export default function AdminEmployeesPage(){
  const adminAccess=useAdminAccess()
  const {locale}=useAdminI18n()
  const {notify}=useAppToast()
  const employeeAccessKey=useMemo(()=>JSON.stringify([
    adminAccess.authUserId||'',Boolean(adminAccess.founder),adminAccess.roleCode||'',
    adminAccess.employeeId||'',adminAccess.dataScope||'',adminAccess.teamId||'',
    adminAccess.positionId||'',adminAccess.permissionKey||'',
  ]),[
    adminAccess.authUserId,adminAccess.founder,adminAccess.roleCode,adminAccess.employeeId,
    adminAccess.dataScope,adminAccess.teamId,adminAccess.positionId,adminAccess.permissionKey,
  ])
  const [sp,setSp]=useSearchParams()
  const requestedEmployeeId=sp.get('employee')||''
  const requestedEmployeeRef=useRef('')
  const detailRequestRef=useRef(0)
  const lastAutoRefreshAtRef=useRef(0)
  const refreshEmployeeDataRef=useRef(null)
  const employeeBootstrapRef=useRef({loaded:false,inFlight:null,accessKey:employeeAccessKey,epoch:0})
  const employeeDirectoryRequestRef=useRef({inFlight:null,activeKey:'',pending:null})
  const masterPositionOptionsRequestRef=useRef(null)
  const historyReadIntentRef=useRef('')
  const pageMountedRef=useRef(true)
  useEffect(()=>{
    pageMountedRef.current=true
    return()=>{pageMountedRef.current=false;refreshEmployeeDataRef.current=null;historyReadIntentRef.current=''}
  },[])
  const publishEmployeeFailure=(operation,reason,{retry,retryLabel='重试',scope=''}={})=>{
    if(!pageMountedRef.current)return null
    return notify({
      type:'error',module:EMPLOYEE_TOAST_MODULE,operation,
      reason:text(reason)||'操作未完成，请稍后重试。',
      dedupeKey:employeeToastDedupeKey(operation,'error',scope),
      retry,retryLabel,
    })
  }
  const publishEmployeeSuccess=(operation,reason,scope='')=>{
    if(!pageMountedRef.current)return null
    return notify({
      type:'success',module:EMPLOYEE_TOAST_MODULE,operation,
      reason:text(reason)||'操作已完成。',
      dedupeKey:employeeToastDedupeKey(operation,'success',scope),
    })
  }
  const refreshMutationConfirmation=()=>refreshEmployeeDataRef.current?.({announceFailure:true})
  const publishMutationFailure=(operation,reason,scope='')=>publishEmployeeFailure(operation,reason,{
    retry:refreshMutationConfirmation,retryLabel:'刷新确认',scope,
  })
  const canViewEmployees=adminAccess.hasPermission('employee.directory.view')
  const canViewResignations=adminAccess.hasPermission('employee.resignations.view')
  const canExportEmployees=adminAccess.hasPermission('employee.directory.export')
  const canViewAnalytics=adminAccess.hasPermission('employee.analytics.view')
  const canViewManagementRisk=canViewAnalytics&&adminAccess.hasPermission(PERMISSIONS.EMPLOYEE_MANAGEMENT_RISK_VIEW)
  const canViewAudit=adminAccess.hasPermission('employee.change_history.view')
  const canViewSensitiveEmployees=adminAccess.hasPermission(PERMISSIONS.SENSITIVE_EMPLOYEE_VIEW)
  const canGenerateActivationCode=adminAccess.hasPermission(PERMISSIONS.USER_ACTIVATION_GENERATE)
  const canManagePrivateNotes=adminAccess.hasPermission(PERMISSIONS.EMPLOYEE_PRIVATE_NOTE_MANAGE)
  const canViewAdjustmentLogs=canViewAudit
    &&adminAccess.hasPermission(PERMISSIONS.ADJUSTMENT_PAGE_VIEW)
    &&adminAccess.hasAnyPermission([PERMISSIONS.ADJUSTMENT_BONUS_VIEW,PERMISSIONS.ADJUSTMENT_DEDUCTION_VIEW])
  const canViewAttendanceLogs=canViewAudit&&adminAccess.hasAnyPermission(['attendance.monthly.view','attendance.today.view','attendance.records.view','attendance.leave.view'])
  const tabs=adminAccess.loading?[]:EMPLOYEE_TABS.filter(item=>{
    const permissions=EMPLOYEE_TAB_PERMISSIONS[item]
    return Array.isArray(permissions)?adminAccess.hasAnyPermission(permissions):adminAccess.hasPermission(permissions)
  })
  const requestedRouteTab=sp.get('tab')
  const requestedTab=canonicalAdminTab('/admin/employees',requestedRouteTab)
  const initialTab=requestedTab==='入离职记录'?'离职记录':['团队管理','岗位管理'].includes(requestedTab)?'人员分析':requestedTab
  const [tab,setTabState]=useState(EMPLOYEE_TABS.includes(initialTab)?initialTab:'员工档案')
  const auditLogViews=[
    {key:'employment',label:'在职离职操作日志',allowed:canViewAudit},
    {key:'adjustment',label:'奖金扣款录入日志',allowed:canViewAdjustmentLogs},
    {key:'attendance',label:'出勤录入日志',allowed:canViewAttendanceLogs},
  ].filter(item=>item.allowed)
  const requestedAuditView=text(sp.get('log'))
  const auditSubview=auditLogViews.some(item=>item.key===requestedAuditView)?requestedAuditView:(auditLogViews[0]?.key||'employment')

  const [meta,setMeta]=useState(emptyEmployeeMeta)
  const [metaError,setMetaError]=useState('')
  const [rows,setRows]=useState([])
  const [total,setTotal]=useState(0)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSizeState]=useState(20)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [refreshing,setRefreshing]=useState(false)
  const [exporting,setExporting]=useState(false)
  const [generated,setGenerated]=useState(null)
  const [activationError,setActivationError]=useState('')
  const [activationLoading,setActivationLoading]=useState('')
  const [activationCopyStatus,setActivationCopyStatus]=useState('')
  const [showFilters,setShowFilters]=useState(true)
  const [filters,setFilters]=useState(blankEmployeeFilters)
  const [appliedFilters,setAppliedFilters]=useState(blankEmployeeFilters)

  const [selected,setSelected]=useState(null)
  const selectedEmployeeIdRef=useRef('')
  selectedEmployeeIdRef.current=text(selected?.employee?.id)
  const [detailLoading,setDetailLoading]=useState(false)
  const [detailError,setDetailError]=useState('')
  const [employeeModal,setEmployeeModal]=useState(null) // {mode,employee_id,form}
  const [resignModal,setResignModal]=useState(null)
  const [editResignModal,setEditResignModal]=useState(null)
  const [restoreModal,setRestoreModal]=useState(null)
  const [cancelHireModal,setCancelHireModal]=useState(null)
  const [privateNoteSelection,setPrivateNoteSelection]=useState({})
  const [batchPrivateNoteModal,setBatchPrivateNoteModal]=useState(null)

  const [analytics,setAnalytics]=useState({
    loading:true,
    error:'',
    kpis:{},
    trend:[],
    teams:[],
    positions:[],
    countries:[],
    shifts:[],
  })
  const [peopleAnalytics,setPeopleAnalytics]=useState({
    loading:true,error:'',kpis:{},trend:[],teams:[],positions:[],countries:[],shifts:[],
  })
  const [managementRisk,setManagementRisk]=useState({loading:false,error:'',organization:{teams:[],groups:[],managers:[]},repeat_employees:[],common_issues:[],trend:[],options:{teams:[],groups:[],managers:[]}})
  const [managementRiskFilters,setManagementRiskFilters]=useState(blankManagementRiskFilters)
  const [appliedManagementRiskFilters,setAppliedManagementRiskFilters]=useState(blankManagementRiskFilters)
  const [managementRiskDimension,setManagementRiskDimension]=useState('teams')
  const managementRiskRequestRef=useRef({inFlight:null,activeFilterKey:'',pendingFilters:null})
  const managementRiskCacheRef=useRef(new Map())
  const [archiveStats,setArchiveStats]=useState({loading:false,error:'',as_of:'',active:0,total:0,latest_updated_at:'',refreshed_at:'',tenure:[],positions:[],platforms:[],countries:[]})
  const [analysisFilters,setAnalysisFilters]=useState(blankPeopleFilters)
  const [appliedAnalysisFilters,setAppliedAnalysisFilters]=useState(blankPeopleFilters)
  const [analysisDetail,setAnalysisDetail]=useState(null)
  const [analysisDetailLoading,setAnalysisDetailLoading]=useState(false)
  const [analysisView,setAnalysisView]=useState(requestedTab==='团队管理'?'团队分析':requestedTab==='岗位管理'?'岗位分析':'总览')
  const analysisViews=useMemo(()=>canViewManagementRisk?[...BASE_ANALYSIS_VIEWS,'管理风险']:BASE_ANALYSIS_VIEWS,[canViewManagementRisk])
  const [resignationAnalytics,setResignationAnalytics]=useState({loading:true,error:'',kpis:{},trend:[],teams:[],positions:[],countries:[],shifts:[]})
  const [resignationAnalyticsFilters,setResignationAnalyticsFilters]=useState(blankResignationAnalyticsFilters)
  const [appliedResignationAnalyticsFilters,setAppliedResignationAnalyticsFilters]=useState(blankResignationAnalyticsFilters)

  const [history,setHistory]=useState([])
  const [historyPermissions,setHistoryPermissions]=useState({can_edit:false,can_restore:false,can_delete:false})
  const [historyTotal,setHistoryTotal]=useState(0)
  const [historyPage,setHistoryPage]=useState(1)
  const [historyPageSize,setHistoryPageSizeState]=useState(()=>Number(localStorage.getItem('wfh_history_page_size'))||20)
  const [historyLoading,setHistoryLoading]=useState(false)
  const [historyFilters,setHistoryFilters]=useState(blankHistoryFilters)
  const [historyDraftFilters,setHistoryDraftFilters]=useState(blankHistoryFilters)
  const [reasonPreview,setReasonPreview]=useState(null)

  const [auditRows,setAuditRows]=useState([])
  const [auditTotal,setAuditTotal]=useState(0)
  const [auditPage,setAuditPage]=useState(1)
  const [auditPageSize,setAuditPageSize]=useState(20)
  const [auditLoading,setAuditLoading]=useState(false)
  const [auditFilters,setAuditFilters]=useState(blankAuditFilters)
  const [auditDraftFilters,setAuditDraftFilters]=useState(blankAuditFilters)

  const [teamKeyword,setTeamKeyword]=useState('')
  const [appliedTeamKeyword,setAppliedTeamKeyword]=useState('')
  const [teamPageSize,setTeamPageSize]=useState(20)
  const [teamPage,setTeamPage]=useState(1)

  const [positionKeyword,setPositionKeyword]=useState('')
  const [appliedPositionKeyword,setAppliedPositionKeyword]=useState('')
  const [positionPageSize,setPositionPageSize]=useState(20)
  const [positionPage,setPositionPage]=useState(1)

  const invoke=async body=>{
    const {data,error}=await supabase.functions.invoke('admin-employees',{body})
    if(error||data?.error) throw new Error(await edgeFunctionErrorMessage({data,error,fallback:'操作失败'}))
    return data
  }

  useEffect(()=>{
    if(!canViewEmployees||!requestedEmployeeId||requestedEmployeeRef.current===requestedEmployeeId)return
    let cancelled=false
    const requestId=++detailRequestRef.current
    const requestEpoch=employeeBootstrapRef.current.epoch
    requestedEmployeeRef.current=requestedEmployeeId
    setSelected({employee:{id:requestedEmployeeId},missing_fields:[]})
    setDetailLoading(true);setDetailError('')
    withEmployeeDetailTimeout(invoke({action:'detail',employee_id:requestedEmployeeId}))
      .then(detail=>{
        if(!cancelled&&detailRequestRef.current===requestId&&employeeBootstrapRef.current.epoch===requestEpoch){
          setSelected(detail)
          setDetailError(employeeDetailPartialError(detail))
        }
      })
      .catch(e=>{
        if(!cancelled&&detailRequestRef.current===requestId&&employeeBootstrapRef.current.epoch===requestEpoch){
          setDetailError(`${employeeRequestError(e,'完整档案读取失败，已保留当前可见资料。')}请重试。`)
        }
      })
      .finally(()=>{if(!cancelled&&detailRequestRef.current===requestId&&employeeBootstrapRef.current.epoch===requestEpoch)setDetailLoading(false)})
    return()=>{cancelled=true}
  },[requestedEmployeeId,canViewEmployees,employeeAccessKey])

  const writeEmployee=async body=>{
    const {data,error}=await supabase.functions.invoke('admin-employee-write',{body})
    if(error||data?.error) throw new Error(await edgeFunctionErrorMessage({data,error,fallback:'员工资料保存失败'}))
    return data
  }

  const checkEmployeeIdentity=async body=>{
    const {data,error}=await supabase.functions.invoke('admin-employee-write',{body:{action:'check_identity',...body}})
    if(error||data?.error) throw new Error(await edgeFunctionErrorMessage({data,error,fallback:'员工ID / 姓名检查失败'}))
    return data
  }

  const loadMasterPositionOptions=async()=>{
    const {data,error}=await supabase.functions.invoke('admin-employee-write',{body:{action:'get_master_position_options'}})
    if(error||data?.error) return []
    return Array.isArray(data?.rows)?data.rows:[]
  }

  const ensureMasterPositionOptions=async()=>{
    if(meta.position_options?.length)return meta.position_options
    if(!masterPositionOptionsRequestRef.current){
      masterPositionOptionsRequestRef.current=loadMasterPositionOptions().finally(()=>{
        masterPositionOptionsRequestRef.current=null
      })
    }
    const rows=await masterPositionOptionsRequestRef.current
    if(rows.length)setMeta(current=>({...current,position_options:rows}))
    return rows
  }

  const loadPageFilterOptions=async(includeInactive=tab==='离职记录',{announceFailure=false,operation='读取员工筛选项'}={})=>{
    if(!pageMountedRef.current)return false
    try{
      const data=await invoke({action:'filter_options',include_inactive:includeInactive})
      if(!pageMountedRef.current)return false
      setMeta(current=>({
        ...current,
        teams:data?.teams||current.teams,
        positions:data?.positions||current.positions,
        options:{...current.options,...(data?.options||{})},
      }))
      setMetaError('')
      return true
    }catch(e){
      if(!pageMountedRef.current)return false
      const message=employeeRequestError(e,'筛选选项读取失败，请稍后重试。')
      setMetaError(message)
      if(announceFailure)publishEmployeeFailure(operation,message,{
        retry:()=>loadPageFilterOptions(includeInactive,{announceFailure:true,operation}),
      })
      return false
    }
  }

  const loadArchiveStats=async(silent=false)=>{
    if(!pageMountedRef.current)return false
    if(!silent) setArchiveStats(v=>({...v,loading:true}))
    try{
      const {data,error}=await supabase.functions.invoke('admin-employee-stats',{body:{action:'overview'}})
      if(!pageMountedRef.current)return false
      if(error||data?.error) throw new Error(await edgeFunctionErrorMessage({data,error,fallback:'员工结构统计读取失败'}))
      setArchiveStats({...data,loading:false,error:'',refreshed_at:new Date().toISOString()})
      return true
    }catch(e){
      if(!pageMountedRef.current)return false
      setArchiveStats(v=>({...v,loading:false,error:e.message||'员工结构统计读取失败'}))
      return false
    }
  }

  const loadPeopleAnalytics=async(nextFilters=appliedAnalysisFilters,{announceFailure=false,operation='查询人员分析'}={})=>{
    if(!pageMountedRef.current)return false
    setPeopleAnalytics(v=>({...v,loading:true,error:''}))
    try{
      const d=new Date()
      const today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const data=await invoke({action:'analytics',today,filters:nextFilters})
      if(!pageMountedRef.current)return false
      setPeopleAnalytics({...data,loading:false,error:''})
      // The unfiltered response is also the base directory used by team and
      // position views. Reuse it instead of sending a duplicate heavy request.
      if(!hasFilterValues(nextFilters)){
        setAnalytics({...data,loading:false,error:''})
        setResignationAnalytics({...data,loading:false,error:''})
      }
      return true
    }catch(e){
      if(!pageMountedRef.current)return false
      const message=employeeRequestError(e,'人员分析读取失败，请重试。')
      setPeopleAnalytics(v=>({...v,loading:false,error:message}))
      if(!hasFilterValues(nextFilters)) setAnalytics(v=>({...v,loading:false,error:message}))
      if(announceFailure)publishEmployeeFailure(operation,message,{
        retry:()=>loadPeopleAnalytics(nextFilters,{announceFailure:true,operation}),
      })
      return false
    }
  }

  const loadManagementRisk=(nextFilters=appliedManagementRiskFilters,{announceFailure=false,operation='查询管理风险',force=false}={})=>{
    if(!pageMountedRef.current)return Promise.resolve(false)
    if(!canViewManagementRisk) return Promise.resolve(true)
    const requestState=managementRiskRequestRef.current
    const requestedFilters={...blankManagementRiskFilters(),...(nextFilters||{})}
    const requestedFilterKey=JSON.stringify(requestedFilters)
    const requestedCacheKey=JSON.stringify([employeeAccessKey,requestedFilters,50])

    const announceRequestFailure=task=>task.then(success=>{
      if(!success)publishEmployeeFailure(operation,requestState.failureMessage||'管理风险分析读取失败，筛选条件已保留，请重试。',{
        retry:()=>loadManagementRisk(requestedFilters,{announceFailure:true,operation,force:true}),
      })
      return success
    })

    if(requestState.inFlight){
      // Keep only the latest explicit request. If the user returns to the
      // currently running filters, its response is already the desired one.
      requestState.pendingFilters=requestedFilterKey===requestState.activeFilterKey
        ? null
        : requestedFilters
      if(!announceFailure)return requestState.inFlight
      return announceRequestFailure(requestState.inFlight)
    }

    if(!force){
      const cached=managementRiskCacheRef.current.get(requestedCacheKey)
      if(cached&&Date.now()-cached.cachedAt<MANAGEMENT_RISK_CACHE_TTL_MS){
        setAppliedManagementRiskFilters(requestedFilters)
        setManagementRisk({...cached.data,loading:false,error:''})
        return Promise.resolve(true)
      }
      if(cached)managementRiskCacheRef.current.delete(requestedCacheKey)
    }

    requestState.failureMessage=''
    const drainRequests=async()=>{
      let activeFilters=requestedFilters
      let finalSuccess=true
      while(activeFilters){
        const activeCacheKey=JSON.stringify([employeeAccessKey,activeFilters,50])
        requestState.activeFilterKey=JSON.stringify(activeFilters)
        requestState.pendingFilters=null
        // "Applied" means the RPC really started; queued filters must not be
        // shown as applied while an older response is still in flight.
        setAppliedManagementRiskFilters(activeFilters)
        setManagementRisk(current=>({...current,loading:true,error:''}))

        let responseData=null
        let responseError=''
        try{
          const {data,error}=await withAbortTimeout(
            signal=>supabase.rpc('admin_employee_management_risk',{
              p_date_from:activeFilters.date_from||null,
              p_date_to:activeFilters.date_to||null,
              p_filters:{
                team:activeFilters.team||'',group:activeFilters.group||'',manager:activeFilters.manager||'',
                manager_role:activeFilters.manager_role||'',employee_search:activeFilters.employee_search||'',
              },
              p_top_limit:50,
            }).abortSignal(signal),
            MANAGEMENT_RISK_REQUEST_TIMEOUT_MS,
            'MANAGEMENT_RISK_TIMEOUT',
          )
          if(!pageMountedRef.current)return false
          if(error||data?.error) throw new Error(readableErrorMessage(error||data?.error)||'管理风险分析读取失败')
          responseData=data
          const cache=managementRiskCacheRef.current
          cache.delete(activeCacheKey)
          cache.set(activeCacheKey,{cachedAt:Date.now(),data})
          while(cache.size>MANAGEMENT_RISK_CACHE_MAX_ENTRIES)cache.delete(cache.keys().next().value)
        }catch(e){
          responseError=e?.code==='MANAGEMENT_RISK_TIMEOUT'||e?.message==='MANAGEMENT_RISK_TIMEOUT'
            ? '管理风险分析读取超过12秒，已停止本次请求；筛选条件已保留，请手动重试。'
            : employeeRequestError(e,'管理风险分析读取失败，请重试。')
        }

        const pendingFilters=requestState.pendingFilters
        finalSuccess=!responseError
        requestState.failureMessage=responseError
        if(!pendingFilters){
          if(responseError) setManagementRisk(current=>({...current,loading:false,error:responseError}))
          else setManagementRisk({...responseData,loading:false,error:''})
        }
        activeFilters=pendingFilters
      }
      return finalSuccess
    }

    requestState.inFlight=drainRequests().finally(()=>{
      requestState.inFlight=null
      requestState.activeFilterKey=''
      requestState.pendingFilters=null
    })
    return announceFailure?announceRequestFailure(requestState.inFlight):requestState.inFlight
  }

  const announceUserManagementRisk=(task,nextFilters,operation='查询管理风险')=>task.then(success=>{
    if(!success)publishEmployeeFailure(operation,managementRiskRequestRef.current.failureMessage||'管理风险分析读取失败，筛选条件已保留，请重试。',{
      retry:()=>loadManagementRisk(nextFilters,{announceFailure:true,operation,force:true}),
    })
    return success
  })

  const loadResignationAnalytics=async(nextFilters=appliedResignationAnalyticsFilters,{announceFailure=false,operation='查询离职分析'}={})=>{
    if(!pageMountedRef.current)return false
    setResignationAnalytics(v=>({...v,loading:true,error:''}))
    try{
      const d=new Date()
      const today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const data=await invoke({action:'analytics',today,filters:nextFilters})
      if(!pageMountedRef.current)return false
      setResignationAnalytics({...data,loading:false,error:''})
      return true
    }catch(e){
      if(!pageMountedRef.current)return false
      const message=employeeRequestError(e,'离职分析读取失败，请重试。')
      setResignationAnalytics(v=>({...v,loading:false,error:employeeRequestError(e,'离职分析读取失败，请重试。')}))
      if(announceFailure)publishEmployeeFailure(operation,message,{
        retry:()=>loadResignationAnalytics(nextFilters,{announceFailure:true,operation}),
      })
      return false
    }
  }

  const fetchEmployeeListData=async(nextPage,nextSize,nextFilters=appliedFilters,forExport=false)=>{
    const archiveFilters={...nextFilters,status:'active'}
    if(text(archiveFilters.risk_level)||text(archiveFilters.account_status)){
      const {data,error}=await supabase.functions.invoke('admin-employee-risk-list',{body:{action:'list',page:nextPage,page_size:nextSize,filters:archiveFilters,risk_level:archiveFilters.risk_level,export:forExport}})
      if(error||data?.error) throw new Error(await edgeFunctionErrorMessage({data,error,fallback:'等级筛选读取失败'}))
      return data
    }
    return await invoke({action:'list',page:nextPage,page_size:nextSize,filters:archiveFilters,export:forExport})
  }

  const applyEmployeeListData=(data,isCurrent=()=>true)=>{
    const visibleRows=(data.rows||[]).filter(r=>text(r.source_type)!=='google_deleted')
    if(!isCurrent())return false
    setRows(visibleRows.map(r=>{
      const totalErrorCount=Number(r.total_error_count||0)
      return {
        ...r,
        month_error_count:Number(r.month_error_count||0),
        total_error_count:totalErrorCount,
        risk_level:riskKeyFromCount(totalErrorCount),
        operator_account:text(r.operator_account),
      }
    }))
    setTotal(Math.max(0,(data.total||0)-((data.rows||[]).length-visibleRows.length)))
    return true
  }

  const executeEmployeeDirectoryRequest=async request=>{
    const state=employeeDirectoryRequestRef.current
    const sameIdentity=()=>pageMountedRef.current&&employeeBootstrapRef.current.epoch===request.epoch
    const isCurrent=()=>sameIdentity()&&!state.pending
    try{
      if(request.kind==='meta'){
        const data=await invoke({action:'meta'})
        if(!sameIdentity())return false
        setMeta(current=>({...data,position_options:current.position_options||[]}))
        setMetaError('')
        employeeBootstrapRef.current.loaded=true
        return true
      }
      if(request.kind==='bootstrap'){
        const data=await invoke({
          action:'bootstrap',page:request.page,page_size:request.pageSize,
          filters:{...request.filters,status:'active'},
        })
        if(!data?.meta||!data?.list)throw new Error('员工档案初始化返回不完整')
        if(!sameIdentity())return false
        setMeta(current=>({...data.meta,position_options:current.position_options||[]}))
        setMetaError('')
        employeeBootstrapRef.current.loaded=true
        // A newer page/filter request may arrive while bootstrap is running.
        // Its metadata is still current for this identity, but its list must
        // not overwrite the newer request that the queue will run next.
        if(state.pending)return false
        if(!applyEmployeeListData(data.list,isCurrent))return false
        return true
      }

      const data=await fetchEmployeeListData(request.page,request.pageSize,request.filters)
      if(!isCurrent())return false
      return applyEmployeeListData(data,isCurrent)
    }catch(e){
      if(request.kind==='meta'&&sameIdentity()){
        setMetaError(employeeRequestError(e,'筛选选项暂时不可用，当前页面仍可继续使用。'))
        return false
      }
      if(isCurrent()&&!request.silent){
        const message=employeeRequestError(e,rows.length?'员工档案刷新失败，已保留当前列表，请稍后重试。':'员工档案读取失败，请稍后重试。')
        setError(employeeRequestError(e,rows.length?'员工档案刷新失败，已保留当前列表，请稍后重试。':'员工档案读取失败，请稍后重试。'))
        if(request.announceFailure)publishEmployeeFailure(request.operation||'查询员工档案',message,{
          retry:()=>loadEmployeeDirectory(request.page,request.pageSize,{
            nextFilters:request.filters,announceFailure:true,operation:request.operation||'查询员工档案',
          }),
        })
      }
      return false
    }
  }

  const enqueueEmployeeDirectoryRequest=request=>{
    const state=employeeDirectoryRequestRef.current
    const queued={
      ...request,
      epoch:employeeBootstrapRef.current.epoch,
      key:JSON.stringify([request.kind,request.page,request.pageSize,request.filters,employeeBootstrapRef.current.epoch]),
    }
    if(state.inFlight){
      if(state.pending?.key===queued.key){
        if(queued.announceFailure)state.pending=queued
        return state.inFlight
      }
      if(state.activeKey===queued.key){
        if(queued.announceFailure){
          state.pending=queued
          return state.inFlight
        }
        // The newest intent returned to the request already in flight. Drop a
        // superseded queued request so the active result may be applied.
        state.pending=null
        return state.inFlight
      }
      // Serialize directory reads and keep only the newest requested page/filter.
      // This prevents focus refreshes and fast filter changes from stacking the
      // expensive scope RPC or allowing an older response to overwrite the UI.
      state.pending=queued
      return state.inFlight
    }

    let task
    const drain=async()=>{
      let current=queued
      let success=false
      while(current){
        state.activeKey=current.key
        state.pending=null
        success=await executeEmployeeDirectoryRequest(current)
        current=state.pending
      }
      return success
    }
    task=drain().finally(()=>{
      if(state.inFlight===task){state.inFlight=null;state.activeKey='';state.pending=null}
    })
    state.inFlight=task
    return task
  }

  const loadBootstrap=async(nextPage=1,nextSize=pageSize,{silent=false,nextFilters=appliedFilters,announceFailure=false,operation='查询员工档案'}={})=>{
    if(!pageMountedRef.current)return false
    if(!silent){setLoading(true);setError('')}
    try{
      return await enqueueEmployeeDirectoryRequest({kind:'bootstrap',page:nextPage,pageSize:nextSize,filters:nextFilters,silent,announceFailure,operation})
    }finally{
      if(!silent&&pageMountedRef.current)setLoading(false)
    }
  }

  const loadList=async(nextPage=page,nextSize=pageSize,{silent=false,nextFilters=appliedFilters,announceFailure=false,operation='查询员工档案'}={})=>{
    if(!pageMountedRef.current)return false
    if(!silent){setLoading(true);setError('')}
    try{
      return await enqueueEmployeeDirectoryRequest({kind:'list',page:nextPage,pageSize:nextSize,filters:nextFilters,silent,announceFailure,operation})
    }finally{
      if(!silent&&pageMountedRef.current)setLoading(false)
    }
  }

  const loadEmployeeDirectory=async(nextPage=page,nextSize=pageSize,{silent=false,nextFilters=appliedFilters,refreshMeta=true,announceFailure=false,operation='查询员工档案'}={})=>{
    if(!pageMountedRef.current)return false
    const usesSpecialReader=Boolean(text(nextFilters?.risk_level)||text(nextFilters?.account_status))
    if(!usesSpecialReader) return loadBootstrap(nextPage,nextSize,{silent,nextFilters,announceFailure,operation})
    if(!silent){setLoading(true);setError('')}
    try{
      if(!refreshMeta) return await enqueueEmployeeDirectoryRequest({kind:'list',page:nextPage,pageSize:nextSize,filters:nextFilters,silent,announceFailure,operation})
      // The regular bootstrap list cannot apply risk/account filters. Queue a
      // metadata-only request followed by the dedicated filtered reader, so an
      // unfiltered bootstrap response can never replace the requested result.
      const metaRequest=enqueueEmployeeDirectoryRequest({kind:'meta',page:nextPage,pageSize:nextSize,filters:nextFilters,silent:true})
      const listRequest=enqueueEmployeeDirectoryRequest({kind:'list',page:nextPage,pageSize:nextSize,filters:nextFilters,silent,announceFailure,operation})
      const results=await Promise.all([metaRequest,listRequest])
      return results[results.length-1]
    }finally{
      if(!silent&&pageMountedRef.current)setLoading(false)
    }
  }

  const loadHistory=async(nextPage=historyPage,nextSize=historyPageSize,nextFilters=historyFilters,{silent=false,announceFailure=false,operation='查询离职记录'}={})=>{
    const readIntent=historyReadIntentRef.current
    historyReadIntentRef.current=''
    const shouldAnnounceFailure=announceFailure||Boolean(readIntent)
    const readOperation=readIntent||operation
    if(!pageMountedRef.current)return false
    if(!silent){ setHistoryLoading(true); setError('') }
    try{
      const data=await invoke({action:'history_list',page:nextPage,page_size:nextSize,filters:nextFilters})
      if(!pageMountedRef.current)return false
      const rawRows=data.rows||[]
      const productionRows=rawRows.filter(r=>!isTestEmployeeNo(r.employee_no))
      const cleaned=dedupeAnalysisRows(productionRows)
      setHistory(cleaned)
      setHistoryPermissions(data.permissions||{can_edit:false,can_restore:false,can_delete:false})
      const hiddenTest=rawRows.length-productionRows.length
      setHistoryTotal(Math.max(0,(data.total||0)-hiddenTest-(productionRows.length-cleaned.length)))
      return true
    }catch(e){
      if(!pageMountedRef.current)return false
      if(!silent){
        const message=employeeRequestError(e,'离职记录读取失败，请重试。')
        setError(message)
        if(shouldAnnounceFailure)publishEmployeeFailure(readOperation,message,{
          retry:()=>loadHistory(nextPage,nextSize,nextFilters,{announceFailure:true,operation:readOperation}),
        })
      }
      return false
    }
    finally{ if(!silent&&pageMountedRef.current) setHistoryLoading(false) }
  }

  const loadAudit=async(nextPage=auditPage,nextSize=auditPageSize,nextFilters=auditFilters,{silent=false,announceFailure=false,operation='查询员工操作日志'}={})=>{
    if(!pageMountedRef.current)return false
    if(!silent){ setAuditLoading(true); setError('') }
    try{
      const data=await writeEmployee({action:'audit_list',page:nextPage,page_size:nextSize,filters:nextFilters})
      if(!pageMountedRef.current)return false
      setAuditRows(data.rows||[])
      setAuditTotal(data.total||0)
      return true
    }catch(e){
      if(!pageMountedRef.current)return false
      if(!silent){
        const message=employeeRequestError(e,'员工操作日志读取失败，请重试。')
        setError(message)
        if(announceFailure)publishEmployeeFailure(operation,message,{
          retry:()=>loadAudit(nextPage,nextSize,nextFilters,{announceFailure:true,operation}),
        })
      }
      return false
    }
    finally{ if(!silent&&pageMountedRef.current) setAuditLoading(false) }
  }

  const refreshEmployeeData=async({silent=false,announceFailure=false}={})=>{
    if(!pageMountedRef.current)return false
    if(!silent) setRefreshing(true)
    try{
      const jobs=[]
      if(canViewEmployees&&tab==='员工档案'){
        jobs.push(loadEmployeeDirectory(page,pageSize,{silent,nextFilters:appliedFilters}))
      }
      else if(canViewAnalytics||canViewResignations||canViewAudit) jobs.push(loadPageFilterOptions(tab==='离职记录'))
      if(canViewEmployees||canViewAnalytics) jobs.push(loadArchiveStats(true))
      if(canViewAnalytics&&tab==='人员分析'){
        if(analysisView==='管理风险'&&canViewManagementRisk) jobs.push(loadManagementRisk(appliedManagementRiskFilters,{force:!silent}))
        else{
          jobs.push(loadPeopleAnalytics(appliedAnalysisFilters))
          // The default resignation data is identical to the default people
          // analytics payload and is populated by loadPeopleAnalytics above.
          if(hasFilterValues(appliedResignationAnalyticsFilters)) jobs.push(loadResignationAnalytics(appliedResignationAnalyticsFilters))
        }
      }
      if(canViewResignations&&tab==='离职记录') jobs.push(loadHistory(historyPage,historyPageSize,historyFilters,{silent}))
      if(canViewAudit&&tab==='操作日志'&&auditSubview==='employment') jobs.push(loadAudit(auditPage,auditPageSize,auditFilters,{silent}))
      if(canViewEmployees&&selected?.employee?.id){
        const selectedEmployeeId=text(selected.employee.id)
        const detailRequestId=detailRequestRef.current
        jobs.push(withEmployeeDetailTimeout(invoke({action:'detail',employee_id:selectedEmployeeId})).then(d=>{
          if(detailRequestRef.current!==detailRequestId||selectedEmployeeIdRef.current!==selectedEmployeeId)return
          setSelected(prev=>{
            if(detailRequestRef.current!==detailRequestId||text(prev?.employee?.id)!==selectedEmployeeId)return prev
            return mergeEmployeeDetailRefresh(prev,d)
          })
          setDetailError(employeeDetailPartialError(d))
          return true
        }).catch(()=>false))
      }
      const outcomes=await Promise.all(jobs)
      if(!pageMountedRef.current)return false
      lastAutoRefreshAtRef.current=Date.now()
      const success=outcomes.every(outcome=>outcome!==false)
      if(!silent&&announceFailure&&!success)publishEmployeeFailure(`刷新${tab||'员工数据'}`,'部分数据刷新失败，已保留成功读取的内容；请查看页面内错误后重试。',{
        retry:()=>refreshEmployeeDataRef.current?.({announceFailure:true}),
      })
      return success
    }catch(e){
      if(!pageMountedRef.current)return false
      const message=employeeRequestError(e,'员工数据刷新失败，请稍后重试。')
      if(!silent)setError(message)
      if(!silent&&announceFailure)publishEmployeeFailure(`刷新${tab||'员工数据'}`,message,{
        retry:()=>refreshEmployeeDataRef.current?.({announceFailure:true}),
      })
      return false
    }finally{
      if(!silent&&pageMountedRef.current) setRefreshing(false)
    }
  }
  refreshEmployeeDataRef.current=refreshEmployeeData

  useEffect(()=>{
    if(adminAccess.loading||(!canViewEmployees&&!canViewAnalytics&&!canViewResignations&&!canViewAudit))return undefined
    const refreshIfStale=()=>{
      if(document.hidden||Date.now()-lastAutoRefreshAtRef.current<300000)return
      lastAutoRefreshAtRef.current=Date.now()
      refreshEmployeeDataRef.current?.({silent:true}).catch(()=>{})
    }
    window.addEventListener('focus',refreshIfStale)
    document.addEventListener('visibilitychange',refreshIfStale)
    return()=>{window.removeEventListener('focus',refreshIfStale);document.removeEventListener('visibilitychange',refreshIfStale)}
  },[adminAccess.loading,canViewEmployees,canViewAnalytics,canViewResignations,canViewAudit])
  useEffect(()=>{
    const state=employeeBootstrapRef.current
    if(state.accessKey!==employeeAccessKey){
      state.accessKey=employeeAccessKey
      state.loaded=false
      state.inFlight=null
      state.epoch+=1
      employeeDirectoryRequestRef.current.pending=null
      managementRiskCacheRef.current.clear()
      detailRequestRef.current+=1
      requestedEmployeeRef.current=''
      setRows([]);setTotal(0);setMeta(emptyEmployeeMeta());setMetaError('')
      setSelected(null);setDetailError('');setDetailLoading(false)
      setEmployeeModal(null);setResignModal(null);setEditResignModal(null)
      setRestoreModal(null);setCancelHireModal(null)
      setGenerated(null);setActivationError('');setActivationCopyStatus('')
    }
    // Access invalidation must happen before these guards. Otherwise a user
    // whose directory permission was removed could keep another scope's rows,
    // drawer, or edit form visible until a full page reload.
    if(adminAccess.loading||tab!=='员工档案'||!canViewEmployees)return
    const usesSpecialReader=Boolean(text(appliedFilters.risk_level)||text(appliedFilters.account_status))
    if((state.loaded&&!usesSpecialReader)||state.inFlight)return
    const task=loadEmployeeDirectory(1,pageSize,{nextFilters:appliedFilters})
      .then(success=>{
        if(success){
          lastAutoRefreshAtRef.current=Date.now()
          return loadArchiveStats()
        }
        return null
      })
      .finally(()=>{if(state.inFlight===task)state.inFlight=null})
    state.inFlight=task
  },[adminAccess.loading,canViewEmployees,tab,employeeAccessKey])
  useEffect(()=>{
    if(adminAccess.loading||!['人员分析','操作日志'].includes(tab))return
    if(!canViewAnalytics&&!canViewAudit)return
    loadPageFilterOptions(false)
  },[adminAccess.loading,canViewAnalytics,canViewAudit,tab])
  useEffect(()=>{
    if(adminAccess.loading||tab!=='人员分析'||!canViewAnalytics||archiveStats.loading||archiveStats.refreshed_at)return
    loadArchiveStats()
  },[adminAccess.loading,canViewAnalytics,tab,archiveStats.loading,archiveStats.refreshed_at])
  useEffect(()=>{
    if(adminAccess.loading||tab!=='离职记录'||!canViewResignations)return
    loadPageFilterOptions(true)
  },[adminAccess.loading,canViewResignations,tab])

  useEffect(()=>{
    if(adminAccess.loading)return
    const raw=canonicalAdminTab('/admin/employees',sp.get('tab'))
    const t=raw==='入离职记录'?'离职记录':raw
    const normalized=t==='团队管理'||t==='岗位管理'?'人员分析':t||'员工档案'
    if(!tabs.includes(normalized)){
      const fallback=tabs[0]
      if(fallback){
        setTabState(fallback)
        setSp(fallback==='员工档案'?{}:adminTabParams('/admin/employees',fallback),{replace:true})
      }
      return
    }
    if(t==='团队管理'||t==='岗位管理'){
      setTabState('人员分析')
      setAnalysisView(t==='团队管理'?'团队分析':'岗位分析')
    }else setTabState(normalized)
    const desiredRouteTab=normalized==='员工档案'?null:adminTabSlug('/admin/employees',raw||normalized)
    if(requestedRouteTab!==desiredRouteTab)setSp(desiredRouteTab?{tab:desiredRouteTab}:{},{replace:true})
  },[sp,adminAccess.loading,adminAccess.permissionKey])

  useEffect(()=>{
    if(!canViewResignations||tab!=='离职记录') return
    const t=setTimeout(()=>{ setHistoryPage(1); loadHistory(1,historyPageSize,historyFilters) },80)
    return()=>clearTimeout(t)
  },[tab,canViewResignations])

  useEffect(()=>{
    if(!canViewAudit||tab!=='操作日志'||auditSubview!=='employment') return
    const t=setTimeout(()=>{ setAuditPage(1); loadAudit(1,auditPageSize,auditFilters) },80)
    return()=>clearTimeout(t)
  },[tab,canViewAudit,auditSubview])

  useEffect(()=>{
    if(!canViewAnalytics||tab!=='人员分析') return
    const t=setTimeout(()=>analysisView==='管理风险'&&canViewManagementRisk?loadManagementRisk(appliedManagementRiskFilters):loadPeopleAnalytics(appliedAnalysisFilters),80)
    return()=>clearTimeout(t)
  },[tab,canViewAnalytics])

  useEffect(()=>{
    if(analysisView==='管理风险'&&!canViewManagementRisk) setAnalysisView('总览')
  },[analysisView,canViewManagementRisk])

  useEffect(()=>{
    const handler=e=>{
      const d=e.detail||{}
      setRestoreModal({employee_id:d.employee_id,employee_no:d.employee_no,full_name:d.full_name,restore_portal:true})
    }
    window.addEventListener('wfh-restore-employee',handler)
    return()=>window.removeEventListener('wfh-restore-employee',handler)
  },[])

  const setTab=v=>{
    if(!tabs.includes(v))return
    setTabState(v)
    setSp(v==='员工档案'?{}:adminTabParams('/admin/employees',v))
  }
  const setAuditSubview=key=>{
    if(!auditLogViews.some(item=>item.key===key))return
    const next=new URLSearchParams(sp)
    next.set('tab',adminTabSlug('/admin/employees','操作日志'))
    if(key==='employment') next.delete('log')
    else next.set('log',key)
    setSp(next)
  }

  const setPageSize=n=>{
    setPageSizeState(n); setPage(1); loadList(1,n,{nextFilters:appliedFilters,announceFailure:true})
  }
  const setHistoryPageSize=n=>{
    localStorage.setItem('wfh_history_page_size',String(n))
    setHistoryPageSizeState(n); setHistoryPage(1); loadHistory(1,n,historyFilters,{announceFailure:true})
  }
  const changeAuditPageSize=n=>{
    setAuditPageSize(n); setAuditPage(1); loadAudit(1,n,auditFilters,{announceFailure:true})
  }
  const applyHistoryFilters=()=>{
    const next={...historyDraftFilters}
    setHistoryFilters(next)
    setHistoryPage(1)
    historyReadIntentRef.current='查询离职记录'
    loadHistory(1,historyPageSize,next)
  }
  const resetHistoryFilters=()=>{
    const next=blankHistoryFilters()
    setHistoryDraftFilters(next)
    setHistoryFilters(next)
    setHistoryPage(1)
    historyReadIntentRef.current='重置离职记录查询'
    loadHistory(1,historyPageSize,next)
  }

  const openDetail=async row=>{
    if(!pageMountedRef.current)return
    setSelected({employee:row,missing_fields:row.missing_fields||[]})
    const requestId=++detailRequestRef.current
    setDetailLoading(true);setDetailError('')
    try{
      const detail=await withEmployeeDetailTimeout(invoke({action:'detail',employee_id:row.id}))
      if(!pageMountedRef.current||detailRequestRef.current!==requestId)return
      detail.employee={
        ...row,
        ...(detail.employee||{}),
        month_error_count:row.month_error_count,
        total_error_count:row.total_error_count,
        risk_level:row.risk_level,
      }
      setSelected(detail)
      setDetailError(employeeDetailPartialError(detail))
      if(detail?.employee?.status==='resigned'&&!text(detail.resignation_reason)&&text(detail.employee.employee_no)){
        invoke({action:'history_list',page:1,page_size:20,filters:{employee_no:text(detail.employee.employee_no)}}).then(h=>{
          if(detailRequestRef.current!==requestId)return
          const match=(h.rows||[]).find(x=>text(x.employee_no).toUpperCase()===text(detail.employee.employee_no).toUpperCase()&&text(x.reason))
          if(match)setSelected(current=>current?.employee?.id===row.id?{...current,resignation_reason:text(match.reason)}:current)
        }).catch(()=>{})
      }
    }
    catch(e){
      if(pageMountedRef.current&&detailRequestRef.current===requestId){
        const message=`${employeeRequestError(e,'完整档案读取失败，已保留当前可见资料。')}请重试。`
        setDetailError(message)
        publishEmployeeFailure('读取员工详情',message,{
          retry:()=>openDetail(row),scope:text(row?.id||row?.employee_no),
        })
      }
    }
    finally{ if(pageMountedRef.current&&detailRequestRef.current===requestId)setDetailLoading(false) }
  }

  const openCreate=()=>{
    const capabilities=employeeWriteCapabilities(meta,'create')
    if(!capabilities.basic) return setError('当前账号没有新增员工权限')
    const f=emptyForm()
    setEmployeeModal({mode:'create',employee_id:null,original_employee_no:'',original_full_name:'',form:f,initial_form:f,capabilities,masked_fields:{}})
    // Position write options come from the transactional write function. Keep
    // that extra call off the archive bootstrap path and load it only on demand.
    void ensureMasterPositionOptions()
  }

  const openEdit=async()=>{
    if(!selected?.employee?.id) return
    const detail=selected
    const capabilities=employeeWriteCapabilities(detail,'edit')
    if(!capabilities.basic) return setError('当前账号没有编辑员工权限')
    const bundle=bundleToForm(detail,capabilities)
    setEmployeeModal({
      mode:'edit',
      employee_id:detail.employee.id,
      original_employee_no:text(detail.employee.employee_no),
      original_full_name:text(detail.employee.full_name),
      form:bundle.form,
      initial_form:bundle.form,
      capabilities,
      masked_fields:bundle.maskedFields,
    })
    void ensureMasterPositionOptions()
  }

  const saveEmployee=async()=>{
    if(!pageMountedRef.current||!employeeModal) return
    const operationEpoch=employeeBootstrapRef.current.epoch
    const {mode,employee_id,form,original_employee_no,original_full_name}=employeeModal
    const operation=mode==='create'?'新增员工':'编辑员工'
    const toastScope=text(employee_id||form?.employee?.employee_no)
    const capabilities=employeeModal.capabilities||{basic:false,sensitiveEmployee:false,compensation:false,payment:false}
    if(!capabilities.basic){
      const message='当前账号没有保存员工资料的权限'
      setError(message);publishEmployeeFailure(operation,message,{scope:toastScope});return
    }
    const employeeNo=text(form.employee.employee_no).toUpperCase()
    if(!employeeNo||!text(form.employee.full_name)){
      const message='员工ID和姓名必须填写'
      setError(message);publishEmployeeFailure(operation,message,{scope:toastScope});return
    }
    if(mode==='create'&&(employeeNo==='SYSTEM'||employeeNo==='ADMIN')){
      const message='SYSTEM / ADMIN 是系统保留ID，不能用于员工。TEST 开头的ID可用于正式表流程测试，但不会计入统计KPI。'
      setError(message);publishEmployeeFailure(operation,message,{scope:employeeNo});return
    }
    let failureOperation=operation
    let writeCompleted=false
    try{
      const initialForm=employeeModal.initial_form||emptyForm()
      const {work_tg,backend_accounts,...ordinaryEmployee}=form.employee
      const employee=patchSection({...ordinaryEmployee,employee_no:employeeNo},'employee',employeeModal.masked_fields,initialForm.employee)
      if(capabilities.sensitiveEmployee){
        Object.assign(employee,patchSection({work_tg,backend_accounts},'employee',employeeModal.masked_fields,initialForm.employee))
      }
      const contactPatch=capabilities.sensitiveEmployee
        ? patchSection(form.contact,'contact',employeeModal.masked_fields,initialForm.contact)
        : {}
      const compensationPatch=capabilities.compensation
        ? patchSection(form.compensation,'compensation',employeeModal.masked_fields,initialForm.compensation,['base_salary','daily_rate','performance_default','meal_allowance','note'])
        : {}
      const paymentPatch=capabilities.payment
        ? patchSection(form.payment,'payment',employeeModal.masked_fields,initialForm.payment,['mode','transfer_using','bank_wallet_account','account_name','usdt_address','contact_phone','whatsapp_number','employee_address'])
        : {}
      const payload={
        action:mode==='create'?'create_employee_full':'update_employee_full',
        employee_id,
        previous_employee_no:mode==='edit'?text(original_employee_no||selected?.employee?.employee_no):'',
        previous_full_name:mode==='edit'?text(original_full_name||selected?.employee?.full_name):'',
        employee,
        sections:{
          employee_sensitive:Object.prototype.hasOwnProperty.call(employee,'work_tg')||Object.prototype.hasOwnProperty.call(employee,'backend_accounts'),
          contact:Object.keys(contactPatch).length>0,
          compensation:Object.keys(compensationPatch).length>0,
          payment:Object.keys(paymentPatch).length>0,
        },
      }
      if(payload.sections.contact) payload.contact=contactPatch
      if(payload.sections.compensation) payload.compensation=compensationPatch
      if(payload.sections.payment) payload.payment=paymentPatch
      const data=await writeEmployee(payload)
      if(!pageMountedRef.current||employeeBootstrapRef.current.epoch!==operationEpoch)return
      writeCompleted=true
      if(mode==='create'&&!sheetSyncSucceeded(data?.sync)){
        let rollbackOk=false
        try{
          await invoke({action:'cancel_new_hire',employee_id:data?.employee_id,confirm_employee_no:employeeNo})
          if(!pageMountedRef.current)return
          rollbackOk=true
        }catch(_){ rollbackOk=false }
        failureOperation=rollbackOk?'同步新增员工':'撤销未同步新增员工'
        throw new Error(`新增失败：正式 Google Sheet 没有写入。${rollbackOk?'Supabase 新增已自动撤销，不会留下半条员工。':'Supabase 自动撤销失败，请立即检查。'} 原因：${sheetSyncMessage(data?.sync)}`)
      }
      if(mode==='edit'&&!sheetSyncSucceeded(data?.sync)){
        failureOperation='同步员工修改'
        throw new Error(`Supabase 已保存，但正式 Google Sheet 同步失败：${sheetSyncMessage(data?.sync)}。请重新保存一次，直到两边同时成功。`)
      }
      setEmployeeModal(null)
      publishEmployeeSuccess(operation,mode==='create'?'员工档案与正式 Google Sheet 已新增。':'员工档案与正式 Google Sheet 已更新。',employeeNo)
      if(mode==='create'){
        // 新增成功只刷新，不再把新员工 ID 自动塞进搜索框。
        setPage(1)
        failureOperation='刷新新增员工结果'
        const refreshOutcomes=await Promise.all([
          loadEmployeeDirectory(1,pageSize,{nextFilters:appliedFilters}),
          loadArchiveStats(),
        ])
        if(!pageMountedRef.current)return
        if(!employeeRefreshSucceeded(refreshOutcomes))throw new Error('员工已新增，但列表或统计刷新失败；请刷新确认最新结果。')
        if(data?.employee_id&&employeeBootstrapRef.current.epoch===operationEpoch){
          failureOperation='读取新增员工详情'
          const detail=await invoke({action:'detail',employee_id:data.employee_id})
          if(pageMountedRef.current&&employeeBootstrapRef.current.epoch===operationEpoch)setSelected(detail)
        }
      }else{
        failureOperation='刷新员工修改结果'
        const refreshOutcomes=await Promise.all([
          loadEmployeeDirectory(page,pageSize,{nextFilters:appliedFilters}),
          loadArchiveStats(),
        ])
        if(!pageMountedRef.current)return
        if(!employeeRefreshSucceeded(refreshOutcomes))throw new Error('员工修改已保存，但列表或统计刷新失败；请刷新确认最新结果。')
        if(employee_id&&employeeBootstrapRef.current.epoch===operationEpoch){
          failureOperation='读取修改后员工详情'
          const detail=await invoke({action:'detail',employee_id})
          if(pageMountedRef.current&&employeeBootstrapRef.current.epoch===operationEpoch)setSelected(detail)
        }
      }
    }catch(e){
      if(!pageMountedRef.current)return
      const message=employeeRequestError(e,`${operation}失败，请稍后重试。`)
      setError(message)
      if(writeCompleted)publishEmployeeFailure(failureOperation,message,{
        retry:refreshMutationConfirmation,retryLabel:'刷新确认',scope:employeeNo,
      })
      else publishMutationFailure(failureOperation,message,employeeNo)
    }
  }

  const openHistoryDetail=async row=>{
    if(!pageMountedRef.current)return
    setDetailLoading(true)
    try{
      let employeeId=text(row?.employee_id)
      // Some lifecycle rows are historical and can miss employee_id. Resolve by exact employee number.
      if(!employeeId&&text(row?.employee_no)){
        const found=await invoke({action:'list',page:1,page_size:5,filters:{employee_no:text(row.employee_no),status:''}})
        if(!pageMountedRef.current)return
        const exact=(found.rows||[]).find(x=>text(x.employee_no).toUpperCase()===text(row.employee_no).toUpperCase())
        employeeId=text(exact?.id||exact?.employee_id)
      }
      if(!employeeId) throw new Error('找不到对应员工档案')
      setSelected({employee:{id:employeeId,employee_no:row?.employee_no,full_name:row?.full_name,status:row?.event_type==='resign'?'resigned':'active'}})
      try{
        const detail=await invoke({action:'detail',employee_id:employeeId})
        if(!pageMountedRef.current)return
        setSelected({...detail,resignation_reason:text(row?.reason)})
      }catch(firstError){
        // Lifecycle data can carry a stale id after test cleanup; retry once by employee number.
        if(!text(row?.employee_no)) throw firstError
        const found=await invoke({action:'list',page:1,page_size:5,filters:{employee_no:text(row.employee_no),status:''}})
        if(!pageMountedRef.current)return
        const exact=(found.rows||[]).find(x=>text(x.employee_no).toUpperCase()===text(row.employee_no).toUpperCase())
        const fallbackId=text(exact?.id||exact?.employee_id)
        if(!fallbackId||fallbackId===employeeId) throw firstError
        const detail=await invoke({action:'detail',employee_id:fallbackId})
        if(!pageMountedRef.current)return
        setSelected({...detail,resignation_reason:text(row?.reason)})
      }
    }catch(e){
      if(!pageMountedRef.current)return
      const message=employeeRequestError(e,'员工档案详情读取失败，请重试。')
      setError(message); setSelected(null)
      publishEmployeeFailure('读取员工详情',message,{
        retry:()=>openHistoryDetail(row),scope:text(row?.employee_id||row?.employee_no),
      })
    }
    finally{ if(pageMountedRef.current)setDetailLoading(false) }
  }

  const drillToEmployees=patch=>{
    const next={...blankEmployeeFilters(),...patch}
    setFilters(next)
    setAppliedFilters(next)
    setPage(1)
    setTab('员工档案')
  }

  const openAnalysisDetail=async({title,event_type='all',dimension='',value='',date_from='',date_to='',filters:detailFilters})=>{
    if(!pageMountedRef.current)return
    const sourceFilters=detailFilters||appliedAnalysisFilters
    setAnalysisDetail({title,event_type,dimension,value,date_from,date_to,rows:[],total:0})
    setAnalysisDetailLoading(true)
    try{
      const data=await invoke({action:'analytics_event_details',event_type,dimension,value,date_from,date_to,limit:2000,filters:sourceFilters})
      if(!pageMountedRef.current)return
      const productionRows=(data.rows||[]).filter(r=>!isTestEmployeeNo(r.employee_no))
      const uniqueRows=dedupeAnalysisRows(productionRows)
      const employeeNos=Array.from(new Set(uniqueRows.map(r=>text(r.employee_no)).filter(Boolean)))
      let dateRows=[]
      if(employeeNos.length){
        const {data:dateData,error:dateError}=await supabase.functions.invoke('admin-employee-dates',{body:{employee_nos:employeeNos}})
        if(!pageMountedRef.current)return
        if(error||dateData?.error) throw new Error(await edgeFunctionErrorMessage({data:dateData,error:dateError,fallback:'员工入离职日期读取失败'}))
        dateRows=dateData?.rows||[]
      }
      const dateMap=new Map(dateRows.map(x=>[text(x.employee_no).toUpperCase(),x]))
      const enrichedRows=uniqueRows.map(r=>{
        const d=dateMap.get(text(r.employee_no).toUpperCase())||{}
        return {...r,hire_date:text(d.hire_date).slice(0,10),resign_date:r.event_type==='resign'?(text(r.date).slice(0,10)||text(d.resign_date).slice(0,10)):text(d.resign_date).slice(0,10)}
      })
      setAnalysisDetail(v=>({...v,...data,rows:enrichedRows,total:enrichedRows.length,title}))
    }catch(e){
      if(!pageMountedRef.current)return
      const message=employeeRequestError(e,'人员明细读取失败，请重试。')
      setError(message); setAnalysisDetail(null)
      publishEmployeeFailure('读取人员分析明细',message,{
        retry:()=>openAnalysisDetail({title,event_type,dimension,value,date_from,date_to,filters:sourceFilters}),
        scope:[event_type,dimension,value,date_from,date_to].join(':'),
      })
    }
    finally{ if(pageMountedRef.current)setAnalysisDetailLoading(false) }
  }

  const openArchiveTenureDetail=async(bucket,label)=>{
    if(!pageMountedRef.current)return
    const detailTitle=bucket==='prepare'?`${label} · 待入职员工`:`${label} · 在职员工`
    setAnalysisDetail({title:detailTitle,event_type:'active',dimension:'',value:'',date_from:'',date_to:'',rows:[],total:0})
    setAnalysisDetailLoading(true)
    try{
      const {data,error}=await supabase.functions.invoke('admin-employee-stats',{body:{action:'tenure_details',bucket,include_test:true}})
      if(!pageMountedRef.current)return
      if(error||data?.error) throw new Error(await edgeFunctionErrorMessage({data,error,fallback:'入职时长人员读取失败'}))
      const uniqueRows=dedupeAnalysisRows(data.rows||[])
      setAnalysisDetail(v=>({...v,...data,rows:uniqueRows,total:uniqueRows.length,title:detailTitle}))
    }catch(e){
      if(!pageMountedRef.current)return
      const message=employeeRequestError(e,'入职时长人员读取失败，请重试。')
      setError(message); setAnalysisDetail(null)
      publishEmployeeFailure('读取入职时长明细',message,{
        retry:()=>openArchiveTenureDetail(bucket,label),scope:text(bucket),
      })
    }
    finally{ if(pageMountedRef.current)setAnalysisDetailLoading(false) }
  }

  const submitResignEdit=async()=>{
    if(!pageMountedRef.current||!editResignModal?.event_id) return
    if(!editResignModal.resign_date||!text(editResignModal.reason)){
      const message='离职日期和离职原因必须填写'
      setError(message);publishEmployeeFailure('编辑离职记录',message,{scope:text(editResignModal.employee_id)});return
    }
    const toastScope=text(editResignModal.employee_id||editResignModal.employee_no)
    let failureOperation='编辑离职记录'
    try{
      const data=await invoke({
        action:'update_resignation',
        event_id:editResignModal.event_id,
        employee_id:editResignModal.employee_id,
        resign_date:editResignModal.resign_date,
        reason:editResignModal.reason,
      })
      if(!pageMountedRef.current)return
      setEditResignModal(null)
      const syncError=!sheetSyncSucceeded(data?.sync)
        ? `离职记录已保存到 Supabase，但正式 Google Sheet 同步失败：${sheetSyncMessage(data?.sync)}`
        : ''
      if(!syncError)publishEmployeeSuccess('编辑离职记录','离职记录与正式 Google Sheet 已更新。',toastScope)
      failureOperation='刷新离职记录修改结果'
      const refreshes=[loadHistory(historyPage,historyPageSize)]
      if(canViewEmployees) refreshes.push(loadEmployeeDirectory(page,pageSize,{nextFilters:appliedFilters}),loadArchiveStats())
      else refreshes.push(loadPageFilterOptions())
      const refreshOutcomes=await Promise.all(refreshes)
      if(!pageMountedRef.current)return
      if(syncError){
        failureOperation='同步离职记录修改'
        throw new Error(`${syncError}${employeeRefreshSucceeded(refreshOutcomes)?'':'；页面结果刷新也失败，请刷新确认。'}`)
      }
      if(!employeeRefreshSucceeded(refreshOutcomes))throw new Error('离职记录已更新，但页面结果刷新失败；请刷新确认最新结果。')
    }catch(e){
      if(!pageMountedRef.current)return
      const message=employeeRequestError(e,'编辑离职记录失败，请稍后重试。')
      setError(message);publishMutationFailure(failureOperation,message,toastScope)
    }
  }

  const submitResign=async()=>{
    if(!pageMountedRef.current||!resignModal?.employee_id) return
    if(!resignModal.resign_date||!text(resignModal.reason)){
      const message='离职日期和离职原因必须填写'
      setError(message);publishEmployeeFailure('办理离职',message,{scope:text(resignModal.employee_id)});return
    }
    const toastScope=text(resignModal.employee_id||resignModal.employee_no)
    let failureOperation='办理离职'
    try{
      const resignedEmployeeId=resignModal.employee_id
      const data=await invoke({action:'resign_employee',...resignModal})
      if(!pageMountedRef.current)return
      // 先从当前在职列表立即移除，再用后端刷新做最终校验，不需要用户 F5。
      setRows(prev=>prev.filter(r=>text(r.id)!==text(resignedEmployeeId)))
      setTotal(prev=>Math.max(0,prev-1))
      setResignModal(null); setSelected(null)
      const syncError=!sheetSyncSucceeded(data?.sync)
        ? `离职已保存到 Supabase，但正式 Google Sheet 同步失败：${sheetSyncMessage(data?.sync)}`
        : ''
      if(!syncError)publishEmployeeSuccess('办理离职','离职状态与正式 Google Sheet 已保存。',toastScope)
      failureOperation='刷新离职结果'
      const refreshes=[loadEmployeeDirectory(1,pageSize,{nextFilters:appliedFilters}),loadArchiveStats()]
      if(canViewResignations){
        setHistoryPage(1)
        setTab('离职记录')
        refreshes.push(loadHistory(1,historyPageSize,historyFilters))
      }
      const refreshOutcomes=await Promise.all(refreshes)
      if(!pageMountedRef.current)return
      if(syncError){
        failureOperation='同步员工离职'
        throw new Error(`${syncError}${employeeRefreshSucceeded(refreshOutcomes)?'':'；页面结果刷新也失败，请刷新确认。'}`)
      }
      if(!employeeRefreshSucceeded(refreshOutcomes))throw new Error('离职已保存，但页面结果刷新失败；请刷新确认最新状态。')
    }catch(e){
      if(!pageMountedRef.current)return
      const message=employeeRequestError(e,'办理离职失败，请稍后重试。')
      setError(message);publishMutationFailure(failureOperation,message,toastScope)
    }
  }

  const submitRestore=async()=>{
    if(!pageMountedRef.current||!restoreModal?.employee_id) return
    const toastScope=text(restoreModal.employee_id||restoreModal.employee_no)
    let failureOperation='恢复员工在职'
    try{
      const data=await invoke({
        action:'undo_resignation',
        employee_id:restoreModal.employee_id,
        restore_portal:restoreModal.restore_portal!==false,
      })
      if(!pageMountedRef.current)return
      setRestoreModal(null)
      setSelected(null)
      const syncError=!sheetSyncSucceeded(data?.sync)
        ? `已恢复 Supabase 在职状态，但正式 Google Sheet 同步失败：${sheetSyncMessage(data?.sync)}`
        : ''
      if(!syncError)publishEmployeeSuccess('恢复员工在职','在职状态、Portal 设置与正式 Google Sheet 已更新。',toastScope)
      failureOperation='刷新恢复在职结果'
      const refreshes=[loadHistory(1,historyPageSize,historyFilters)]
      if(canViewEmployees) refreshes.push(loadEmployeeDirectory(1,pageSize,{nextFilters:appliedFilters}),loadArchiveStats())
      else refreshes.push(loadPageFilterOptions())
      const refreshOutcomes=await Promise.all(refreshes)
      if(!pageMountedRef.current)return
      if(syncError){
        failureOperation='同步恢复在职'
        throw new Error(`${syncError}${employeeRefreshSucceeded(refreshOutcomes)?'':'；页面结果刷新也失败，请刷新确认。'}`)
      }
      if(!employeeRefreshSucceeded(refreshOutcomes))throw new Error('员工已恢复在职，但页面结果刷新失败；请刷新确认最新状态。')
    }catch(e){
      if(!pageMountedRef.current)return
      const message=employeeRequestError(e,'恢复员工在职失败，请稍后重试。')
      setError(message);publishMutationFailure(failureOperation,message,toastScope)
    }
  }

  const submitCancelHire=async()=>{
    if(!pageMountedRef.current||!cancelHireModal?.employee_id) return
    if(text(cancelHireModal.confirm_text)!==text(cancelHireModal.employee_no)){
      const message='请输入完整员工ID确认撤销入职'
      setError(message);publishEmployeeFailure('撤销员工入职',message,{scope:text(cancelHireModal.employee_id)});return
    }
    const toastScope=text(cancelHireModal.employee_id||cancelHireModal.employee_no)
    let failureOperation='撤销员工入职'
    try{
      const data=await writeEmployee({
        action:'cancel_new_hire_any_state',
        employee_id:cancelHireModal.employee_id,
        confirm_employee_no:cancelHireModal.confirm_text,
      })
      if(!pageMountedRef.current)return
      setCancelHireModal(null)
      setSelected(null)
      if(!data?.sheet_warning)publishEmployeeSuccess('撤销员工入职','员工档案已撤销，历史审计记录保留。',toastScope)
      failureOperation='刷新撤销入职结果'
      const refreshes=[loadEmployeeDirectory(1,pageSize,{nextFilters:appliedFilters}),loadArchiveStats()]
      if(canViewResignations) refreshes.push(loadHistory(1,historyPageSize,historyFilters))
      if(canViewAudit) refreshes.push(loadAudit(1,auditPageSize,auditFilters,{silent:true}))
      const refreshOutcomes=await Promise.all(refreshes)
      if(!pageMountedRef.current)return
      if(data?.sheet_warning){
        failureOperation='同步撤销入职'
        throw new Error(`${data.sheet_warning}${employeeRefreshSucceeded(refreshOutcomes)?'':'；页面结果刷新也失败，请刷新确认。'}`)
      }
      if(!employeeRefreshSucceeded(refreshOutcomes))throw new Error('员工入职已撤销，但页面结果刷新失败；请刷新确认最新状态。')
    }catch(e){
      if(!pageMountedRef.current)return
      const message=employeeRequestError(e,'撤销员工入职失败，请稍后重试。')
      setError(message);publishMutationFailure(failureOperation,message,toastScope)
    }
  }

  const generateCode=async employeeNo=>{
    if(!pageMountedRef.current)return
    const target=text(employeeNo)
    setGenerated(null); setActivationError(''); setActivationCopyStatus(''); setActivationLoading(target)
    try{
      const {data,error}=await supabase.functions.invoke('admin-accounts',{body:{action:'generate_activation_code',employee_no:target,valid_hours:72}})
      if(!pageMountedRef.current)return
      if(error||data?.error) throw new Error(await edgeFunctionErrorMessage({data,error,fallback:'激活码生成失败'}))
      if(!text(data?.activation_code)) throw new Error('激活码生成成功，但服务未返回可复制的激活码')
      setGenerated(data)
    }catch(e){
      if(pageMountedRef.current)setActivationError(e.message||'激活码生成失败')
    }finally{
      if(pageMountedRef.current)setActivationLoading('')
    }
  }

  const closeActivationCode=()=>{
    setGenerated(null)
    setActivationCopyStatus('')
  }

  const copyActivationCode=async()=>{
    const code=text(generated?.activation_code)
    if(!code) return
    try{
      if(navigator.clipboard?.writeText){
        await navigator.clipboard.writeText(code)
      }else{
        const input=document.createElement('textarea')
        input.value=code
        input.setAttribute('readonly','')
        input.style.position='fixed'
        input.style.opacity='0'
        document.body.appendChild(input)
        input.select()
        const copied=document.execCommand('copy')
        input.remove()
        if(!copied) throw new Error('copy failed')
      }
      setActivationCopyStatus('已复制，可直接发给员工')
    }catch{
      setActivationCopyStatus('复制失败，请选中激活码后手动复制')
    }
  }

  const exportEmployeeArchive=async()=>{
    if(!pageMountedRef.current||exporting||!canExportEmployees)return
    setExporting(true)
    setError('')
    try{
      const collected=new Map()
      let nextPage=1
      let expectedPages=1
      while(nextPage<=expectedPages){
        const data=await fetchEmployeeListData(nextPage,EMPLOYEE_EXPORT_PAGE_SIZE,appliedFilters,true)
        if(!pageMountedRef.current)return
        expectedPages=Math.max(1,Number(data?.pages||Math.ceil(Number(data?.total||0)/EMPLOYEE_EXPORT_PAGE_SIZE)||1))
        if(expectedPages>EMPLOYEE_EXPORT_MAX_PAGES) throw new Error(`当前筛选超过 ${EMPLOYEE_EXPORT_PAGE_SIZE*EMPLOYEE_EXPORT_MAX_PAGES} 条，请缩小筛选范围后再导出。`)
        const visibleRows=(data?.rows||[]).filter(row=>text(row.source_type)!=='google_deleted')
        visibleRows.forEach((row,index)=>{
          const totalErrorCount=Number(row.total_error_count||0)
          const normalized={
            ...row,
            total_error_count:totalErrorCount,
            risk_level:riskKeyFromCount(totalErrorCount),
            operator_account:text(row.operator_account),
          }
          const risk=employeeRiskMeta(normalized)
          const portalAccount=employeePortalAccountPresentation(normalized)
          const key=text(normalized.id)||`${text(normalized.employee_no)}-${nextPage}-${index}`
          collected.set(key,{
            risk_label:risk?.zh||'—',
            total_error_count:totalErrorCount,
            employee_no:text(normalized.employee_no)||'—',
            full_name:text(normalized.full_name)||'—',
            country:text(normalized.country||normalized.nationality)||'—',
            team:text(normalized.teams?.name)||'—',
            teacher:text(normalized.online_trainer||normalized.trainer_name)||'—',
            position:text(normalized.positions?.name)||'—',
            shift:text(normalized.shift_name)||'—',
            employment_type:typeName(normalized.employment_type),
            status:statusName(normalized.status),
            hire_date:text(normalized.hire_date).slice(0,10)||'—',
            tenure:tenureCompactLabel(normalized.hire_date,normalized.resign_date,normalized.status),
            created_at:formatDateTime(normalized.created_at),
            operator_account:operatorDisplay(normalized.operator_account),
            profile_status:Number(normalized.missing_count||0)>0?`待完善 ${Number(normalized.missing_count)} 项`:'完整',
            account_status:portalAccount.label,
            work_tg:text(normalized.work_tg)||'—',
            backend_accounts:text(normalized.backend_accounts)||'—',
          })
        })
        nextPage+=1
      }
      const exportRows=[...collected.values()]
      if(!exportRows.length) throw new Error('当前筛选没有可导出的员工。')
      const blob=new Blob([employeeArchiveCsv(exportRows)],{type:'text/csv;charset=utf-8'})
      const url=URL.createObjectURL(blob)
      const anchor=document.createElement('a')
      anchor.href=url
      anchor.download=employeeArchiveExportFilename()
      anchor.style.display='none'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    }catch(e){
      if(!pageMountedRef.current)return
      const message=employeeRequestError(e,'员工档案导出失败，请稍后重试。')
      setError(message)
      publishEmployeeFailure('导出员工档案',message,{
        retry:exportEmployeeArchive,scope:JSON.stringify(appliedFilters),
      })
    }finally{
      if(pageMountedRef.current)setExporting(false)
    }
  }

  const pages=Math.max(1,Math.ceil(total/pageSize))
  const historyPages=Math.max(1,Math.ceil(historyTotal/historyPageSize))
  const auditPages=Math.max(1,Math.ceil(auditTotal/auditPageSize))
  const applyEmployeeFilters=()=>{
    const next={...filters}
    setAppliedFilters(next)
    setPage(1)
    loadList(1,pageSize,{nextFilters:next,announceFailure:true})
  }
  const resetEmployeeFilters=()=>{
    const next=blankEmployeeFilters()
    setFilters(next)
    setAppliedFilters(next)
    setPage(1)
    loadList(1,pageSize,{nextFilters:next,announceFailure:true})
  }
  const applyAnalysisFilters=()=>{
    const next={...blankPeopleFilters(),date_from:analysisFilters.date_from,date_to:analysisFilters.date_to}
    if(analysisView==='总览') Object.assign(next,analysisFilters)
    if(analysisView==='团队分析') next.team=analysisFilters.team
    if(analysisView==='岗位分析') Object.assign(next,{team:analysisFilters.team,position:analysisFilters.position})
    if(analysisView==='国家分析') next.country=analysisFilters.country
    if(analysisView==='班次分析') next.shift_name=analysisFilters.shift_name
    setAppliedAnalysisFilters(next)
    loadPeopleAnalytics(next,{announceFailure:true})
  }
  const resetAnalysisFilters=()=>{
    const next=blankPeopleFilters()
    setAnalysisFilters(next)
    setAppliedAnalysisFilters(next)
    loadPeopleAnalytics(next,{announceFailure:true})
  }
  const applyManagementRiskFilters=()=>{
    const next={...managementRiskFilters}
    if(next.date_from&&next.date_to&&next.date_from>next.date_to){
      const message='分析开始日期不能晚于结束日期。'
      setManagementRisk(current=>({...current,error:message}))
      publishEmployeeFailure('查询管理风险',message)
      return
    }
    void announceUserManagementRisk(loadManagementRisk(next,{force:true}),next)
  }
  const resetManagementRiskFilters=()=>{
    const next=blankManagementRiskFilters()
    setManagementRiskFilters(next)
    void announceUserManagementRisk(loadManagementRisk(next,{force:true}),next)
  }
  const setManagementRiskRange=preset=>{
    const next={...managementRiskFilters,...managementRiskDatePreset(preset)}
    setManagementRiskFilters(next)
    void announceUserManagementRisk(loadManagementRisk(next,{force:true}),next)
  }
  const changeAnalysisView=view=>{
    const next={...blankPeopleFilters(),date_from:analysisFilters.date_from,date_to:analysisFilters.date_to}
    setAnalysisView(view)
    if(view==='管理风险'){
      if(canViewManagementRisk) loadManagementRisk(appliedManagementRiskFilters)
      return
    }
    setAnalysisFilters(next)
    setAppliedAnalysisFilters(next)
    if(view!=='离职分析') loadPeopleAnalytics(next)
  }
  const applyResignationAnalyticsFilters=()=>{
    const next={...resignationAnalyticsFilters}
    setAppliedResignationAnalyticsFilters(next)
    loadResignationAnalytics(next,{announceFailure:true})
  }
  const resetResignationAnalyticsFilters=()=>{
    const next=blankResignationAnalyticsFilters()
    setResignationAnalyticsFilters(next)
    setAppliedResignationAnalyticsFilters(next)
    loadResignationAnalytics(next,{announceFailure:true})
  }

  const selectedPrivateNoteEmployees=Object.values(privateNoteSelection)
  const selectedPrivateNoteCount=selectedPrivateNoteEmployees.length
  const togglePrivateNoteEmployee=row=>setPrivateNoteSelection(current=>{
    const next={...current}
    if(next[row.id])delete next[row.id]
    else if(Object.keys(next).length<50)next[row.id]={id:row.id,employee_no:row.employee_no,full_name:row.full_name}
    return next
  })
  const togglePrivateNotePage=checked=>setPrivateNoteSelection(current=>{
    const next={...current}
    if(!checked){
      for(const row of rows)delete next[row.id]
      return next
    }
    for(const row of rows){
      if(Object.keys(next).length>=50)break
      next[row.id]={id:row.id,employee_no:row.employee_no,full_name:row.full_name}
    }
    return next
  })
  const openBatchPrivateNotes=()=>{
    if(!canManagePrivateNotes||!selectedPrivateNoteCount)return
    setBatchPrivateNoteModal({
      employees:selectedPrivateNoteEmployees,
      requestKey:privateNoteRequestKey(),
    })
  }

  const filteredTeams=useMemo(()=>{
    const q=appliedTeamKeyword.trim()
    return (analytics.teams||[]).filter(t=>!q||text(t.name).toLowerCase().includes(q.toLowerCase()))
  },[analytics.teams,appliedTeamKeyword])
  const teamPages=Math.max(1,Math.ceil(filteredTeams.length/teamPageSize))
  const teamSlice=filteredTeams.slice((teamPage-1)*teamPageSize,teamPage*teamPageSize)

  const filteredPositions=useMemo(()=>{
    const q=appliedPositionKeyword.trim()
    return (analytics.positions||[]).filter(p=>!q||text(p.name).toLowerCase().includes(q.toLowerCase()))
  },[analytics.positions,appliedPositionKeyword])
  const positionPages=Math.max(1,Math.ceil(filteredPositions.length/positionPageSize))
  const positionSlice=filteredPositions.slice((positionPage-1)*positionPageSize,positionPage*positionPageSize)
  const visibleTab=tabs.includes(tab)?tab:''
  const pageChrome=adminLocalPageTabs('/admin/employees',tabs,visibleTab)
  const sectionTitle=pageChrome.active.sectionLabel||'员工管理'
  const sectionKicker={alerts:'RISK & NOTIFICATION CENTER',workforce:'WORKFORCE & SCHEDULING',attendance_exams:'ATTENDANCE · EXAMS · REWARDS'}[pageChrome.active.groupId]||'PEOPLE & ORGANIZATION'

  // A failed request in one employee sub-page must not leave a stale banner
  // above every other sub-page after navigation. The destination loader will
  // surface its own current error if that request also fails.
  useEffect(()=>{ setError('') },[visibleTab])

  return <div className="content-page employee-page pro-employee-page">
    <div className="module-title-row">
      <div>
        <div className="module-kicker">{sectionKicker}</div>
        <h1>{sectionTitle}</h1>
      </div>
      <div className="employee-title-actions">
        {visibleTab&&!['停电 / 断网记录','预警记录'].includes(visibleTab)&&<button className="secondary-action employee-refresh-action" onClick={()=>refreshEmployeeData({announceFailure:true})} disabled={refreshing}>{refreshing?'刷新中…':'↻ 刷新数据'}</button>}
        {visibleTab==='员工档案'&&canManagePrivateNotes&&selectedPrivateNoteCount>0&&<button className="secondary-action employee-batch-note-action" onClick={openBatchPrivateNotes}>批量备注（{selectedPrivateNoteCount}）</button>}
        {visibleTab==='员工档案'&&meta.actions?.can_create&&<button className="primary-action" onClick={openCreate}>+ 新增员工</button>}
      </div>
    </div>

    <AdminModuleNav />

    {error&&!['停电 / 断网记录','预警记录'].includes(visibleTab)&&<div className="page-error employee-notice">{error}<button onClick={()=>setError('')}>×</button></div>}
    {metaError&&['员工档案','人员分析','离职记录','操作日志'].includes(visibleTab)&&<div className="employee-inline-sync-note" role="status"><span>{metaError}</span><button type="button" onClick={()=>canViewEmployees&&visibleTab==='员工档案'?loadEmployeeDirectory(page,pageSize,{nextFilters:appliedFilters,announceFailure:true,operation:'重新读取员工档案'}):loadPageFilterOptions(visibleTab==='离职记录',{announceFailure:true})}>重新读取</button></div>}
    {visibleTab==='员工档案'&&<>
      <div className="archive-compact-head">
        <div><h2>员工档案</h2><span>当前仅显示在职员工 · 当前筛选共 {total} 人</span></div>
      </div>
      <div className="filter-card archive-filter-card v24-filter-card">
        <div className="field-search-grid employee-core-search-grid">
          <label className="pro-filter-field" data-native-risk-filter="1"><span>等级</span><select value={filters.risk_level||''} onChange={e=>setFilters({...filters,risk_level:e.target.value})}><option value="">全部等级</option><option value="excellent">优秀（0错误）</option><option value="normal">正常（1–8）</option><option value="attention">注意（9–15）</option><option value="watch">重点（16–30）</option><option value="high">高频（31+）</option></select></label>
          <label className="pro-filter-field"><span>员工ID</span><div className="pro-input-shell"><i>⌕</i><input value={filters.employee_no} onChange={e=>setFilters({...filters,employee_no:e.target.value})} placeholder="输入员工ID"/></div></label>
          <label className="pro-filter-field"><span>姓名</span><div className="pro-input-shell"><i>⌕</i><input value={filters.full_name} onChange={e=>setFilters({...filters,full_name:e.target.value})} placeholder="输入姓名"/></div></label>
          {canViewSensitiveEmployees&&<label className="pro-filter-field"><span>工作TG</span><div className="pro-input-shell"><i>⌕</i><input value={filters.work_tg} onChange={e=>setFilters({...filters,work_tg:e.target.value})} placeholder="输入工作TG"/></div></label>}
          {canViewSensitiveEmployees&&<label className="pro-filter-field"><span>后台账号</span><div className="pro-input-shell"><i>⌕</i><input value={filters.backend_account} onChange={e=>setFilters({...filters,backend_account:e.target.value})} placeholder="输入后台账号"/></div></label>}
          <label className="pro-filter-field"><span>账号激活状态</span><select className="pro-native-select" value={filters.account_status||''} onChange={e=>setFilters({...filters,account_status:e.target.value})}><option value="">全部账号</option><option value="activated">已激活</option><option value="unactivated">未激活</option></select></label>
          <div className="filter-toolbar-actions archive-filter-actions"><button className="secondary-action" onClick={()=>setShowFilters(v=>!v)}>{showFilters?'收起筛选':'更多筛选'}</button><button className="primary-action" onClick={applyEmployeeFilters} disabled={loading}>{loading?'查询中…':'查询'}</button><button className="secondary-action" onClick={resetEmployeeFilters} disabled={loading}>重置</button>{canExportEmployees&&<button type="button" className="secondary-action archive-export-action" title="导出当前筛选的全部员工数据" onClick={exportEmployeeArchive} disabled={exporting||loading||total===0}>{exporting?'导出中…':`⇩ 导出（${total}）`}</button>}</div>
        </div>
        {showFilters&&<div className="filter-grid employee-filter-grid v24-advanced-filter-grid">
          <label>团队<FilterCombo value={filters.team} options={meta.options?.teams||[]} onChange={v=>setFilters({...filters,team:v})} placeholder="全部团队 / 输入搜索" listId="employee-team-filter"/></label>
          <label>岗位<FilterCombo value={filters.position} options={meta.options?.positions||[]} onChange={v=>setFilters({...filters,position:v})} placeholder="全部岗位 / 输入搜索" listId="employee-position-filter"/></label>
          <label>员工国家<FilterCombo value={filters.country} options={meta.options?.countries||[]} onChange={v=>setFilters({...filters,country:v})} placeholder="全部员工国家 / 输入搜索" listId="employee-country-filter"/></label>
          <label>员工类型<select value={filters.employment_type} onChange={e=>setFilters({...filters,employment_type:e.target.value})}><option value="">全部</option>{typeOptions.map(x=><option key={x} value={x}>{x}</option>)}</select></label>
          <label>班次<FilterCombo value={filters.shift_name} options={cleanShiftOptions(meta.options?.shifts||[])} onChange={v=>setFilters({...filters,shift_name:v})} placeholder="全部班次 / 输入搜索" listId="employee-shift-filter"/></label>
          <label>老师<FilterCombo value={filters.teacher} options={meta.options?.trainers||[]} onChange={v=>setFilters({...filters,teacher:v})} placeholder="全部老师 / 输入搜索" listId="employee-teacher-filter"/></label>
          <label>入职日期起<input type="date" value={filters.hire_from} onChange={e=>setFilters({...filters,hire_from:e.target.value})}/></label>
          <label>入职日期止<input type="date" value={filters.hire_to} onChange={e=>setFilters({...filters,hire_to:e.target.value})}/></label>
        </div>}
      </div>

      <div className="module-summary-grid employee-summary-grid employee-kpi-grid archive-kpi-strip">
        <MetricSummary label="在职员工" value={archiveStats.kpis?.active??archiveStats.active??analytics.kpis?.active??meta.active} hint={`员工档案 ${archiveStats.kpis?.total_profiles??archiveStats.total??analytics.kpis?.total_profiles??meta.total??0}`} onClick={()=>openAnalysisDetail({title:'当前在职员工',event_type:'active',filters:{}})}/>
        <MetricSummary label="今日入职" value={archiveStats.kpis?.today_join??analytics.kpis?.today_join??'—'} compare={archiveStats.kpis?.today_join_delta??analytics.kpis?.today_join_delta} compareLabel="较昨日" onClick={()=>openAnalysisDetail({title:'今日入职人员',event_type:'join',date_from:archiveStats.as_of||analytics.as_of,date_to:archiveStats.as_of||analytics.as_of,filters:{}})}/>
        <MetricSummary label="今日离职" value={archiveStats.kpis?.today_resign??analytics.kpis?.today_resign??'—'} compare={archiveStats.kpis?.today_resign_delta??analytics.kpis?.today_resign_delta} compareLabel="较昨日" inverse onClick={()=>openAnalysisDetail({title:'今日离职人员',event_type:'resign',date_from:archiveStats.as_of||analytics.as_of,date_to:archiveStats.as_of||analytics.as_of,filters:{}})}/>
        <MetricSummary label="近7天入职" value={archiveStats.kpis?.join_7d??analytics.kpis?.join_7d??'—'} compare={archiveStats.kpis?.join_7d_delta_pct??analytics.kpis?.join_7d_delta_pct} compareLabel="较前7天" percentCompare onClick={()=>openAnalysisDetail({title:'近7天入职人员',event_type:'join',date_from:isoAdd(archiveStats.as_of||analytics.as_of,-6),date_to:archiveStats.as_of||analytics.as_of,filters:{}})}/>
        <MetricSummary label="近7天离职" value={archiveStats.kpis?.resign_7d??analytics.kpis?.resign_7d??'—'} compare={archiveStats.kpis?.resign_7d_delta_pct??analytics.kpis?.resign_7d_delta_pct} compareLabel="较前7天" percentCompare inverse onClick={()=>openAnalysisDetail({title:'近7天离职人员',event_type:'resign',date_from:isoAdd(archiveStats.as_of||analytics.as_of,-6),date_to:archiveStats.as_of||analytics.as_of,filters:{}})}/>
        <MetricSummary label="近30天净增" value={archiveStats.kpis?.net_30d??analytics.kpis?.net_30d??'—'} hint={`入 ${archiveStats.kpis?.join_30d??analytics.kpis?.join_30d??'—'} / 离 ${archiveStats.kpis?.resign_30d??analytics.kpis?.resign_30d??'—'}`} onClick={()=>openAnalysisDetail({title:'近30天人员流动',event_type:'all',date_from:isoAdd(archiveStats.as_of||analytics.as_of,-29),date_to:archiveStats.as_of||analytics.as_of,filters:{}})}/>
      </div>

      {activationError&&<div className="page-error" style={{marginBottom:12}}>{activationError}</div>}
      <div className="data-card">
        {loading&&rows.length===0?<div className="empty-state">读取中...</div>:rows.length===0?<div className="empty-state">暂无符合条件的员工</div>:<div className="table-scroll">
          <table className="data-table employee-master-table">
            <thead><tr>{canManagePrivateNotes&&<th className="employee-note-select-cell"><input type="checkbox" aria-label="选择当前页员工用于批量备注" checked={rows.length>0&&rows.every(row=>Boolean(privateNoteSelection[row.id]))} onChange={event=>togglePrivateNotePage(event.target.checked)}/></th>}<th className="employee-col-level">等级</th><th className="employee-error-count-col">累计错误</th><th className="employee-col-id">员工ID</th><th className="employee-col-name">姓名</th><th className="employee-col-country">员工国家</th><th className="employee-col-team">团队</th><th className="employee-col-trainer">老师</th><th className="employee-col-position">岗位</th><th className="employee-col-shift">班次</th><th className="employee-col-type">员工类型</th><th className="employee-col-hire-date">入职日期</th><th className="employee-col-tenure">入职时长</th><th className="employee-col-created">录入时间</th><th className="employee-col-operator">操作人账号</th><th className="employee-col-profile">资料</th><th className="employee-col-account">账号</th><th className="employee-col-action">操作</th></tr></thead>
            <tbody>{rows.map(r=>{
              const risk=employeeRiskMeta(r)
              const portalAccount=employeePortalAccountPresentation(r)
              return <tr key={r.id}>
                {canManagePrivateNotes&&<td className="employee-note-select-cell"><input type="checkbox" aria-label={`选择 ${r.employee_no} ${r.full_name} 用于批量备注`} checked={Boolean(privateNoteSelection[r.id])} disabled={!privateNoteSelection[r.id]&&selectedPrivateNoteCount>=50} onChange={()=>togglePrivateNoteEmployee(r)}/></td>}
                <td className="employee-col-level">{risk?<span className={`employee-risk-badge ${risk.className}`} data-admin-i18n-skip title={locale==='en'?`Total errors: ${Number(r.total_error_count||0)}`:`累计错误 ${Number(r.total_error_count||0)} 笔`}>{risk[locale]||risk.zh}</span>:'—'}</td>
                <td className="employee-error-count-cell" data-admin-i18n-skip title={locale==='en'?`${Number(r.total_error_count||0)} total errors`:`累计错误 ${Number(r.total_error_count||0)} 笔`}><strong>{Number(r.total_error_count||0)}</strong><span>{locale==='en'?' errors':' 笔'}</span></td>
                <td className="employee-col-id"><strong>{r.employee_no}</strong></td><td className="employee-col-name"><span className="employee-name-value" title={r.full_name}>{r.full_name}</span></td><td className="employee-col-country">{r.country||r.nationality||'-'}</td><td className="employee-col-team">{r.teams?.name||'-'}</td><td className="employee-col-trainer">{r.online_trainer||r.trainer_name||'-'}</td><td className="employee-col-position">{r.positions?.name||'-'}</td><td className="employee-col-shift">{r.shift_name||'-'}</td><td className="employee-col-type">{typeName(r.employment_type)}</td><td className="employee-col-hire-date employee-hire-date-cell">{text(r.hire_date).slice(0,10)||'-'}</td><td className="employee-col-tenure"><strong>{tenureCompactLabel(r.hire_date,r.resign_date,r.status)}</strong></td><td className="employee-col-created">{formatDateTime(r.created_at)}</td><td className="employee-col-operator"><span className="operator-chip">{operatorDisplay(r.operator_account)}</span></td>
                <td className="employee-col-profile">{r.missing_count>0?<span className="missing-chip">待完善 {r.missing_count}</span>:<span className="profile-chip">完整</span>}</td>
                <td className="employee-col-account"><span className={portalAccount.className}>{portalAccount.label}</span></td>
                <td className="employee-col-action"><div className="row-actions"><button className="table-action" onClick={()=>openDetail(r)}>查看</button>{portalAccount.canGenerateActivationCode&&(meta.actions?.can_generate_activation_code||canGenerateActivationCode)&&<button className="table-action" disabled={activationLoading===text(r.employee_no)} onClick={()=>generateCode(r.employee_no)}>{activationLoading===text(r.employee_no)?'获取中…':'激活码'}</button>}</div></td>
              </tr>
            })}</tbody>
          </table>
        </div>}
        <Pagination page={page} pages={pages} total={total} pageSize={pageSize} loading={loading} onPage={p=>{setPage(p);loadList(p,pageSize,{announceFailure:true})}} onPageSize={setPageSize}/>
      </div>
      {generated&&<ActivationCodeModal data={generated} copyStatus={activationCopyStatus} onCopy={copyActivationCode} onClose={closeActivationCode}/>}
      {batchPrivateNoteModal&&<BatchEmployeePrivateNoteModal state={batchPrivateNoteModal} onClose={()=>setBatchPrivateNoteModal(null)} onAllSucceeded={()=>setPrivateNoteSelection({})}/>}
    </>}

    {visibleTab==='停电 / 断网记录'&&<ConnectivityRecordsPage/>}

    {visibleTab==='预警记录'&&<AdminAlertRecordsPage/>}

    {visibleTab==='人员分析'&&<>
      <div className="analysis-head-row people-analysis-title">
        <h2>人员分析</h2>
        <div className="analysis-badge">实时数据</div>
      </div>

      <div className="employee-analysis-subtabs" role="tablist" aria-label="人员分析子目录">
        {analysisViews.map(x=><button type="button" key={x} className={analysisView===x?'active':''} onClick={()=>changeAnalysisView(x)}>{x}</button>)}
      </div>

      {(analysisView==='管理风险'?managementRisk.error:analysisView==='离职分析'?resignationAnalytics.error:peopleAnalytics.error)&&<div className="employee-inline-sync-note is-error" role="alert"><span>{analysisView==='管理风险'?managementRisk.error:analysisView==='离职分析'?resignationAnalytics.error:peopleAnalytics.error}</span><button type="button" onClick={()=>analysisView==='管理风险'?loadManagementRisk(appliedManagementRiskFilters,{announceFailure:true,operation:'重新读取管理风险',force:true}):analysisView==='离职分析'?loadResignationAnalytics(appliedResignationAnalyticsFilters,{announceFailure:true,operation:'重新读取离职分析'}):loadPeopleAnalytics(appliedAnalysisFilters,{announceFailure:true,operation:'重新读取人员分析'})}>重新读取</button></div>}

      {!['离职分析','管理风险'].includes(analysisView)&&<div className="analytics-filter-panel v24-analytics-filter-panel">
        <div className={`people-filter-grid view-${analysisView}`}>
          {analysisView==='总览'&&<><label className="pro-filter-field"><span>员工ID</span><div className="pro-input-shell"><i>⌕</i><input value={analysisFilters.employee_no} onChange={e=>setAnalysisFilters({...analysisFilters,employee_no:e.target.value})} placeholder="输入员工ID"/></div></label><label className="pro-filter-field"><span>姓名</span><div className="pro-input-shell"><i>⌕</i><input value={analysisFilters.full_name} onChange={e=>setAnalysisFilters({...analysisFilters,full_name:e.target.value})} placeholder="输入姓名"/></div></label>{canViewSensitiveEmployees&&<label className="pro-filter-field"><span>工作TG</span><div className="pro-input-shell"><i>⌕</i><input value={analysisFilters.work_tg} onChange={e=>setAnalysisFilters({...analysisFilters,work_tg:e.target.value})} placeholder="输入工作TG"/></div></label>}</>}
          {['总览','团队分析','岗位分析'].includes(analysisView)&&<label className="pro-filter-field"><span>团队</span><FilterCombo value={analysisFilters.team} options={meta.options?.teams||[]} onChange={v=>setAnalysisFilters({...analysisFilters,team:v})} placeholder="全部团队 / 输入搜索" listId="analysis-team"/></label>}
          {['总览','岗位分析'].includes(analysisView)&&<label className="pro-filter-field"><span>岗位</span><FilterCombo value={analysisFilters.position} options={meta.options?.positions||[]} onChange={v=>setAnalysisFilters({...analysisFilters,position:v})} placeholder="全部岗位 / 输入搜索" listId="analysis-position"/></label>}
          {['总览','国家分析'].includes(analysisView)&&<label className="pro-filter-field"><span>员工国家</span><FilterCombo value={analysisFilters.country} options={meta.options?.countries||[]} onChange={v=>setAnalysisFilters({...analysisFilters,country:v})} placeholder="全部员工国家 / 输入搜索" listId="analysis-country"/></label>}
          {['总览','班次分析'].includes(analysisView)&&<label className="pro-filter-field"><span>班次</span><FilterCombo value={analysisFilters.shift_name} options={cleanShiftOptions(meta.options?.shifts||[])} onChange={v=>setAnalysisFilters({...analysisFilters,shift_name:v})} placeholder="全部班次 / 输入搜索" listId="analysis-shift"/></label>}
          <label className="pro-filter-field people-date-range-field"><span>分析日期区间</span><div className="pro-date-range"><input type="date" value={analysisFilters.date_from} onChange={e=>setAnalysisFilters({...analysisFilters,date_from:e.target.value})}/><b>—</b><input type="date" value={analysisFilters.date_to} onChange={e=>setAnalysisFilters({...analysisFilters,date_to:e.target.value})}/></div></label>
          <div className="filter-toolbar-actions people-filter-actions"><button className="primary-action people-query-action" onClick={applyAnalysisFilters} disabled={peopleAnalytics.loading} aria-busy={peopleAnalytics.loading}>{peopleAnalytics.loading&&<i className="employee-action-spinner" aria-hidden="true"/>}<span>{peopleAnalytics.loading?'查询中':'查询'}</span></button><button className="secondary-action people-reset-action" onClick={resetAnalysisFilters} disabled={peopleAnalytics.loading}>重置</button></div>
        </div>
      </div>}

      {analysisView==='总览'&&<>
        <div className="module-summary-grid employee-summary-grid employee-kpi-grid people-analysis-kpis">
          <MetricSummary label="在职员工" value={peopleAnalytics.kpis?.active??meta.active} hint={`员工档案 ${(peopleAnalytics.kpis?.total_profiles ?? meta.total ?? 0)}`} onClick={()=>openAnalysisDetail({title:'当前在职员工',event_type:'active',filters:appliedAnalysisFilters})}/>
          {peopleAnalytics.period?.active?<>
            <MetricSummary label="区间入职" value={peopleAnalytics.period.join??0} hint={`${peopleAnalytics.period.from} → ${peopleAnalytics.period.to}`} onClick={()=>openAnalysisDetail({title:`${peopleAnalytics.period.label} · 入职人员`,event_type:'join',date_from:peopleAnalytics.period.from,date_to:peopleAnalytics.period.to})}/>
            <MetricSummary label="区间离职" value={peopleAnalytics.period.resign??0} hint={`${peopleAnalytics.period.from} → ${peopleAnalytics.period.to}`} inverse onClick={()=>openAnalysisDetail({title:`${peopleAnalytics.period.label} · 离职人员`,event_type:'resign',date_from:peopleAnalytics.period.from,date_to:peopleAnalytics.period.to})}/>
            <MetricSummary label="区间净增" value={signed(peopleAnalytics.period.net??0)} hint={`入 ${peopleAnalytics.period.join??0} / 离 ${peopleAnalytics.period.resign??0}`} onClick={()=>openAnalysisDetail({title:`${peopleAnalytics.period.label} · 人员流动`,event_type:'all',date_from:peopleAnalytics.period.from,date_to:peopleAnalytics.period.to})}/>
            <MetricSummary label="区间离职率" value={pctText(peopleAnalytics.period.resign_rate??0)} hint="按当前筛选人员口径"/>
            <MetricSummary label="区间天数" value={peopleAnalytics.period.days??1} hint={peopleAnalytics.period.label||'所选日期'}/>
          </>:<>
            <MetricSummary label="今日入职" value={peopleAnalytics.kpis?.today_join??'—'} compare={peopleAnalytics.kpis?.today_join_delta} compareLabel="较昨日" onClick={()=>openAnalysisDetail({title:'今日入职人员',event_type:'join',date_from:peopleAnalytics.as_of,date_to:peopleAnalytics.as_of})}/>
            <MetricSummary label="今日离职" value={peopleAnalytics.kpis?.today_resign??'—'} compare={peopleAnalytics.kpis?.today_resign_delta} compareLabel="较昨日" inverse onClick={()=>openAnalysisDetail({title:'今日离职人员',event_type:'resign',date_from:peopleAnalytics.as_of,date_to:peopleAnalytics.as_of})}/>
            <MetricSummary label="近7天入职" value={peopleAnalytics.kpis?.join_7d??'—'} compare={peopleAnalytics.kpis?.join_7d_delta_pct} compareLabel="较前7天" percentCompare onClick={()=>openAnalysisDetail({title:'近7天入职人员',event_type:'join',date_from:isoAdd(peopleAnalytics.as_of,-6),date_to:peopleAnalytics.as_of})}/>
            <MetricSummary label="近7天离职" value={peopleAnalytics.kpis?.resign_7d??'—'} compare={peopleAnalytics.kpis?.resign_7d_delta_pct} compareLabel="较前7天" percentCompare inverse onClick={()=>openAnalysisDetail({title:'近7天离职人员',event_type:'resign',date_from:isoAdd(peopleAnalytics.as_of,-6),date_to:peopleAnalytics.as_of})}/>
            <MetricSummary label="近30天净增" value={peopleAnalytics.kpis?.net_30d??'—'} hint={`入 ${peopleAnalytics.kpis?.join_30d??'—'} / 离 ${peopleAnalytics.kpis?.resign_30d??'—'}`} onClick={()=>openAnalysisDetail({title:'近30天人员流动',event_type:'all',date_from:isoAdd(peopleAnalytics.as_of,-29),date_to:peopleAnalytics.as_of})}/>
          </>}
        </div>
        <ArchiveStructureStats
          data={archiveStats}
          onTenure={(bucket,label)=>openArchiveTenureDetail(bucket,label)}
          onPosition={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'position',value:name,filters:appliedAnalysisFilters})}
          onCountry={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'country',value:name,filters:appliedAnalysisFilters})}
        />
        <EmployeeAnalyticsOverview
          analytics={peopleAnalytics}
          onTeam={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'team',value:name,filters:appliedAnalysisFilters})}
          onPosition={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'position',value:name,filters:appliedAnalysisFilters})}
          onCountry={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'country',value:name,filters:appliedAnalysisFilters})}
          onShift={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'shift',value:name,filters:appliedAnalysisFilters})}
          onResign={(dimension,value)=>openAnalysisDetail({title:`${value} · ${peopleAnalytics.period?.active?peopleAnalytics.period.label:'近30天'}离职人员`,event_type:'resign',dimension,value,date_from:peopleAnalytics.period?.active?peopleAnalytics.period.from:isoAdd(peopleAnalytics.as_of,-29),date_to:peopleAnalytics.period?.active?peopleAnalytics.period.to:peopleAnalytics.as_of,filters:appliedAnalysisFilters})}
          onDay={date=>openAnalysisDetail({title:`${date} · 人员流动`,event_type:'all',date_from:date,date_to:date,filters:appliedAnalysisFilters})}
        />
      </>}

      {analysisView==='国家分析'&&(peopleAnalytics.loading?<AnalysisLoadingState label="正在读取国家分析"/>:<>
        <CountryTenurePanel analytics={peopleAnalytics} filters={appliedAnalysisFilters} onOpen={args=>openAnalysisDetail(args)}/>
        <CountryPeopleAnalytics
          analytics={peopleAnalytics}
          onOpen={args=>openAnalysisDetail(args)}
          onCountry={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'country',value:name,filters:appliedAnalysisFilters})}
        />
      </>)}

      {analysisView==='班次分析'&&<DimensionAnalysisDirectory
        title="班次分析" subtitle="按当前排班班次查看人数、占比和人员流动。"
        rows={peopleAnalytics.shifts||[]} loading={peopleAnalytics.loading}
        onPeople={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'shift',value:name,filters:appliedAnalysisFilters})}
        onResign={name=>openAnalysisDetail({title:`${name} · 近30天离职人员`,event_type:'resign',dimension:'shift',value:name,date_from:isoAdd(peopleAnalytics.as_of,-29),date_to:peopleAnalytics.as_of,filters:appliedAnalysisFilters})}
      />}

      {analysisView==='离职分析'&&<ResignationAnalyticsPanel
        analytics={resignationAnalytics}
        filters={resignationAnalyticsFilters}
        setFilters={setResignationAnalyticsFilters}
        options={analytics}
        onQuery={applyResignationAnalyticsFilters}
        onReset={resetResignationAnalyticsFilters}
        onOpen={args=>openAnalysisDetail({...args,filters:appliedResignationAnalyticsFilters})}
      />}

      {analysisView==='管理风险'&&canViewManagementRisk&&<ManagementRiskPanel
        data={managementRisk}
        filters={managementRiskFilters}
        setFilters={setManagementRiskFilters}
        dimension={managementRiskDimension}
        setDimension={setManagementRiskDimension}
        onQuery={applyManagementRiskFilters}
        onReset={resetManagementRiskFilters}
        onRange={setManagementRiskRange}
        onOpenEmployee={row=>openDetail({id:row.employee_id,employee_no:row.employee_no,full_name:row.full_name})}
      />}
    </>}
    {visibleTab==='人员分析'&&analysisView==='团队分析'&&<>
      <div className="analysis-head-row">
        <div><h2>团队结构分析</h2><p>团队人数、占全体比例、人员流动和团队内部岗位构成。</p></div>
        <div className="analysis-badge">{analytics.teams?.length||0} 个团队</div>
      </div>
      <TeamAnalysisSummary analytics={analytics}/>
      <div className="data-card analysis-list-card">
        <div className="structure-filter-toolbar">
          <div className="structure-select-wrap"><span>查看团队</span><FilterCombo value={teamKeyword} options={(analytics.teams||[]).map(t=>t.name)} onChange={setTeamKeyword} placeholder="全部团队 / 输入名称搜索" listId="team-manager-filter"/></div>
          <div className="structure-toolbar-actions"><button className="primary-action" onClick={()=>{setAppliedTeamKeyword(teamKeyword);setTeamPage(1)}}>查询</button><button className="secondary-action" onClick={()=>{setTeamKeyword('');setAppliedTeamKeyword('');setTeamPage(1)}}>重置</button></div>
        </div>
        <div className="analysis-card-list">{teamSlice.map(t=><TeamAnalysisCard key={t.name} item={t} onPeople={()=>openAnalysisDetail({title:`${t.name} · 当前成员`,event_type:'active',dimension:'team',value:t.name,filters:{}})} onResign={()=>openAnalysisDetail({title:`${t.name} · 近30天离职人员`,event_type:'resign',dimension:'team',value:t.name,date_from:isoAdd(analytics.as_of,-29),date_to:analytics.as_of,filters:{}})} onPosition={name=>openAnalysisDetail({title:`${t.name} · ${name} · 当前成员`,event_type:'active',dimension:'team',value:t.name,filters:{position:name}})}/>)}</div>
        {!analytics.loading&&!teamSlice.length&&<div className="empty-state">暂无团队数据</div>}
        <Pagination page={teamPage} pages={teamPages} total={filteredTeams.length} pageSize={teamPageSize} loading={analytics.loading} onPage={setTeamPage} onPageSize={n=>{setTeamPageSize(n);setTeamPage(1)}}/>
      </div>
    </>}

    {visibleTab==='人员分析'&&analysisView==='岗位分析'&&<>
      <div className="analysis-head-row">
        <div><h2>岗位结构分析</h2><p>岗位人数、占全体比例、人员流动和岗位在各团队的分布。</p></div>
        <div className="analysis-badge">{analytics.positions?.length||0} 个岗位</div>
      </div>
      <PositionAnalysisSummary analytics={analytics}/>
      <div className="data-card analysis-list-card">
        <div className="structure-filter-toolbar">
          <div className="structure-select-wrap"><span>查看岗位</span><FilterCombo value={positionKeyword} options={(analytics.positions||[]).map(p=>p.name)} onChange={setPositionKeyword} placeholder="全部岗位 / 输入名称搜索" listId="position-manager-filter"/></div>
          <div className="structure-toolbar-actions"><button className="primary-action" onClick={()=>{setAppliedPositionKeyword(positionKeyword);setPositionPage(1)}}>查询</button><button className="secondary-action" onClick={()=>{setPositionKeyword('');setAppliedPositionKeyword('');setPositionPage(1)}}>重置</button></div>
        </div>
        <div className="analysis-card-list">{positionSlice.map(p=><PositionAnalysisCard key={p.name} item={p} onPeople={()=>openAnalysisDetail({title:`${p.name} · 当前人员`,event_type:'active',dimension:'position',value:p.name,filters:{}})} onResign={()=>openAnalysisDetail({title:`${p.name} · 近30天离职人员`,event_type:'resign',dimension:'position',value:p.name,date_from:isoAdd(analytics.as_of,-29),date_to:analytics.as_of,filters:{}})} onTeam={name=>openAnalysisDetail({title:`${p.name} · ${name} · 当前人员`,event_type:'active',dimension:'position',value:p.name,filters:{team:name}})}/>)}</div>
        {!analytics.loading&&!positionSlice.length&&<div className="empty-state">暂无岗位数据</div>}
        <Pagination page={positionPage} pages={positionPages} total={filteredPositions.length} pageSize={positionPageSize} loading={analytics.loading} onPage={setPositionPage} onPageSize={n=>{setPositionPageSize(n);setPositionPage(1)}}/>
      </div>
    </>}

    {visibleTab==='离职记录'&&<div className="data-card resignation-card-pro">
      <div className="section-head resignation-section-head">
        <div><h2>离职记录</h2></div>
        <span>{historyTotal} 人</span>
      </div>

      <div className="resignation-filter-panel v25-resignation-filter-panel resignation-search-panel">
        <label className="resign-filter-field"><span>员工ID</span><div className="pro-input-shell"><i>⌕</i><input value={historyDraftFilters.employee_no} onChange={e=>setHistoryDraftFilters({...historyDraftFilters,employee_no:e.target.value})} placeholder="输入员工ID"/></div></label>
        <label className="resign-filter-field"><span>姓名</span><div className="pro-input-shell"><i>⌕</i><input value={historyDraftFilters.full_name} onChange={e=>setHistoryDraftFilters({...historyDraftFilters,full_name:e.target.value})} placeholder="输入姓名"/></div></label>
        <label className="resign-filter-field"><span>团队</span><FilterCombo value={historyDraftFilters.team} options={meta.options?.teams||[]} onChange={v=>setHistoryDraftFilters({...historyDraftFilters,team:v})} placeholder="全部团队 / 输入搜索" listId="history-team"/></label>
        <label className="resign-filter-field"><span>岗位</span><FilterCombo value={historyDraftFilters.position} options={meta.options?.positions||[]} onChange={v=>setHistoryDraftFilters({...historyDraftFilters,position:v})} placeholder="全部岗位 / 输入搜索" listId="history-position"/></label>
        <label className="resign-filter-field"><span>员工国家</span><FilterCombo value={historyDraftFilters.country} options={meta.options?.countries||[]} onChange={v=>setHistoryDraftFilters({...historyDraftFilters,country:v})} placeholder="全部员工国家 / 输入搜索" listId="history-country"/></label>
        <label className="resign-filter-field v25-resign-reason"><span>离职原因</span><input value={historyDraftFilters.reason} onChange={e=>setHistoryDraftFilters({...historyDraftFilters,reason:e.target.value})} placeholder="输入离职原因关键字"/></label>
        <label className="resign-filter-field v25-resign-date"><span>离职日期区间</span><div className="pro-date-range"><input aria-label="离职日期起" type="date" value={historyDraftFilters.date_from} onChange={e=>setHistoryDraftFilters({...historyDraftFilters,date_from:e.target.value})}/><b>—</b><input aria-label="离职日期止" type="date" value={historyDraftFilters.date_to} onChange={e=>setHistoryDraftFilters({...historyDraftFilters,date_to:e.target.value})}/></div></label>
        <div className="resign-filter-actions v25-resign-actions"><button className="primary-action resignation-query-action" onClick={applyHistoryFilters} disabled={historyLoading}>{historyLoading?'查询中…':'查询'}</button><button className="secondary-action" onClick={resetHistoryFilters} disabled={historyLoading}>重置</button></div>
      </div>

      {!history.length&&historyLoading?<div className="empty-state">读取离职记录...</div>:<div className={`table-scroll resignation-history-table-wrap ${historyLoading?'is-loading':''}`}><table className="data-table lifecycle-table resignation-table-pro">
        <thead><tr><th>离职日期</th><th>员工ID</th><th>姓名</th><th>员工类型</th><th>员工国家</th><th>团队</th><th>岗位</th><th>离职原因</th><th>来源</th><th>操作记录</th><th>操作</th></tr></thead>
        <tbody>{history.map(r=>{
          const s=r.snapshot||{}
          return <tr key={r.id}>
            <td className="date-strong">{r.effective_date||'—'}</td>
            <td><strong>{r.employee_no}</strong></td>
            <td>{r.full_name||'-'}</td>
            <td>{r.employee_type||s.employment_type||'-'}</td>
            <td>{r.employee_country||s.country||'-'}</td>
            <td>{r.team_name||s.team||'-'}</td>
            <td>{r.position_name||s.position||'-'}</td>
            <td className="reason-cell">{text(r.reason)?<button type="button" title="点击查看完整离职原因" onClick={()=>setReasonPreview({reason:text(r.reason),employee_no:r.employee_no,full_name:r.full_name,resign_date:r.effective_date})} style={{display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden',maxWidth:230,padding:0,border:0,background:'transparent',color:'inherit',font:'inherit',lineHeight:1.45,textAlign:'left',cursor:'pointer',wordBreak:'break-word'}}>{text(r.reason).length>90?`${text(r.reason).slice(0,90)}…`:text(r.reason)}</button>:'—'}</td>
            <td>{r.source_label||r.source_sheet||r.source||'-'}</td>
            <td><div className="operation-record"><span className="operator-chip">{operatorDisplay(r.snapshot?.operator_account||r.snapshot?.operator_email||r.snapshot?.last_edited_username||r.operator_account)}</span><small>{formatDateTime(r.snapshot?.operation_time||r.snapshot?.last_edited_at||r.operation_time||r.created_at)}</small></div></td>
            <td><div className="row-actions history-row-actions">
              {canViewEmployees&&<button className="table-action" onClick={()=>openHistoryDetail(r)}>查看员工档案</button>}
              {historyPermissions.can_edit&&<button className="table-action edit-history-action" onClick={()=>setEditResignModal({event_id:r.id,employee_id:r.employee_id,employee_no:r.employee_no,full_name:r.full_name,resign_date:r.effective_date||'',reason:r.reason||''})}>编辑</button>}
              {historyPermissions.can_restore&&<button className="table-action restore-action" onClick={()=>setRestoreModal({employee_id:r.employee_id,employee_no:r.employee_no,full_name:r.full_name,restore_portal:true})}>恢复在职</button>}
              {historyPermissions.can_delete&&r.employee_id&&<button className="table-action cancel-hire-history-action" title="未正式入职或后台新增员工可直接撤销；不符合条件时系统会安全拒绝" onClick={()=>setCancelHireModal({employee_id:r.employee_id,employee_no:r.employee_no,full_name:r.full_name,confirm_text:''})}>撤销入职</button>}
            </div></td>
          </tr>
        })}</tbody>
      </table>{historyLoading&&<div className="history-loading-overlay" aria-live="polite"><span>读取离职记录...</span></div>}</div>}
      <Pagination page={historyPage} pages={historyPages} total={historyTotal} pageSize={historyPageSize} loading={historyLoading} onPage={p=>{setHistoryPage(p);loadHistory(p,historyPageSize,historyFilters,{announceFailure:true})}} onPageSize={setHistoryPageSize}/>
    </div>}

    {visibleTab==='操作日志'&&<>
      <div className="employee-analysis-subtabs" role="tablist" aria-label="档案变更记录子目录">
        {auditLogViews.map(item=><button type="button" role="tab" aria-selected={auditSubview===item.key} key={item.key} className={auditSubview===item.key?'active':''} onClick={()=>setAuditSubview(item.key)}>{item.label}</button>)}
      </div>
      {auditSubview==='employment'&&<div className="data-card">
      <div className="section-head">
        <div><h2>在职离职操作日志</h2></div>
        <span>{auditTotal} 条</span>
      </div>
      <div className="resignation-filter-panel v25-resignation-filter-panel audit-search-panel">
        <label className="resign-filter-field"><span>员工ID</span><input value={auditDraftFilters.employee_no} onChange={e=>setAuditDraftFilters({...auditDraftFilters,employee_no:e.target.value})} placeholder="输入员工ID"/></label>
        <label className="resign-filter-field"><span>姓名</span><input value={auditDraftFilters.full_name} onChange={e=>setAuditDraftFilters({...auditDraftFilters,full_name:e.target.value})} placeholder="输入姓名"/></label>
        <label className="resign-filter-field"><span>操作类型</span><FilterCombo value={auditDraftFilters.action?auditActionLabel(auditDraftFilters.action):''} options={auditActionOptions.map(x=>x.label)} onChange={label=>setAuditDraftFilters({...auditDraftFilters,action:auditActionValueByLabel(label)})} placeholder="全部操作 / 输入搜索" listId="audit-action-filter"/></label>
        <label className="resign-filter-field"><span>操作账号</span><input value={auditDraftFilters.actor} onChange={e=>setAuditDraftFilters({...auditDraftFilters,actor:e.target.value})} placeholder="后台账号 / Google 邮箱"/></label>
        <label className="resign-filter-field v25-resign-date"><span>操作日期区间</span><div className="pro-date-range"><input type="date" value={auditDraftFilters.date_from} onChange={e=>setAuditDraftFilters({...auditDraftFilters,date_from:e.target.value})}/><b>—</b><input type="date" value={auditDraftFilters.date_to} onChange={e=>setAuditDraftFilters({...auditDraftFilters,date_to:e.target.value})}/></div></label>
        <div className="resign-filter-actions v25-resign-actions"><button className="primary-action resignation-query-action" onClick={()=>{const next={...auditDraftFilters};setAuditFilters(next);setAuditPage(1);loadAudit(1,auditPageSize,next,{announceFailure:true})}} disabled={auditLoading}>{auditLoading?'查询中…':'查询'}</button><button className="secondary-action" onClick={()=>{const next=blankAuditFilters();setAuditDraftFilters(next);setAuditFilters(next);setAuditPage(1);loadAudit(1,auditPageSize,next,{announceFailure:true})}} disabled={auditLoading}>重置</button></div>
      </div>
      {auditLoading&&!auditRows.length?<div className="empty-state">读取操作日志...</div>:!auditRows.length?<div className="empty-state">暂无操作日志</div>:<div className="table-scroll"><table className="data-table">
        <thead><tr><th>时间</th><th>操作账号</th><th>员工ID</th><th>姓名</th><th>操作</th><th>详细变更</th><th>来源</th></tr></thead>
        <tbody>{auditRows.map(r=><tr key={r.id}>
          <td style={{whiteSpace:'nowrap'}}>{formatDateTime(r.created_at)}</td><td><span className="operator-chip">{operatorDisplay(r.actor_username)}</span></td><td><strong>{r.employee_no||'—'}</strong></td><td>{r.full_name||'—'}</td><td>{auditActionLabel(r.action)}</td><td className="reason-cell"><AuditChanges row={r} meta={meta}/></td><td style={{whiteSpace:'nowrap'}}>{auditSourceLabel(r)}</td>
        </tr>)}</tbody>
      </table></div>}
      <Pagination page={auditPage} pages={auditPages} total={auditTotal} pageSize={auditPageSize} loading={auditLoading} onPage={p=>{setAuditPage(p);loadAudit(p,auditPageSize,auditFilters,{announceFailure:true})}} onPageSize={changeAuditPageSize}/>
      </div>}
      {auditSubview==='adjustment'&&<AdminDataEntryLogs category="adjustment"/>}
      {auditSubview==='attendance'&&<AdminDataEntryLogs category="attendance"/>}
    </>}

    {reasonPreview&&<div className="modal-mask employee-action-modal-mask" onMouseDown={()=>setReasonPreview(null)}><div className="modal-card" style={{width:'min(720px,calc(100vw - 40px))',maxWidth:720}} onMouseDown={e=>e.stopPropagation()}>
      <div className="modal-head"><div><span className="modal-kicker">RESIGNATION REASON</span><h2>完整离职原因</h2><p>{reasonPreview.employee_no||'—'} · {reasonPreview.full_name||'—'} · {reasonPreview.resign_date||'—'}</p></div><button onClick={()=>setReasonPreview(null)}>×</button></div>
      <div style={{padding:'0 24px 24px'}}><div style={{whiteSpace:'pre-wrap',wordBreak:'break-word',lineHeight:1.8,fontSize:14,color:'#243b5a',padding:'16px 18px',border:'1px solid #dbe5f1',borderRadius:12,background:'#f8fbff',maxHeight:'55vh',overflow:'auto'}}>{reasonPreview.reason}</div></div>
    </div></div>}

    {analysisDetail&&<AnalysisDetailModal state={analysisDetail} loading={analysisDetailLoading} onClose={()=>setAnalysisDetail(null)} onOpenEmployee={canViewEmployees?row=>openHistoryDetail(row):null}/>}

    {selected&&<EmployeeDrawer
      key={selected.employee.id}
      detail={selected}
      loading={detailLoading}
      error={detailError}
      onRetry={()=>openDetail(selected.employee)}
      onClose={()=>{detailRequestRef.current+=1;setSelected(null);setDetailError('');if(requestedEmployeeId){const next=new URLSearchParams(sp);next.delete('employee');setSp(next,{replace:true});requestedEmployeeRef.current=''}}}
      returnToAnalysis={Boolean(analysisDetail)}
      onReturn={()=>setSelected(null)}
      onEdit={openEdit}
      onResign={()=>setResignModal({employee_id:selected.employee.id,employee_no:selected.employee.employee_no,full_name:selected.employee.full_name,resign_date:'',reason:'',disable_portal:true})}
      onCancelHire={()=>setCancelHireModal({employee_id:selected.employee.id,employee_no:selected.employee.employee_no,full_name:selected.employee.full_name,confirm_text:''})}
    />}
    {employeeModal&&<EmployeeFormModal state={employeeModal} setState={setEmployeeModal} meta={meta} onClose={()=>setEmployeeModal(null)} onSave={saveEmployee} onCheckIdentity={checkEmployeeIdentity}/>}
    {resignModal&&<ResignModal state={resignModal} setState={setResignModal} onClose={()=>setResignModal(null)} onSave={submitResign}/>}
    {editResignModal&&<EditResignationModal state={editResignModal} setState={setEditResignModal} onClose={()=>setEditResignModal(null)} onSave={submitResignEdit}/>}
    {restoreModal&&<RestoreModal state={restoreModal} setState={setRestoreModal} onClose={()=>setRestoreModal(null)} onSave={submitRestore}/>}
    {cancelHireModal&&<CancelHireModal state={cancelHireModal} setState={setCancelHireModal} onClose={()=>setCancelHireModal(null)} onSave={submitCancelHire}/>}
  </div>
}

function EmployeeFormModal({state,setState,meta,onClose,onSave,onCheckIdentity}){
  const f=state.form
  const e=f.employee
  const capabilities=state.capabilities||{basic:false,sensitiveEmployee:false,compensation:false,payment:false}
  const phpHome=isPhpHome(e.employment_type)
  const paymentMode=f.payment.mode||defaultPaymentMode(e.employment_type)
  const [identityCheck,setIdentityCheck]=useState(null)
  const [identityChecking,setIdentityChecking]=useState(false)
  const identitySeq=useRef(0)

  useEffect(()=>{
    const employeeNo=text(e.employee_no).toUpperCase()
    const fullName=text(e.full_name)
    if(!employeeNo&&!fullName){ setIdentityCheck(null); setIdentityChecking(false); return }
    setIdentityCheck(null)
    setIdentityChecking(true)
    const seq=++identitySeq.current
    const timer=setTimeout(async()=>{
      try{
        const result=await onCheckIdentity({
          employee_id:state.employee_id||'',
          previous_employee_no:state.original_employee_no||'',
          employee_no:employeeNo,
          full_name:fullName,
        })
        if(seq===identitySeq.current) setIdentityCheck(result)
      }catch(err){
        if(seq===identitySeq.current) setIdentityCheck({check_error:err?.message||'检查失败'})
      }finally{
        if(seq===identitySeq.current) setIdentityChecking(false)
      }
    },420)
    return()=>clearTimeout(timer)
  },[e.employee_no,e.full_name,state.employee_id,state.original_employee_no])

  const idConflict=identityCheck?.employee_no?.conflict||null
  const nameConflict=identityCheck?.full_name?.conflict||null
  const nameMatches=identityCheck?.full_name?.matches||[]
  const identityReady=Boolean(text(e.employee_no)||text(e.full_name))
  const nameMatchSummary=nameMatches.slice(0,4).map(x=>{
    const status=x.status==='resigned'?'离职':x.status==='historical'||x.source==='lifecycle_history'?'历史记录':'在职'
    const date=x.resign_date||x.effective_date||''
    return `${x.employee_no||'历史记录'} · ${status}${date?` · ${date}`:''}`
  }).join('；')

  const setEmployee=(k,v)=>{
    const next={...e,[k]:v}
    let payment={...f.payment}
    let compensation={...f.compensation}

    // On create, derive a clean payroll/payment template from the employee type.
    // During edit, changing an ordinary profile field must not silently clear or
    // rewrite an existing sensitive section.
    if(k==='employment_type'&&state.mode==='create'){
      payment={...payment,mode:defaultPaymentMode(v)}
      if(isPhpHome(v)){
        compensation={
          ...compensation,
          currency:'PHP',
          base_salary:'',
          daily_rate:'',
          salary_basis:'',
          performance_default:'',
          meal_allowance:'',
        }
      }else{
        compensation={...compensation,currency:'USD',daily_rate:'',salary_basis:''}
      }
    }

    if(k==='country'){
      next.nationality=v
    }

    if(k==='market_position'){
      const ref=platformRefFor(meta.platform_map||[],v)
      if(ref){
        // V29.4.7: 盘口系列与团队彻底分开；团队只由「居家排班表」同步。
        next.market_country=ref.series || ''
      }
    }

    if(k==='position_name'){
      const position=(meta.positions||[]).find(p=>text(p.name).toLowerCase()===text(v).toLowerCase())
      next.position_id=position?.id||''
    }

    setState({...state,form:{...f,employee:next,payment,compensation}})
  }

  const setContact=(k,v)=>setState({...state,form:{...f,contact:{...f.contact,[k]:v}}})
  const setComp=(k,v)=>setState({...state,form:{...f,compensation:{...f.compensation,[k]:v}}})
  const setPhpSalaryBasis=(basis)=>{
    const compensation = basis==='monthly'
      ? {...f.compensation,salary_basis:'monthly',currency:'PHP',base_salary:'25000',daily_rate:'',performance_default:'',meal_allowance:''}
      : basis==='daily'
        ? {...f.compensation,salary_basis:'daily',currency:'PHP',base_salary:'',daily_rate:'970',performance_default:'',meal_allowance:''}
        : {...f.compensation,salary_basis:'',currency:'PHP',base_salary:'',daily_rate:'',performance_default:'',meal_allowance:''}
    setState({...state,form:{...f,compensation}})
  }
  const setPayment=(k,v)=>setState({...state,form:{...f,payment:{...f.payment,[k]:v}}})

  const opts=meta.options||{}
  const selectOptions=(items,current)=>mergeOptions(items,current)
  const platformMap=meta.platform_map||[]
  const platformOptions=platformMap.length ? Array.from(new Set(platformMap.map(x=>x.platform).filter(Boolean))) : (opts.market_positions||[])
  const platformRefs=platformRefsFor(platformMap,e.market_position)
  const platformRef=platformRefs[0]||null
  const existingTeamName=(meta.teams||[]).find(t=>text(t.id)===text(e.team_id))?.name||''
  const derivedSeries=platformRef?.series || e.market_country || ''
  const actualTeamName=existingTeamName || '待排班同步'
  const countries=Array.from(new Set(platformRefs.map(x=>x.country).filter(Boolean)))
  const derivedMarketCountry=countries.length>1?`多国家：${countries.join(' / ')}`:(countries[0]||'')

  return <div className="modal-mask employee-form-mask" onMouseDown={onClose}><div className="modal-card employee-form-modal" onMouseDown={ev=>ev.stopPropagation()}>
    <div className="modal-head employee-form-head"><div><span>{state.mode==='create'?'NEW EMPLOYEE':'EDIT EMPLOYEE'}</span><h2>{state.mode==='create'?'新增员工':'编辑员工资料'}</h2></div><button onClick={onClose}>×</button></div>

    <FormSection title="基本资料">
      <Field label="员工ID">
        <input value={e.employee_no} onChange={x=>setEmployee('employee_no',x.target.value.toUpperCase())} aria-invalid={Boolean(idConflict)}/>
        {identityChecking&&<small style={{display:'block',marginTop:6,color:'#64748b'}}>正在检查员工ID…</small>}
        {!identityChecking&&idConflict&&<small style={{display:'block',marginTop:6,color:'#dc2626',fontWeight:700}}>此员工ID已被使用：{idConflict.employee_no} · {idConflict.full_name||'未命名'} · {idConflict.status==='resigned'||idConflict.source==='lifecycle_history'?'历史/离职记录':'当前员工'}，不能保存。</small>}
        {!identityChecking&&identityCheck&&!identityCheck?.check_error&&!idConflict&&identityReady&&text(e.employee_no)&&<small style={{display:'block',marginTop:6,color:'#15803d'}}>✓ 员工ID可用；编辑现有员工时也可以在这里纠正输错的ID。</small>}
        {!identityChecking&&identityCheck?.check_error&&<small style={{display:'block',marginTop:6,color:'#dc2626',fontWeight:700}}>检查失败：{identityCheck.check_error}。为避免重复员工，暂时不能保存。</small>}
      </Field>
      <Field label="姓名">
        <input value={e.full_name} onChange={x=>setEmployee('full_name',x.target.value)} aria-invalid={Boolean(nameConflict)}/>
        {identityChecking&&text(e.full_name)&&<small style={{display:'block',marginTop:6,color:'#64748b'}}>正在检查姓名是否已被使用…</small>}
        {!identityChecking&&nameConflict&&<small style={{display:'block',marginTop:6,color:'#dc2626',fontWeight:700}}>此姓名已被使用：{nameMatchSummary}{nameMatches.length>4?`；另有 ${nameMatches.length-4} 条`:''}。姓名必须唯一，不能保存。</small>}
        {!identityChecking&&identityCheck&&!identityCheck?.check_error&&text(e.full_name)&&!nameConflict&&<small style={{display:'block',marginTop:6,color:'#15803d'}}>✓ 姓名可用，当前员工及历史记录中均未被其他人使用。</small>}
      </Field>
      <Field label="员工国家"><SelectValue value={e.country} options={selectOptions(opts.countries,e.country)} onChange={v=>setEmployee('country',v)}/></Field>
      <Field label="员工类型"><SelectValue value={typeName(e.employment_type)==='纯居家（越南/缅甸/印尼等）'?'纯居家（越南/缅甸/印尼等）':e.employment_type} options={selectOptions(typeOptions,typeName(e.employment_type))} onChange={v=>setEmployee('employment_type',v)}/></Field>
      <Field label="入职日期"><input type="date" value={e.hire_date} onChange={x=>setEmployee('hire_date',x.target.value)}/></Field>
      <Field label="主档岗位">
        <WriteCombo
          value={e.position_name||''}
          options={meta.position_options?.length?meta.position_options:(meta.positions||[]).map(x=>x.name)}
          onChange={v=>setEmployee('position_name',v)}
          placeholder="选择岗位 / 输入新岗位"
          listId="employee-position-write-options"
        />
      </Field>
    </FormSection>

    <FormSection title="组织与工作" subtitle={!capabilities.sensitiveEmployee?'工作 TG 与后台账号属于敏感资料；当前账号无编辑权限，保存不会修改现有值。':!capabilities.sensitiveEmployeeView?'当前值已隐藏；仅输入的新值会替换原资料，留空会保留原值。':''}>
      <Field label="盘口岗位">
        <WriteCombo
          value={e.market_position||''}
          options={platformOptions}
          onChange={v=>setEmployee('market_position',v)}
          placeholder="选择盘口 / 输入新盘口或组合盘口"
          listId="employee-market-position-options"
        />
      </Field>
      <Field label="盘口系列"><div className="readonly-choice">{derivedSeries||'—'}</div></Field>
      <Field label="当前团队（排班）"><div className="readonly-choice">{actualTeamName}</div></Field>
      <Field label="盘口国家"><div className="readonly-choice">{derivedMarketCountry||'—'}</div></Field>
      <Field label="工作TG"><input value={e.work_tg} disabled={!capabilities.sensitiveEmployee} placeholder={capabilities.sensitiveEmployee?'':'无敏感资料编辑权限'} onChange={x=>setEmployee('work_tg',x.target.value)}/></Field>
      <Field label="后台账号"><input value={e.backend_accounts} disabled={!capabilities.sensitiveEmployee} placeholder={capabilities.sensitiveEmployee?'':'无敏感资料编辑权限'} onChange={x=>setEmployee('backend_accounts',x.target.value)}/></Field>
      <Field label="当前排班"><div className="readonly-choice live-assignment-note">主档岗位同步「居家员工名单」；排班岗位由「居家排班表」最新排班同步，二者独立不互相覆盖</div></Field>
    </FormSection>

    {typeName(e.employment_type)==='现场转居家'&&<FormSection title="现场转居家资料">
      <Field label="最后地点"><input value={e.last_location} onChange={x=>setEmployee('last_location',x.target.value)}/></Field>
      <Field label="回去时间"><input type="date" value={e.return_date} onChange={x=>setEmployee('return_date',x.target.value)}/></Field>
      <Field label="居家时间"><input type="date" value={e.home_date} onChange={x=>setEmployee('home_date',x.target.value)}/></Field>
    </FormSection>}

    <FormSection title="联系方式" subtitle={!capabilities.sensitiveEmployee?'当前账号无敏感联系方式编辑权限；这些字段不会提交，也不会覆盖原资料。':!capabilities.sensitiveEmployeeView?'当前值已隐藏；只填写需要替换的联系方式，留空会保留原值。':''}>
      <Field label="Workfolio 邮箱"><input value={f.contact.work_email} disabled={!capabilities.sensitiveEmployee} placeholder={capabilities.sensitiveEmployee?'':'无编辑权限'} onChange={x=>setContact('work_email',x.target.value)}/></Field>
      <Field label="Telegram"><input value={f.contact.telegram_username} disabled={!capabilities.sensitiveEmployee} placeholder={capabilities.sensitiveEmployee?'':'无编辑权限'} onChange={x=>setContact('telegram_username',x.target.value)}/></Field>
      <Field label="Zoom 邮箱"><input value={f.contact.zoom_email} disabled={!capabilities.sensitiveEmployee} placeholder={capabilities.sensitiveEmployee?'':'无编辑权限'} onChange={x=>setContact('zoom_email',x.target.value)}/></Field>
      <Field label="Facebook"><input value={f.contact.facebook} disabled={!capabilities.sensitiveEmployee} placeholder={capabilities.sensitiveEmployee?'':'无编辑权限'} onChange={x=>setContact('facebook',x.target.value)}/></Field>
      <Field label="WhatsApp / 手机"><input value={f.contact.whatsapp_phone} disabled={!capabilities.sensitiveEmployee} placeholder={capabilities.sensitiveEmployee?'':'无编辑权限'} onChange={x=>setContact('whatsapp_phone',x.target.value)}/></Field>
    </FormSection>

    {e.employment_type&&capabilities.compensationView&&<FormSection title="工资设置" subtitle={!capabilities.compensation?'当前账号无工资编辑权限；保存普通资料不会修改工资设置。':''}>
      {phpHome?<>
        <Field label="PHP 工资方式">
          <select disabled={!capabilities.compensation} value={f.compensation.salary_basis||phpSalaryBasis(f.compensation)} onChange={x=>setPhpSalaryBasis(x.target.value)}>
            <option value="">请选择</option>
            <option value="monthly">月薪制 · 25,000 PHP / 月</option>
            <option value="daily">日薪制 · 970 PHP / 天</option>
          </select>
        </Field>
        {!f.compensation.salary_basis && f.compensation.base_salary && f.compensation.daily_rate &&
          <Field label="旧资料状态" wide><div className="salary-warning">旧资料同时有月薪和日薪，请选择实际工资方式后保存。</div></Field>}
      </>:<>
        <Field label="底薪（USD）"><input disabled={!capabilities.compensation} type="number" step="0.01" value={f.compensation.base_salary} onChange={x=>setComp('base_salary',x.target.value)}/></Field>
        <Field label="默认绩效（USD）"><input disabled={!capabilities.compensation} type="number" step="0.01" value={f.compensation.performance_default} onChange={x=>setComp('performance_default',x.target.value)}/></Field>
        {isOnsiteToHome(e.employment_type)&&<Field label="餐补（USD）"><input disabled={!capabilities.compensation} type="number" step="0.01" value={f.compensation.meal_allowance} onChange={x=>setComp('meal_allowance',x.target.value)}/></Field>}
      </>}
      <Field label="备注" wide><input value={f.compensation.note} disabled={!capabilities.compensation} placeholder={capabilities.compensation?'':'无工资编辑权限'} onChange={x=>setComp('note',x.target.value)}/></Field>
    </FormSection>}

    {e.employment_type&&<FormSection title="收款资料" subtitle={!capabilities.payment?'当前账号无收款资料编辑权限；脱敏值不会进入表单或提交。':!capabilities.paymentView?'当前收款值已隐藏；只填写需要替换的项目，留空会保留原值。':''}>
      <Field label="收款方式"><div className="readonly-choice">{paymentMode==='usdt'?'USDT':'银行卡 / 钱包'}</div></Field>
      {paymentMode==='usdt'?<>
        <Field label="USDT 地址" wide><input value={f.payment.usdt_address} disabled={!capabilities.payment} placeholder={capabilities.payment?'':'无收款资料编辑权限'} onChange={x=>setPayment('usdt_address',x.target.value)}/></Field>
      </>:<>
        <Field label="类型 / 银行"><input value={f.payment.transfer_using} disabled={!capabilities.payment} onChange={x=>setPayment('transfer_using',x.target.value)} placeholder={capabilities.payment?'GCash / Maya / BPI / Bank...':'无收款资料编辑权限'}/></Field>
        <Field label="账号"><input value={f.payment.bank_wallet_account} disabled={!capabilities.payment} placeholder={capabilities.payment?'':'无收款资料编辑权限'} onChange={x=>setPayment('bank_wallet_account',x.target.value)}/></Field>
        <Field label="收款姓名"><input value={f.payment.account_name} disabled={!capabilities.payment} placeholder={capabilities.payment?'':'无收款资料编辑权限'} onChange={x=>setPayment('account_name',x.target.value)}/></Field>
      </>}
      <Field label="联系电话"><input value={f.payment.contact_phone} disabled={!capabilities.payment} placeholder={capabilities.payment?'':'无收款资料编辑权限'} onChange={x=>setPayment('contact_phone',x.target.value)}/></Field>
      <Field label="WhatsApp"><input value={f.payment.whatsapp_number} disabled={!capabilities.payment} placeholder={capabilities.payment?'':'无收款资料编辑权限'} onChange={x=>setPayment('whatsapp_number',x.target.value)}/></Field>
      <Field label="员工地址" wide><textarea value={f.payment.employee_address} disabled={!capabilities.payment} placeholder={capabilities.payment?'':'无收款资料编辑权限'} onChange={x=>setPayment('employee_address',x.target.value)}/></Field>
    </FormSection>}

    <div className="modal-actions employee-form-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" disabled={Boolean(idConflict)||Boolean(nameConflict)||identityChecking||!identityCheck||Boolean(identityCheck?.check_error)} onClick={onSave}>{identityChecking?'正在检查…':state.mode==='create'?'创建员工':'保存修改'}</button></div>
  </div></div>
}

function ActivationCodeModal({data,copyStatus,onCopy,onClose}){
  return <div className="modal-mask activation-code-mask" onMouseDown={onClose}>
    <div className="activation-code-modal" role="dialog" aria-modal="true" aria-labelledby="activation-code-title" onMouseDown={e=>e.stopPropagation()}>
      <div className="activation-code-modal-head">
        <div><span>EMPLOYEE ACCOUNT</span><h2 id="activation-code-title">员工激活码已生成</h2></div>
        <button type="button" aria-label="关闭" onClick={onClose}>×</button>
      </div>
      <div className="activation-code-employee"><strong>{data.employee_no}</strong><span>{data.employee_name||'—'}</span></div>
      <button type="button" className="activation-code-copy-box" onClick={onCopy} title="点击复制激活码">
        <small>72 小时内有效 · 点击复制</small>
        <b>{data.activation_code}</b>
      </button>
      <p className={`activation-copy-feedback ${copyStatus?.includes('失败')?'has-error':''}`}>{copyStatus||'复制后发送给对应员工，用于首次开通账号。'}</p>
      <div className="activation-code-modal-actions"><button type="button" className="secondary-action" onClick={onClose}>关闭</button><button type="button" className="primary-action" onClick={onCopy}>{copyStatus?.startsWith('已复制')?'再次复制':'复制激活码'}</button></div>
    </div>
  </div>
}

const PRIVATE_NOTE_CATEGORIES={
  general:'一般情况',identity:'身份核验',integrity:'诚信风险',
  conduct:'行为记录',payment:'收款资料',other:'其他',
}
const blankPrivateNoteForm=()=>({id:'',version:0,note_text:'',category:'general',incident_date:''})
const privateNoteRequestKey=()=>globalThis.crypto?.randomUUID?.()||'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,char=>{
  const value=Math.floor(Math.random()*16)
  return (char==='x'?value:(value&3)|8).toString(16)
})

function privateNoteError(error){
  const message=text(error?.message||error)
  if(message.includes('private_note_version_conflict'))return '备注已被其他人修改，请刷新后再编辑。'
  if(message.includes('private_note_archived'))return '这条备注已经删除，请刷新列表。'
  if(message.includes('employee_out_of_scope'))return '该员工不在当前账号的管理范围内。'
  if(message.includes('permission_denied'))return '当前账号没有内部备注操作权限。'
  if(message.includes('invalid_private_note_category'))return '备注分类无效，请重新选择。'
  if(message.includes('invalid_private_note'))return '备注需填写 1–2000 个字符。'
  return employeeRequestError(error,'内部备注操作失败，请重试。')
}

function EmployeePrivateNotesPanel({employeeId,canManage,onChanged}){
  const {notify}=useAppToast()
  const [state,setState]=useState({loading:true,error:'',rows:[],total:0})
  const [form,setForm]=useState(null)
  const [saving,setSaving]=useState(false)
  const [message,setMessage]=useState('')
  const requestRef=useRef(0)
  const mountedRef=useRef(true)
  const employeeRef=useRef(employeeId)
  employeeRef.current=employeeId
  const load=async({clear=false,announceFailure=false,operation='读取内部备注'}={})=>{
    if(!mountedRef.current)return false
    const targetEmployeeId=employeeId
    const requestId=++requestRef.current
    setState(current=>clear
      ? {loading:true,error:'',rows:[],total:0}
      : {...current,loading:true,error:''})
    const {data,error}=await supabase.rpc('admin_employee_private_notes',{p_employee_id:targetEmployeeId,p_page:1,p_page_size:100})
    if(!mountedRef.current||requestRef.current!==requestId||employeeRef.current!==targetEmployeeId)return false
    const message=error?privateNoteError(error):''
    setState(error
      ? {loading:false,error:message,rows:[],total:0}
      : {loading:false,error:'',rows:data?.rows||[],total:Number(data?.total||0)})
    if(error&&announceFailure)notify({
      type:'error',module:EMPLOYEE_TOAST_MODULE,operation,reason:message,
      dedupeKey:employeeToastDedupeKey(operation,'error',targetEmployeeId),
      retry:()=>load({announceFailure:true,operation}),retryLabel:'重试',
    })
    return !error
  }
  useEffect(()=>{
    mountedRef.current=true
    return()=>{mountedRef.current=false;requestRef.current+=1}
  },[])
  useEffect(()=>{
    requestRef.current+=1
    setForm(null);setSaving(false);setMessage('')
    setState({loading:Boolean(employeeId),error:'',rows:[],total:0})
    if(employeeId)load({clear:true})
    return()=>{requestRef.current+=1}
  },[employeeId])
  const startCreate=()=>{setMessage('');setForm(blankPrivateNoteForm())}
  const startEdit=note=>{setMessage('');setForm({
    id:note.id,version:Number(note.version||0),note_text:text(note.note_text),
    category:text(note.category)||'general',incident_date:text(note.incident_date).slice(0,10),
  })}
  const save=async event=>{
    event.preventDefault()
    const targetEmployeeId=employeeId
    const note=text(form?.note_text)
    const editing=Boolean(form?.id)
    const operation=editing?'编辑内部备注':'保存内部备注'
    if(!note){
      const message='请填写备注内容。'
      setMessage(message)
      notify({type:'error',module:EMPLOYEE_TOAST_MODULE,operation,reason:message,dedupeKey:employeeToastDedupeKey(operation,'error',targetEmployeeId)})
      return
    }
    setSaving(true);setMessage('')
    const args=form.id
      ? {p_note_id:form.id,p_expected_version:form.version,p_note:note,p_category:form.category,p_incident_date:form.incident_date||null}
      : {p_employee_id:employeeId,p_note:note,p_category:form.category,p_incident_date:form.incident_date||null}
    const rpc=form.id?'admin_employee_private_note_update':'admin_employee_private_note_create'
    const {error}=await supabase.rpc(rpc,args)
    if(!mountedRef.current||employeeRef.current!==targetEmployeeId)return
    setSaving(false)
    if(error){
      const message=privateNoteError(error)
      setMessage(message)
      notify({
        type:'error',module:EMPLOYEE_TOAST_MODULE,operation,reason:message,
        dedupeKey:employeeToastDedupeKey(operation,'error',targetEmployeeId),
        retry:()=>load({announceFailure:true,operation:'刷新内部备注确认'}),retryLabel:'刷新确认',
      })
      return
    }
    const successMessage=editing?'备注已更新。':'备注已保存。'
    setForm(null);setMessage(successMessage)
    notify({type:'success',module:EMPLOYEE_TOAST_MODULE,operation,reason:successMessage,dedupeKey:employeeToastDedupeKey(operation,'success',targetEmployeeId)})
    await load({announceFailure:true,operation:`刷新${operation}结果`})
    onChanged?.()
  }
  const remove=async note=>{
    if(!window.confirm('确定删除这条内部备注？删除后不再显示，操作记录和修改历史仍会保留。'))return
    const targetEmployeeId=employeeId
    setSaving(true);setMessage('')
    const {error}=await supabase.rpc('admin_employee_private_note_archive',{p_note_id:note.id,p_expected_version:Number(note.version||0)})
    if(!mountedRef.current||employeeRef.current!==targetEmployeeId)return
    setSaving(false)
    if(error){
      const message=privateNoteError(error)
      setMessage(message)
      notify({
        type:'error',module:EMPLOYEE_TOAST_MODULE,operation:'删除内部备注',reason:message,
        dedupeKey:employeeToastDedupeKey('删除内部备注','error',targetEmployeeId),
        retry:()=>load({announceFailure:true,operation:'刷新内部备注确认'}),retryLabel:'刷新确认',
      })
      return
    }
    if(form?.id===note.id)setForm(null)
    const successMessage='备注已删除，操作记录和修改历史仍保留。'
    setMessage(successMessage)
    notify({type:'success',module:EMPLOYEE_TOAST_MODULE,operation:'删除内部备注',reason:successMessage,dedupeKey:employeeToastDedupeKey('删除内部备注','success',targetEmployeeId)})
    await load({announceFailure:true,operation:'刷新删除内部备注结果'})
    onChanged?.()
  }
  return <section className="detail-panel employee-private-notes-panel">
    <div className="detail-panel-head"><div><h3>内部备注</h3><p>仅授权后台账号可见；员工前端不会收到或显示这些内容。</p></div><div className="employee-private-note-head-actions"><span>{state.total} 条</span>{canManage&&!form&&<button type="button" onClick={startCreate}>+ 新增备注</button>}</div></div>
    {message&&<div className={`employee-private-note-message ${/失败|无效|没有|冲突|填写|范围/.test(message)?'is-error':''}`}>{message}</div>}
    {canManage&&form&&<form className="employee-private-note-form" onSubmit={save}>
      <div className="employee-private-note-form-grid"><label>分类<select value={form.category} onChange={event=>setForm({...form,category:event.target.value})}>{Object.entries(PRIVATE_NOTE_CATEGORIES).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>事件日期（可选）<input type="date" value={form.incident_date} onChange={event=>setForm({...form,incident_date:event.target.value})}/></label></div>
      <label>备注内容<textarea autoFocus rows="5" maxLength="2000" value={form.note_text} onChange={event=>setForm({...form,note_text:event.target.value})} placeholder="记录需要后续授权人员留意的事实、核验结果或历史情况。"/></label>
      <footer><span>{text(form.note_text).length} / 2000</span><div><button type="button" disabled={saving} onClick={()=>setForm(null)}>取消</button><button className="primary-action" type="submit" disabled={saving}>{saving?'保存中…':form.id?'保存修改':'保存备注'}</button></div></footer>
    </form>}
    {state.loading?<div className="employee-section-placeholder"><p>正在读取内部备注…</p></div>:state.error?<div className="employee-section-placeholder"><p>{state.error}</p><button type="button" onClick={()=>load({announceFailure:true})}>重新读取</button></div>:state.rows.length?<div className="employee-private-note-list">{state.rows.map(note=><article key={note.id}>
      <header><div><b>{PRIVATE_NOTE_CATEGORIES[note.category]||'其他'}</b>{note.incident_date&&<time>事件日期 · {text(note.incident_date).slice(0,10)}</time>}</div>{canManage&&<div><button type="button" disabled={saving} onClick={()=>startEdit(note)}>编辑</button><button type="button" className="danger-outline" disabled={saving} onClick={()=>remove(note)}>删除</button></div>}</header>
      <p>{note.note_text}</p>
      <footer><span>创建：{note.created_by_username||'后台账号'} · {formatDateTime(note.created_at)}</span><span>更新：{note.updated_by_username||'后台账号'} · {formatDateTime(note.updated_at)} · v{note.version}</span></footer>
    </article>)}</div>:<div className="employee-section-placeholder"><p>暂无内部备注。</p>{canManage&&<button type="button" onClick={startCreate}>新增第一条备注</button>}</div>}
  </section>
}

function EmployeePrivateNoteHistory({employeeId,refreshToken=0}){
  const [state,setState]=useState({loading:true,error:'',rows:[],total:0,page:1,pages:1})
  const [page,setPage]=useState(1)
  const [retryToken,setRetryToken]=useState(0)
  useEffect(()=>{
    let alive=true
    setState(current=>({...current,loading:true,error:''}))
    supabase.rpc('admin_employee_private_note_history',{p_employee_id:employeeId,p_page:page,p_page_size:50}).then(({data,error})=>{
      if(!alive)return
      if(error)setState({loading:false,error:privateNoteError(error),rows:[],total:0,page:1,pages:1})
      else setState({loading:false,error:'',rows:data?.rows||[],total:Number(data?.total||0),page:Number(data?.page||1),pages:Number(data?.pages||1)})
    })
    return()=>{alive=false}
  },[employeeId,page,refreshToken,retryToken])
  const actionLabel={create:'新增',update:'修改',archive:'删除'}
  return <section className="employee-private-note-history">
    <div className="employee-private-note-history-head"><div><h4>完整修改历史</h4><p>每次新增、修改及删除都会独立保留。</p></div><span>{state.total} 条</span></div>
    {state.loading?<div className="employee-section-placeholder"><p>正在读取修改历史…</p></div>:state.error?<div className="employee-section-placeholder"><p>{state.error}</p><button type="button" onClick={()=>setRetryToken(value=>value+1)}>重新读取</button></div>:state.rows.length?<div className="employee-private-note-history-list">{state.rows.map(row=><article key={row.id}>
      <header><div><b>{actionLabel[row.action]||row.action}</b><span>{PRIVATE_NOTE_CATEGORIES[row.category]||'其他'} · v{row.version}</span>{row.archived&&<em>已删除</em>}</div><time>{row.changed_by_username||'后台账号'} · {formatDateTime(row.changed_at)}</time></header>
      <p>{row.note_text}</p>
      {row.incident_date&&<footer>事件日期 · {text(row.incident_date).slice(0,10)}</footer>}
    </article>)}</div>:<div className="employee-section-placeholder"><p>暂无修改历史。</p></div>}
    {state.pages>1&&<Pagination page={state.page} pages={state.pages} total={state.total} pageSize={50} loading={state.loading} onPage={setPage}/>}
  </section>
}

function EmployeePrivateNotesDialog({employeeId,canManage,onClose,onChanged}){
  const [showHistory,setShowHistory]=useState(false)
  const [historyRevision,setHistoryRevision]=useState(0)
  const handleNotesChanged=()=>{
    setHistoryRevision(value=>value+1)
    onChanged?.()
  }
  return <div className="modal-mask employee-action-modal-mask employee-private-note-dialog-mask" onMouseDown={onClose}><div className="modal-card employee-private-note-dialog" onMouseDown={event=>event.stopPropagation()}>
    <div className="modal-head"><div><span className="modal-kicker">INTERNAL NOTES</span><h2>管理内部备注</h2></div><button type="button" onClick={onClose}>×</button></div>
    <div className="employee-private-note-dialog-body">
      <EmployeePrivateNotesPanel employeeId={employeeId} canManage={canManage} onChanged={handleNotesChanged}/>
      <button type="button" className="employee-private-note-history-toggle" onClick={()=>setShowHistory(value=>!value)}>{showHistory?'收起完整修改历史':'查看完整修改历史'}</button>
      {showHistory&&<EmployeePrivateNoteHistory employeeId={employeeId} refreshToken={historyRevision}/>}
    </div>
  </div></div>
}

function EmployeePrivateNoteSummary({employeeId,canManage}){
  const [state,setState]=useState({loading:true,error:'',latest:null,total:0})
  const [open,setOpen]=useState(false)
  const [revision,setRevision]=useState(0)
  useEffect(()=>{
    let alive=true
    setState(current=>({...current,loading:true,error:''}))
    supabase.rpc('admin_employee_private_notes',{p_employee_id:employeeId,p_page:1,p_page_size:1}).then(({data,error})=>{
      if(!alive)return
      if(error)setState({loading:false,error:privateNoteError(error),latest:null,total:0})
      else setState({loading:false,error:'',latest:data?.rows?.[0]||null,total:Number(data?.total||0)})
    })
    return()=>{alive=false}
  },[employeeId,revision])
  const latest=state.latest
  return <>
    <div className={`employee-private-note-summary ${state.error?'is-error':''}`}>
      <div className="employee-private-note-summary-copy">
        <div><strong>内部备注</strong><span>{state.loading?'读取中…':`${state.total} 条`}</span></div>
        {state.loading?<p>正在读取最新备注…</p>:state.error?<p>{state.error}</p>:latest?<><p>{latest.note_text}</p><small>最后操作：{latest.updated_by_username||'后台账号'} · {formatDateTime(latest.updated_at)} · v{latest.version}</small></>:<p>暂无内部备注。</p>}
      </div>
      <button type="button" onClick={()=>setOpen(true)}>{canManage?'管理备注':'查看备注'}</button>
    </div>
    {open&&<EmployeePrivateNotesDialog employeeId={employeeId} canManage={canManage} onClose={()=>setOpen(false)} onChanged={()=>setRevision(value=>value+1)}/>}
  </>
}

function BatchEmployeePrivateNoteModal({state,onClose,onAllSucceeded}){
  const {notify}=useAppToast()
  const [form,setForm]=useState(blankPrivateNoteForm())
  const [saving,setSaving]=useState(false)
  const [attempted,setAttempted]=useState(false)
  const [message,setMessage]=useState('')
  const [result,setResult]=useState(null)
  const employees=state.employees||[]
  const employeeById=Object.fromEntries(employees.map(employee=>[employee.id,employee]))
  const failureLabel=reason=>({
    employee_out_of_scope:'不在当前账号管理范围',
    request_key_payload_conflict:'本次防重编号与已保存内容不一致',
    save_failed:'保存失败',
  }[reason]||'保存失败')
  const save=async event=>{
    event?.preventDefault?.()
    const note=text(form.note_text)
    if(!note){setMessage('请填写备注内容。');return}
    setSaving(true);setAttempted(true);setMessage('')
    const {data,error}=await supabase.rpc('admin_employee_private_note_batch_create',{
      p_employee_ids:employees.map(employee=>employee.id),
      p_request_key:state.requestKey,
      p_note:note,
      p_category:form.category,
      p_incident_date:form.incident_date||null,
    })
    setSaving(false)
    if(error){
      const reason=privateNoteError(error)
      setMessage(`${reason} 可使用相同防重编号重试，不会重复新增已成功的备注。`)
      notify({type:'error',module:EMPLOYEE_TOAST_MODULE,operation:'批量新增内部备注',reason,dedupeKey:employeeToastDedupeKey('批量新增内部备注','error',state.requestKey)})
      return
    }
    const next=data||{}
    setResult(next)
    const created=Number(next.created||0),replayed=Number(next.idempotent_replays||0),failed=Number(next.failed||0)
    const reason=failed?`已保存 ${created} 人，防重跳过 ${replayed} 人，失败 ${failed} 人。`:`已为 ${created+replayed} 名员工完成备注；没有覆盖既有备注。`
    setMessage(reason)
    notify({type:failed?'error':'success',module:EMPLOYEE_TOAST_MODULE,operation:'批量新增内部备注',reason,dedupeKey:employeeToastDedupeKey('批量新增内部备注',failed?'error':'success',state.requestKey)})
    if(!failed)onAllSucceeded?.()
  }
  return <div className="modal-mask employee-action-modal-mask employee-batch-note-mask" onMouseDown={onClose}><div className="modal-card employee-batch-note-modal" onMouseDown={event=>event.stopPropagation()}>
    <div className="modal-head"><div><span className="modal-kicker">BATCH INTERNAL NOTE</span><h2>批量新增内部备注</h2><p>为 {employees.length} 名员工分别新增同一备注；不会替换或覆盖任何旧备注。</p></div><button type="button" onClick={onClose}>×</button></div>
    <form className="employee-private-note-form" onSubmit={save}>
      <div className="employee-batch-note-people">{employees.slice(0,8).map(employee=><span key={employee.id}>{employee.employee_no} · {employee.full_name}</span>)}{employees.length>8&&<span>另 {employees.length-8} 人</span>}</div>
      <div className="employee-private-note-form-grid"><label>分类<select disabled={attempted} value={form.category} onChange={event=>setForm({...form,category:event.target.value})}>{Object.entries(PRIVATE_NOTE_CATEGORIES).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>事件日期（可选）<input disabled={attempted} type="date" value={form.incident_date} onChange={event=>setForm({...form,incident_date:event.target.value})}/></label></div>
      <label>备注内容<textarea autoFocus disabled={attempted} rows="4" maxLength="2000" value={form.note_text} onChange={event=>setForm({...form,note_text:event.target.value})} placeholder="相同内容会分别保存到每名员工，不影响他们已有的备注。"/></label>
      {message&&<div className={`employee-private-note-message ${result&&!Number(result.failed||0)?'':'is-error'}`}>{message}</div>}
      {result?.failures?.length>0&&<div className="employee-batch-note-failures"><strong>失败清单</strong>{result.failures.map((failure,index)=>{const employee=employeeById[failure.employee_id]||{};return <span key={`${failure.employee_id}-${index}`}>{employee.employee_no||failure.employee_id} · {employee.full_name||'未命名'}：{failureLabel(failure.reason)}</span>})}</div>}
      <footer><span>{text(form.note_text).length} / 2000 · 防重编号已自动建立</span><div><button type="button" disabled={saving} onClick={onClose}>{result&&!Number(result.failed||0)?'完成':'取消'}</button>{(!result||Number(result.failed||0)>0)&&<button className="primary-action" type="submit" disabled={saving}>{saving?'保存中…':attempted?'安全重试':'确认批量新增'}</button>}</div></footer>
    </form>
  </div></div>
}

export function EmployeeDrawer({detail,loading,error,onRetry,onClose,onEdit,onResign,onCancelHire,returnToAnalysis,onReturn,readOnly=false}){
  const adminAccess=useAdminAccess()
  const canViewPrivateNotes=adminAccess.hasAnyPermission([PERMISSIONS.EMPLOYEE_PRIVATE_NOTE_VIEW,PERMISSIONS.EMPLOYEE_PRIVATE_NOTE_MANAGE])
  const canManagePrivateNotes=adminAccess.hasPermission(PERMISSIONS.EMPLOYEE_PRIVATE_NOTE_MANAGE)
  const canViewAdjustmentBonus=adminAccess.hasPermission(PERMISSIONS.ADJUSTMENT_BONUS_VIEW)
  const canViewAdjustmentDeduction=adminAccess.hasPermission(PERMISSIONS.ADJUSTMENT_DEDUCTION_VIEW)
  const canViewAdjustments=adminAccess.hasPermission(PERMISSIONS.ADJUSTMENT_PAGE_VIEW)&&(canViewAdjustmentBonus||canViewAdjustmentDeduction)
  const canViewPayrollRecords=adminAccess.hasPermission(PERMISSIONS.EMPLOYEE_DIRECTORY_PAYROLL_RECORDS_VIEW)
  const canViewCompensation=detail.permissions?.compensation_view===true
  const e=detail.employee||{}, c=detail.contact||{}, p=detail.payment||{}, comp=detail.compensation||{}
  const [profileSummary,setProfileSummary]=useState(null)
  const [profileSummaryLoading,setProfileSummaryLoading]=useState(false)
  const [examData,setExamData]=useState(null)
  const [examLoading,setExamLoading]=useState(false)
  const [examError,setExamError]=useState('')
  const [activeSection,setActiveSection]=useState('info')
  const [employeeErrors,setEmployeeErrors]=useState({rows:[],total:0,page:1,pages:1})
  const [employeeErrorsLoading,setEmployeeErrorsLoading]=useState(false)
  const [employeeErrorsError,setEmployeeErrorsError]=useState('')
  const [connectivityData,setConnectivityData]=useState(null)
  const [connectivityLoading,setConnectivityLoading]=useState(false)
  const [connectivityError,setConnectivityError]=useState('')
  const [payrollData,setPayrollData]=useState(null)
  const [payrollLoading,setPayrollLoading]=useState(false)
  const [payrollError,setPayrollError]=useState('')
  const [trainerReviewData,setTrainerReviewData]=useState({rows:[],total:0,page:1,page_size:20,pages:1})
  const [trainerReviewLoading,setTrainerReviewLoading]=useState(false)
  const [trainerReviewError,setTrainerReviewError]=useState('')
  const [trainerReviewFilters,setTrainerReviewFilters]=useState({query:'',dateFrom:'',dateTo:''})
  const [trainerReviewPage,setTrainerReviewPage]=useState(1)
  const [trainerReviewPageSize,setTrainerReviewPageSize]=useState(20)
  const missing=detail.missing_fields||[]
  const full=Boolean(detail.permissions?.sensitive_payment_view)
  const paymentMode=p.mode||defaultPaymentMode(e.employment_type)
  const paymentTitle=paymentMode==='usdt'?'USDT 收款资料':'银行卡 / 钱包收款资料'
  const seededProfileSummary=employeeProfileMetricSeed(e)
  const visibleProfileSummary=profileSummary?.employee_id===e.id?profileSummary:seededProfileSummary
  const drawerTabs=useMemo(()=>[
    ['info','员工信息',true],
    ['alerts','预警记录',adminAccess.hasAnyPermission(ADMIN_ALERT_PERMISSIONS)],
    ['errors','员工出错记录',adminAccess.hasPermission(PERMISSIONS.REPORT_ERRORS_VIEW)],
    ['exams','员工考试记录',adminAccess.hasPermission(PERMISSIONS.EMPLOYEE_DIRECTORY_VIEW)],
    ['connectivity','停电 / 断网记录',adminAccess.hasPermission('connectivity.view')],
    ['payroll','工资记录',canViewPayrollRecords],
    ['attendance','员工出勤记录',adminAccess.hasPermission(PERMISSIONS.ATTENDANCE_RECORDS_VIEW)],
    ['penalties','奖金 / 扣款',canViewAdjustments],
    ['trainer_reviews','老师评价',adminAccess.hasPermission(PERMISSIONS.ONLINE_TRAINING_REPORT_VIEW)],
  ].filter(([, ,allowed])=>allowed),[adminAccess.founder,adminAccess.permissionKey])
  useEffect(()=>{
    setActiveSection('info')
    setTrainerReviewFilters({query:'',dateFrom:'',dateTo:''})
    setTrainerReviewPage(1)
    setTrainerReviewData({rows:[],total:0,page:1,page_size:20,pages:1})
    setTrainerReviewError('')
  },[e.id])
  useEffect(()=>{
    if(!drawerTabs.some(([key])=>key===activeSection))setActiveSection('info')
  },[activeSection,drawerTabs])
  useEffect(()=>{
    if(!e.id)return
    let alive=true
    setProfileSummaryLoading(true)
    supabase.rpc('admin_employee_profile_summary',{p_employee_id:e.id}).then(({data,error})=>{
      if(!alive)return
      if(error)return
      const seed=employeeProfileMetricSeed(e)
      setProfileSummary({
        employee_id:e.id,
        ...(data||{}),
        // The list has already calculated the current error totals. Keep those
        // authoritative values while the lighter profile RPC fills exam KPIs.
        month_records:seed.month_records??Number(data?.month_records||0),
        total_errors:seed.total_errors??Number(data?.total_errors||0),
      })
    }).finally(()=>alive&&setProfileSummaryLoading(false))
    return()=>{alive=false}
  },[e.id,e.month_error_count,e.total_error_count])
  useEffect(()=>{
    if(!e.id||activeSection!=='exams'){return}
    let alive=true
    setExamLoading(true);setExamError('')
    supabase.rpc('admin_employee_exam_history',{p_employee_id:e.id}).then(({data,error})=>{
      if(!alive)return
      if(error)setExamError(error.message);else setExamData(data)
    }).finally(()=>alive&&setExamLoading(false))
    return()=>{alive=false}
  },[e.id,activeSection])
  useEffect(()=>{
    if(!e.id||activeSection!=='connectivity')return
    let alive=true
    setConnectivityLoading(true);setConnectivityError('')
    supabase.rpc('admin_employee_connectivity_history',{p_employee_id:e.id}).then(({data,error})=>{
      if(!alive)return
      if(error)setConnectivityError(error.message);else setConnectivityData(data||null)
    }).finally(()=>alive&&setConnectivityLoading(false))
    return()=>{alive=false}
  },[e.id,activeSection])
  useEffect(()=>{
    if(!canViewPayrollRecords){
      setPayrollData(null);setPayrollError('');setPayrollLoading(false)
      return
    }
    if(!e.id||activeSection!=='payroll')return
    let alive=true
    setPayrollLoading(true);setPayrollError('')
    supabase.rpc('admin_employee_payroll_history',{p_employee_id:e.id}).then(({data,error})=>{
      if(!alive)return
      if(error)setPayrollError(error.message);else setPayrollData(data||null)
    }).finally(()=>alive&&setPayrollLoading(false))
    return()=>{alive=false}
  },[e.id,activeSection,canViewPayrollRecords])
  useEffect(()=>{
    if(!e.id||activeSection!=='errors')return
    let alive=true
    setEmployeeErrorsLoading(true);setEmployeeErrorsError('')
    supabase.rpc('admin_employee_error_history',{p_employee_id:e.id,p_page:1,p_page_size:100}).then(({data,error})=>{
      if(!alive)return
      if(error)setEmployeeErrorsError(error.message);else setEmployeeErrors(data||{rows:[],total:0,page:1,pages:1})
    }).finally(()=>alive&&setEmployeeErrorsLoading(false))
    return()=>{alive=false}
  },[e.id,activeSection])
  useEffect(()=>{
    if(!e.id||activeSection!=='trainer_reviews')return
    let alive=true
    setTrainerReviewLoading(true);setTrainerReviewError('')
    const load=async()=>{
      try{
        const args={
          p_query:trainerReviewFilters.query,
          p_date_from:trainerReviewFilters.dateFrom||null,
          p_date_to:trainerReviewFilters.dateTo||null,
          p_employee_id:e.id,
          p_page:trainerReviewPage,
          p_page_size:trainerReviewPageSize,
        }
        const result=await supabase.rpc('online_training_list',args)
        if(result.error)throw result.error
        const payload=result.data||{}
        const rows=payload.rows||[]
        if(alive)setTrainerReviewData({
          rows,
          total:Number(payload.total??rows.length),
          page:Number(payload.page||trainerReviewPage),
          page_size:Number(payload.page_size||trainerReviewPageSize),
          pages:Math.max(1,Number(payload.pages||1)),
        })
      }catch(error){
        if(alive)setTrainerReviewError(employeeRequestError(error,'老师评价读取失败，请重试。'))
      }finally{
        if(alive)setTrainerReviewLoading(false)
      }
    }
    load()
    return()=>{alive=false}
  },[e.id,activeSection,trainerReviewFilters.query,trainerReviewFilters.dateFrom,trainerReviewFilters.dateTo,trainerReviewPage,trainerReviewPageSize])

  return <div className="modal-mask detail-mask" onMouseDown={onClose}><div className="employee-detail-drawer employee-detail-v12" onMouseDown={ev=>ev.stopPropagation()}>
    <div className="employee-hero">
      <div className="employee-avatar">{text(e.full_name).slice(0,1).toUpperCase()||'E'}</div>
      <div className="employee-hero-copy"><div className="employee-id-line">{e.employee_no}</div><h2>{e.full_name||'读取中...'}</h2><div className="employee-tags"><span>{typeName(e.employment_type)}</span><span>{e.teams?.name||'未匹配团队'}</span><span>{e.positions?.name||'未设置主档岗位'}</span>{e.schedule_position&&e.schedule_position!==e.positions?.name&&<span>排班：{e.schedule_position}</span>}{e.hire_date&&<span className="employee-tenure-chip">{tenureDurationLabel(e.hire_date,e.resign_date,e.status)}</span>}</div></div>
      <div className="drawer-head-actions">
        {returnToAnalysis&&<button className="back-outline" onClick={onReturn}>← 返回人员明细</button>}
        {!readOnly&&e.status!=='resigned'&&detail.actions?.can_resign&&<button className="danger-outline" onClick={onResign}>办理离职</button>}
        {!readOnly&&e.status==='resigned'&&detail.actions?.can_reactivate&&<button className="restore-outline" onClick={()=>window.dispatchEvent(new CustomEvent('wfh-restore-employee',{detail:{employee_id:e.id,employee_no:e.employee_no,full_name:e.full_name}}))}>恢复在职</button>}
        {!readOnly&&detail.actions?.can_delete&&<button className="cancel-hire-outline" title="不符合撤销条件时系统会安全拒绝，不会删除员工资料" onClick={onCancelHire}>撤销入职</button>}
        {!readOnly&&detail.actions?.can_edit&&<button className="edit-outline" onClick={onEdit}>编辑</button>}
        <button className="drawer-close" onClick={onClose}>×</button>
      </div>
    </div>
    {e.id&&<EmployeeProfileMetrics data={visibleProfileSummary} loading={profileSummaryLoading}/>}
    {(loading||error)&&<div className={`employee-inline-sync-note ${error?'is-error':''}`} role={error?'alert':'status'}><span>{error||'已先显示员工基础资料，正在补充联系方式、工资与收款资料…'}</span>{error&&<button type="button" onClick={onRetry}>重新读取</button>}</div>}
    {!loading&&!error&&<div className={`profile-status-line ${missing.length?'has-missing':'is-complete'}`}><div><strong>{missing.length?`资料待完善 ${missing.length} 项`:'当前必填资料完整'}</strong><span>{missing.length?missing.join(' · '):'已通过当前员工类型的资料检查规则'}</span></div></div>}
      <nav className="employee-drawer-tabs">
        {drawerTabs.map(([key,label])=><button key={key} className={activeSection===key?'active':''} onClick={()=>setActiveSection(key)}>{label}</button>)}
      </nav>
      <div className="detail-sections detail-sections-v11">
        {activeSection==='alerts'&&<EmployeeAlertHistoryPanel employeeId={e.id}/>}
        {activeSection==='exams'&&<EmployeeExamPanel data={examData} loading={examLoading} error={examError}/>}
        {activeSection==='errors'&&<EmployeeErrorPanel data={employeeErrors} loading={employeeErrorsLoading} error={employeeErrorsError}/>}
        {activeSection==='connectivity'&&<EmployeeConnectivityPanel data={connectivityData} loading={connectivityLoading} error={connectivityError}/>}
        {activeSection==='payroll'&&canViewPayrollRecords&&<EmployeePayrollHistoryPanel data={payrollData} loading={payrollLoading} error={payrollError}/>}
        {activeSection==='attendance'&&<EmployeeAttendancePanel employeeId={e.id}/>}
        {activeSection==='penalties'&&canViewAdjustments&&<EmployeeAdjustmentPanel employeeId={e.id} canViewBonus={canViewAdjustmentBonus} canViewDeduction={canViewAdjustmentDeduction}/>}
        {activeSection==='trainer_reviews'&&<EmployeeTrainerReviewPanel data={trainerReviewData} employeeId={e.id} loading={trainerReviewLoading} error={trainerReviewError} filters={trainerReviewFilters} page={trainerReviewPage} pageSize={trainerReviewPageSize} onFilters={next=>{setTrainerReviewFilters(next);setTrainerReviewPage(1)}} onPage={setTrainerReviewPage} onPageSize={next=>{setTrainerReviewPageSize(next);setTrainerReviewPage(1)}}/>}
        {activeSection==='info'&&<>
        <InfoPanel title="基本资料" rows={[['员工ID',e.employee_no],['姓名',e.full_name],['员工国家',e.country||e.nationality],['员工类型',typeName(e.employment_type)],['状态',statusName(e.status)],['入职日期',text(e.hire_date).slice(0,10)],['入职时长',tenureDurationLabel(e.hire_date,e.resign_date,e.status)],['录入时间',formatDateTime(e.created_at)],['离职日期',text(e.resign_date).slice(0,10)],...(e.status==='resigned'?[['离职原因',text(detail.resignation_reason)||'—']]:[])]}>
          {canViewPrivateNotes&&<EmployeePrivateNoteSummary employeeId={e.id} canManage={canManagePrivateNotes}/>}
        </InfoPanel>
        <InfoPanel title="组织与排班" rows={[['团队',e.teams?.name],['主档岗位',e.positions?.name],['排班岗位',e.schedule_position],['班次',e.shift_name],['负责人',e.person_in_charge||e.leader_name],['现场培训',e.on_site_trainer],['线上组长',e.online_leader||e.leader_name],['线上培训',e.online_trainer||e.trainer_name],['盘口',e.platform_scope],['工作内容',e.work_content]]}/>
        <InfoPanel title="联系方式" rows={[['工作TG',e.work_tg],['后台账号',e.backend_accounts],['Telegram',c.telegram_username],['Workfolio邮箱',c.work_email],['Zoom邮箱',c.zoom_email],['Facebook',c.facebook],['WhatsApp',c.whatsapp_phone]]}/>
        {canViewCompensation&&<InfoPanel title="工资设置" rows={isPhpHome(e.employment_type)
          ? (comp.base_salary!==null && comp.base_salary!==undefined && comp.base_salary!==''
              ? [['工资方式','月薪制'],['月薪',money(comp.base_salary,'PHP')],['备注',comp.note]]
              : comp.daily_rate!==null && comp.daily_rate!==undefined && comp.daily_rate!==''
                ? [['工资方式','日薪制'],['日薪',money(comp.daily_rate,'PHP')],['备注',comp.note]]
                : [['工资方式','待确认'],['备注',comp.note]])
          : isOnsiteToHome(e.employment_type)
            ? [['底薪',money(comp.base_salary,'USD')],['默认绩效',money(comp.performance_default,'USD')],['餐补',money(comp.meal_allowance,'USD')],['备注',comp.note]]
            : [['底薪',money(comp.base_salary,'USD')],['默认绩效',money(comp.performance_default,'USD')],['备注',comp.note]]
        }/>}
        <section className="detail-panel payment-panel-v11">
          <div className="detail-panel-head"><div><h3>{paymentTitle}</h3><p>{full?'你有敏感资料查看权限，显示完整值。':'完整号码不下发到浏览器，仅显示首尾，中间 **** 隐藏。'}</p></div><span className={full?'access-full':'access-masked'}>{full?'完整可见':'部分隐藏'}</span></div>
          {paymentMode==='usdt'?<div className="payment-primary"><span>USDT 地址</span><strong>{text(p.usdt_address)||'—'}</strong><small>收款方式：{p.transfer_using||'USDT'}</small></div>:paymentMode==='bank_wallet'?<div className="info-rows"><InfoRow label="收款方式" value={p.transfer_using}/><InfoRow label="银行卡 / 钱包账号" value={p.bank_wallet_account} mono/><InfoRow label="收款姓名" value={p.account_name}/></div>:null}
          <div className="payment-secondary"><InfoRow label="联系电话" value={p.contact_phone}/><InfoRow label="WhatsApp" value={p.whatsapp_number}/><InfoRow label="员工地址" value={p.employee_address}/></div>
        </section>
        </>}
      </div>
  </div></div>
}

const TRAINING_ATTENDANCE_LABELS={normal:'正常上班',rest:'公休',not_started:'未入',leave:'请假',absent:'缺席',transferred:'回家'}

function EmployeeTrainerReviewPanel({data,employeeId,loading,error,filters,page,pageSize,onFilters,onPage,onPageSize}){
  const rows=employeeTrainerReviewRows(data?.rows||[],employeeId)
  const [draft,setDraft]=useState(filters)
  useEffect(()=>setDraft(filters),[employeeId,filters.query,filters.dateFrom,filters.dateTo])
  const update=(key,value)=>setDraft(current=>({...current,[key]:value}))
  const submit=event=>{
    event.preventDefault()
    onFilters({...draft,query:text(draft.query)})
  }
  const reset=()=>{
    const next={query:'',dateFrom:'',dateTo:''}
    setDraft(next)
    onFilters(next)
  }
  const total=Number(data?.total??rows.length)
  const resolvedPage=Number(data?.page||page)
  const resolvedPageSize=Number(data?.page_size||pageSize)
  return <section className="detail-panel employee-trainer-review-panel">
    <div className="detail-panel-head"><div><h3>老师评价</h3><p>按线上培训日报日期查看老师对该员工的工作与培训评价。</p></div><span className="employee-exam-count">{total} 条</span></div>
    <form className="employee-history-filters employee-trainer-review-filters" onSubmit={submit}>
      <label><span>日期起</span><input type="date" value={draft.dateFrom} max={draft.dateTo||undefined} onChange={event=>update('dateFrom',event.target.value)}/></label>
      <label><span>日期止</span><input type="date" value={draft.dateTo} min={draft.dateFrom||undefined} onChange={event=>update('dateTo',event.target.value)}/></label>
      <label className="employee-history-search"><span>搜索</span><input value={draft.query} onChange={event=>update('query',event.target.value)} placeholder="搜索老师、日报标题、工作、表现或问题"/></label>
      <div className="employee-trainer-review-filter-actions"><button type="submit" disabled={loading}>查询</button><button type="button" disabled={loading||(!filters.query&&!filters.dateFrom&&!filters.dateTo&&!draft.query&&!draft.dateFrom&&!draft.dateTo)} onClick={reset}>重置</button></div>
    </form>
    {loading?<div className="employee-exam-empty">正在读取老师评价...</div>:error?<div className="employee-exam-empty error">{error}</div>:rows.length?<div className="employee-trainer-review-list">{rows.map(row=>{
      const details=[
        ['当天工作 / 培训评语',row.workDetails],
        ['工作表现',row.performance],
        ['发现问题',row.issues],
        ['后续安排',row.followUp],
        ['状态说明',row.statusNote],
        ['岗位数据 / 首次响应',row.responseTime],
      ].filter(([,value])=>text(value))
      return <article key={row.key}>
        <header><div><strong>{text(row.reportDate).slice(0,10)||'—'}</strong><span>培训老师：{row.trainerName||'未填写'}</span></div><em className={row.attendanceStatus}>{TRAINING_ATTENDANCE_LABELS[row.attendanceStatus]||row.attendanceStatus}</em></header>
        {details.length?<div className="employee-trainer-review-grid">{details.map(([label,value])=><div key={label}><b>{label}</b><p>{value}</p></div>)}</div>:<div className="employee-trainer-review-empty">该日已记录，老师未填写额外评价。</div>}
        <footer><span>{row.reportTitle||'线上培训日报'}</span><span>更新：{formatDateTime(row.submittedAt)}</span></footer>
      </article>
    })}</div>:<div className="employee-exam-empty">暂无老师评价</div>}
    {!loading&&!error&&total>0&&<Pagination
      page={resolvedPage}
      pages={Math.max(1,Number(data?.pages||1))}
      total={total}
      pageSize={resolvedPageSize}
      pageSizeOptions={[20,30,50,100]}
      loading={loading}
      onPage={onPage}
      onPageSize={onPageSize}
    />}
  </section>
}

const EMPLOYEE_HISTORY_PAGE_SIZES=[20,30,50,100]

function EmployeeProfileHistoryFilters({draft,setDraft,onApply,onReset,loading=false,placeholder}){
  const update=(key,value)=>setDraft(current=>({...current,[key]:value}))
  return <form className="employee-history-filters employee-profile-history-filters" onSubmit={event=>{event.preventDefault();onApply()}}>
    <label><span>日期起</span><input type="date" value={draft.dateFrom} max={draft.dateTo||undefined} onChange={event=>update('dateFrom',event.target.value)}/></label>
    <label><span>日期止</span><input type="date" value={draft.dateTo} min={draft.dateFrom||undefined} onChange={event=>update('dateTo',event.target.value)}/></label>
    <label className="employee-history-search"><span>搜索</span><input value={draft.query} onChange={event=>update('query',event.target.value)} placeholder={placeholder}/></label>
    <div className="employee-trainer-review-filter-actions"><button type="submit" disabled={loading}>查询</button><button type="button" disabled={loading||(!draft.query&&!draft.dateFrom&&!draft.dateTo)} onClick={onReset}>重置</button></div>
  </form>
}

function EmployeeErrorPanel({data,loading,error}){
  const sourceRows=Array.isArray(data?.rows)?data.rows:[]
  const sourceTotal=Number(data?.total??sourceRows.length)
  const blankFilters=()=>({query:'',dateFrom:'',dateTo:''})
  const [draft,setDraft]=useState(blankFilters)
  const [filters,setFilters]=useState(blankFilters)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(20)
  const filteredRows=useMemo(()=>filterEmployeeErrorHistory(sourceRows,filters),[sourceRows,filters])
  const pages=Math.max(1,Math.ceil(filteredRows.length/pageSize))
  const resolvedPage=Math.min(page,pages)
  const rows=filteredRows.slice((resolvedPage-1)*pageSize,resolvedPage*pageSize)
  const limited=sourceTotal>sourceRows.length
  const apply=()=>{setFilters({...draft,query:text(draft.query)});setPage(1)}
  const reset=()=>{const next=blankFilters();setDraft(next);setFilters(next);setPage(1)}
  return <section className="detail-panel employee-error-panel">
    <div className="detail-panel-head"><div><h3>员工出错记录</h3></div><span className="employee-exam-count">{filteredRows.length}{sourceTotal!==filteredRows.length?` / ${sourceTotal}`:''} 条</span></div>
    <EmployeeProfileHistoryFilters draft={draft} setDraft={setDraft} onApply={apply} onReset={reset} loading={loading} placeholder="搜索日期、错误类型、情况、处理方式、质检人或结果"/>
    {limited&&<div className="employee-history-limit-note">当前安全读取最近 {sourceRows.length} / 共 {sourceTotal} 条；日期和搜索仅筛选这批已加载记录，不会并发读取其余页面。</div>}
    {loading?<div className="employee-exam-empty">正在读取出错记录...</div>:error?<div className="employee-exam-empty error">{error}</div>:rows.length?<div className="employee-error-list">{rows.map((row,index)=><article key={row.record_key||`${row.qc_date}-${index}`}><div className="employee-error-meta"><b>{text(row.qc_date).slice(0,10)||'—'}</b><span>{row.error_type||'未分类错误'}</span>{row.score!==null&&row.score!==undefined&&row.score!==''&&<em>{row.score} 分</em>}</div><div><small>错误情况</small><p>{row.error_note||'—'}</p></div><div><small>正确处理方式</small><p>{row.correct_action||'—'}</p></div><footer><span>质检人：{row.qc_person||'—'}</span><span>复检：{row.leader_review||'—'} · {row.qc_result||'—'}</span></footer></article>)}</div>:<div className="employee-exam-empty">{sourceRows.length?'暂无符合筛选条件的出错记录':'暂无出错记录'}</div>}
    {!loading&&!error&&filteredRows.length>0&&<Pagination page={resolvedPage} pages={pages} total={filteredRows.length} pageSize={pageSize} pageSizeOptions={EMPLOYEE_HISTORY_PAGE_SIZES} loading={loading} onPage={setPage} onPageSize={next=>{setPageSize(next);setPage(1)}}/>}
  </section>
}

function EmployeeExamPanel({data,loading,error}){
  const {notify}=useAppToast()
  const summary=data?.summary||{}, sourceRows=Array.isArray(data?.history)?data.history:[]
  const [examDetail,setExamDetail]=useState(null)
  const [detailLoading,setDetailLoading]=useState(false)
  const [detailError,setDetailError]=useState('')
  const blankFilters=()=>({query:'',dateFrom:'',dateTo:''})
  const [draft,setDraft]=useState(blankFilters)
  const [filters,setFilters]=useState(blankFilters)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(20)
  const mountedRef=useRef(true)
  const examDetailRequestRef=useRef(0)
  const examDetailFlightRef=useRef(null)
  useEffect(()=>{
    mountedRef.current=true
    return()=>{mountedRef.current=false;examDetailRequestRef.current+=1;examDetailFlightRef.current=null}
  },[])
  const examStatus=x=>({in_progress:'答题中',submitted:'待批改',grading:'批改中',graded:'已完成',expired:'已过期'}[x]||x||'—')
  const result=x=>x.status==='graded'?(x.passed?'通过':'未通过'):examStatus(x.status)
  const filteredRows=useMemo(()=>filterEmployeeExamHistory(sourceRows,filters),[sourceRows,filters])
  const pages=Math.max(1,Math.ceil(filteredRows.length/pageSize))
  const resolvedPage=Math.min(page,pages)
  const rows=filteredRows.slice((resolvedPage-1)*pageSize,resolvedPage*pageSize)
  const sourceTotal=Number(summary.attempts??sourceRows.length)
  const limited=sourceTotal>sourceRows.length
  const apply=()=>{setFilters({...draft,query:text(draft.query)});setPage(1)}
  const reset=()=>{const next=blankFilters();setDraft(next);setFilters(next);setPage(1)}
  const answerResult=x=>{
    if(x.source_system==='legacy'&&!x.answer_detail_available)return x.percentage==null?'逐题明细未同步':'总成绩已保留 · 逐题明细未同步'
    const parts=[`对 ${x.correct_count||0}`]
    if(Number(x.partial_count||0)>0)parts.push(`半对 ${x.partial_count}`)
    parts.push(`错 ${x.wrong_count||0}`)
    if(Number(x.pending_count||0)>0)parts.push(`待评 ${x.pending_count}`)
    if(x.source_system==='legacy'){
      const total=Number(x.total_question_count||0),answered=Number(x.answer_detail_count||0)
      const unanswered=Number(x.unanswered_count??Math.max(total-answered,0))
      if(unanswered>0)parts.unshift(`未答 ${unanswered}`)
    }
    return parts.join(' · ')
  }
  const openExam=async row=>{
    if(!mountedRef.current)return
    const requestKey=`${row.source_system||'current'}:${row.id}`
    if(examDetailFlightRef.current?.key===requestKey)return examDetailFlightRef.current.promise
    const requestToken=++examDetailRequestRef.current
    const isCurrent=()=>mountedRef.current&&examDetailRequestRef.current===requestToken
    setExamDetail({session:row,answers:[]});setDetailLoading(true);setDetailError('')
    const request=(async()=>{
      try{
        const fn=row.source_system==='legacy'?'admin_employee_exam_legacy_detail':'admin_employee_exam_session_detail'
        const {data:detail,error:e}=await supabase.rpc(fn,{p_session_id:row.id})
        if(e)throw e
        const rawAnswers=Array.isArray(detail?.answers)?detail.answers:[]
        let answers=rawAnswers
        try{answers=await hydrateExamAnswersAttachments(supabase,rawAnswers,300)}catch{/* Attachment preview failure must not block the exam record. */}
        try{answers=await hydrateExamFeedbackAnswers(supabase,answers,300)}catch{/* Teacher feedback image preview failure must not block the exam record. */}
        if(!isCurrent())return false
        setExamDetail(detail?{...detail,answers}:detail)
        return true
      }catch(error){
        if(!isCurrent())return false
        const message=employeeRequestError(error,'考试详情读取失败，请重试。')
        setDetailError(message)
        notify({
          type:'error',module:EMPLOYEE_TOAST_MODULE,operation:'读取考试详情',reason:message,
          dedupeKey:employeeToastDedupeKey('读取考试详情','error',row.id),
          retry:()=>openExam(row),retryLabel:'重试',
        })
        return false
      }finally{if(isCurrent())setDetailLoading(false)}
    })()
    examDetailFlightRef.current={key:requestKey,promise:request}
    try{return await request}finally{if(examDetailFlightRef.current?.promise===request)examDetailFlightRef.current=null}
  }
  const closeExamDetail=()=>{examDetailRequestRef.current+=1;examDetailFlightRef.current=null;setExamDetail(null);setDetailLoading(false);setDetailError('')}
  return <section className="detail-panel employee-exam-panel"><div className="detail-panel-head"><div><h3>考试记录</h3></div><span className="employee-exam-count">{filteredRows.length}{sourceTotal!==filteredRows.length?` / ${sourceTotal}`:''} 次</span></div>
    <EmployeeProfileHistoryFilters draft={draft} setDraft={setDraft} onApply={apply} onReset={reset} loading={loading} placeholder="搜索日期、考试、来源、系列、评分人、状态或结果"/>
    {limited&&<div className="employee-history-limit-note">当前安全读取最近 {sourceRows.length} / 共 {sourceTotal} 次；日期和搜索仅筛选这批已加载记录，不会并发读取其余记录。</div>}
    {loading?<div className="employee-exam-empty">正在读取考试记录...</div>:error?<div className="employee-exam-empty error">{error}</div>:<>
      <div className="employee-exam-summary"><span><small>考试次数</small><b>{summary.attempts||0}</b></span><span><small>本系统 / 旧考试</small><b>{summary.current_attempts||0} / {summary.legacy_attempts||0}</b></span><span><small>已评分 / 待完成</small><b>{summary.graded||0} / {summary.pending||0}</b></span><span><small>通过次数</small><b>{summary.passed||0}</b></span><span><small>平均分</small><b>{summary.average==null?'—':`${summary.average}%`}</b></span></div>
      {rows.length?<div className="employee-exam-table-wrap"><table className="employee-exam-table"><thead><tr><th>来源</th><th>考试</th><th>次数</th><th>开始作答</th><th>完成作答</th><th>评分完成</th><th>成绩</th><th>答题结果</th><th>评分人</th><th>结果</th><th>详情</th></tr></thead><tbody>{rows.map(x=><tr key={`${x.source_system}-${x.id}`}><td><span className={`exam-source-badge ${x.source_system==='legacy'?'legacy':'current'}`}>{x.source_label||'本系统'}</span></td><td><strong>{x.title}</strong></td><td>第 {x.attempt_no} 次</td><td>{formatDateTime(x.started_at)}</td><td>{formatDateTime(x.submitted_at)}</td><td>{formatDateTime(x.graded_at)}</td><td>{x.percentage==null?'—':`${Number(x.earned_score||0).toLocaleString()}/${Number(x.total_score||0).toLocaleString()} · ${Number(x.percentage).toFixed(1)}%`}</td><td>{answerResult(x)}</td><td>{x.grader_name||'—'}</td><td><span className={`employee-exam-result ${x.status==='graded'?(x.passed?'pass':'fail'):'pending'}`}>{result(x)}</span></td><td><button className="table-action" onClick={()=>openExam(x)}>查看详情</button></td></tr>)}</tbody></table></div>:<div className="employee-exam-empty">{sourceRows.length?'暂无符合筛选条件的考试记录':'暂无考试记录'}</div>}
      {filteredRows.length>0&&<Pagination page={resolvedPage} pages={pages} total={filteredRows.length} pageSize={pageSize} pageSizeOptions={EMPLOYEE_HISTORY_PAGE_SIZES} loading={loading} onPage={setPage} onPageSize={next=>{setPageSize(next);setPage(1)}}/>}
    </>}
    {examDetail&&<EmployeeExamDetailModal detail={examDetail} loading={detailLoading} error={detailError} onClose={closeExamDetail}/>}
  </section>
}

function EmployeeExamDetailModal({detail,loading,error,onClose}){
  const session=detail?.session||{},answers=detail?.answers||[]
  return <div className="modal-mask employee-action-modal-mask" onMouseDown={onClose}><div className="modal-card employee-exam-detail-modal" onMouseDown={e=>e.stopPropagation()}>
    <div className="modal-head"><div><span className="modal-kicker">EXAM RECORD</span><h2>{session.title||'考试详细记录'}</h2><p>{session.employee_no||''} · {session.source_label||'本系统'} · 第 {session.attempt_no||'—'} 次</p></div><button onClick={onClose}>×</button></div>
    {loading?<div className="employee-exam-empty">正在读取完整答卷...</div>:error?<div className="employee-exam-empty error">{error}</div>:<div className="employee-exam-detail-body">
      <div className="employee-exam-summary"><span><small>成绩</small><b>{session.percentage==null?'—':`${Number(session.percentage).toFixed(1)}%`}</b></span><span><small>得分</small><b>{session.earned_score==null?'—':`${session.earned_score}/${session.total_score}`}</b></span><span><small>状态</small><b>{session.status||'—'}</b></span><span><small>评分完成</small><b>{formatDateTime(session.graded_at)}</b></span></div>
      <div className="employee-exam-answer-list">{answers.length?answers.map((a,index)=><article key={a.answer_id||a.question_id||index}><header><b>第 {a.ordinality||index+1} 题</b><span>{a.awarded_score==null?'待评分':`${a.awarded_score}/${a.points||0} 分`}</span></header><p>{a.question_zh||a.question_en||a.question_vi||'题目内容未保留'}</p><div><small>员工答案</small><strong>{a.answer_text||(Array.isArray(a.attachments)&&a.attachments.length?'仅提交图片':'未作答')}</strong></div><EmployeeExamAnswerImageGallery attachments={a.attachments}/>{(a.grader_feedback||(a.grader_feedback_attachments||[]).length>0)&&<div><small>评分说明</small><strong>{a.grader_feedback||'老师已附回复图片'}</strong></div>}<EmployeeExamFeedbackImageGallery attachments={a.grader_feedback_attachments}/></article>):<div className="employee-exam-empty">此记录没有可显示的逐题答卷</div>}</div>
    </div>}
  </div></div>
}

function ResignModal({state,setState,onClose,onSave}){
  return <div className="modal-mask employee-action-modal-mask" onMouseDown={onClose}><div className="modal-card resign-modal" onMouseDown={e=>e.stopPropagation()}>
    <div className="modal-head"><div><span className="modal-kicker">EMPLOYEE RESIGNATION</span><h2>办理离职</h2><p>{state.employee_no} · {state.full_name}</p></div><button onClick={onClose}>×</button></div>
    <div className="form-grid">
      <Field label="离职日期"><input type="date" value={state.resign_date} onChange={e=>setState({...state,resign_date:e.target.value})}/></Field>
      <Field label="离职原因" wide><input value={state.reason} onChange={e=>setState({...state,reason:e.target.value})} placeholder="必须填写，例如：个人原因 / 不适合岗位 / 绩效原因"/></Field>
      <label className="checkbox-row form-wide"><input type="checkbox" checked={state.disable_portal} onChange={e=>setState({...state,disable_portal:e.target.checked})}/><span>同时停用员工 Portal 登录账号（员工历史资料不会删除）</span></label>
    </div>
    <div className="modal-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="danger-action" onClick={onSave}>确认离职</button></div>
  </div></div>
}

function AnalysisDetailModal({state,loading,onClose,onOpenEmployee}){
  const blankDetailFilters=()=>({employee_no:'',full_name:'',team:'',position:'',country:'',shift:'',reason:''})
  const [detailDraftFilters,setDetailDraftFilters]=useState(blankDetailFilters)
  const [detailFilters,setDetailFilters]=useState(blankDetailFilters)
  const [detailPage,setDetailPage]=useState(1)
  const [detailPageSize,setDetailPageSize]=useState(20)
  const options=useMemo(()=>({
    teams:Array.from(new Set((state.rows||[]).map(x=>text(x.team)).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN')),
    positions:Array.from(new Set((state.rows||[]).map(x=>text(x.position)).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN')),
    countries:Array.from(new Set((state.rows||[]).map(x=>text(x.country)).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN')),
    shifts:Array.from(new Set((state.rows||[]).map(x=>text(x.shift)).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN')),
  }),[state.rows])
  const filteredRows=useMemo(()=>{
    const contains=(a,b)=>!text(b)||text(a).toLowerCase().includes(text(b).toLowerCase())
    return (state.rows||[]).filter(r=>
      contains(r.employee_no,detailFilters.employee_no)&&
      contains(r.full_name,detailFilters.full_name)&&
      contains(r.team,detailFilters.team)&&
      contains(r.position,detailFilters.position)&&
      contains(r.country,detailFilters.country)&&
      contains(r.shift,detailFilters.shift)&&
      contains(r.reason,detailFilters.reason)
    )
  },[state.rows,detailFilters])
  const pages=Math.max(1,Math.ceil(filteredRows.length/detailPageSize))
  const pageRows=filteredRows.slice((detailPage-1)*detailPageSize,detailPage*detailPageSize)
  const isActiveView=state.event_type==='active'
  const showReason=state.event_type!=='active'
  const visibleTestCount=filteredRows.filter(r=>r.is_test).length
  const visibleProductionCount=filteredRows.length-visibleTestCount
  const detailTypeLabel=v=>v==='resign'?'离职':v==='active'?'在职':'入职'
  const detailDateLabel=v=>v==='resign'?'离职日期':'入职日期'
  useEffect(()=>setDetailPage(1),[JSON.stringify(detailFilters),detailPageSize,state.title])
  useEffect(()=>{if(detailPage>pages)setDetailPage(pages)},[detailPage,pages])

  return <div className="modal-mask analytics-detail-mask" onMouseDown={onClose}><div className="analytics-detail-dialog" onMouseDown={e=>e.stopPropagation()}>
    <div className="analytics-detail-head">
      <div><span className="modal-kicker">PEOPLE DETAIL</span><h2>{state.title}</h2><p>{filteredRows.length} 条显示{visibleTestCount>0?`（正式 ${visibleProductionCount} + TEST ${visibleTestCount}）`:''} · 正式KPI仍不计TEST · 可继续筛选并查看完整员工档案。</p></div>
      <button className="drawer-close" onClick={onClose}>×</button>
    </div>
    <div className={`analytics-detail-filterbar ${isActiveView?'active-detail-filterbar':''}`}>
      <label className="pro-filter-field"><span>员工ID</span><div className="pro-input-shell"><i>⌕</i><input value={detailDraftFilters.employee_no} onChange={e=>setDetailDraftFilters({...detailDraftFilters,employee_no:e.target.value})} placeholder="输入员工ID"/></div></label>
      <label className="pro-filter-field"><span>姓名</span><div className="pro-input-shell"><i>⌕</i><input value={detailDraftFilters.full_name} onChange={e=>setDetailDraftFilters({...detailDraftFilters,full_name:e.target.value})} placeholder="输入姓名"/></div></label>
      <label className="pro-filter-field"><span>团队</span><FilterCombo value={detailDraftFilters.team} options={options.teams} onChange={v=>setDetailDraftFilters({...detailDraftFilters,team:v})} placeholder="全部团队 / 输入搜索" listId="detail-team"/></label>
      <label className="pro-filter-field"><span>岗位</span><FilterCombo value={detailDraftFilters.position} options={options.positions} onChange={v=>setDetailDraftFilters({...detailDraftFilters,position:v})} placeholder="全部岗位 / 输入搜索" listId="detail-position"/></label>
      <label className="pro-filter-field"><span>员工国家</span><FilterCombo value={detailDraftFilters.country} options={options.countries} onChange={v=>setDetailDraftFilters({...detailDraftFilters,country:v})} placeholder="全部员工国家 / 输入搜索" listId="detail-country"/></label>
      <label className="pro-filter-field"><span>班次</span><FilterCombo value={detailDraftFilters.shift} options={cleanShiftOptions(options.shifts)} onChange={v=>setDetailDraftFilters({...detailDraftFilters,shift:v})} placeholder="全部班次 / 输入搜索" listId="detail-shift"/></label>
      {showReason&&<label className="pro-filter-field"><span>离职原因</span><input className="pro-plain-input" value={detailDraftFilters.reason} onChange={e=>setDetailDraftFilters({...detailDraftFilters,reason:e.target.value})} placeholder="输入离职原因"/></label>}
      <div className="filter-toolbar-actions"><button className="primary-action" onClick={()=>setDetailFilters({...detailDraftFilters})}>查询</button><button className="secondary-action" onClick={()=>{const next=blankDetailFilters();setDetailDraftFilters(next);setDetailFilters(next)}}>重置</button></div>
    </div>
    {loading?<div className="empty-state">读取人员明细...</div>:!filteredRows.length?<div className="empty-state">这个条件下暂无人员记录</div>:<div className="analytics-detail-content"><div className="analytics-detail-table-wrap"><table className="data-table analytics-detail-table">
      <thead><tr><th>入职日期</th>{showReason&&<th>离职日期</th>}<th>状态</th><th>员工ID</th><th>姓名</th><th>团队</th><th>岗位</th><th>员工国家</th><th>班次</th>{showReason&&<th>离职原因</th>}<th>操作</th></tr></thead>
      <tbody>{pageRows.map((r,i)=><tr key={r.id||`${r.employee_no}-${r.date}-${i}`}><td><div className="event-date-cell"><strong>{r.hire_date||((r.event_type==='join'||r.event_type==='active')?r.date:'—')||'—'}</strong><small>入职日期</small></div></td>{showReason&&<td><div className="event-date-cell"><strong>{r.resign_date||r.date||'—'}</strong><small>离职日期</small></div></td>}<td><span className={`event-chip ${r.event_type==='resign'?'resign':r.event_type==='active'?'active':'join'}`}>{detailTypeLabel(r.event_type)}</span></td><td><strong>{r.employee_no||'—'}</strong>{r.is_test&&<span style={{marginLeft:6,fontSize:10,fontWeight:800,color:'#b45309'}}>TEST</span>}</td><td>{r.full_name||'—'}</td><td>{r.team||'—'}</td><td>{r.position||'—'}</td><td>{r.country||'—'}</td><td>{r.shift||'—'}</td>{showReason&&<td className="analytics-reason">{r.reason||'—'}</td>}<td>{r.employee_id&&<button className="table-action primary-mini-action" onClick={()=>onOpenEmployee(r)}>查看档案</button>}</td></tr>)}</tbody>
    </table></div><Pagination page={detailPage} pages={pages} total={filteredRows.length} pageSize={detailPageSize} loading={loading} onPage={setDetailPage} onPageSize={n=>{setDetailPageSize(n);setDetailPage(1)}}/></div>}
  </div></div>
}

function EditResignationModal({state,setState,onClose,onSave}){
  return <div className="modal-mask employee-action-modal-mask" onMouseDown={onClose}><div className="modal-card resign-modal edit-resignation-modal" onMouseDown={e=>e.stopPropagation()}>
    <div className="modal-head"><div><span className="modal-kicker">EDIT RESIGNATION</span><h2>修改离职记录</h2><p>{state.employee_no} · {state.full_name}</p></div><button onClick={onClose}>×</button></div>
    <div className="edit-resignation-note">修改后会同步更新当前离职档案；员工其他历史资料不会删除。</div>
    <div className="form-grid">
      <Field label="离职日期"><input type="date" value={state.resign_date} onChange={e=>setState({...state,resign_date:e.target.value})}/></Field>
      <Field label="离职原因" wide><input value={state.reason} onChange={e=>setState({...state,reason:e.target.value})} placeholder="填写实际离职原因"/></Field>
    </div>
    <div className="modal-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" onClick={onSave}>保存修改</button></div>
  </div></div>
}

function CancelHireModal({state,setState,onClose,onSave}){
  return <div className="modal-mask employee-action-modal-mask" onMouseDown={onClose}><div className="modal-card resign-modal" onMouseDown={e=>e.stopPropagation()}>
    <div className="modal-head"><div><span className="modal-kicker">CANCEL NEW HIRE</span><h2>撤销入职</h2><p>{state.employee_no} · {state.full_name}</p></div><button onClick={onClose}>×</button></div>
    <div className="cancel-hire-warning"><strong>只用于录错资料或新人临时取消上班。</strong><span>确认后会移除当前员工档案与正式《居家员工名单》记录。已经建立员工登录账号的人员不能直接撤销。</span></div>
    <div className="form-grid"><Field label={`输入员工ID ${state.employee_no} 确认`} wide><input value={state.confirm_text||''} onChange={e=>setState({...state,confirm_text:e.target.value.toUpperCase()})}/></Field></div>
    <div className="modal-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="danger-action" onClick={onSave}>确认撤销入职</button></div>
  </div></div>
}

function RestoreModal({state,setState,onClose,onSave}){
  return <div className="modal-mask employee-action-modal-mask" onMouseDown={onClose}><div className="modal-card resign-modal" onMouseDown={e=>e.stopPropagation()}>
    <div className="modal-head"><div><span className="modal-kicker">RESTORE EMPLOYEE</span><h2>恢复在职</h2><p>{state.employee_no} · {state.full_name}</p></div><button onClick={onClose}>×</button></div>
    <div className="restore-confirm-copy">
      <strong>撤销这次离职记录？</strong>
      <span>员工会恢复为在职，离职日期与离职原因会从正式《居家员工名单》清除。</span>
    </div>
    <label className="checkbox-row"><input type="checkbox" checked={state.restore_portal!==false} onChange={e=>setState({...state,restore_portal:e.target.checked})}/><span>如有员工 Portal，同时恢复登录</span></label>
    <div className="modal-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" onClick={onSave}>确认恢复</button></div>
  </div></div>
}


function isoAdd(base,days){
  if(!base) return ''
  const d=new Date(`${base}T12:00:00`)
  d.setDate(d.getDate()+Number(days||0))
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function signed(v){
  const n=Number(v)
  if(!Number.isFinite(n)) return '—'
  if(n>0) return `+${n}`
  return String(n)
}
function pctText(v){
  const n=Number(v)
  if(!Number.isFinite(n)) return '0%'
  return `${n.toFixed(n>=10?1:2).replace(/\.0$/,'')}%`
}
function MetricSummary({label,value,compare,compareLabel,hint,percentCompare,inverse,onClick}){
  const n=Number(compare)
  const hasCompare=compare!==undefined&&compare!==null&&Number.isFinite(n)
  const cls=hasCompare?(n===0?'flat':((inverse?n<0:n>0)?'good':'bad')):''
  return <div className={`summary-card metric-summary-card ${onClick?'is-clickable':''}`} onClick={onClick} role={onClick?'button':undefined} tabIndex={onClick?0:undefined}>
    <span>{label}</span>
    <strong>{value??'—'}</strong>
    {hasCompare?<small className={`metric-compare ${cls}`}>{compareLabel} {signed(n)}{percentCompare?'%':''}</small>:hint?<small className="metric-hint">{hint}</small>:null}
    {onClick&&<b className="metric-drill-cue">查看明细 →</b>}
  </div>
}
function RatioBar({name,count,share,sub,onClick}){
  const width=Math.max(0,Math.min(100,Number(share)||0))
  return <div className={`ratio-row ${onClick?'ratio-clickable':''}`} onClick={onClick} role={onClick?'button':undefined}>
    <div className="ratio-row-head"><span title={name}>{name||'未分类'}</span><strong>{count||0}<em>{pctText(share)}</em></strong></div>
    <div className="ratio-track"><i style={{width:`${width}%`}}/></div>
    {sub&&<small>{sub}</small>}
  </div>
}
function MiniFlow({join7,resign7,join30,resign30,net30}){
  return <div className="mini-flow-grid">
    <div><span>7天入职</span><strong>{join7||0}</strong></div>
    <div><span>7天离职</span><strong>{resign7||0}</strong></div>
    <div><span>30天入职</span><strong>{join30||0}</strong></div>
    <div><span>30天离职</span><strong>{resign30||0}</strong></div>
    <div className={(net30||0)>=0?'flow-net positive':'flow-net negative'}><span>30天净增</span><strong>{signed(net30||0)}</strong></div>
  </div>
}
function TrendBars({rows=[],onSelectDay}){
  const max=Math.max(1,...rows.flatMap(x=>[Number(x.join)||0,Number(x.resign)||0]))
  return <div className="trend-bars trend-bars-pro">
    <div className="trend-legend"><span><i className="join-dot"/>入职</span><span><i className="resign-dot"/>离职</span></div>
    <div className="trend-bars-body">{rows.map(x=><button type="button" className="trend-day" key={x.date} title={`${x.date} 入职 ${x.join||0} / 离职 ${x.resign||0}`} onClick={()=>onSelectDay?.(x.date)}>
      <div className="trend-value-pair"><b>{x.join||0}</b><em>{x.resign||0}</em></div>
      <div className="trend-columns"><i className="join-col" style={{height:`${Math.max(3,(Number(x.join)||0)/max*100)}%`}}/><i className="resign-col" style={{height:`${Math.max(3,(Number(x.resign)||0)/max*100)}%`}}/></div>
      <span>{String(x.date||'').slice(5)}</span>
    </button>)}</div>
  </div>
}
function EmployeeAnalyticsOverview({analytics,onTeam,onPosition,onCountry,onShift,onResign,onDay}){
  if(analytics.loading) return <AnalysisLoadingState label="正在读取人员结构"/>
  const countries=(analytics.countries||[]).slice(0,7)
  const teams=(analytics.teams||[]).slice(0,7)
  const positions=(analytics.positions||[]).slice(0,7)
  const shifts=(analytics.shifts||[]).slice(0,7)
  return <div className="people-analysis-layout">
    <div className="people-analysis-main">
      <section className="analysis-overview-card trend-card compact-trend-card">
        <div className="analysis-card-head"><div><h3>{analytics.period?.active?`${analytics.period.label} 人员流动`:'近14天人员流动'}</h3><p>柱顶直接显示入职 / 离职人数；点击日期查看当天人员。</p></div><span>{analytics.period?.active?`区间净增 ${signed(analytics.period.net||0)}`:`30天净增 ${signed(analytics.kpis?.net_30d||0)}`}</span></div>
        <TrendBars rows={analytics.trend||[]} onSelectDay={onDay}/>
      </section>
      <section className="analysis-overview-card country-card-pro">
        <div className="analysis-card-head"><div><h3>员工国家概览</h3><p>{analytics.period?.active?`当前人数 / ${analytics.period.label}离职`:'当前人数 / 近30天离职'}</p></div></div>
        <div className="country-analysis-list">{countries.map(x=><div className="country-analysis-row country-click-row" key={x.name}>
          <button type="button" onClick={()=>onCountry?.(x.name)}><strong>{x.name}</strong><span>{x.count} 人 · {pctText(x.share)}</span></button>
          <button type="button" className="country-resign-link" onClick={()=>onResign?.('country',x.name)}><span>{analytics.period?.active?'区间离职':'30天离职'}</span><strong>{analytics.period?.active?(x.period_resign||0):(x.resign_30d||0)}</strong><em>{pctText(analytics.period?.active?(x.period_resign_rate||0):(x.resign_rate_30||0))}</em></button>
        </div>)}</div>
      </section>
    </div>
    <div className="people-analysis-breakdowns">
      <section className="analysis-overview-card">
        <div className="analysis-card-head"><div><h3>团队人数占比</h3><p>点击团队查看该团队员工</p></div></div>
        <div className="ratio-list">{teams.map(x=><RatioBar key={x.name} {...x} onClick={()=>onTeam?.(x.name)}/>)}</div>
      </section>
      <section className="analysis-overview-card">
        <div className="analysis-card-head"><div><h3>岗位人数占比</h3><p>点击岗位查看人员</p></div></div>
        <div className="ratio-list">{positions.map(x=><RatioBar key={x.name} {...x} onClick={()=>onPosition?.(x.name)}/>)}</div>
      </section>
      <section className="analysis-overview-card">
        <div className="analysis-card-head"><div><h3>班次人数占比</h3><p>点击班次查看人员</p></div></div>
        <div className="ratio-list">{shifts.map(x=><RatioBar key={x.name} {...x} onClick={()=>onShift?.(x.name)}/>)}</div>
      </section>
    </div>
  </div>
}


function DimensionAnalysisDirectory({title,subtitle,rows=[],loading,onPeople,onResign}){
  if(loading) return <AnalysisLoadingState label={`正在读取${title}`}/>
  const ordered=[...rows].sort((a,b)=>(b.count||0)-(a.count||0)||text(a.name).localeCompare(text(b.name),'zh-CN'))
  const active=ordered.reduce((sum,x)=>sum+(Number(x.count)||0),0)
  const join7=ordered.reduce((sum,x)=>sum+(Number(x.join_7d)||0),0)
  const resign7=ordered.reduce((sum,x)=>sum+(Number(x.resign_7d)||0),0)
  const resign30=ordered.reduce((sum,x)=>sum+(Number(x.resign_30d)||0),0)
  return <section className="dimension-directory-section">
    <div className="analysis-head-row dimension-directory-heading">
      <div><h2>{title}</h2><p>{subtitle}</p></div>
      <div className="analysis-badge">{ordered.length} 项 · {active} 人</div>
    </div>
    <div className="dimension-directory-summary">
      <MetricSummary label="当前人数" value={active}/>
      <MetricSummary label="近7天入职" value={join7}/>
      <MetricSummary label="近7天离职" value={resign7} inverse/>
      <MetricSummary label="近30天离职" value={resign30} inverse/>
    </div>
    <div className="dimension-directory-grid">{ordered.map(x=><article className="dimension-directory-card" key={x.name}>
      <div className="dimension-directory-card-head"><button type="button" onClick={()=>onPeople?.(x.name)}><strong>{x.name||'未分类'}</strong><span>查看当前人员 →</span></button><em>{x.count||0} 人</em></div>
      <div className="overall-ratio"><div><span>占当前在职</span><strong>{pctText(x.share||0)}</strong></div><div className="ratio-track big"><i style={{width:`${Math.max(0,Math.min(100,Number(x.share)||0))}%`}}/></div></div>
      <MiniFlow join7={x.join_7d} resign7={x.resign_7d} join30={x.join_30d} resign30={x.resign_30d} net30={x.net_30d}/>
      <div className="dimension-directory-actions"><button type="button" className="table-action" onClick={()=>onPeople?.(x.name)}>查看人员</button><button type="button" className="table-action" onClick={()=>onResign?.(x.name)}>近30天离职 {x.resign_30d||0}</button></div>
    </article>)}</div>
    {!ordered.length&&<div className="empty-state">暂无{title}数据</div>}
  </section>
}

function AnalysisLoadingState({label}){
  return <div className="employee-analysis-loading" role="status" aria-live="polite" aria-busy="true"><i aria-hidden="true"/><span>{label}</span></div>
}



function CountryTenurePanel({analytics,filters,onOpen}){
  if(analytics.loading) return null
  const rows=analytics.countries||[]
  if(!rows.length) return null
  const activeTotal=rows.reduce((sum,x)=>sum+(Number(x.count)||0),0)
  const resignTotal=rows.reduce((sum,x)=>sum+(Number(x.resign_total)||0),0)
  const overallRate=activeTotal+resignTotal?resignTotal/(activeTotal+resignTotal)*100:0
  const openActive=(country,bucket,label)=>onOpen?.({
    title:`${country} · ${label}`,
    event_type:'active',
    dimension:'country',
    value:country,
    filters:{...(filters||{}),country:'',tenure_bucket:bucket},
  })
  const openAllActive=country=>onOpen?.({
    title:`${country} · 当前在职员工`,
    event_type:'active',
    dimension:'country',
    value:country,
    filters:{...(filters||{}),country:''},
  })
  const openResigned=country=>onOpen?.({
    title:`${country} · 累计离职员工`,
    event_type:'resign',
    dimension:'country',
    value:country,
    date_from:analytics.resignation?.history_from||'2000-01-01',
    date_to:analytics.as_of,
    filters:{...(filters||{}),country:''},
  })
  const cell=(country,bucket,label,value)=><button type="button" className="tenure-number-link" onClick={()=>openActive(country,bucket,label)}>{value||0}</button>

  return <section className="country-tenure-section">
    <div className="analysis-head-row country-tenure-heading">
      <div><h2>员工国家入职阶段</h2><p>按员工国家查看准备入职、入职天数阶段、当前在职和累计离职；点击人数直接弹出对应员工。</p></div>
      <div className="country-tenure-summary">
        <span>当前在职 <strong>{activeTotal}</strong></span>
        <span>累计离职 <strong>{resignTotal}</strong></span>
        <span>综合离职率 <strong>{pctText(overallRate)}</strong></span>
      </div>
    </div>
    <div className="analysis-overview-card country-tenure-card">
      <div className="country-tenure-table-wrap"><table className="country-tenure-table">
        <thead><tr>
          <th>员工国家</th><th>准备入职</th><th>入职7天内</th><th>入职7-14天</th><th>入职15-30天</th><th>入职30-60天</th><th>入职60天以上</th><th>当前在职</th><th>累计离职</th><th>离职率</th>
        </tr></thead>
        <tbody>{rows.map(x=><tr key={x.name}>
          <td><button type="button" className="dimension-name-button" onClick={()=>openAllActive(x.name)}>{x.name}</button>{(x.tenure_unknown||0)>0&&<small className="tenure-missing-note">日期待完善 {x.tenure_unknown}</small>}</td>
          <td>{cell(x.name,'prepare','准备入职人员',x.prepare_join)}</td>
          <td>{cell(x.name,'within_7','入职7天内人员',x.hire_7d)}</td>
          <td>{cell(x.name,'days_7_14','入职7-14天人员',x.hire_7_14)}</td>
          <td>{cell(x.name,'days_15_30','入职15-30天人员',x.hire_15_30)}</td>
          <td>{cell(x.name,'days_30_60','入职30-60天人员',x.hire_30_60)}</td>
          <td>{cell(x.name,'days_60_plus','入职60天以上人员',x.hire_60_plus)}</td>
          <td><button type="button" className="tenure-number-link total" onClick={()=>openAllActive(x.name)}>{x.count||0}</button></td>
          <td><button type="button" className="tenure-number-link resign" onClick={()=>openResigned(x.name)}>{x.resign_total||0}</button></td>
          <td><strong className="tenure-rate">{pctText(x.lifetime_resign_rate||0)}</strong></td>
        </tr>)}</tbody>
      </table></div>
    </div>
  </section>
}

function CountryPeopleAnalytics({analytics,onOpen,onCountry}){
  if(analytics.loading) return null
  const rows=analytics.countries||[]
  if(!rows.length) return null
  const asOf=analytics.as_of
  const today=asOf
  const start7=isoAdd(asOf,-6)
  const start30=isoAdd(asOf,-29)
  const monthFrom=analytics.resignation?.month_from||String(asOf||'').slice(0,7)+'-01'
  const biggest=[...rows].sort((a,b)=>(b.count||0)-(a.count||0))[0]
  const joinTop=[...rows].sort((a,b)=>(b.join_30d||0)-(a.join_30d||0))[0]
  const resignTop=[...rows].sort((a,b)=>(b.resign_30d||0)-(a.resign_30d||0))[0]
  const rateTop=[...rows].filter(x=>(x.count||0)+(x.resign_30d||0)>=5).sort((a,b)=>(b.resign_rate_30||0)-(a.resign_rate_30||0))[0]
  const open=(title,event_type,date_from,date_to,name)=>onOpen?.({title,event_type,date_from,date_to,dimension:'country',value:name})
  return <section className="country-intelligence-section">
    <div className="analysis-head-row country-intelligence-heading">
      <div><h2>员工国家分析</h2><p>当前人数、入职、离职、净增与离职率按员工国家拆分；人数可直接下钻到具体员工。</p></div>
      <div className="analysis-badge">{rows.length} 个员工国家</div>
    </div>
    <div className="country-summary-grid">
      <MetricSummary label="人数最多国家" value={biggest?.count||0} hint={`${biggest?.name||'—'} · ${pctText(biggest?.share||0)}`} onClick={()=>biggest&&onCountry?.(biggest.name)}/>
      <MetricSummary label="30天入职最多" value={joinTop?.join_30d||0} hint={joinTop?.name||'—'} onClick={()=>joinTop&&open(`${joinTop.name} · 近30天入职人员`,'join',start30,today,joinTop.name)}/>
      <MetricSummary label="30天离职最多" value={resignTop?.resign_30d||0} hint={resignTop?.name||'—'} inverse onClick={()=>resignTop&&open(`${resignTop.name} · 近30天离职人员`,'resign',start30,today,resignTop.name)}/>
      <MetricSummary label="30天离职率最高" value={pctText(rateTop?.resign_rate_30||0)} hint={rateTop?.name||'—'} inverse onClick={()=>rateTop&&open(`${rateTop.name} · 近30天离职人员`,'resign',start30,today,rateTop.name)}/>
    </div>
    <div className="analysis-overview-card country-flow-card">
      <div className="analysis-card-head"><div><h3>各员工国家人员流动</h3><p>今日、近7天、近30天的入职 / 离职与对比；点击人数查看对应员工。</p></div></div>
      <div className="country-flow-table-wrap"><table className="country-flow-table">
        <thead><tr><th>员工国家</th><th>在职</th><th>占比</th><th>今日入职</th><th>今日离职</th><th>近7天入职</th><th>近7天离职</th><th>7天净增</th><th>近30天入职</th><th>近30天离职</th><th>30天净增</th><th>30天离职率</th><th>本月入职</th><th>本月离职</th><th>入职月环比</th><th>离职月环比</th><th>累计离职</th></tr></thead>
        <tbody>{rows.map(x=><tr key={x.name}>
          <td><button className="dimension-name-button" onClick={()=>onCountry?.(x.name)}>{x.name}</button></td>
          <td><button className="number-link" onClick={()=>onCountry?.(x.name)}>{x.count||0}</button></td><td>{pctText(x.share||0)}</td>
          <td><button className="number-link join-number-link" onClick={()=>open(`${x.name} · 今日入职`, 'join',today,today,x.name)}>{x.today_join||0}</button><JoinCompare value={x.today_join_delta_pct}/></td>
          <td><button className="number-link" onClick={()=>open(`${x.name} · 今日离职`, 'resign',today,today,x.name)}>{x.today_resign||0}</button><ResignCompare value={x.today_resign_delta_pct}/></td>
          <td><button className="number-link join-number-link" onClick={()=>open(`${x.name} · 近7天入职`, 'join',start7,today,x.name)}>{x.join_7d||0}</button><JoinCompare value={x.join_7d_delta_pct}/></td>
          <td><button className="number-link" onClick={()=>open(`${x.name} · 近7天离职`, 'resign',start7,today,x.name)}>{x.resign_7d||0}</button><ResignCompare value={x.resign_7d_delta_pct}/></td>
          <td className={(x.net_7d||0)>=0?'positive-number':'negative-number'}>{signed(x.net_7d||0)}</td>
          <td><button className="number-link join-number-link" onClick={()=>open(`${x.name} · 近30天入职`, 'join',start30,today,x.name)}>{x.join_30d||0}</button></td>
          <td><button className="number-link" onClick={()=>open(`${x.name} · 近30天离职`, 'resign',start30,today,x.name)}>{x.resign_30d||0}</button></td>
          <td className={(x.net_30d||0)>=0?'positive-number':'negative-number'}>{signed(x.net_30d||0)}</td><td>{pctText(x.resign_rate_30||0)}</td><td><button className="number-link join-number-link" onClick={()=>open(`${x.name} · 本月入职`, 'join',monthFrom,today,x.name)}>{x.month_join||0}</button></td><td><button className="number-link" onClick={()=>open(`${x.name} · 本月离职`, 'resign',monthFrom,today,x.name)}>{x.month_resign||0}</button></td><td><JoinCompare value={x.month_join_delta_pct}/></td><td><ResignCompare value={x.month_resign_delta_pct}/></td><td>{x.resign_total||0}</td>
        </tr>)}</tbody>
      </table></div>
    </div>
  </section>
}

function resignCompareText(v){
  const n=Number(v)||0
  if(n===0) return '0%'
  return `${n>0?'+':''}${n.toFixed(1)}%`
}
function ResignCompare({value}){
  const n=Number(value)||0
  const cls=n>0?'worse':n<0?'better':'flat'
  return <span className={`resign-compare ${cls}`}>{resignCompareText(n)}</span>
}
function JoinCompare({value}){
  const n=Number(value)||0
  const cls=n>0?'better':n<0?'worse':'flat'
  return <span className={`resign-compare ${cls}`}>{resignCompareText(n)}</span>
}
function ResignationAnalyticsPanel({analytics,filters,setFilters,options,onQuery,onReset,onOpen}){
  if(analytics.loading) return null
  const k=analytics.kpis||{}
  const r=analytics.resignation||{}
  const asOf=analytics.as_of
  const today=asOf
  const yesterday=isoAdd(asOf,-1)
  const sevenFrom=isoAdd(asOf,-6)
  const thirtyFrom=isoAdd(asOf,-29)
  const historyFrom=r.history_from||'2000-01-01'
  const monthFrom=r.month_from||String(asOf||'').slice(0,7)+'-01'
  const teams=analytics.teams||[]
  const positions=(analytics.positions||[]).slice().sort((a,b)=>(b.month_resign||0)-(a.month_resign||0)||(b.resign_total||0)-(a.resign_total||0)).slice(0,12)
  const countries=(analytics.countries||[]).slice().sort((a,b)=>(b.month_resign||0)-(a.month_resign||0)||(b.resign_total||0)-(a.resign_total||0)).slice(0,12)
  const shifts=(analytics.shifts||[]).slice().sort((a,b)=>(b.month_resign||0)-(a.month_resign||0)||(b.resign_total||0)-(a.resign_total||0)).slice(0,12)
  const unmatchedTeam=teams.find(x=>['未匹配团队','未分类'].includes(text(x.name)))
  const validTeamCount=teams.filter(x=>!['未匹配团队','未分类'].includes(text(x.name))).length
  const open=(title,date_from,date_to,dimension='',value='')=>onOpen?.({title,event_type:'resign',date_from,date_to,dimension,value})

  return <section className="resignation-analytics-section">
    <div className="analysis-head-row resignation-analysis-heading">
      <h2>离职分析</h2>
      <div className="resignation-heading-actions">{Number(unmatchedTeam?.count||0)>0&&<button type="button" className="resignation-unmatched-bell" title={`当前有 ${unmatchedTeam?.count||0} 名人员未匹配团队`}>🔔 <strong>{unmatchedTeam?.count||0}</strong></button>}<div className="analysis-badge">截至 {asOf||'—'}</div></div>
    </div>

    <div className="resignation-analysis-filterbar">
      <label className="pro-filter-field"><span>员工ID</span><div className="pro-input-shell"><i>⌕</i><input value={filters.employee_no} onChange={e=>setFilters({...filters,employee_no:e.target.value})} placeholder="输入员工ID"/></div></label>
      <label className="pro-filter-field"><span>姓名</span><div className="pro-input-shell"><i>⌕</i><input value={filters.full_name} onChange={e=>setFilters({...filters,full_name:e.target.value})} placeholder="输入姓名"/></div></label>
      <label className="pro-filter-field"><span>团队</span><FilterCombo value={filters.team} options={(options.teams||[]).map(x=>x.name)} onChange={v=>setFilters({...filters,team:v})} placeholder="全部团队 / 输入搜索" listId="resign-analysis-team"/></label>
      <label className="pro-filter-field"><span>岗位</span><FilterCombo value={filters.position} options={(options.positions||[]).map(x=>x.name)} onChange={v=>setFilters({...filters,position:v})} placeholder="全部岗位 / 输入搜索" listId="resign-analysis-position"/></label>
      <label className="pro-filter-field"><span>员工国家</span><FilterCombo value={filters.country} options={(options.countries||[]).map(x=>x.name)} onChange={v=>setFilters({...filters,country:v})} placeholder="全部员工国家 / 输入搜索" listId="resign-analysis-country"/></label>
      <label className="pro-filter-field"><span>离职原因</span><input className="pro-plain-input" value={filters.reason} onChange={e=>setFilters({...filters,reason:e.target.value})} placeholder="输入离职原因"/></label>
      <label className="pro-filter-field resign-analysis-date"><span>离职日期区间</span><div className="pro-date-range"><input type="date" value={filters.date_from} onChange={e=>setFilters({...filters,date_from:e.target.value})}/><b>—</b><input type="date" value={filters.date_to} onChange={e=>setFilters({...filters,date_to:e.target.value})}/></div></label>
      <div className="filter-toolbar-actions"><button className="primary-action" onClick={onQuery}>查询</button><button className="secondary-action" onClick={onReset}>重置</button></div>
    </div>

    {analytics.period?.active&&<div className="resignation-period-strip">
      <div><span>所选区间</span><strong>{analytics.period.label}</strong></div>
      <div><span>区间离职</span><strong>{analytics.period.resign||0}</strong></div>
      <div><span>区间入职</span><strong>{analytics.period.join||0}</strong></div>
      <div><span>区间净增</span><strong>{signed(analytics.period.net||0)}</strong></div>
      <div><span>区间离职率</span><strong>{pctText(analytics.period.resign_rate||0)}</strong></div>
    </div>}

    <div className="resignation-kpi-grid">
      <button type="button" className="resign-kpi-card" onClick={()=>open('今日离职人员',today,today)}>
        <span>今日离职</span><strong>{k.today_resign||0}</strong>
        <small>较昨日 <ResignCompare value={k.today_resign_delta_pct}/></small>
      </button>
      <button type="button" className="resign-kpi-card" onClick={()=>open('昨日离职人员',yesterday,yesterday)}>
        <span>昨日离职</span><strong>{k.yesterday_resign||0}</strong>
        <small>较前日 <ResignCompare value={k.yesterday_resign_delta_pct}/></small>
      </button>
      <button type="button" className="resign-kpi-card" onClick={()=>open('近7天离职人员',sevenFrom,today)}>
        <span>近7天离职</span><strong>{k.resign_7d||0}</strong>
        <small>较前7天 <ResignCompare value={k.resign_7d_delta_pct}/></small>
      </button>
      <button type="button" className="resign-kpi-card" onClick={()=>open('本月离职人员',monthFrom,today)}>
        <span>本月离职</span><strong>{k.month_resign||0}</strong>
        <small>较上月同期 <ResignCompare value={k.month_resign_delta_pct}/></small>
      </button>
      <button type="button" className="resign-kpi-card" onClick={()=>open('累计离职人员',historyFrom,today)}>
        <span>累计离职</span><strong>{k.resign_total||0}</strong>
        <small>{historyFrom} 至今</small>
      </button>
      <button type="button" className="resign-kpi-card" onClick={()=>open('近30天离职人员',thirtyFrom,today)}>
        <span>近30天离职率</span><strong>{pctText(k.resign_rate_30||0)}</strong>
        <small>近30天离职 {k.resign_30d||0} 人</small>
      </button>
    </div>

    <div className="analysis-overview-card team-resignation-card">
      <div className="analysis-card-head">
        <h3>各团队离职明细</h3>
        <span>{teams.length} 个团队</span>
      </div>
      <div className="team-resignation-table-wrap">
        <table className="team-resignation-table">
          <thead><tr>
            <th>团队</th><th>在职</th><th>今日</th><th>昨日</th><th>今日较昨</th><th>昨日较前日</th>
            <th>近7天</th><th>前7天</th><th>周环比</th>
            <th>本月</th><th>上月同期</th><th>月环比</th>
            <th>累计离职</th><th>30天离职率</th><th>人员</th>
          </tr></thead>
          <tbody>{teams.map(x=><tr key={x.name}>
            <td><button className="dimension-name-button" type="button" onClick={()=>open(`${x.name} · 累计离职人员`,historyFrom,today,'team',x.name)}>{x.name}</button></td>
            <td><strong>{x.count||0}</strong></td>
            <td><button className="number-link" onClick={()=>open(`${x.name} · 今日离职`,today,today,'team',x.name)}>{x.today_resign||0}</button></td>
            <td><button className="number-link" onClick={()=>open(`${x.name} · 昨日离职`,yesterday,yesterday,'team',x.name)}>{x.yesterday_resign||0}</button></td>
            <td><ResignCompare value={x.today_resign_delta_pct}/></td>
            <td><ResignCompare value={x.yesterday_resign_delta_pct}/></td>
            <td><button className="number-link" onClick={()=>open(`${x.name} · 近7天离职`,sevenFrom,today,'team',x.name)}>{x.resign_7d||0}</button></td>
            <td>{x.prev_resign_7d||0}</td>
            <td><ResignCompare value={x.resign_7d_delta_pct}/></td>
            <td><button className="number-link" onClick={()=>open(`${x.name} · 本月离职`,monthFrom,today,'team',x.name)}>{x.month_resign||0}</button></td>
            <td>{x.prev_month_resign||0}</td>
            <td><ResignCompare value={x.month_resign_delta_pct}/></td>
            <td><button className="number-link" onClick={()=>open(`${x.name} · 累计离职人员`,historyFrom,today,'team',x.name)}>{x.resign_total||0}</button></td>
            <td>{pctText(x.resign_rate_30||0)}</td>
            <td><button className="table-action primary-mini-action" onClick={()=>open(`${x.name} · 本月离职人员`,monthFrom,today,'team',x.name)}>查看人员</button></td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>

    <div className="resignation-ranking-grid">
      <div className="analysis-overview-card resignation-ranking-card">
        <div className="analysis-card-head"><div><h3>岗位离职排行</h3><p>本月离职 / 上月同期 / 累计</p></div></div>
        <div className="resign-ranking-list">{positions.map(x=><button type="button" key={x.name} onClick={()=>open(`${x.name} · 本月离职人员`,monthFrom,today,'position',x.name)}>
          <span>{x.name}</span><strong>{x.month_resign||0} 人</strong><em>上月同期 {x.prev_month_resign||0} · 累计 {x.resign_total||0}</em><ResignCompare value={x.month_resign_delta_pct}/>
        </button>)}</div>
      </div>
      <div className="analysis-overview-card resignation-ranking-card">
        <div className="analysis-card-head"><div><h3>员工国家离职排行</h3><p>本月离职 / 上月同期 / 累计</p></div></div>
        <div className="resign-ranking-list">{countries.map(x=><button type="button" key={x.name} onClick={()=>open(`${x.name} · 本月离职人员`,monthFrom,today,'country',x.name)}>
          <span>{x.name}</span><strong>{x.month_resign||0} 人</strong><em>上月同期 {x.prev_month_resign||0} · 累计 {x.resign_total||0}</em><ResignCompare value={x.month_resign_delta_pct}/>
        </button>)}</div>
      </div>
      <div className="analysis-overview-card resignation-ranking-card">
        <div className="analysis-card-head"><div><h3>班次离职排行</h3><p>本月离职 / 上月同期 / 累计；点击查看具体人员</p></div></div>
        <div className="resign-ranking-list">{shifts.map(x=><button type="button" key={x.name} onClick={()=>open(`${x.name} · 本月离职人员`,monthFrom,today,'shift',x.name)}>
          <span>{x.name}</span><strong>{x.month_resign||0} 人</strong><em>上月同期 {x.prev_month_resign||0} · 累计 {x.resign_total||0}</em><ResignCompare value={x.month_resign_delta_pct}/>
        </button>)}</div>
        {!shifts.length&&<div className="empty-state">暂无班次离职数据</div>}
      </div>
    </div>
  </section>
}

function TeamAnalysisSummary({analytics}){
  const rows=analytics.teams||[]
  const largest=rows[0]
  const resignTop=[...rows].sort((a,b)=>(b.resign_30d||0)-(a.resign_30d||0))[0]
  const avg=rows.length?Math.round((analytics.kpis?.active||0)/rows.length):0
  return <div className="analysis-summary-strip">
    <MetricSummary label="当前团队" value={rows.length}/>
    <MetricSummary label="最大团队" value={largest?.count||0} hint={largest?.name||'—'}/>
    <MetricSummary label="平均团队人数" value={avg}/>
    <MetricSummary label="30天离职最多" value={resignTop?.resign_30d||0} hint={resignTop?.name||'—'}/>
  </div>
}
function PositionAnalysisSummary({analytics}){
  const rows=analytics.positions||[]
  const largest=rows[0]
  const resignTop=[...rows].sort((a,b)=>(b.resign_30d||0)-(a.resign_30d||0))[0]
  return <div className="analysis-summary-strip">
    <MetricSummary label="当前岗位" value={rows.length}/>
    <MetricSummary label="最大岗位" value={largest?.count||0} hint={largest?.name||'—'}/>
    <MetricSummary label="最大岗位占比" value={largest?pctText(largest.share):'—'}/>
    <MetricSummary label="30天离职最多" value={resignTop?.resign_30d||0} hint={resignTop?.name||'—'}/>
  </div>
}
function TeamAnalysisCard({item,onPeople,onResign,onPosition}){
  return <article className="structure-analysis-card interactive-structure-card">
    <div className="structure-card-head">
      <button className="structure-title-button" type="button" onClick={onPeople}><h3>{item.name}</h3><p>{item.count} 人 · 占全部在职 {pctText(item.share)} · 查看成员 →</p></button>
      <button type="button" className="structure-rate structure-rate-button" onClick={onResign}><span>30天离职</span><strong>{item.resign_30d||0} 人</strong><em>{pctText(item.resign_rate_30||0)}</em></button>
    </div>
    <div className="overall-ratio"><div><span>团队占全体比例</span><strong>{item.count} 人 · {pctText(item.share)}</strong></div><div className="ratio-track big"><i style={{width:`${Math.min(100,item.share||0)}%`}}/></div></div>
    <MiniFlow join7={item.join_7d} resign7={item.resign_7d} join30={item.join_30d} resign30={item.resign_30d} net30={item.net_30d}/>
    <div className="internal-breakdown">
      <div className="breakdown-title"><strong>团队内部岗位比例</strong><span>{item.count} 人</span></div>
      <div className="ratio-list compact">{(item.positions||[]).map(x=><RatioBar key={x.name} {...x} onClick={()=>onPosition?.(x.name)}/>)}</div>
    </div>
  </article>
}
function PositionAnalysisCard({item,onPeople,onResign,onTeam}){
  return <article className="structure-analysis-card interactive-structure-card">
    <div className="structure-card-head">
      <button className="structure-title-button" type="button" onClick={onPeople}><h3>{item.name}</h3><p>{item.count} 人 · 占全部在职 {pctText(item.share)} · 查看人员 →</p></button>
      <button type="button" className="structure-rate structure-rate-button" onClick={onResign}><span>30天离职</span><strong>{item.resign_30d||0} 人</strong><em>{pctText(item.resign_rate_30||0)}</em></button>
    </div>
    <div className="overall-ratio"><div><span>岗位占全体比例</span><strong>{item.count} 人 · {pctText(item.share)}</strong></div><div className="ratio-track big"><i style={{width:`${Math.min(100,item.share||0)}%`}}/></div></div>
    <MiniFlow join7={item.join_7d} resign7={item.resign_7d} join30={item.join_30d} resign30={item.resign_30d} net30={item.net_30d}/>
    <div className="internal-breakdown">
      <div className="breakdown-title"><strong>该岗位在各团队的比例</strong><span>{item.count} 人</span></div>
      <div className="ratio-list compact">{(item.teams||[]).map(x=><RatioBar key={x.name} {...x} onClick={()=>onTeam?.(x.name)}/>)}</div>
    </div>
  </article>
}
function ArchiveStructureStats({data,onTenure,onPosition,onCountry}){
  const tenureRows=data?.tenure||[]
  const updated=data?.refreshed_at?formatDateTime(data.refreshed_at):'—'
  const changed=data?.latest_updated_at?formatDateTime(data.latest_updated_at):'—'
  return <section className="archive-structure-section">
    <div className="archive-structure-head">
      <div><h3>员工结构统计</h3><p>在职员工的入职时长、岗位、盘口和国家人数；首次进入、手动刷新或切回过期页面时按需读取。</p></div>
      <div className={`archive-sync-badge ${data?.error?'has-error':''}`}><i/><span title={`最近数据变更 ${changed}`}>{data?.error?'结构统计待部署':`实时已连接 · ${updated}`}</span></div>
    </div>
    <div className="archive-structure-grid">
      <ArchiveBreakdownCard title="入职时长" rows={tenureRows} loading={data?.loading} onRow={x=>onTenure?.(x.key,x.name)}/>
      <ArchiveBreakdownCard title="各岗位人数" rows={data?.positions||[]} loading={data?.loading} onRow={x=>onPosition?.(x.name)}/>
      <ArchiveBreakdownCard title="各盘口人数" rows={data?.platforms||[]} loading={data?.loading}/>
      <ArchiveBreakdownCard title="各国家人数" rows={data?.countries||[]} loading={data?.loading} onRow={x=>onCountry?.(x.name)}/>
    </div>
  </section>
}
function ArchiveBreakdownCard({title,rows,loading,onRow}){
  const total=(rows||[]).reduce((sum,x)=>sum+(Number(x.count)||0),0)
  return <section className="archive-breakdown-card">
    <div className="archive-breakdown-head"><strong>{title}</strong><span>{total} 人次</span></div>
    <div className="archive-breakdown-list">
      {loading&&!(rows||[]).length?<div className="archive-breakdown-empty">读取中...</div>:(rows||[]).map(x=>{
        const inner=<><span>{x.name}</span><strong>{x.count||0}<em>{Number.isFinite(Number(x.share))?`${Number(x.share).toFixed(1)}%`:''}</em></strong></>
        return onRow?<button type="button" key={x.key||x.name} onClick={()=>onRow(x)}>{inner}</button>:<div key={x.key||x.name}>{inner}</div>
      })}
      {!loading&&!(rows||[]).length&&<div className="archive-breakdown-empty">暂无数据</div>}
    </div>
  </section>
}

function SelectValue({value,options,onChange}){
  return <select value={value||''} onChange={e=>onChange(e.target.value)}>
    <option value="">请选择</option>
    {(options||[]).map(x=><option key={x} value={x}>{x}</option>)}
  </select>
}


function FilterCombo({value,options,onChange,placeholder,listId}){
  // V27.2: selected value 与正在输入的搜索关键字分离。
  // 这样已经选中“越南”后，可以再次打开并直接搜索“菲律宾”，不用先切回“全部”。
  const [open,setOpen]=useState(false)
  const [query,setQuery]=useState('')
  const root=useRef(null)
  const values=useMemo(()=>Array.from(new Set((options||[]).map(text).filter(Boolean))),[JSON.stringify(options||[])])
  const q=text(query).toLowerCase()
  const filtered=useMemo(()=>values.filter(x=>!q||x.toLowerCase().includes(q)).slice(0,80),[values,q])
  const closeMenu=()=>{setOpen(false);setQuery('')}
  const openMenu=()=>{setQuery('');setOpen(true)}
  useEffect(()=>{
    const close=e=>{ if(root.current&&!root.current.contains(e.target)){setOpen(false);setQuery('')} }
    document.addEventListener('mousedown',close)
    return()=>document.removeEventListener('mousedown',close)
  },[])
  return <div className={`smart-filter-combo ${open?'is-open':''}`} ref={root} data-combo={listId}>
    <input
      value={open?query:(value||'')}
      onChange={e=>{setQuery(e.target.value);setOpen(true)}}
      onFocus={openMenu}
      onKeyDown={e=>{
        if(e.key==='Escape') closeMenu()
        if(e.key==='Enter'&&filtered.length===1){e.preventDefault();onChange(filtered[0]);closeMenu()}
      }}
      placeholder={placeholder||'全部 / 输入搜索'}
      autoComplete="off"
    />
    <button type="button" className="smart-combo-toggle" onMouseDown={e=>e.preventDefault()} onClick={()=>{if(open)closeMenu();else openMenu()}} aria-label="展开选项">⌄</button>
    {open&&<div className="smart-combo-menu">
      <button type="button" className={!value?'active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>{onChange('');closeMenu()}}>{placeholder?.split('/')[0]?.trim()||'全部'}</button>
      {filtered.map(x=><button type="button" key={x} className={text(value)===x?'active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>{onChange(x);closeMenu()}}>{x}</button>)}
      {!filtered.length&&<div className="smart-combo-empty">没有匹配项，请换关键字搜索</div>}
    </div>}
  </div>
}


function WriteCombo({value,options,onChange,placeholder,listId}){
  const [open,setOpen]=useState(false)
  const [query,setQuery]=useState('')
  const root=useRef(null)

  const values=useMemo(()=>Array.from(new Map(
    (options||[])
      .map(text)
      .filter(Boolean)
      .map(x=>[x.replace(/\s+/g,'').toUpperCase(),x])
  ).values()),[JSON.stringify(options||[])])

  const q=text(query).toLowerCase()
  const filtered=useMemo(()=>values.filter(x=>!q||x.toLowerCase().includes(q)).slice(0,100),[values,q])

  const closeMenu=()=>{setOpen(false);setQuery('')}
  const openMenu=()=>{setQuery('');setOpen(true)}

  useEffect(()=>{
    const close=e=>{ if(root.current&&!root.current.contains(e.target)) closeMenu() }
    document.addEventListener('mousedown',close)
    return()=>document.removeEventListener('mousedown',close)
  },[])

  return <div className={`smart-filter-combo write-combo ${open?'is-open':''}`} ref={root} data-combo={listId}>
    <input
      value={open?query:(value||'')}
      onChange={e=>{setQuery(e.target.value);setOpen(true)}}
      onFocus={openMenu}
      onKeyDown={e=>{
        if(e.key==='Escape') closeMenu()
        if(e.key==='Enter'){
          e.preventDefault()
          const manual=text(query)
          if(manual) onChange(manual)
          closeMenu()
        }
      }}
      placeholder={placeholder||'选择 / 输入搜索'}
      autoComplete="off"
    />
    <button type="button" className="smart-combo-toggle" onMouseDown={e=>e.preventDefault()} onClick={()=>{if(open)closeMenu();else openMenu()}} aria-label="展开选项">⌄</button>
    {open&&<div className="smart-combo-menu">
      {filtered.map(x=><button type="button" key={x} className={text(value)===x?'active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>{onChange(x);closeMenu()}}>{x}</button>)}
      {text(query)&&!values.some(x=>x.toLowerCase()===text(query).toLowerCase())&&
        <button type="button" className="write-combo-create" onMouseDown={e=>e.preventDefault()} onClick={()=>{onChange(text(query));closeMenu()}}>＋ 使用新值「{text(query)}」</button>}
      {!filtered.length&&!text(query)&&<div className="smart-combo-empty">暂无可选项</div>}
    </div>}
  </div>
}

function FormSection({title,subtitle,children}){ return <section className="employee-form-section"><div className="employee-form-section-head"><h3>{title}</h3>{subtitle&&<p>{subtitle}</p>}</div><div className="employee-form-grid">{children}</div></section> }
function Field({label,children,wide}){ return <label className={wide?'form-field form-wide':'form-field'}><span>{label}</span>{children}</label> }
function InfoPanel({title,rows,children}){ return <section className="detail-panel"><div className="detail-panel-head"><h3>{title}</h3></div><div className="info-rows">{rows.map(([k,v])=><InfoRow key={k} label={k} value={v}/>)}</div>{children}</section> }
function InfoRow({label,value,mono}){ return <div className="info-row"><span>{label}</span><strong className={mono?'mono-value':''}>{text(value)||'—'}</strong></div> }
function Summary({label,value}){ return <div className="summary-card"><span>{label}</span><strong>{value??'—'}</strong></div> }
function money(v,currency){ if(v===null||v===undefined||v==='') return '—'; const n=Number(v); const value=Number.isInteger(n)?String(n):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,''); return `${value} ${currency||''}`.trim() }
