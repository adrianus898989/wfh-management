import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Pagination } from './DataPageControls'

const text=value=>String(value??'').trim()
const EVIDENCE_BUCKET='connectivity-evidence'
const MAX_EVIDENCE_FILES=3
const MAX_EVIDENCE_SIZE=50*1024*1024
const ALLOWED_EVIDENCE_TYPES=new Set(['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','video/mp4','video/quicktime','video/webm'])
const today=()=>{
  const d=new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
const typeLabel=value=>({power_outage:'停电',internet_outage:'断网'}[value]||value||'—')
const statusLabel=value=>({reported:'已记录',verified:'已核实',resolved:'已恢复',rejected:'不成立'}[value]||value||'—')
const durationLabel=value=>{
  const minutes=Number(value)
  if(!Number.isFinite(minutes)||minutes<=0)return '—'
  const hours=Math.floor(minutes/60),rest=minutes%60
  return `${hours?`${hours}小时`:''}${rest?`${rest}分钟`:''}`
}
const calculatedDuration=(start,end)=>{
  if(!start||!end)return 0
  const [sh,sm]=start.split(':').map(Number),[eh,em]=end.split(':').map(Number)
  if(![sh,sm,eh,em].every(Number.isFinite))return 0
  const from=sh*60+sm,to=eh*60+em
  return to>=from?to-from:24*60-from+to
}
const initialFilters=()=>({q:'',incident_type:'',status:'',country:'',date_from:'',date_to:''})
const initialRecord=()=>({employee_no:'',incident_date:today(),incident_type:'internet_outage',started_at:'',ended_at:'',details:''})
const evidenceItems=row=>Array.isArray(row?.attachments)?row.attachments:[]
const evidenceMime=file=>{
  if(file.type)return file.type.toLowerCase()
  const ext=file.name.split('.').pop()?.toLowerCase()
  return ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',heic:'image/heic',heif:'image/heif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm'}[ext]||'')
}
const safeFileName=name=>text(name).replace(/[^\p{L}\p{N}._-]+/gu,'-').replace(/^-+|-+$/g,'').slice(-90)||'evidence'

function EvidenceLinks({items=[],legacyUrl=''}){
  const [busy,setBusy]=useState('')
  const [preview,setPreview]=useState(null)
  const open=async item=>{
    if(!item?.path)return
    setBusy(item.path)
    const {data,error}=await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(item.path,300)
    setBusy('')
    if(error){window.alert(`附件打开失败：${error.message}`);return}
    setPreview({url:data.signedUrl,mime:item.mime||'',name:item.name||'证明文件'})
  }
  if(!items.length&&!legacyUrl)return null
  return <><div className="connectivity-evidence-links">{items.map((item,index)=><button type="button" key={item.path||index} onClick={()=>open(item)} disabled={busy===item.path}>{busy===item.path?'打开中…':`${String(item.mime||'').startsWith('video/')?'视频':'图片'} ${index+1}`}</button>)}{legacyUrl&&<button type="button" onClick={()=>setPreview({url:legacyUrl,mime:'image/*',name:'旧证明'})}>旧证明</button>}</div>{preview&&<div className="connectivity-lightbox" role="dialog" aria-modal="true" aria-label={preview.name} onMouseDown={()=>setPreview(null)}><div onMouseDown={event=>event.stopPropagation()}><header><strong>{preview.name}</strong><button type="button" onClick={()=>setPreview(null)}>×</button></header>{String(preview.mime).startsWith('video/')?<video src={preview.url} controls autoPlay/>:<img src={preview.url} alt={preview.name}/>}</div></div>}</>
}

export function ConnectivityRecordsPage(){
  const [filters,setFilters]=useState(initialFilters)
  const [applied,setApplied]=useState(initialFilters)
  const [state,setState]=useState({loading:true,error:'',data:null})
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(30)
  const [showCreate,setShowCreate]=useState(false)
  const [record,setRecord]=useState(initialRecord)
  const [files,setFiles]=useState([])
  const [saving,setSaving]=useState(false)
  const [message,setMessage]=useState('')
  const [formError,setFormError]=useState('')
  const [employeeLookup,setEmployeeLookup]=useState({status:'idle',employee:null,message:''})

  const load=async(nextPage=page,nextSize=pageSize,nextFilters=applied)=>{
    setState(current=>({...current,loading:true,error:''}))
    const {data,error}=await supabase.rpc('admin_connectivity_home',{p_filters:{...nextFilters,page:nextPage,page_size:nextSize}})
    if(error)setState({loading:false,error:error.message,data:null})
    else setState({loading:false,error:'',data:data||null})
  }
  useEffect(()=>{load(1,pageSize,applied)},[])

  const query=()=>{const next={...filters};setApplied(next);setPage(1);load(1,pageSize,next)}
  const reset=()=>{const next=initialFilters();setFilters(next);setApplied(next);setPage(1);load(1,pageSize,next)}
  const openCreate=()=>{setRecord(initialRecord());setFiles([]);setFormError('');setEmployeeLookup({status:'idle',employee:null,message:''});setShowCreate(true)}
  const closeCreate=()=>{if(saving)return;setShowCreate(false);setFiles([]);setFormError('');setEmployeeLookup({status:'idle',employee:null,message:''})}
  useEffect(()=>{
    if(!showCreate)return undefined
    const employeeNo=text(record.employee_no)
    if(!employeeNo){setEmployeeLookup({status:'idle',employee:null,message:''});return undefined}
    if(employeeNo.replace(/[^a-z0-9]/gi,'').length<4){setEmployeeLookup({status:'typing',employee:null,message:'继续输入完整员工ID'});return undefined}
    let cancelled=false
    setEmployeeLookup({status:'loading',employee:null,message:'正在检测员工…'})
    const timer=window.setTimeout(async()=>{
      const {data,error}=await supabase.rpc('admin_connectivity_employee_lookup',{p_employee_no:employeeNo})
      if(cancelled)return
      if(error){setEmployeeLookup({status:'error',employee:null,message:'暂时无法检测，请稍后重试'});return}
      if(!data?.found){setEmployeeLookup({status:'missing',employee:null,message:'找不到这个员工ID，请核对'});return}
      setEmployeeLookup({status:'found',employee:data.employee,message:''})
    },350)
    return()=>{cancelled=true;window.clearTimeout(timer)}
  },[showCreate,record.employee_no])
  const chooseFiles=event=>{
    const next=[...event.target.files]
    event.target.value=''
    if(next.length>MAX_EVIDENCE_FILES){setFormError(`最多上传 ${MAX_EVIDENCE_FILES} 个图片或视频。`);return}
    const unsupported=next.find(file=>!ALLOWED_EVIDENCE_TYPES.has(evidenceMime(file)))
    if(unsupported){setFormError(`不支持文件“${unsupported.name}”，请选择图片、MP4、MOV 或 WebM 视频。`);return}
    const oversized=next.find(file=>file.size>MAX_EVIDENCE_SIZE)
    if(oversized){setFormError(`文件“${oversized.name}”超过 50MB。`);return}
    setFormError('');setFiles(next)
  }
  const save=async event=>{
    event.preventDefault();setFormError('');setMessage('')
    if(!text(record.employee_no)){setFormError('请填写员工ID。');return}
    if(employeeLookup.status!=='found'){setFormError(employeeLookup.status==='loading'?'正在检测员工，请稍候。':'员工ID尚未通过检测，请先核对。');return}
    if(!record.incident_date||!record.started_at||!record.ended_at){setFormError('请完整填写发生日期、开始时间和恢复时间。');return}
    setSaving(true)
    const uploaded=[]
    try{
      const {data:userData,error:userError}=await supabase.auth.getUser()
      if(userError||!userData?.user)throw new Error('登录状态已失效，请重新登录。')
      const employeeKey=text(record.employee_no).toUpperCase().replace(/[^A-Z0-9]/g,'')||'employee'
      for(let index=0;index<files.length;index+=1){
        const file=files[index],mime=evidenceMime(file)
        const unique=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${index}`
        const path=`${userData.user.id}/${employeeKey}/${record.incident_date}/${unique}-${safeFileName(file.name)}`
        const {data,error}=await supabase.storage.from(EVIDENCE_BUCKET).upload(path,file,{contentType:mime,upsert:false})
        if(error)throw error
        uploaded.push({path:data.path,name:file.name,mime,size:file.size})
      }
      const {data,error}=await supabase.rpc('admin_connectivity_create',{p_record:{...record,attachments:uploaded}})
      if(error)throw error
      setMessage(`已记录 ${data.employee_no}（${data.full_name}）的${typeLabel(record.incident_type)}情况。`)
      window.setTimeout(()=>setMessage(''),5000)
      setRecord(initialRecord());setFiles([]);setShowCreate(false);setPage(1);await load(1,pageSize,applied)
    }catch(error){
      if(uploaded.length)await supabase.storage.from(EVIDENCE_BUCKET).remove(uploaded.map(item=>item.path))
      setFormError(error.message==='employee_not_found'?'找不到这个员工ID，请核对后再保存。':`保存失败：${error.message}`)
    }finally{setSaving(false)}
  }
  const data=state.data||{},summary=data.summary||{},rows=data.rows||[],daily=data.daily_stats||[]
  const previewDuration=useMemo(()=>calculatedDuration(record.started_at,record.ended_at),[record.started_at,record.ended_at])
  return <div className="connectivity-page">
    <div className="connectivity-head"><div><h2>停电 / 断网记录</h2></div>{data.permissions?.create&&<button className="primary-action" onClick={openCreate}>＋ 新增记录</button>}</div>
    {message&&<div className="connectivity-toast" role="status"><span>✓</span>{message}</div>}
    {showCreate&&<div className="connectivity-modal-backdrop" role="presentation" onMouseDown={closeCreate}><form className="connectivity-modal" onSubmit={save} onMouseDown={event=>event.stopPropagation()}><header><div><small>NEW CONNECTIVITY RECORD</small><h3>新增停电 / 断网记录</h3></div><button type="button" onClick={closeCreate} disabled={saving}>×</button></header>{formError&&<div className="connectivity-form-error">{formError}</div>}<div className="connectivity-form-grid">
      <label className="connectivity-employee-field">员工ID<input autoFocus value={record.employee_no} onChange={event=>setRecord({...record,employee_no:event.target.value})} placeholder="例如 CS000134" required/><span className={`connectivity-employee-check ${employeeLookup.status}`}>{employeeLookup.status==='found'?<><b>{employeeLookup.employee.full_name}</b><em>{employeeLookup.employee.country||'未填写国家'} · {employeeLookup.employee.team_name||'未分配团队'} / {employeeLookup.employee.position_name||'未分配岗位'} · {employeeLookup.employee.status==='resigned'?'已离职':'在职'}</em></>:employeeLookup.message}</span></label>
      <label>发生日期<input type="date" value={record.incident_date} onChange={event=>setRecord({...record,incident_date:event.target.value})} required/></label>
      <label>问题类型<select value={record.incident_type} onChange={event=>setRecord({...record,incident_type:event.target.value})}><option value="power_outage">停电</option><option value="internet_outage">断网</option></select></label>
      <label>自动时长<input value={previewDuration?durationLabel(previewDuration):'填写开始与恢复时间后自动计算'} disabled/></label>
      <label>开始时间<input type="time" value={record.started_at} onChange={event=>setRecord({...record,started_at:event.target.value})} required/></label>
      <label>恢复时间<input type="time" value={record.ended_at} onChange={event=>setRecord({...record,ended_at:event.target.value})} required/></label>
      <label className="wide">情况说明（可选）<textarea value={record.details} onChange={event=>setRecord({...record,details:event.target.value})} placeholder="填写停电或断网原因、恢复情况等"/></label>
      <label className="wide connectivity-upload">图片 / 视频证明（可选，最多 3 个）<input type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,video/mp4,video/quicktime,video/webm" onChange={chooseFiles}/><span>支持图片、MP4、MOV、WebM；每个文件不超过 50MB。</span>{files.length>0&&<div>{files.map((file,index)=><button type="button" key={`${file.name}-${file.size}`} onClick={()=>setFiles(current=>current.filter((_,i)=>i!==index))}>{file.name}<b>×</b></button>)}</div>}</label>
    </div><footer><button type="button" className="secondary-action" onClick={closeCreate} disabled={saving}>取消</button><button type="submit" className="primary-action" disabled={saving}>{saving?'正在上传并保存…':'保存记录'}</button></footer></form></div>}
    <section className="connectivity-filter-card"><div className="connectivity-filter-grid">
      <label>员工<input value={filters.q} onChange={event=>setFilters({...filters,q:event.target.value})} onKeyDown={event=>event.key==='Enter'&&query()} placeholder="员工ID / 姓名"/></label>
      <label>问题类型<select value={filters.incident_type} onChange={event=>setFilters({...filters,incident_type:event.target.value})}><option value="">全部类型</option><option value="power_outage">停电</option><option value="internet_outage">断网</option></select></label>
      <label>员工国家<select value={filters.country} onChange={event=>setFilters({...filters,country:event.target.value})}><option value="">全部国家</option>{(data.country_options||[]).map(country=><option key={country}>{country}</option>)}</select></label>
      <label>状态<select value={filters.status} onChange={event=>setFilters({...filters,status:event.target.value})}><option value="">全部状态</option><option value="reported">已记录</option><option value="verified">已核实</option><option value="resolved">已恢复</option><option value="rejected">不成立</option></select></label>
      <label>日期起<input type="date" value={filters.date_from} onChange={event=>setFilters({...filters,date_from:event.target.value})}/></label>
      <label>日期止<input type="date" value={filters.date_to} onChange={event=>setFilters({...filters,date_to:event.target.value})}/></label>
      <div className="connectivity-filter-actions"><button className="primary-action" onClick={query} disabled={state.loading}>{state.loading?'查询中…':'查询'}</button><button className="secondary-action" onClick={reset}>重置</button></div>
    </div></section>
    <div className="connectivity-summary"><div><span>记录总数</span><strong>{summary.total||0}</strong></div><div><span>涉及员工</span><strong>{summary.affected_employees||0}</strong></div><div><span>停电</span><strong>{summary.power||0}</strong></div><div><span>断网</span><strong>{summary.internet||0}</strong></div></div>
    <section className="connectivity-daily-card"><header><div><h3>每日情况统计</h3></div><span>显示最近 {daily.length} 个有记录的日期</span></header>{daily.length?<div className="connectivity-daily-list">{daily.map(day=><article key={day.incident_date}><strong>{day.incident_date}</strong><span><b>{day.affected_employees}</b> 人</span><span>{day.total_records} 条记录</span><span className="power">停电 {day.power}</span><span className="internet">断网 {day.internet}</span><div>{(day.countries||[]).map(country=><em key={country.name}>{country.name} {country.employees}人</em>)}</div></article>)}</div>:<div className="connectivity-empty compact">暂无每日统计</div>}</section>
    <section className="connectivity-table-card">
      {state.error?<div className="connectivity-empty error">{state.error}</div>:state.loading&&!data.rows?<div className="connectivity-empty">正在读取记录…</div>:rows.length?<div className="connectivity-table-wrap"><table><thead><tr><th>日期</th><th>入职日期</th><th>员工ID</th><th>姓名</th><th>员工国家</th><th>团队 / 岗位</th><th>类型</th><th>开始 / 恢复</th><th>持续</th><th>状态</th><th>情况说明</th><th>证明</th><th>录入人</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><strong>{row.incident_date}</strong></td><td>{row.hire_date||'—'}</td><td><b>{row.employee_no}</b></td><td>{row.full_name}</td><td>{row.employee_country||'—'}</td><td>{row.team_name||'—'}<small>{row.position_name||'—'}</small></td><td><span className={`connectivity-type ${row.incident_type}`}>{typeLabel(row.incident_type)}</span></td><td>{text(row.started_at).slice(0,5)||'—'} → {text(row.ended_at).slice(0,5)||'—'}</td><td>{durationLabel(row.duration_minutes)}</td><td><span className={`connectivity-status ${row.status}`}>{statusLabel(row.status)}</span></td><td className="connectivity-details">{row.details||'—'}</td><td className="connectivity-proof"><EvidenceLinks items={evidenceItems(row)} legacyUrl={row.evidence_url}/>{!evidenceItems(row).length&&!row.evidence_url?'—':null}</td><td>{row.recorded_by_name||'—'}</td></tr>)}</tbody></table></div>:<div className="connectivity-empty">暂无符合条件的记录</div>}
      <Pagination page={Number(data.page||page)} pages={Number(data.pages||1)} total={Number(data.total||0)} pageSize={pageSize} loading={state.loading} onPage={next=>{setPage(next);load(next,pageSize,applied)}} onPageSize={next=>{setPageSize(next);setPage(1);load(1,next,applied)}}/>
    </section>
  </div>
}

export function EmployeeConnectivityPanel({data,loading,error}){
  const rows=data?.rows||[]
  return <section className="detail-panel employee-connectivity-panel"><div className="detail-panel-head"><h3>停电 / 断网记录</h3><span className="employee-exam-count">{data?.total||0} 条</span></div>{loading?<div className="connectivity-empty">正在读取记录…</div>:error?<div className="connectivity-empty error">{error}</div>:rows.length?<div className="employee-connectivity-list">{rows.map(row=><article key={row.id}><div><strong>{row.incident_date}</strong><span className={`connectivity-type ${row.incident_type}`}>{typeLabel(row.incident_type)}</span></div><div><small>时间 / 持续</small><p>{text(row.started_at).slice(0,5)||'—'} → {text(row.ended_at).slice(0,5)||'—'} · {durationLabel(row.duration_minutes)}</p></div><div><small>状态</small><p>{statusLabel(row.status)}</p></div><div className="wide"><small>情况说明</small><p>{row.details||'—'}</p></div><div className="wide connectivity-panel-proof"><small>证明</small><EvidenceLinks items={evidenceItems(row)} legacyUrl={row.evidence_url}/>{!evidenceItems(row).length&&!row.evidence_url?<p>—</p>:null}</div></article>)}</div>:<div className="connectivity-empty">暂无停电或断网记录</div>}</section>
}

export function EmployeePayrollHistoryPanel({data,loading,error}){
  const rows=data?.rows||[]
  const money=(value,currency)=>{try{return new Intl.NumberFormat('zh-CN',{style:'currency',currency:currency||'USD',maximumFractionDigits:2}).format(Number(value||0))}catch{return `${Number(value||0).toLocaleString()} ${currency||''}`}}
  return <section className="detail-panel employee-payroll-panel"><div className="detail-panel-head"><h3>工资记录</h3><span className="employee-exam-count">{data?.total||0} 份</span></div>{loading?<div className="connectivity-empty">正在读取工资记录…</div>:error?<div className="connectivity-empty error">{error}</div>:rows.length?<div className="employee-payroll-list">{rows.map(row=><article key={row.id}><header><div><strong>{String(row.period_start).slice(0,7)}</strong><span>{row.title}</span></div><span className={`payroll-match ${row.status==='published'?'ok':'neutral'}`}>{row.status==='published'?'已发布':'待发布'}</span></header><div className="employee-payroll-grid"><span><small>基础工资</small><b>{money(row.base_salary,row.currency)}</b></span><span><small>出勤工资</small><b>{money(row.attendance_salary,row.currency)}</b></span><span><small>扣款 / 调整</small><b>{money(Number(row.leave_deduction||0)+Number(row.late_deduction||0)+Number(row.absence_deduction||0)+Number(row.performance_adjustment||0)+Number(row.deposit_adjustment||0),row.currency)}</b></span><span><small>实发工资</small><b className="total">{money(row.total_pay,row.currency)}</b></span></div>{row.remark&&<p>{row.remark}</p>}</article>)}</div>:<div className="connectivity-empty">暂无工资记录</div>}</section>
}

export function EmployeeProfileMetrics({data,loading}){
  const total=Number(data?.total_errors||0)
  const grade=total>=20?'高频':total>=10?'重点':total>=5?'注意':total===0?'优秀':'正常'
  return <div className="wfh-v2722-risk-summary" data-grade={grade} data-profile-metrics="1"><div className="risk-grade"><span>等级</span><strong>{grade}</strong></div><div><span>本月记录</span><strong>{loading?'—':`${Number(data?.month_records||0)} 笔`}</strong></div><div><span>总错误</span><strong>{loading?'—':`${total} 笔`}</strong></div><div><span>考试总次数</span><strong>{loading?'—':`${Number(data?.exam_attempts||0)} 次`}</strong></div><div><span>平均考试分数</span><strong>{loading?'—':data?.exam_average==null?'—':`${Number(data.exam_average).toFixed(1)} 分`}</strong></div></div>
}
