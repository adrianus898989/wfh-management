import React, { useEffect, useMemo, useState } from 'react'
import { businessTodayIso, businessTodayRange } from '../lib/adminQueryDefaults'
import { supabase } from '../lib/supabase'
import { Pagination } from './DataPageControls'

const text=value=>String(value??'').trim()
const EVIDENCE_BUCKET='connectivity-evidence'
const MAX_EVIDENCE_FILES=3
const MAX_EVIDENCE_SIZE=50*1024*1024
const ALLOWED_EVIDENCE_TYPES=new Set(['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','video/mp4','video/quicktime','video/webm'])
const today=businessTodayIso
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
const initialFilters=()=>({employee_no:'',employee_name:'',team:'',position:'',incident_type:'',status:'',country:'',...businessTodayRange()})
const initialRecord=()=>({id:null,employee_no:'',incident_date:today(),incident_type:'internet_outage',started_at:'',ended_at:'',details:'',status:'reported'})
const evidenceItems=row=>Array.isArray(row?.attachments)?row.attachments:[]
const evidenceMime=file=>{
  if(file.type)return file.type.toLowerCase()
  const ext=file.name.split('.').pop()?.toLowerCase()
  return ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',heic:'image/heic',heif:'image/heif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm'}[ext]||'')
}
const safeFileName=name=>text(name).replace(/[^\p{L}\p{N}._-]+/gu,'-').replace(/^-+|-+$/g,'').slice(-90)||'evidence'
const removeEvidencePaths=async paths=>{
  if(!paths?.length)return null
  try{
    const {error}=await supabase.storage.from(EVIDENCE_BUCKET).remove(paths)
    return error||null
  }catch(error){return error}
}
const safeRemoteUrl=value=>{
  try{
    const parsed=new URL(text(value),globalThis.location?.origin||'https://invalid.local')
    return ['http:','https:'].includes(parsed.protocol)?parsed.href:''
  }catch{return ''}
}
const storagePathFromUrl=value=>{
  const url=safeRemoteUrl(value)
  if(!url)return ''
  try{
    const marker=`/${EVIDENCE_BUCKET}/`
    const pathname=new URL(url).pathname
    const index=pathname.indexOf(marker)
    return index<0?'':decodeURIComponent(pathname.slice(index+marker.length))
  }catch{return ''}
}

