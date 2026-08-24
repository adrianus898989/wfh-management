import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Pagination } from '../components/DataPageControls'
import { attendanceAmount, attendanceCurrency, attendanceCurrencySummary, attendanceKindLabel, attendanceSourceGroupLabel } from '../components/AttendanceRecords'
import { supabase } from '../lib/supabase'
import { EmployeeDrawer } from './AdminEmployeesPage'

const TABS=['排班表','出勤表','今日考勤','考勤记录','请假审批','奖金 / 扣款']
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
const requestTab=tab=>!['排班表','出勤表'].includes(tab)
const tabScope=tab=>tab==='奖金 / 扣款'?'adjustment':'attendance'
const employeeTypeLabel=row=>{
  const explicit=text(row?.employment_type)
  const mapped={home_ph:'纯居家菲律宾',home_vn:'纯居家',home_id:'纯居家',home_mm:'纯居家',onsite_to_home:'现场转居家'}[explicit.toLowerCase()]
  if(explicit)return mapped||explicit
  return text(row?.source_group).toLowerCase()==='onsite_to_home'?'现场转居家':'纯居家'
}
const employeeStatusLabel=value=>({active:'在职',probation:'试用',suspended:'停用',inactive:'停用',resigned:'离职',unmatched:'未匹配'}[text(value).toLowerCase()]||text(value)||'—')
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
  return {...normalized,currency:attendanceCurrency(normalized)}
})

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
  const rows=useMemo(()=>normalizeAttendanceRows(data.rows||[]),[data.rows])
  const options=data.options||{}
  const subtitle=tab==='排班表'?'按团队和班次快速查看当前人员安排。':tab==='出勤表'?'固定员工资料，横向查看每月 1–31 日出勤记录。':tab==='奖金 / 扣款'?'奖金、扣款与币种清晰分列。':'集中查看员工考勤、请假与离职记录。'

  return <div className="content-page attendance-page">
    <header className="attendance-page-head">
      <div><small>ATTENDANCE OPERATIONS</small><h1>排班与考勤</h1><p>{subtitle}</p></div>
      <div className="attendance-head-actions">{requestTab(tab)&&<button type="button" onClick={()=>setRefreshKey(value=>value+1)} disabled={state.loading}>{state.loading?'刷新中…':'刷新数据'}</button>}</div>
    </header>

    <nav className="module-tabs attendance-tabs" aria-label="排班与考勤页面">
      {TABS.map(value=><button type="button" key={value} className={tab===value?'active':''} onClick={()=>setTab(value)}>{value}</button>)}
    </nav>

    {employeeError&&<div className="attendance-error" role="alert"><span>{employeeError}</span><button type="button" onClick={()=>setEmployeeError('')}>×</button></div>}
    {tab==='排班表'&&<SchedulePane/>}
    {tab==='出勤表'&&<AttendanceMatrixPane/>}

    {requestTab(tab)&&<>
      {tab==='请假审批'&&<div className="attendance-readonly-notice"><b>当前为记录视图</b><span>页面默认筛选“请假”，也可以切换公休、回家 / 居家假、半天等真实类别。</span></div>}
      {tab==='今日考勤'&&<div className="attendance-context-note"><b>{todayIso()}</b><span>仅显示今天已经登记的记录；没有记录不等同于正常出勤。</span></div>}
      <AttendanceFilters tab={tab} draft={draft} setDraft={setDraft} options={options} advanced={advanced} setAdvanced={setAdvanced} loading={state.loading} onQuery={query} onReset={reset}/>
      {state.error&&<div className="attendance-error" role="alert"><span>考勤数据读取失败：{state.error}</span><button type="button" onClick={()=>setRefreshKey(value=>value+1)}>重试</button></div>}
      <AttendanceSummary scope={tabScope(tab)} summary={data.summary||{}} total={Number(data.total||0)}/>
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
      <label className="attendance-search"><span>员工 / 内容搜索</span><div><i>⌕</i><input value={draft.search} onChange={event=>update('search',event.target.value)} onKeyDown={event=>event.key==='Enter'&&onQuery()} placeholder="员工ID / 姓名 / 原因 / 备注"/></div></label>
      <button type="button" className="primary-action" onClick={onQuery} disabled={loading}>{loading?'查询中…':'查询'}</button>
      <button type="button" className="secondary-action" onClick={onReset} disabled={loading}>重置</button>
      <button type="button" className="attendance-filter-toggle" onClick={()=>setAdvanced(value=>!value)}>{advanced?'收起筛选':'更多筛选'}</button>
    </div>
    {advanced&&<div className="attendance-filter-grid">
      <label><span>日期起</span><input type="date" value={draft.date_from} disabled={tab==='今日考勤'} onChange={event=>update('date_from',event.target.value)}/></label>
      <label><span>日期止</span><input type="date" value={draft.date_to} disabled={tab==='今日考勤'} onChange={event=>update('date_to',event.target.value)}/></label>
      {select('员工类型','source_group',options.source_groups,'全部员工类型',attendanceSourceGroupLabel)}
      <label><span>记录类别</span><select value={draft.event_kind} onChange={event=>update('event_kind',event.target.value)}><option value="">全部类别</option>{kindOptions.map(item=><option key={item.key} value={item.value}>{item.label}</option>)}</select></label>
      <label><span>员工状态</span><select value={draft.employee_status} onChange={event=>update('employee_status',event.target.value)}><option value="">全部员工状态</option><option value="active">在职</option><option value="probation">试用</option><option value="resigned">离职</option><option value="inactive">停用</option><option value="unmatched">未匹配</option></select></label>
      {select('团队','team',options.teams,'全部团队')}
      {select('岗位','position',options.positions,'全部岗位')}
      {select('员工国家','country',options.countries,'全部国家')}
      {select('盘口 / 平台','platform',options.platforms,'全部盘口')}
      {select('负责人','manager',options.managers,'全部负责人')}
    </div>}
  </section>
}

