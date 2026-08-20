import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Pagination } from '../components/DataPageControls'

const text = v => String(v ?? '').trim()
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
const analysisViews=['总览','团队分析','岗位分析','国家分析','班次分析','离职分析']
const blankHistoryFilters=()=>({employee_no:'',full_name:'',team:'',position:'',country:'',reason:'',date_from:'',date_to:''})
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
function isPendingHireForCancel(hireDate,status){
  if(!['active','resigned'].includes(text(status))) return false
  const hire=parseIsoDateOnly(hireDate)
  if(!hire) return false
  const now=new Date()
  const todayUtc=new Date(Date.UTC(now.getFullYear(),now.getMonth(),now.getDate(),12))
  return hire.getTime()>=todayUtc.getTime()
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

function bundleToForm(detail){
  const e=detail?.employee||{}
  const c=detail?.contact||{}
  const p=detail?.payment||{}
  const comp=detail?.compensation||{}
  return {
    employee:{
      employee_no:e.employee_no||'',full_name:e.full_name||'',country:e.country||'',nationality:e.nationality||'',
      employment_type:e.employment_type||'',team_id:e.team_id||'',position_id:e.position_id||'',position_name:e.positions?.name||'',
      market_country:e.market_country||'',market_position:e.market_position||'',shift_name:e.shift_name||'',
      group_name:e.group_name||'',leader_name:e.leader_name||'',trainer_name:e.trainer_name||'',
      platform_scope:e.platform_scope||'',work_content:e.work_content||'',work_tg:e.work_tg||'',
      backend_accounts:e.backend_accounts||'',hire_date:text(e.hire_date).slice(0,10),
      last_location:e.last_location||'',return_date:text(e.return_date).slice(0,10),home_date:text(e.home_date).slice(0,10),
    },
    contact:{
      work_email:c.work_email||'',telegram_username:c.telegram_username||'',zoom_email:c.zoom_email||'',
      facebook:c.facebook||'',whatsapp_phone:c.whatsapp_phone||'',
    },
    compensation:{
      base_salary:comp.base_salary??'',daily_rate:comp.daily_rate??'',performance_default:comp.performance_default??'',meal_allowance:comp.meal_allowance??'',
      currency:comp.currency||defaultCurrency(e.employment_type),note:comp.note||'',
      salary_basis:isPhpHome(e.employment_type)?phpSalaryBasis(comp):'',
    },
    payment:{
      mode:p.mode||defaultPaymentMode(e.employment_type),
      transfer_using:p.transfer_using||'',
      bank_wallet_account:p.bank_wallet_account||'',
      account_name:p.account_name||'',
      usdt_address:p.usdt_address||'',
      contact_phone:p.contact_phone||'',
      whatsapp_number:p.whatsapp_number||'',
      employee_address:p.employee_address||'',
    },
  }
}

export default function AdminEmployeesPage(){
  const [sp,setSp]=useSearchParams()
  const tabs=['员工档案','人员分析','团队管理','岗位管理','离职记录','操作日志']
  const initialTab=sp.get('tab')==='入离职记录'?'离职记录':sp.get('tab')
  const [tab,setTabState]=useState(tabs.includes(initialTab)?initialTab:'员工档案')

  const [meta,setMeta]=useState({
    teams:[],positions:[],position_options:[],total:0,active:0,no_team:0,official_id_pending:0,
    options:{countries:[],nationalities:[],employment_types:[],shifts:[],groups:[],leaders:[],trainers:[],market_countries:[],market_positions:[],platforms:[]},
    platform_map:[],
    schedule:{teams:[],positions:[],shifts:[],leaders:[],trainers:[],position_stats:[],team_stats:[]}
  })
  const [rows,setRows]=useState([])
  const [total,setTotal]=useState(0)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSizeState]=useState(()=>Number(localStorage.getItem('wfh_employee_page_size'))||20)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [refreshing,setRefreshing]=useState(false)
  const [liveTick,setLiveTick]=useState(0)
  const [generated,setGenerated]=useState(null)
  const [showFilters,setShowFilters]=useState(true)
  const [filters,setFilters]=useState({
    employee_no:'',full_name:'',work_tg:'',backend_account:'',risk_level:'',team:'',position:'',country:'',status:'active',
    employment_type:'',shift_name:'',leader:'',hire_from:'',hire_to:'',
  })

  const [selected,setSelected]=useState(null)
  const [detailLoading,setDetailLoading]=useState(false)
  const [employeeModal,setEmployeeModal]=useState(null) // {mode,employee_id,form}
  const [resignModal,setResignModal]=useState(null)
  const [editResignModal,setEditResignModal]=useState(null)
  const [restoreModal,setRestoreModal]=useState(null)
  const [cancelHireModal,setCancelHireModal]=useState(null)

  const [analytics,setAnalytics]=useState({
    loading:true,
    kpis:{},
    trend:[],
    teams:[],
    positions:[],
    countries:[],
    shifts:[],
  })
  const [peopleAnalytics,setPeopleAnalytics]=useState({
    loading:true,kpis:{},trend:[],teams:[],positions:[],countries:[],shifts:[],
  })
  const [archiveStats,setArchiveStats]=useState({loading:true,error:'',as_of:'',active:0,total:0,latest_updated_at:'',refreshed_at:'',tenure:[],positions:[],platforms:[],countries:[]})
  const [analysisFilters,setAnalysisFilters]=useState({employee_no:'',full_name:'',work_tg:'',team:'',position:'',country:'',shift_name:'',date_from:'',date_to:''})
  const [analysisDetail,setAnalysisDetail]=useState(null)
  const [analysisDetailLoading,setAnalysisDetailLoading]=useState(false)
  const [analysisView,setAnalysisView]=useState('总览')
  const [resignationAnalytics,setResignationAnalytics]=useState({loading:true,kpis:{},trend:[],teams:[],positions:[],countries:[],shifts:[]})
  const [resignationAnalyticsFilters,setResignationAnalyticsFilters]=useState({employee_no:'',full_name:'',team:'',position:'',country:'',reason:'',date_from:'',date_to:''})

  const [history,setHistory]=useState([])
  const [historyPermissions,setHistoryPermissions]=useState({can_edit:false,can_restore:false})
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

  const [teamKeyword,setTeamKeyword]=useState('')
  const [teamPageSize,setTeamPageSize]=useState(20)
  const [teamPage,setTeamPage]=useState(1)

  const [positionKeyword,setPositionKeyword]=useState('')
  const [positionPageSize,setPositionPageSize]=useState(20)
  const [positionPage,setPositionPage]=useState(1)

  const first=useRef(true)

  const invoke=async body=>{
    const {data,error}=await supabase.functions.invoke('admin-employees',{body})
    if(error||data?.error) throw new Error(data?.error||error?.message||'操作失败')
    return data
  }

  const writeEmployee=async body=>{
    const {data,error}=await supabase.functions.invoke('admin-employee-write',{body})
    if(error||data?.error) throw new Error(data?.error||error?.message||'员工资料保存失败')
    return data
  }

  const loadOperatorMap=async employeeIds=>{
    const ids=(employeeIds||[]).map(text).filter(Boolean)
    if(!ids.length) return new Map()
    const {data,error}=await supabase.functions.invoke('admin-employee-operators',{body:{employee_ids:ids}})
    if(error||data?.error) return new Map()
    return new Map((data?.rows||[]).map(x=>[text(x.employee_id),text(x.operator_account)]))
  }

  const checkEmployeeIdentity=async body=>{
    const {data,error}=await supabase.functions.invoke('admin-employee-write',{body:{action:'check_identity',...body}})
    if(error||data?.error) throw new Error(data?.error||error?.message||'员工ID / 姓名检查失败')
    return data
  }

  const loadMasterPositionOptions=async()=>{
    const {data,error}=await supabase.functions.invoke('admin-employee-write',{body:{action:'get_master_position_options'}})
    if(error||data?.error) return []
    return Array.isArray(data?.rows)?data.rows:[]
  }

  const loadMeta=async()=>{
    try{
      const [baseMeta,positionOptions]=await Promise.all([
        invoke({action:'meta'}),
        loadMasterPositionOptions(),
      ])
      setMeta({...baseMeta,position_options:positionOptions})
    }catch(e){ setError(e.message) }
  }

  const loadArchiveStats=async(silent=false)=>{
    if(!silent) setArchiveStats(v=>({...v,loading:true}))
    try{
      const d=new Date()
      const today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const {data,error}=await supabase.functions.invoke('admin-employee-stats',{body:{action:'overview',today}})
      if(error||data?.error) throw new Error(data?.error||error?.message||'员工结构统计读取失败')
      setArchiveStats({...data,loading:false,error:'',refreshed_at:new Date().toISOString()})
    }catch(e){
      setArchiveStats(v=>({...v,loading:false,error:e.message||'员工结构统计读取失败'}))
    }
  }

  const loadAnalytics=async()=>{
    setAnalytics(v=>({...v,loading:true}))
    try{
      const d=new Date()
      const today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const data=await invoke({action:'analytics',today})
      setAnalytics({...data,loading:false})
    }catch(e){
      setAnalytics(v=>({...v,loading:false}))
      setError(e.message)
    }
  }

  const loadPeopleAnalytics=async(nextFilters=analysisFilters)=>{
    setPeopleAnalytics(v=>({...v,loading:true}))
    try{
      const d=new Date()
      const today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const data=await invoke({action:'analytics',today,filters:nextFilters})
      setPeopleAnalytics({...data,loading:false})
    }catch(e){
      setPeopleAnalytics(v=>({...v,loading:false}))
      setError(e.message)
    }
  }

  const loadResignationAnalytics=async(nextFilters=resignationAnalyticsFilters)=>{
    setResignationAnalytics(v=>({...v,loading:true}))
    try{
      const d=new Date()
      const today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const data=await invoke({action:'analytics',today,filters:nextFilters})
      setResignationAnalytics({...data,loading:false})
    }catch(e){
      setResignationAnalytics(v=>({...v,loading:false}))
      setError(e.message)
    }
  }

  const fetchEmployeeListData=async(nextPage,nextSize,nextFilters=filters)=>{
    if(text(nextFilters?.risk_level)){
      const {data,error}=await supabase.functions.invoke('admin-employee-risk-list',{body:{action:'list',page:nextPage,page_size:nextSize,filters:nextFilters,risk_level:nextFilters.risk_level}})
      if(error||data?.error) throw new Error(data?.error||error?.message||'等级筛选读取失败')
      return data
    }
    return await invoke({action:'list',page:nextPage,page_size:nextSize,filters:nextFilters})
  }

  const loadList=async(nextPage=page,nextSize=pageSize,{silent=false}={})=>{
    if(!silent){ setLoading(true); setError('') }
    try{
      const data=await fetchEmployeeListData(nextPage,nextSize,filters)
      const visibleRows=(data.rows||[]).filter(r=>text(r.source_type)!=='google_deleted')
      const operatorMap=await loadOperatorMap(visibleRows.map(r=>r.id))
      setRows(visibleRows.map(r=>({...r,operator_account:operatorMap.get(text(r.id))||text(r.operator_account)})))
      setTotal(Math.max(0,(data.total||0)-((data.rows||[]).length-visibleRows.length)))
    }catch(e){ if(!silent) setError(e.message) }
    finally{ if(!silent) setLoading(false) }
  }

  const loadHistory=async(nextPage=historyPage,nextSize=historyPageSize,nextFilters=historyFilters,{silent=false}={})=>{
    if(!silent){ setHistoryLoading(true); setError('') }
    try{
      const data=await invoke({action:'history_list',page:nextPage,page_size:nextSize,filters:nextFilters})
      const rawRows=data.rows||[]
      const productionRows=rawRows.filter(r=>!isTestEmployeeNo(r.employee_no))
      const cleaned=dedupeAnalysisRows(productionRows)
      setHistory(cleaned)
      setHistoryPermissions(data.permissions||{can_edit:false,can_restore:false})
      const hiddenTest=rawRows.length-productionRows.length
      setHistoryTotal(Math.max(0,(data.total||0)-hiddenTest-(productionRows.length-cleaned.length)))
    }catch(e){ if(!silent) setError(e.message) }
    finally{ if(!silent) setHistoryLoading(false) }
  }

  const loadAudit=async(nextPage=auditPage,nextSize=auditPageSize,nextFilters=auditFilters,{silent=false}={})=>{
    if(!silent){ setAuditLoading(true); setError('') }
    try{
      const data=await writeEmployee({action:'audit_list',page:nextPage,page_size:nextSize,filters:nextFilters})
      setAuditRows(data.rows||[])
      setAuditTotal(data.total||0)
    }catch(e){ if(!silent) setError(e.message) }
    finally{ if(!silent) setAuditLoading(false) }
  }

  const refreshEmployeeData=async({silent=false}={})=>{
    if(!silent) setRefreshing(true)
    try{
      const jobs=[loadMeta(),loadAnalytics(),loadArchiveStats(true)]
      if(tab==='员工档案') jobs.push(loadList(page,pageSize,{silent}))
      if(tab==='人员分析') jobs.push(loadPeopleAnalytics(analysisFilters),loadResignationAnalytics(resignationAnalyticsFilters))
      if(tab==='离职记录') jobs.push(loadHistory(historyPage,historyPageSize,historyFilters,{silent}))
      if(tab==='操作日志') jobs.push(loadAudit(auditPage,auditPageSize,auditFilters,{silent}))
      if(selected?.employee?.id){
        jobs.push(invoke({action:'detail',employee_id:selected.employee.id}).then(d=>setSelected(prev=>({...d,resignation_reason:text(prev?.resignation_reason||d?.resignation_reason)}))).catch(()=>{}))
      }
      await Promise.all(jobs)
    }finally{
      if(!silent) setRefreshing(false)
    }
  }

  useEffect(()=>{
    let timer=null
    const signal=()=>{
      clearTimeout(timer)
      timer=setTimeout(()=>setLiveTick(v=>v+1),1500)
    }
    const channel=supabase
      .channel('admin-employees-live-v284')
      .on('postgres_changes',{event:'*',schema:'public',table:'employees'},signal)
      .on('postgres_changes',{event:'*',schema:'public',table:'employee_lifecycle_events'},signal)
      .on('postgres_changes',{event:'*',schema:'public',table:'employee_audit_logs'},signal)
      .subscribe()
    return()=>{
      clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  },[])

  useEffect(()=>{
    if(!liveTick) return
    refreshEmployeeData({silent:true})
  },[liveTick])

  useEffect(()=>{ loadMeta(); loadAnalytics(); loadArchiveStats(); const t=setInterval(()=>{ if(!document.hidden) loadArchiveStats(true) },60000); return()=>clearInterval(t) },[])
  useEffect(()=>{
    if(tab!=='员工档案') return
    const t=setInterval(async()=>{
      if(document.hidden) return
      try{
        const d=new Date()
        const today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
        const [metaData,listData,analyticsData]=await Promise.all([
          invoke({action:'meta'}),
          fetchEmployeeListData(page,pageSize,filters),
          invoke({action:'analytics',today}),
        ])
        setMeta(metaData)
        setRows(listData.rows||[]); setTotal(listData.total||0)
        setAnalytics({...analyticsData,loading:false})
      }catch{}
    },60000)
    return()=>clearInterval(t)
  },[tab,page,pageSize,JSON.stringify(filters)])
  useEffect(()=>{
    if(first.current){ first.current=false; loadList(1,pageSize); return }
    const t=setTimeout(()=>{ setPage(1); loadList(1,pageSize) },260)
    return()=>clearTimeout(t)
  },[JSON.stringify(filters)])

  useEffect(()=>{
    const raw=sp.get('tab')
    const t=raw==='入离职记录'?'离职记录':raw
    if(tabs.includes(t)) setTabState(t)
  },[sp])

  useEffect(()=>{
    if(tab!=='离职记录') return
    const t=setTimeout(()=>{ setHistoryPage(1); loadHistory(1,historyPageSize,historyFilters) },80)
    return()=>clearTimeout(t)
  },[tab])

  useEffect(()=>{
    if(tab!=='操作日志') return
    const t=setTimeout(()=>{ setAuditPage(1); loadAudit(1,auditPageSize,auditFilters) },80)
    return()=>clearTimeout(t)
  },[tab])

  useEffect(()=>{
    if(tab!=='人员分析') return
    const t=setTimeout(()=>loadPeopleAnalytics(analysisFilters),220)
    return()=>clearTimeout(t)
  },[tab,JSON.stringify(analysisFilters)])

  useEffect(()=>{
    if(tab!=='人员分析') return
    const t=setTimeout(()=>loadResignationAnalytics(resignationAnalyticsFilters),260)
    return()=>clearTimeout(t)
  },[tab,JSON.stringify(resignationAnalyticsFilters)])

  useEffect(()=>{
    const handler=e=>{
      const d=e.detail||{}
      setRestoreModal({employee_id:d.employee_id,employee_no:d.employee_no,full_name:d.full_name,restore_portal:true})
    }
    window.addEventListener('wfh-restore-employee',handler)
    return()=>window.removeEventListener('wfh-restore-employee',handler)
  },[])

  const setTab=v=>{
    setTabState(v)
    setSp(v==='员工档案'?{}:{tab:v})
  }

  const setPageSize=n=>{
    localStorage.setItem('wfh_employee_page_size',String(n))
    setPageSizeState(n); setPage(1); loadList(1,n)
  }
  const setHistoryPageSize=n=>{
    localStorage.setItem('wfh_history_page_size',String(n))
    setHistoryPageSizeState(n); setHistoryPage(1); loadHistory(1,n,historyFilters)
  }
  const changeAuditPageSize=n=>{
    setAuditPageSize(n); setAuditPage(1); loadAudit(1,n,auditFilters)
  }
  const applyHistoryFilters=()=>{
    const next={...historyDraftFilters}
    setHistoryFilters(next)
    setHistoryPage(1)
    loadHistory(1,historyPageSize,next)
  }
  const resetHistoryFilters=()=>{
    const next=blankHistoryFilters()
    setHistoryDraftFilters(next)
    setHistoryFilters(next)
    setHistoryPage(1)
    loadHistory(1,historyPageSize,next)
  }

  const openDetail=async row=>{
    setSelected({employee:row,missing_fields:row.missing_fields||[]})
    setDetailLoading(true)
    try{
      const detail=await invoke({action:'detail',employee_id:row.id})
      if(detail?.employee?.status==='resigned'&&!text(detail.resignation_reason)&&text(detail.employee.employee_no)){
        try{
          const h=await invoke({action:'history_list',page:1,page_size:20,filters:{employee_no:text(detail.employee.employee_no)}})
          const match=(h.rows||[]).find(x=>text(x.employee_no).toUpperCase()===text(detail.employee.employee_no).toUpperCase()&&text(x.reason))
          if(match) detail.resignation_reason=text(match.reason)
        }catch(_){}
      }
      setSelected(detail)
    }
    catch(e){ setError(e.message); setSelected(null) }
    finally{ setDetailLoading(false) }
  }

  const openCreate=()=>{
    const f=emptyForm()
    setEmployeeModal({mode:'create',employee_id:null,original_employee_no:'',original_full_name:'',form:f})
  }

  const openEdit=async()=>{
    if(!selected?.employee?.id) return
    const detail=selected
    setEmployeeModal({
      mode:'edit',
      employee_id:detail.employee.id,
      original_employee_no:text(detail.employee.employee_no),
      original_full_name:text(detail.employee.full_name),
      form:bundleToForm(detail),
    })
  }

  const saveEmployee=async()=>{
    if(!employeeModal) return
    const {mode,employee_id,form,original_employee_no,original_full_name}=employeeModal
    const employeeNo=text(form.employee.employee_no).toUpperCase()
    if(!employeeNo||!text(form.employee.full_name)){
      return setError('员工ID和姓名必须填写')
    }
    if(mode==='create'&&(employeeNo==='SYSTEM'||employeeNo==='ADMIN')){
      return setError('SYSTEM / ADMIN 是系统保留ID，不能用于员工。TEST 开头的ID可用于正式表流程测试，但不会计入统计KPI。')
    }
    try{
      const payload={
        action:mode==='create'?'create_employee_full':'update_employee_full',
        employee_id,
        previous_employee_no:mode==='edit'?text(original_employee_no||selected?.employee?.employee_no):'',
        previous_full_name:mode==='edit'?text(original_full_name||selected?.employee?.full_name):'',
        employee:{...form.employee,employee_no:employeeNo},
        contact:form.contact,
        compensation:form.compensation,
        payment:form.payment,
      }
      const data=await writeEmployee(payload)
      if(mode==='create'&&!sheetSyncSucceeded(data?.sync)){
        let rollbackOk=false
        try{
          await invoke({action:'cancel_new_hire',employee_id:data?.employee_id,confirm_employee_no:employeeNo})
          rollbackOk=true
        }catch(_){ rollbackOk=false }
        throw new Error(`新增失败：正式 Google Sheet 没有写入。${rollbackOk?'Supabase 新增已自动撤销，不会留下半条员工。':'Supabase 自动撤销失败，请立即检查。'} 原因：${sheetSyncMessage(data?.sync)}`)
      }
      if(mode==='edit'&&!sheetSyncSucceeded(data?.sync)){
        throw new Error(`Supabase 已保存，但正式 Google Sheet 同步失败：${sheetSyncMessage(data?.sync)}。请重新保存一次，直到两边同时成功。`)
      }
      setEmployeeModal(null)
      if(mode==='create'){
        // 新增成功只刷新，不再把新员工 ID 自动塞进搜索框。
        setPage(1)
        const [listData]=await Promise.all([
          fetchEmployeeListData(1,pageSize,filters),
          loadMeta(),loadAnalytics(),loadArchiveStats(),
        ])
        const visibleRows=(listData.rows||[]).filter(r=>text(r.source_type)!=='google_deleted')
        setRows(visibleRows)
        setTotal(Math.max(0,(listData.total||0)-((listData.rows||[]).length-visibleRows.length)))
        if(data?.employee_id) setSelected(await invoke({action:'detail',employee_id:data.employee_id}))
      }else{
        await Promise.all([loadMeta(),loadAnalytics(),loadArchiveStats(),loadList(page,pageSize)])
        if(employee_id) setSelected(await invoke({action:'detail',employee_id}))
      }
    }catch(e){ setError(e.message) }
  }

  const openHistoryDetail=async row=>{
    setDetailLoading(true)
    try{
      let employeeId=text(row?.employee_id)
      // Some lifecycle rows are historical and can miss employee_id. Resolve by exact employee number.
      if(!employeeId&&text(row?.employee_no)){
        const found=await invoke({action:'list',page:1,page_size:5,filters:{employee_no:text(row.employee_no),status:''}})
        const exact=(found.rows||[]).find(x=>text(x.employee_no).toUpperCase()===text(row.employee_no).toUpperCase())
        employeeId=text(exact?.id||exact?.employee_id)
      }
      if(!employeeId) throw new Error('找不到对应员工档案')
      setSelected({employee:{id:employeeId,employee_no:row?.employee_no,full_name:row?.full_name,status:row?.event_type==='resign'?'resigned':'active'}})
      try{
        const detail=await invoke({action:'detail',employee_id:employeeId})
        setSelected({...detail,resignation_reason:text(row?.reason)})
      }catch(firstError){
        // Lifecycle data can carry a stale id after test cleanup; retry once by employee number.
        if(!text(row?.employee_no)) throw firstError
        const found=await invoke({action:'list',page:1,page_size:5,filters:{employee_no:text(row.employee_no),status:''}})
        const exact=(found.rows||[]).find(x=>text(x.employee_no).toUpperCase()===text(row.employee_no).toUpperCase())
        const fallbackId=text(exact?.id||exact?.employee_id)
        if(!fallbackId||fallbackId===employeeId) throw firstError
        const detail=await invoke({action:'detail',employee_id:fallbackId})
        setSelected({...detail,resignation_reason:text(row?.reason)})
      }
    }catch(e){ setError(e.message); setSelected(null) }
    finally{ setDetailLoading(false) }
  }

  const clearEmployeeFilters=()=>({
    employee_no:'',full_name:'',work_tg:'',backend_account:'',risk_level:'',team:'',position:'',country:'',status:'active',
    employment_type:'',shift_name:'',leader:'',hire_from:'',hire_to:'',
  })

  const drillToEmployees=patch=>{
    setFilters({...clearEmployeeFilters(),...patch})
    setPage(1)
    setTab('员工档案')
  }

  const openAnalysisDetail=async({title,event_type='all',dimension='',value='',date_from='',date_to='',filters:detailFilters})=>{
    const sourceFilters=detailFilters||analysisFilters
    setAnalysisDetail({title,event_type,dimension,value,date_from,date_to,rows:[],total:0})
    setAnalysisDetailLoading(true)
    try{
      const data=await invoke({action:'analytics_event_details',event_type,dimension,value,date_from,date_to,limit:2000,filters:sourceFilters})
      const productionRows=(data.rows||[]).filter(r=>!isTestEmployeeNo(r.employee_no))
      const uniqueRows=dedupeAnalysisRows(productionRows)
      const employeeNos=Array.from(new Set(uniqueRows.map(r=>text(r.employee_no)).filter(Boolean)))
      let dateRows=[]
      if(employeeNos.length){
        const {data:dateData,error:dateError}=await supabase.functions.invoke('admin-employee-dates',{body:{employee_nos:employeeNos}})
        if(error||dateData?.error) throw new Error(dateData?.error||dateError?.message||'员工入离职日期读取失败')
        dateRows=dateData?.rows||[]
      }
      const dateMap=new Map(dateRows.map(x=>[text(x.employee_no).toUpperCase(),x]))
      const enrichedRows=uniqueRows.map(r=>{
        const d=dateMap.get(text(r.employee_no).toUpperCase())||{}
        return {...r,hire_date:text(d.hire_date).slice(0,10),resign_date:r.event_type==='resign'?(text(r.date).slice(0,10)||text(d.resign_date).slice(0,10)):text(d.resign_date).slice(0,10)}
      })
      setAnalysisDetail(v=>({...v,...data,rows:enrichedRows,total:enrichedRows.length,title}))
    }catch(e){ setError(e.message); setAnalysisDetail(null) }
    finally{ setAnalysisDetailLoading(false) }
  }

  const openArchiveTenureDetail=async(bucket,label)=>{
    setAnalysisDetail({title:`${label} · 在职员工`,event_type:'active',dimension:'',value:'',date_from:'',date_to:'',rows:[],total:0})
    setAnalysisDetailLoading(true)
    try{
      const d=new Date()
      const today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const {data,error}=await supabase.functions.invoke('admin-employee-stats',{body:{action:'tenure_details',bucket,today,include_test:true}})
      if(error||data?.error) throw new Error(data?.error||error?.message||'入职时长人员读取失败')
      const uniqueRows=dedupeAnalysisRows(data.rows||[])
      setAnalysisDetail(v=>({...v,...data,rows:uniqueRows,total:uniqueRows.length,title:`${label} · 在职员工`}))
    }catch(e){ setError(e.message); setAnalysisDetail(null) }
    finally{ setAnalysisDetailLoading(false) }
  }

  const submitResignEdit=async()=>{
    if(!editResignModal?.event_id) return
    if(!editResignModal.resign_date||!text(editResignModal.reason)){
      return setError('离职日期和离职原因必须填写')
    }
    try{
      const data=await invoke({
        action:'update_resignation',
        event_id:editResignModal.event_id,
        employee_id:editResignModal.employee_id,
        resign_date:editResignModal.resign_date,
        reason:editResignModal.reason,
      })
      setEditResignModal(null)
      await Promise.all([loadMeta(),loadAnalytics(),loadArchiveStats(),loadList(page,pageSize),loadHistory(historyPage,historyPageSize)])
      if(!sheetSyncSucceeded(data?.sync)) setError(`离职记录已保存到 Supabase，但正式 Google Sheet 同步失败：${sheetSyncMessage(data?.sync)}`)
    }catch(e){ setError(e.message) }
  }

  const submitResign=async()=>{
    if(!resignModal?.employee_id) return
    if(!resignModal.resign_date||!text(resignModal.reason)){
      return setError('离职日期和离职原因必须填写')
    }
    try{
      const resignedEmployeeId=resignModal.employee_id
      const data=await invoke({action:'resign_employee',...resignModal})
      // 先从当前在职列表立即移除，再用后端刷新做最终校验，不需要用户 F5。
      setRows(prev=>prev.filter(r=>text(r.id)!==text(resignedEmployeeId)))
      setTotal(prev=>Math.max(0,prev-1))
      setResignModal(null); setSelected(null)
      setHistoryPage(1)
      setTab('离职记录')
      await Promise.all([loadMeta(),loadAnalytics(),loadArchiveStats(),loadList(1,pageSize),loadHistory(1,historyPageSize,historyFilters)])
      if(!sheetSyncSucceeded(data?.sync)) setError(`离职已保存到 Supabase，但正式 Google Sheet 同步失败：${sheetSyncMessage(data?.sync)}`)
    }catch(e){ setError(e.message) }
  }

  const submitRestore=async()=>{
    if(!restoreModal?.employee_id) return
    try{
      const data=await invoke({
        action:'undo_resignation',
        employee_id:restoreModal.employee_id,
        restore_portal:restoreModal.restore_portal!==false,
      })
      setRestoreModal(null)
      setSelected(null)
      await Promise.all([loadMeta(),loadAnalytics(),loadArchiveStats(),loadList(1,pageSize),loadHistory(1,historyPageSize,historyFilters)])
      if(!sheetSyncSucceeded(data?.sync)) setError(`已恢复 Supabase 在职状态，但正式 Google Sheet 同步失败：${sheetSyncMessage(data?.sync)}`)
    }catch(e){ setError(e.message) }
  }

  const submitCancelHire=async()=>{
    if(!cancelHireModal?.employee_id) return
    if(text(cancelHireModal.confirm_text)!==text(cancelHireModal.employee_no)){
      return setError('请输入完整员工ID确认撤销入职')
    }
    try{
      const data=await writeEmployee({
        action:'cancel_new_hire_any_state',
        employee_id:cancelHireModal.employee_id,
        confirm_employee_no:cancelHireModal.confirm_text,
      })
      setCancelHireModal(null)
      setSelected(null)
      await Promise.all([loadMeta(),loadAnalytics(),loadArchiveStats(),loadList(1,pageSize),loadHistory(1,historyPageSize,historyFilters),loadAudit(1,auditPageSize,auditFilters,{silent:true})])
      if(data?.sheet_warning) setError(data.sheet_warning)
    }catch(e){ setError(e.message) }
  }

  const generateCode=async employeeNo=>{
    setGenerated(null); setError('')
    const {data,error}=await supabase.rpc('generate_employee_activation_code',{p_employee_no:employeeNo,p_valid_hours:72})
    if(error) return setError(error.message)
    setGenerated(data?.[0]||null)
  }

  const pages=Math.max(1,Math.ceil(total/pageSize))
  const historyPages=Math.max(1,Math.ceil(historyTotal/historyPageSize))
  const auditPages=Math.max(1,Math.ceil(auditTotal/auditPageSize))
  const clear=()=>setFilters(clearEmployeeFilters())

  const filteredTeams=useMemo(()=>{
    const q=teamKeyword.trim()
    return (analytics.teams||[]).filter(t=>!q||text(t.name).toLowerCase().includes(q.toLowerCase()))
  },[analytics.teams,teamKeyword])
  const teamPages=Math.max(1,Math.ceil(filteredTeams.length/teamPageSize))
  const teamSlice=filteredTeams.slice((teamPage-1)*teamPageSize,teamPage*teamPageSize)

  const filteredPositions=useMemo(()=>{
    const q=positionKeyword.trim()
    return (analytics.positions||[]).filter(p=>!q||text(p.name).toLowerCase().includes(q.toLowerCase()))
  },[analytics.positions,positionKeyword])
  const positionPages=Math.max(1,Math.ceil(filteredPositions.length/positionPageSize))
  const positionSlice=filteredPositions.slice((positionPage-1)*positionPageSize,positionPage*positionPageSize)

  return <div className="content-page employee-page pro-employee-page">
    <div className="module-title-row">
      <div>
        <div className="module-kicker">PEOPLE & ORGANIZATION</div>
        <h1>员工管理</h1>
      </div>
      <div className="employee-title-actions">
        <button className="secondary-action employee-refresh-action" onClick={()=>refreshEmployeeData()} disabled={refreshing}>{refreshing?'刷新中…':'↻ 刷新数据'}</button>
        {tab==='员工档案'&&<button className="primary-action" onClick={openCreate}>+ 新增员工</button>}
      </div>
    </div>

    <div className="module-tabs">
      {tabs.map(x=><button key={x} className={tab===x?'active':''} onClick={()=>setTab(x)}>{x}</button>)}
    </div>

    {error&&<div className="page-error employee-notice">{error}<button onClick={()=>setError('')}>×</button></div>}
    {tab==='员工档案'&&<>
      <div className="archive-compact-head">
        <div><h2>员工档案</h2><span>当前在职 {meta.active||0} · 全部档案 {meta.total||0}</span></div>
      </div>
      <div className="filter-card archive-filter-card v24-filter-card">
        <div className="field-search-grid employee-core-search-grid">
          <label className="pro-filter-field" data-native-risk-filter="1"><span>等级</span><select value={filters.risk_level||''} onChange={e=>setFilters({...filters,risk_level:e.target.value})}><option value="">全部等级</option><option value="excellent">优秀（0错误）</option><option value="normal">正常（1–8）</option><option value="attention">注意（9–15）</option><option value="watch">重点（16–30）</option><option value="high">高频（31+）</option></select></label>
          <label className="pro-filter-field"><span>员工ID</span><div className="pro-input-shell"><i>⌕</i><input value={filters.employee_no} onChange={e=>setFilters({...filters,employee_no:e.target.value})} placeholder="输入员工ID"/></div></label>
          <label className="pro-filter-field"><span>姓名</span><div className="pro-input-shell"><i>⌕</i><input value={filters.full_name} onChange={e=>setFilters({...filters,full_name:e.target.value})} placeholder="输入姓名"/></div></label>
          <label className="pro-filter-field"><span>工作TG</span><div className="pro-input-shell"><i>⌕</i><input value={filters.work_tg} onChange={e=>setFilters({...filters,work_tg:e.target.value})} placeholder="输入工作TG"/></div></label>
          <label className="pro-filter-field"><span>后台账号</span><div className="pro-input-shell"><i>⌕</i><input value={filters.backend_account} onChange={e=>setFilters({...filters,backend_account:e.target.value})} placeholder="输入后台账号"/></div></label>
        </div>
        {showFilters&&<div className="filter-grid employee-filter-grid v24-advanced-filter-grid">
          <label>团队<FilterCombo value={filters.team} options={(analytics.teams||[]).map(x=>x.name)} onChange={v=>setFilters({...filters,team:v})} placeholder="全部团队 / 输入搜索" listId="employee-team-filter"/></label>
          <label>岗位<FilterCombo value={filters.position} options={(analytics.positions||[]).map(x=>x.name)} onChange={v=>setFilters({...filters,position:v})} placeholder="全部岗位 / 输入搜索" listId="employee-position-filter"/></label>
          <label>员工国家<FilterCombo value={filters.country} options={meta.options?.countries||[]} onChange={v=>setFilters({...filters,country:v})} placeholder="全部员工国家 / 输入搜索" listId="employee-country-filter"/></label>
          <label>员工类型<select value={filters.employment_type} onChange={e=>setFilters({...filters,employment_type:e.target.value})}><option value="">全部</option>{typeOptions.map(x=><option key={x} value={x}>{x}</option>)}</select></label>
          <label>班次<FilterCombo value={filters.shift_name} options={cleanShiftOptions((analytics.shifts||[]).map(x=>x.name).length?(analytics.shifts||[]).map(x=>x.name):(meta.options?.shifts||[]))} onChange={v=>setFilters({...filters,shift_name:v})} placeholder="全部班次 / 输入搜索" listId="employee-shift-filter"/></label>
          <label>组长 / 负责人<FilterCombo value={filters.leader} options={meta.options?.leaders||[]} onChange={v=>setFilters({...filters,leader:v})} placeholder="全部负责人 / 输入搜索" listId="employee-leader-filter"/></label>
          <label>状态<select value={filters.status} onChange={e=>setFilters({...filters,status:e.target.value})}><option value="">全部</option><option value="active">在职</option><option value="probation">试用</option><option value="suspended">停用</option><option value="resigned">离职</option></select></label>
          <label>入职日期起<input type="date" value={filters.hire_from} onChange={e=>setFilters({...filters,hire_from:e.target.value})}/></label>
          <label>入职日期止<input type="date" value={filters.hire_to} onChange={e=>setFilters({...filters,hire_to:e.target.value})}/></label>
        </div>}
        <div className="filter-toolbar-actions archive-filter-actions"><button className="secondary-action" onClick={()=>setShowFilters(v=>!v)}>{showFilters?'收起筛选':'更多筛选'}</button><button className="secondary-action" onClick={clear}>重置</button></div>
      </div>

      <div className="module-summary-grid employee-summary-grid employee-kpi-grid archive-kpi-strip">
        <MetricSummary label="在职员工" value={archiveStats.kpis?.active??archiveStats.active??analytics.kpis?.active??meta.active} hint={`员工档案 ${archiveStats.kpis?.total_profiles??archiveStats.total??analytics.kpis?.total_profiles??meta.total??0}`} onClick={()=>openAnalysisDetail({title:'当前在职员工',event_type:'active',filters:{}})}/>
        <MetricSummary label="今日入职" value={archiveStats.kpis?.today_join??analytics.kpis?.today_join??'—'} compare={analytics.kpis?.today_join_delta} compareLabel="较昨日" onClick={()=>openAnalysisDetail({title:'今日入职人员',event_type:'join',date_from:archiveStats.as_of||analytics.as_of,date_to:archiveStats.as_of||analytics.as_of,filters:{}})}/>
        <MetricSummary label="今日离职" value={archiveStats.kpis?.today_resign??analytics.kpis?.today_resign??'—'} compare={analytics.kpis?.today_resign_delta} compareLabel="较昨日" inverse onClick={()=>openAnalysisDetail({title:'今日离职人员',event_type:'resign',date_from:archiveStats.as_of||analytics.as_of,date_to:archiveStats.as_of||analytics.as_of,filters:{}})}/>
        <MetricSummary label="近7天入职" value={archiveStats.kpis?.join_7d??analytics.kpis?.join_7d??'—'} compare={analytics.kpis?.join_7d_delta_pct} compareLabel="较前7天" percentCompare onClick={()=>openAnalysisDetail({title:'近7天入职人员',event_type:'join',date_from:isoAdd(archiveStats.as_of||analytics.as_of,-6),date_to:archiveStats.as_of||analytics.as_of,filters:{}})}/>
        <MetricSummary label="近7天离职" value={archiveStats.kpis?.resign_7d??analytics.kpis?.resign_7d??'—'} compare={analytics.kpis?.resign_7d_delta_pct} compareLabel="较前7天" percentCompare inverse onClick={()=>openAnalysisDetail({title:'近7天离职人员',event_type:'resign',date_from:isoAdd(archiveStats.as_of||analytics.as_of,-6),date_to:archiveStats.as_of||analytics.as_of,filters:{}})}/>
        <MetricSummary label="近30天净增" value={archiveStats.kpis?.net_30d??analytics.kpis?.net_30d??'—'} hint={`入 ${archiveStats.kpis?.join_30d??analytics.kpis?.join_30d??'—'} / 离 ${archiveStats.kpis?.resign_30d??analytics.kpis?.resign_30d??'—'}`} onClick={()=>openAnalysisDetail({title:'近30天人员流动',event_type:'all',date_from:isoAdd(archiveStats.as_of||analytics.as_of,-29),date_to:archiveStats.as_of||analytics.as_of,filters:{}})}/>
      </div>

      <ArchiveStructureStats
        data={archiveStats}
        onTenure={(bucket,label)=>openArchiveTenureDetail(bucket,label)}
        onPosition={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'position',value:name,filters:{}})}
        onCountry={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'country',value:name,filters:{}})}
      />

      {generated&&<div className="activation-banner"><div><span>{generated.employee_no} · {generated.employee_name}</span><strong>{generated.activation_code}</strong></div><button onClick={()=>navigator.clipboard.writeText(generated.activation_code)}>复制激活码</button></div>}

      <div className="data-card">
        {loading?<div className="empty-state">读取中...</div>:rows.length===0?<div className="empty-state">暂无符合条件的员工</div>:<div className="table-scroll">
          <table className="data-table employee-master-table">
            <thead><tr><th>员工ID</th><th>姓名</th><th>员工国家</th><th>团队</th><th>组长</th><th>岗位</th><th>班次</th><th>员工类型</th><th>入职日期</th><th>入职时长</th><th>录入时间</th><th>操作人账号</th><th>资料</th><th>账号</th><th>操作</th></tr></thead>
            <tbody>{rows.map(r=><tr key={r.id}>
              <td><strong>{r.employee_no}</strong></td><td>{r.full_name}</td><td>{r.country||r.nationality||'-'}</td><td>{r.teams?.name||'-'}</td><td>{r.leader_name||'-'}</td><td>{r.positions?.name||'-'}</td><td>{r.shift_name||'-'}</td><td>{typeName(r.employment_type)}</td><td className="employee-hire-date-cell">{text(r.hire_date).slice(0,10)||'-'}</td><td><strong>{tenureCompactLabel(r.hire_date,r.resign_date,r.status)}</strong></td><td>{formatDateTime(r.created_at)}</td><td><span className="operator-chip">{operatorDisplay(r.operator_account)}</span></td>
              <td>{r.missing_count>0?<span className="missing-chip">待完善 {r.missing_count}</span>:<span className="profile-chip">完整</span>}</td>
              <td>{r.account_opened?<span className="status-chip">已开通</span>:<span className="status-chip off">未开通</span>}</td>
              <td><div className="row-actions"><button className="table-action" onClick={()=>openDetail(r)}>查看</button>{!r.account_opened&&<button className="table-action" onClick={()=>generateCode(r.employee_no)}>激活码</button>}</div></td>
            </tr>)}</tbody>
          </table>
        </div>}
        <Pagination page={page} pages={pages} total={total} pageSize={pageSize} loading={loading} onPage={p=>{setPage(p);loadList(p,pageSize)}} onPageSize={setPageSize}/>
      </div>
    </>}

    {tab==='人员分析'&&<>
      <div className="analysis-head-row people-analysis-title">
        <div><h2>人员分析</h2><p>人员规模、组织结构、国家、班次和离职分开查看；不再把所有分析堆在一个长页面。</p></div>
        <div className="analysis-badge">实时数据</div>
      </div>

      <div className="employee-analysis-subtabs" role="tablist" aria-label="人员分析子目录">
        {analysisViews.map(x=><button type="button" key={x} className={analysisView===x?'active':''} onClick={()=>setAnalysisView(x)}>{x}</button>)}
      </div>

      {analysisView!=='离职分析'&&<div className="analytics-filter-panel v24-analytics-filter-panel">
        <div className="people-filter-grid">
          <label className="pro-filter-field"><span>员工ID</span><div className="pro-input-shell"><i>⌕</i><input value={analysisFilters.employee_no} onChange={e=>setAnalysisFilters({...analysisFilters,employee_no:e.target.value})} placeholder="输入员工ID"/></div></label>
          <label className="pro-filter-field"><span>姓名</span><div className="pro-input-shell"><i>⌕</i><input value={analysisFilters.full_name} onChange={e=>setAnalysisFilters({...analysisFilters,full_name:e.target.value})} placeholder="输入姓名"/></div></label>
          <label className="pro-filter-field"><span>工作TG</span><div className="pro-input-shell"><i>⌕</i><input value={analysisFilters.work_tg} onChange={e=>setAnalysisFilters({...analysisFilters,work_tg:e.target.value})} placeholder="输入工作TG"/></div></label>
          <label className="pro-filter-field"><span>团队</span><FilterCombo value={analysisFilters.team} options={(analytics.teams||[]).map(x=>x.name)} onChange={v=>setAnalysisFilters({...analysisFilters,team:v})} placeholder="全部团队 / 输入搜索" listId="analysis-team"/></label>
          <label className="pro-filter-field"><span>岗位</span><FilterCombo value={analysisFilters.position} options={(analytics.positions||[]).map(x=>x.name)} onChange={v=>setAnalysisFilters({...analysisFilters,position:v})} placeholder="全部岗位 / 输入搜索" listId="analysis-position"/></label>
          <label className="pro-filter-field"><span>员工国家</span><FilterCombo value={analysisFilters.country} options={(analytics.countries||[]).map(x=>x.name)} onChange={v=>setAnalysisFilters({...analysisFilters,country:v})} placeholder="全部员工国家 / 输入搜索" listId="analysis-country"/></label>
          <label className="pro-filter-field"><span>班次</span><FilterCombo value={analysisFilters.shift_name} options={cleanShiftOptions((analytics.shifts||[]).map(x=>x.name))} onChange={v=>setAnalysisFilters({...analysisFilters,shift_name:v})} placeholder="全部班次 / 输入搜索" listId="analysis-shift"/></label>
          <label className="pro-filter-field people-date-range-field"><span>分析日期区间</span><div className="pro-date-range"><input type="date" value={analysisFilters.date_from} onChange={e=>setAnalysisFilters({...analysisFilters,date_from:e.target.value})}/><b>—</b><input type="date" value={analysisFilters.date_to} onChange={e=>setAnalysisFilters({...analysisFilters,date_to:e.target.value})}/></div></label>
          <div className="filter-toolbar-actions people-filter-actions"><button className="secondary-action" onClick={()=>setAnalysisFilters({employee_no:'',full_name:'',work_tg:'',team:'',position:'',country:'',shift_name:'',date_from:'',date_to:''})}>重置</button></div>
        </div>
      </div>}

      {analysisView==='总览'&&<>
        <div className="module-summary-grid employee-summary-grid employee-kpi-grid people-analysis-kpis">
          <MetricSummary label="在职员工" value={peopleAnalytics.kpis?.active??meta.active} hint={`员工档案 ${(peopleAnalytics.kpis?.total_profiles ?? meta.total ?? 0)}`} onClick={()=>openAnalysisDetail({title:'当前在职员工',event_type:'active',filters:analysisFilters})}/>
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
        <EmployeeAnalyticsOverview
          analytics={peopleAnalytics}
          onTeam={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'team',value:name,filters:analysisFilters})}
          onPosition={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'position',value:name,filters:analysisFilters})}
          onCountry={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'country',value:name,filters:analysisFilters})}
          onShift={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'shift',value:name,filters:analysisFilters})}
          onResign={(dimension,value)=>openAnalysisDetail({title:`${value} · ${peopleAnalytics.period?.active?peopleAnalytics.period.label:'近30天'}离职人员`,event_type:'resign',dimension,value,date_from:peopleAnalytics.period?.active?peopleAnalytics.period.from:isoAdd(peopleAnalytics.as_of,-29),date_to:peopleAnalytics.period?.active?peopleAnalytics.period.to:peopleAnalytics.as_of,filters:analysisFilters})}
          onDay={date=>openAnalysisDetail({title:`${date} · 人员流动`,event_type:'all',date_from:date,date_to:date,filters:analysisFilters})}
        />
      </>}

      {analysisView==='团队分析'&&<DimensionAnalysisDirectory
        title="团队分析" subtitle="按团队查看当前人数、占比、近7天 / 近30天人员流动。"
        rows={peopleAnalytics.teams||[]} loading={peopleAnalytics.loading}
        onPeople={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'team',value:name,filters:analysisFilters})}
        onResign={name=>openAnalysisDetail({title:`${name} · 近30天离职人员`,event_type:'resign',dimension:'team',value:name,date_from:isoAdd(peopleAnalytics.as_of,-29),date_to:peopleAnalytics.as_of,filters:analysisFilters})}
      />}

      {analysisView==='岗位分析'&&<DimensionAnalysisDirectory
        title="岗位分析" subtitle="按岗位查看当前人数、占比和人员流动。"
        rows={peopleAnalytics.positions||[]} loading={peopleAnalytics.loading}
        onPeople={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'position',value:name,filters:analysisFilters})}
        onResign={name=>openAnalysisDetail({title:`${name} · 近30天离职人员`,event_type:'resign',dimension:'position',value:name,date_from:isoAdd(peopleAnalytics.as_of,-29),date_to:peopleAnalytics.as_of,filters:analysisFilters})}
      />}

      {analysisView==='国家分析'&&<>
        <CountryTenurePanel analytics={peopleAnalytics} filters={analysisFilters} onOpen={args=>openAnalysisDetail(args)}/>
        <CountryPeopleAnalytics
          analytics={peopleAnalytics}
          onOpen={args=>openAnalysisDetail(args)}
          onCountry={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'country',value:name,filters:analysisFilters})}
        />
      </>}

      {analysisView==='班次分析'&&<DimensionAnalysisDirectory
        title="班次分析" subtitle="按当前排班班次查看人数、占比和人员流动。"
        rows={peopleAnalytics.shifts||[]} loading={peopleAnalytics.loading}
        onPeople={name=>openAnalysisDetail({title:`${name} · 当前在职员工`,event_type:'active',dimension:'shift',value:name,filters:analysisFilters})}
        onResign={name=>openAnalysisDetail({title:`${name} · 近30天离职人员`,event_type:'resign',dimension:'shift',value:name,date_from:isoAdd(peopleAnalytics.as_of,-29),date_to:peopleAnalytics.as_of,filters:analysisFilters})}
      />}

      {analysisView==='离职分析'&&<ResignationAnalyticsPanel
        analytics={resignationAnalytics}
        filters={resignationAnalyticsFilters}
        setFilters={setResignationAnalyticsFilters}
        options={analytics}
        onOpen={args=>openAnalysisDetail({...args,filters:resignationAnalyticsFilters})}
      />}
    </>}
    {tab==='团队管理'&&<>
      <div className="analysis-head-row">
        <div><h2>团队结构分析</h2><p>团队人数、占全体比例、人员流动和团队内部岗位构成。</p></div>
        <div className="analysis-badge">{analytics.teams?.length||0} 个团队</div>
      </div>
      <TeamAnalysisSummary analytics={analytics}/>
      <div className="data-card analysis-list-card">
        <div className="structure-filter-toolbar">
          <div className="structure-select-wrap"><span>查看团队</span><FilterCombo value={teamKeyword} options={(analytics.teams||[]).map(t=>t.name)} onChange={v=>{setTeamKeyword(v);setTeamPage(1)}} placeholder="全部团队 / 输入名称搜索" listId="team-manager-filter"/></div>
          <div className="structure-toolbar-actions"><button className="secondary-action" onClick={()=>{setTeamKeyword('');setTeamPage(1)}}>重置</button></div>
        </div>
        <div className="analysis-card-list">{teamSlice.map(t=><TeamAnalysisCard key={t.name} item={t} onPeople={()=>openAnalysisDetail({title:`${t.name} · 当前成员`,event_type:'active',dimension:'team',value:t.name,filters:{}})} onResign={()=>openAnalysisDetail({title:`${t.name} · 近30天离职人员`,event_type:'resign',dimension:'team',value:t.name,date_from:isoAdd(analytics.as_of,-29),date_to:analytics.as_of,filters:{}})} onPosition={name=>openAnalysisDetail({title:`${t.name} · ${name} · 当前成员`,event_type:'active',dimension:'team',value:t.name,filters:{position:name}})}/>)}</div>
        {!analytics.loading&&!teamSlice.length&&<div className="empty-state">暂无团队数据</div>}
        <Pagination page={teamPage} pages={teamPages} total={filteredTeams.length} pageSize={teamPageSize} loading={analytics.loading} onPage={setTeamPage} onPageSize={n=>{setTeamPageSize(n);setTeamPage(1)}}/>
      </div>
    </>}

    {tab==='岗位管理'&&<>
      <div className="analysis-head-row">
        <div><h2>岗位结构分析</h2><p>岗位人数、占全体比例、人员流动和岗位在各团队的分布。</p></div>
        <div className="analysis-badge">{analytics.positions?.length||0} 个岗位</div>
      </div>
      <PositionAnalysisSummary analytics={analytics}/>
      <div className="data-card analysis-list-card">
        <div className="structure-filter-toolbar">
          <div className="structure-select-wrap"><span>查看岗位</span><FilterCombo value={positionKeyword} options={(analytics.positions||[]).map(p=>p.name)} onChange={v=>{setPositionKeyword(v);setPositionPage(1)}} placeholder="全部岗位 / 输入名称搜索" listId="position-manager-filter"/></div>
          <div className="structure-toolbar-actions"><button className="secondary-action" onClick={()=>{setPositionKeyword('');setPositionPage(1)}}>重置</button></div>
        </div>
        <div className="analysis-card-list">{positionSlice.map(p=><PositionAnalysisCard key={p.name} item={p} onPeople={()=>openAnalysisDetail({title:`${p.name} · 当前人员`,event_type:'active',dimension:'position',value:p.name,filters:{}})} onResign={()=>openAnalysisDetail({title:`${p.name} · 近30天离职人员`,event_type:'resign',dimension:'position',value:p.name,date_from:isoAdd(analytics.as_of,-29),date_to:analytics.as_of,filters:{}})} onTeam={name=>openAnalysisDetail({title:`${p.name} · ${name} · 当前人员`,event_type:'active',dimension:'position',value:p.name,filters:{team:name}})}/>)}</div>
        {!analytics.loading&&!positionSlice.length&&<div className="empty-state">暂无岗位数据</div>}
        <Pagination page={positionPage} pages={positionPages} total={filteredPositions.length} pageSize={positionPageSize} loading={analytics.loading} onPage={setPositionPage} onPageSize={n=>{setPositionPageSize(n);setPositionPage(1)}}/>
      </div>
    </>}

    {tab==='离职记录'&&<div className="data-card resignation-card-pro">
      <div className="section-head resignation-section-head">
        <div><h2>离职记录</h2><p>完整保留离职员工档案；可按员工、团队、岗位、国家、原因和日期精确查询。</p></div>
        <span>{historyTotal} 人</span>
      </div>

      <div className="resignation-filter-panel v25-resignation-filter-panel" style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:'14px 16px',alignItems:'end'}}>
        <label className="resign-filter-field"><span>员工ID</span><div className="pro-input-shell"><i>⌕</i><input value={historyDraftFilters.employee_no} onChange={e=>setHistoryDraftFilters({...historyDraftFilters,employee_no:e.target.value})} placeholder="输入员工ID"/></div></label>
        <label className="resign-filter-field"><span>姓名</span><div className="pro-input-shell"><i>⌕</i><input value={historyDraftFilters.full_name} onChange={e=>setHistoryDraftFilters({...historyDraftFilters,full_name:e.target.value})} placeholder="输入姓名"/></div></label>
        <label className="resign-filter-field"><span>团队</span><FilterCombo value={historyDraftFilters.team} options={(analytics.teams||[]).map(x=>x.name)} onChange={v=>setHistoryDraftFilters({...historyDraftFilters,team:v})} placeholder="全部团队 / 输入搜索" listId="history-team"/></label>
        <label className="resign-filter-field"><span>岗位</span><FilterCombo value={historyDraftFilters.position} options={(analytics.positions||[]).map(x=>x.name)} onChange={v=>setHistoryDraftFilters({...historyDraftFilters,position:v})} placeholder="全部岗位 / 输入搜索" listId="history-position"/></label>
        <label className="resign-filter-field"><span>员工国家</span><FilterCombo value={historyDraftFilters.country} options={(analytics.countries||[]).map(x=>x.name)} onChange={v=>setHistoryDraftFilters({...historyDraftFilters,country:v})} placeholder="全部员工国家 / 输入搜索" listId="history-country"/></label>
        <label className="resign-filter-field v25-resign-reason"><span>离职原因</span><input value={historyDraftFilters.reason} onChange={e=>setHistoryDraftFilters({...historyDraftFilters,reason:e.target.value})} placeholder="输入离职原因关键字"/></label>
        <label className="resign-filter-field v25-resign-date"><span>离职日期区间</span><div className="pro-date-range"><input aria-label="离职日期起" type="date" value={historyDraftFilters.date_from} onChange={e=>setHistoryDraftFilters({...historyDraftFilters,date_from:e.target.value})}/><b>—</b><input aria-label="离职日期止" type="date" value={historyDraftFilters.date_to} onChange={e=>setHistoryDraftFilters({...historyDraftFilters,date_to:e.target.value})}/></div></label>
        <div className="resign-filter-actions v25-resign-actions" style={{gridColumn:'4',display:'flex',justifyContent:'flex-end',alignItems:'end',gap:8,minHeight:42}}><button className="primary-action resignation-query-action" onClick={applyHistoryFilters} disabled={historyLoading}>{historyLoading?'查询中...':'查询'}</button><button className="secondary-action" onClick={resetHistoryFilters} disabled={historyLoading}>重置</button></div>
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
              <button className="table-action" onClick={()=>openHistoryDetail(r)}>查看</button>
              {historyPermissions.can_edit&&<button className="table-action edit-history-action" onClick={()=>setEditResignModal({event_id:r.id,employee_id:r.employee_id,employee_no:r.employee_no,full_name:r.full_name,resign_date:r.effective_date||'',reason:r.reason||''})}>编辑</button>}
              {historyPermissions.can_restore&&<button className="table-action restore-action" onClick={()=>setRestoreModal({employee_id:r.employee_id,employee_no:r.employee_no,full_name:r.full_name,restore_portal:true})}>恢复在职</button>}
              {r.employee_id&&<button className="table-action cancel-hire-history-action" title="未正式入职或后台新增员工可直接撤销；不符合条件时系统会安全拒绝" onClick={()=>setCancelHireModal({employee_id:r.employee_id,employee_no:r.employee_no,full_name:r.full_name,confirm_text:''})}>撤销入职</button>}
            </div></td>
          </tr>
        })}</tbody>
      </table>{historyLoading&&<div className="history-loading-overlay" aria-live="polite"><span>读取离职记录...</span></div>}</div>}
      <Pagination page={historyPage} pages={historyPages} total={historyTotal} pageSize={historyPageSize} loading={historyLoading} onPage={p=>{setHistoryPage(p);loadHistory(p,historyPageSize,historyFilters)}} onPageSize={setHistoryPageSize}/>
    </div>}

    {tab==='操作日志'&&<div className="data-card">
      <div className="section-head">
        <div><h2>操作日志</h2><p>只显示新操作。后台历史重扫不再显示；Google 编辑优先显示真实邮箱，邮箱被隐藏时使用已登记操作人，不再统一冒充 Google Sheet。</p></div>
        <span>{auditTotal} 条</span>
      </div>
      <div className="resignation-filter-panel v25-resignation-filter-panel" style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:'14px 16px',alignItems:'end'}}>
        <label className="resign-filter-field"><span>员工ID</span><input value={auditFilters.employee_no} onChange={e=>setAuditFilters({...auditFilters,employee_no:e.target.value})} placeholder="输入员工ID"/></label>
        <label className="resign-filter-field"><span>姓名</span><input value={auditFilters.full_name} onChange={e=>setAuditFilters({...auditFilters,full_name:e.target.value})} placeholder="输入姓名"/></label>
        <label className="resign-filter-field"><span>操作类型</span><FilterCombo value={auditFilters.action?auditActionLabel(auditFilters.action):''} options={auditActionOptions.map(x=>x.label)} onChange={label=>setAuditFilters({...auditFilters,action:auditActionValueByLabel(label)})} placeholder="全部操作 / 输入搜索" listId="audit-action-filter"/></label>
        <label className="resign-filter-field"><span>操作账号</span><input value={auditFilters.actor} onChange={e=>setAuditFilters({...auditFilters,actor:e.target.value})} placeholder="后台账号 / Google 邮箱"/></label>
        <label className="resign-filter-field v25-resign-date" style={{gridColumn:'1 / span 2',minWidth:0}}><span>操作日期区间</span><div className="pro-date-range" style={{width:'100%'}}><input type="date" value={auditFilters.date_from} onChange={e=>setAuditFilters({...auditFilters,date_from:e.target.value})}/><b>—</b><input type="date" value={auditFilters.date_to} onChange={e=>setAuditFilters({...auditFilters,date_to:e.target.value})}/></div></label>
        <div className="resign-filter-actions v25-resign-actions" style={{gridColumn:'3 / span 2',display:'flex',alignSelf:'end',justifyContent:'flex-end',alignItems:'end',gap:8,minHeight:42}}><button className="primary-action resignation-query-action" onClick={()=>{setAuditPage(1);loadAudit(1,auditPageSize,auditFilters)}} disabled={auditLoading}>{auditLoading?'查询中...':'查询'}</button><button className="secondary-action" onClick={()=>{const next=blankAuditFilters();setAuditFilters(next);setAuditPage(1);loadAudit(1,auditPageSize,next)}} disabled={auditLoading}>重置</button></div>
      </div>
      {auditLoading&&!auditRows.length?<div className="empty-state">读取操作日志...</div>:!auditRows.length?<div className="empty-state">暂无操作日志</div>:<div className="table-scroll"><table className="data-table">
        <thead><tr><th>时间</th><th>操作账号</th><th>员工ID</th><th>姓名</th><th>操作</th><th>详细变更</th><th>来源</th></tr></thead>
        <tbody>{auditRows.map(r=><tr key={r.id}>
          <td style={{whiteSpace:'nowrap'}}>{formatDateTime(r.created_at)}</td><td><span className="operator-chip">{operatorDisplay(r.actor_username)}</span></td><td><strong>{r.employee_no||'—'}</strong></td><td>{r.full_name||'—'}</td><td>{auditActionLabel(r.action)}</td><td className="reason-cell"><AuditChanges row={r} meta={meta}/></td><td style={{whiteSpace:'nowrap'}}>{auditSourceLabel(r)}</td>
        </tr>)}</tbody>
      </table></div>}
      <Pagination page={auditPage} pages={auditPages} total={auditTotal} pageSize={auditPageSize} loading={auditLoading} onPage={p=>{setAuditPage(p);loadAudit(p,auditPageSize,auditFilters)}} onPageSize={changeAuditPageSize}/>
    </div>}

    {reasonPreview&&<div className="modal-mask employee-action-modal-mask" onMouseDown={()=>setReasonPreview(null)}><div className="modal-card" style={{width:'min(720px,calc(100vw - 40px))',maxWidth:720}} onMouseDown={e=>e.stopPropagation()}>
      <div className="modal-head"><div><span className="modal-kicker">RESIGNATION REASON</span><h2>完整离职原因</h2><p>{reasonPreview.employee_no||'—'} · {reasonPreview.full_name||'—'} · {reasonPreview.resign_date||'—'}</p></div><button onClick={()=>setReasonPreview(null)}>×</button></div>
      <div style={{padding:'0 24px 24px'}}><div style={{whiteSpace:'pre-wrap',wordBreak:'break-word',lineHeight:1.8,fontSize:14,color:'#243b5a',padding:'16px 18px',border:'1px solid #dbe5f1',borderRadius:12,background:'#f8fbff',maxHeight:'55vh',overflow:'auto'}}>{reasonPreview.reason}</div></div>
    </div></div>}

    {analysisDetail&&<AnalysisDetailModal state={analysisDetail} loading={analysisDetailLoading} onClose={()=>setAnalysisDetail(null)} onOpenEmployee={row=>openHistoryDetail(row)}/>}

    {selected&&<EmployeeDrawer detail={selected} loading={detailLoading} onClose={()=>setSelected(null)} returnToAnalysis={Boolean(analysisDetail)} onReturn={()=>setSelected(null)} onEdit={openEdit} onResign={()=>setResignModal({employee_id:selected.employee.id,employee_no:selected.employee.employee_no,full_name:selected.employee.full_name,resign_date:'',reason:'',disable_portal:true})} onCancelHire={()=>setCancelHireModal({employee_id:selected.employee.id,employee_no:selected.employee.employee_no,full_name:selected.employee.full_name,confirm_text:''})}/>}
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

    if(k==='employment_type'){
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

    <FormSection title="组织与工作">
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
      <Field label="工作TG"><input value={e.work_tg} onChange={x=>setEmployee('work_tg',x.target.value)}/></Field>
      <Field label="后台账号"><input value={e.backend_accounts} onChange={x=>setEmployee('backend_accounts',x.target.value)}/></Field>
      <Field label="当前排班"><div className="readonly-choice live-assignment-note">主档岗位同步「居家员工名单」；排班岗位由「居家排班表」最新排班同步，二者独立不互相覆盖</div></Field>
    </FormSection>

    {typeName(e.employment_type)==='现场转居家'&&<FormSection title="现场转居家资料">
      <Field label="最后地点"><input value={e.last_location} onChange={x=>setEmployee('last_location',x.target.value)}/></Field>
      <Field label="回去时间"><input type="date" value={e.return_date} onChange={x=>setEmployee('return_date',x.target.value)}/></Field>
      <Field label="居家时间"><input type="date" value={e.home_date} onChange={x=>setEmployee('home_date',x.target.value)}/></Field>
    </FormSection>}

    <FormSection title="联系方式">
      <Field label="Workfolio 邮箱"><input value={f.contact.work_email} onChange={x=>setContact('work_email',x.target.value)}/></Field>
      <Field label="Telegram"><input value={f.contact.telegram_username} onChange={x=>setContact('telegram_username',x.target.value)}/></Field>
      <Field label="Zoom 邮箱"><input value={f.contact.zoom_email} onChange={x=>setContact('zoom_email',x.target.value)}/></Field>
      <Field label="Facebook"><input value={f.contact.facebook} onChange={x=>setContact('facebook',x.target.value)}/></Field>
      <Field label="WhatsApp / 手机"><input value={f.contact.whatsapp_phone} onChange={x=>setContact('whatsapp_phone',x.target.value)}/></Field>
    </FormSection>

    {e.employment_type&&<FormSection title="工资设置">
      {phpHome?<>
        <Field label="PHP 工资方式">
          <select value={f.compensation.salary_basis||phpSalaryBasis(f.compensation)} onChange={x=>setPhpSalaryBasis(x.target.value)}>
            <option value="">请选择</option>
            <option value="monthly">月薪制 · 25,000 PHP / 月</option>
            <option value="daily">日薪制 · 970 PHP / 天</option>
          </select>
        </Field>
        {!f.compensation.salary_basis && f.compensation.base_salary && f.compensation.daily_rate &&
          <Field label="旧资料状态" wide><div className="salary-warning">旧资料同时有月薪和日薪，请选择实际工资方式后保存。</div></Field>}
      </>:<>
        <Field label="底薪（USD）"><input type="number" step="0.01" value={f.compensation.base_salary} onChange={x=>setComp('base_salary',x.target.value)}/></Field>
        <Field label="默认绩效（USD）"><input type="number" step="0.01" value={f.compensation.performance_default} onChange={x=>setComp('performance_default',x.target.value)}/></Field>
        {isOnsiteToHome(e.employment_type)&&<Field label="餐补（USD）"><input type="number" step="0.01" value={f.compensation.meal_allowance} onChange={x=>setComp('meal_allowance',x.target.value)}/></Field>}
      </>}
      <Field label="备注" wide><input value={f.compensation.note} onChange={x=>setComp('note',x.target.value)}/></Field>
    </FormSection>}

    {e.employment_type&&<FormSection title="收款资料">
      <Field label="收款方式"><div className="readonly-choice">{paymentMode==='usdt'?'USDT':'银行卡 / 钱包'}</div></Field>
      {paymentMode==='usdt'?<>
        <Field label="USDT 地址" wide><input value={f.payment.usdt_address} onChange={x=>setPayment('usdt_address',x.target.value)}/></Field>
      </>:<>
        <Field label="类型 / 银行"><input value={f.payment.transfer_using} onChange={x=>setPayment('transfer_using',x.target.value)} placeholder="GCash / Maya / BPI / Bank..."/></Field>
        <Field label="账号"><input value={f.payment.bank_wallet_account} onChange={x=>setPayment('bank_wallet_account',x.target.value)}/></Field>
        <Field label="收款姓名"><input value={f.payment.account_name} onChange={x=>setPayment('account_name',x.target.value)}/></Field>
      </>}
      <Field label="联系电话"><input value={f.payment.contact_phone} onChange={x=>setPayment('contact_phone',x.target.value)}/></Field>
      <Field label="WhatsApp"><input value={f.payment.whatsapp_number} onChange={x=>setPayment('whatsapp_number',x.target.value)}/></Field>
      <Field label="员工地址" wide><textarea value={f.payment.employee_address} onChange={x=>setPayment('employee_address',x.target.value)}/></Field>
    </FormSection>}

    <div className="modal-actions employee-form-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" disabled={Boolean(idConflict)||Boolean(nameConflict)||identityChecking||!identityCheck||Boolean(identityCheck?.check_error)} onClick={onSave}>{identityChecking?'正在检查…':state.mode==='create'?'创建员工':'保存修改'}</button></div>
  </div></div>
}