function EvidenceLinks({items=[],legacyUrl='',t}){
  const tr=typeof t==='function'?t:(_key,fallback)=>fallback
  const [busy,setBusy]=useState('')
  const [preview,setPreview]=useState(null)
  const previewObjectUrl=preview?.objectUrl?preview.url:''
  useEffect(()=>()=>{
    if(previewObjectUrl)URL.revokeObjectURL(previewObjectUrl)
  },[previewObjectUrl])
  useEffect(()=>{
    if(!preview)return undefined
    const closeOnEscape=event=>{if(event.key==='Escape')setPreview(null)}
    window.addEventListener('keydown',closeOnEscape)
    return()=>window.removeEventListener('keydown',closeOnEscape)
  },[preview])
  const downloadPreview=async item=>{
    const {data,error}=await supabase.storage.from(EVIDENCE_BUCKET).download(item.path)
    if(error||!data)throw error||new Error('preview_download_failed')
    const downloadedMime=/^(image|video)\//.test(data.type||'')?data.type:''
    return {url:URL.createObjectURL(data),objectUrl:true,mime:downloadedMime||item.mime||''}
  }
  const previewError=error=>{
    const value=`${error?.statusCode||error?.status||''} ${error?.message||''}`
    if(/401|jwt|session|auth/i.test(value))return tr('connectivity.previewSessionExpired','登录状态已失效，请重新登录。')
    if(/403|denied|permission|policy/i.test(value))return tr('connectivity.previewDenied','当前账号无权查看这份证明。')
    if(/404|not found|does not exist/i.test(value))return tr('connectivity.previewMissing','证明文件已被移动或删除。')
    return tr('connectivity.previewFailed','图片访问失败，请重试；若再次失败请联系管理员。')
  }
  const open=async(item,forceDownload=false)=>{
    if(!item?.path)return
    const name=item.name||tr('connectivity.evidenceFile','证明文件')
    setBusy(item.path)
    setPreview({item,url:'',mime:item.mime||'',name,error:false,loading:true,message:''})
    try{
      let resolved
      if(forceDownload)resolved=await downloadPreview(item)
      else{
        const {data,error}=await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(item.path,120)
        const signedUrl=safeRemoteUrl(data?.signedUrl)
        if(error||!signedUrl)resolved=await downloadPreview(item)
        else resolved={url:signedUrl,objectUrl:false,mime:item.mime||''}
      }
      setPreview({item,...resolved,name,error:false,loading:false,message:''})
    }catch(error){
      setPreview({item,url:'',mime:item.mime||'',name,error:true,loading:false,message:previewError(error)})
    }finally{
      setBusy('')
    }
  }
  const openLegacy=()=>{
    const url=safeRemoteUrl(legacyUrl)
    const path=storagePathFromUrl(url)
    if(path){open({path,mime:'image/*',name:tr('connectivity.legacyEvidence','旧证明')});return}
    setPreview({url,mime:'image/*',name:tr('connectivity.legacyEvidence','旧证明'),error:!url})
  }
  const mediaFailed=()=>{
    if(preview?.item&&!preview.objectUrl){open(preview.item,true);return}
    setPreview(current=>current?{...current,error:true}:current)
  }
  if(!items.length&&!legacyUrl)return null
  return <><div className="connectivity-evidence-links">{items.map((item,index)=><button type="button" key={item.path||index} onClick={()=>open(item)} disabled={busy===item.path}>{busy===item.path?tr('connectivity.opening','打开中…'):`${tr(String(item.mime||'').startsWith('video/')?'connectivity.video':'connectivity.image',String(item.mime||'').startsWith('video/')?'视频':'图片')} ${index+1}`}</button>)}{legacyUrl&&<button type="button" onClick={openLegacy}>{tr('connectivity.legacyEvidence','旧证明')}</button>}</div>{preview&&<div className="connectivity-lightbox" role="dialog" aria-modal="true" aria-label={preview.name} onMouseDown={()=>setPreview(null)}><div onMouseDown={event=>event.stopPropagation()}><header><strong>{preview.name}</strong><button type="button" aria-label={tr('common.close','关闭')} onClick={()=>setPreview(null)}>×</button></header>{preview.loading?<div className="connectivity-preview-fallback" role="status"><strong>{tr('connectivity.opening','打开中…')}</strong></div>:preview.error||!preview.url?<div className="connectivity-preview-fallback" role="alert"><strong>{preview.message||tr('connectivity.previewFailed','图片访问失败，请重试。')}</strong><div>{preview.item&&<button type="button" onClick={()=>open(preview.item)}>{tr('connectivity.retry','重试预览')}</button>}</div></div>:<div className="connectivity-preview-media">{String(preview.mime).startsWith('video/')?<video src={preview.url} controls autoPlay onError={mediaFailed}/>:<img src={preview.url} alt={preview.name} onError={mediaFailed}/>} {preview.objectUrl&&<a href={preview.url} download={preview.name}>{tr('connectivity.openOriginal','下载文件')}</a>}</div>}</div></div>}</>
}