function AttendanceSummary({scope,summary,total}){
  const currencySummary=attendanceCurrencySummary(summary)
  const money=(currency,key)=>currencySummary[currency]?`${currency} ${formatNumber(currencySummary[currency]?.[key]||0)}`:'—'
  const count=(currency,key)=>currencySummary[currency]?currencySummary[currency]?.[key]||0:'—'
  const items=scope==='adjustment'?
    [['记录总数',total],['USD 奖金',`${count('USD','bonus_count')} 笔 · ${money('USD','bonus_total')}`,'positive'],['USD 扣款',`${count('USD','deduction_count')} 笔 · ${money('USD','deduction_total')}`,'negative'],['USD 净额',money('USD','net_amount')],['PHP 奖金',`${count('PHP','bonus_count')} 笔 · ${money('PHP','bonus_total')}`,'positive'],['PHP 扣款',`${count('PHP','deduction_count')} 笔 · ${money('PHP','deduction_total')}`,'negative'],['PHP 净额',money('PHP','net_amount')],['待核对记录',summary.unmatched||0,'warning'],['币种待核对',summary.currency_review_count||0,'warning'],['金额未解析',summary.incomplete||0,'warning']]:
    [['记录总数',total],['公休',summary.public_holiday||0],['回家 / 居家假',summary.home_leave||0],['请假',summary.leave||0,'warning'],['半天',summary.half_day||0,'warning'],['缺勤',summary.absence||0,'negative'],['离职',summary.resignation||0],['待核对记录',summary.unmatched||0,'warning']]
  return <section className="attendance-summary-grid">{items.map(([label,value,tone])=><div key={label} className={tone||''}><span>{label}</span><strong>{value}</strong></div>)}</section>
}

