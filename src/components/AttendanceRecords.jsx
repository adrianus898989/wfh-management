import React, { useState } from 'react'

const text = value => String(value ?? '').trim()

const KIND_LABELS = {
  normal: '正常出勤',
  present: '正常出勤',
  public_holiday: '公休',
  home_leave: '回家 / 居家假',
  leave: '请假',
  half_day: '半天',
  absence: '缺勤',
  absent: '缺勤',
  resignation: '离职',
  late: '迟到',
  bonus: '奖金',
  deduction: '扣款',
  penalty: '扣款',
}

export const attendanceKindLabel = value => KIND_LABELS[text(value).toLowerCase()] || text(value) || '未分类'
export const attendanceSourceGroupLabel = value => ({home:'居家员工',onsite_to_home:'现场转居家'}[text(value).toLowerCase()]||text(value)||'—')

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
  if(formatted)return `${bonus&&Number(row.amount)>0?'+':''}${formatted}`
  return text(row?.raw_amount)||'—'
}

function SummaryItem({label,value,tone=''}){
  return <span className={tone}><small>{label}</small><b>{value??0}</b></span>
}

function RecordSource({row}){
  return <div className="employee-attendance-source">
    <strong>{row.source_title||row.source_name||'私有表快照'}</strong>
    <span>{[attendanceSourceGroupLabel(row.source_group),row.source_month,row.source_row?`第 ${row.source_row} 行`:null].filter(Boolean).join(' · ')||'—'}</span>
  </div>
}

function RecordDetailsModal({row,onClose,adjustment=false}){
  if(!row)return null
  return <div className="modal-mask attendance-record-modal-mask" onMouseDown={onClose}>
    <div className="attendance-record-modal" role="dialog" aria-modal="true" aria-labelledby="employee-attendance-record-title" onMouseDown={event=>event.stopPropagation()}>
      <header>
        <div><small>{adjustment?'ADJUSTMENT SNAPSHOT':'ATTENDANCE SNAPSHOT'}</small><h3 id="employee-attendance-record-title">{attendanceKindLabel(row.event_kind)} · {row.event_date||'日期未记录'}</h3><p>{row.employee_no||'—'} · {row.full_name||'—'}</p></div>
        <button type="button" aria-label="关闭" onClick={onClose}>×</button>
      </header>
      <div className="attendance-record-modal-meta">
        <span><small>来源</small><b>{row.source_title||row.source_name||'—'}</b></span>
        <span><small>来源分组 / 月份</small><b>{[attendanceSourceGroupLabel(row.source_group),row.source_month].filter(Boolean).join(' · ')||'—'}</b></span>
        <span><small>来源位置</small><b>{[row.source_block,row.source_row?`第 ${row.source_row} 行`:null].filter(Boolean).join(' · ')||'—'}</b></span>
        {adjustment&&<span><small>金额</small><b className={kindTone(row.event_kind)}>{attendanceAmount(row)}</b></span>}
      </div>
      <section><small>原因</small><p>{row.reason||'—'}</p></section>
      <section><small>完整备注</small><p>{row.note||'—'}</p></section>
      <footer><button type="button" className="secondary-action" onClick={onClose}>关闭</button></footer>
    </div>
  </div>
}

export function EmployeeAttendancePanel({data,loading,error}){
  const rows=data?.rows||data?.history||[]
  const summary=data?.summary||{}
  const [selected,setSelected]=useState(null)
  return <section className="detail-panel employee-attendance-panel">
    <div className="detail-panel-head"><div><h3>员工出勤记录</h3><p>来自私有出勤来源表的只读历史快照。</p></div><span className="employee-exam-count">{data?.total||rows.length||0} 条</span></div>
    {loading?<div className="attendance-panel-state">正在读取出勤记录…</div>:error?<div className="attendance-panel-state error">{error}</div>:<>
      <div className="employee-attendance-summary">
        <SummaryItem label="公休" value={summary.public_holiday}/><SummaryItem label="回家 / 居家假" value={summary.home_leave}/><SummaryItem label="请假" value={summary.leave}/><SummaryItem label="半天" value={summary.half_day}/><SummaryItem label="缺勤" value={summary.absence} tone="negative"/><SummaryItem label="离职" value={summary.resignation}/>
      </div>
      {rows.length?<div className="employee-attendance-list">{rows.map((row,index)=><article key={row.id||`${row.source_key}-${row.source_row}-${index}`}>
        <div className="employee-attendance-record-head"><div><strong>{row.event_date||'—'}</strong><span className={`attendance-kind ${kindTone(row.event_kind)}`}>{attendanceKindLabel(row.event_kind)}</span></div><button type="button" onClick={()=>setSelected(row)}>查看完整说明</button></div>
        <div className="employee-attendance-record-body"><div><small>原因</small><p>{row.reason||'—'}</p></div><div><small>备注</small><p>{row.note||'—'}</p></div></div>
        <RecordSource row={row}/>
      </article>)}</div>:<div className="attendance-panel-state">暂无出勤记录</div>}
    </>}
    {selected&&<RecordDetailsModal row={selected} onClose={()=>setSelected(null)}/>}
  </section>
}

export function EmployeeAdjustmentPanel({data,loading,error}){
  const rows=data?.rows||data?.history||[]
  const summary=data?.summary||{}
  const [selected,setSelected]=useState(null)
  return <section className="detail-panel employee-attendance-panel employee-adjustment-panel">
    <div className="detail-panel-head"><div><h3>奖金 / 扣款记录</h3><p>金额保留原始快照，未完整解析时同时显示原值。</p></div><span className="employee-exam-count">{data?.total||rows.length||0} 条</span></div>
    {loading?<div className="attendance-panel-state">正在读取奖金 / 扣款记录…</div>:error?<div className="attendance-panel-state error">{error}</div>:<>
      <div className="employee-adjustment-summary">
        <SummaryItem label="奖金笔数" value={summary.bonus_count} tone="positive"/><SummaryItem label="奖金合计" value={formatNumber(summary.bonus_total)||0} tone="positive"/><SummaryItem label="扣款笔数" value={summary.deduction_count} tone="negative"/><SummaryItem label="扣款合计" value={formatNumber(summary.deduction_total)||0} tone="negative"/><SummaryItem label="净额" value={formatNumber(summary.net_amount)||0}/><SummaryItem label="待核对金额" value={summary.incomplete} tone="warning"/>
      </div>
      {rows.length?<div className="employee-adjustment-list">{rows.map((row,index)=><article key={row.id||`${row.source_key}-${row.source_row}-${index}`}>
        <div className="employee-adjustment-amount"><span className={`attendance-kind ${kindTone(row.event_kind)}`}>{attendanceKindLabel(row.event_kind)}</span><b className={kindTone(row.event_kind)}>{attendanceAmount(row)}</b><small>{row.event_date||'—'}</small></div>
        <div className="employee-adjustment-copy"><strong>{row.reason||'未填写原因'}</strong><p>{row.note||'—'}</p><RecordSource row={row}/></div>
        <button type="button" onClick={()=>setSelected(row)}>详情</button>
      </article>)}</div>:<div className="attendance-panel-state">暂无奖金 / 扣款记录</div>}
    </>}
    {selected&&<RecordDetailsModal row={selected} adjustment onClose={()=>setSelected(null)}/>}
  </section>
}
