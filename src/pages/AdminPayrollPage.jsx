import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Pagination } from '../components/DataPageControls'
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
  attendance_salary:['出勤工资','全勤工资','attendancesalary','gajikehadiran','lươngchuyêncần','luongchuyencan'],
  leave_deduction:['休假扣款','休假扣除','leavededuction','cuti','potongancuti'],
  late_deduction:['迟到','迟到扣款','latededuction','terlambat','đimuộn','dimuon'],
  absence_deduction:['缺勤','旷工','absencededuction','absen','vắngmặt','vangmat'],
  increment_adjustment:['递增','递增工资','increment','incrementadjustment'],
  attendance_bonus:['满勤','满勤奖','attendancebonus','fullattendancebonus'],
  performance_adjustment:['绩效','绩效调整','performance','performanceadjustment','kinerja','hiệusuất','hieusuat'],
  deposit_adjustment:['押金','押金调整','deposit','depositadjustment'],
  overtime_bonus:['额外加班','加班','overtime','overtimebonus','lembur','tăngca','tangca'],
  extra_adjustment:['额外加扣','额外调整','extraadjustment','extradeduction'],
  next_deduction:['下次要扣除','下次扣除','nextdeduction'],
  overpayment_deduction:['多转扣除','多付扣除','overpaymentdeduction'],
  source_group:['分组','组别','group','groupname'],
  departure_date:['离职日期','departuredate','resignationdate'],
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
    const numericFields=['base_salary','attendance_salary','leave_deduction','late_deduction','absence_deduction','increment_adjustment','attendance_bonus','performance_adjustment','deposit_adjustment','overtime_bonus','extra_adjustment','next_deduction','overpayment_deduction','other_adjustment','total_pay']
    numericFields.forEach(field=>{mapped[field]=number(mapped[field])})
    mapped.employee_no=clean(mapped.employee_no)
    mapped.full_name=clean(mapped.full_name)
    mapped.hire_date=isoDate(mapped.hire_date)
    mapped.platform=clean(mapped.platform)
    mapped.position_name=clean(mapped.position_name)
    mapped.card_number=clean(mapped.card_number)
    mapped.payment_name=clean(mapped.payment_name)
    mapped.payment_method=clean(mapped.payment_method)
    mapped.source_group=clean(mapped.source_group)
    mapped.departure_date=isoDate(mapped.departure_date)
    mapped.remark=clean(mapped.remark)
    mapped.raw_payload=raw
    mapped.raw_payload.__payroll_fields={
      increment_adjustment:mapped.increment_adjustment,
      attendance_bonus:mapped.attendance_bonus,
      extra_adjustment:mapped.extra_adjustment,
      next_deduction:mapped.next_deduction,
      overpayment_deduction:mapped.overpayment_deduction,
      source_group:mapped.source_group,
      departure_date:mapped.departure_date,
    }
    mapped.line_items=[
      ['attendance_salary','出勤工资','earn'],['leave_deduction','休假扣款','deduct'],
      ['late_deduction','迟到扣款','deduct'],['absence_deduction','缺勤扣款','deduct'],
      ['increment_adjustment','递增','earn'],['attendance_bonus','满勤','earn'],
      ['performance_adjustment','绩效调整','adjust'],['deposit_adjustment','押金调整','adjust'],
      ['overtime_bonus','额外加班','earn'],['extra_adjustment','额外加扣','adjust'],
      ['next_deduction','下次要扣除','deduct'],['overpayment_deduction','多转扣除','deduct'],
      ['other_adjustment','其他调整','adjust'],
    ].filter(([field])=>mapped[field]!==0).map(([code,label,type])=>({code,label,type,amount:mapped[code]}))
    rows.push(mapped)
  })
  if(!rows.length)throw new Error('文件中没有可导入的员工工资记录。')
  return {rows,headerIndex,headers:headers.map(clean)}
}

