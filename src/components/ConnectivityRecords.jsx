import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Pagination } from './DataPageControls'

const text=value=>String(value??'').trim()
const today=()=>{
  const d=new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
const typeLabel=value=>({power_outage:'停电',internet_outage:'断网',both:'停电并断网',other:'其他'}[value]||value||'—')
const statusLabel=value=>({reported:'已记录',verified:'已核实',resolved:'已恢复',rejected:'不成立'}[value]||value||'—')
const impactLabel=value=>({none:'无影响',late:'迟到',interrupted:'工作中断',absent:'无法上班',other:'其他'}[value]||value||'—')
const durationLabel=value=>{
  const minutes=Number(value)
  if(!Number.isFinite(minutes)||minutes<=0)return '—'
  const hours=Math.floor(minutes/60),rest=minutes%60
  return `${hours?`${hours}小时`:''}${rest?`${rest}分钟`:''}`
}
const initialFilters=()=>({q:'',incident_type:'',status:'',date_from:'',date_to:''})
const initialRecord=()=>({employee_no:'',incident_date:today(),incident_type:'internet_outage',started_at:'',ended_at:'',duration_minutes:'',work_impact:'interrupted',status:'reported',details:'',evidence_url:''})

export function ConnectivityRecordsPage(){
  const [filters,setFilters]=useState(initialFilters)
  const [applied,setApplied]=useState(initialFilters)
  const [state,setState]=useState({loading:true,error:'',data:null})
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(30)
  const [showCreate,setShowCreate]=useState(false)
  const [record,setRecord]=useState(initialRecord)
  const [saving,setSaving]=useState(false)
  const [message,setMessage]=useState('')

  const load=async(nextPage=page,nextSize=pageSize,nextFilters=applied)=>{
    setState(current=>({...current,loading:true,error:''}))
    const {data,error}=await supabase.rpc('admin_connectivity_home',{p_filters:{...nextFilters,page:nextPage,page_size:nextSize}})
    if(error)setState({loading:false,error:error.message,data:null})
    else setState({loading:false,error:'',data:data||null})
  }
  useEffect(()=>{load(1,pageSize,applied)},[])

  const query=()=>{const next={...filters};setApplied(next);setPage(1);load(1,pageSize,next)}
  const reset=()=>{const next=initialFilters();setFilters(next);setApplied(next);setPage(1);load(1,pageSize,next)}
  const save=async()=>{
    setSaving(true);setMessage('')
    const {data,error}=await supabase.rpc('admin_connectivity_create',{p_record:record})
    setSaving(false)
    if(error){setMessage(error.message==='employee_not_found'?'找不到这个员工ID，请核对后再保存。':`保存失败：${error.message}`);return}
    setMessage(`已记录 ${data.employee_no} 的停电/断网情况。`)
    setRecord(initialRecord());setShowCreate(false);setPage(1);await load(1,pageSize,applied)
  }
  const data=state.data||{},summary=data.summary||{},rows=data.rows||[]
  return <div className="connectivity-page">
    <div className="connectivity-head"><div><h2>停电 / 断网记录</h2></div>{data.permissions?.create&&<button className="primary-action" onClick={()=>setShowCreate(value=>!value)}>{showCreate?'取消录入':'+ 新增记录'}</button>}</div>
    {message&&<div className={`connectivity-message ${message.startsWith('保存失败')||message.startsWith('找不到')?'error':''}`}>{message}</div>}
    {showCreate&&<section className="connectivity-create-card">
      <div className="connectivity-form-grid">
        <label>员工ID<input value={record.employee_no} onChange={event=>setRecord({...record,employee_no:event.target.value})} placeholder="输入员工ID，例如 CS000134"/></label>
        <label>发生日期<input type="date" value={record.incident_date} onChange={event=>setRecord({...record,incident_date:event.target.value})}/></label>
        <label>问题类型<select value={record.incident_type} onChange={event=>setRecord({...record,incident_type:event.target.value})}><option value="power_outage">停电</option><option value="internet_outage">断网</option><option value="both">停电并断网</option><option value="other">其他</option></select></label>
        <label>影响<select value={record.work_impact} onChange={event=>setRecord({...record,work_impact:event.target.value})}><option value="none">无影响</option><option value="late">迟到</option><option value="interrupted">工作中断</option><option value="absent">无法上班</option><option value="other">其他</option></select></label>
        <label>开始时间<input type="time" value={record.started_at} onChange={event=>setRecord({...record,started_at:event.target.value})}/></label>
        <label>恢复时间<input type="time" value={record.ended_at} onChange={event=>setRecord({...record,ended_at:event.target.value})}/></label>
        <label>持续分钟<input type="number" min="0" max="10080" value={record.duration_minutes} onChange={event=>setRecord({...record,duration_minutes:event.target.value})} placeholder="可留空，按时间自动计算"/></label>
        <label>状态<select value={record.status} onChange={event=>setRecord({...record,status:event.target.value})}><option value="reported">已记录</option><option value="verified">已核实</option><option value="resolved">已恢复</option><option value="rejected">不成立</option></select></label>
        <label className="wide">情况说明<textarea value={record.details} onChange={event=>setRecord({...record,details:event.target.value})} placeholder="填写原因、对工作的影响、恢复情况等"/></label>
        <label className="wide">证明链接（可选）<input value={record.evidence_url} onChange={event=>setRecord({...record,evidence_url:event.target.value})} placeholder="截图或证明文件链接"/></label>
      </div>
      <div className="connectivity-form-actions"><button className="primary-action" disabled={saving||!text(record.employee_no)} onClick={save}>{saving?'保存中…':'保存记录'}</button></div>
    </section>}
    <section className="connectivity-filter-card"><div className="connectivity-filter-grid">
      <label>员工<input value={filters.q} onChange={event=>setFilters({...filters,q:event.target.value})} onKeyDown={event=>event.key==='Enter'&&query()} placeholder="员工ID / 姓名"/></label>
      <label>问题类型<select value={filters.incident_type} onChange={event=>setFilters({...filters,incident_type:event.target.value})}><option value="">全部类型</option><option value="power_outage">停电</option><option value="internet_outage">断网</option><option value="both">停电并断网</option><option value="other">其他</option></select></label>
      <label>状态<select value={filters.status} onChange={event=>setFilters({...filters,status:event.target.value})}><option value="">全部状态</option><option value="reported">已记录</option><option value="verified">已核实</option><option value="resolved">已恢复</option><option value="rejected">不成立</option></select></label>
      <label>日期起<input type="date" value={filters.date_from} onChange={event=>setFilters({...filters,date_from:event.target.value})}/></label>
      <label>日期止<input type="date" value={filters.date_to} onChange={event=>setFilters({...filters,date_to:event.target.value})}/></label>
      <div className="connectivity-filter-actions"><button className="primary-action" onClick={query} disabled={state.loading}>{state.loading?'查询中…':'查询'}</button><button className="secondary-action" onClick={reset}>重置</button></div>
    </div></section>
    <div className="connectivity-summary"><div><span>记录总数</span><strong>{summary.total||0}</strong></div><div><span>涉及员工</span><strong>{summary.affected_employees||0}</strong></div><div><span>停电</span><strong>{summary.power||0}</strong></div><div><span>断网</span><strong>{summary.internet||0}</strong></div><div><span>同时发生</span><strong>{summary.both||0}</strong></div></div>
    <section className="connectivity-table-card">
      {state.error?<div className="connectivity-empty error">{state.error}</div>:state.loading&&!data.rows?<div className="connectivity-empty">正在读取记录…</div>:rows.length?<div className="connectivity-table-wrap"><table><thead><tr><th>日期</th><th>员工ID</th><th>姓名</th><th>团队 / 岗位</th><th>类型</th><th>开始 / 恢复</th><th>持续</th><th>影响</th><th>状态</th><th>情况说明</th><th>录入人</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><strong>{row.incident_date}</strong></td><td>{row.employee_no}</td><td>{row.full_name}</td><td>{row.team_name||'—'}<small>{row.position_name||'—'}</small></td><td><span className={`connectivity-type ${row.incident_type}`}>{typeLabel(row.incident_type)}</span></td><td>{text(row.started_at).slice(0,5)||'—'} / {text(row.ended_at).slice(0,5)||'—'}</td><td>{durationLabel(row.duration_minutes)}</td><td>{impactLabel(row.work_impact)}</td><td><span className={`connectivity-status ${row.status}`}>{statusLabel(row.status)}</span></td><td className="connectivity-details">{row.details||'—'}{row.evidence_url&&<a href={row.evidence_url} target="_blank" rel="noreferrer">查看证明</a>}</td><td>{row.recorded_by_name||'—'}</td></tr>)}</tbody></table></div>:<div className="connectivity-empty">暂无符合条件的记录</div>}
      <Pagination page={Number(data.page||page)} pages={Number(data.pages||1)} total={Number(data.total||0)} pageSize={pageSize} loading={state.loading} onPage={next=>{setPage(next);load(next,pageSize,applied)}} onPageSize={next=>{setPageSize(next);setPage(1);load(1,next,applied)}}/>
    </section>
  </div>
}

