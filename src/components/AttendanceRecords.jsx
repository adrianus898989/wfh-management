import React, { useMemo, useState } from 'react'
import { adjustmentCategory, adjustmentReason } from '../lib/adjustmentPresentation'
import { attendanceHistoryRemark } from '../lib/attendancePresentation'

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
const historyMatches=(row,filters,fields=[])=>{
  const date=historyDate(row)
  if(filters.from&&(!date||date<filters.from))return false
  if(filters.to&&(!date||date>filters.to))return false
  const keyword=text(filters.keyword).toLocaleLowerCase()
  if(!keyword)return true
  return fields.some(field=>text(typeof field==='function'?field(row):row?.[field]).toLocaleLowerCase().includes(keyword))
}

function HistoryFilters({filters,setFilters,placeholder='搜索备注或内容'}){
  const update=(key,value)=>setFilters(current=>({...current,[key]:value}))
  const reset=()=>setFilters({from:'',to:'',keyword:''})
  return <div className="employee-history-filters">
    <label><span>日期起</span><input type="date" value={filters.from} onChange={event=>update('from',event.target.value)}/></label>
    <label><span>日期止</span><input type="date" value={filters.to} onChange={event=>update('to',event.target.value)}/></label>
    <label className="employee-history-search"><span>搜索</span><input value={filters.keyword} onChange={event=>update('keyword',event.target.value)} placeholder={placeholder}/></label>
    {(filters.from||filters.to||filters.keyword)&&<button type="button" onClick={reset}>重置</button>}
  </div>
}

const emptyHistoryFilters=()=>({from:'',to:'',keyword:''})

const adjustmentVisibilityKind=row=>{
  const kind=text(row?.event_kind).toLowerCase()
  if(kind==='bonus')return 'bonus'
  if(kind==='deduction')return 'deduction'
  const amount=Number(row?.amount)
  if(kind&&Number.isFinite(amount)&&amount>0)return 'bonus'
  if(kind&&Number.isFinite(amount)&&amount<0)return 'deduction'
  return 'unclassified'
}

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

export function EmployeeAttendancePanel({data,loading,error}){
  const sourceRows=data?.rows||data?.history||[]
  const rows=sourceRows.filter(row=>ATTENDANCE_EVENT_KINDS.has(text(row?.event_kind||row?.kind).toLowerCase()))
  const [filters,setFilters]=useState(emptyHistoryFilters)
  const visibleRows=useMemo(()=>rows.filter(row=>historyMatches(row,filters,['reason','note',row=>attendanceKindLabel(row.event_kind||row.kind)])),[rows,filters])
  return <section className="detail-panel employee-attendance-panel">
    <div className="detail-panel-head"><div><h3>员工出勤记录</h3></div><span className="employee-exam-count">{visibleRows.length} 条</span></div>
    {loading?<div className="attendance-panel-state">正在读取出勤记录…</div>:error?<div className="attendance-panel-state error">{error}</div>:<>
      <HistoryFilters filters={filters} setFilters={setFilters} placeholder="搜索状态、原因或备注"/>
      {visibleRows.length?<div className="employee-attendance-compact-wrap"><table className="employee-attendance-compact-table">
        <thead><tr><th>日期</th><th>类型</th><th>备注 / 原因</th></tr></thead>
        <tbody>{visibleRows.map((row,index)=>{
          const kind=row.event_kind||row.kind
          return <tr key={row.id||`${row.source_key}-${row.source_row}-${index}`}><td>{historyDate(row)||'—'}</td><td><span className={`attendance-kind ${kindTone(kind)}`}>{attendanceKindLabel(kind)}</span></td><td>{attendanceHistoryRemark(row)}</td></tr>
        })}</tbody>
      </table></div>:<div className="attendance-panel-state">暂无出勤记录</div>}
    </>}
  </section>
}

