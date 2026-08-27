import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Pagination } from '../components/DataPageControls'
import AdminModuleNav from '../components/AdminModuleNav'
import { AdminPayoutChangeWorkspace } from '../components/PaymentChangeWorkflow'
import { adminLocalPageTabs, adminTabParams, adminTabSlug, canonicalAdminTab } from '../config/navigation'
import { PERMISSIONS } from '../config/permissions'
import { useAdminAccess } from '../lib/adminAccess'
import { useAdminI18n } from '../lib/adminI18n'
import { PAYROLL_CURRENCY_OPTIONS, payrollCurrencyLabel } from '../lib/payrollCurrency'
import { payrollBatchIdentity, payrollMatchState, summarizePayrollRows } from '../lib/payrollImportState'
import { supabase } from '../lib/supabase'

const PAYOUT_CHANGE_VIEW=PERMISSIONS.PAYROLL_CHANGE_HISTORY_VIEW
const PAYOUT_CHANGE_REVIEW=PERMISSIONS.PAYROLL_CHANGE_HISTORY_REVIEW
const PAYMENT_CHANGE_TABS=new Set(['收款资料审核','申请记录'])
const TABS = ['工资导入','待发布','已发布','导入记录','收款资料审核','申请记录']
const PAYROLL_SUMMARY_ONLY_BATCH_ID=0
const clean = value => String(value ?? '').trim()
const key = value => clean(value).toLowerCase().replace(/[\s_\-\/()（）.：:]+/g,'')
const payrollMonth=()=>{
  try{
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit'}).formatToParts(new Date())
    const values=Object.fromEntries(parts.map(part=>[part.type,part.value]))
    return `${values.year}-${values.month}`
  }catch{return new Date().toISOString().slice(0,7)}
}
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
const dateTime = value => {
  if(!value)return '—'
  const parsed=new Date(value)
  if(Number.isNaN(parsed.getTime()))return clean(value)
  return new Intl.DateTimeFormat('zh-CN',{
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,
  }).format(parsed).replaceAll('/','-')
}
const payrollBatchStatus=value=>({draft:'待发布',published:'已发布',archived:'已归档'}[clean(value).toLowerCase()]||clean(value)||'未知')
const payrollBatchDisplayStatus=batch=>batch?.voided_at?'已作废':payrollBatchStatus(batch?.status)
const payrollBatchStatusClass=batch=>batch?.voided_at?'voided':clean(batch?.status).toLowerCase()
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
  const [params,setParams]=useSearchParams()
  const access=useAdminAccess()
  const {t:adminT}=useAdminI18n()
  const routeTab=params.get('tab')
  const urlTab=canonicalAdminTab('/admin/payroll',routeTab)
  const visibleTabs=access.loading?[]:TABS.filter(value=>{
    if(value==='收款资料审核')return access.hasPermission(PAYOUT_CHANGE_VIEW)&&access.hasPermission(PAYOUT_CHANGE_REVIEW)
    if(value==='申请记录')return access.hasPermission(PERMISSIONS.PAYROLL_CHANGE_HISTORY_VIEW)
    if(value==='工资导入'||value==='导入记录')return access.hasPermission(PERMISSIONS.PAYROLL_IMPORT_HISTORY_VIEW)
    if(value==='待发布')return access.hasPermission(PERMISSIONS.PAYROLL_PENDING_VIEW)
    if(value==='已发布')return access.hasPermission(PERMISSIONS.PAYROLL_PUBLISHED_VIEW)
    return false
  })
  const [tab,setTabState]=useState(TABS.includes(urlTab)?urlTab:TABS[0])
  const [state,setState]=useState({loading:true,error:'',data:null})
  const [batchId,setBatchId]=useState(null)
  const [fileState,setFileState]=useState({file:null,rows:[],error:'',loading:false})
  const [form,setForm]=useState({period:payrollMonth(),title:'',currency:'PHP',notes:''})
  const [message,setMessage]=useState('')
  const [saving,setSaving]=useState(false)
  const [rowFilter,setRowFilter]=useState('all')
  const [rowSearch,setRowSearch]=useState('')
  const [positionFilter,setPositionFilter]=useState('')
  const [platformFilter,setPlatformFilter]=useState('')
  const [rowPage,setRowPage]=useState(1)
  const [rowPageSize,setRowPageSize]=useState(20)
  const [employeePanel,setEmployeePanel]=useState(null)
  const fileRef=useRef(null)
  const employeeRequestRef=useRef(0)
  const loadRequestRef=useRef(0)

  const setTab=value=>{
    if(!visibleTabs.includes(value))return
    setTabState(value);setParams(value===TABS[0]?{}:adminTabParams('/admin/payroll',value))
    setRowFilter('all');setRowSearch('');setPositionFilter('');setPlatformFilter('');setRowPage(1)
  }

  const load=async(selected=batchId,targetTab=tab)=>{
    const requestId=++loadRequestRef.current
    if(PAYMENT_CHANGE_TABS.has(targetTab)){
      setState({loading:false,error:'',data:null})
      return
    }
    setState(current=>({...current,loading:true,error:''}))
    try{
      const homeRpc=targetTab==='待发布'?'admin_payroll_pending_page':targetTab==='已发布'?'admin_payroll_published_page':'admin_payroll_import_history_page'
      let response=await supabase.rpc(homeRpc,{p_batch_id:selected===null||selected===undefined?null:selected})
      if(requestId!==loadRequestRef.current)return
      if(response.error)throw response.error
      let data=response.data||null
      const wantedStatus=targetTab==='待发布'?'draft':targetTab==='已发布'?'published':null
      if(wantedStatus&&data?.selected_batch?.status!==wantedStatus){
        const target=(data?.batches||[]).find(batch=>batch.status===wantedStatus)
        if(target&&Number(data?.selected_batch?.id)!==Number(target.id)){
          response=await supabase.rpc(homeRpc,{p_batch_id:target.id})
          if(requestId!==loadRequestRef.current)return
          if(response.error)throw response.error
          data=response.data||null
        }
      }
      if(requestId!==loadRequestRef.current)return
      setState({loading:false,error:'',data})
      if(targetTab==='工资导入'||targetTab==='导入记录')setBatchId(null)
      else setBatchId(data?.selected_batch?.id||null)
    }catch(error){
      if(requestId!==loadRequestRef.current)return
      setState({loading:false,error:error?.message||'工资资料读取失败',data:null})
    }
  }
  useEffect(()=>{
    if(access.loading)return undefined
    const nextTab=visibleTabs.includes(urlTab)?urlTab:(visibleTabs[0]||'')
    if(!nextTab){setTabState('');setState({loading:false,error:'',data:null});return undefined}
    const desiredRouteTab=nextTab===TABS[0]?null:adminTabSlug('/admin/payroll',nextTab)
    if(routeTab!==desiredRouteTab){
      setParams(desiredRouteTab?{tab:desiredRouteTab}:{},{replace:true})
      return undefined
    }
    setTabState(nextTab)
    if(PAYMENT_CHANGE_TABS.has(nextTab)){
      setState({loading:false,error:'',data:null})
      return undefined
    }
    const selected=nextTab==='工资导入'||nextTab==='导入记录'?PAYROLL_SUMMARY_ONLY_BATCH_ID:null
    load(selected,nextTab)
    return()=>{loadRequestRef.current+=1}
  },[access.loading,access.founder,access.permissionKey,urlTab,routeTab])

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
    const resignedText=Number(data.resigned||0)>0?`，其中离职员工 ${data.resigned} 人`:''
    setMessage(`导入完成：${data.rows} 人，已识别 ${data.matched} 人${resignedText}，未匹配 ${data.unmatched} 人。`)
    setBatchId(data.batch_id);setFileState({file:null,rows:[],error:'',loading:false});if(fileRef.current)fileRef.current.value=''
    if(access.hasPermission(PERMISSIONS.PAYROLL_PENDING_VIEW)){
      await load(data.batch_id,'待发布')
      setTabState('待发布');setParams(adminTabParams('/admin/payroll','待发布'))
    }else{
      await load(PAYROLL_SUMMARY_ONLY_BATCH_ID,'导入记录')
    }
  }

  const publish=async id=>{
    setSaving(true);setMessage('')
    const {data,error}=await supabase.rpc('admin_payroll_publish',{p_batch_id:id})
    setSaving(false)
    if(error){setMessage(`发布失败：${error.message}`);return}
    const excluded=Number(data.excluded_rows||0)
    setMessage(`已发布 ${data.rows} 份工资单${excluded?`，另有 ${excluded} 份离职、停用或未匹配记录仅保留在后台`:''}。`)
    if(access.hasPermission(PERMISSIONS.PAYROLL_PUBLISHED_VIEW)){
      await load(id,'已发布');setTabState('已发布');setParams(adminTabParams('/admin/payroll','已发布'))
    }else{
      await load(null,'待发布')
    }
  }

  const deleteBatch=async batch=>{
    if(batch.status!=='draft')return
    if(!window.confirm(`确认移除草稿“${batch.title}”？\n工资记录不会被物理删除，将保留在“导入记录”并可恢复。`))return
    setSaving(true);setMessage('')
    const {data,error}=await supabase.rpc('admin_payroll_delete',{p_batch_id:batch.id})
    setSaving(false)
    if(error){setMessage(`删除失败：${error.message}`);return}
    setMessage(`已移除草稿“${batch.title}”；${data.rows||batch.row_count} 份工资记录仍保留在导入记录中，可随时恢复。`)
    setBatchId(null);setRowFilter('all');setRowSearch('');setPositionFilter('');setPlatformFilter('');await load(null)
  }

  const batches=state.data?.batches||[]
  const visibleBatches=useMemo(()=>batches.filter(batch=>tab==='待发布'?batch.status==='draft':tab==='已发布'?batch.status==='published':true),[batches,tab])
  const selected=state.data?.selected_batch
  const visibleSelected=selected&&visibleBatches.some(batch=>Number(batch.id)===Number(selected.id))?selected:null
  const rows=state.data?.rows||[]
  const rowStateCounts=useMemo(()=>summarizePayrollRows(rows),[rows])
  const positionOptions=useMemo(()=>[...new Set(rows.map(row=>clean(row.position_name)).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),[rows])
  const platformOptions=useMemo(()=>[...new Set(rows.map(row=>clean(row.platform)).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),[rows])
  const filteredRows=useMemo(()=>{
    const needle=key(rowSearch)
    return rows.filter(row=>{
      if(rowFilter!=='all'&&payrollMatchState(row)!==rowFilter)return false
      if(positionFilter&&clean(row.position_name)!==positionFilter)return false
      if(platformFilter&&clean(row.platform)!==platformFilter)return false
      if(needle){
        const haystack=key([row.employee_no,row.full_name,row.platform,row.source_group,row.position_name,row.payment_name,row.payment_method,row.card_number,row.remark].join(' '))
        if(!haystack.includes(needle))return false
      }
      return true
    })
  },[rows,rowFilter,rowSearch,positionFilter,platformFilter])
  const unmatchedCount=rowStateCounts.unmatched
  const rowPages=Math.max(1,Math.ceil(filteredRows.length/rowPageSize))
  const pagedRows=useMemo(()=>filteredRows.slice((rowPage-1)*rowPageSize,rowPage*rowPageSize),[filteredRows,rowPage,rowPageSize])
  useEffect(()=>{setRowPage(1)},[batchId,rowFilter,rowSearch,positionFilter,platformFilter])
  useEffect(()=>{setRowPage(current=>Math.min(current,rowPages))},[rowPages])
  const clearRowFilters=()=>{setRowFilter('all');setRowSearch('');setPositionFilter('');setPlatformFilter('');setRowPage(1)}
  const employeePanelOpen=Boolean(employeePanel)
  const closeEmployee=()=>{
    employeeRequestRef.current+=1
    setEmployeePanel(null)
  }
  useEffect(()=>{
    if(!employeePanelOpen)return undefined
    const previousOverflow=document.body.style.overflow
    const onKeyDown=event=>{
      if(event.key!=='Escape')return
      employeeRequestRef.current+=1
      setEmployeePanel(null)
    }
    document.body.style.overflow='hidden'
    window.addEventListener('keydown',onKeyDown)
    return()=>{
      document.body.style.overflow=previousOverflow
      window.removeEventListener('keydown',onKeyDown)
    }
  },[employeePanelOpen])
  const openEmployee=async row=>{
    const employeeId=clean(row?.employee_id)
    if(!employeeId)return
    const requestId=employeeRequestRef.current+1
    employeeRequestRef.current=requestId
    const fallback={
      id:employeeId,
      employee_no:clean(row.employee_no),
      full_name:clean(row.full_name),
      platform_scope:clean(row.platform),
      position_name:clean(row.position_name),
      hire_date:clean(row.hire_date),
      resign_date:clean(row.departure_date),
      group_name:clean(row.source_group),
      status:payrollMatchState(row),
    }
    setEmployeePanel({loading:true,error:'',employee:fallback})
    try{
      const {data,error}=await supabase.functions.invoke('admin-employees',{body:{action:'detail',employee_id:employeeId}})
      if(employeeRequestRef.current!==requestId)return
      if(error||data?.error){
        setEmployeePanel({loading:false,error:data?.error||error?.message||'员工档案读取失败',employee:fallback})
        return
      }
      const detail=data||{}
      const employee=detail.employee||detail.profile||detail
      setEmployeePanel({loading:false,error:'',employee:{...fallback,...employee}})
    }catch(error){
      if(employeeRequestRef.current!==requestId)return
      setEmployeePanel({loading:false,error:error?.message||'员工档案读取失败',employee:fallback})
    }
  }

  const pageChrome=adminLocalPageTabs('/admin/payroll',visibleTabs,tab)
  const sectionTitle=pageChrome.active.sectionLabel||'工资统计'
  const canMutateWholePayroll=access.founder||access.dataScope==='all'
  const hasWholePayrollAction=access.hasAnyPermission([
    PERMISSIONS.PAYROLL_IMPORT_HISTORY_EDIT,
    PERMISSIONS.PAYROLL_PENDING_EDIT,
    PERMISSIONS.PAYROLL_PENDING_APPROVE,
    PERMISSIONS.PAYROLL_PENDING_PUBLISH,
  ])
  const uploadWorkspace=canMutateWholePayroll&&access.hasPermission(PERMISSIONS.PAYROLL_IMPORT_HISTORY_EDIT)?<PayrollUploadWorkspace
    fileRef={fileRef}
    fileState={fileState}
    form={form}
    saving={saving}
    setForm={setForm}
    onFile={onFile}
    onImport={importRows}
  />:null

  return <div className="content-page payroll-admin-page">
    <div className="payroll-page-head"><div><small>PAYROLL REPORTS</small><h1>{adminT(sectionTitle)}</h1>{pageChrome.active.itemLabel&&<p>{adminT(pageChrome.active.itemLabel)}</p>}</div>{!PAYMENT_CHANGE_TABS.has(tab)&&<button className="payroll-refresh" disabled={access.loading||!tab} onClick={()=>load(tab==='工资导入'||tab==='导入记录'?PAYROLL_SUMMARY_ONLY_BATCH_ID:batchId)}>{adminT('刷新资料')}</button>}</div>
    {state.error&&<div className="payroll-alert error">{state.error}</div>}
    {message&&<div className="payroll-alert">{message}</div>}
    {!canMutateWholePayroll&&hasWholePayrollAction&&<div className="payroll-alert">当前账号为有限员工范围；可查看范围内工资，但导入、删除、审核和发布整批工资仅限“全部数据”范围账号。</div>}
    <AdminModuleNav />

    {access.loading?<div className="payroll-empty-small">{adminT('正在读取页面权限…')}</div>:!tab?<div className="payroll-alert error">{adminT('当前账号没有工资中心页面权限。')}</div>:PAYMENT_CHANGE_TABS.has(tab)?<AdminPayoutChangeWorkspace mode={tab==='收款资料审核'?'pending':'history'} canReview={access.hasPermission(PAYOUT_CHANGE_REVIEW)}/>:tab==='工资导入'?uploadWorkspace:tab==='导入记录'?<>
      {uploadWorkspace}
      <PayrollImportHistory
        batches={batches}
        canEdit={Boolean(canMutateWholePayroll&&state.data?.permissions?.edit&&access.hasPermission(PERMISSIONS.PAYROLL_IMPORT_HISTORY_EDIT))}
        onChanged={async nextMessage=>{setMessage(nextMessage);await load(PAYROLL_SUMMARY_ONLY_BATCH_ID,'导入记录')}}
        onOpenEmployee={openEmployee}
      />
    </>:<>
      <section className="payroll-batch-strip">
        {visibleBatches.length?visibleBatches.map(batch=><button key={payrollBatchIdentity(batch)} className={Number(batchId)===Number(batch.id)?'active':''} onClick={()=>{clearRowFilters();setBatchId(batch.id);load(batch.id)}}>
          <span>{String(batch.period_start).slice(0,7)} · #{payrollBatchIdentity(batch)}</span><strong>{batch.title}</strong><small>{batch.row_count} 人 · 在职/试用 {batch.active_count??batch.matched_count??0} · 停用 {batch.suspended_count??0} · 离职 {batch.resigned_count??0} · 未匹配 {batch.unresolved_count??batch.unmatched_count??0}</small>
        </button>):<div className="payroll-empty-small">{tab==='已发布'?(state.data?.empty_reason||'当前无有效发布批次，最近批次已删除/归档；请到“导入记录”核对。'):'暂无对应工资批次'}</div>}
      </section>
      {visibleSelected&&<section className="payroll-preview-card">
        <div className="payroll-section-head"><div><h2>{visibleSelected.title}</h2><p>{visibleSelected.status==='published'?'已发布给员工':'仍在后台复核，员工暂时看不到'} · {visibleSelected.source_file_name||'系统数据'} · 币种 {visibleSelected.currency}</p></div><div className="payroll-section-actions">{visibleSelected.status==='draft'&&state.data?.permissions?.publish&&access.hasPermission(PERMISSIONS.PAYROLL_PENDING_PUBLISH)&&<button disabled={saving} onClick={()=>publish(visibleSelected.id)}>{saving?'发布中…':'发布给员工'}</button>}{state.data?.permissions?.edit&&access.hasPermission(PERMISSIONS.PAYROLL_PENDING_EDIT)&&(visibleSelected.status!=='published'||state.data?.permissions?.publish)&&<button className="danger" disabled={saving} onClick={()=>deleteBatch(visibleSelected)}>删除批次</button>}</div></div>
        <div className="payroll-summary-grid"><button type="button" className={rowFilter==='active'?'active':''} onClick={()=>setRowFilter('active')}><span>在职 / 试用</span><strong>{rowStateCounts.active}</strong><small>在职与试用</small></button><button type="button" className={rowFilter==='suspended'?'active':''} onClick={()=>setRowFilter('suspended')}><span>停用员工</span><strong>{rowStateCounts.suspended}</strong><small>停用 / inactive</small></button><button type="button" className={rowFilter==='resigned'?'active':''} onClick={()=>setRowFilter('resigned')}><span>离职员工</span><strong>{rowStateCounts.resigned}</strong><small>历史记录保留</small></button><button type="button" className={`${rowFilter==='unmatched'?'active':''} ${unmatchedCount>0?'has-warning':''}`} disabled={unmatchedCount===0} onClick={unmatchedCount>0?()=>setRowFilter('unmatched'):undefined}><span>未匹配</span><strong className={unmatchedCount>0?'warn':''}>{unmatchedCount}</strong><small>{unmatchedCount>0?'需要核对':'没有数据'}</small></button><div><span>合计实发</span><strong>{money(rows.reduce((sum,row)=>sum+Number(row.total_pay||0),0),visibleSelected.currency)}</strong><small>{rowStateCounts.total} 人 · {payrollCurrencyLabel(visibleSelected.currency)}</small></div></div>
        <div className="payroll-record-filters">
          <label className="payroll-search-wide"><span>综合搜索</span><input value={rowSearch} onChange={event=>setRowSearch(event.target.value)} placeholder="员工ID / 姓名 / 盘口 / 卡号 / 收款姓名 / 备注"/></label>
          <label><span>员工状态</span><select value={rowFilter} onChange={event=>setRowFilter(event.target.value)}><option value="all">全部状态</option><option value="active">在职 / 试用</option><option value="suspended">停用员工</option><option value="resigned">离职员工</option><option value="unmatched" disabled={unmatchedCount===0}>未匹配{unmatchedCount===0?'（没有数据）':''}</option></select></label>
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
    {employeePanel&&<PayrollEmployeeDrawer panel={employeePanel} onClose={closeEmployee}/>}
  </div>
}

function PayrollUploadWorkspace({fileRef,fileState,form,saving,setForm,onFile,onImport}){
  return <>
    <section className="payroll-upload-card payroll-import-record-upload">
      <div className="payroll-upload-copy"><span>↑</span><div><h2>上传工资表</h2><p>选择工资月份和币种后上传 XLSX、CSV 或 TSV；导入成功后会先进入“待发布工资表”。</p></div></div>
      <div className="payroll-import-form">
        <label>工资月份<input type="month" value={form.period} onChange={event=>setForm({...form,period:event.target.value})}/></label>
        <label>批次名称<input value={form.title} onChange={event=>setForm({...form,title:event.target.value})} placeholder={`${form.period} 工资`}/></label>
        <label>对应币种<select value={form.currency} onChange={event=>setForm({...form,currency:event.target.value})}>{PAYROLL_CURRENCY_OPTIONS.map(option=><option key={option.code} value={option.code}>{option.code} · {option.label}</option>)}</select></label>
        <label className="wide">备注<input value={form.notes} onChange={event=>setForm({...form,notes:event.target.value})} placeholder="例如：2026年8月正式工资"/></label>
      </div>
      <div className="payroll-drop-zone" onClick={()=>fileRef.current?.click()}>
        <input ref={fileRef} type="file" accept=".xlsx,.csv,.tsv,.txt" onChange={event=>onFile(event.target.files?.[0])}/>
        <strong>{fileState.loading?'正在读取表格…':fileState.file?fileState.file.name:'选择工资表文件'}</strong>
        <span>支持中文、英文、越南文和印尼文常用表头；整张原始表不会公开给员工。</span>
      </div>
      {fileState.error&&<div className="payroll-file-error">{fileState.error}</div>}
    </section>
    {fileState.rows.length>0&&<section className="payroll-preview-card">
      <div className="payroll-section-head"><div><h2>导入预览</h2><p>共 {fileState.rows.length} 行 · 币种 {form.currency}；发布前先写入“待发布工资表”。</p></div><button disabled={saving} onClick={onImport}>{saving?'导入中…':'确认导入'}</button></div>
      <PayrollRows rows={fileState.rows.slice(0,60)} currency={form.currency} preview/>
    </section>}
  </>
}

function PayrollImportHistory({batches,canEdit=false,onChanged,onOpenEmployee}){
  const requestRef=useRef(0)
  const [panel,setPanel]=useState(null)
  const [editForm,setEditForm]=useState({title:'',notes:''})
  const [voidReason,setVoidReason]=useState('')
  const [actionBusy,setActionBusy]=useState('')
  const [actionError,setActionError]=useState('')
  const [search,setSearch]=useState('')
  const [matchFilter,setMatchFilter]=useState('all')
  const [positionFilter,setPositionFilter]=useState('')
  const [platformFilter,setPlatformFilter]=useState('')
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(20)
  const history=useMemo(()=>[...(batches||[])].sort((left,right)=>{
    const byCreated=new Date(right.created_at||0).getTime()-new Date(left.created_at||0).getTime()
    if(byCreated)return byCreated
    return Number(right.id||0)-Number(left.id||0)
  }),[batches])
  const rows=panel?.rows||[]
  const selected=panel?.selected||panel?.batch||null
  const positionOptions=useMemo(()=>[...new Set(rows.map(row=>clean(row.position_name)).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),[rows])
  const platformOptions=useMemo(()=>[...new Set(rows.map(row=>clean(row.platform)).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),[rows])
  const filteredRows=useMemo(()=>{
    const needle=key(search)
    return rows.filter(row=>{
      if(matchFilter!=='all'&&payrollMatchState(row)!==matchFilter)return false
      if(positionFilter&&clean(row.position_name)!==positionFilter)return false
      if(platformFilter&&clean(row.platform)!==platformFilter)return false
      if(!needle)return true
      return key([row.employee_no,row.full_name,row.platform,row.source_group,row.position_name,row.payment_name,row.payment_method,row.card_number,row.remark].join(' ')).includes(needle)
    })
  },[rows,search,matchFilter,positionFilter,platformFilter])
  const pages=Math.max(1,Math.ceil(filteredRows.length/pageSize))
  const pagedRows=useMemo(()=>filteredRows.slice((page-1)*pageSize,page*pageSize),[filteredRows,page,pageSize])
  const totalAmount=rows.reduce((sum,row)=>sum+Number(row.total_pay||0),0)
  const unmatched=rows.filter(row=>payrollMatchState(row)==='unmatched').length

  const resetFilters=()=>{
    setSearch('');setMatchFilter('all');setPositionFilter('');setPlatformFilter('');setPage(1)
  }
  const closePanel=()=>{
    requestRef.current+=1
    setPanel(null)
    setActionBusy('');setActionError('');setVoidReason('')
    resetFilters()
  }
  const openBatch=async batch=>{
    const requestId=requestRef.current+1
    requestRef.current=requestId
    resetFilters()
    setActionError('');setVoidReason('')
    setPanel({batch,selected:batch,rows:[],loading:true,error:''})
    try{
      const {data,error}=await supabase.rpc('admin_payroll_import_history_page',{p_batch_id:batch.id})
      if(requestRef.current!==requestId)return
      if(error){
        setPanel({batch,selected:batch,rows:[],loading:false,error:error.message||'批次记录读取失败'})
        return
      }
      const nextSelected=data?.selected_batch||batch
      setPanel({batch:nextSelected,selected:nextSelected,rows:data?.rows||[],loading:false,error:''})
    }catch(error){
      if(requestRef.current!==requestId)return
      setPanel({batch,selected:batch,rows:[],loading:false,error:error?.message||'批次记录读取失败'})
    }
  }
  useEffect(()=>{
    if(!selected)return
    setEditForm({title:clean(selected.title),notes:clean(selected.notes)})
  },[selected?.id,selected?.updated_at])
  const runBatchAction=async(name,rpc,args,success,{close=false}={})=>{
    if(actionBusy)return
    setActionBusy(name);setActionError('')
    try{
      const {data,error}=await supabase.rpc(rpc,args)
      if(error)throw error
      const nextMessage=typeof success==='function'?success(data||{}):success
      if(onChanged)await onChanged(nextMessage)
      if(close){closePanel();return}
      await openBatch({...selected,...data})
    }catch(error){setActionError(error?.message||'批次操作失败')}
    finally{setActionBusy('')}
  }
  const saveBatch=()=>runBatchAction('save','admin_payroll_update_batch',{
    p_batch_id:selected.id,p_title:editForm.title,p_notes:editForm.notes,
  },'批次名称和备注已更新。')
  const removeDraft=()=>{
    if(!window.confirm(`确认移除草稿“${selected.title}”？\n记录不会被物理删除，可在这里恢复。`))return
    runBatchAction('void','admin_payroll_delete',{p_batch_id:selected.id},'草稿已安全移除；记录和审计日志仍保留，可恢复。')
  }
  const voidArchived=()=>runBatchAction('void','admin_payroll_void_batch',{
    p_batch_id:selected.id,p_reason:voidReason,
  },'归档批次已作废；数据未被删除，可恢复。')
  const restoreBatch=()=>runBatchAction('restore','admin_payroll_restore_batch',{
    p_batch_id:selected.id,
  },data=>`批次已恢复为“${payrollBatchStatus(data.status)}”。`)
  const cloneCorrection=()=>{
    if(!window.confirm(`将“${selected.title}”完整复制为新的待发布纠正草稿？\n原批次保持只读，不会被修改。`))return
    runBatchAction('clone','admin_payroll_clone_correction',{p_batch_id:selected.id},data=>`已创建纠正草稿“${data.title||`批次 #${data.batch_id}`}”。`,{close:true})
  }
  useEffect(()=>{setPage(1)},[search,matchFilter,positionFilter,platformFilter,selected?.id])
  useEffect(()=>{setPage(current=>Math.min(current,pages))},[pages])
  useEffect(()=>{
    if(!panel)return undefined
    const previousOverflow=document.body.style.overflow
    const onKeyDown=event=>{if(event.key==='Escape')closePanel()}
    document.body.style.overflow='hidden'
    window.addEventListener('keydown',onKeyDown)
    return()=>{
      document.body.style.overflow=previousOverflow
      window.removeEventListener('keydown',onKeyDown)
    }
  },[Boolean(panel)])

  return <>
    <section className="payroll-import-history-card">
      <div className="payroll-import-history-head">
        <div><h2>导入批次</h2><p>已归档表示同月份新批次发布后自动替代旧批次；历史数据仍会保留。</p></div>
        <span>共 {history.length} 个批次</span>
      </div>
      <div className="payroll-import-history-list">
        <div className="payroll-import-history-columns" aria-hidden="true"><span>导入文档</span><span>工资月份</span><span>操作人</span><span>导入时间</span><span>人数</span><span>总金额</span><span>状态</span><span/></div>
        {history.length?history.map(batch=>{
          const hasTotal=batch.total_amount!==undefined&&batch.total_amount!==null
          return <button type="button" key={payrollBatchIdentity(batch)} className="payroll-import-history-row" onClick={()=>openBatch(batch)}>
            <span className="payroll-import-file"><b>{batch.source_file_name||batch.title||'未命名工资文档'}</b><small>批次 #{payrollBatchIdentity(batch)} · {batch.source_file_name&&batch.title&&batch.source_file_name!==batch.title?batch.title:(batch.source_type==='upload'?'文件上传':'系统导入')}</small></span>
            <span className="payroll-import-period">{String(batch.period_start||'').slice(0,7)||'—'}</span>
            <span className="payroll-import-actors"><b>上传 {batch.created_by_name||'—'}</b><small>编辑 {batch.updated_by_name||'—'}</small>{batch.published_at&&<small>发布 {batch.published_by_name||'—'}</small>}</span>
            <span className="payroll-import-time">{dateTime(batch.created_at)}</span>
            <span className="payroll-import-count"><b>{Number(batch.row_count||0).toLocaleString()}</b><small>人</small></span>
            <span className="payroll-import-total"><b>{hasTotal?money(batch.total_amount,batch.currency):'—'}</b><small>{batch.currency||'USD'}</small></span>
            <span><i className={`payroll-batch-status ${payrollBatchStatusClass(batch)}`}>{payrollBatchDisplayStatus(batch)}</i></span>
            <span className="payroll-import-open">查看记录 <b aria-hidden="true">→</b></span>
          </button>
        }):<div className="payroll-import-history-empty">暂无工资导入记录</div>}
      </div>
    </section>
    {panel&&<div className="payroll-batch-modal-backdrop" role="presentation" onMouseDown={closePanel}>
      <section className="payroll-batch-modal" role="dialog" aria-modal="true" aria-labelledby="payroll-batch-modal-title" onMouseDown={event=>event.stopPropagation()}>
        <header className="payroll-batch-modal-head">
          <div><span>PAYROLL IMPORT RECORD</span><h2 id="payroll-batch-modal-title">{selected?.source_file_name||selected?.title||'工资导入记录'}</h2><p>{selected?.title||'—'} · {String(selected?.period_start||'').slice(0,7)||'—'}</p></div>
          <button type="button" className="payroll-dialog-close" aria-label="关闭批次记录" onClick={closePanel}><span aria-hidden="true">×</span></button>
        </header>
        <div className="payroll-batch-modal-body">
          <div className="payroll-batch-facts">
            <div><span>文档批次 / 导入时间</span><strong>#{payrollBatchIdentity(selected)} · {dateTime(selected?.created_at)}</strong></div>
            <div><span>上传人</span><strong>{selected?.created_by_name||'—'} · {dateTime(selected?.created_at)}</strong></div>
            <div><span>最近编辑人</span><strong>{selected?.updated_by_name||'—'} · {dateTime(selected?.updated_at)}</strong></div>
            <div><span>发布人</span><strong>{selected?.published_at?`${selected?.published_by_name||'—'} · ${dateTime(selected?.published_at)}`:'尚未发布'}</strong></div>
            <div><span>工资单</span><strong>{Number(selected?.row_count||rows.length).toLocaleString()} 人</strong></div>
            <div><span>合计实发</span><strong>{panel.loading?'读取中…':money(totalAmount,selected?.currency)}</strong></div>
            <div><span>币种 / 状态</span><strong>{selected?.currency||'USD'} · {payrollBatchDisplayStatus(selected)}</strong></div>
            <div><span>纠正来源</span><strong>{selected?.correction_of_batch_id?`批次 #${selected.correction_of_batch_id}`:'原始导入'}</strong></div>
          </div>
          {selected?.status==='archived'&&!selected?.voided_at&&<div className="payroll-lifecycle-note">“已归档”不是删除：同月份的新批次发布后，旧发布批次会自动归档，员工只看到当前有效发布批次。</div>}
          {selected?.voided_at&&<div className="payroll-lifecycle-note is-voided">该批次已作废：{selected?.void_reason||'未填写原因'} · 操作人 {selected?.voided_by_name||'—'} · {dateTime(selected?.voided_at)}。工资记录和审计历史仍完整保留。</div>}
          {canEdit&&selected&&!panel.loading&&!panel.error&&<section className="payroll-batch-correction-box">
            <div><strong>批次纠错</strong><p>{selected.voided_at?'可恢复被安全移除的批次。':selected.status==='published'?'已发布批次保持只读；请复制为纠正草稿后修改并重新发布。':selected.status==='archived'?'归档批次可修正名称/备注、作废记录或复制纠正草稿；工资金额保持只读。':'草稿可修改批次名称和备注，也可安全移除。'}</p></div>
            {['draft','archived'].includes(selected.status)&&!selected.voided_at&&<div className="payroll-batch-edit-form"><label>批次名称<input value={editForm.title} maxLength={200} onChange={event=>setEditForm(current=>({...current,title:event.target.value}))}/></label><label>备注<textarea value={editForm.notes} maxLength={2000} onChange={event=>setEditForm(current=>({...current,notes:event.target.value}))}/></label></div>}
            {selected.status==='archived'&&!selected.voided_at&&<label className="payroll-void-reason">作废原因<textarea value={voidReason} maxLength={1000} onChange={event=>setVoidReason(event.target.value)} placeholder="例如：导入文件或备注名称错误（必填）"/></label>}
            <div className="payroll-batch-correction-actions">
              {selected.status==='draft'&&!selected.voided_at&&<><button type="button" disabled={Boolean(actionBusy)||!clean(editForm.title)} onClick={saveBatch}>{actionBusy==='save'?'保存中…':'保存批次资料'}</button><button type="button" className="danger" disabled={Boolean(actionBusy)} onClick={removeDraft}>{actionBusy==='void'?'移除中…':'删除草稿（可恢复）'}</button></>}
              {selected.status==='archived'&&!selected.voided_at&&<><button type="button" disabled={Boolean(actionBusy)||!clean(editForm.title)} onClick={saveBatch}>{actionBusy==='save'?'保存中…':'保存名称/备注'}</button><button type="button" disabled={Boolean(actionBusy)} onClick={cloneCorrection}>{actionBusy==='clone'?'创建中…':'复制为纠正草稿'}</button><button type="button" className="danger" disabled={Boolean(actionBusy)||!clean(voidReason)} onClick={voidArchived}>{actionBusy==='void'?'作废中…':'作废导入记录'}</button></>}
              {selected.status==='published'&&!selected.voided_at&&<button type="button" disabled={Boolean(actionBusy)} onClick={cloneCorrection}>{actionBusy==='clone'?'创建中…':'创建纠正草稿'}</button>}
              {selected.voided_at&&<button type="button" disabled={Boolean(actionBusy)} onClick={restoreBatch}>{actionBusy==='restore'?'恢复中…':'恢复批次'}</button>}
            </div>
            {actionError&&<p className="payroll-batch-action-error">{actionError}</p>}
          </section>}
          {panel.loading?<div className="payroll-batch-loading"><i/><span>正在读取该文档的员工工资记录…</span></div>:panel.error?<div className="payroll-batch-load-error"><span>{panel.error}</span><button type="button" onClick={()=>openBatch(panel.batch)}>重试</button></div>:<>
            <div className="payroll-record-filters payroll-batch-record-filters">
              <label className="payroll-search-wide"><span>综合搜索</span><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="员工ID / 姓名 / 盘口 / 卡号 / 收款姓名 / 备注"/></label>
              <label><span>员工状态</span><select value={matchFilter} onChange={event=>setMatchFilter(event.target.value)}><option value="all">全部状态</option><option value="active">在职 / 试用</option><option value="suspended">停用员工</option><option value="resigned">离职员工</option><option value="unmatched" disabled={unmatched===0}>未匹配{unmatched===0?'（没有数据）':''}</option></select></label>
              <label><span>岗位</span><select value={positionFilter} onChange={event=>setPositionFilter(event.target.value)}><option value="">全部岗位</option>{positionOptions.map(value=><option key={value}>{value}</option>)}</select></label>
              <label><span>盘口</span><select value={platformFilter} onChange={event=>setPlatformFilter(event.target.value)}><option value="">全部盘口</option>{platformOptions.map(value=><option key={value}>{value}</option>)}</select></label>
              <div className="payroll-filter-actions"><button type="button" onClick={resetFilters}>重置</button></div>
            </div>
            <div className="payroll-filter-result">筛选结果 {filteredRows.length} / {rows.length} 条 · 第 {page} / {pages} 页</div>
            <PayrollRows rows={pagedRows} currency={selected?.currency||'USD'} onOpenEmployee={onOpenEmployee}/>
            <Pagination page={page} pages={pages} total={filteredRows.length} pageSize={pageSize} loading={panel.loading} onPage={setPage} onPageSize={value=>{setPageSize(value);setPage(1)}}/>
          </>}
        </div>
      </section>
    </div>}
  </>
}

function PayrollRows({rows,currency,preview=false,onOpenEmployee}){
  const [detailDialog,setDetailDialog]=useState(null)
  useEffect(()=>{
    if(!detailDialog)return undefined
    const previousOverflow=document.body.style.overflow
    const close=event=>{if(event.key==='Escape')setDetailDialog(null)}
    document.body.style.overflow='hidden'
    window.addEventListener('keydown',close)
    return()=>{
      document.body.style.overflow=previousOverflow
      window.removeEventListener('keydown',close)
    }
  },[detailDialog])
  const matchLabel=row=>({active:'在职 / 试用',suspended:'停用',resigned:'离职员工',unmatched:'未匹配'}[payrollMatchState(row)]||'未匹配')
  const matchClass=row=>({active:'ok',suspended:'neutral',resigned:'resigned',unmatched:'bad'}[payrollMatchState(row)]||'bad')
  const openText=(title,value)=>value&&setDetailDialog({title,value})
  const openItems=(title,items,subtitle='')=>setDetailDialog({title,items,subtitle})
  return <><div className="payroll-table-wrap"><table className="payroll-table payroll-table-complete payroll-table-compact"><thead><tr><th>#</th><th>员工</th><th>组织 / 岗位</th><th>任职日期</th><th>收款资料</th><th>基础工资</th><th>出勤工资</th><th>加扣明细</th><th>实发工资</th><th>匹配</th><th>备注</th></tr></thead>
    <tbody>{rows.length?rows.map((row,index)=>{
      const salaryItems=payrollSalaryItems(row,currency)
      const adjustmentCount=salaryItems.filter(item=>item.group==='adjustment'&&Number(item.raw)!==0).length
      const paymentItems=[['收款姓名',row.payment_name],['银行 / GCASH',row.payment_method],['卡号',row.card_number]].filter(([,value])=>clean(value))
      return <tr key={`${row.source_row||index}-${row.employee_no||row.full_name}`}>
        <td className="payroll-sequence-cell">{row.source_row||index+1}</td>
        <td className="payroll-person-cell">
          {row.full_name?<button type="button" className="payroll-compact-value payroll-name-value" title={row.full_name} aria-label={`查看完整姓名：${row.full_name}`} onClick={()=>openText('完整姓名',row.full_name)}>{row.full_name}</button>:<strong>—</strong>}
          {!preview&&onOpenEmployee&&row.employee_id&&row.employee_no?<button type="button" className="payroll-employee-link" title="打开完整员工档案" onClick={()=>onOpenEmployee(row)}>{row.employee_no}</button>:<small>{row.employee_no||'—'}</small>}
        </td>
        <td className="payroll-organization-cell">
          <strong title={row.position_name||''}>{row.position_name||'未填写岗位'}</strong>
          {row.source_group&&<small title={row.source_group}>{row.source_group}</small>}
          {row.platform&&<button type="button" className="payroll-compact-value payroll-platform-value" title={row.platform} aria-label={`查看完整盘口：${row.platform}`} onClick={()=>openText('完整盘口 / 平台',row.platform)}>{row.platform}</button>}
        </td>
        <td className="payroll-date-cell"><span><i>入</i>{row.hire_date||'—'}</span>{row.departure_date&&<span><i>离</i>{row.departure_date}</span>}</td>
        <td className="payroll-payment-cell">{paymentItems.length?<button type="button" className="payroll-payment-summary" title="查看完整收款资料" onClick={()=>openItems('完整收款资料',paymentItems,row.full_name||row.employee_no)}><strong>{row.payment_name||row.payment_method||'收款资料'}</strong><small>{[row.payment_method,row.card_number].filter(Boolean).join(' · ')||'点击查看'}</small></button>:<span>—</span>}</td>
        <td className="payroll-money-cell">{money(row.base_salary,currency)}</td>
        <td className="payroll-money-cell">{money(row.attendance_salary,currency)}</td>
        <td className="payroll-breakdown-cell"><button type="button" className="payroll-breakdown-button" onClick={()=>openItems('完整工资构成',salaryItems,`${row.employee_no||'—'} · ${row.full_name||'—'}`)}><strong>{adjustmentCount?`${adjustmentCount} 项`:'无调整'}</strong><small>查看全部明细</small></button></td>
        <td className="payroll-total-cell">{money(row.total_pay,currency)}</td>
        <td>{preview?<span className="payroll-match neutral">导入后匹配</span>:<span className={`payroll-match ${matchClass(row)}`}>{matchLabel(row)}</span>}</td>
        <td className="payroll-remark-cell">{row.remark?<button type="button" className="payroll-compact-value payroll-remark-value" title={row.remark} aria-label="查看完整备注" onClick={()=>openText('完整备注',row.remark)}>{row.remark}</button>:<span>—</span>}</td>
      </tr>
    }):<tr><td className="payroll-table-empty" colSpan="11">暂无符合条件的工资记录</td></tr>}</tbody>
  </table></div>{detailDialog&&<PayrollValueDialog dialog={detailDialog} onClose={()=>setDetailDialog(null)}/>}</>
}

const PAYROLL_SALARY_FIELDS=[
  ['基础工资','base_salary','base'],['出勤工资','attendance_salary','earn'],
  ['休假扣款','leave_deduction','deduct'],['迟到扣款','late_deduction','deduct'],['缺勤扣款','absence_deduction','deduct'],
  ['递增','increment_adjustment','adjust'],['满勤','attendance_bonus','adjust'],['绩效','performance_adjustment','adjust'],
  ['押金','deposit_adjustment','adjust'],['额外加班','overtime_bonus','adjust'],['额外加扣','extra_adjustment','adjust'],
  ['下次要扣除','next_deduction','deduct'],['多转扣除','overpayment_deduction','deduct'],['其他调整','other_adjustment','adjust'],
  ['实发工资','total_pay','total'],
]

function payrollSalaryItems(row,currency){
  return PAYROLL_SALARY_FIELDS.map(([label,field,tone])=>({label,value:money(row[field],currency),raw:row[field],tone,group:['base_salary','attendance_salary','total_pay'].includes(field)?'primary':'adjustment'}))
}

function PayrollValueDialog({dialog,onClose}){
  return <div className="payroll-value-modal-backdrop" role="presentation" onMouseDown={onClose}>
    <div className={`payroll-value-modal ${dialog.items?'payroll-detail-modal':''}`} role="dialog" aria-modal="true" aria-labelledby="payroll-value-modal-title" onMouseDown={event=>event.stopPropagation()}>
      <header><div><h3 id="payroll-value-modal-title">{dialog.title}</h3>{dialog.subtitle&&<small>{dialog.subtitle}</small>}</div><button type="button" className="payroll-dialog-close" aria-label="关闭" onClick={onClose}><span aria-hidden="true">×</span></button></header>
      {dialog.items?<dl className="payroll-detail-list">{dialog.items.map(item=>{
        const tuple=Array.isArray(item)?{label:item[0],value:item[1]}:item
        return <div key={tuple.label} className={tuple.tone?`is-${tuple.tone}`:''}><dt>{tuple.label}</dt><dd>{clean(tuple.value)||'—'}</dd></div>
      })}</dl>:<p>{dialog.value}</p>}
    </div>
  </div>
}

const payrollDisplayValue=value=>{
  if(value==null)return ''
  if(typeof value==='object')return clean(value.name||value.title||value.label)
  return clean(value)
}
const payrollReadPath=(record,path)=>path.split('.').reduce((value,part)=>value?.[part],record)
const payrollPick=(record,...paths)=>{
  for(const path of paths){
    const value=payrollDisplayValue(payrollReadPath(record,path))
    if(value)return value
  }
  return '—'
}
const payrollStatusLabel=value=>({active:'在职 / 试用',probation:'在职 / 试用',suspended:'停用',inactive:'停用',resigned:'离职',unmatched:'未匹配',pending:'待入职'}[clean(value).toLowerCase()]||payrollDisplayValue(value)||'—')
const payrollTypeLabel=value=>({home_ph:'纯居家菲律宾',home_vn:'纯居家越南',home_id:'纯居家印尼',home_mm:'纯居家缅甸',onsite_to_home:'现场转居家',pure_remote:'纯居家',remote:'居家',onsite:'现场',hybrid:'混合办公'}[clean(value).toLowerCase()]||payrollDisplayValue(value)||'—')

function PayrollEmployeeDrawer({panel,onClose}){
  const employee=panel.employee||{}
  const name=payrollPick(employee,'full_name','name')
  const employeeNo=payrollPick(employee,'employee_no','employeeNo')
  const status=payrollStatusLabel(payrollPick(employee,'status'))
  const basicRows=[
    ['员工ID',employeeNo],
    ['姓名',name],
    ['员工国家',payrollPick(employee,'country','nationality')],
    ['员工类型',payrollTypeLabel(payrollPick(employee,'employment_type','employee_type'))],
    ['状态',status],
    ['入职日期',payrollPick(employee,'hire_date')],
    ['离职日期',payrollPick(employee,'resign_date','departure_date')],
  ]
  const organizationRows=[
    ['团队',payrollPick(employee,'teams.name','team.name','team_name','team')],
    ['组别',payrollPick(employee,'groups.name','group.name','group_name')],
    ['岗位',payrollPick(employee,'positions.name','position.name','position_name','schedule_position')],
    ['班次',payrollPick(employee,'shift_name','shift.name','shift')],
    ['负责人 / 组长',payrollPick(employee,'person_in_charge','leader_name','manager_name')],
    ['培训老师',payrollPick(employee,'online_trainer','trainer_name')],
    ['盘口 / 平台',payrollPick(employee,'platform_scope','platform')],
    ['工作内容',payrollPick(employee,'work_content')],
  ]
  return <div className="payroll-employee-drawer-backdrop" role="presentation" onMouseDown={onClose}>
    <aside className="payroll-employee-drawer" role="dialog" aria-modal="true" aria-labelledby="payroll-employee-drawer-title" onMouseDown={event=>event.stopPropagation()}>
      <header className="payroll-employee-drawer-head">
        <div className="payroll-employee-avatar">{name==='—'?'E':name.slice(0,1).toUpperCase()}</div>
        <div><span>{employeeNo}</span><h2 id="payroll-employee-drawer-title">{name}</h2><div className="payroll-employee-badges"><b data-status={clean(employee.status).toLowerCase()}>{status}</b>{payrollPick(employee,'teams.name','team_name')!=='—'&&<b>{payrollPick(employee,'teams.name','team_name')}</b>}{payrollPick(employee,'positions.name','position_name')!=='—'&&<b>{payrollPick(employee,'positions.name','position_name')}</b>}</div></div>
        <button type="button" className="payroll-dialog-close" aria-label="关闭员工档案" onClick={onClose}><span aria-hidden="true">×</span></button>
      </header>
      <div className="payroll-employee-drawer-body">
        {panel.loading&&<div className="payroll-employee-loading"><i/><span>正在读取员工档案…</span></div>}
        {panel.error&&<div className="payroll-employee-error">{panel.error}</div>}
        <PayrollEmployeeSection title="基本资料" rows={basicRows}/>
        <PayrollEmployeeSection title="组织与岗位" rows={organizationRows}/>
      </div>
    </aside>
  </div>
}

function PayrollEmployeeSection({title,rows}){
  return <section className="payroll-employee-section"><h3>{title}</h3><dl>{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'—'}</dd></div>)}</dl></section>
}