export function EmployeeConnectivityPanel({data,loading,error}){
  const rows=data?.rows||[]
  return <section className="detail-panel employee-connectivity-panel"><div className="detail-panel-head"><h3>停电 / 断网记录</h3><span className="employee-exam-count">{data?.total||0} 条</span></div>{loading?<div className="connectivity-empty">正在读取记录…</div>:error?<div className="connectivity-empty error">{error}</div>:rows.length?<div className="employee-connectivity-list">{rows.map(row=><article key={row.id}><div><strong>{row.incident_date}</strong><span className={`connectivity-type ${row.incident_type}`}>{typeLabel(row.incident_type)}</span></div><div><small>时间 / 持续</small><p>{text(row.started_at).slice(0,5)||'—'} → {text(row.ended_at).slice(0,5)||'—'} · {durationLabel(row.duration_minutes)}</p></div><div><small>工作影响 / 状态</small><p>{impactLabel(row.work_impact)} · {statusLabel(row.status)}</p></div><div className="wide"><small>情况说明</small><p>{row.details||'—'}</p></div></article>)}</div>:<div className="connectivity-empty">暂无停电或断网记录</div>}</section>
}

export function EmployeePayrollHistoryPanel({data,loading,error}){
  const rows=data?.rows||[]
  const money=(value,currency)=>{try{return new Intl.NumberFormat('zh-CN',{style:'currency',currency:currency||'USD',maximumFractionDigits:2}).format(Number(value||0))}catch{return `${Number(value||0).toLocaleString()} ${currency||''}`}}
  return <section className="detail-panel employee-payroll-panel"><div className="detail-panel-head"><h3>工资记录</h3><span className="employee-exam-count">{data?.total||0} 份</span></div>{loading?<div className="connectivity-empty">正在读取工资记录…</div>:error?<div className="connectivity-empty error">{error}</div>:rows.length?<div className="employee-payroll-list">{rows.map(row=><article key={row.id}><header><div><strong>{String(row.period_start).slice(0,7)}</strong><span>{row.title}</span></div><span className={`payroll-match ${row.status==='published'?'ok':'neutral'}`}>{row.status==='published'?'已发布':'待发布'}</span></header><div className="employee-payroll-grid"><span><small>基础工资</small><b>{money(row.base_salary,row.currency)}</b></span><span><small>出勤工资</small><b>{money(row.attendance_salary,row.currency)}</b></span><span><small>扣款 / 调整</small><b>{money(Number(row.leave_deduction||0)+Number(row.late_deduction||0)+Number(row.absence_deduction||0)+Number(row.performance_adjustment||0)+Number(row.deposit_adjustment||0),row.currency)}</b></span><span><small>实发工资</small><b className="total">{money(row.total_pay,row.currency)}</b></span></div>{row.remark&&<p>{row.remark}</p>}</article>)}</div>:<div className="connectivity-empty">暂无工资记录</div>}</section>
}

export function EmployeeProfileMetrics({data,loading}){
  const total=Number(data?.total_errors||0)
  const grade=total>=20?'高频':total>=10?'重点':total>=5?'注意':total===0?'优秀':'正常'
  return <div className="wfh-v2722-risk-summary" data-grade={grade} data-profile-metrics="1"><div className="risk-grade"><span>等级</span><strong>{grade}</strong></div><div><span>本月记录</span><strong>{loading?'—':`${Number(data?.month_records||0)} 笔`}</strong></div><div><span>总错误</span><strong>{loading?'—':`${total} 笔`}</strong></div><div><span>考试总次数</span><strong>{loading?'—':`${Number(data?.exam_attempts||0)} 次`}</strong></div><div><span>平均考试分数</span><strong>{loading?'—':data?.exam_average==null?'—':`${Number(data.exam_average).toFixed(1)} 分`}</strong></div></div>
}