function AttendanceTable({rows,scope,loading,hasData,onEmployee,onDetail}){
  return <section className={`attendance-table-card ${loading&&hasData?'is-loading':''}`}>
    <header><div><h2>{scope==='adjustment'?'奖金 / 扣款明细':'考勤记录明细'}</h2><p>员工、组织与说明分列展示；点击原因或备注可查看完整文字。</p></div><span>{loading?'读取中…':`${rows.length} 条 / 本页`}</span></header>
    {!hasData&&loading?<div className="attendance-table-state">正在读取记录…</div>:!rows.length?<div className="attendance-table-state">当前筛选条件下暂无记录</div>:<div className="attendance-table-scroll"><table className={scope==='adjustment'?'attendance-detail-table adjustment':'attendance-detail-table'}>
      <thead><tr><th>日期</th><th>入职日期</th><th>员工</th><th>员工类型 / 国家</th><th>状态</th><th>团队 / 岗位</th><th>负责人</th>{scope==='adjustment'&&<th>金额 / 币种</th>}<th>原因</th><th>备注</th></tr></thead>
      <tbody>{rows.map((row,index)=><tr key={row.id||`${row.source_key}-${row.source_row}-${index}`}>
        <td><div className="attendance-event-cell"><strong>{row.event_date||'—'}</strong><span className={`attendance-kind kind-${text(row.event_kind).toLowerCase()}`}>{attendanceKindLabel(row.event_kind)}</span>{row.is_mirror&&<em>镜像</em>}</div></td>
        <td><span className="attendance-hire-date">{text(row.hire_date).slice(0,10)||'—'}</span></td>
        <td><div className="attendance-employee-cell">{row.employee_id?<button type="button" onClick={()=>onEmployee(row)}>{row.employee_no||'未编号'}</button>:<strong>{row.employee_no||'未匹配'}</strong>}<span>{row.full_name||'—'}</span></div></td>
        <td><div className="attendance-stack"><strong>{employeeTypeLabel(row)}</strong><span>{row.country||'—'}</span></div></td>
        <td><div className="attendance-status-stack"><span className={`attendance-employee-status ${text(row.employee_status).toLowerCase()}`}>{employeeStatusLabel(row.employee_status)}</span>{row.needs_review&&<span className="attendance-review-badge" title="员工身份尚未唯一确认，需要人工核对员工ID或姓名">待核对</span>}</div></td>
        <td><div className="attendance-stack"><strong>{row.team_name||'—'}</strong><span>{row.position_name||'—'}</span></div></td>
        <td>{row.manager||'—'}</td>
        {scope==='adjustment'&&<td><div className={`attendance-amount ${text(row.event_kind).toLowerCase()}`}><strong>{attendanceAmount(row)}</strong><span>{row.raw_amount&&text(row.raw_amount)!==text(row.amount)?`原值 ${row.raw_amount}`:'金额已解析'}</span></div></td>}
        <td><button type="button" className="attendance-copy-button" title="查看完整原因" onClick={()=>onDetail(row)}>{row.reason||'—'}</button></td>
        <td><button type="button" className="attendance-copy-button note" title="查看完整备注" onClick={()=>onDetail(row)}>{row.note||'—'}</button></td>
      </tr>)}</tbody>
    </table></div>}
    {loading&&hasData&&<div className="attendance-loading-overlay">正在更新结果…</div>}
  </section>
}