export default function AdminPayrollPage(){
  const navigate=useNavigate()
  const [params,setParams]=useSearchParams()
  const urlTab=params.get('tab')
  const [tab,setTabState]=useState(TABS.includes(urlTab)?urlTab:TABS[0])
  const [state,setState]=useState({loading:true,error:'',data:null})
  const [batchId,setBatchId]=useState(null)
  const [fileState,setFileState]=useState({file:null,rows:[],error:'',loading:false})
  const [form,setForm]=useState({period:new Date().toISOString().slice(0,7),title:'',currency:'PHP',notes:''})
  const [message,setMessage]=useState('')
  const [saving,setSaving]=useState(false)
  const [rowFilter,setRowFilter]=useState('all')
  const [rowSearch,setRowSearch]=useState('')
  const [positionFilter,setPositionFilter]=useState('')
  const [platformFilter,setPlatformFilter]=useState('')
  const [rowPage,setRowPage]=useState(1)
  const [rowPageSize,setRowPageSize]=useState(20)
  const fileRef=useRef(null)

  const setTab=value=>{
    setTabState(value);setParams(value===TABS[0]?{}:{tab:value})
    setRowFilter('all');setRowSearch('');setPositionFilter('');setPlatformFilter('');setRowPage(1)
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

  const deleteBatch=async batch=>{
    const warning=batch.status==='published'?'这份工资已发布给员工，删除后员工也无法再查看。':'这份工资尚未发布。'
    if(!window.confirm(`确认删除“${batch.title}”？\n${warning}\n此操作会删除该批次的全部 ${batch.row_count} 份工资记录。`))return
    setSaving(true);setMessage('')
    const {data,error}=await supabase.rpc('admin_payroll_delete',{p_batch_id:batch.id})
    setSaving(false)
    if(error){setMessage(`删除失败：${error.message}`);return}
    setMessage(`已删除“${batch.title}”及 ${data.rows||batch.row_count} 份工资记录。`)
    setBatchId(null);setRowFilter('all');setRowSearch('');setPositionFilter('');setPlatformFilter('');await load(null)
  }

  const batches=state.data?.batches||[]
  const visibleBatches=useMemo(()=>batches.filter(batch=>tab==='待发布'?batch.status==='draft':tab==='已发布'?batch.status==='published':true),[batches,tab])
  const selected=state.data?.selected_batch
  const visibleSelected=selected&&visibleBatches.some(batch=>Number(batch.id)===Number(selected.id))?selected:null
  const rows=state.data?.rows||[]
  const matchState=row=>row.match_state||(row.matched?'active':'unmatched')
  const positionOptions=useMemo(()=>[...new Set(rows.map(row=>clean(row.position_name)).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),[rows])
  const platformOptions=useMemo(()=>[...new Set(rows.map(row=>clean(row.platform)).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),[rows])
  const filteredRows=useMemo(()=>{
    const needle=key(rowSearch)
    return rows.filter(row=>{
      if(rowFilter!=='all'&&matchState(row)!==rowFilter)return false
      if(positionFilter&&clean(row.position_name)!==positionFilter)return false
      if(platformFilter&&clean(row.platform)!==platformFilter)return false
      if(needle){
        const haystack=key([row.employee_no,row.full_name,row.platform,row.source_group,row.position_name,row.payment_name,row.payment_method,row.card_number,row.remark].join(' '))
        if(!haystack.includes(needle))return false
      }
      return true
    })
  },[rows,rowFilter,rowSearch,positionFilter,platformFilter])
  const unmatchedCount=Number(visibleSelected?.unmatched_count??rows.filter(row=>matchState(row)==='unmatched').length)||0
  const rowPages=Math.max(1,Math.ceil(filteredRows.length/rowPageSize))
  const pagedRows=useMemo(()=>filteredRows.slice((rowPage-1)*rowPageSize,rowPage*rowPageSize),[filteredRows,rowPage,rowPageSize])
  useEffect(()=>{setRowPage(1)},[batchId,rowFilter,rowSearch,positionFilter,platformFilter])
  useEffect(()=>{setRowPage(current=>Math.min(current,rowPages))},[rowPages])
  const clearRowFilters=()=>{setRowFilter('all');setRowSearch('');setPositionFilter('');setPlatformFilter('');setRowPage(1)}
  const openEmployee=row=>{
    const employeeId=clean(row?.employee_id)
    if(!employeeId)return
    navigate(`/admin/employees?employee=${encodeURIComponent(employeeId)}`)
  }

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
          <label>币种<select value={form.currency} onChange={event=>setForm({...form,currency:event.target.value})}><option value="PHP">PHP · 菲律宾披索</option><option value="USD">USD · 美金</option></select></label>
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
        {visibleBatches.length?visibleBatches.map(batch=><button key={batch.id} className={Number(batchId)===Number(batch.id)?'active':''} onClick={()=>{clearRowFilters();setBatchId(batch.id);load(batch.id)}}>
          <span>{String(batch.period_start).slice(0,7)}</span><strong>{batch.title}</strong><small>{batch.row_count} 人 · 在职 {batch.active_count??batch.matched_count??0} · 离职 {batch.resigned_count??0} · 未匹配 {batch.unresolved_count??batch.unmatched_count??0}</small>
        </button>):<div className="payroll-empty-small">暂无对应工资批次</div>}
      </section>
      {visibleSelected&&<section className="payroll-preview-card">
        <div className="payroll-section-head"><div><h2>{visibleSelected.title}</h2><p>{visibleSelected.status==='published'?'已发布给员工':'仍在后台复核，员工暂时看不到'} · {visibleSelected.source_file_name||'系统数据'} · 币种 {visibleSelected.currency}</p></div><div className="payroll-section-actions">{visibleSelected.status==='draft'&&state.data?.permissions?.publish&&<button disabled={saving} onClick={()=>publish(visibleSelected.id)}>{saving?'发布中…':'发布给员工'}</button>}{state.data?.permissions?.edit&&<button className="danger" disabled={saving} onClick={()=>deleteBatch(visibleSelected)}>删除批次</button>}</div></div>
        <div className="payroll-summary-grid"><button type="button" className={rowFilter==='all'?'active':''} onClick={()=>setRowFilter('all')}><span>工资单</span><strong>{visibleSelected.row_count}</strong><small>全部记录</small></button><button type="button" className={rowFilter==='active'?'active':''} onClick={()=>setRowFilter('active')}><span>在职员工</span><strong>{visibleSelected.active_count??rows.filter(row=>matchState(row)==='active').length}</strong><small>当前在职</small></button><button type="button" className={rowFilter==='resigned'?'active':''} onClick={()=>setRowFilter('resigned')}><span>离职员工</span><strong>{visibleSelected.resigned_count??rows.filter(row=>matchState(row)==='resigned').length}</strong><small>历史记录保留</small></button><button type="button" className={`${rowFilter==='unmatched'?'active':''} ${unmatchedCount>0?'has-warning':''}`} disabled={unmatchedCount===0} onClick={unmatchedCount>0?()=>setRowFilter('unmatched'):undefined}><span>未匹配</span><strong className={unmatchedCount>0?'warn':''}>{unmatchedCount}</strong><small>{unmatchedCount>0?'需要核对':'没有数据'}</small></button><div><span>合计实发</span><strong>{money(rows.reduce((sum,row)=>sum+Number(row.total_pay||0),0),visibleSelected.currency)}</strong><small>{visibleSelected.currency==='PHP'?'菲律宾披索':'美金'}</small></div></div>
        <div className="payroll-record-filters">
          <label className="payroll-search-wide"><span>综合搜索</span><input value={rowSearch} onChange={event=>setRowSearch(event.target.value)} placeholder="员工ID / 姓名 / 盘口 / 卡号 / 收款姓名 / 备注"/></label>
          <label><span>员工状态</span><select value={rowFilter} onChange={event=>setRowFilter(event.target.value)}><option value="all">全部状态</option><option value="active">在职员工</option><option value="resigned">离职员工</option><option value="unmatched" disabled={unmatchedCount===0}>未匹配{unmatchedCount===0?'（没有数据）':''}</option></select></label>
          <label><span>岗位</span><select value={positionFilter} onChange={event=>setPositionFilter(event.target.value)}><option value="">全部岗位</option>{positionOptions.map(value=><option key={value}>{value}</option>)}</select></label>
          <label><span>盘口</span><select value={platformFilter} onChange={event=>setPlatformFilter(event.target.value)}><option value="">全部盘口</option>{platformOptions.map(value=><option key={value}>{value}</option>)}</select></label>
          <div className="payroll-filter-actions"><button type="button" onClick={clearRowFilters}>重置</button></div>
        </div>
        {rowFilter==='unmatched'&&<div className="payroll-unmatched-note">仅显示无法按员工ID或唯一姓名关联员工档案的记录；已离职员工会保留并归类到“离职员工”。</div>}
        <div className="payroll-filter-result">筛选结果 {filteredRows.length} / {rows.length} 条 · 第 {rowPage} / {rowPages} 页</div>
        <PayrollRows rows={pagedRows} currency={visibleSelected.currency} onOpenEmployee={openEmployee}/>
        <Pagination page={rowPage} pages={rowPages} total={filteredRows.length} pageSize={rowPageSize} loading={state.loading} onPage={setRowPage} onPageSize={value=>{setRowPageSize(value);setRowPage(1)}}/>
      </section>}
    </>}
  </div>
}

function PayrollRows({rows,currency,preview=false,onOpenEmployee}){
  const [expandedPlatform,setExpandedPlatform]=useState('')
  useEffect(()=>{
    if(!expandedPlatform)return undefined
    const close=event=>{if(event.key==='Escape')setExpandedPlatform('')}
    window.addEventListener('keydown',close)
    return()=>window.removeEventListener('keydown',close)
  },[expandedPlatform])
  const stateOf=row=>row.match_state||(row.matched?'active':'unmatched')
  const matchLabel=row=>({active:'在职员工',resigned:'离职员工',unmatched:'未匹配'}[stateOf(row)]||'未匹配')
  const matchClass=row=>({active:'ok',resigned:'resigned',unmatched:'bad'}[stateOf(row)]||'bad')
  return <><div className="payroll-table-wrap"><table className="payroll-table payroll-table-complete"><thead><tr><th>#</th><th>员工ID</th><th>姓名</th><th>盘口</th><th>分组</th><th>岗位</th><th>入职日期</th><th>离职日期</th><th>卡号</th><th>收款姓名</th><th>银行 / GCASH</th><th>基础工资</th><th>出勤工资</th><th>休假扣款</th><th>递增</th><th>满勤</th><th>绩效</th><th>押金</th><th>额外加班</th><th>额外加扣</th><th>下次要扣除</th><th>多转扣除</th><th>其他调整</th><th>实发工资</th><th>员工匹配</th><th>备注</th></tr></thead>
    <tbody>{rows.length?rows.map((row,index)=><tr key={`${row.source_row||index}-${row.employee_no||row.full_name}`}><td>{row.source_row||index+1}</td><td>{!preview&&onOpenEmployee&&row.employee_id&&row.employee_no?<button type="button" className="payroll-employee-link" title="打开员工档案" onClick={()=>onOpenEmployee(row)}>{row.employee_no}</button>:<strong>{row.employee_no||'—'}</strong>}</td><td>{row.full_name||'—'}</td><td className="payroll-platform-cell"><button type="button" className="payroll-platform-value" disabled={!row.platform} title={row.platform?'点击查看完整盘口 / 平台':''} onClick={()=>row.platform&&setExpandedPlatform(row.platform)}>{row.platform||'—'}</button></td><td>{row.source_group||'—'}</td><td>{row.position_name||'—'}</td><td>{row.hire_date||'—'}</td><td>{row.departure_date||'—'}</td><td>{row.card_number||'—'}</td><td>{row.payment_name||'—'}</td><td>{row.payment_method||'—'}</td><td>{money(row.base_salary,currency)}</td><td>{money(row.attendance_salary,currency)}</td><td>{money(row.leave_deduction,currency)}</td><td>{money(row.increment_adjustment,currency)}</td><td>{money(row.attendance_bonus,currency)}</td><td>{money(row.performance_adjustment,currency)}</td><td>{money(row.deposit_adjustment,currency)}</td><td>{money(row.overtime_bonus,currency)}</td><td>{money(row.extra_adjustment,currency)}</td><td>{money(row.next_deduction,currency)}</td><td>{money(row.overpayment_deduction,currency)}</td><td>{money(row.other_adjustment,currency)}</td><td className="payroll-total-cell">{money(row.total_pay,currency)}</td><td>{preview?<span className="payroll-match neutral">导入后匹配</span>:<span className={`payroll-match ${matchClass(row)}`}>{matchLabel(row)}</span>}</td><td className="payroll-remark-cell">{row.remark||'—'}</td></tr>):<tr><td className="payroll-table-empty" colSpan="26">暂无符合条件的工资记录</td></tr>}</tbody>
  </table></div>{expandedPlatform&&<div className="payroll-value-modal-backdrop" role="presentation" onMouseDown={()=>setExpandedPlatform('')}><div className="payroll-value-modal" role="dialog" aria-modal="true" aria-labelledby="payroll-platform-modal-title" onMouseDown={event=>event.stopPropagation()}><header><h3 id="payroll-platform-modal-title">完整盘口 / 平台</h3><button type="button" aria-label="关闭" onClick={()=>setExpandedPlatform('')}>×</button></header><p>{expandedPlatform}</p></div></div>}</>
}
