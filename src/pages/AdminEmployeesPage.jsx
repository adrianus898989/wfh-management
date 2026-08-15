import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DataPageControls, Pagination } from '../components/DataPageControls'

const text = v => String(v ?? '').trim()
const statusName = s => ({active:'在职',inactive:'停用',resigned:'离职'}[s] || s || '-')
const typeOptions = [
  '纯居家菲律宾','纯居家印尼','纯居家越南','纯居家缅甸','纯居家马来',
  '现场转居家','现场人员','排班补录'
]
const legacyType = {home_ph:'纯居家菲律宾',onsite_to_home:'现场转居家',home_vn:'纯居家越南',home_id:'纯居家印尼',home_mm:'纯居家缅甸'}
const typeName = v => legacyType[text(v)] || text(v) || '-'
const eventLabel = v => ({join:'入职',resign:'离职',reactivate:'复职',profile_update:'资料修改'}[v] || v || '-')

function defaultPaymentMode(type){
  const t=typeName(type)
  if(t==='现场转居家') return 'usdt'
  if(['纯居家印尼','纯居家越南','纯居家缅甸','纯居家马来','纯居家马来西亚'].includes(t)) return 'usdt'
  if(t==='纯居家菲律宾') return 'bank_wallet'
  return 'unknown'
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
    compensation:{base_salary:'',performance_default:'',meal_allowance:'',currency:'USD',effective_from:'',note:''},
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
      base_salary:comp.base_salary??'',performance_default:comp.performance_default??'',meal_allowance:comp.meal_allowance??'',
      currency:comp.currency||'USD',effective_from:text(comp.effective_from).slice(0,10),note:comp.note||'',
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
  const tabs=['员工档案','团队管理','岗位管理','入离职记录']
  const [tab,setTabState]=useState(tabs.includes(sp.get('tab'))?sp.get('tab'):'员工档案')

  const [meta,setMeta]=useState({teams:[],positions:[],total:0,active:0,no_team:0,official_id_pending:0})
  const [rows,setRows]=useState([])
  const [total,setTotal]=useState(0)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSizeState]=useState(()=>Number(localStorage.getItem('wfh_employee_page_size'))||20)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [generated,setGenerated]=useState(null)
  const [showFilters,setShowFilters]=useState(true)
  const [filters,setFilters]=useState({
    keyword:'',team_id:'',position_id:'',country:'',status:'active',
    employment_type:'',shift_name:'',leader:'',hire_from:'',hire_to:'',
  })

  const [selected,setSelected]=useState(null)
  const [detailLoading,setDetailLoading]=useState(false)
  const [employeeModal,setEmployeeModal]=useState(null) // {mode,employee_id,form}
  const [resignModal,setResignModal]=useState(null)

  const [history,setHistory]=useState([])
  const [historyTotal,setHistoryTotal]=useState(0)
  const [historyPage,setHistoryPage]=useState(1)
  const [historyPageSize,setHistoryPageSizeState]=useState(()=>Number(localStorage.getItem('wfh_history_page_size'))||20)
  const [historyLoading,setHistoryLoading]=useState(false)
  const [historyFilters,setHistoryFilters]=useState({keyword:'',event_type:'',date_from:'',date_to:''})

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
      setHistory(data.rows||[]); setHistoryTotal(data.total||0)
    }catch(e){ setError(e.message) }
    finally{ setHistoryLoading(false) }
  }

  useEffect(()=>{ loadMeta() },[])
  useEffect(()=>{
    if(first.current){ first.current=false; loadList(1,pageSize); return }
    const t=setTimeout(()=>{ setPage(1); loadList(1,pageSize) },260)
    return()=>clearTimeout(t)
  },[JSON.stringify(filters)])

  useEffect(()=>{
    const t=sp.get('tab')
    if(tabs.includes(t)) setTabState(t)
  },[sp])

  useEffect(()=>{
    if(tab!=='入离职记录') return
    const t=setTimeout(()=>{ setHistoryPage(1); loadHistory(1,historyPageSize) },220)
    return()=>clearTimeout(t)
  },[tab,JSON.stringify(historyFilters)])

  const setTab=v=>{
    setTabState(v)
    setSp(v==='员工档案'?{}:{tab:v})
    if(v==='入离职记录') loadHistory(1,historyPageSize)
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
      await Promise.all([loadMeta(),loadList(mode==='create'?1:page,pageSize)])
      if(mode==='edit'&&employee_id){
        setSelected(await invoke({action:'detail',employee_id}))
      }
      if(data?.sync?.skipped) setError('员工已保存；Google Sheet 双向同步尚未完成配置。')
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
      await Promise.all([loadMeta(),loadList(1,pageSize),loadHistory(1,historyPageSize)])
      if(data?.sync?.skipped) setError('离职已保存；Google Sheet 双向同步尚未完成配置。')
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
  const clear=()=>setFilters({
    keyword:'',team_id:'',position_id:'',country:'',status:'active',
    employment_type:'',shift_name:'',leader:'',hire_from:'',hire_to:'',
  })

  const filteredTeams=useMemo(()=>{
    const q=teamKeyword.trim().toLowerCase()
    return (meta.teams||[]).filter(t=>!q||[t.name,t.code,t.country].some(v=>text(v).toLowerCase().includes(q)))
  },[meta.teams,teamKeyword])
  const teamPages=Math.max(1,Math.ceil(filteredTeams.length/teamPageSize))
  const teamSlice=filteredTeams.slice((teamPage-1)*teamPageSize,teamPage*teamPageSize)

  const filteredPositions=useMemo(()=>{
    const q=positionKeyword.trim().toLowerCase()
    return (meta.positions||[]).filter(p=>!q||[p.name,p.code,p.currency].some(v=>text(v).toLowerCase().includes(q)))
  },[meta.positions,positionKeyword])
  const positionPages=Math.max(1,Math.ceil(filteredPositions.length/positionPageSize))
  const positionSlice=filteredPositions.slice((positionPage-1)*positionPageSize,positionPage*positionPageSize)

  return <div className="content-page employee-page pro-employee-page">
    <div className="module-title-row">
      <div>
        <div className="module-kicker">PEOPLE & ORGANIZATION</div>
        <h1>员工管理</h1>
        <p className="page-subtitle">员工档案、工资设置、入离职记录和 Google Sheet 同步使用同一个员工 ID。</p>
      </div>
      {tab==='员工档案'&&<button className="primary-action" onClick={openCreate}>+ 新增员工</button>}
    </div>

    <div className="module-tabs">
      {tabs.map(x=><button key={x} className={tab===x?'active':''} onClick={()=>setTab(x)}>{x}</button>)}
    </div>

    <div className="module-summary-grid employee-summary-grid">
      <Summary label="当前员工档案" value={meta.total}/>
      <Summary label="在职员工" value={meta.active}/>
      <Summary label="团队记录" value={meta.teams?.length||0}/>
      <Summary label="未匹配团队" value={meta.no_team}/>
      <Summary label="待补正式ID" value={meta.official_id_pending}/>
    </div>

    {error&&<div className="page-error employee-notice">{error}<button onClick={()=>setError('')}>×</button></div>}

    {tab==='员工档案'&&<>
      <div className="filter-card">
        <DataPageControls
          keyword={filters.keyword}
          onKeyword={v=>setFilters({...filters,keyword:v})}
          placeholder="搜索员工ID / 姓名 / 工作账号 / TG / 组长 / 培训 / 盘口"
          pageSize={pageSize}
          onPageSize={setPageSize}
          right={<>
            <button className="secondary-action" onClick={()=>setShowFilters(v=>!v)}>{showFilters?'收起筛选':'更多筛选'}</button>
            <button className="secondary-action" onClick={clear}>重置</button>
          </>}
        />
        {showFilters&&<div className="filter-grid employee-filter-grid">
          <label>团队<select value={filters.team_id} onChange={e=>setFilters({...filters,team_id:e.target.value})}><option value="">全部</option>{meta.teams?.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label>岗位<select value={filters.position_id} onChange={e=>setFilters({...filters,position_id:e.target.value})}><option value="">全部</option>{meta.positions?.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>国家<input value={filters.country} onChange={e=>setFilters({...filters,country:e.target.value})} placeholder="例如 菲律宾"/></label>
          <label>员工类型<input value={filters.employment_type} onChange={e=>setFilters({...filters,employment_type:e.target.value})} placeholder="例如 纯居家菲律宾"/></label>
          <label>班次<input value={filters.shift_name} onChange={e=>setFilters({...filters,shift_name:e.target.value})} placeholder="例如 白班 Day"/></label>
          <label>组长 / 负责人<input value={filters.leader} onChange={e=>setFilters({...filters,leader:e.target.value})} placeholder="输入姓名"/></label>
          <label>状态<select value={filters.status} onChange={e=>setFilters({...filters,status:e.target.value})}><option value="">全部</option><option value="active">在职</option><option value="inactive">停用</option><option value="resigned">离职</option></select></label>
          <label>入职日期起<input type="date" value={filters.hire_from} onChange={e=>setFilters({...filters,hire_from:e.target.value})}/></label>
          <label>入职日期止<input type="date" value={filters.hire_to} onChange={e=>setFilters({...filters,hire_to:e.target.value})}/></label>
        </div>}
      </div>

      {generated&&<div className="activation-banner"><div><span>{generated.employee_no} · {generated.employee_name}</span><strong>{generated.activation_code}</strong></div><button onClick={()=>navigator.clipboard.writeText(generated.activation_code)}>复制激活码</button></div>}

      <div className="data-card">
        {loading?<div className="empty-state">读取中...</div>:rows.length===0?<div className="empty-state">暂无符合条件的员工</div>:<div className="table-scroll">
          <table className="data-table employee-master-table">
            <thead><tr><th>员工ID</th><th>姓名</th><th>国家</th><th>团队</th><th>组长</th><th>岗位</th><th>班次</th><th>员工类型</th><th>入职日期</th><th>资料</th><th>账号</th><th>操作</th></tr></thead>
            <tbody>{rows.map(r=><tr key={r.id}>
              <td><strong>{r.employee_no}</strong></td><td>{r.full_name}</td><td>{r.country||r.nationality||'-'}</td><td>{r.teams?.name||'-'}</td><td>{r.leader_name||'-'}</td><td>{r.positions?.name||'-'}</td><td>{r.shift_name||'-'}</td><td>{typeName(r.employment_type)}</td><td>{text(r.hire_date).slice(0,10)||'-'}</td>
              <td>{r.missing_count>0?<span className="missing-chip">待完善 {r.missing_count}</span>:<span className="profile-chip">完整</span>}</td>
              <td>{r.account_opened?<span className="status-chip">已开通</span>:<span className="status-chip off">未开通</span>}</td>
              <td><div className="row-actions"><button className="table-action" onClick={()=>openDetail(r)}>查看</button>{!r.account_opened&&<button className="table-action" onClick={()=>generateCode(r.employee_no)}>激活码</button>}</div></td>
            </tr>)}</tbody>
          </table>
        </div>}
        <Pagination page={page} pages={pages} total={total} pageSize={pageSize} loading={loading} onPage={p=>{setPage(p);loadList(p,pageSize)}}/>
      </div>
    </>}

    {tab==='团队管理'&&<div className="data-card">
      <div className="section-head"><div><h2>团队管理</h2><p>搜索团队 / 编码 / 国家。</p></div><span>{filteredTeams.length} 条</span></div>
      <div className="inner-tools"><DataPageControls keyword={teamKeyword} onKeyword={v=>{setTeamKeyword(v);setTeamPage(1)}} placeholder="搜索团队 / 编码 / 国家" pageSize={teamPageSize} onPageSize={n=>{setTeamPageSize(n);setTeamPage(1)}}/></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>团队</th><th>编码</th><th>国家</th><th>状态</th></tr></thead><tbody>{teamSlice.map(t=><tr key={t.id}><td><strong>{t.name}</strong></td><td>{t.code||'-'}</td><td>{t.country||'-'}</td><td>{t.status||'-'}</td></tr>)}</tbody></table></div>
      <Pagination page={teamPage} pages={teamPages} total={filteredTeams.length} pageSize={teamPageSize} loading={false} onPage={setTeamPage}/>
    </div>}

    {tab==='岗位管理'&&<div className="data-card">
      <div className="section-head"><div><h2>岗位管理</h2><p>搜索岗位 / 编码 / 币种。</p></div><span>{filteredPositions.length} 条</span></div>
      <div className="inner-tools"><DataPageControls keyword={positionKeyword} onKeyword={v=>{setPositionKeyword(v);setPositionPage(1)}} placeholder="搜索岗位 / 编码 / 币种" pageSize={positionPageSize} onPageSize={n=>{setPositionPageSize(n);setPositionPage(1)}}/></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>岗位</th><th>编码</th><th>工资封顶</th><th>币种</th><th>状态</th></tr></thead><tbody>{positionSlice.map(p=><tr key={p.id}><td><strong>{p.name}</strong></td><td>{p.code||'-'}</td><td>{p.salary_cap??'-'}</td><td>{p.currency||'-'}</td><td>{p.status||'-'}</td></tr>)}</tbody></table></div>
      <Pagination page={positionPage} pages={positionPages} total={filteredPositions.length} pageSize={positionPageSize} loading={false} onPage={setPositionPage}/>
    </div>}

    {tab==='入离职记录'&&<div className="data-card">
      <div className="section-head"><div><h2>入职 / 离职记录</h2><p>历史离职从原表导入；以后后台办理离职和 Google Sheet 修改都会继续追加事件。</p></div><span>{historyTotal} 条事件</span></div>
      <div className="inner-tools history-tools">
        <DataPageControls
          keyword={historyFilters.keyword}
          onKeyword={v=>setHistoryFilters({...historyFilters,keyword:v})}
          placeholder="搜索员工ID / 姓名"
          pageSize={historyPageSize}
          onPageSize={setHistoryPageSize}
          right={<>
            <select className="compact-select" value={historyFilters.event_type} onChange={e=>setHistoryFilters({...historyFilters,event_type:e.target.value})}>
              <option value="">全部类型</option><option value="join">入职</option><option value="resign">离职</option><option value="reactivate">复职</option><option value="profile_update">资料修改</option>
            </select>
            <input className="compact-date" type="date" value={historyFilters.date_from} onChange={e=>setHistoryFilters({...historyFilters,date_from:e.target.value})}/>
            <input className="compact-date" type="date" value={historyFilters.date_to} onChange={e=>setHistoryFilters({...historyFilters,date_to:e.target.value})}/>
          </>}
        />
      </div>
      {historyLoading?<div className="empty-state">读取历史...</div>:<div className="table-scroll"><table className="data-table lifecycle-table">
        <thead><tr><th>日期</th><th>类型</th><th>员工ID</th><th>姓名</th><th>员工类型</th><th>国家</th><th>岗位</th><th>原因</th><th>来源</th></tr></thead>
        <tbody>{history.map(r=>{
          const s=r.snapshot||{}
          return <tr key={r.id}><td>{r.effective_date||'待补日期'}</td><td><span className={`event-chip event-${r.event_type}`}>{eventLabel(r.event_type)}</span></td><td><strong>{r.employee_no}</strong></td><td>{r.full_name||'-'}</td><td>{s.employment_type||'-'}</td><td>{s.country||'-'}</td><td>{s.position||'-'}</td><td>{r.reason||'-'}</td><td>{r.source_sheet||r.source||'-'}</td></tr>
        })}</tbody>
      </table></div>}
      <Pagination page={historyPage} pages={historyPages} total={historyTotal} pageSize={historyPageSize} loading={historyLoading} onPage={p=>{setHistoryPage(p);loadHistory(p,historyPageSize)}}/>
    </div>}

    {selected&&<EmployeeDrawer detail={selected} loading={detailLoading} onClose={()=>setSelected(null)} onEdit={openEdit} onResign={()=>setResignModal({employee_id:selected.employee.id,employee_no:selected.employee.employee_no,full_name:selected.employee.full_name,resign_date:'',reason:'',note:'',disable_portal:true})}/>}
    {employeeModal&&<EmployeeFormModal state={employeeModal} setState={setEmployeeModal} meta={meta} onClose={()=>setEmployeeModal(null)} onSave={saveEmployee}/>}
    {resignModal&&<ResignModal state={resignModal} setState={setResignModal} onClose={()=>setResignModal(null)} onSave={submitResign}/>}
  </div>
}

function EmployeeFormModal({state,setState,meta,onClose,onSave}){
  const f=state.form
  const e=f.employee
  const paymentMode=f.payment.mode==='unknown'?defaultPaymentMode(e.employment_type):f.payment.mode
  const setEmployee=(k,v)=>{
    const next={...e,[k]:v}
    let payment=f.payment
    if(k==='employment_type') payment={...payment,mode:defaultPaymentMode(v)}
    setState({...state,form:{...f,employee:next,payment}})
  }
  const setContact=(k,v)=>setState({...state,form:{...f,contact:{...f.contact,[k]:v}}})
  const setComp=(k,v)=>setState({...state,form:{...f,compensation:{...f.compensation,[k]:v}}})
  const setPayment=(k,v)=>setState({...state,form:{...f,payment:{...f.payment,[k]:v}}})

  return <div className="modal-mask employee-form-mask" onMouseDown={onClose}><div className="modal-card employee-form-modal" onMouseDown={ev=>ev.stopPropagation()}>
    <div className="modal-head employee-form-head"><div><span>{state.mode==='create'?'NEW EMPLOYEE':'EDIT EMPLOYEE'}</span><h2>{state.mode==='create'?'新增员工':'编辑员工资料'}</h2></div><button onClick={onClose}>×</button></div>

    <FormSection title="基本资料">
      <Field label="员工ID"><input disabled={state.mode==='edit'} value={e.employee_no} onChange={x=>setEmployee('employee_no',x.target.value.toUpperCase())}/></Field>
      <Field label="姓名"><input value={e.full_name} onChange={x=>setEmployee('full_name',x.target.value)}/></Field>
      <Field label="国家"><input value={e.country} onChange={x=>setEmployee('country',x.target.value)}/></Field>
      <Field label="国籍"><input value={e.nationality} onChange={x=>setEmployee('nationality',x.target.value)}/></Field>
      <Field label="员工类型"><select value={e.employment_type} onChange={x=>setEmployee('employment_type',x.target.value)}><option value="">请选择</option>{typeOptions.map(x=><option key={x}>{x}</option>)}</select></Field>
      <Field label="入职日期"><input type="date" value={e.hire_date} onChange={x=>setEmployee('hire_date',x.target.value)}/></Field>
    </FormSection>

    <FormSection title="组织与工作">
      <Field label="团队"><select value={e.team_id} onChange={x=>setEmployee('team_id',x.target.value)}><option value="">未设置</option>{meta.teams?.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      <Field label="岗位"><select value={e.position_id} onChange={x=>setEmployee('position_id',x.target.value)}><option value="">未设置</option>{meta.positions?.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="班次"><input value={e.shift_name} onChange={x=>setEmployee('shift_name',x.target.value)}/></Field>
      <Field label="组别"><input value={e.group_name} onChange={x=>setEmployee('group_name',x.target.value)}/></Field>
      <Field label="组长 / 负责人"><input value={e.leader_name} onChange={x=>setEmployee('leader_name',x.target.value)}/></Field>
      <Field label="培训老师"><input value={e.trainer_name} onChange={x=>setEmployee('trainer_name',x.target.value)}/></Field>
      <Field label="盘口国家"><input value={e.market_country} onChange={x=>setEmployee('market_country',x.target.value)}/></Field>
      <Field label="盘口岗位"><input value={e.market_position} onChange={x=>setEmployee('market_position',x.target.value)}/></Field>
      <Field label="盘口 / 平台"><input value={e.platform_scope} onChange={x=>setEmployee('platform_scope',x.target.value)}/></Field>
      <Field label="工作TG"><input value={e.work_tg} onChange={x=>setEmployee('work_tg',x.target.value)}/></Field>
      <Field label="后台账号"><input value={e.backend_accounts} onChange={x=>setEmployee('backend_accounts',x.target.value)}/></Field>
      <Field label="工作内容" wide><textarea value={e.work_content} onChange={x=>setEmployee('work_content',x.target.value)}/></Field>
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

    <FormSection title="工资设置" subtitle="这是员工当前工资基线；复杂考勤、满勤、绩效计算仍由工资模块按规则计算。">
      <Field label="底薪"><input type="number" step="0.01" value={f.compensation.base_salary} onChange={x=>setComp('base_salary',x.target.value)}/></Field>
      <Field label="默认绩效"><input type="number" step="0.01" value={f.compensation.performance_default} onChange={x=>setComp('performance_default',x.target.value)}/></Field>
      <Field label="餐补"><input type="number" step="0.01" value={f.compensation.meal_allowance} onChange={x=>setComp('meal_allowance',x.target.value)}/></Field>
      <Field label="币种"><select value={f.compensation.currency} onChange={x=>setComp('currency',x.target.value)}><option>USD</option><option>PHP</option><option>VND</option><option>IDR</option></select></Field>
      <Field label="生效日期"><input type="date" value={f.compensation.effective_from} onChange={x=>setComp('effective_from',x.target.value)}/></Field>
      <Field label="备注"><input value={f.compensation.note} onChange={x=>setComp('note',x.target.value)}/></Field>
    </FormSection>

    <FormSection title="收款资料" subtitle={paymentMode==='usdt'?'当前员工类型按 USDT 收款。':paymentMode==='bank_wallet'?'当前员工类型按银行卡 / 钱包收款。':'请确认收款方式。'}>
      <Field label="收款方式">
        <select value={paymentMode} onChange={x=>setPayment('mode',x.target.value)}><option value="unknown">待确认</option><option value="bank_wallet">银行卡 / 钱包</option><option value="usdt">USDT</option></select>
      </Field>
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
    </FormSection>

    <div className="modal-actions employee-form-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" onClick={onSave}>{state.mode==='create'?'创建员工':'保存修改'}</button></div>
  </div></div>
}

function EmployeeDrawer({detail,loading,onClose,onEdit,onResign}){
  const e=detail.employee||{}, c=detail.contact||{}, p=detail.payment||{}, comp=detail.compensation||{}
  const missing=detail.missing_fields||[]
  const full=Boolean(detail.permissions?.sensitive_payment_view)
  const paymentMode=p.mode||'unknown'
  const paymentTitle=paymentMode==='usdt'?'USDT 收款资料':paymentMode==='bank_wallet'?'银行卡 / 钱包收款资料':'收款资料'

  return <div className="modal-mask detail-mask" onMouseDown={onClose}><div className="employee-detail-drawer employee-detail-v12" onMouseDown={ev=>ev.stopPropagation()}>
    <div className="employee-hero">
      <div className="employee-avatar">{text(e.full_name).slice(0,1).toUpperCase()||'E'}</div>
      <div className="employee-hero-copy"><div className="employee-id-line">{e.employee_no}</div><h2>{e.full_name||'读取中...'}</h2><div className="employee-tags"><span>{typeName(e.employment_type)}</span><span>{e.teams?.name||'未匹配团队'}</span><span>{e.positions?.name||'未设置岗位'}</span></div></div>
      <div className="drawer-head-actions">{e.status!=='resigned'&&<button className="danger-outline" onClick={onResign}>办理离职</button>}<button className="edit-outline" onClick={onEdit}>编辑</button><button className="drawer-close" onClick={onClose}>×</button></div>
    </div>
    {loading?<div className="empty-state">读取完整档案...</div>:<>
      <div className={`profile-status-line ${missing.length?'has-missing':'is-complete'}`}><div><strong>{missing.length?`资料待完善 ${missing.length} 项`:'当前必填资料完整'}</strong><span>{missing.length?missing.join(' · '):'已通过当前员工类型的资料检查规则'}</span></div></div>
      <div className="detail-sections detail-sections-v11">
        <InfoPanel title="基本资料" rows={[['员工ID',e.employee_no],['姓名',e.full_name],['国家',e.country],['国籍',e.nationality],['员工类型',typeName(e.employment_type)],['状态',statusName(e.status)],['入职日期',text(e.hire_date).slice(0,10)],['离职日期',text(e.resign_date).slice(0,10)]]}/>
        <InfoPanel title="组织与排班" rows={[['团队',e.teams?.name],['岗位',e.positions?.name],['班次',e.shift_name],['组别',e.group_name],['组长 / 负责人',e.leader_name],['培训老师',e.trainer_name],['盘口',e.platform_scope],['工作内容',e.work_content]]}/>
        <InfoPanel title="联系方式" rows={[['工作TG',e.work_tg],['后台账号',e.backend_accounts],['Telegram',c.telegram_username],['Workfolio邮箱',c.work_email],['Zoom邮箱',c.zoom_email],['Facebook',c.facebook],['WhatsApp',c.whatsapp_phone]]}/>
        <InfoPanel title="工资设置" rows={[['底薪',money(comp.base_salary,comp.currency)],['默认绩效',money(comp.performance_default,comp.currency)],['餐补',money(comp.meal_allowance,comp.currency)],['币种',comp.currency],['生效日期',text(comp.effective_from).slice(0,10)],['备注',comp.note]]}/>
        <section className="detail-panel payment-panel-v11">
          <div className="detail-panel-head"><div><h3>{paymentTitle}</h3><p>{full?'你有敏感资料查看权限，显示完整值。':'完整号码不下发到浏览器，仅显示首尾，中间 **** 隐藏。'}</p></div><span className={full?'access-full':'access-masked'}>{full?'完整可见':'部分隐藏'}</span></div>
          {paymentMode==='usdt'?<div className="payment-primary"><span>USDT 地址</span><strong>{text(p.usdt_address)||'—'}</strong><small>收款方式：{p.transfer_using||'USDT'}</small></div>:paymentMode==='bank_wallet'?<div className="info-rows"><InfoRow label="收款方式" value={p.transfer_using}/><InfoRow label="银行卡 / 钱包账号" value={p.bank_wallet_account} mono/><InfoRow label="收款姓名" value={p.account_name}/></div>:<div className="empty-payment">当前收款方式待确认。</div>}
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
      <Field label="离职原因"><input value={state.reason} onChange={e=>setState({...state,reason:e.target.value})} placeholder="必须填写"/></Field>
      <Field label="备注" wide><textarea value={state.note} onChange={e=>setState({...state,note:e.target.value})}/></Field>
      <label className="checkbox-row form-wide"><input type="checkbox" checked={state.disable_portal} onChange={e=>setState({...state,disable_portal:e.target.checked})}/><span>同时停用员工 Portal 登录账号（员工历史资料不会删除）</span></label>
    </div>
    <div className="modal-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="danger-action" onClick={onSave}>确认离职</button></div>
  </div></div>
}

function FormSection({title,subtitle,children}){ return <section className="employee-form-section"><div className="employee-form-section-head"><h3>{title}</h3>{subtitle&&<p>{subtitle}</p>}</div><div className="employee-form-grid">{children}</div></section> }
function Field({label,children,wide}){ return <label className={wide?'form-field form-wide':'form-field'}><span>{label}</span>{children}</label> }
function InfoPanel({title,rows}){ return <section className="detail-panel"><div className="detail-panel-head"><h3>{title}</h3></div><div className="info-rows">{rows.map(([k,v])=><InfoRow key={k} label={k} value={v}/>)}</div></section> }
function InfoRow({label,value,mono}){ return <div className="info-row"><span>{label}</span><strong className={mono?'mono-value':''}>{text(value)||'—'}</strong></div> }
function Summary({label,value}){ return <div className="summary-card"><span>{label}</span><strong>{value??'—'}</strong></div> }
function money(v,currency){ if(v===null||v===undefined||v==='') return '—'; const n=Number(v); const value=Number.isInteger(n)?String(n):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,''); return `${value} ${currency||''}`.trim() }