function AttendanceRecordModal({row,adjustment,onClose}){
  return <div className="modal-mask attendance-main-modal-mask" onMouseDown={onClose}><div className="attendance-main-modal" role="dialog" aria-modal="true" aria-labelledby="attendance-main-modal-title" onMouseDown={event=>event.stopPropagation()}>
    <header><div><small>ATTENDANCE DETAIL</small><h2 id="attendance-main-modal-title">{attendanceKindLabel(row.event_kind)} · 完整记录</h2><p>{row.event_date||'—'} · {row.employee_no||'未匹配'} · {row.full_name||'—'}</p></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>
    <div className="attendance-modal-facts">
      <span><small>入职日期</small><b>{text(row.hire_date).slice(0,10)||'—'}</b></span><span><small>员工类型 / 国家</small><b>{[employeeTypeLabel(row),row.country].filter(Boolean).join(' · ')||'—'}</b></span><span><small>员工状态</small><b>{employeeStatusLabel(row.employee_status)}</b></span><span><small>团队 / 岗位</small><b>{[row.team_name,row.position_name].filter(Boolean).join(' · ')||'—'}</b></span><span><small>负责人</small><b>{row.manager||'—'}</b></span>{adjustment&&<span><small>金额 / 原值</small><b>{attendanceAmount(row)}{row.raw_amount?` · ${row.raw_amount}`:''}</b></span>}
    </div>
    <section><small>完整原因</small><p>{row.reason||'—'}</p></section>
    <section><small>完整备注</small><p>{row.note||'—'}</p></section>
    <footer><button type="button" className="secondary-action" onClick={onClose}>关闭</button></footer>
  </div></div>
}

