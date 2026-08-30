import React, { useEffect, useState } from 'react'
import { adjustmentCategory, adjustmentReason } from '../lib/adjustmentPresentation'
import { attendanceHistoryRemark } from '../lib/attendancePresentation'
import { supabase } from '../lib/supabase'
import { Pagination } from './DataPageControls'

const text = value => String(value ?? '').trim()

const KIND_LABELS = {
  normal: '正常出勤',
  present: '正常出勤',
  public_holiday: '公休',
  home_leave: '回家',
  leave: '请假',
  half_day: '半天',
  absence: '缺席',
  absent: '缺席',
  resignation: '离职',
  late: '迟到',
  bonus: '奖金',
  deduction: '扣款',
  penalty: '扣款',
}

const ATTENDANCE_EVENT_KINDS = new Set(['public_holiday','home_leave','leave','half_day','absence','absent','resignation'])

export const attendanceKindLabel = value => KIND_LABELS[text(value).toLowerCase()] || text(value) || '未分类'
export const attendanceSourceGroupLabel = value => ({home:'纯居家',onsite_to_home:'现场转居家'}[text(value).toLowerCase()]||text(value)||'—')

const philippinesCountry = value => /(^|\b)(PH|PHL|PHILIPPINES?|FILIPINO)($|\b)|菲律宾|菲律賓/i.test(text(value))
export const attendanceCurrency = row => {
  const sourceGroup=text(row?.source_group).toLowerCase()
  const employmentType=text(row?.employment_type).toLowerCase()
  if(sourceGroup==='onsite_to_home'||employmentType.includes('现场转居家')||employmentType.includes('onsite'))return 'USD'
  const country=text(row?.country||row?.nationality)
  // 业务规则只有一个 PHP 例外：纯居家菲律宾籍。其余员工统一使用 USD。
  return philippinesCountry(country)?'PHP':'USD'
}

export const attendanceCurrencySummary = summary => {
  const source=summary?.currency_summary||summary?.currencies||{}
  const entries=Array.isArray(source)?source.map(item=>[text(item?.currency||item?.currency_code).toUpperCase(),item]):Object.entries(source).map(([currency,value])=>[text(currency).toUpperCase(),value])
  const result={USD:null,PHP:null}
  entries.forEach(([currency,value])=>{if(currency in result)result[currency]=value||{}})
  return result
}

const kindTone = value => {
  const key=text(value).toLowerCase()
  if(['normal','present','bonus'].includes(key))return 'positive'
  if(['absence','absent','deduction','penalty','resignation'].includes(key))return 'negative'
  if(['leave','home_leave','half_day','late'].includes(key))return 'warning'
  return 'neutral'
}

const formatNumber = value => {
  if(value===null||value===undefined||value==='')return ''
  const amount=Number(value)
  if(!Number.isFinite(amount))return text(value)
  return amount.toLocaleString('zh-CN',{maximumFractionDigits:2})
}

export const attendanceAmount = row => {
  const formatted=formatNumber(row?.amount)
  const bonus=['bonus','reward'].includes(text(row?.event_kind).toLowerCase())
  const currency=attendanceCurrency(row)
  const currencyLabel=currency==='待核对'?'币种待核对':currency
  if(formatted)return `${currencyLabel} ${bonus&&Number(row.amount)>0?'+':''}${formatted}`
  return text(row?.raw_amount)?`${currencyLabel} ${text(row.raw_amount)}`:'—'
}

function SummaryItem({label,value,tone=''}){
  return <span className={tone}><small>{label}</small><b>{value??0}</b></span>
}

const historyDate=row=>text(row?.event_date||row?.incident_date).slice(0,10)

function HistoryFilters({filters,setFilters,onSubmit,onReset,loading=false,placeholder='搜索备注或内容'}){
  const update=(key,value)=>setFilters(current=>({...current,[key]:value}))
  return <form className="employee-history-filters" onSubmit={event=>{event.preventDefault();onSubmit()}}>
    <label><span>日期起</span><input type="date" value={filters.from} onChange={event=>update('from',event.target.value)}/></label>
    <label><span>日期止</span><input type="date" value={filters.to} onChange={event=>update('to',event.target.value)}/></label>
    <label className="employee-history-search"><span>搜索</span><input value={filters.keyword} onChange={event=>update('keyword',event.target.value)} placeholder={placeholder}/></label>
    <button type="submit" disabled={loading}>{loading?'查询中…':'查询'}</button>
    {(filters.from||filters.to||filters.keyword)&&<button type="button" disabled={loading} onClick={onReset}>重置</button>}
  </form>
}

