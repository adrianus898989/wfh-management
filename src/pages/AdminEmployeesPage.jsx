import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DataPageControls, Pagination } from '../components/DataPageControls'

const text = v => String(v ?? '').trim()
const statusName = s => ({active:'在职',inactive:'停用',resigned:'离职'}[s] || s || '-')
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
const eventLabel = v => ({join:'入职',resign:'离职',reactivate:'复职',profile_update:'资料修改'}[v] || v || '-')
const formatDateTime = v => {
  if(!v) return '—'
  const d=new Date(v)
  if(Number.isNaN(d.getTime())) return text(v)
  return d.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})
}
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
      team_id:'',position_id:'',market_country:'',market_position:'',shift_name:'',
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
      employment_type:e.employment_type||'',team_id:e.team_id||'',position_id:e.position_id||'',
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
  const tabs=['员工档案','人员分析','团队管理','岗位管理','离职记录']
  const initialTab=sp.get('tab')==='入离职记录'?'离职记录':sp.get('tab')
  const [tab,setTabState]=useState(tabs.includes(initialTab)?initialTab:'员工档案')

  const [meta,setMeta]=useState({
    teams:[],positions:[],total:0,active:0,no_team:0,official_id_pending:0,
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
  const [generated,setGenerated]=useState(null)
  const [showFilters,setShowFilters]=useState(true)
  const [filters,setFilters]=useState({
    keyword:'',team:'',position:'',country:'',status:'active',
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
  const [analysisFilters,setAnalysisFilters]=useState({keyword:'',team:'',position:'',country:'',shift_name:''})
  const [analysisDetail,setAnalysisDetail]=useState(null)
  const [analysisDetailLoading,setAnalysisDetailLoading]=useState(false)

  const [history,setHistory]=useState([])
  const [historyPermissions,setHistoryPermissions]=useState({can_edit:false,can_restore:false})
  const [historyTotal,setHistoryTotal]=useState(0)
  const [historyPage,setHistoryPage]=useState(1)
  const [historyPageSize,setHistoryPageSizeState]=useState(()=>Number(localStorage.getItem('wfh_history_page_size'))||20)
  const [historyLoading,setHistoryLoading]=useState(false)
  const [historyFilters,setHistoryFilters]=useState({keyword:'',date_from:'',date_to:''})

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

  const loadMeta=async()=>{
    try{ setMeta(await invoke({action:'meta'})) }catch(e){ setError(e.message) }
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

  const loadList=async(nextPage=page,nextSize=pageSize)=>{
    setLoading(true); setError('')
    try{
      const data=await invoke({action:'list',page:nextPage,page_size:nextSize,filters})
      setRows(data.rows||[]); setTotal(data.total||0)
    }catch(e){ setError(e.message) }
    finally{ setLoading(false) }
  }

  const loadHistory=async(nextPage=historyPage,nextSize=historyPageSize)=>{
    setHistoryLoading(true); setError('')
    try{
      const data=await invoke({action:'history_list',page:nextPage,page_size:nextSize,filters:historyFilters})
      setHistory(data.rows||[])
      setHistoryPermissions(data.permissions||{can_edit:false,can_restore:false})
      setHistoryTotal(data.total||0)
    }catch(e){ setError(e.message) }
    finally{ setHistoryLoading(false) }
  }

  useEffect(()=>{ loadMeta(); loadAnalytics() },[])
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
    const t=setTimeout(()=>{ setHistoryPage(1); loadHistory(1,historyPageSize) },220)
    return()=>clearTimeout(t)
  },[tab,JSON.stringify(historyFilters)])

  useEffect(()=>{
    if(tab!=='人员分析') return
    const t=setTimeout(()=>loadPeopleAnalytics(analysisFilters),220)
    return()=>clearTimeout(t)
  },[tab,JSON.stringify(analysisFilters)])

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
    if(v==='离职记录') loadHistory(1,historyPageSize)
  }

  const setPageSize=n=>{
    localStorage.setItem('wfh_employee_page_size',String(n))
    setPageSizeState(n); setPage(1); loadList(1,n)
  }
  const setHistoryPageSize=n=>{
    localStorage.setItem('wfh_history_page_size',String(n))
    setHistoryPageSizeState(n); setHistoryPage(1); loadHistory(1,n)
  }

  const openDetail=async row=>{
    setSelected({employee:row,missing_fields:row.missing_fields||[]})
    setDetailLoading(true)
    try{ setSelected(await invoke({action:'detail',employee_id:row.id})) }
    catch(e){ setError(e.message); setSelected(null) }
    finally{ setDetailLoading(false) }
  }

  const openCreate=()=>{
    const f=emptyForm()
    setEmployeeModal({mode:'create',employee_id:null,form:f})
  }

  const openEdit=async()=>{
    if(!selected?.employee?.id) return
    const detail=selected
    setEmployeeModal({mode:'edit',employee_id:detail.employee.id,form:bundleToForm(detail)})
  }

  const saveEmployee=async()=>{
    if(!employeeModal) return
    const {mode,employee_id,form}=employeeModal
    if(!text(form.employee.employee_no)||!text(form.employee.full_name)){
      return setError('员工ID和姓名必须填写')
    }
    try{
      const payload={
        action:mode==='create'?'create_employee_full':'update_employee_full',
        employee_id,
        employee:form.employee,
        contact:form.contact,
        compensation:form.compensation,
        payment:form.payment,
      }
      const data=await invoke(payload)
      setEmployeeModal(null)
      await Promise.all([loadMeta(),loadAnalytics(),loadList(mode==='create'?1:page,pageSize)])
      if(mode==='edit'&&employee_id){
        setSelected(await invoke({action:'detail',employee_id}))
      }
      if(data?.sync?.skipped) setError('员工已保存；Google Sheet 双向同步尚未完成配置。')
    }catch(e){ setError(e.message) }
  }

  const openHistoryDetail=async row=>{
    if(!row?.employee_id) return setError('找不到对应员工档案')
    setSelected({employee:{id:row.employee_id,employee_no:row.employee_no,full_name:row.full_name,status:'resigned'}})
    setDetailLoading(true)
    try{ setSelected(await invoke({action:'detail',employee_id:row.employee_id})) }
    catch(e){ setError(e.message); setSelected(null) }
    finally{ setDetailLoading(false) }
  }

  const clearEmployeeFilters=()=>({
    keyword:'',team:'',position:'',country:'',status:'active',
    employment_type:'',shift_name:'',leader:'',hire_from:'',hire_to:'',
  })

  const drillToEmployees=patch=>{
    setFilters({...clearEmployeeFilters(),...patch})
    setPage(1)
    setTab('员工档案')
  }

  const openAnalysisDetail=async({title,event_type='all',dimension='',value='',date_from='',date_to=''})=>{
    setAnalysisDetail({title,event_type,dimension,value,date_from,date_to,rows:[],total:0})
    setAnalysisDetailLoading(true)
    try{
      const data=await invoke({action:'analytics_event_details',event_type,dimension,value,date_from,date_to,limit:200,filters:analysisFilters})
      setAnalysisDetail(v=>({...v,...data,title}))
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
      await Promise.all([loadMeta(),loadAnalytics(),loadList(page,pageSize),loadHistory(historyPage,historyPageSize)])
      if(data?.sync?.skipped) setError('离职记录已修改；Google Sheet 双向同步尚未完成配置。')
    }catch(e){ setError(e.message) }
  }

  const submitResign=async()=>{
    if(!resignModal?.employee_id) return
    if(!resignModal.resign_date||!text(resignModal.reason)){
      return setError('离职日期和离职原因必须填写')
    }
    try{
      const data=await invoke({action:'resign_employee',...resignModal})
      setResignModal(null); setSelected(null)
      await Promise.all([loadMeta(),loadAnalytics(),loadList(1,pageSize),loadHistory(1,historyPageSize)])
      if(data?.sync?.skipped) setError('离职已保存；Google Sheet 双向同步尚未完成配置。')
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
      await Promise.all([loadMeta(),loadAnalytics(),loadList(1,pageSize),loadHistory(1,historyPageSize)])
      if(data?.sync?.skipped) setError('已恢复在职；Google Sheet 双向同步尚未完成配置。')
    }catch(e){ setError(e.message) }
  }

  const submitCancelHire=async()=>{
    if(!cancelHireModal?.employee_id) return
    if(text(cancelHireModal.confirm_text)!==text(cancelHireModal.employee_no)){
      return setError('请输入完整员工ID确认撤销入职')
    }
    try{
      const data=await invoke({
        action:'cancel_new_hire',
        employee_id:cancelHireModal.employee_id,
        confirm_employee_no:cancelHireModal.confirm_text,
      })
      setCancelHireModal(null)
      setSelected(null)
      await Promise.all([loadMeta(),loadAnalytics(),loadList(1,pageSize),loadHistory(1,historyPageSize)])
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
  const clear=()=>setFilters(clearEmployeeFilters())

  const filteredTeams=useMemo(()=>{
    const q=teamKeyword.trim()
    return (analytics.teams||[]).filter(t=>!q||text(t.name)===q)
  },[analytics.teams,teamKeyword])
  const teamPages=Math.max(1,Math.ceil(filteredTeams.length/teamPageSize))
  const teamSlice=filteredTeams.slice((teamPage-1)*teamPageSize,teamPage*teamPageSize)

  const filteredPositions=useMemo(()=>{
    const q=positionKeyword.trim()
    return (analytics.positions||[]).filter(p=>!q||text(p.name)===q)
  },[analytics.positions,positionKeyword])
  const positionPages=Math.max(1,Math.ceil(filteredPositions.length/positionPageSize))
  const positionSlice=filteredPositions.slice((positionPage-1)*positionPageSize,positionPage*positionPageSize)

  return <div className="content-page employee-page pro-employee-page">
    <div className="module-title-row">
      <div>
        <div className="module-kicker">PEOPLE & ORGANIZATION</div>
        <h1>员工管理</h1>
      </div>
      {tab==='员工档案'&&<button className="primary-action" onClick={openCreate}>+ 新增员工</button>}
    </div>

    <div className="module-tabs">
      {tabs.map(x=><button key={x} className={tab===x?'active':''} onClick={()=>setTab(x)}>{x}</button>)}
    </div>

    {error&&<div className="page-error employee-notice">{error}<button onClick={()=>setError('')}>×</button></div>}

    {tab==='员工档案'&&<>
      <div className="archive-compact-head">
        <div><h2>员工档案</h2><span>当前在职 {meta.active||0} · 全部档案 {meta.total||0}</span></div>
      </div>
      <div className="filter-card archive-filter-card">
        <DataPageControls
          keyword={filters.keyword}
          onKeyword={v=>setFilters({...filters,keyword:v})}
          placeholder="搜索员工ID / 姓名 / 工作账号 / TG"
          pageSize={pageSize}
          onPageSize={setPageSize}
          right={<>
            <button className="secondary-action" onClick={()=>setShowFilters(v=>!v)}>{showFilters?'收起筛选':'更多筛选'}</button>
            <button className="secondary-action" onClick={clear}>重置</button>
          </>}
        />
        {showFilters&&<div className="filter-grid employee-filter-grid">
          <label>团队<FilterCombo value={filters.team} options={(analytics.teams||[]).map(x=>x.name)} onChange={v=>setFilters({...filters,team:v})} placeholder="全部团队" listId="employee-team-filter"/></label>
          <label>岗位<FilterCombo value={filters.position} options={(analytics.positions||[]).map(x=>x.name)} onChange={v=>setFilters({...filters,position:v})} placeholder="全部岗位" listId="employee-position-filter"/></label>
          <label>国家<FilterCombo value={filters.country} options={meta.options?.countries||[]} onChange={v=>setFilters({...filters,country:v})} placeholder="全部国家" listId="employee-country-filter"/></label>
          <label>员工类型<select value={filters.employment_type} onChange={e=>setFilters({...filters,employment_type:e.target.value})}><option value="">全部</option>{typeOptions.map(x=><option key={x} value={x}>{x}</option>)}</select></label>
          <label>班次<FilterCombo value={filters.shift_name} options={(analytics.shifts||[]).map(x=>x.name).length?(analytics.shifts||[]).map(x=>x.name):(meta.options?.shifts||[])} onChange={v=>setFilters({...filters,shift_name:v})} placeholder="全部班次" listId="employee-shift-filter"/></label>
          <label>组长 / 负责人<FilterCombo value={filters.leader} options={meta.options?.leaders||[]} onChange={v=>setFilters({...filters,leader:v})} placeholder="全部负责人" listId="employee-leader-filter"/></label>
          <label>状态<select value={filters.status} onChange={e=>setFilters({...filters,status:e.target.value})}><option value="">全部</option><option value="active">在职</option><option value="inactive">停用</option><option value="resigned">离职</option></select></label>
          <label>入职日期起<input type="date" value={filters.hire_from} onChange={e=>setFilters({...filters,hire_from:e.target.value})}/></label>
          <label>入职日期止<input type="date" value={filters.hire_to} onChange={e=>setFilters({...filters,hire_to:e.target.value})}/></label>
        </div>}
      </div>

      {generated&&<div className="activation-banner"><div><span>{generated.employee_no} · {generated.employee_name}</span><strong>{generated.activation_code}</strong></div><button onClick={()=>navigator.clipboard.writeText(generated.activation_code)}>复制激活码</button></div>}

      <div className="data-card">
        {loading?<div className="empty-state">读取中...</div>:rows.length===0?<div className="empty-state">暂无符合条件的员工</div>:<div className="table-scroll">
          <table className="data-table employee-master-table">
            <thead><tr><th>员工ID</th><th>姓名</th><th>国家</th><th>团队</th><th>组长</th><th>岗位</th><th>班次</th><th>员工类型</th><th>入职日期</th><th>录入时间</th><th>资料</th><th>账号</th><th>操作</th></tr></thead>
            <tbody>{rows.map(r=><tr key={r.id}>
              <td><strong>{r.employee_no}</strong></td><td>{r.full_name}</td><td>{r.country||r.nationality||'-'}</td><td>{r.teams?.name||'-'}</td><td>{r.leader_name||'-'}</td><td>{r.positions?.name||'-'}</td><td>{r.shift_name||'-'}</td><td>{typeName(r.employment_type)}</td><td>{text(r.hire_date).slice(0,10)||'-'}</td><td>{formatDateTime(r.created_at)}</td>
              <td>{r.missing_count>0?<span className="missing-chip">待完善 {r.missing_count}</span>:<span className="profile-chip">完整</span>}</td>
              <td>{r.account_opened?<span className="status-chip">已开通</span>:<span className="status-chip off">未开通</span>}</td>
              <td><div className="row-actions"><button className="table-action" onClick={()=>openDetail(r)}>查看</button>{!r.account_opened&&<button className="table-action" onClick={()=>generateCode(r.employee_no)}>激活码</button>}</div></td>
            </tr>)}</tbody>
          </table>
        </div>}
        <Pagination page={page} pages={pages} total={total} pageSize={pageSize} loading={loading} onPage={p=>{setPage(p);loadList(p,pageSize)}}/>
      </div>
    </>}

    {tab==='人员分析'&&<>
      <div className="analysis-head-row people-analysis-title">
        <div><h2>人员分析</h2><p>人员规模、入离职趋势和组织结构；所有数字都可以继续下钻查看人员。</p></div>
        <div className="analysis-badge">实时数据</div>
      </div>

      <div className="analytics-filter-bar">
        <div className="analytics-search-box">
          <span>⌕</span>
          <input value={analysisFilters.keyword} onChange={e=>setAnalysisFilters({...analysisFilters,keyword:e.target.value})} placeholder="搜索员工ID / 姓名 / TG"/>
        </div>
        <select value={analysisFilters.team} onChange={e=>setAnalysisFilters({...analysisFilters,team:e.target.value})}>
          <option value="">全部团队</option>{(analytics.teams||[]).map(x=><option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
        <select value={analysisFilters.position} onChange={e=>setAnalysisFilters({...analysisFilters,position:e.target.value})}>
          <option value="">全部岗位</option>{(analytics.positions||[]).map(x=><option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
        <select value={analysisFilters.country} onChange={e=>setAnalysisFilters({...analysisFilters,country:e.target.value})}>
          <option value="">全部国家</option>{(analytics.countries||[]).map(x=><option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
        <select value={analysisFilters.shift_name} onChange={e=>setAnalysisFilters({...analysisFilters,shift_name:e.target.value})}>
          <option value="">全部班次</option>{(analytics.shifts||[]).map(x=><option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
        {Object.values(analysisFilters).some(Boolean)&&<button className="secondary-action compact-clear" onClick={()=>setAnalysisFilters({keyword:'',team:'',position:'',country:'',shift_name:''})}>清除</button>}
      </div>

      <div className="module-summary-grid employee-summary-grid employee-kpi-grid people-analysis-kpis">
        <MetricSummary label="在职员工" value={peopleAnalytics.kpis?.active??meta.active} hint={`员工档案 ${(peopleAnalytics.kpis?.total_profiles ?? meta.total ?? 0)}`} onClick={()=>drillToEmployees({status:'active',keyword:analysisFilters.keyword,team:analysisFilters.team,position:analysisFilters.position,country:analysisFilters.country,shift_name:analysisFilters.shift_name})}/>
        <MetricSummary label="今日入职" value={peopleAnalytics.kpis?.today_join??'—'} compare={peopleAnalytics.kpis?.today_join_delta} compareLabel="较昨日" onClick={()=>openAnalysisDetail({title:'今日入职人员',event_type:'join',date_from:peopleAnalytics.as_of,date_to:peopleAnalytics.as_of})}/>
        <MetricSummary label="今日离职" value={peopleAnalytics.kpis?.today_resign??'—'} compare={peopleAnalytics.kpis?.today_resign_delta} compareLabel="较昨日" inverse onClick={()=>openAnalysisDetail({title:'今日离职人员',event_type:'resign',date_from:peopleAnalytics.as_of,date_to:peopleAnalytics.as_of})}/>
        <MetricSummary label="近7天入职" value={peopleAnalytics.kpis?.join_7d??'—'} compare={peopleAnalytics.kpis?.join_7d_delta_pct} compareLabel="较前7天" percentCompare onClick={()=>openAnalysisDetail({title:'近7天入职人员',event_type:'join',date_from:isoAdd(peopleAnalytics.as_of,-6),date_to:peopleAnalytics.as_of})}/>
        <MetricSummary label="近7天离职" value={peopleAnalytics.kpis?.resign_7d??'—'} compare={peopleAnalytics.kpis?.resign_7d_delta_pct} compareLabel="较前7天" percentCompare inverse onClick={()=>openAnalysisDetail({title:'近7天离职人员',event_type:'resign',date_from:isoAdd(peopleAnalytics.as_of,-6),date_to:peopleAnalytics.as_of})}/>
        <MetricSummary label="近30天净增" value={peopleAnalytics.kpis?.net_30d??'—'} hint={`入 ${peopleAnalytics.kpis?.join_30d??'—'} / 离 ${peopleAnalytics.kpis?.resign_30d??'—'}`} onClick={()=>openAnalysisDetail({title:'近30天人员流动',event_type:'all',date_from:isoAdd(peopleAnalytics.as_of,-29),date_to:peopleAnalytics.as_of})}/>
      </div>

      <EmployeeAnalyticsOverview
        analytics={peopleAnalytics}
        onTeam={name=>drillToEmployees({team:name})}
        onPosition={name=>drillToEmployees({position:name})}
        onCountry={name=>drillToEmployees({country:name})}
        onShift={name=>drillToEmployees({shift_name:name})}
        onResign={(dimension,value)=>openAnalysisDetail({title:`${value} · 近30天离职人员`,event_type:'resign',dimension,value,date_from:isoAdd(peopleAnalytics.as_of,-29),date_to:peopleAnalytics.as_of})}
        onDay={date=>openAnalysisDetail({title:`${date} · 人员流动`,event_type:'all',date_from:date,date_to:date})}
      />
    </>}

    {tab==='团队管理'&&<>
      <div className="analysis-head-row">
        <div><h2>团队结构分析</h2><p>团队人数、占全体比例、人员流动和团队内部岗位构成。</p></div>
        <div className="analysis-badge">{analytics.teams?.length||0} 个团队</div>
      </div>
      <TeamAnalysisSummary analytics={analytics}/>
      <div className="data-card analysis-list-card">
        <div className="structure-filter-toolbar">
          <div className="structure-select-wrap"><span>查看团队</span><select value={teamKeyword} onChange={e=>{setTeamKeyword(e.target.value);setTeamPage(1)}}><option value="">全部团队</option>{(analytics.teams||[]).map(t=><option key={t.name} value={t.name}>{t.name} · {t.count}人</option>)}</select></div>
          <div className="structure-toolbar-actions"><button className="secondary-action" onClick={()=>{setTeamKeyword('');setTeamPage(1)}}>全部</button><select value={teamPageSize} onChange={e=>{setTeamPageSize(Number(e.target.value));setTeamPage(1)}}><option value="10">每页 10</option><option value="20">每页 20</option></select></div>
        </div>
        <div className="analysis-card-list">{teamSlice.map(t=><TeamAnalysisCard key={t.name} item={t} onPeople={()=>drillToEmployees({team:t.name})} onResign={()=>openAnalysisDetail({title:`${t.name} · 近30天离职人员`,event_type:'resign',dimension:'team',value:t.name,date_from:isoAdd(analytics.as_of,-29),date_to:analytics.as_of})} onPosition={name=>drillToEmployees({team:t.name,position:name})}/>)}</div>
        {!analytics.loading&&!teamSlice.length&&<div className="empty-state">暂无团队数据</div>}
        <Pagination page={teamPage} pages={teamPages} total={filteredTeams.length} pageSize={teamPageSize} loading={analytics.loading} onPage={setTeamPage}/>
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
          <div className="structure-select-wrap"><span>查看岗位</span><select value={positionKeyword} onChange={e=>{setPositionKeyword(e.target.value);setPositionPage(1)}}><option value="">全部岗位</option>{(analytics.positions||[]).map(p=><option key={p.name} value={p.name}>{p.name} · {p.count}人</option>)}</select></div>
          <div className="structure-toolbar-actions"><button className="secondary-action" onClick={()=>{setPositionKeyword('');setPositionPage(1)}}>全部</button><select value={positionPageSize} onChange={e=>{setPositionPageSize(Number(e.target.value));setPositionPage(1)}}><option value="10">每页 10</option><option value="20">每页 20</option></select></div>
        </div>
        <div className="analysis-card-list">{positionSlice.map(p=><PositionAnalysisCard key={p.name} item={p} onPeople={()=>drillToEmployees({position:p.name})} onResign={()=>openAnalysisDetail({title:`${p.name} · 近30天离职人员`,event_type:'resign',dimension:'position',value:p.name,date_from:isoAdd(analytics.as_of,-29),date_to:analytics.as_of})} onTeam={name=>drillToEmployees({position:p.name,team:name})}/>)}</div>
        {!analytics.loading&&!positionSlice.length&&<div className="empty-state">暂无岗位数据</div>}
        <Pagination page={positionPage} pages={positionPages} total={filteredPositions.length} pageSize={positionPageSize} loading={analytics.loading} onPage={setPositionPage}/>
      </div>
    </>}

    {tab==='离职记录'&&<div className="data-card resignation-card-pro">
      <div className="section-head resignation-section-head">
        <div><h2>离职记录</h2><p>保留完整员工档案，可查看、按权限修改离职信息或恢复在职。</p></div>
        <span>{historyTotal} 人</span>
      </div>
      <div className="inner-tools history-tools history-tools-pro">
        <DataPageControls
          keyword={historyFilters.keyword}
          onKeyword={v=>setHistoryFilters({...historyFilters,keyword:v})}
          placeholder="搜索员工ID / 姓名 / 离职原因"
          pageSize={historyPageSize}
          onPageSize={setHistoryPageSize}
          right={<>
            <div className="history-date-range">
              <label><span>离职日期</span><div className="date-pair"><input className="compact-date" aria-label="离职日期起" type="date" value={historyFilters.date_from} onChange={e=>setHistoryFilters({...historyFilters,date_from:e.target.value})}/><b>—</b><input className="compact-date" aria-label="离职日期止" type="date" value={historyFilters.date_to} onChange={e=>setHistoryFilters({...historyFilters,date_to:e.target.value})}/></div></label>
            </div>
            {(historyFilters.keyword||historyFilters.date_from||historyFilters.date_to)&&<button className="secondary-action history-reset" onClick={()=>setHistoryFilters({keyword:'',date_from:'',date_to:''})}>清除</button>}
          </>}
        />
      </div>
      {historyLoading?<div className="empty-state">读取离职记录...</div>:<div className="table-scroll"><table className="data-table lifecycle-table resignation-table-pro">
        <thead><tr><th>离职日期</th><th>员工ID</th><th>姓名</th><th>员工类型</th><th>国家</th><th>团队</th><th>岗位</th><th>离职原因</th><th>来源</th><th>操作账号</th><th>操作</th><th>操作时间</th></tr></thead>
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
            <td className="reason-cell">{r.reason||'-'}</td>
            <td>{r.source_label||r.source_sheet||r.source||'-'}</td>
            <td><span className="operator-chip">{r.operator_account||'—'}</span></td>
            <td><div className="row-actions history-row-actions">
              <button className="table-action" onClick={()=>openHistoryDetail(r)}>查看</button>
              {historyPermissions.can_edit&&<button className="table-action edit-history-action" onClick={()=>setEditResignModal({event_id:r.id,employee_id:r.employee_id,employee_no:r.employee_no,full_name:r.full_name,resign_date:r.effective_date||'',reason:r.reason||''})}>编辑</button>}
              {historyPermissions.can_restore&&<button className="table-action restore-action" onClick={()=>setRestoreModal({employee_id:r.employee_id,employee_no:r.employee_no,full_name:r.full_name,restore_portal:true})}>恢复在职</button>}
            </div></td>
            <td className="operation-time-cell">{formatDateTime(r.operation_time||r.created_at)}</td>
          </tr>
        })}</tbody>
      </table></div>}
      <Pagination page={historyPage} pages={historyPages} total={historyTotal} pageSize={historyPageSize} loading={historyLoading} onPage={p=>{setHistoryPage(p);loadHistory(p,historyPageSize)}}/>
    </div>}

    {analysisDetail&&<AnalysisDetailModal state={analysisDetail} loading={analysisDetailLoading} onClose={()=>setAnalysisDetail(null)} onOpenEmployee={row=>{setAnalysisDetail(null);openHistoryDetail(row)}}/>}

    {selected&&<EmployeeDrawer detail={selected} loading={detailLoading} onClose={()=>setSelected(null)} onEdit={openEdit} onResign={()=>setResignModal({employee_id:selected.employee.id,employee_no:selected.employee.employee_no,full_name:selected.employee.full_name,resign_date:'',reason:'',disable_portal:true})} onCancelHire={()=>setCancelHireModal({employee_id:selected.employee.id,employee_no:selected.employee.employee_no,full_name:selected.employee.full_name,confirm_text:''})}/>}
    {employeeModal&&<EmployeeFormModal state={employeeModal} setState={setEmployeeModal} meta={meta} onClose={()=>setEmployeeModal(null)} onSave={saveEmployee}/>}
    {resignModal&&<ResignModal state={resignModal} setState={setResignModal} onClose={()=>setResignModal(null)} onSave={submitResign}/>}
    {editResignModal&&<EditResignationModal state={editResignModal} setState={setEditResignModal} onClose={()=>setEditResignModal(null)} onSave={submitResignEdit}/>}
    {restoreModal&&<RestoreModal state={restoreModal} setState={setRestoreModal} onClose={()=>setRestoreModal(null)} onSave={submitRestore}/>}
    {cancelHireModal&&<CancelHireModal state={cancelHireModal} setState={setCancelHireModal} onClose={()=>setCancelHireModal(null)} onSave={submitCancelHire}/>}
  </div>
}

function EmployeeFormModal({state,setState,meta,onClose,onSave}){
  const f=state.form
  const e=f.employee
  const phpHome=isPhpHome(e.employment_type)
  const paymentMode=f.payment.mode||defaultPaymentMode(e.employment_type)

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
      if(ref) next.market_country=ref.series || ''
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
  const existingTeamName=(meta.teams||[]).find(t=>t.id===e.team_id)?.name||''
  const derivedSeries=platformRef?.series || existingTeamName || e.market_country || ''
  const countries=Array.from(new Set(platformRefs.map(x=>x.country).filter(Boolean)))
  const derivedMarketCountry=countries.length>1?`多国家：${countries.join(' / ')}`:(countries[0]||'')

  return <div className="modal-mask employee-form-mask" onMouseDown={onClose}><div className="modal-card employee-form-modal" onMouseDown={ev=>ev.stopPropagation()}>
    <div className="modal-head employee-form-head"><div><span>{state.mode==='create'?'NEW EMPLOYEE':'EDIT EMPLOYEE'}</span><h2>{state.mode==='create'?'新增员工':'编辑员工资料'}</h2></div><button onClick={onClose}>×</button></div>

    <FormSection title="基本资料">
      <Field label="员工ID"><input disabled={state.mode==='edit'} value={e.employee_no} onChange={x=>setEmployee('employee_no',x.target.value.toUpperCase())}/></Field>
      <Field label="姓名"><input value={e.full_name} onChange={x=>setEmployee('full_name',x.target.value)}/></Field>
      <Field label="员工国家"><SelectValue value={e.country} options={selectOptions(opts.countries,e.country)} onChange={v=>setEmployee('country',v)}/></Field>
      <Field label="员工类型"><SelectValue value={typeName(e.employment_type)==='纯居家（越南/缅甸/印尼等）'?'纯居家（越南/缅甸/印尼等）':e.employment_type} options={selectOptions(typeOptions,typeName(e.employment_type))} onChange={v=>setEmployee('employment_type',v)}/></Field>
      <Field label="入职日期"><input type="date" value={e.hire_date} onChange={x=>setEmployee('hire_date',x.target.value)}/></Field>
    </FormSection>

    <FormSection title="组织与工作">
      <Field label="盘口岗位">
        <input list="employee-market-position-options" value={e.market_position||''} onChange={x=>setEmployee('market_position',x.target.value)} placeholder="可直接输入新盘口 / 组合盘口"/>
        <datalist id="employee-market-position-options">{platformOptions.map(x=><option key={x} value={x}/>)}</datalist>
      </Field>
      <Field label="团队 / 系列"><div className="readonly-choice">{derivedSeries||'—'}</div></Field>
      <Field label="盘口国家"><div className="readonly-choice">{derivedMarketCountry||'—'}</div></Field>
      <Field label="工作TG"><input value={e.work_tg} onChange={x=>setEmployee('work_tg',x.target.value)}/></Field>
      <Field label="后台账号"><input value={e.backend_accounts} onChange={x=>setEmployee('backend_accounts',x.target.value)}/></Field>
      <Field label="当前排班"><div className="readonly-choice live-assignment-note">岗位 / 班次由居家排班表同步</div></Field>
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

    <div className="modal-actions employee-form-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" onClick={onSave}>{state.mode==='create'?'创建员工':'保存修改'}</button></div>
  </div></div>
}

function EmployeeDrawer({detail,loading,onClose,onEdit,onResign,onCancelHire}){
  const e=detail.employee||{}, c=detail.contact||{}, p=detail.payment||{}, comp=detail.compensation||{}
  const missing=detail.missing_fields||[]
  const full=Boolean(detail.permissions?.sensitive_payment_view)
  const paymentMode=p.mode||defaultPaymentMode(e.employment_type)
  const paymentTitle=paymentMode==='usdt'?'USDT 收款资料':'银行卡 / 钱包收款资料'

  return <div className="modal-mask detail-mask" onMouseDown={onClose}><div className="employee-detail-drawer employee-detail-v12" onMouseDown={ev=>ev.stopPropagation()}>
    <div className="employee-hero">
      <div className="employee-avatar">{text(e.full_name).slice(0,1).toUpperCase()||'E'}</div>
      <div className="employee-hero-copy"><div className="employee-id-line">{e.employee_no}</div><h2>{e.full_name||'读取中...'}</h2><div className="employee-tags"><span>{typeName(e.employment_type)}</span><span>{e.teams?.name||'未匹配团队'}</span><span>{e.positions?.name||'未设置岗位'}</span></div></div>
      <div className="drawer-head-actions">
        {e.status!=='resigned'&&detail.actions?.can_resign&&<button className="danger-outline" onClick={onResign}>办理离职</button>}
        {e.status==='resigned'&&detail.actions?.can_reactivate&&<button className="restore-outline" onClick={()=>window.dispatchEvent(new CustomEvent('wfh-restore-employee',{detail:{employee_id:e.id,employee_no:e.employee_no,full_name:e.full_name}}))}>恢复在职</button>}
        {detail.actions?.can_cancel_hire&&<button className="cancel-hire-outline" onClick={onCancelHire}>撤销入职</button>}
        {detail.actions?.can_edit&&<button className="edit-outline" onClick={onEdit}>编辑</button>}
        <button className="drawer-close" onClick={onClose}>×</button>
      </div>
    </div>
    {loading?<div className="empty-state">读取完整档案...</div>:<>
      <div className={`profile-status-line ${missing.length?'has-missing':'is-complete'}`}><div><strong>{missing.length?`资料待完善 ${missing.length} 项`:'当前必填资料完整'}</strong><span>{missing.length?missing.join(' · '):'已通过当前员工类型的资料检查规则'}</span></div></div>
      <div className="detail-sections detail-sections-v11">
        <InfoPanel title="基本资料" rows={[['员工ID',e.employee_no],['姓名',e.full_name],['员工国家',e.country||e.nationality],['员工类型',typeName(e.employment_type)],['状态',statusName(e.status)],['入职日期',text(e.hire_date).slice(0,10)],['录入时间',formatDateTime(e.created_at)],['离职日期',text(e.resign_date).slice(0,10)]]}/>
        <InfoPanel title="组织与排班" rows={[['团队',e.teams?.name],['岗位',e.positions?.name],['班次',e.shift_name],['负责人 / 组长',e.leader_name],['培训老师',e.trainer_name],['盘口',e.platform_scope],['工作内容',e.work_content]]}/>
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
  return <div className="modal-mask" onMouseDown={onClose}><div className="modal-card resign-modal" onMouseDown={e=>e.stopPropagation()}>
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
  return <div className="modal-mask analytics-detail-mask" onMouseDown={onClose}><div className="analytics-detail-drawer" onMouseDown={e=>e.stopPropagation()}>
    <div className="analytics-detail-head">
      <div><span className="modal-kicker">PEOPLE DETAIL</span><h2>{state.title}</h2><p>{state.total||0} 条人员记录</p></div>
      <button className="drawer-close" onClick={onClose}>×</button>
    </div>
    {loading?<div className="empty-state">读取人员明细...</div>:!state.rows?.length?<div className="empty-state">这个条件下暂无人员记录</div>:<div className="analytics-detail-table-wrap"><table className="data-table analytics-detail-table">
      <thead><tr><th>日期</th><th>类型</th><th>员工ID</th><th>姓名</th><th>团队</th><th>岗位</th><th>国家</th><th>班次</th><th>离职原因</th><th></th></tr></thead>
      <tbody>{state.rows.map((r,i)=><tr key={r.id||`${r.employee_no}-${r.date}-${i}`}><td>{r.date||'—'}</td><td><span className={`event-chip ${r.event_type==='resign'?'resign':'join'}`}>{r.event_type==='resign'?'离职':'入职'}</span></td><td><strong>{r.employee_no||'—'}</strong></td><td>{r.full_name||'—'}</td><td>{r.team||'—'}</td><td>{r.position||'—'}</td><td>{r.country||'—'}</td><td>{r.shift||'—'}</td><td className="analytics-reason">{r.reason||'—'}</td><td>{r.employee_id&&<button className="table-action" onClick={()=>onOpenEmployee(r)}>查看档案</button>}</td></tr>)}</tbody>
    </table></div>}
  </div></div>
}

function EditResignationModal({state,setState,onClose,onSave}){
  return <div className="modal-mask" onMouseDown={onClose}><div className="modal-card resign-modal edit-resignation-modal" onMouseDown={e=>e.stopPropagation()}>
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
  return <div className="modal-mask" onMouseDown={onClose}><div className="modal-card resign-modal" onMouseDown={e=>e.stopPropagation()}>
    <div className="modal-head"><div><span className="modal-kicker">CANCEL NEW HIRE</span><h2>撤销入职</h2><p>{state.employee_no} · {state.full_name}</p></div><button onClick={onClose}>×</button></div>
    <div className="cancel-hire-warning"><strong>只用于录错资料或新人临时取消上班。</strong><span>确认后会移除当前员工档案与 TEST Google Sheet 记录。已经建立员工登录账号的人员不能直接撤销。</span></div>
    <div className="form-grid"><Field label={`输入员工ID ${state.employee_no} 确认`} wide><input value={state.confirm_text||''} onChange={e=>setState({...state,confirm_text:e.target.value.toUpperCase()})}/></Field></div>
    <div className="modal-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="danger-action" onClick={onSave}>确认撤销入职</button></div>
  </div></div>
}

function RestoreModal({state,setState,onClose,onSave}){
  return <div className="modal-mask" onMouseDown={onClose}><div className="modal-card resign-modal" onMouseDown={e=>e.stopPropagation()}>
    <div className="modal-head"><div><span className="modal-kicker">RESTORE EMPLOYEE</span><h2>恢复在职</h2><p>{state.employee_no} · {state.full_name}</p></div><button onClick={onClose}>×</button></div>
    <div className="restore-confirm-copy">
      <strong>撤销这次离职记录？</strong>
      <span>员工会恢复为在职，离职日期与离职原因会从当前 TEST Google Sheet 清除。</span>
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
        <div className="analysis-card-head"><div><h3>近14天人员流动</h3><p>柱顶数字就是当天人数；点击日期查看当天人员。</p></div><span>30天净增 {signed(analytics.kpis?.net_30d||0)}</span></div>
        <TrendBars rows={analytics.trend||[]} onSelectDay={onDay}/>
      </section>
      <section className="analysis-overview-card country-card-pro">
        <div className="analysis-card-head"><div><h3>国家人员与离职</h3><p>当前人数 / 近30天离职</p></div></div>
        <div className="country-analysis-list">{countries.map(x=><div className="country-analysis-row country-click-row" key={x.name}>
          <button type="button" onClick={()=>onCountry?.(x.name)}><strong>{x.name}</strong><span>{x.count} 人 · {pctText(x.share)}</span></button>
          <button type="button" className="country-resign-link" onClick={()=>onResign?.('country',x.name)}><span>30天离职</span><strong>{x.resign_30d||0}</strong><em>{pctText(x.resign_rate_30||0)}</em></button>
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
function SelectValue({value,options,onChange}){
  return <select value={value||''} onChange={e=>onChange(e.target.value)}>
    <option value="">请选择</option>
    {(options||[]).map(x=><option key={x} value={x}>{x}</option>)}
  </select>
}

function FilterCombo({value,options,onChange,placeholder,listId}){
  return <>
    <input list={listId} value={value||''} onChange={e=>onChange(e.target.value)} placeholder={placeholder||'全部'}/>
    <datalist id={listId}>{(options||[]).map(x=><option key={x} value={x}/>)}</datalist>
  </>
}

function FormSection({title,subtitle,children}){ return <section className="employee-form-section"><div className="employee-form-section-head"><h3>{title}</h3>{subtitle&&<p>{subtitle}</p>}</div><div className="employee-form-grid">{children}</div></section> }
function Field({label,children,wide}){ return <label className={wide?'form-field form-wide':'form-field'}><span>{label}</span>{children}</label> }
function InfoPanel({title,rows}){ return <section className="detail-panel"><div className="detail-panel-head"><h3>{title}</h3></div><div className="info-rows">{rows.map(([k,v])=><InfoRow key={k} label={k} value={v}/>)}</div></section> }
function InfoRow({label,value,mono}){ return <div className="info-row"><span>{label}</span><strong className={mono?'mono-value':''}>{text(value)||'—'}</strong></div> }
function Summary({label,value}){ return <div className="summary-card"><span>{label}</span><strong>{value??'—'}</strong></div> }
function money(v,currency){ if(v===null||v===undefined||v==='') return '—'; const n=Number(v); const value=Number.isInteger(n)?String(n):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,''); return `${value} ${currency||''}`.trim() }
