import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const text = v => String(v ?? '').trim()
const statusName = s => ({active:'在职',inactive:'停用',resigned:'离职'}[s] || s || '-')
const legacyType = {home_ph:'纯居家菲律宾',onsite_to_home:'现场转居家',home_vn:'纯居家越南',home_id:'纯居家印尼',home_mm:'纯居家缅甸'}
const typeName = v => legacyType[text(v)] || text(v) || '-'
const freshEmployee = () => ({employee_no:'',full_name:'',country:'',nationality:'',employment_type:'',team_id:'',position_id:'',status:'active'})

const paymentLabels = [
  ['transfer_using','收款方式'],
  ['gcash_account','GCash / 银行账号'],
  ['gcash_name','收款姓名'],
  ['usdt_address','USDT 地址'],
  ['contact_phone','联系电话'],
  ['whatsapp_number','WhatsApp'],
  ['facebook','Facebook'],
  ['employee_address','员工地址'],
]

export default function AdminEmployeesPage(){
  const [sp,setSp] = useSearchParams()
  const tabs=['员工档案','团队管理','岗位管理','入离职记录']
  const [tab,setTabState]=useState(tabs.includes(sp.get('tab'))?sp.get('tab'):'员工档案')
  const [meta,setMeta]=useState({teams:[],positions:[],total:0,active:0,no_team:0,official_id_pending:0})
  const [rows,setRows]=useState([])
  const [total,setTotal]=useState(0)
  const [page,setPage]=useState(1)
  const pageSize=100
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [selected,setSelected]=useState(null)
  const [detailLoading,setDetailLoading]=useState(false)
  const [showCreate,setShowCreate]=useState(false)
  const [form,setForm]=useState(freshEmployee())
  const [generated,setGenerated]=useState(null)
  const [showFilters,setShowFilters]=useState(true)
  const [filters,setFilters]=useState({
    keyword:'',team_id:'',position_id:'',country:'',status:'active',employment_type:'',
    shift_name:'',profile_status:'',leader:'',hire_from:'',hire_to:'',
  })
  const first=useRef(true)

  const invoke=async body=>{
    const {data,error}=await supabase.functions.invoke('admin-employees',{body})
    if(error || data?.error) throw new Error(data?.error || error?.message || '读取失败')
    return data
  }
  const adminCall=async body=>{
    const {data,error}=await supabase.functions.invoke('admin-accounts',{body})
    if(error || data?.error) throw new Error(data?.error || error?.message || '操作失败')
    return data
  }

  const loadMeta=async()=>{
    try{ setMeta(await invoke({action:'meta'})) }catch(e){ setError(e.message) }
  }

  const loadList=async(nextPage=page)=>{
    setLoading(true); setError('')
    try{
      const data=await invoke({action:'list',page:nextPage,page_size:pageSize,filters})
      setRows(data.rows||[]); setTotal(data.total||0)
    }catch(e){ setError(e.message) }
    finally{ setLoading(false) }
  }

  useEffect(()=>{ loadMeta() },[])
  useEffect(()=>{
    if(first.current){ first.current=false; loadList(1); return }
    const t=setTimeout(()=>{ setPage(1); loadList(1) },280)
    return()=>clearTimeout(t)
  },[JSON.stringify(filters)])

  useEffect(()=>{ const t=sp.get('tab'); if(tabs.includes(t)) setTabState(t) },[sp])

  const setTab=v=>{ setTabState(v); setSp(v==='员工档案'?{}:{tab:v}) }

  const openDetail=async row=>{
    setSelected({employee:row,missing_fields:row.missing_fields||[],loading:true})
    setDetailLoading(true)
    try{ setSelected(await invoke({action:'detail',employee_id:row.id})) }
    catch(e){ setError(e.message); setSelected(null) }
    finally{ setDetailLoading(false) }
  }

  const createEmployee=async()=>{
    try{
      await adminCall({action:'create_employee',...form})
      setShowCreate(false); setForm(freshEmployee())
      await Promise.all([loadMeta(),loadList(1)])
    }catch(e){ setError(e.message) }
  }

  const generateCode=async employeeNo=>{
    setGenerated(null); setError('')
    const {data,error}=await supabase.rpc('generate_employee_activation_code',{p_employee_no:employeeNo,p_valid_hours:72})
    if(error) return setError(error.message)
    setGenerated(data?.[0]||null)
  }

  const pages=Math.max(1,Math.ceil(total/pageSize))
  const countries=useMemo(()=>[],[]) // 国家搜索使用文本输入，避免先拉全表
  const clear=()=>setFilters({keyword:'',team_id:'',position_id:'',country:'',status:'active',employment_type:'',shift_name:'',profile_status:'',leader:'',hire_from:'',hire_to:''})

  return <div className="content-page employee-page pro-employee-page">
    <div className="module-title-row">
      <div><div className="module-kicker">PEOPLE & ORGANIZATION</div><h1>员工管理</h1><p className="page-subtitle">分页读取 Supabase，不再受 1000 条限制；敏感收款资料按权限返回完整值或遮罩值。</p></div>
      {tab==='员工档案'&&<button className="primary-action" onClick={()=>setShowCreate(true)}>+ 新增员工</button>}
    </div>

    <div className="module-tabs">{tabs.map(x=><button key={x} className={tab===x?'active':''} onClick={()=>setTab(x)}>{x}</button>)}</div>

    <div className="module-summary-grid employee-summary-grid">
      <Summary label="员工总数" value={meta.total}/>
      <Summary label="在职员工" value={meta.active}/>
      <Summary label="团队记录" value={meta.teams?.length||0}/>
      <Summary label="未匹配团队" value={meta.no_team}/>
      <Summary label="待补正式ID" value={meta.official_id_pending}/>
    </div>

    {error&&<div className="page-error">{error}</div>}

    {tab==='员工档案'&&<>
      <div className="filter-card">
        <div className="filter-main-row">
          <div className="search-box"><span>⌕</span><input value={filters.keyword} onChange={e=>setFilters({...filters,keyword:e.target.value})} placeholder="搜索员工ID / 姓名 / 工作账号 / TG / 组长 / 培训 / 盘口"/></div>
          <div className="filter-actions"><button className="secondary-action" onClick={()=>setShowFilters(v=>!v)}>{showFilters?'收起筛选':'更多筛选'}</button><button className="secondary-action" onClick={clear}>重置</button></div>
        </div>
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

      <div className="list-meta-row">
        <span>共 {total} 人 · 当前第 {page}/{pages} 页</span>
        <span>{total?`${(page-1)*pageSize+1}–${Math.min(page*pageSize,total)}`:'0'} / {total}</span>
      </div>

      {generated&&<div className="activation-banner"><div><span>{generated.employee_no} · {generated.employee_name}</span><strong>{generated.activation_code}</strong></div><button onClick={()=>navigator.clipboard.writeText(generated.activation_code)}>复制激活码</button></div>}

      <div className="data-card">
        {loading?<div className="empty-state">读取中...</div>:rows.length===0?<div className="empty-state">暂无符合条件的员工</div>:<div className="table-scroll"><table className="data-table employee-master-table">
          <thead><tr><th>员工ID</th><th>姓名</th><th>国家</th><th>团队</th><th>组长</th><th>岗位</th><th>班次</th><th>员工类型</th><th>入职日期</th><th>资料完整度</th><th>账号</th><th>操作</th></tr></thead>
          <tbody>{rows.map(r=><tr key={r.id}>
            <td><strong>{r.employee_no}</strong></td><td>{r.full_name}</td><td>{r.country||r.nationality||'-'}</td><td>{r.teams?.name||'-'}</td><td>{r.leader_name||'-'}</td><td>{r.positions?.name||'-'}</td><td>{r.shift_name||'-'}</td><td>{typeName(r.employment_type)}</td><td>{text(r.hire_date).slice(0,10)||'-'}</td>
            <td>{r.missing_count>0?<span className="missing-chip">缺失 {r.missing_count} 项</span>:<span className="profile-chip">资料完整</span>}</td>
            <td>{r.account_opened?<span className="status-chip">已开通</span>:<span className="status-chip off">未开通</span>}</td>
            <td><div className="row-actions"><button className="table-action" onClick={()=>openDetail(r)}>查看</button>{!r.account_opened&&<button className="table-action" onClick={()=>generateCode(r.employee_no)}>激活码</button>}</div></td>
          </tr>)}</tbody>
        </table></div>}
      </div>

      <div className="pagination-bar">
        <button disabled={page<=1||loading} onClick={()=>{const p=page-1;setPage(p);loadList(p)}}>上一页</button>
        <span>第 {page} / {pages} 页</span>
        <button disabled={page>=pages||loading} onClick={()=>{const p=page+1;setPage(p);loadList(p)}}>下一页</button>
      </div>
    </>}

    {tab==='团队管理'&&<div className="data-card"><div className="section-head"><div><h2>团队管理</h2><p>团队维护功能继续保留；当前团队来自已导入排班数据。</p></div><span>{meta.teams?.length||0} 条</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>团队</th><th>国家</th><th>状态</th></tr></thead><tbody>{meta.teams?.map(t=><tr key={t.id}><td><strong>{t.name}</strong></td><td>{t.country||'-'}</td><td>{t.status||'-'}</td></tr>)}</tbody></table></div></div>}
    {tab==='岗位管理'&&<div className="data-card"><div className="section-head"><div><h2>岗位管理</h2><p>岗位与工资规则以后继续关联。</p></div><span>{meta.positions?.length||0} 条</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>岗位</th><th>编码</th><th>工资封顶</th><th>币种</th><th>状态</th></tr></thead><tbody>{meta.positions?.map(p=><tr key={p.id}><td><strong>{p.name}</strong></td><td>{p.code||'-'}</td><td>{p.salary_cap??'-'}</td><td>{p.currency||'-'}</td><td>{p.status||'-'}</td></tr>)}</tbody></table></div></div>}
    {tab==='入离职记录'&&<div className="data-card module-empty"><div><h2>入职 / 离职记录</h2><p>下一小步会接 Google Sheet ↔ Supabase 双向同步，同时记录每一次新人 / 离职变更来源。</p></div></div>}

    {showCreate&&<div className="modal-mask" onMouseDown={()=>setShowCreate(false)}><div className="modal-card" onMouseDown={e=>e.stopPropagation()}>
      <div className="modal-head"><h2>新增员工</h2><button onClick={()=>setShowCreate(false)}>×</button></div>
      <div className="form-grid">
        <label>员工ID<input value={form.employee_no} onChange={e=>setForm({...form,employee_no:e.target.value.toUpperCase()})}/></label>
        <label>姓名<input value={form.full_name} onChange={e=>setForm({...form,full_name:e.target.value})}/></label>
        <label>国家<input value={form.country} onChange={e=>setForm({...form,country:e.target.value})}/></label>
        <label>国籍<input value={form.nationality} onChange={e=>setForm({...form,nationality:e.target.value})}/></label>
        <label>员工类型<input value={form.employment_type} onChange={e=>setForm({...form,employment_type:e.target.value})} placeholder="例如：纯居家菲律宾"/></label>
        <label>团队<select value={form.team_id} onChange={e=>setForm({...form,team_id:e.target.value})}><option value="">未设置</option>{meta.teams?.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label>岗位<select value={form.position_id} onChange={e=>setForm({...form,position_id:e.target.value})}><option value="">未设置</option>{meta.positions?.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>状态<select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option value="active">在职</option><option value="inactive">停用</option><option value="resigned">离职</option></select></label>
      </div>
      <div className="modal-actions"><button className="secondary-action" onClick={()=>setShowCreate(false)}>取消</button><button className="primary-action" onClick={createEmployee}>创建员工</button></div>
    </div></div>}

    {selected&&<EmployeeDrawer detail={selected} loading={detailLoading} onClose={()=>setSelected(null)}/>}
  </div>
}

function EmployeeDrawer({detail,loading,onClose}){
  const e=detail.employee||{}
  const contact=detail.contact||{}
  const pay=detail.payment||{}
  const missing=detail.missing_fields||[]
  const canSensitive=Boolean(detail.permissions?.sensitive_payment_view)

  return <div className="modal-mask detail-mask" onMouseDown={onClose}><div className="employee-detail-drawer" onMouseDown={ev=>ev.stopPropagation()}>
    <div className="detail-head"><div><span>{e.employee_no}</span><h2>{e.full_name||'读取中...'}</h2><p>{typeName(e.employment_type)} · {e.teams?.name||'未匹配团队'} · {e.positions?.name||'未设置岗位'}</p></div><button onClick={onClose}>×</button></div>
    {loading?<div className="empty-state">读取完整档案...</div>:<>
      {missing.length>0?<div className="missing-banner"><strong>⚠ 资料缺失 {missing.length} 项</strong><div>{missing.map(x=><span key={x}>{x}</span>)}</div></div>:<div className="complete-banner">✓ 当前必填资料完整</div>}
      <div className="detail-sections">
        <DetailSection title="基本资料" rows={[
          ['员工ID',e.employee_no],['姓名',e.full_name],['国家',e.country],['国籍',e.nationality],
          ['员工类型',typeName(e.employment_type)],['状态',statusName(e.status)],['入职日期',text(e.hire_date).slice(0,10)],['离职日期',text(e.resign_date).slice(0,10)],
        ]}/>
        <DetailSection title="组织与排班" rows={[
          ['团队',e.teams?.name],['岗位',e.positions?.name],['班次',e.shift_name],['组别',e.group_name],
          ['组长 / 负责人',e.leader_name],['培训老师',e.trainer_name],['盘口',e.platform_scope],['工作内容',e.work_content],
        ]}/>
        <DetailSection title="联系方式" rows={[
          ['工作TG',e.work_tg],['后台账号',e.backend_accounts],['Telegram',contact.telegram_username],['Workfolio邮箱',contact.work_email],
          ['Zoom邮箱',contact.zoom_email],['Facebook',contact.facebook],['WhatsApp',contact.whatsapp_phone],['资料来源',e.source_sheet],
        ]}/>
        <section className="detail-section">
          <div className="sensitive-head"><div><h3>收款资料</h3><p>{canSensitive?'你有「敏感收款资料查看」权限，显示完整资料。':'无敏感查看权限，仅显示首尾，中间以 **** 隐藏。'}</p></div><span className={canSensitive?'unlock-chip':'lock-chip'}>{canSensitive?'完整可见':'已遮罩'}</span></div>
          <div className="detail-grid">{paymentLabels.map(([key,label])=><div className="detail-item" key={key}><span>{label}</span><strong className="sensitive-value">{text(pay[key])||'—'}</strong></div>)}</div>
        </section>
      </div>
    </>}
  </div></div>
}

function DetailSection({title,rows}){ return <section className="detail-section"><h3>{title}</h3><div className="detail-grid">{rows.map(([k,v])=><div className="detail-item" key={k}><span>{k}</span><strong>{text(v)||'—'}</strong></div>)}</div></section> }
function Summary({label,value}){ return <div className="summary-card"><span>{label}</span><strong>{value??'—'}</strong></div> }