export function ConnectivityRecordsPage(){
  const [filters,setFilters]=useState(initialFilters)
  const [applied,setApplied]=useState(initialFilters)
  const [state,setState]=useState({loading:true,error:'',data:null})
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(30)
  const [editor,setEditor]=useState('')
  const [record,setRecord]=useState(initialRecord)
  const [existingFiles,setExistingFiles]=useState([])
  const [originalFiles,setOriginalFiles]=useState([])
  const [files,setFiles]=useState([])
  const [saving,setSaving]=useState(false)
  const [message,setMessage]=useState('')
  const [formError,setFormError]=useState('')
  const [employeeLookup,setEmployeeLookup]=useState({status:'idle',employee:null,message:''})
  const [capabilities,setCapabilities]=useState({create:false,edit:false,delete:false})
  const [deleteTarget,setDeleteTarget]=useState(null)
  const [deleteError,setDeleteError]=useState('')
  const [deleting,setDeleting]=useState(false)

  const load=async(nextPage=page,nextSize=pageSize,nextFilters=applied)=>{
    setState(current=>({...current,loading:true,error:''}))
    const {data,error}=await supabase.rpc('admin_connectivity_home',{p_filters:{...nextFilters,page:nextPage,page_size:nextSize}})
    if(error)setState({loading:false,error:error.message,data:null})
    else setState({loading:false,error:'',data:data||null})
  }
  useEffect(()=>{load(1,pageSize,applied)},[])
  useEffect(()=>{
    let active=true
    Promise.all(['connectivity.create','connectivity.edit','connectivity.delete'].map(code=>supabase.rpc('has_permission',{p_permission_code:code}))).then(results=>{
      if(!active)return
      setCapabilities({create:Boolean(results[0].data&&!results[0].error),edit:Boolean(results[1].data&&!results[1].error),delete:Boolean(results[2].data&&!results[2].error)})
    })
    return()=>{active=false}
  },[])

  const query=()=>{const next={...filters};setApplied(next);setPage(1);load(1,pageSize,next)}
  const reset=()=>{const next=initialFilters();setFilters(next);setApplied(next);setPage(1);load(1,pageSize,next)}
  const flash=value=>{setMessage(value);window.setTimeout(()=>setMessage(''),5000)}
  const resetEditor=()=>{setEditor('');setRecord(initialRecord());setExistingFiles([]);setOriginalFiles([]);setFiles([]);setFormError('');setEmployeeLookup({status:'idle',employee:null,message:''})}
  const openCreate=()=>{resetEditor();setEditor('create')}
  const openEdit=row=>{
    const attachments=evidenceItems(row)
    setRecord({id:row.id,employee_no:row.employee_no||'',incident_date:row.incident_date||today(),incident_type:row.incident_type||'internet_outage',started_at:text(row.started_at).slice(0,5),ended_at:text(row.ended_at).slice(0,5),details:row.details||'',status:row.status||'reported'})
    setExistingFiles(attachments);setOriginalFiles(attachments);setFiles([]);setFormError('')
    setEmployeeLookup({status:'found',employee:{full_name:row.full_name,country:row.employee_country,team_name:row.team_name,position_name:row.position_name,status:row.employee_status},message:''})
    setEditor('edit')
  }
  const closeEditor=()=>{if(!saving)resetEditor()}
  useEffect(()=>{
    if(!editor)return undefined
    const employeeNo=text(record.employee_no)
    if(!employeeNo){setEmployeeLookup({status:'idle',employee:null,message:''});return undefined}
    if(employeeNo.replace(/[^a-z0-9]/gi,'').length<4){setEmployeeLookup({status:'typing',employee:null,message:'继续输入完整员工ID'});return undefined}
    let cancelled=false
    setEmployeeLookup({status:'loading',employee:null,message:'正在检测员工…'})
    const timer=window.setTimeout(async()=>{
      const rpc=editor==='edit'?'admin_connectivity_edit_employee_lookup':'admin_connectivity_employee_lookup'
      const {data,error}=await supabase.rpc(rpc,{p_employee_no:employeeNo})
      if(cancelled)return
      if(error){setEmployeeLookup({status:'error',employee:null,message:'暂时无法检测，请稍后重试'});return}
      if(!data?.found){setEmployeeLookup({status:'missing',employee:null,message:'找不到这个员工ID，请核对'});return}
      setEmployeeLookup({status:'found',employee:data.employee,message:''})
    },350)
    return()=>{cancelled=true;window.clearTimeout(timer)}
  },[editor,record.employee_no])
  const chooseFiles=event=>{
    const next=[...event.target.files]
    event.target.value=''
    const combined=[...files,...next]
    if(existingFiles.length+combined.length>MAX_EVIDENCE_FILES){setFormError(`最多保留 ${MAX_EVIDENCE_FILES} 个图片或视频。`);return}
    const unsupported=next.find(file=>!ALLOWED_EVIDENCE_TYPES.has(evidenceMime(file)))
    if(unsupported){setFormError(`不支持文件“${unsupported.name}”，请选择图片、MP4、MOV 或 WebM 视频。`);return}
    const oversized=next.find(file=>file.size>MAX_EVIDENCE_SIZE)
    if(oversized){setFormError(`文件“${oversized.name}”超过 50MB。`);return}
    setFormError('');setFiles(combined)
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
      const attachments=[...existingFiles,...uploaded]
      const rpc=editor==='edit'?'admin_connectivity_update':'admin_connectivity_create'
      const {data,error}=await supabase.rpc(rpc,{p_record:{...record,attachments}})
      if(error)throw error
      let cleanupWarning=''
      if(editor==='edit'){
        const kept=new Set(attachments.map(item=>item.path))
        const removed=originalFiles.map(item=>item.path).filter(path=>path&&!kept.has(path))
        if(removed.length){
          const removeError=await removeEvidencePaths(removed)
          if(removeError)cleanupWarning='记录已更新，但旧证明文件未能自动清理；文件已从记录隐藏，请联系管理员清理存储文件。'
        }
        flash(cleanupWarning||`已更新 ${data.employee_no}（${data.full_name}）的${typeLabel(record.incident_type)}记录。`)
      }else flash(`已记录 ${data.employee_no}（${data.full_name}）的${typeLabel(record.incident_type)}情况。`)
      resetEditor();setPage(1);await load(1,pageSize,applied)
    }catch(error){
      let rollbackError=null
      if(uploaded.length){
        rollbackError=await removeEvidencePaths(uploaded.map(item=>item.path))
      }
      const cleanupNotice=rollbackError?'；新上传证明文件未能自动回滚，请联系管理员清理存储文件':''
      const saveMessage=error.message==='employee_not_found'?'找不到这个员工ID，请核对后再保存。':`保存失败：${error.message}`
      setFormError(`${saveMessage}${cleanupNotice}`)
    }finally{setSaving(false)}
  }
  const confirmDelete=async()=>{
    if(!deleteTarget)return
    setDeleting(true);setDeleteError('')
    try{
      const {data,error}=await supabase.rpc('admin_connectivity_delete',{p_incident_id:deleteTarget.id})
      if(error)throw error
      const paths=(data?.attachments||evidenceItems(deleteTarget)).map(item=>item.path).filter(Boolean)
      let cleanupWarning=''
      if(paths.length){
        const removeError=await removeEvidencePaths(paths)
        if(removeError)cleanupWarning='记录已删除，但证明文件未能自动清理，请联系管理员处理存储文件。'
      }
      setDeleteTarget(null);flash(cleanupWarning||`已删除 ${deleteTarget.employee_no} 的 ${deleteTarget.incident_date} ${typeLabel(deleteTarget.incident_type)}记录。`)
      const nextPage=rows.length===1&&page>1?page-1:page
      setPage(nextPage);await load(nextPage,pageSize,applied)
    }catch(error){setDeleteError(`删除失败：${error.message}`)}finally{setDeleting(false)}
  }
  const data=state.data||{},summary=data.summary||{},rows=data.rows||[],daily=data.daily_stats||[]
  const canCreate=Boolean(data.permissions?.create||capabilities.create)
  const canEdit=capabilities.edit
  const canDelete=capabilities.delete
  const showActions=canEdit||canDelete
  const previewDuration=useMemo(()=>calculatedDuration(record.started_at,record.ended_at),[record.started_at,record.ended_at])
  return <div className="connectivity-page">
    <div className="connectivity-head"><div><h2>停电 / 断网记录</h2></div>{canCreate&&<button className="primary-action" onClick={openCreate}>＋ 新增记录</button>}</div>
    {message&&<div className="connectivity-toast" role="status"><span>✓</span>{message}</div>}
    {editor&&<div className="connectivity-modal-backdrop" role="presentation" onMouseDown={closeEditor}><form className="connectivity-modal" onSubmit={save} onMouseDown={event=>event.stopPropagation()}><header><div><small>{editor==='edit'?'EDIT CONNECTIVITY RECORD':'NEW CONNECTIVITY RECORD'}</small><h3>{editor==='edit'?'编辑停电 / 断网记录':'新增停电 / 断网记录'}</h3></div><button type="button" onClick={closeEditor} disabled={saving}>×</button></header>{formError&&<div className="connectivity-form-error">{formError}</div>}<div className="connectivity-form-grid">
      <label className="connectivity-employee-field">员工ID<input autoFocus value={record.employee_no} onChange={event=>setRecord({...record,employee_no:event.target.value})} placeholder="例如 CS000134" required/><span className={`connectivity-employee-check ${employeeLookup.status}`}>{employeeLookup.status==='found'?<><b>{employeeLookup.employee.full_name}</b><em>{employeeLookup.employee.country||'未填写国家'} · {employeeLookup.employee.team_name||'未分配团队'} / {employeeLookup.employee.position_name||'未分配岗位'} · {employeeLookup.employee.status==='resigned'?'已离职':'在职'}</em></>:employeeLookup.message}</span></label>
      <label>发生日期<input type="date" value={record.incident_date} onChange={event=>setRecord({...record,incident_date:event.target.value})} required/></label>
      <label>问题类型<select value={record.incident_type} onChange={event=>setRecord({...record,incident_type:event.target.value})}><option value="power_outage">停电</option><option value="internet_outage">断网</option></select></label>
      <label>自动时长<input value={previewDuration?durationLabel(previewDuration):'填写开始与恢复时间后自动计算'} disabled/></label>
      <label>开始时间<input type="time" value={record.started_at} onChange={event=>setRecord({...record,started_at:event.target.value})} required/></label>
      <label>恢复时间<input type="time" value={record.ended_at} onChange={event=>setRecord({...record,ended_at:event.target.value})} required/></label>
      {editor==='edit'&&<label>记录状态<select value={record.status} onChange={event=>setRecord({...record,status:event.target.value})}><option value="reported">已记录</option><option value="verified">已核实</option><option value="resolved">已恢复</option><option value="rejected">不成立</option></select></label>}
      <label className="wide">情况说明（可选）<textarea value={record.details} onChange={event=>setRecord({...record,details:event.target.value})} placeholder="填写停电或断网原因、恢复情况等"/></label>
      <label className="wide connectivity-upload">图片 / 视频证明（可选，最多 3 个）<input type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,video/mp4,video/quicktime,video/webm" onChange={chooseFiles} disabled={existingFiles.length+files.length>=MAX_EVIDENCE_FILES}/><span>支持图片、MP4、MOV、WebM；每个文件不超过 50MB。</span>{(existingFiles.length>0||files.length>0)&&<div className="connectivity-upload-files">{existingFiles.map(item=><button type="button" key={item.path} onClick={()=>setExistingFiles(current=>current.filter(file=>file.path!==item.path))}><small>已上传</small>{item.name||'证明文件'}<b>×</b></button>)}{files.map((file,index)=><button type="button" key={`${file.name}-${file.size}-${index}`} onClick={()=>setFiles(current=>current.filter((_,i)=>i!==index))}><small>待上传</small>{file.name}<b>×</b></button>)}</div>}</label>
    </div><footer><button type="button" className="secondary-action" onClick={closeEditor} disabled={saving}>取消</button><button type="submit" className="primary-action" disabled={saving}>{saving?'正在上传并保存…':editor==='edit'?'保存修改':'保存记录'}</button></footer></form></div>}
    {deleteTarget&&<div className="connectivity-modal-backdrop" role="presentation" onMouseDown={()=>!deleting&&setDeleteTarget(null)}><div className="connectivity-delete-modal" role="dialog" aria-modal="true" onMouseDown={event=>event.stopPropagation()}><header><div><small>DELETE CONNECTIVITY RECORD</small><h3>删除停电 / 断网记录</h3></div><button type="button" onClick={()=>setDeleteTarget(null)} disabled={deleting}>×</button></header><div><strong>确认删除这条记录吗？</strong><p>{deleteTarget.incident_date} · {deleteTarget.employee_no} · {deleteTarget.full_name} · {typeLabel(deleteTarget.incident_type)}</p><span>记录会从后台和员工前端移除；此操作只对持有“删除停电/断网记录”权限的账号开放。</span>{deleteError&&<div className="connectivity-form-error">{deleteError}</div>}</div><footer><button type="button" className="secondary-action" onClick={()=>setDeleteTarget(null)} disabled={deleting}>取消</button><button type="button" className="connectivity-danger-action" onClick={confirmDelete} disabled={deleting}>{deleting?'正在删除…':'确认删除'}</button></footer></div></div>}
    <section className="connectivity-filter-card"><div className="connectivity-filter-grid">
      <label>员工ID<input value={filters.employee_no} onChange={event=>setFilters({...filters,employee_no:event.target.value})} onKeyDown={event=>event.key==='Enter'&&query()} placeholder="输入员工ID"/></label>
      <label>姓名<input value={filters.employee_name} onChange={event=>setFilters({...filters,employee_name:event.target.value})} onKeyDown={event=>event.key==='Enter'&&query()} placeholder="输入员工姓名"/></label>
      <label>团队<select value={filters.team} onChange={event=>setFilters({...filters,team:event.target.value})}><option value="">全部团队</option>{(data.team_options||[]).map(value=><option key={value}>{value}</option>)}</select></label>
      <label>岗位<select value={filters.position} onChange={event=>setFilters({...filters,position:event.target.value})}><option value="">全部岗位</option>{(data.position_options||[]).map(value=><option key={value}>{value}</option>)}</select></label>
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
      {state.error?<div className="connectivity-empty error">{state.error}</div>:state.loading&&!data.rows?<div className="connectivity-empty">正在读取记录…</div>:rows.length?<div className="connectivity-table-wrap"><table><thead><tr><th>日期</th><th>入职日期</th><th>员工ID</th><th>姓名</th><th>员工国家</th><th>团队</th><th>岗位</th><th>类型</th><th>开始 / 恢复</th><th>持续</th><th>状态</th><th>情况说明</th><th>证明</th><th>录入人</th>{showActions&&<th>操作</th>}</tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><strong>{row.incident_date}</strong></td><td>{row.hire_date||'—'}</td><td><b>{row.employee_no}</b></td><td>{row.full_name}</td><td>{row.employee_country||'—'}</td><td>{row.team_name||'—'}</td><td>{row.position_name||'—'}</td><td><span className={`connectivity-type ${row.incident_type}`}>{typeLabel(row.incident_type)}</span></td><td>{text(row.started_at).slice(0,5)||'—'} → {text(row.ended_at).slice(0,5)||'—'}</td><td>{durationLabel(row.duration_minutes)}</td><td><span className={`connectivity-status ${row.status}`}>{statusLabel(row.status)}</span></td><td className="connectivity-details">{row.details||'—'}</td><td className="connectivity-proof"><EvidenceLinks items={evidenceItems(row)} legacyUrl={row.evidence_url}/>{!evidenceItems(row).length&&!row.evidence_url?'—':null}</td><td>{row.recorded_by_name||'—'}</td>{showActions&&<td><div className="connectivity-row-actions">{canEdit&&<button type="button" onClick={()=>openEdit(row)}>编辑</button>}{canDelete&&<button type="button" className="danger" onClick={()=>{setDeleteError('');setDeleteTarget(row)}}>删除</button>}</div></td>}</tr>)}</tbody></table></div>:<div className="connectivity-empty">暂无符合条件的记录</div>}
      <Pagination page={Number(data.page||page)} pages={Number(data.pages||1)} total={Number(data.total||0)} pageSize={pageSize} loading={state.loading} onPage={next=>{setPage(next);load(next,pageSize,applied)}} onPageSize={next=>{setPageSize(next);setPage(1);load(1,next,applied)}}/>
    </section>
  </div>
}