const emptyHistoryFilters=()=>({from:'',to:'',keyword:''})
const HISTORY_PAGE_SIZES=[20,30,50,100]

function useEmployeeHistoryRpc(rpcName,employeeIdValue,enabled=true){
  const employeeId=text(employeeIdValue)
  const [draftFilters,setDraftFilters]=useState(emptyHistoryFilters)
  const [appliedFilters,setAppliedFilters]=useState(emptyHistoryFilters)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(20)
  const [filtersEmployeeId,setFiltersEmployeeId]=useState('')
  const [state,setState]=useState({employeeId:'',data:null,loading:false,error:''})

  useEffect(()=>{
    setDraftFilters(emptyHistoryFilters())
    setAppliedFilters(emptyHistoryFilters())
    setPage(1)
    setPageSize(20)
    setFiltersEmployeeId(employeeId)
    setState({employeeId:'',data:null,loading:false,error:''})
  },[employeeId,rpcName])

  useEffect(()=>{
    if(!enabled||!employeeId||filtersEmployeeId!==employeeId||!supabase)return
    let active=true
    setState(current=>({...current,employeeId,loading:true,error:''}))
    supabase.rpc(rpcName,{
      p_employee_id:employeeId,
      p_date_from:appliedFilters.from||null,
      p_date_to:appliedFilters.to||null,
      p_search:text(appliedFilters.keyword)||null,
      p_page:page,
      p_page_size:pageSize,
    }).then(({data,error})=>{
      if(!active)return
      if(error){
        setState(current=>({...current,employeeId,loading:false,error:error.message||'记录读取失败'}))
        return
      }
      setState({employeeId,data:data||null,loading:false,error:''})
    }).catch(error=>{
      if(active)setState(current=>({...current,employeeId,loading:false,error:error?.message||'记录读取失败'}))
    })
    return()=>{active=false}
  },[rpcName,employeeId,filtersEmployeeId,enabled,appliedFilters,page,pageSize])

  const data=state.employeeId===employeeId?state.data:null
  const apply=()=>{
    if(draftFilters.from&&draftFilters.to&&draftFilters.from>draftFilters.to){
      setState(current=>({...current,employeeId,error:'日期起不能晚于日期止'}))
      return
    }
    setPage(1)
    setAppliedFilters({...draftFilters,keyword:text(draftFilters.keyword)})
  }
  const reset=()=>{
    const empty=emptyHistoryFilters()
    setDraftFilters(empty)
    setPage(1)
    setAppliedFilters(empty)
  }
  const changePageSize=next=>{
    if(!HISTORY_PAGE_SIZES.includes(Number(next)))return
    setPageSize(Number(next))
    setPage(1)
  }

  return {
    data,
    loading:state.employeeId===employeeId&&state.loading,
    error:state.employeeId===employeeId?state.error:'',
    filters:draftFilters,
    setFilters:setDraftFilters,
    apply,
    reset,
    page,
    setPage,
    pageSize,
    setPageSize:changePageSize,
  }
}

function HistoryPagination({data,loading,page,pageSize,onPage,onPageSize}){
  const total=Number(data?.total||0)
  if(total<=0)return null
  return <Pagination
    page={Number(data?.page||page||1)}
    pages={Math.max(1,Number(data?.pages||1))}
    total={total}
    pageSize={Number(data?.page_size||pageSize||20)}
    pageSizeOptions={HISTORY_PAGE_SIZES}
    loading={loading}
    onPage={onPage}
    onPageSize={onPageSize}
  />
}

const adjustmentVisibilityKind=row=>{
  const kind=text(row?.event_kind).toLowerCase()
  if(kind==='bonus')return 'bonus'
  if(kind==='deduction')return 'deduction'
  const amount=Number(row?.amount)
  if(kind&&Number.isFinite(amount)&&amount>0)return 'bonus'
  if(kind&&Number.isFinite(amount)&&amount<0)return 'deduction'
  return 'unclassified'
}
const adjustmentSearchCategory=row=>adjustmentCategory(row)

