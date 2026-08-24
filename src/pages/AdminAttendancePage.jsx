import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Pagination } from '../components/DataPageControls'
import { attendanceAmount, attendanceKindLabel, attendanceSourceGroupLabel } from '../components/AttendanceRecords'
import { supabase } from '../lib/supabase'
import { EmployeeDrawer } from './AdminEmployeesPage'

const TABS=['排班表','今日考勤','考勤记录','请假审批','换班记录','奖金 / 扣款']
const text=value=>String(value??'').trim()
const todayIso=()=>{
  const date=new Date()
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
const emptyFilters=()=>({search:'',date_from:'',date_to:'',source_month:'',source_group:'',event_kind:'',employee_status:'',team:'',position:'',country:'',platform:'',manager:'',match_status:''})
const tabFilters=tab=>{
  const next=emptyFilters()
  if(tab==='今日考勤')next.date_from=next.date_to=todayIso()
  if(tab==='请假审批')next.event_kind='leave'
  return next
}
const requestTab=tab=>!['排班表','换班记录'].includes(tab)
const tabScope=tab=>tab==='奖金 / 扣款'?'adjustment':'attendance'
const employeeStatusLabel=value=>({active:'在职',probation:'试用',suspended:'停用',inactive:'停用',resigned:'离职',unmatched:'未匹配'}[text(value).toLowerCase()]||text(value)||'—')
const matchStatusLabel=value=>({matched:'已匹配',exact:'精确匹配',active:'在职匹配',resigned:'离职匹配',ambiguous:'多候选',unmatched:'未匹配',mirror:'镜像行',ignored:'已忽略'}[text(value).toLowerCase()]||text(value)||'待核对')
const matchTone=value=>{
  const key=text(value).toLowerCase()
  if(['matched','exact','active','resigned'].includes(key))return 'matched'
  if(['ambiguous','mirror'].includes(key))return 'warning'
  if(['unmatched'].includes(key))return 'unmatched'
  return 'neutral'
}
const matchMethodLabel=row=>{
  const rosterMethod=text(row?.raw_values?.roster_match_method)
  const canonical=({employee_id_exact:'员工ID精确',name_unique_exact:'唯一姓名精确'}[text(row?.match_method)]||text(row?.match_method)||'—')
  if(rosterMethod==='next_month_roster')return `${canonical} · 次月名单辅助，需复核`
  if(rosterMethod==='roster_exact')return `${canonical} · 本月名单`
  return canonical
}
const syncStatusLabel=value=>({success:'已同步',ready:'已就绪',synced:'已同步',complete:'已完成',partial:'部分同步',warning:'待核对',empty:'暂无记录',pending:'等待同步',failed:'同步失败',error:'同步失败'}[text(value).toLowerCase()]||text(value)||'状态未知')
const syncTone=value=>{
  const key=text(value).toLowerCase()
  if(['success','ready','synced','complete'].includes(key))return 'success'
  if(['partial','warning','pending'].includes(key))return 'warning'
  if(['failed','error'].includes(key))return 'error'
  return 'neutral'
}
const formatDateTime=value=>{
  if(!value)return '—'
  const date=new Date(value)
  return Number.isNaN(date.getTime())?text(value):date.toLocaleString('zh-CN',{hour12:false})
}
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

export default function AdminAttendancePage(){
  const [params,setParams]=useSearchParams()
  const tab=TABS.includes(params.get('tab'))?params.get('tab'):TABS[0]
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
  const employeeRequest=useRef(0)

  const setTab=value=>setParams(value===TABS[0]?{}:{tab:value})
  useEffect(()=>{
    const next=tabFilters(tab)
    setDraft(next);setApplied(next);setPage(1);setState({loading:false,error:'',data:null});setEmployeeError('')
  },[tab])

  useEffect(()=>{
    if(!requestTab(tab))return undefined
    let alive=true
    const load=async()=>{
      setState(current=>({...current,loading:true,error:''}))
      const filters={...applied,scope:tabScope(tab),page,page_size:pageSize}
      if(tab==='今日考勤')filters.date_from=filters.date_to=todayIso()
      if(tab==='请假审批'&&!filters.event_kind)filters.event_kind='leave'
      const {data,error}=await supabase.rpc('admin_attendance_home',{p_filters:filters})
      if(!alive)return
      if(error)setState(current=>({loading:false,error:message(error),data:current.data}))
      else{
        const result=data||{rows:[],page,pages:1,total:0,page_size:pageSize}
        setState({loading:false,error:'',data:result})
        const pages=Math.max(1,Number(result.pages||1))
        if(page>pages)setPage(pages)
      }
    }
    load()
    return()=>{alive=false}
  },[tab,applied,page,pageSize,refreshKey])

  const query=()=>{setApplied({...draft});setPage(1)}
  const reset=()=>{const next=tabFilters(tab);setDraft(next);setApplied(next);setPage(1)}
  const openEmployee=async row=>{
    if(!row.employee_id)return
    const sequence=++employeeRequest.current
    setEmployeeError('')
    setEmployeeDetail({employee:{id:row.employee_id,employee_no:row.employee_no,full_name:row.full_name,status:row.employee_status,teams:{name:row.team_name},positions:{name:row.position_name}},missing_fields:[]})
    setEmployeeDetailLoading(true)
    const {data,error}=await supabase.functions.invoke('admin-employees',{body:{action:'detail',employee_id:row.employee_id}})
    if(sequence!==employeeRequest.current)return
    if(error||data?.error){setEmployeeDetail(null);setEmployeeError(`员工档案读取失败：${message(error||data?.error)}`)}else setEmployeeDetail(data)
    setEmployeeDetailLoading(false)
  }

  const data=state.data||{}
  const rows=data.rows||[]
  const options=data.options||{}
  const subtitle=tab==='排班表'?'员工主档与当前排班关系。':tab==='奖金 / 扣款'?'奖金、扣款及未解析金额的私有来源表快照。':'12 个私有来源表的真实考勤快照、匹配结果与来源位置。'

  return <div className="content-page attendance-page">
    <header className="attendance-page-head">
      <div><small>ATTENDANCE OPERATIONS</small><h1>排班与考勤</h1><p>{subtitle}</p></div>
      <div className="attendance-head-actions">{requestTab(tab)&&<><span className="attendance-private-badge">私有表只读快照</span><button type="button" onClick={()=>setRefreshKey(value=>value+1)} disabled={state.loading}>{state.loading?'刷新中…':'刷新数据'}</button></>}</div>
    </header>

    <nav className="module-tabs attendance-tabs" aria-label="排班与考勤页面">
      {TABS.map(value=><button type="button" key={value} className={tab===value?'active':''} onClick={()=>setTab(value)}>{value}</button>)}
    </nav>

    {employeeError&&<div className="attendance-error" role="alert"><span>{employeeError}</span><button type="button" onClick={()=>setEmployeeError('')}>×</button></div>}
    {tab==='排班表'&&<SchedulePane/>}
    {tab==='换班记录'&&<ShiftChangePlaceholder onAttendance={()=>setTab('考勤记录')}/>}

    {requestTab(tab)&&<>
      {tab==='请假审批'&&<div className="attendance-readonly-notice"><b>只读历史记录，不是审批队列</b><span>当前 12 个来源只提供已经发生的考勤事实，没有申请人、审批人或审批状态。页面默认筛选“请假”，也可在下方切换公休、回家 / 居家假、半天等真实类别。</span></div>}
      {tab==='今日考勤'&&<div className="attendance-context-note"><b>{todayIso()}</b><span>仅显示今天在私有来源快照中已有的记录；没有记录不等同于正常出勤。</span></div>}
      <AttendanceFilters tab={tab} draft={draft} setDraft={setDraft} options={options} advanced={advanced} setAdvanced={setAdvanced} loading={state.loading} onQuery={query} onReset={reset}/>
      {state.error&&<div className="attendance-error" role="alert"><span>考勤数据读取失败：{state.error}</span><button type="button" onClick={()=>setRefreshKey(value=>value+1)}>重试</button></div>}
      <AttendanceSummary scope={tabScope(tab)} summary={data.summary||{}} total={Number(data.total||0)}/>
      <SourceStatusPanel sources={data.sources||[]} latestSync={data.latest_sync} loading={state.loading&&!state.data}/>
      <AttendanceTable rows={rows} scope={tabScope(tab)} loading={state.loading} hasData={Boolean(state.data)} onEmployee={openEmployee} onDetail={setRecordDetail}/>
      <Pagination page={Number(data.page||page)} pages={Math.max(1,Number(data.pages||1))} total={Number(data.total||0)} pageSize={Number(data.page_size||pageSize)} loading={state.loading} onPage={setPage} onPageSize={next=>{setPageSize(next);setPage(1)}}/>
    </>}

    {recordDetail&&<AttendanceRecordModal row={recordDetail} adjustment={tabScope(tab)==='adjustment'} onClose={()=>setRecordDetail(null)}/>}
    {employeeDetail&&<EmployeeDrawer detail={employeeDetail} loading={employeeDetailLoading} readOnly onClose={()=>{employeeRequest.current+=1;setEmployeeDetail(null);setEmployeeDetailLoading(false)}}/>}
  </div>
}

function AttendanceFilters({tab,draft,setDraft,options,advanced,setAdvanced,loading,onQuery,onReset}){
  const update=(key,value)=>setDraft(current=>({...current,[key]:value}))
  const kindOptions=optionEntries(options.event_kinds,attendanceKindLabel)
  if(draft.event_kind&&!kindOptions.some(item=>item.value===draft.event_kind))kindOptions.unshift({value:draft.event_kind,label:attendanceKindLabel(draft.event_kind),key:`selected-${draft.event_kind}`})
  const select=(label,key,values,allLabel,labeler)=><label><span>{label}</span><select value={draft[key]} onChange={event=>update(key,event.target.value)}><option value="">{allLabel}</option>{optionEntries(values,labeler).map(item=><option value={item.value} key={item.key}>{item.label}</option>)}</select></label>
  return <section className="attendance-filter-card">
    <div className="attendance-filter-main">
      <label className="attendance-search"><span>员工 / 内容搜索</span><div><i>⌕</i><input value={draft.search} onChange={event=>update('search',event.target.value)} onKeyDown={event=>event.key==='Enter'&&onQuery()} placeholder="员工ID / 姓名 / 原因 / 备注 / 来源"/></div></label>
      <button type="button" className="primary-action" onClick={onQuery} disabled={loading}>{loading?'查询中…':'查询'}</button>
      <button type="button" className="secondary-action" onClick={onReset} disabled={loading}>重置</button>
      <button type="button" className="attendance-filter-toggle" onClick={()=>setAdvanced(value=>!value)}>{advanced?'收起筛选':'更多筛选'}</button>
    </div>
    {advanced&&<div className="attendance-filter-grid">
      <label><span>日期起</span><input type="date" value={draft.date_from} disabled={tab==='今日考勤'} onChange={event=>update('date_from',event.target.value)}/></label>
      <label><span>日期止</span><input type="date" value={draft.date_to} disabled={tab==='今日考勤'} onChange={event=>update('date_to',event.target.value)}/></label>
      {select('来源月份','source_month',options.source_months,'全部月份')}
      {select('来源分组','source_group',options.source_groups,'全部分组',attendanceSourceGroupLabel)}
      <label><span>记录类别</span><select value={draft.event_kind} onChange={event=>update('event_kind',event.target.value)}><option value="">全部类别</option>{kindOptions.map(item=><option key={item.key} value={item.value}>{item.label}</option>)}</select></label>
      <label><span>员工状态</span><select value={draft.employee_status} onChange={event=>update('employee_status',event.target.value)}><option value="">全部员工状态</option><option value="active">在职</option><option value="probation">试用</option><option value="resigned">离职</option><option value="inactive">停用</option><option value="unmatched">未匹配</option></select></label>
      {select('团队','team',options.teams,'全部团队')}
      {select('岗位','position',options.positions,'全部岗位')}
      {select('员工国家','country',options.countries,'全部国家')}
      {select('盘口 / 平台','platform',options.platforms,'全部盘口')}
      {select('负责人','manager',options.managers,'全部负责人')}
      {select('匹配状态','match_status',options.match_statuses,'全部匹配状态',matchStatusLabel)}
    </div>}
  </section>
}

function AttendanceSummary({scope,summary,total}){
  const items=scope==='adjustment'?
    [['记录总数',total],['奖金笔数',summary.bonus_count||0,'positive'],['奖金合计',formatNumber(summary.bonus_total),'positive'],['扣款笔数',summary.deduction_count||0,'negative'],['扣款合计',formatNumber(summary.deduction_total),'negative'],['净额',formatNumber(summary.net_amount)],['待核对金额',summary.incomplete||0,'warning']]:
    [['记录总数',total],['公休',summary.public_holiday||0],['回家 / 居家假',summary.home_leave||0],['请假',summary.leave||0,'warning'],['半天',summary.half_day||0,'warning'],['缺勤',summary.absence||0,'negative'],['离职',summary.resignation||0]]
  return <section className="attendance-summary-grid">{items.map(([label,value,tone])=><div key={label} className={tone||''}><span>{label}</span><strong>{value}</strong></div>)}</section>
}

function SourceStatusPanel({sources,latestSync,loading}){
  const syncedAt=latestSync&&typeof latestSync==='object'?(latestSync.synced_at||latestSync.latest_sync||latestSync.updated_at||latestSync.created_at):latestSync
  return <section className="attendance-source-panel">
    <header><div><small>PRIVATE SOURCE SNAPSHOTS</small><h2>12 个来源状态</h2><p>每条记录保留来源表、分组、月份、区块及原始行号，便于回查。</p></div><div><strong>{loading?'—':sources.length} / 12</strong><span>最近同步 {formatDateTime(syncedAt)}</span></div></header>
    {loading?<div className="attendance-source-state">正在读取来源状态…</div>:sources.length?<div className="attendance-source-grid">{sources.map((source,index)=><SourceCard key={source.source_key||source.key||source.id||index} source={source}/>)}</div>:<div className="attendance-source-state">RPC 尚未返回来源状态；记录表仍保持只读。</div>}
    {!loading&&sources.length!==12&&<footer>当前 RPC 返回 {sources.length} 个来源状态，目标清单为 12 个；缺少的来源不会以假数据补齐。</footer>}
  </section>
}

function SourceCard({source}){
  const status=source.status||source.sync_status||source.state||(Number(source.row_count??source.total??source.records)>0?'ready':'empty')
  const rows=source.row_count??source.record_count??source.total??source.records??0
  const matched=source.matched_count??source.matched??0
  const unmatched=source.unmatched_count??source.unmatched??0
  return <article className="attendance-source-card" title={source.metadata?.roster_note||''}>
    <div><span className={`attendance-sync-state ${syncTone(status)}`}>{syncStatusLabel(status)}</span><small>{source.metadata?.requires_review?'名单需复核':'私有来源'}</small></div>
    <h3 title={source.source_title||source.source_name||source.title||source.source_key}>{source.source_title||source.source_name||source.title||source.source_key||'未命名来源'}</h3>
    <p>{[attendanceSourceGroupLabel(source.source_group),source.source_month].filter(Boolean).join(' · ')||source.source_key||'—'}</p>
    <dl><div><dt>记录</dt><dd>{rows}</dd></div><div><dt>匹配</dt><dd>{matched}</dd></div><div><dt>待核对</dt><dd>{unmatched}</dd></div></dl>
    <footer>{formatDateTime(source.latest_sync||source.synced_at||source.updated_at)}</footer>
  </article>
}

function AttendanceTable({rows,scope,loading,hasData,onEmployee,onDetail}){
  return <section className={`attendance-table-card ${loading&&hasData?'is-loading':''}`}>
    <header><div><h2>{scope==='adjustment'?'奖金 / 扣款明细':'考勤快照明细'}</h2><p>员工链接打开完整档案；说明与备注可查看原始长文本。</p></div><span>{loading?'读取中…':`${rows.length} 条 / 本页`}</span></header>
    {!hasData&&loading?<div className="attendance-table-state">正在读取私有表快照…</div>:!rows.length?<div className="attendance-table-state">当前筛选条件下暂无记录</div>:<div className="attendance-table-scroll"><table>
      <thead><tr><th>日期 / 类别</th><th>员工</th><th>状态</th><th>团队 / 岗位</th><th>国家 / 盘口</th><th>负责人</th>{scope==='adjustment'&&<th>金额 / 原值</th>}<th>原因 / 备注</th><th>私有表来源</th><th>匹配</th><th>详情</th></tr></thead>
      <tbody>{rows.map((row,index)=><tr key={row.id||`${row.source_key}-${row.source_row}-${index}`}>
        <td><div className="attendance-event-cell"><strong>{row.event_date||'—'}</strong><span className={`attendance-kind kind-${text(row.event_kind).toLowerCase()}`}>{attendanceKindLabel(row.event_kind)}</span>{row.is_mirror&&<em>镜像</em>}</div></td>
        <td><div className="attendance-employee-cell">{row.employee_id?<button type="button" onClick={()=>onEmployee(row)}>{row.employee_no||'未编号'}</button>:<strong>{row.employee_no||'未匹配'}</strong>}<span>{row.full_name||'—'}</span></div></td>
        <td><span className={`attendance-employee-status ${text(row.employee_status).toLowerCase()}`}>{employeeStatusLabel(row.employee_status)}</span></td>
        <td><div className="attendance-stack"><strong>{row.team_name||'—'}</strong><span>{row.position_name||'—'}</span></div></td>
        <td><div className="attendance-stack"><strong>{row.country||'—'}</strong><span title={row.platform||''}>{row.platform||'—'}</span></div></td>
        <td>{row.manager||'—'}</td>
        {scope==='adjustment'&&<td><div className={`attendance-amount ${text(row.event_kind).toLowerCase()}`}><strong>{attendanceAmount(row)}</strong><span>{row.raw_amount&&text(row.raw_amount)!==text(row.amount)?`原值 ${row.raw_amount}`:'已解析'}</span></div></td>}
        <td><button type="button" className="attendance-note-button" title="查看完整原因与备注" onClick={()=>onDetail(row)}><strong>{row.reason||'—'}</strong><span>{row.note||'—'}</span></button></td>
        <td><div className="attendance-source-cell"><strong title={row.source_title||row.source_name||''}>{row.source_title||row.source_name||'—'}</strong><span>{[attendanceSourceGroupLabel(row.source_group),row.source_month].filter(Boolean).join(' · ')||'—'}</span><small>{[row.source_block,row.source_row?`第 ${row.source_row} 行`:null].filter(Boolean).join(' · ')||row.source_key||'—'}</small></div></td>
        <td><div className="attendance-match-cell"><span className={matchTone(row.match_status)}>{matchStatusLabel(row.match_status)}</span><small>{matchMethodLabel(row)}</small></div></td>
        <td><button type="button" className="table-action" onClick={()=>onDetail(row)}>查看</button></td>
      </tr>)}</tbody>
    </table></div>}
    {loading&&hasData&&<div className="attendance-loading-overlay">正在更新结果…</div>}
  </section>
}

function AttendanceRecordModal({row,adjustment,onClose}){
  return <div className="modal-mask attendance-main-modal-mask" onMouseDown={onClose}><div className="attendance-main-modal" role="dialog" aria-modal="true" aria-labelledby="attendance-main-modal-title" onMouseDown={event=>event.stopPropagation()}>
    <header><div><small>PRIVATE TABLE SNAPSHOT</small><h2 id="attendance-main-modal-title">{attendanceKindLabel(row.event_kind)} · 完整记录</h2><p>{row.event_date||'—'} · {row.employee_no||'未匹配'} · {row.full_name||'—'}</p></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>
    <div className="attendance-modal-facts">
      <span><small>员工状态</small><b>{employeeStatusLabel(row.employee_status)}</b></span><span><small>团队 / 岗位</small><b>{[row.team_name,row.position_name].filter(Boolean).join(' · ')||'—'}</b></span><span><small>员工国家 / 盘口</small><b>{[row.country,row.platform].filter(Boolean).join(' · ')||'—'}</b></span><span><small>负责人</small><b>{row.manager||'—'}</b></span>{adjustment&&<span><small>金额 / 原值</small><b>{attendanceAmount(row)}{row.raw_amount?` · ${row.raw_amount}`:''}</b></span>}<span><small>匹配状态</small><b>{matchStatusLabel(row.match_status)} · {matchMethodLabel(row)}</b></span>
    </div>
    <section><small>完整原因</small><p>{row.reason||'—'}</p></section>
    <section><small>完整备注</small><p>{row.note||'—'}</p></section>
    <section className="attendance-modal-source"><small>私有表来源位置</small><p><b>{row.source_title||row.source_name||'—'}</b><br/>{[attendanceSourceGroupLabel(row.source_group),row.source_month,row.source_block,row.source_row?`第 ${row.source_row} 行`:null].filter(Boolean).join(' · ')||row.source_key||'—'}</p></section>
    <footer><button type="button" className="secondary-action" onClick={onClose}>关闭</button></footer>
  </div></div>
}

function ShiftChangePlaceholder({onAttendance}){
  return <section className="attendance-placeholder"><div className="attendance-placeholder-icon">⇄</div><small>SHIFT CHANGE RECORDS</small><h2>本批来源没有独立换班字段</h2><p>当前接入的 12 个私有表只保留考勤、请假、缺勤、离职及奖金 / 扣款快照，没有换班申请、原班次、新班次或审批状态。这里明确留空，避免把其他记录误作换班审批。</p><button type="button" className="secondary-action" onClick={onAttendance}>查看真实考勤记录</button></section>
}

function SchedulePane(){
  const [search,setSearch]=useState('')
  const [draftSearch,setDraftSearch]=useState('')
  const [state,setState]=useState({loading:true,error:'',rows:[]})
  const load=async()=>{
    setState(current=>({...current,loading:true,error:''}))
    const {data,error}=await supabase.functions.invoke('admin-accounts',{body:{action:'bootstrap'}})
    if(error||data?.error)setState({loading:false,error:message(error||data?.error),rows:[]})
    else setState({loading:false,error:'',rows:(data?.employees||[]).filter(employee=>text(employee.status)==='active'||!text(employee.status))})
  }
  useEffect(()=>{load()},[])
  const rows=useMemo(()=>{
    const needle=text(search).toLowerCase()
    if(!needle)return state.rows
    return state.rows.filter(employee=>[employee.employee_no,employee.full_name,employee.country,employee.nationality,employee.shift_name,employee.platform_scope,employee?.teams?.name,employee?.positions?.name,employee.leader_name,employee.trainer_name].some(value=>text(value).toLowerCase().includes(needle)))
  },[state.rows,search])
  return <>
    <section className="attendance-filter-card schedule-search-card"><div className="attendance-filter-main"><label className="attendance-search"><span>搜索当前排班</span><div><i>⌕</i><input value={draftSearch} onChange={event=>setDraftSearch(event.target.value)} onKeyDown={event=>event.key==='Enter'&&setSearch(draftSearch)} placeholder="员工ID / 姓名 / 团队 / 班次 / 盘口"/></div></label><button type="button" className="primary-action" onClick={()=>setSearch(draftSearch)}>查询</button><button type="button" className="secondary-action" onClick={()=>{setDraftSearch('');setSearch('')}}>重置</button><button type="button" className="attendance-filter-toggle" onClick={load} disabled={state.loading}>{state.loading?'读取中…':'刷新排班'}</button></div></section>
    {state.error&&<div className="attendance-error"><span>排班读取失败：{state.error}</span><button type="button" onClick={load}>重试</button></div>}
    <section className="attendance-table-card schedule-table-card"><header><div><h2>当前排班关系</h2><p>来自已导入员工主档与排班匹配结果。</p></div><span>{state.loading?'读取中…':`${rows.length} 人`}</span></header>{state.loading&&!state.rows.length?<div className="attendance-table-state">正在读取排班…</div>:!rows.length?<div className="attendance-table-state">暂无符合条件的排班员工</div>:<div className="attendance-table-scroll"><table><thead><tr><th>员工ID</th><th>姓名</th><th>团队</th><th>班次</th><th>岗位</th><th>组长 / 负责人</th><th>培训老师</th><th>员工国家</th><th>盘口 / 平台</th></tr></thead><tbody>{rows.slice(0,700).map(employee=><tr key={employee.id}><td><strong>{employee.employee_no||'—'}</strong></td><td>{employee.full_name||'—'}</td><td>{employee?.teams?.name||'—'}</td><td>{employee.shift_name||'—'}</td><td>{employee?.positions?.name||'—'}</td><td>{employee.leader_name||'—'}</td><td>{employee.trainer_name||'—'}</td><td>{employee.country||employee.nationality||'—'}</td><td className="attendance-schedule-platform">{employee.platform_scope||'—'}</td></tr>)}</tbody></table></div>}</section>
  </>
}