export function EmployeeConnectivityPanel({data,loading,error,title,t}){
  const tr=typeof t==='function'?t:(_key,fallback,values={})=>Object.entries(values).reduce(
    (result,[key,value])=>result.replaceAll(`{${key}}`,String(value)),
    fallback,
  )
  const rows=data?.rows||[]
  const [filters,setFilters]=useState({from:'',to:'',keyword:''})
  const translatedType=value=>value==='power_outage'?tr('connectivity.power','停电'):value==='internet_outage'?tr('connectivity.internet','断网'):value||'—'
  const translatedStatus=value=>({reported:tr('connectivity.recorded','已记录'),verified:tr('connectivity.verified','已核实'),resolved:tr('connectivity.resolved','已恢复'),rejected:tr('connectivity.rejected','不成立')}[value]||value||'—')
  const translatedDuration=value=>{
    const minutes=Number(value)
    if(!Number.isFinite(minutes)||minutes<=0)return '—'
    const hours=Math.floor(minutes/60),rest=minutes%60
    return `${hours?tr('connectivity.hours','{count}小时',{count:hours}):''}${hours&&rest?' ':''}${rest?tr('connectivity.minutes','{count}分钟',{count:rest}):''}`
  }
  const visibleRows=useMemo(()=>rows.filter(row=>{
    const date=text(row.incident_date).slice(0,10)
    if(filters.from&&(!date||date<filters.from))return false
    if(filters.to&&(!date||date>filters.to))return false
    const keyword=text(filters.keyword).toLocaleLowerCase()
    if(!keyword)return true
    return [row.details,row.incident_type,row.status,translatedType(row.incident_type),translatedStatus(row.status),row.incident_date]
      .some(value=>text(value).toLocaleLowerCase().includes(keyword))
  }),[rows,filters,t])
  const update=(key,value)=>setFilters(current=>({...current,[key]:value}))
  const reset=()=>setFilters({from:'',to:'',keyword:''})
  const total=(filters.from||filters.to||filters.keyword)?visibleRows.length:(data?.total||visibleRows.length)
  return <section className="detail-panel employee-connectivity-panel"><div className="detail-panel-head"><h3>{title||tr('connectivity.title','停电 / 断网记录')}</h3><span className="employee-exam-count">{tr('common.totalItems','共 {count} 条',{count:total})}</span></div>{loading?<div className="connectivity-empty">{tr('connectivity.loading','正在读取记录…')}</div>:error?<div className="connectivity-empty error">{error}</div>:<><div className="employee-history-filters employee-connectivity-filters">
    <label><span>{tr('filters.dateFrom','日期起')}</span><input type="date" value={filters.from} onChange={event=>update('from',event.target.value)}/></label>
    <label><span>{tr('filters.dateTo','日期止')}</span><input type="date" value={filters.to} onChange={event=>update('to',event.target.value)}/></label>
    <label className="employee-history-search"><span>{tr('filters.search','搜索')}</span><input value={filters.keyword} onChange={event=>update('keyword',event.target.value)} placeholder={tr('connectivity.searchPlaceholder','搜索类型、状态或情况说明')}/></label>
    {(filters.from||filters.to||filters.keyword)&&<button type="button" onClick={reset}>{tr('filters.reset','重置')}</button>}
  </div>{visibleRows.length?<div className="employee-connectivity-list">{visibleRows.map(row=><article key={row.id}><div className="employee-connectivity-identity"><strong>{row.incident_date}</strong><span className={`connectivity-type ${row.incident_type}`}>{translatedType(row.incident_type)}</span></div><div><small>{tr('connectivity.timeDuration','时间 / 持续')}</small><p>{text(row.started_at).slice(0,5)||'—'} → {text(row.ended_at).slice(0,5)||'—'} · {translatedDuration(row.duration_minutes)}</p></div><div><small>{tr('connectivity.status','状态')}</small><p>{translatedStatus(row.status)}</p></div><div className="employee-connectivity-details"><small>{tr('connectivity.details','情况说明')}</small><p>{row.details||'—'}</p></div><div className="connectivity-panel-proof"><small>{tr('connectivity.evidence','证明')}</small><EvidenceLinks items={evidenceItems(row)} legacyUrl={row.evidence_url} t={t}/>{!evidenceItems(row).length&&!row.evidence_url?<p>—</p>:null}</div></article>)}</div>:<div className="connectivity-empty">{tr('connectivity.none','暂无停电或断网记录')}</div>}</>}</section>
}