function RecordDetailsModal({row,onClose,adjustment=false}){
  if(!row)return null
  return <div className="modal-mask attendance-record-modal-mask" onMouseDown={onClose}>
    <div className="attendance-record-modal" role="dialog" aria-modal="true" aria-labelledby="employee-attendance-record-title" onMouseDown={event=>event.stopPropagation()}>
      <header>
        <div><small>{adjustment?'ADJUSTMENT DETAIL':'ATTENDANCE DETAIL'}</small><h3 id="employee-attendance-record-title">{attendanceKindLabel(row.event_kind)} · {row.event_date||'日期未记录'}</h3><p>{row.employee_no||'—'} · {row.full_name||'—'}</p></div>
        <button type="button" aria-label="关闭" onClick={onClose}>×</button>
      </header>
      {adjustment&&<div className="attendance-record-modal-meta"><span><small>类型</small><b>{adjustmentCategory(row)}</b></span><span><small>金额 / 币种</small><b className={kindTone(row.event_kind)}>{attendanceAmount(row)}</b></span></div>}
      {adjustment?<section><small>原因</small><p>{adjustmentReason(row)}</p></section>:<>
        <section><small>原因</small><p>{row.reason||'—'}</p></section>
        <section><small>完整备注</small><p>{row.note||'—'}</p></section>
      </>}
      <footer><button type="button" className="secondary-action" onClick={onClose}>关闭</button></footer>
    </div>
  </div>
}

export function EmployeeAttendancePanel({employeeId}){
  const query=useEmployeeHistoryRpc('admin_employee_attendance_history_filtered',employeeId)
  const result=query.data
  const sourceRows=result?.rows||result?.history||[]
  const rows=sourceRows.filter(row=>ATTENDANCE_EVENT_KINDS.has(text(row?.event_kind||row?.kind).toLowerCase()))
  const resultLoading=query.loading||(!query.data&&!query.error&&Boolean(text(employeeId)))
  const resultError=query.error
  return <section className="detail-panel employee-attendance-panel">
    <div className="detail-panel-head"><div><h3>员工出勤记录</h3></div><span className="employee-exam-count">{Number(result?.total||rows.length)} 条</span></div>
    {!result&&resultLoading?<div className="attendance-panel-state">正在读取出勤记录…</div>:!result&&resultError?<div className="attendance-panel-state error">{resultError}</div>:<>
      {resultError&&<div className="attendance-panel-state error">{resultError}</div>}
      <HistoryFilters filters={query.filters} setFilters={query.setFilters} onSubmit={query.apply} onReset={query.reset} loading={resultLoading} placeholder="搜索状态、原因或备注"/>
      {rows.length?<div className="employee-attendance-compact-wrap"><table className="employee-attendance-compact-table">
        <thead><tr><th>日期</th><th>类型</th><th>备注 / 原因</th></tr></thead>
        <tbody>{rows.map((row,index)=>{
          const kind=row.event_kind||row.kind
          return <tr key={row.id||`${row.source_key}-${row.source_row}-${index}`}><td>{historyDate(row)||'—'}</td><td><span className={`attendance-kind ${kindTone(kind)}`}>{attendanceKindLabel(kind)}</span></td><td>{attendanceHistoryRemark(row)}</td></tr>
        })}</tbody>
      </table></div>:<div className="attendance-panel-state">暂无出勤记录</div>}
      <HistoryPagination data={result} loading={resultLoading} page={query.page} pageSize={query.pageSize} onPage={query.setPage} onPageSize={query.setPageSize}/>
    </>}
  </section>
}