function SchedulePane(){
  const blank=()=>({search:'',team:'',group:'',position:'',shift:''})
  const [draft,setDraft]=useState(blank)
  const [applied,setApplied]=useState(blank)
  const [refreshKey,setRefreshKey]=useState(0)
  const [selected,setSelected]=useState(null)
  const [state,setState]=useState({loading:true,error:'',rows:[],options:{}})
  useEffect(()=>{
    let alive=true
    const load=async()=>{
      setState(current=>({...current,loading:true,error:''}))
      const {data,error}=await supabase.rpc('admin_attendance_schedule',{p_filters:applied})
      if(!alive)return
      if(error)setState(current=>({...current,loading:false,error:message(error)}))
      else{
        const payload=data||{}
        const rawRows=payload.rows||payload.employees||payload.schedule||[]
        const rows=rawRows.map((row,index)=>({
          ...row,
          id:row.id||row.employee_id||`${row.employee_no||row.full_name}-${index}`,
          employee_no:row.employee_no||row.staff_id||row.employee_code||'',
          full_name:row.full_name||row.employee_name||row.name||'',
          team_name:row.team_name||row.team||'未分配团队',
          group_name:row.group_name||row.group||row.team_group||'',
          shift_name:row.shift_display||row.shift_raw||row.shift_name||row.shift||'',
          shift_bucket:row.shift_bucket||shiftTone(row.shift_display||row.shift_raw||row.shift_name||row.shift),
          position_name:row.position_name||row.position||'',
          country:row.country_name||row.country||row.nationality||'',
          platform:row.platform_name||row.platform||row.platform_scope||'',
          manager:row.responsible||row.manager||'',
        }))
        setState({loading:false,error:'',rows,options:payload.options||payload.filters||{}})
      }
    }
    load()
    return()=>{alive=false}
  },[applied,refreshKey])
  const optionValues=(key,selector)=>{
    const supplied=state.options?.[key]||state.options?.[`${key}s`]||[]
    const values=supplied.length?supplied.map(item=>text(item?.value??item?.name??item?.label??item)):state.rows.map(selector)
    return Array.from(new Set(values.map(text).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN'))
  }
  const teams=useMemo(()=>optionValues('team',row=>row.team_name),[state.options,state.rows])
  const groups=useMemo(()=>optionValues('group',row=>row.group_name),[state.options,state.rows])
  const positions=useMemo(()=>optionValues('position',row=>row.position_name),[state.options,state.rows])
  const shifts=useMemo(()=>optionValues('shift',row=>row.shift_name).sort(shiftSort),[state.options,state.rows])
  const counts=useMemo(()=>state.rows.reduce((result,employee)=>{const key=employee.shift_bucket||shiftTone(employee.shift_name);result[key]=(result[key]||0)+1;return result},{day:0,mid:0,night:0,other:0}),[state.rows])
  const matrix=useMemo(()=>{
    const teamsMap=new Map()
    state.rows.forEach(employee=>{
      const teamName=employee.team_name||'未分配团队'
      if(!teamsMap.has(teamName))teamsMap.set(teamName,{team:teamName,day:[],mid:[],night:[],other:[]})
      teamsMap.get(teamName)[employee.shift_bucket||shiftTone(employee.shift_name)].push(employee)
    })
    return Array.from(teamsMap.values()).sort((a,b)=>a.team.localeCompare(b.team,'zh-CN'))
  },[state.rows])
  const update=(key,value)=>setDraft(current=>({...current,[key]:value}))
  const apply=()=>setApplied({...draft})
  const reset=()=>{const next=blank();setDraft(next);setApplied(next)}
  return <>
    <section className="schedule-overview"><div><span>早班 / 白班</span><strong>{counts.day}</strong></div><div><span>中班</span><strong>{counts.mid}</strong></div><div><span>晚班 / 夜班</span><strong>{counts.night}</strong></div><div><span>其他 / 未设置</span><strong>{counts.other}</strong></div></section>
    <section className="attendance-filter-card schedule-search-card"><div className="attendance-filter-main"><label className="attendance-search"><span>员工搜索</span><div><i>⌕</i><input value={draft.search} onChange={event=>update('search',event.target.value)} onKeyDown={event=>event.key==='Enter'&&apply()} placeholder="员工ID / 姓名 / 盘口 / 国家"/></div></label><label className="schedule-inline-filter"><span>团队</span><select value={draft.team} onChange={event=>update('team',event.target.value)}><option value="">全部团队</option>{teams.map(value=><option key={value}>{value}</option>)}</select></label><label className="schedule-inline-filter"><span>组别</span><select value={draft.group} onChange={event=>update('group',event.target.value)}><option value="">全部组别</option>{groups.map(value=><option key={value}>{value}</option>)}</select></label><label className="schedule-inline-filter"><span>岗位</span><select value={draft.position} onChange={event=>update('position',event.target.value)}><option value="">全部岗位</option>{positions.map(value=><option key={value}>{value}</option>)}</select></label><label className="schedule-inline-filter"><span>班次</span><select value={draft.shift} onChange={event=>update('shift',event.target.value)}><option value="">全部班次</option>{shifts.map(value=><option key={value}>{value}</option>)}</select></label><button type="button" className="primary-action" onClick={apply}>查询</button><button type="button" className="secondary-action" onClick={reset}>重置</button><button type="button" className="attendance-filter-toggle" onClick={()=>setRefreshKey(value=>value+1)} disabled={state.loading}>{state.loading?'读取中…':'刷新排班'}</button></div></section>
    {state.error&&<div className="attendance-error"><span>排班读取失败：{state.error}</span><button type="button" onClick={()=>setRefreshKey(value=>value+1)}>重试</button></div>}
    <section className="attendance-table-card schedule-matrix-card"><header><div><h2>团队 × 班次</h2><p>每格显示总人数与前 6 名，点击格子查看该团队该班次的完整名单。</p></div><span>{state.loading?'读取中…':`${state.rows.length} 人 · ${matrix.length} 个团队`}</span></header>{state.loading&&!state.rows.length?<div className="attendance-table-state">正在读取排班…</div>:!matrix.length?<div className="attendance-table-state">暂无符合条件的排班员工</div>:<div className="schedule-team-matrix-scroll"><div className="schedule-team-matrix"><div className="schedule-team-row head"><div>团队</div><div>早班 / 白班</div><div>中班</div><div>晚班 / 夜班</div><div>其他 / 未设置</div></div>{matrix.map(teamRow=><div className="schedule-team-row" key={teamRow.team}><div className="schedule-team-name"><strong>{teamRow.team}</strong><span>{teamRow.day.length+teamRow.mid.length+teamRow.night.length+teamRow.other.length} 人</span></div>{['day','mid','night','other'].map(tone=><button type="button" className={`schedule-team-cell ${tone}`} key={tone} onClick={()=>setSelected({team:teamRow.team,tone,people:teamRow[tone]})} disabled={!teamRow[tone].length}><strong>{teamRow[tone].length}<small>人</small></strong><span>{teamRow[tone].slice(0,6).map(person=>person.full_name||person.employee_no).join('、')||'无人排班'}</span>{teamRow[tone].length>6&&<em>另有 {teamRow[tone].length-6} 人</em>}</button>)}</div>)}</div></div>}
      {state.loading&&state.rows.length>0&&<div className="attendance-loading-overlay">正在更新排班…</div>}
    </section>
    {selected&&<ScheduleRosterModal data={selected} onClose={()=>setSelected(null)}/>}
  </>
}

function ScheduleRosterModal({data,onClose}){
  const label={day:'早班 / 白班',mid:'中班',night:'晚班 / 夜班',other:'其他 / 未设置'}[data.tone]||'班次'
  return <div className="modal-mask attendance-main-modal-mask" onMouseDown={onClose}><div className="attendance-main-modal schedule-roster-modal" role="dialog" aria-modal="true" onMouseDown={event=>event.stopPropagation()}><header><div><small>SCHEDULE ROSTER</small><h2>{data.team} · {label}</h2><p>共 {data.people.length} 人</p></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></header><div className="schedule-roster-list">{data.people.map(person=><article key={person.id}><div><strong>{person.full_name||'—'}</strong><span>{person.employee_no||'—'} · {person.group_name||'未分组'}</span></div><div><strong>{person.position_name||'—'}</strong><span>{person.country||'—'} · {person.platform||'—'}</span></div><div><strong>{text(person.hire_date).slice(0,10)||'—'}</strong><span>入职日期 · {employeeStatusLabel(person.employee_status||person.status)}</span></div><div><strong>{person.manager||'—'}</strong><span>负责人</span></div><span className={`schedule-shift ${data.tone}`}>{canonicalShift(person.shift_name)||label}</span></article>)}</div><footer><button type="button" className="secondary-action" onClick={onClose}>关闭</button></footer></div></div>
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

const monthValue=()=>todayIso().slice(0,7)
const monthMeta=value=>{
  const [year,month]=text(value).split('-').map(Number)
  const safeYear=year||new Date().getFullYear(),safeMonth=month||new Date().getMonth()+1
  const count=new Date(safeYear,safeMonth,0).getDate()
  return {days:Array.from({length:count},(_,index)=>index+1),from:`${safeYear}-${String(safeMonth).padStart(2,'0')}-01`,to:`${safeYear}-${String(safeMonth).padStart(2,'0')}-${String(count).padStart(2,'0')}`}
}
const matrixPersonKey=row=>text(row.employee_id)||text(row.id)||text(row.employee_no).toUpperCase()
const matrixKindMeta=value=>({
  public_holiday:['休','public_holiday'],home_leave:['回','home_leave'],leave:['假','leave'],half_day:['半','half_day'],absence:['缺','absence'],absent:['缺','absence'],resignation:['离','resignation'],late:['迟','late'],normal:['勤','normal'],present:['勤','normal'],
}[text(value).toLowerCase()]||['记','other'])

async function fetchAttendanceMonth(month){
  const {data,error}=await supabase.rpc('admin_attendance_monthly',{p_filters:{month}})
  if(error)throw error
  return data||{rows:[],options:{}}
}

function AttendanceMatrixPane(){
  const [month,setMonth]=useState(monthValue)
  const [draftSearch,setDraftSearch]=useState('')
  const [search,setSearch]=useState('')
  const [team,setTeam]=useState('')
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(30)
  const [dayDetail,setDayDetail]=useState(null)
  const [state,setState]=useState({loading:true,error:'',people:[],options:{}})
  const request=useRef(0)
  const load=async(force=false)=>{
    const sequence=++request.current
    setState(current=>({...current,loading:true,error:''}))
    try{
      const payload=await fetchAttendanceMonth(month,force)
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
        days:person.days||person.day_map||person.attendance_days||{},
      }))
      setState({loading:false,error:'',people,options:payload.options||{}})
    }catch(error){if(sequence===request.current)setState(current=>({...current,loading:false,error:message(error)}))}
  }
  useEffect(()=>{load()},[month])
  const bounds=useMemo(()=>monthMeta(month),[month])
  const people=useMemo(()=>{
    const needle=text(search).toLowerCase()
    return state.people.filter(employee=>(!needle||[employee.employee_no,employee.full_name,employee.country,employee.nationality,employee.platform,employee.position_name,employee.team_name].some(value=>text(value).toLowerCase().includes(needle)))&&(!team||text(employee.team_name)===team)).sort((a,b)=>text(a.team_name).localeCompare(text(b.team_name),'zh-CN')||text(a.full_name).localeCompare(text(b.full_name),'zh-CN'))
  },[state.people,search,team])
  const teams=useMemo(()=>{
    const supplied=state.options?.teams||[]
    const values=supplied.length?supplied.map(item=>text(item?.value??item?.name??item)):state.people.map(employee=>text(employee.team_name))
    return Array.from(new Set(values.filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN'))
  },[state.people,state.options])
  const pages=Math.max(1,Math.ceil(people.length/pageSize))
  const pagePeople=people.slice((page-1)*pageSize,page*pageSize)
  useEffect(()=>{setPage(1)},[month,search,team,pageSize])
  useEffect(()=>{if(page>pages)setPage(pages)},[page,pages])
  return <>
    <section className="attendance-filter-card matrix-toolbar"><div className="attendance-filter-main"><label className="schedule-inline-filter month"><span>查看月份</span><input type="month" value={month} onChange={event=>setMonth(event.target.value||monthValue())}/></label><label className="attendance-search"><span>搜索员工</span><div><i>⌕</i><input value={draftSearch} onChange={event=>setDraftSearch(event.target.value)} onKeyDown={event=>event.key==='Enter'&&setSearch(draftSearch)} placeholder="员工ID / 姓名 / 盘口 / 国家 / 岗位"/></div></label><label className="schedule-inline-filter"><span>团队</span><select value={team} onChange={event=>setTeam(event.target.value)}><option value="">全部团队</option>{teams.map(value=><option key={value}>{value}</option>)}</select></label><button type="button" className="primary-action" onClick={()=>setSearch(draftSearch)}>查询</button><button type="button" className="secondary-action" onClick={()=>{setDraftSearch('');setSearch('');setTeam('')}}>重置</button><button type="button" className="attendance-filter-toggle" onClick={()=>load(true)} disabled={state.loading}>{state.loading?'读取中…':'刷新出勤'}</button></div></section>
    {state.error&&<div className="attendance-error"><span>月度出勤读取失败：{state.error}</span><button type="button" onClick={()=>load(true)}>重试</button></div>}
    <section className="attendance-table-card attendance-matrix-card"><header><div><h2>{month.replace('-','年')}月出勤表</h2><p>左侧员工资料固定，右侧可横向查看 1–{bounds.days.length} 日；空白表示当天没有登记异常，不代表已完成打卡。</p></div><div className="matrix-legend"><span className="public_holiday">休 公休</span><span className="home_leave">回 居家假</span><span className="leave">假 请假</span><span className="half_day">半 半天</span><span className="absence">缺 缺勤</span><span className="resignation">离 离职</span></div></header>
      {state.loading&&!state.people.length?<div className="attendance-table-state">正在生成月度出勤表…</div>:!people.length?<div className="attendance-table-state">当前条件下暂无员工</div>:<div className="attendance-matrix-scroll"><table><thead><tr><th className="matrix-sticky matrix-scope">盘口 / 国家</th><th className="matrix-sticky matrix-position">岗位 / 团队</th><th className="matrix-sticky matrix-employee">员工</th><th className="matrix-sticky matrix-hire">入职日期</th>{bounds.days.map(day=><th className="matrix-day-head" key={day}>{day}</th>)}</tr></thead><tbody>{pagePeople.map(employee=><tr key={matrixPersonKey(employee)}><td className="matrix-sticky matrix-scope"><strong>{employee.platform||'—'}</strong><span>{employee.country||employee.nationality||'—'}</span></td><td className="matrix-sticky matrix-position"><strong>{employee.position_name||'—'}</strong><span>{employee.team_name||'—'}</span></td><td className="matrix-sticky matrix-employee"><strong>{employee.full_name||'—'}</strong><span>{employee.employee_no||'—'}</span></td><td className="matrix-sticky matrix-hire"><strong>{text(employee.hire_date).slice(0,10)||'—'}</strong></td>{bounds.days.map(day=>{const date=`${month}-${String(day).padStart(2,'0')}`,raw=employee.days?.[day]??employee.days?.[String(day)]??employee.days?.[date]??[],records=Array.isArray(raw)?raw:(raw?[raw]:[]),metas=Array.from(new Map(records.map(record=>[text(record.event_kind||record.kind||record.status),matrixKindMeta(record.event_kind||record.kind||record.status)])).values()),primary=metas[0];return <td className="matrix-day-cell" key={day}>{primary?<button type="button" className={primary[1]} aria-label={`${employee.full_name||employee.employee_no} ${date} 查看出勤详情`} title="点击查看完整原因与备注" onClick={()=>setDayDetail({employee,date,records})}>{metas.length>1?`${primary[0]}+${metas.length-1}`:primary[0]}</button>:<i title="无记录">—</i>}</td>})}</tr>)}</tbody></table></div>}
      {state.loading&&state.people.length>0&&<div className="attendance-loading-overlay">正在更新月度出勤…</div>}
    </section>
    {people.length>0&&<div className="matrix-pagination"><Pagination page={page} pages={pages} total={people.length} pageSize={pageSize} loading={state.loading} onPage={setPage} onPageSize={setPageSize}/></div>}
    {dayDetail&&<AttendanceDayModal data={dayDetail} onClose={()=>setDayDetail(null)}/>}
  </>
}

function AttendanceDayModal({data,onClose}){
  const employee=data.employee||{}
  return <div className="modal-mask attendance-main-modal-mask" onMouseDown={onClose}><div className="attendance-main-modal attendance-day-modal" role="dialog" aria-modal="true" aria-labelledby="attendance-day-modal-title" onMouseDown={event=>event.stopPropagation()}><header><div><small>DAILY ATTENDANCE DETAIL</small><h2 id="attendance-day-modal-title">{data.date} · 出勤详情</h2><p>{employee.employee_no||'—'} · {employee.full_name||'—'}</p></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></header><div className="attendance-modal-facts"><span><small>入职日期</small><b>{text(employee.hire_date).slice(0,10)||'—'}</b></span><span><small>盘口 / 国家</small><b>{[employee.platform,employee.country||employee.nationality].filter(Boolean).join(' · ')||'—'}</b></span><span><small>岗位 / 团队</small><b>{[employee.position_name,employee.team_name].filter(Boolean).join(' · ')||'—'}</b></span></div><div className="attendance-day-records">{data.records.map((record,index)=><article key={`${record.event_kind||record.kind}-${index}`}><span className={`attendance-kind kind-${text(record.event_kind||record.kind||record.status).toLowerCase()}`}>{attendanceKindLabel(record.event_kind||record.kind||record.status)}</span><div><small>原因</small><p>{record.reason||'—'}</p></div><div><small>备注</small><p>{record.note||'—'}</p></div></article>)}</div><footer><button type="button" className="secondary-action" onClick={onClose}>关闭</button></footer></div></div>
}
