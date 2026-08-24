import React, { useState } from 'react'

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
  if(text(row?.currency_rule).toLowerCase()==='home_country_unknown')return '待核对'
  const explicit=text(row?.currency||row?.currency_code||row?.raw_values?.currency).toUpperCase()
  if(['USD','PHP'].includes(explicit))return explicit
  const sourceGroup=text(row?.source_group).toLowerCase()
  const employmentType=text(row?.employment_type).toLowerCase()
  if(sourceGroup==='onsite_to_home'||employmentType.includes('现场转居家')||employmentType.includes('onsite'))return 'USD'
  const country=text(row?.country||row?.nationality)
  if(!country)return '待核对'
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

function RecordDetailsModal({row,onClose,adjustment=false}){
  if(!row)return null
  return <div className="modal-mask attendance-record-modal-mask" onMouseDown={onClose}>
    <div className="attendance-record-modal" role="dialog" aria-modal="true" aria-labelledby="employee-attendance-record-title" onMouseDown={event=>event.stopPropagation()}>
      <header>
        <div><small>{adjustment?'ADJUSTMENT DETAIL':'ATTENDANCE DETAIL'}</small><h3 id="employee-attendance-record-title">{attendanceKindLabel(row.event_kind)} · {row.event_date||'日期未记录'}</h3><p>{row.employee_no||'—'} · {row.full_name||'—'}</p></div>
        <button type="button" aria-label="关闭" onClick={onClose}>×</button>
      </header>
      {adjustment&&<div className="attendance-record-modal-meta"><span><small>金额 / 币种</small><b className={kindTone(row.event_kind)}>{attendanceAmount(row)}</b></span></div>}
      <section><small>原因</small><p>{row.reason||'—'}</p></section>
      <section><small>完整备注</small><p>{row.note||'—'}</p></section>
      <footer><button type="button" className="secondary-action" onClick={onClose}>关闭</button></footer>
    </div>
  </div>
}

export function EmployeeAttendancePanel({data,loading,error}){
  const sourceRows=data?.rows||data?.history||[]
  const rows=sourceRows.filter(row=>ATTENDANCE_EVENT_KINDS.has(text(row?.event_kind||row?.kind).toLowerCase()))
  const summary=data?.summary||{}
  const [selected,setSelected]=useState(null)
  return <section className="detail-panel employee-attendance-panel">
    <div className="detail-panel-head"><div><h3>员工出勤记录</h3><p>仅显示公休、回家、请假、半天、缺席与离职六类记录。</p></div><span className="employee-exam-count">{rows.length} 条</span></div>
    {loading?<div className="attendance-panel-state">正在读取出勤记录…</div>:error?<div className="attendance-panel-state error">{error}</div>:<>
      <div className="employee-attendance-summary">
        <SummaryItem label="公休" value={summary.public_holiday}/><SummaryItem label="回家" value={summary.home_leave}/><SummaryItem label="请假" value={summary.leave}/><SummaryItem label="半天" value={summary.half_day}/><SummaryItem label="缺席" value={summary.absence} tone="negative"/><SummaryItem label="离职" value={summary.resignation}/>
      </div>
      {rows.length?<div className="employee-attendance-list">{rows.map((row,index)=><article key={row.id||`${row.source_key}-${row.source_row}-${index}`}>
        <div className="employee-attendance-record-head"><div><strong>{row.event_date||'—'}</strong><span className={`attendance-kind ${kindTone(row.event_kind)}`}>{attendanceKindLabel(row.event_kind)}</span></div><button type="button" onClick={()=>setSelected(row)}>查看完整说明</button></div>
        <div className="employee-attendance-record-body"><div><small>原因</small><p>{row.reason||'—'}</p></div><div><small>备注</small><p>{row.note||'—'}</p></div></div>
      </article>)}</div>:<div className="attendance-panel-state">暂无出勤记录</div>}
    </>}
    {selected&&<RecordDetailsModal row={selected} onClose={()=>setSelected(null)}/>}
  </section>
}

export function EmployeeAdjustmentPanel({data,loading,error}){
  const rows=data?.rows||data?.history||[]
  const summary=data?.summary||{}
  const currencySummary=attendanceCurrencySummary(summary)
  const currencyValue=(currency,key)=>currencySummary[currency]?`${currency} ${formatNumber(currencySummary[currency]?.[key])||0}`:'—'
  const currencyCount=(currency,key)=>currencySummary[currency]?`${currencySummary[currency]?.[key]||0} 笔`:'—'
  const [selected,setSelected]=useState(null)
  return <section className="detail-panel employee-attendance-panel employee-adjustment-panel">
    <div className="detail-panel-head"><div><h3>奖金 / 扣款记录</h3><p>金额按 USD / PHP 标示，未完整解析时同时显示原值。</p></div><span className="employee-exam-count">{data?.total||rows.length||0} 条</span></div>
    {loading?<div className="attendance-panel-state">正在读取奖金 / 扣款记录…</div>:error?<div className="attendance-panel-state error">{error}</div>:<>
      <div className="employee-adjustment-summary">
        <SummaryItem label="USD 奖金" value={`${currencyCount('USD','bonus_count')} · ${currencyValue('USD','bonus_total')}`} tone="positive"/><SummaryItem label="USD 扣款" value={`${currencyCount('USD','deduction_count')} · ${currencyValue('USD','deduction_total')}`} tone="negative"/><SummaryItem label="USD 净额" value={currencyValue('USD','net_amount')}/><SummaryItem label="PHP 奖金" value={`${currencyCount('PHP','bonus_count')} · ${currencyValue('PHP','bonus_total')}`} tone="positive"/><SummaryItem label="PHP 扣款" value={`${currencyCount('PHP','deduction_count')} · ${currencyValue('PHP','deduction_total')}`} tone="negative"/><SummaryItem label="PHP 净额" value={currencyValue('PHP','net_amount')}/><SummaryItem label="币种待核对" value={summary.currency_review_count||0} tone="warning"/><SummaryItem label="金额未解析" value={summary.incomplete||0} tone="warning"/>
      </div>
      {rows.length?<div className="employee-adjustment-list">{rows.map((row,index)=><article key={row.id||`${row.source_key}-${row.source_row}-${index}`}>
        <div className="employee-adjustment-amount"><span className={`attendance-kind ${kindTone(row.event_kind)}`}>{attendanceKindLabel(row.event_kind)}</span><b className={kindTone(row.event_kind)}>{attendanceAmount(row)}</b><small>{row.event_date||'—'}</small></div>
        <div className="employee-adjustment-copy"><strong>{row.reason||'未填写原因'}</strong><p>{row.note||'—'}</p></div>
        <button type="button" onClick={()=>setSelected(row)}>详情</button>
      </article>)}</div>:<div className="attendance-panel-state">暂无奖金 / 扣款记录</div>}
    </>}
    {selected&&<RecordDetailsModal row={selected} adjustment onClose={()=>setSelected(null)}/>}
  </section>
}
