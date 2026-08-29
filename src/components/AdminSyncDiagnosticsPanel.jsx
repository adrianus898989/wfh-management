import React,{useEffect,useMemo,useRef,useState} from 'react'
import {Pagination} from './DataPageControls'
import {supabase} from '../lib/supabase'
import {
  ADMIN_SYNC_DIAGNOSTIC_META,
  adminSyncDiagnosticEvidence,
  adminSyncDiagnosticLabel,
  adminSyncDiagnosticSourceRows,
} from '../lib/adminSyncDiagnostics'

const numeric=value=>Number.isFinite(Number(value))?Number(value):0
const clean=value=>String(value??'').trim()
const formatTime=(value,locale)=>{
  if(!value)return '—'
  const parsed=new Date(value)
  if(Number.isNaN(parsed.getTime()))return clean(value)
  return new Intl.DateTimeFormat(locale==='en'?'en-GB':'zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(parsed)
}

async function readDiagnostics(filters,page,pageSize,signal){
  const query=supabase.rpc('admin_sync_diagnostics',{p_filters:filters,p_page:page,p_page_size:pageSize})
  const {data,error}=signal?await query.abortSignal(signal):await query
  if(error)throw error
  return data||{rows:[],total:0,page,pages:1,page_size:pageSize,summary:{}}
}

export function AdminSyncDiagnosticsPanel({open,locale='zh'}){
  const requestRef=useRef(0)
  const controllerRef=useRef(null)
  const [draft,setDraft]=useState({search:'',kind:'all',issue_code:''})
  const [filters,setFilters]=useState(draft)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(20)
  const [state,setState]=useState({loaded:false,loading:false,error:'',rows:[],total:0,pages:1,summary:{}})
  const labels=useMemo(()=>Object.entries(ADMIN_SYNC_DIAGNOSTIC_META).sort((a,b)=>a[1][locale].localeCompare(b[1][locale])),[locale])

  const load=async(nextPage=page,nextSize=pageSize,nextFilters=filters)=>{
    const requestId=++requestRef.current
    controllerRef.current?.abort()
    const controller=new AbortController()
    controllerRef.current=controller
    const timer=window.setTimeout(()=>controller.abort(),5000)
    setState(current=>({...current,loading:true,error:''}))
    try{
      const data=await readDiagnostics(nextFilters,nextPage,nextSize,controller.signal)
      if(requestId!==requestRef.current)return
      setState({loaded:true,loading:false,error:'',rows:Array.isArray(data.rows)?data.rows:[],total:numeric(data.total),pages:Math.max(1,numeric(data.pages)),summary:data.summary||{}})
    }catch(error){
      if(requestId!==requestRef.current)return
      const aborted=controller.signal.aborted
      setState(current=>({...current,loaded:true,loading:false,error:aborted?(locale==='en'?'The diagnostic read reached its 5-second safety limit. Retry without affecting other pages.':'同步差异读取达到 5 秒安全上限；可重试，不会影响其他页面。'):(clean(error?.message)||(locale==='en'?'Unable to read sync diagnostics.':'同步差异读取失败。'))}))
    }finally{
      window.clearTimeout(timer)
      if(controllerRef.current===controller)controllerRef.current=null
    }
  }

  useEffect(()=>{
    if(!open||state.loaded)return
    load(1,pageSize,filters)
    return()=>{
      requestRef.current+=1
      controllerRef.current?.abort()
      controllerRef.current=null
    }
  },[open])

  if(!open)return null
  const summary=state.summary||{}
  const attendance=summary.attendance||{}
  const run=summary.latest_employee_master_run||{}
  const apply=()=>{const next={...draft};setFilters(next);setPage(1);load(1,pageSize,next)}
  const reset=()=>{const next={search:'',kind:'all',issue_code:''};setDraft(next);setFilters(next);setPage(1);load(1,pageSize,next)}

  return <section className="admin-sync-diagnostics" data-admin-i18n-skip>
    <header><div><small>{locale==='en'?'SYNC QUALITY':'同步质量'}</small><h3>{locale==='en'?'Mismatch and import diagnostics':'同步差异与原因'}</h3><p>{locale==='en'?'Read from persisted import results only. This page never scans Google Sheets live.':'只读取已保存的导入结果；打开本页不会实时扫描 Google 表格。'}</p></div><button type="button" onClick={()=>load(page,pageSize,filters)} disabled={state.loading}>{state.loading?(locale==='en'?'Reading…':'读取中…'):(locale==='en'?'Refresh':'刷新')}</button></header>
    <div className="admin-sync-summary">
      <div><span>{locale==='en'?'Employee issues':'员工来源待核对'}</span><strong>{numeric(summary.employee_issue_total)}</strong><small>{locale==='en'?'latest successful run':'最近一次成功同步'}</small></div>
      <div><span>{locale==='en'?'Unmatched rows':'表格未匹配行'}</span><strong>{numeric(attendance.unmatched_count)}</strong><small>{locale==='en'?'persisted source totals':'当前来源统计'}</small></div>
      <div><span>{locale==='en'?'Ambiguous rows':'多人匹配行'}</span><strong>{numeric(attendance.ambiguous_count)}</strong><small>{locale==='en'?'requires identity review':'需要核对身份'}</small></div>
      <div><span>{locale==='en'?'Latest employee sync':'员工最近同步'}</span><strong>{formatTime(run.finished_at||run.captured_at,locale)}</strong><small>{run.status||'—'} · {numeric(run.home_rows)+numeric(run.schedule_rows)} {locale==='en'?'source rows':'来源行'}</small></div>
    </div>
    <div className="admin-sync-filters">
      <label><span>{locale==='en'?'Search':'综合搜索'}</span><input value={draft.search} onChange={event=>setDraft(current=>({...current,search:event.target.value}))} onKeyDown={event=>event.key==='Enter'&&apply()} placeholder={locale==='en'?'Employee ID, name, source or reason':'员工 ID、姓名、来源或原因'}/></label>
      <label><span>{locale==='en'?'Area':'同步模块'}</span><select value={draft.kind} onChange={event=>setDraft(current=>({...current,kind:event.target.value}))}><option value="all">{locale==='en'?'All':'全部'}</option><option value="employee_master">{locale==='en'?'Employee master':'员工档案'}</option><option value="attendance">{locale==='en'?'Attendance / adjustments':'考勤 / 奖惩'}</option></select></label>
      <label><span>{locale==='en'?'Reason':'差异原因'}</span><select value={draft.issue_code} onChange={event=>setDraft(current=>({...current,issue_code:event.target.value}))}><option value="">{locale==='en'?'All reasons':'全部原因'}</option>{labels.map(([code,meta])=><option key={code} value={code}>{meta[locale]}</option>)}</select></label>
      <div><button type="button" onClick={apply} disabled={state.loading}>{locale==='en'?'Search':'查询'}</button><button type="button" className="secondary" onClick={reset} disabled={state.loading}>{locale==='en'?'Reset':'重置'}</button></div>
    </div>
    {state.error&&<div className="admin-sync-error" role="alert">{state.error}</div>}
    <div className="admin-sync-table">
      <div className="admin-sync-table-head"><span>{locale==='en'?'Module / source':'模块 / 来源'}</span><span>{locale==='en'?'Employee':'员工'}</span><span>{locale==='en'?'Mismatch':'差异原因'}</span><span>{locale==='en'?'Evidence':'具体误差'}</span><span>{locale==='en'?'Source row':'来源行'}</span><span>{locale==='en'?'Detected':'检测时间'}</span></div>
      {state.loading&&!state.loaded?<div className="admin-sync-empty">{locale==='en'?'Reading bounded diagnostics…':'正在读取限定范围的同步差异…'}</div>:!state.rows.length?<div className="admin-sync-empty">{locale==='en'?'No matching persisted discrepancies.':'没有符合筛选条件的已记录差异。'}</div>:state.rows.map(row=><article key={`${row.diagnostic_kind}:${row.diagnostic_id}`}>
        <div><b>{row.diagnostic_kind==='employee_master'?(locale==='en'?'Employee master':'员工档案'):(locale==='en'?'Attendance / adjustments':'考勤 / 奖惩')}</b><span>{row.source_name||row.source_month||'—'}</span></div>
        <div><b>{row.employee_no||'—'}</b><span>{row.employee_name||'—'}</span></div>
        <strong>{adminSyncDiagnosticLabel(row.issue_code,locale)}</strong>
        <ul>{adminSyncDiagnosticEvidence(row,locale).map((item,index)=><li key={`${item}:${index}`}>{item}</li>)}</ul>
        <span>{adminSyncDiagnosticSourceRows(row,locale)}</span>
        <time>{formatTime(row.detected_at,locale)}</time>
      </article>)}
    </div>
    <Pagination page={page} pages={state.pages} total={state.total} pageSize={pageSize} pageSizeOptions={[20,30,50]} loading={state.loading} onPage={next=>{setPage(next);load(next,pageSize,filters)}} onPageSize={next=>{setPageSize(next);setPage(1);load(1,next,filters)}}/>
  </section>
}