export function EmployeeAdjustmentPanel({employeeId,canViewBonus=false,canViewDeduction=false}){
  const query=useEmployeeHistoryRpc('admin_employee_adjustment_history_filtered',employeeId,canViewBonus||canViewDeduction)
  const result=query.data
  const serverPermissions=query.data?.permissions
  if(serverPermissions){
    canViewBonus=Boolean(serverPermissions.bonus)
    canViewDeduction=Boolean(serverPermissions.deduction)
  }
  const sourceRows=result?.rows||result?.history||[]
  // Defense in depth: the filtered RPC already applies the same category
  // boundary before totals and pagination.
  const rows=sourceRows.filter(row=>{
    const kind=adjustmentVisibilityKind(row)
    const categoryAllowed=kind==='bonus'?canViewBonus:kind==='deduction'?canViewDeduction:canViewBonus&&canViewDeduction
    return categoryAllowed
  })
  const summary=result?.summary||{}
  const currencySummary=attendanceCurrencySummary(summary)
  const currencyValue=(currency,key)=>currencySummary[currency]?`${currency} ${formatNumber(currencySummary[currency]?.[key])||0}`:'—'
  const currencyCount=(currency,key)=>currencySummary[currency]?`${currencySummary[currency]?.[key]||0} 笔`:'—'
  const [selected,setSelected]=useState(null)
  const resultLoading=query.loading||(!query.data&&!query.error&&Boolean(text(employeeId)))
  const resultError=query.error
  const panelTitle=canViewBonus&&canViewDeduction?'奖金 / 扣款记录':canViewBonus?'奖金记录':'扣款记录'
  const summaryItems=[...(canViewBonus?[['USD 奖金',`${currencyCount('USD','bonus_count')} · ${currencyValue('USD','bonus_total')}`,'positive'],['PHP 奖金',`${currencyCount('PHP','bonus_count')} · ${currencyValue('PHP','bonus_total')}`,'positive']]:[]),...(canViewDeduction?[['USD 扣款',`${currencyCount('USD','deduction_count')} · ${currencyValue('USD','deduction_total')}`,'negative'],['PHP 扣款',`${currencyCount('PHP','deduction_count')} · ${currencyValue('PHP','deduction_total')}`,'negative']]:[]),...(canViewBonus&&canViewDeduction?[['USD 净额',currencyValue('USD','net_amount')],['PHP 净额',currencyValue('PHP','net_amount')]]:[]),['币种待核对',summary.currency_review_count||0,'warning'],['金额未解析',summary.incomplete||0,'warning']]
  useEffect(()=>setSelected(null),[query.page,query.pageSize,query.data])
  return <section className="detail-panel employee-attendance-panel employee-adjustment-panel">
    <div className="detail-panel-head"><div><h3>{panelTitle}</h3></div><span className="employee-exam-count">{Number(result?.total||rows.length)} 条</span></div>
    {!result&&resultLoading?<div className="attendance-panel-state">正在读取奖金 / 扣款记录…</div>:!result&&resultError?<div className="attendance-panel-state error">{resultError}</div>:<>
      {resultError&&<div className="attendance-panel-state error">{resultError}</div>}
      <HistoryFilters filters={query.filters} setFilters={query.setFilters} onSubmit={query.apply} onReset={query.reset} loading={resultLoading} placeholder="搜索类型、金额、奖金、扣款或原因"/>
      <div className="employee-adjustment-summary">
        {summaryItems.map(([label,value,tone])=><SummaryItem key={label} label={label} value={value} tone={tone}/>)}
      </div>
      {rows.length?<div className="employee-adjustment-list">{rows.map((row,index)=><article key={row.id||`${row.source_key}-${row.source_row}-${index}`}>
        <div className="employee-adjustment-amount"><span className={`attendance-kind ${kindTone(row.event_kind)}`}>{attendanceKindLabel(row.event_kind)}</span><b className={kindTone(row.event_kind)}>{attendanceAmount(row)}</b><small>{row.event_date||'—'}</small></div>
        <div className="employee-adjustment-copy" title={adjustmentSearchCategory(row)}><small>类型</small><strong>{adjustmentCategory(row)}</strong><small>原因</small><p>{adjustmentReason(row)}</p></div>
        <button type="button" onClick={()=>setSelected(row)}>详情</button>
      </article>)}</div>:<div className="attendance-panel-state">暂无奖金 / 扣款记录</div>}
      <HistoryPagination data={result} loading={resultLoading} page={query.page} pageSize={query.pageSize} onPage={query.setPage} onPageSize={query.setPageSize}/>
    </>}
    {selected&&<RecordDetailsModal row={selected} adjustment onClose={()=>setSelected(null)}/>}
  </section>
}
