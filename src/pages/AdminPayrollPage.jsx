import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const TABS = ['工资导入','待发布','已发布','导入记录']
const clean = value => String(value ?? '').trim()
const key = value => clean(value).toLowerCase().replace(/[\s_\-\/()（）.：:]+/g,'')
const isoDate = value => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0,10)
  const s=clean(value)
  if(!s) return ''
  const d=new Date(s)
  return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10)
}
const number = value => {
  if(typeof value==='number') return Number.isFinite(value)?value:0
  const parsed=Number(clean(value).replace(/[^0-9.\-]/g,''))
  return Number.isFinite(parsed)?parsed:0
}
const money = (value,currency='USD') => {
  const amount=Number(value||0)
  try{return new Intl.NumberFormat('zh-CN',{style:'currency',currency,maximumFractionDigits:2}).format(amount)}catch{return `${amount.toLocaleString()} ${currency}`}
}

const ALIASES = {
  sequence:['序号','no','number','stt'],
  platform:['盘口','平台','platform','series','market'],
  position_name:['岗位','职位','position','posisi','vịtrí','vitri'],
  employee_no:['id','员工id','员工编号','employeeid','employeeno','mãnhânviên','manhanvien','idkaryawan'],
  full_name:['姓名','员工姓名','fullname','name','nama','namalengkap','họtên','hoten'],
  hire_date:['入职时间','入职日期','hiredate','startdate','ngàyvàolàm','ngayvaolam','tanggalmasuk'],
  card_number:['卡号','银行卡号','accountnumber','cardnumber','sốtàikhoản','sotaikhoan','nomorrekening'],
  payment_name:['银行姓名','收款姓名','bankname','accountname','tênngânhàng','tennganhang','namarekening'],
  payment_method:['银行gcash','银行/gcash','收款方式','paymentmethod','bankgcash','metodepembayaran'],
  base_salary:['基础工资','底薪','basicsalary','basesalary','gajipokok','lươngcơbản','luongcoban'],
  attendance_salary:['出勤工资','全勤工资','满勤','满勤奖','attendancesalary','attendancebonus','gajikehadiran','lươngchuyêncần','luongchuyencan'],
  leave_deduction:['休假扣款','休假扣除','leavededuction','cuti','potongancuti'],
  late_deduction:['迟到','迟到扣款','latededuction','terlambat','đimuộn','dimuon'],
  absence_deduction:['缺勤','旷工','absencededuction','absen','vắngmặt','vangmat'],
  performance_adjustment:['绩效','绩效调整','performance','performanceadjustment','kinerja','hiệusuất','hieusuat'],
  deposit_adjustment:['押金','押金调整','deposit','depositadjustment'],
  overtime_bonus:['额外加班','加班','overtime','overtimebonus','lembur','tăngca','tangca'],
  other_adjustment:['其他调整','其他','otheradjustment','adjustment','penyesuaianlain'],
  remark:['备注','说明','remark','remarks','note','notes','catatan','ghichú','ghichu'],
  total_pay:['工资','总工资','实发工资','totalpay','takehomepay','netsalary','gajibersih','lươngthựclĩnh','luongthuclinh'],
}
const ALIAS_LOOKUP = new Map(Object.entries(ALIASES).flatMap(([field,values])=>values.map(value=>[key(value),field])))

function parseDelimited(source,delimiter){
  const rows=[];let row=[];let cell='';let quoted=false
  for(let i=0;i<source.length;i+=1){
    const ch=source[i]
    if(ch==='"'){
      if(quoted&&source[i+1]==='"'){cell+='"';i+=1}else quoted=!quoted
    }else if(ch===delimiter&&!quoted){row.push(cell);cell=''}
    else if((ch==='\n'||ch==='\r')&&!quoted){
      if(ch==='\r'&&source[i+1]==='\n')i+=1
      row.push(cell);rows.push(row);row=[];cell=''
    }else cell+=ch
  }
  if(cell||row.length){row.push(cell);rows.push(row)}
  return rows
}