export function EmployeeAdjustmentPanel({data,loading,error,canViewBonus=false,canViewDeduction=false}){
  const rows=data?.rows||data?.history||[]
  const summary=data?.summary||{}
  const currencySummary=attendanceCurrencySummary(summary)
  const currencyValue=(currency,key)=>currencySummary[currency]?`${currency} ${formatNumber(currencySummary[currency]?.[key])||0}`:'—'
  const currencyCount=(currency,key)=>currencySummary[currency]?`${currencySummary[currency]?.[key]||0} 笔`:'—'
  const [selected,setSelected]=useState(null)
  const [filters,setFilters]=useState(emptyHistoryFilters)
  const visibleRows=useMemo(()=>rows.filter(row=>{
    const kind=adjustmentVisibilityKind(row)
    const categoryAllowed=kind==='bonus'?canViewBonus:kind==='deduction'?canViewDeduction:canViewBonus&&canViewDeduction
    return categoryAllowed&&historyMatches(row,filters,['reason','note','raw_amount',row=>adjustmentCategory(row),row=>attendanceAmount(row),row=>attendanceKindLabel(row.event_kind)])
  }),[rows,filters,canViewBonus,canViewDeduction])
  const panelTitle=canViewBonus&&canViewDeduction?'奖金 / 扣款记录':canViewBonus?'奖金记录':'扣款记录'
  const summaryItems=[...(canViewBonus?[['USD 奖金',`${currencyCount('USD','bonus_count')} · ${currencyValue('USD','bonus_total')}`,'positive'],['PHP 奖金',`${currencyCount('PHP','bonus_count')} · ${currencyValue('PHP','bonus_total')}`,'positive']]:[]),...(canViewDeduction?[['USD 扣款',`${currencyCount('USD','deduction_count')} · ${currencyValue('USD','deduction_total')}`,'negative'],['PHP 扣款',`${currencyCount('PHP','deduction_count')} · ${currencyValue('PHP','deduction_total')}`,'negative']]:[]),...(canViewBonus&&canViewDeduction?[['USD 净额',currencyValue('USD','net_amount')],['PHP 净额',currencyValue('PHP','net_amount')]]:[]),['币种待核对',summary.currency_review_count||0,'warning'],['金额未解析',summary.incomplete||0,'warning']]
  return <section className="detail-panel employee-attendance-panel employee-adjustment-panel">
    <div className="detail-panel-head"><div><h3>{panelTitle}</h3></div><span className="employee-exam-count">{visibleRows.length} 条</span></div>
    {loading?<div className="attendance-panel-state">正在读取奖金 / 扣款记录…</div>:error?<div className="attendance-panel-state error">{error}</div>:<>
      <HistoryFilters filters={filters} setFilters={setFilters} placeholder="搜索类型、金额、奖金、扣款或原因"/>
      <div className="employee-adjustment-summary">
        {summaryItems.map(([label,value,tone])=><SummaryItem key={label} label={label} value={value} tone={tone}/>)}
      </div>
      {visibleRows.length?<div className="employee-adjustment-list">{visibleRows.map((row,index)=><article key={row.id||`${row.source_key}-${row.source_row}-${index}`}>
        <div className="employee-adjustment-amount"><span className={`attendance-kind ${kindTone(row.event_kind)}`}>{attendanceKindLabel(row.event_kind)}</span><b className={kindTone(row.event_kind)}>{attendanceAmount(row)}</b><small>{row.event_date||'—'}</small></div>
        <div className="employee-adjustment-copy"><small>类型</small><strong>{adjustmentCategory(row)}</strong><small>原因</small><p>{adjustmentReason(row)}</p></div>
        <button type="button" onClick={()=>setSelected(row)}>详情</button>
      </article>)}</div>:<div className="attendance-panel-state">暂无奖金 / 扣款记录</div>}
    </>}
    {selected&&<RecordDetailsModal row={selected} adjustment onClose={()=>setSelected(null)}/>}
  </section>
}