function EmployeeDrawer({detail,loading,onClose,onEdit,onResign,onCancelHire,returnToAnalysis,onReturn}){
  const e=detail.employee||{}, c=detail.contact||{}, p=detail.payment||{}, comp=detail.compensation||{}
  const missing=detail.missing_fields||[]
  const full=Boolean(detail.permissions?.sensitive_payment_view)
  const paymentMode=p.mode||defaultPaymentMode(e.employment_type)
  const paymentTitle=paymentMode==='usdt'?'USDT 收款资料':'银行卡 / 钱包收款资料'

  return <div className="modal-mask detail-mask" onMouseDown={onClose}><div className="employee-detail-drawer employee-detail-v12" onMouseDown={ev=>ev.stopPropagation()}>
    <div className="employee-hero">
      <div className="employee-avatar">{text(e.full_name).slice(0,1).toUpperCase()||'E'}</div>
      <div className="employee-hero-copy"><div className="employee-id-line">{e.employee_no}</div><h2>{e.full_name||'读取中...'}</h2><div className="employee-tags"><span>{typeName(e.employment_type)}</span><span>{e.teams?.name||'未匹配团队'}</span><span>{e.positions?.name||'未设置主档岗位'}</span>{e.schedule_position&&e.schedule_position!==e.positions?.name&&<span>排班：{e.schedule_position}</span>}{e.hire_date&&<span className="employee-tenure-chip">{tenureDurationLabel(e.hire_date,e.resign_date,e.status)}</span>}</div></div>
      <div className="drawer-head-actions">
        {returnToAnalysis&&<button className="back-outline" onClick={onReturn}>← 返回人员明细</button>}
        {e.status!=='resigned'&&detail.actions?.can_resign&&<button className="danger-outline" onClick={onResign}>办理离职</button>}
        {e.status==='resigned'&&detail.actions?.can_reactivate&&<button className="restore-outline" onClick={()=>window.dispatchEvent(new CustomEvent('wfh-restore-employee',{detail:{employee_id:e.id,employee_no:e.employee_no,full_name:e.full_name}}))}>恢复在职</button>}
        {(detail.actions?.can_cancel_hire||isPendingHireForCancel(e.hire_date,e.status)||detail.actions?.can_edit)&&<button className="cancel-hire-outline" title="不符合撤销条件时系统会安全拒绝，不会删除员工资料" onClick={onCancelHire}>撤销入职</button>}
        {detail.actions?.can_edit&&<button className="edit-outline" onClick={onEdit}>编辑</button>}
        <button className="drawer-close" onClick={onClose}>×</button>
      </div>
    </div>
    {loading?<div className="empty-state">读取完整档案...</div>:<>
      <div className={`profile-status-line ${missing.length?'has-missing':'is-complete'}`}><div><strong>{missing.length?`资料待完善 ${missing.length} 项`:'当前必填资料完整'}</strong><span>{missing.length?missing.join(' · '):'已通过当前员工类型的资料检查规则'}</span></div></div>
      <div className="detail-sections detail-sections-v11">
        <InfoPanel title="基本资料" rows={[['员工ID',e.employee_no],['姓名',e.full_name],['员工国家',e.country||e.nationality],['员工类型',typeName(e.employment_type)],['状态',statusName(e.status)],['入职日期',text(e.hire_date).slice(0,10)],['入职时长',tenureDurationLabel(e.hire_date,e.resign_date,e.status)],['录入时间',formatDateTime(e.created_at)],['离职日期',text(e.resign_date).slice(0,10)],...(e.status==='resigned'?[['离职原因',text(detail.resignation_reason)||'—']]:[])]}/>
        <InfoPanel title="组织与排班" rows={[['团队',e.teams?.name],['主档岗位',e.positions?.name],['排班岗位',e.schedule_position],['班次',e.shift_name],['负责人 / 组长',e.leader_name],['培训老师',e.trainer_name],['盘口',e.platform_scope],['工作内容',e.work_content]]}/>
        <InfoPanel title="联系方式" rows={[['工作TG',e.work_tg],['后台账号',e.backend_accounts],['Telegram',c.telegram_username],['Workfolio邮箱',c.work_email],['Zoom邮箱',c.zoom_email],['Facebook',c.facebook],['WhatsApp',c.whatsapp_phone]]}/>
        <InfoPanel title="工资设置" rows={isPhpHome(e.employment_type)
          ? (comp.base_salary!==null && comp.base_salary!==undefined && comp.base_salary!==''
              ? [['工资方式','月薪制'],['月薪',money(comp.base_salary,'PHP')],['备注',comp.note]]
              : comp.daily_rate!==null && comp.daily_rate!==undefined && comp.daily_rate!==''
                ? [['工资方式','日薪制'],['日薪',money(comp.daily_rate,'PHP')],['备注',comp.note]]
                : [['工资方式','待确认'],['备注',comp.note]])
          : isOnsiteToHome(e.employment_type)
            ? [['底薪',money(comp.base_salary,'USD')],['默认绩效',money(comp.performance_default,'USD')],['餐补',money(comp.meal_allowance,'USD')],['备注',comp.note]]
            : [['底薪',money(comp.base_salary,'USD')],['默认绩效',money(comp.performance_default,'USD')],['备注',comp.note]]
        }/>
        <section className="detail-panel payment-panel-v11">
          <div className="detail-panel-head"><div><h3>{paymentTitle}</h3><p>{full?'你有敏感资料查看权限，显示完整值。':'完整号码不下发到浏览器，仅显示首尾，中间 **** 隐藏。'}</p></div><span className={full?'access-full':'access-masked'}>{full?'完整可见':'部分隐藏'}</span></div>
          {paymentMode==='usdt'?<div className="payment-primary"><span>USDT 地址</span><strong>{text(p.usdt_address)||'—'}</strong><small>收款方式：{p.transfer_using||'USDT'}</small></div>:paymentMode==='bank_wallet'?<div className="info-rows"><InfoRow label="收款方式" value={p.transfer_using}/><InfoRow label="银行卡 / 钱包账号" value={p.bank_wallet_account} mono/><InfoRow label="收款姓名" value={p.account_name}/></div>:null}
          <div className="payment-secondary"><InfoRow label="联系电话" value={p.contact_phone}/><InfoRow label="WhatsApp" value={p.whatsapp_number}/><InfoRow label="员工地址" value={p.employee_address}/></div>
        </section>
      </div>
    </>}
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
  const [detailFilters,setDetailFilters]=useState({employee_no:'',full_name:'',team:'',position:'',country:'',shift:'',reason:''})
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
      <label className="pro-filter-field"><span>员工ID</span><div className="pro-input-shell"><i>⌕</i><input value={detailFilters.employee_no} onChange={e=>setDetailFilters({...detailFilters,employee_no:e.target.value})} placeholder="输入员工ID"/></div></label>
      <label className="pro-filter-field"><span>姓名</span><div className="pro-input-shell"><i>⌕</i><input value={detailFilters.full_name} onChange={e=>setDetailFilters({...detailFilters,full_name:e.target.value})} placeholder="输入姓名"/></div></label>
      <label className="pro-filter-field"><span>团队</span><FilterCombo value={detailFilters.team} options={options.teams} onChange={v=>setDetailFilters({...detailFilters,team:v})} placeholder="全部团队 / 输入搜索" listId="detail-team"/></label>
      <label className="pro-filter-field"><span>岗位</span><FilterCombo value={detailFilters.position} options={options.positions} onChange={v=>setDetailFilters({...detailFilters,position:v})} placeholder="全部岗位 / 输入搜索" listId="detail-position"/></label>
      <label className="pro-filter-field"><span>员工国家</span><FilterCombo value={detailFilters.country} options={options.countries} onChange={v=>setDetailFilters({...detailFilters,country:v})} placeholder="全部员工国家 / 输入搜索" listId="detail-country"/></label>
      <label className="pro-filter-field"><span>班次</span><FilterCombo value={detailFilters.shift} options={cleanShiftOptions(options.shifts)} onChange={v=>setDetailFilters({...detailFilters,shift:v})} placeholder="全部班次 / 输入搜索" listId="detail-shift"/></label>
      {showReason&&<label className="pro-filter-field"><span>离职原因</span><input className="pro-plain-input" value={detailFilters.reason} onChange={e=>setDetailFilters({...detailFilters,reason:e.target.value})} placeholder="输入离职原因"/></label>}
      <div className="filter-toolbar-actions"><button className="secondary-action" onClick={()=>setDetailFilters({employee_no:'',full_name:'',team:'',position:'',country:'',shift:'',reason:''})}>重置</button></div>
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
  if(analytics.loading) return <div className="analysis-overview-card"><div className="empty-state compact-empty">正在计算人员结构...</div></div>
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
  if(loading) return <div className="analysis-overview-card"><div className="empty-state compact-empty">正在计算{title}...</div></div>
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
function ResignationAnalyticsPanel({analytics,filters,setFilters,options,onOpen}){
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
      <div>
        <h2>离职分析</h2>
        <p>按日、周、月和累计统计离职；环比上升用红色、下降用绿色。所有数字都可下钻到具体员工与离职原因。</p>
      </div>
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
      <div className="filter-toolbar-actions"><button className="secondary-action" onClick={()=>setFilters({employee_no:'',full_name:'',team:'',position:'',country:'',reason:'',date_from:'',date_to:''})}>重置</button></div>
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
        <div>
          <h3>各团队离职明细</h3>
          <p>今天 / 昨天、近7天 / 前7天、本月 / 上月同期、累计离职与离职率；点击人数或“查看人员”进入明细。</p>
        </div>
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
      <div><h3>员工结构统计</h3><p>在职员工的入职时长、岗位、盘口和国家人数；Realtime 自动刷新，60 秒静默轮询兜底。</p></div>
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
function InfoPanel({title,rows}){ return <section className="detail-panel"><div className="detail-panel-head"><h3>{title}</h3></div><div className="info-rows">{rows.map(([k,v])=><InfoRow key={k} label={k} value={v}/>)}</div></section> }
function InfoRow({label,value,mono}){ return <div className="info-row"><span>{label}</span><strong className={mono?'mono-value':''}>{text(value)||'—'}</strong></div> }
function Summary({label,value}){ return <div className="summary-card"><span>{label}</span><strong>{value??'—'}</strong></div> }
function money(v,currency){ if(v===null||v===undefined||v==='') return '—'; const n=Number(v); const value=Number.isInteger(n)?String(n):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,''); return `${value} ${currency||''}`.trim() }