async function readWorkbook(file){
  const ext=file.name.toLowerCase().split('.').pop()
  if(ext==='xlsx'){
    const {readSheet}=await import('read-excel-file/browser')
    return readSheet(file)
  }
  const source=await file.text()
  const delimiter=ext==='tsv'||source.split('\n')[0]?.includes('\t')?'\t':','
  return parseDelimited(source,delimiter)
}

function normalizeRows(sheetRows){
  const candidates=sheetRows.slice(0,20).map((row,index)=>({
    index,
    fields:row.map(cell=>ALIAS_LOOKUP.get(key(cell))).filter(Boolean),
  })).sort((a,b)=>b.fields.length-a.fields.length)
  const headerIndex=candidates[0]?.index ?? 0
  const headers=sheetRows[headerIndex]||[]
  const fields=headers.map(cell=>ALIAS_LOOKUP.get(key(cell))||null)
  if(!fields.includes('employee_no')&&!fields.includes('full_name')) throw new Error('找不到“员工ID”或“姓名”列，请检查表头。')
  if(!fields.includes('total_pay')) throw new Error('找不到“工资 / 实发工资 / Total Pay”列，请检查表头。')

  const rows=[]
  sheetRows.slice(headerIndex+1).forEach((source,index)=>{
    const raw={}
    const mapped={source_row:headerIndex+index+2,raw_payload:{}}
    source.forEach((cell,column)=>{
      const header=clean(headers[column])||`第${column+1}列`
      raw[header]=cell instanceof Date?isoDate(cell):cell
      const field=fields[column]
      if(field)mapped[field]=cell
    })
    if(!clean(mapped.employee_no)&&!clean(mapped.full_name))return
    const numericFields=['base_salary','attendance_salary','leave_deduction','late_deduction','absence_deduction','performance_adjustment','deposit_adjustment','overtime_bonus','other_adjustment','total_pay']
    numericFields.forEach(field=>{mapped[field]=number(mapped[field])})
    mapped.employee_no=clean(mapped.employee_no)
    mapped.full_name=clean(mapped.full_name)
    mapped.hire_date=isoDate(mapped.hire_date)
    mapped.platform=clean(mapped.platform)
    mapped.position_name=clean(mapped.position_name)
    mapped.card_number=clean(mapped.card_number)
    mapped.payment_name=clean(mapped.payment_name)
    mapped.payment_method=clean(mapped.payment_method)
    mapped.remark=clean(mapped.remark)
    mapped.raw_payload=raw
    mapped.line_items=[
      ['base_salary','基本工资','earn'],['attendance_salary','出勤工资','earn'],['leave_deduction','休假扣款','deduct'],
      ['late_deduction','迟到扣款','deduct'],['absence_deduction','缺勤扣款','deduct'],
      ['performance_adjustment','绩效调整','adjust'],['deposit_adjustment','押金调整','adjust'],
      ['overtime_bonus','额外加班','earn'],['other_adjustment','其他调整','adjust'],
    ].filter(([field])=>mapped[field]!==0).map(([code,label,type])=>({code,label,type,amount:mapped[code]}))
    rows.push(mapped)
  })
  if(!rows.length)throw new Error('文件中没有可导入的员工工资记录。')
  return {rows,headerIndex,headers:headers.map(clean)}
}