export function EmployeePayrollHistoryPanel({data,loading,error}){
  const rows=data?.rows||[]
  const money=(value,currency)=>{try{return new Intl.NumberFormat('zh-CN',{style:'currency',currency:currency||'USD',maximumFractionDigits:2}).format(Number(value||0))}catch{return `${Number(value||0).toLocaleString()} ${currency||''}`}}
  return <section className="detail-panel employee-payroll-panel"><div className="detail-panel-head"><h3>工资记录</h3><span className="employee-exam-count">{data?.total||0} 份</span></div>{loading?<div className="connectivity-empty">正在读取工资记录…</div>:error?<div className="connectivity-empty error">{error}</div>:rows.length?<div className="employee-payroll-list">{rows.map(row=><article key={row.id}><header><div><strong>{String(row.period_start).slice(0,7)}</strong><span>{row.title}</span></div><span className={`payroll-match ${row.status==='published'?'ok':'neutral'}`}>{row.status==='published'?'已发布':'待发布'}</span></header><div className="employee-payroll-grid"><span><small>基础工资</small><b>{money(row.base_salary,row.currency)}</b></span><span><small>出勤工资</small><b>{money(row.attendance_salary,row.currency)}</b></span><span><small>扣款 / 调整</small><b>{money(Number(row.leave_deduction||0)+Number(row.late_deduction||0)+Number(row.absence_deduction||0)+Number(row.performance_adjustment||0)+Number(row.deposit_adjustment||0),row.currency)}</b></span><span><small>实发工资</small><b className="total">{money(row.total_pay,row.currency)}</b></span></div>{row.remark&&<p>{row.remark}</p>}</article>)}</div>:<div className="connectivity-empty">暂无工资记录</div>}</section>
}

export function EmployeeProfileMetrics({data,loading}){
  const total=Number(data?.total_errors||0)
  // Keep the drawer grade identical to the employee list/filter thresholds.
  const grade=total>=31?'高频':total>=16?'重点':total>=9?'注意':total===0?'优秀':'正常'
  return <div className="wfh-v2722-risk-summary" data-grade={grade} data-profile-metrics="1"><div className="risk-grade"><span>等级</span><strong>{grade}</strong></div><div><span>本月记录</span><strong>{loading?'—':`${Number(data?.month_records||0)} 笔`}</strong></div><div><span>总错误</span><strong>{loading?'—':`${total} 笔`}</strong></div><div><span>考试总次数</span><strong>{loading?'—':`${Number(data?.exam_attempts||0)} 次`}</strong></div><div><span>平均考试分数</span><strong>{loading?'—':data?.exam_average==null?'—':`${Number(data.exam_average).toFixed(1)} 分`}</strong></div></div>
}