export default function AdminPayrollPage(){
  const [params,setParams]=useSearchParams()
  const urlTab=params.get('tab')
  const [tab,setTabState]=useState(TABS.includes(urlTab)?urlTab:TABS[0])
  const [state,setState]=useState({loading:true,error:'',data:null})
  const [batchId,setBatchId]=useState(null)
  const [fileState,setFileState]=useState({file:null,rows:[],error:'',loading:false})
  const [form,setForm]=useState({period:new Date().toISOString().slice(0,7),title:'',currency:'USD',notes:''})
  const [message,setMessage]=useState('')
  const [saving,setSaving]=useState(false)
  const fileRef=useRef(null)

  const setTab=value=>{
    setTabState(value);setParams(value===TABS[0]?{}:{tab:value})
    if(value==='工资导入')return
    const wantedStatus=value==='待发布'?'draft':value==='已发布'?'published':null
    const next=(state.data?.batches||[]).find(batch=>!wantedStatus||batch.status===wantedStatus)
    if(next){setBatchId(next.id);load(next.id)}
  }
  useEffect(()=>{if(TABS.includes(urlTab))setTabState(urlTab)},[urlTab])

  const load=async(selected=batchId)=>{
    setState(current=>({...current,loading:true,error:''}))
    const {data,error}=await supabase.rpc('admin_payroll_home',{p_batch_id:selected||null})
    if(error)setState({loading:false,error:error.message,data:null})
    else{
      setState({loading:false,error:'',data:data||null})
      if(data?.selected_batch?.id)setBatchId(data.selected_batch.id)
    }
  }
  useEffect(()=>{load(null)},[])

  const onFile=async file=>{
    if(!file)return
    setFileState({file,rows:[],error:'',loading:true})
    setMessage('')
    try{
      const parsed=normalizeRows(await readWorkbook(file))
      setFileState({file,rows:parsed.rows,error:'',loading:false})
      if(!form.title)setForm(current=>({...current,title:`${current.period} 工资`}))
    }catch(error){setFileState({file,rows:[],error:error.message||'文件读取失败',loading:false})}
  }

  const importRows=async()=>{
    if(!fileState.rows.length)return
    setSaving(true);setMessage('')
    const payload={
      period_start:`${form.period}-01`,title:form.title||`${form.period} 工资`,currency:form.currency,
      source_type:'upload',source_file_name:fileState.file?.name||'',notes:form.notes,
    }
    const {data,error}=await supabase.rpc('admin_payroll_import',{p_batch:payload,p_rows:fileState.rows})
    setSaving(false)
    if(error){setMessage(`导入失败：${error.message}`);return}
    setMessage(`导入完成：${data.rows} 人，匹配员工 ${data.matched} 人，未匹配 ${data.unmatched} 人。`)
    setBatchId(data.batch_id);setFileState({file:null,rows:[],error:'',loading:false});if(fileRef.current)fileRef.current.value=''
    await load(data.batch_id)
    setTabState('待发布');setParams({tab:'待发布'})
  }

  const publish=async id=>{
    setSaving(true);setMessage('')
    const {data,error}=await supabase.rpc('admin_payroll_publish',{p_batch_id:id})
    setSaving(false)
    if(error){setMessage(`发布失败：${error.message}`);return}
    setMessage(`已发布 ${data.rows} 份工资单，员工现在可以在“我的工资”查看。`)
    await load(id);setTabState('已发布');setParams({tab:'已发布'})
  }

  const batches=state.data?.batches||[]
  const visibleBatches=useMemo(()=>batches.filter(batch=>tab==='待发布'?batch.status==='draft':tab==='已发布'?batch.status==='published':true),[batches,tab])
  const selected=state.data?.selected_batch
  const visibleSelected=selected&&visibleBatches.some(batch=>Number(batch.id)===Number(selected.id))?selected:null
  const rows=state.data?.rows||[]

  return <div className="content-page payroll-admin-page">
    <div className="payroll-page-head"><div><small>PAYROLL MANAGEMENT</small><h1>工资中心</h1></div><button className="payroll-refresh" onClick={()=>load()}>刷新资料</button></div>
    {state.error&&<div className="payroll-alert error">{state.error}</div>}
    {message&&<div className="payroll-alert">{message}</div>}
    <div className="module-tabs payroll-tabs">{TABS.map(item=><button key={item} className={tab===item?'active':''} onClick={()=>setTab(item)}>{item}</button>)}</div>

    {tab==='工资导入'?<>
      <section className="payroll-upload-card">
        <div className="payroll-upload-copy"><span>01</span><div><h2>上传工资表</h2><p>支持 XLSX、CSV、TSV；自动识别中文、英文、越南文和印尼文常用表头。</p></div></div>
        <div className="payroll-import-form">
          <label>工资月份<input type="month" value={form.period} onChange={event=>setForm({...form,period:event.target.value})}/></label>
          <label>批次名称<input value={form.title} onChange={event=>setForm({...form,title:event.target.value})} placeholder={`${form.period} 工资`}/></label>
          <label>币种<select value={form.currency} onChange={event=>setForm({...form,currency:event.target.value})}><option>USD</option><option>PHP</option><option>CNY</option><option>VND</option><option>IDR</option></select></label>
          <label className="wide">备注<input value={form.notes} onChange={event=>setForm({...form,notes:event.target.value})} placeholder="例如：2026年7月正式工资"/></label>
        </div>
        <div className="payroll-drop-zone" onClick={()=>fileRef.current?.click()}>
          <input ref={fileRef} type="file" accept=".xlsx,.csv,.tsv,.txt" onChange={event=>onFile(event.target.files?.[0])}/>
          <strong>{fileState.loading?'正在读取表格…':fileState.file?fileState.file.name:'选择工资表文件'}</strong>
          <span>文件只用于导入工资数据，不会向员工公开整张表。</span>
        </div>
        {fileState.error&&<div className="payroll-file-error">{fileState.error}</div>}
      </section>
      {fileState.rows.length>0&&<section className="payroll-preview-card">
        <div className="payroll-section-head"><div><h2>导入预览</h2><p>共 {fileState.rows.length} 行；发布前先写入“待发布”批次。</p></div><button disabled={saving} onClick={importRows}>{saving?'导入中…':'确认导入'}</button></div>
        <PayrollRows rows={fileState.rows.slice(0,60)} currency={form.currency} preview/>
      </section>}
    </>:<>
      <section className="payroll-batch-strip">
        {visibleBatches.length?visibleBatches.map(batch=><button key={batch.id} className={Number(batchId)===Number(batch.id)?'active':''} onClick={()=>{setBatchId(batch.id);load(batch.id)}}>
          <span>{String(batch.period_start).slice(0,7)}</span><strong>{batch.title}</strong><small>{batch.row_count} 人 · 已匹配 {batch.matched_count} · 未匹配 {batch.unmatched_count}</small>
        </button>):<div className="payroll-empty-small">暂无对应工资批次</div>}
      </section>
      {visibleSelected&&<section className="payroll-preview-card">
        <div className="payroll-section-head"><div><h2>{visibleSelected.title}</h2><p>{visibleSelected.status==='published'?'已发布给员工':'仍在后台复核，员工暂时看不到'} · {visibleSelected.source_file_name||'系统数据'}</p></div>{visibleSelected.status==='draft'&&state.data?.permissions?.publish&&<button disabled={saving} onClick={()=>publish(visibleSelected.id)}>{saving?'发布中…':'发布给员工'}</button>}</div>
        <div className="payroll-summary-grid"><div><span>工资单</span><strong>{visibleSelected.row_count}</strong></div><div><span>已匹配</span><strong>{visibleSelected.matched_count}</strong></div><div><span>未匹配</span><strong className={visibleSelected.unmatched_count?'warn':''}>{visibleSelected.unmatched_count}</strong></div><div><span>合计实发</span><strong>{money(rows.reduce((sum,row)=>sum+Number(row.total_pay||0),0),visibleSelected.currency)}</strong></div></div>
        <PayrollRows rows={rows} currency={visibleSelected.currency}/>
      </section>}
    </>}
  </div>
}

function PayrollRows({rows,currency,preview=false}){
  return <div className="payroll-table-wrap"><table className="payroll-table"><thead><tr><th>#</th><th>员工ID</th><th>姓名</th><th>盘口</th><th>岗位</th><th>基础工资</th><th>出勤工资</th><th>实发工资</th><th>员工匹配</th><th>备注</th></tr></thead>
    <tbody>{rows.map((row,index)=><tr key={`${row.source_row||index}-${row.employee_no||row.full_name}`}><td>{row.source_row||index+1}</td><td><strong>{row.employee_no||'—'}</strong></td><td>{row.full_name||'—'}</td><td>{row.platform||'—'}</td><td>{row.position_name||'—'}</td><td>{money(row.base_salary,currency)}</td><td>{money(row.attendance_salary,currency)}</td><td className="payroll-total-cell">{money(row.total_pay,currency)}</td><td>{preview?<span className="payroll-match neutral">导入后匹配</span>:<span className={`payroll-match ${row.matched?'ok':'bad'}`}>{row.matched?'已匹配':'未匹配'}</span>}</td><td>{row.remark||'—'}</td></tr>)}</tbody>
  </table></div>
}
