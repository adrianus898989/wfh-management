import React,{useEffect,useMemo,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {supabase} from '../lib/supabase'
import {adminPagePresentation} from '../config/navigation'
import {
  onlineTrainingReportMatchesTrainer,
} from '../lib/onlineTrainingIdentity'
import {
  employeeTrainingTableRow,
  selectedTrainingHistoryRow,
  trainerTrainingTableRow,
} from '../lib/onlineTrainingPresentation'
import {businessTodayRange} from '../lib/adminQueryDefaults'
import {Pagination} from '../components/DataPageControls'
import AdminModuleNav from '../components/AdminModuleNav'
import {useAppToast} from '../components/AppToastProvider'
import {EmployeeDrawer} from './AdminEmployeesPage'
import {edgeFunctionErrorMessage} from '../lib/edgeFunctionError'
import '../styles-online-training.css'

const BUCKET='online-training'
const ONLINE_TRAINING_TOAST_MODULE='线上培训日报'
const RPC_PAGE_SIZE=50
const MAX_ATTACHMENTS=6
const MAX_IMAGE_BYTES=4*1024*1024
const MAX_IMAGE_EDGE=1600
const text=value=>String(value??'').trim()
const MANILA_DATE_FORMAT=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'})
const isoToday=()=>{const parts=Object.fromEntries(MANILA_DATE_FORMAT.formatToParts(new Date()).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`}
const dateText=value=>value?new Date(`${value}T00:00:00`).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}):'—'
const timeText=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—'
const inclusiveDays=(from,to)=>{
  if(!from||!to||from>to)return 0
  const start=new Date(`${from}T00:00:00Z`),end=new Date(`${to}T00:00:00Z`)
  return Math.max(0,Math.round((end-start)/86400000)+1)
}
const safeFileName=name=>text(name).replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'screenshot'
const cleanAttachment=item=>({path:text(item?.path),name:text(item?.name),size:Number(item?.size||0),type:text(item?.type)})
const attachmentWithUrl=item=>({...cleanAttachment(item),url:text(item?.url)})
const removeStoredPaths=async paths=>{
  if(!paths?.length)return null
  try{
    const {error}=await supabase.storage.from(BUCKET).remove(paths)
    return error||null
  }catch(error){return error}
}
const uniq=values=>[...new Set((values||[]).map(text).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'))
const rosterValue=(rows,key)=>uniq((rows||[]).map(row=>row?.[key])).join(' / ')
const EMPTY_FILTERS={employee_no:'',employee_name:'',trainer:'',keyword:'',team:'',group:'',position:'',shift:'',platform:'',attendance:'',from:'',to:''}
const defaultFilters=()=>{const range=businessTodayRange();return{...EMPTY_FILTERS,from:range.date_from,to:range.date_to}}
const delay=ms=>new Promise(resolve=>window.setTimeout(resolve,ms))
const isTransientError=error=>/failed to fetch|networkerror|network request failed|load failed|connection|timeout/i.test(text(error?.message||error))
const readableError=(error,fallback)=>isTransientError(error)?'连接短暂中断，请点击“重新读取”':text(error?.message)||fallback

async function optimiseUpload(file){
  if(file.type==='image/gif'||typeof createImageBitmap!=='function')return file
  try{
    const bitmap=await createImageBitmap(file)
    const scale=Math.min(1,MAX_IMAGE_EDGE/Math.max(bitmap.width,bitmap.height))
    if(scale===1&&file.size<=MAX_IMAGE_BYTES){bitmap.close();return file}
    const canvas=document.createElement('canvas')
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale))
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close()
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.82))
    if(!blob||blob.size>=file.size)return file
    const base=file.name.replace(/\.[^.]+$/,'')||'screenshot'
    return new File([blob],`${base}.webp`,{type:'image/webp',lastModified:file.lastModified})
  }catch{return file}
}

const ATTENDANCE={
  normal:{label:'正常上班',tone:'green'},
  rest:{label:'公休',tone:'gray'},
  not_started:{label:'未入',tone:'violet'},
  leave:{label:'请假',tone:'amber'},
  absent:{label:'缺席',tone:'red'},
  transferred:{label:'回家',tone:'blue'},
}
const ATTENDANCE_OPTIONS=Object.entries(ATTENDANCE)
const REASON_REQUIRED=new Set(['leave','absent','transferred'])
const REASON_PLACEHOLDER={leave:'填写请假原因',absent:'填写缺席原因',transferred:'填写回家原因'}
const REVIEW={pending:'待查看',read:'已阅',needs_changes:'需补充'}

function historySummary(person,rows,period){
  const reportRows=rows||[]
  const recordedDates=new Set(reportRows.map(row=>text(row.report_date)).filter(Boolean))
  const statusDates={normal:new Set(),rest:new Set(),not_started:new Set(),leave:new Set(),absent:new Set(),transferred:new Set()}
  reportRows.forEach(row=>{
    const member=(row.members||[])[0]
    const date=text(row.report_date)
    if(date&&statusDates[member?.attendance_status])statusDates[member.attendance_status].add(date)
  })
  const periodDays=inclusiveDays(period?.from,period?.to)||(person.period_days||recordedDates.size)
  const missingDays=person.is_current_roster===false
    ?0
    :Math.max(periodDays-recordedDates.size,0)
  return {
    period_days:periodDays,
    report_count:reportRows.length,
    recorded_days:recordedDates.size,
    missing_days:missingDays,
    normal_count:statusDates.normal.size,
    rest_count:statusDates.rest.size,
    not_started_count:statusDates.not_started.size,
    leave_count:statusDates.leave.size,
    absent_count:statusDates.absent.size,
    home_count:statusDates.transferred.size,
  }
}

function blankReport(access={}){
  const day=isoToday()
  return {
    id:crypto.randomUUID(),report_date:day,title:`线上培训日报 · ${day}`,
    platform:'',shift_name:'',team_name:'',group_name:'',leader_name:'',
    trainer_name:access.employee_name||'',course_type:'',report_summary:'',issues_summary:'',next_plan:'',
    attachments:[],manager_filter:'',roster_shift:'',roster_team:'',roster_position:'',roster_query:'',
  }
}

function reportWithRoster(draft,rows,trainerName=''){
  const members=rows||[]
  return {...draft,
    trainer_name:trainerName||draft.trainer_name||rosterValue(members,'online_trainer'),
    leader_name:rosterValue(members,'online_leader')||rosterValue(members,'responsible'),
    shift_name:rosterValue(members,'shift'),team_name:rosterValue(members,'team'),
    group_name:rosterValue(members,'group'),platform:rosterValue(members,'platform'),
  }
}

function memberFromRoster(row,index=0){
  return {
    employee_id:row.id,employee_no:row.employee_no,employee_name:row.full_name,
    hire_date:row.hire_date||'',
    position_name:row.position||'',team_name:row.team||'',group_name:row.group||'',
    shift_name:row.shift||'',platform:row.platform||'',leader_name:row.responsible||'',
    trainer_name:row.online_trainer||'',attendance_status:'normal',status_note:'',
    work_details:'',performance:'',issues:'',follow_up:'',metrics:{response_time:''},sort_order:index,
  }
}

function draftFromReport(row){
  return {
    id:row.id,report_date:row.report_date,title:row.title,platform:row.platform||'',
    shift_name:row.shift_name||'',team_name:row.team_name||'',group_name:row.group_name||'',
    leader_name:row.leader_name||'',trainer_name:row.trainer_name||'',course_type:row.course_type||'',
    report_summary:row.report_summary||'',issues_summary:row.issues_summary||'',next_plan:row.next_plan||'',
    attachments:(row.attachments||[]).map(attachmentWithUrl),manager_filter:row.trainer_name||'',
    roster_shift:row.shift_name||'',roster_team:row.team_name||'',roster_position:'',roster_query:'',
  }
}

function memberFromReport(row,index){
  const attendance=row.attendance_status==='not_applicable'?'rest':row.attendance_status
  return {
    employee_id:row.employee_id,employee_no:row.employee_no,employee_name:row.employee_name,
    hire_date:row.hire_date||'',
    position_name:row.position_name||'',team_name:row.team_name||'',group_name:row.group_name||'',
    shift_name:row.shift_name||'',platform:row.platform||'',leader_name:row.leader_name||'',
    trainer_name:row.trainer_name||'',attendance_status:ATTENDANCE[attendance]?attendance:'normal',
    status_note:row.status_note||'',work_details:row.work_details||'',performance:row.performance||'',
    issues:row.issues||'',follow_up:row.follow_up||'',metrics:row.metrics||{response_time:''},sort_order:index,
  }
}

function positionPrompts(position){
  const value=text(position)
  if(value.includes('客服'))return{
    work:'今天负责的平台、会员咨询及处理事项',performance:'响应速度、服务表现、流程执行情况',
    issues:'错误回答、未解决问题、需要加强的规则',follow:'后续培训重点与明日安排',metric:'例如：92LOTTERY 12秒、VN168 15秒',
  }
  if(value.includes('出款'))return{
    work:'处理订单、成功/驳回及协助事项',performance:'处理效率、准确度及流程执行情况',
    issues:'延迟、异常订单、风险或操作问题',follow:'待跟进订单与后续训练安排',metric:'例如：处理 320 笔、驳回 18 笔',
  }
  if(value.includes('查单')||value.includes('审单')||value.includes('质检'))return{
    work:'今天检查/审核的工作内容与数量',performance:'准确度、完成度及协作表现',
    issues:'发现的错误、异常与待复查事项',follow:'纠正方式和下一步跟进',metric:'例如：检查 86 笔、发现 3 个问题',
  }
  return{work:'今天负责的工作及完成情况',performance:'工作表现、效率与配合情况',issues:'发现的问题或需要协助事项',follow:'改进方向与明日安排',metric:'填写岗位相关数据（选填）'}
}

function AttachmentGrid({items,onOpen,compact=false}){
  if(!items?.length)return null
  return <div className={`ot-attachments ${compact?'compact':''}`}>{items.map((item,index)=><button type="button" key={item.path||index} onClick={()=>onOpen(item)} title="点击查看大图">
    {item.url?<img src={item.url} alt={item.name||'培训截图'}/>:<span>图片</span>}
    <small>{item.name||`截图 ${index+1}`}</small>
  </button>)}</div>
}

function OverlayPortal({children}){
  return createPortal(children,document.body)
}

export default function OnlineTrainingPage(){
  const {notify}=useAppToast()
  const [bootstrap,setBootstrap]=useState(null)
  const [mode,setMode]=useState('reports')
  const [filters,setFilters]=useState(defaultFilters)
  const [draftFilters,setDraftFilters]=useState(defaultFilters)
  const [searchVersion,setSearchVersion]=useState(0)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(20)
  const [result,setResult]=useState({rows:[],total:0,pages:1})
  const [loading,setLoading]=useState(true)
  const [searching,setSearching]=useState(false)
  const [error,setError]=useState('')
  const [editor,setEditor]=useState(null)
  const [pendingFiles,setPendingFiles]=useState([])
  const [saving,setSaving]=useState(false)
  const [viewing,setViewing]=useState(null)
  const [deleteTarget,setDeleteTarget]=useState(null)
  const [deleteError,setDeleteError]=useState('')
  const [profile,setProfile]=useState(null)
  const [history,setHistory]=useState(null)
  const [trainerHistory,setTrainerHistory]=useState(null)
  const [lightbox,setLightbox]=useState(null)
  const listRequestRef=useRef(0)
  const historyRequestRef=useRef(0)
  const trainerHistoryRequestRef=useRef(0)
  const trainerRequestRef=useRef(0)
  const profileRequestRef=useRef(0)
  const viewingRequestRef=useRef(0)
  const editorRequestRef=useRef(0)
  const listIntentRef=useRef('')

  const hydrateAttachments=async rows=>{
    const paths=uniq((rows||[]).flatMap(row=>(row.attachments||[]).map(item=>item.path)))
    if(!paths.length)return rows||[]
    try{
      const {data,error:storageError}=await supabase.storage.from(BUCKET).createSignedUrls(paths,3600)
      if(storageError)return rows||[]
      const urls=new Map((data||[]).map(item=>[item.path,item.signedUrl]))
      return (rows||[]).map(row=>({...row,attachments:(row.attachments||[]).map(item=>({...cleanAttachment(item),url:urls.get(item.path)||''}))}))
    }catch{return rows||[]}
  }

  const call=async(name,args={})=>{
    const {data,error:rpcError}=await supabase.rpc(name,args)
    if(rpcError)throw rpcError
    return data
  }

  const readCall=async(name,args={})=>{
    let lastError
    for(let attempt=0;attempt<3;attempt+=1){
      try{return await call(name,args)}
      catch(error){
        lastError=error
        if(!isTransientError(error)||attempt===2)throw error
        await delay(250+(attempt*350))
      }
    }
    throw lastError
  }

  const loadBootstrap=async({announceFailure=false}={})=>{
    setLoading(true)
    try{
      const data=await readCall('online_training_context')
      setBootstrap(data)
      setError('')
      return data
    }catch(err){
      const reason=readableError(err,'线上培训模块读取失败')
      setError(reason)
      if(announceFailure)listIntentRef.current=''
      if(announceFailure)notify({
        type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:'刷新模块数据',reason,
        dedupeKey:'online-training:bootstrap:read:error',
        retry:()=>{listIntentRef.current='刷新线上培训记录';return loadBootstrap({announceFailure:true})},retryLabel:'重试',
      })
      return null
    }
    finally{setLoading(false)}
  }

  const loadList=async({silent=false,nextPage=page,announceFailure=false,operation='',throwOnError=false}={})=>{
    const requestId=++listRequestRef.current
    const requestedMode=mode
    const requestedOperation=operation||(announceFailure?'查询线上培训记录':listIntentRef.current)
    listIntentRef.current=''
    if(silent)setSearching(true);else setLoading(true)
    try{
      const data=await readCall(
        requestedMode==='reports'?'online_training_search_trainers':'online_training_search_people',{
          p_filters:filters,p_page:nextPage,p_page_size:pageSize,
        },
      )
      const rows=data?.rows||[]
      if(requestId!==listRequestRef.current)return
      const safePage=Math.max(1,Number(data?.page||nextPage))
      setResult({...data,rows,report_total:Number(data?.report_total||0)})
      if(safePage!==nextPage)setPage(safePage)
      setError('')
      return true
    }catch(err){
      const reason=readableError(err,'线上培训记录读取失败')
      if(requestId===listRequestRef.current){
        setError(reason)
        if(requestedOperation)notify({
          type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:requestedOperation,reason,
          dedupeKey:'online-training:list:read:error',
          retry:()=>loadList({silent:true,announceFailure:true,operation:'刷新线上培训记录'}),retryLabel:'重试',
        })
      }
      if(throwOnError)throw err
      return false
    }finally{
      if(requestId===listRequestRef.current){setLoading(false);setSearching(false)}
    }
  }

  useEffect(()=>{loadBootstrap()},[])
  useEffect(()=>{
    if(!bootstrap)return
    const timer=setTimeout(()=>loadList({silent:true}),0)
    return()=>clearTimeout(timer)
  },[bootstrap,mode,page,pageSize,searchVersion])
  useEffect(()=>{
    if(!(editor||viewing||deleteTarget||profile||history||trainerHistory||lightbox))return
    const prior=document.body.style.overflow;document.body.style.overflow='hidden'
    return()=>{document.body.style.overflow=prior}
  },[editor,viewing,deleteTarget,profile,history,trainerHistory,lightbox])

  const myRoster=bootstrap?.my_roster||[]
  const filterOptions=useMemo(()=>{
    const supplied=bootstrap?.filter_options||{}
    const roster=bootstrap?.roster||[]
    const fallback={
      trainer:roster.map(row=>row.online_trainer),team:roster.map(row=>row.team),
      group:roster.map(row=>row.group),position:roster.map(row=>row.position),
      shift:roster.map(row=>row.shift),platform:roster.map(row=>row.platform),
    }
    return Object.fromEntries(Object.keys(fallback).map(key=>[key,uniq((supplied[key]||fallback[key]||[]))]))
  },[bootstrap])
  const canAdminSelect=Boolean(bootstrap?.access?.is_founder||bootstrap?.access?.can_manage)
  const canOpenSubmit=Boolean(bootstrap?.access?.can_submit&&(myRoster.length||canAdminSelect))

  const updateDraft=(key,value)=>setEditor(current=>({...current,validation:null,draft:{...current.draft,[key]:value}}))
  const updateMember=(index,key,value)=>setEditor(current=>({...current,validation:null,members:current.members.map((member,i)=>{
    if(i!==index)return member
    if(key==='attendance_status')return {...member,attendance_status:value,status_note:REASON_REQUIRED.has(value)?member.status_note:''}
    return {...member,[key]:value}
  })}))
  const updateMetric=(index,value)=>setEditor(current=>({...current,validation:null,members:current.members.map((member,i)=>i===index?{...member,metrics:{...(member.metrics||{}),response_time:value}}:member)}))

  const openCreate=()=>{
    if(!bootstrap?.access?.can_submit){setError('当前账号没有线上培训提交权限');return}
    // A signed-URL hydration started by an earlier view/edit click can finish
    // after this action on a slow connection. Invalidate both requests before
    // opening the fresh draft so the stale modal cannot replace it.
    viewingRequestRef.current+=1
    editorRequestRef.current+=1
    trainerRequestRef.current+=1
    setViewing(null)
    const assignmentMode=myRoster.length?'linked':canAdminSelect?'admin':'unmatched'
    const sourceRows=assignmentMode==='linked'?myRoster:[]
    const reporterName=text(bootstrap?.auto_assignment?.trainer_name)||text(bootstrap.access.employee_name)
    const draft=reportWithRoster(blankReport({...bootstrap.access,employee_name:reporterName}),sourceRows,reporterName)
    setError('')
    setPendingFiles([])
    setEditor({original:null,assignmentMode,rosterLoading:false,validation:null,draft,members:sourceRows.map(memberFromRoster)})
  }

  const openView=async row=>{
    const requestId=++viewingRequestRef.current
    const [hydrated]=await hydrateAttachments([row])
    if(requestId!==viewingRequestRef.current)return
    setViewing(hydrated||row)
  }

  const openEdit=async row=>{
    const requestId=++editorRequestRef.current
    const [hydrated]=await hydrateAttachments([row])
    if(requestId!==editorRequestRef.current)return
    const source=hydrated||row
    setError('')
    setPendingFiles([])
    setEditor({original:source,assignmentMode:'edit',rosterLoading:false,validation:null,draft:draftFromReport(source),members:(source.members||[]).map(memberFromReport)})
  }

  const releasePending=items=>items.forEach(item=>URL.revokeObjectURL(item.preview))
  const discardEditor=()=>{editorRequestRef.current+=1;trainerRequestRef.current+=1;releasePending(pendingFiles);setPendingFiles([]);setEditor(null)}
  const closeEditor=()=>{if(!saving)discardEditor()}
  const closeViewer=()=>{viewingRequestRef.current+=1;setViewing(null)}

  const selectAdminTrainer=async value=>{
    const requestId=++trainerRequestRef.current
    if(!value){
      setEditor(current=>({...current,rosterLoading:false,rosterError:'',draft:{...current.draft,manager_filter:'',trainer_name:'',leader_name:'',shift_name:'',team_name:'',group_name:'',platform:''},members:[]}))
      return
    }
    setEditor(current=>({...current,rosterLoading:true,rosterError:'',draft:{...current.draft,manager_filter:value,trainer_name:value},members:[]}))
    setError('')
    try{
      const selected=await readCall('online_training_roster_for_trainer',{p_trainer_name:value})||[]
      if(requestId!==trainerRequestRef.current)return
      setEditor(current=>current?.assignmentMode==='admin'&&text(current.draft?.manager_filter)===text(value)?({...current,rosterLoading:false,
        draft:reportWithRoster({...current.draft,manager_filter:value,trainer_name:value},selected,value),
        members:selected.map(memberFromRoster),
      }):current)
    }catch(err){
      if(requestId!==trainerRequestRef.current)return
      const message=readableError(err,'线上培训人员读取失败')
      setEditor(current=>current?.assignmentMode==='admin'&&text(current.draft?.manager_filter)===text(value)?({...current,rosterLoading:false,rosterError:message}):current)
      notify({
        type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:'读取培训人员',reason:message,
        dedupeKey:'online-training:trainer-roster:read:error',retry:()=>selectAdminTrainer(value),retryLabel:'重试',
      })
    }
  }

  const addFiles=async event=>{
    const files=[...(event.target.files||[])];event.target.value=''
    const slots=MAX_ATTACHMENTS-(editor?.draft?.attachments?.length||0)-pendingFiles.length
    if(slots<=0){setEditor(current=>({...current,validation:{message:`每份报告最多上传${MAX_ATTACHMENTS}张关键截图`,issues:[]}}));return}
    const accepted=[]
    let message=''
    for(const source of files.slice(0,slots)){
      if(!['image/jpeg','image/png','image/webp','image/gif'].includes(source.type)){message=`${source.name} 不是支持的图片格式`;continue}
      const file=await optimiseUpload(source)
      if(file.size>MAX_IMAGE_BYTES){message=`${source.name} 压缩后仍超过4MB，请换一张较小的图片`;continue}
      accepted.push({file,preview:URL.createObjectURL(file)})
    }
    setPendingFiles(current=>[...current,...accepted])
    if(message)setEditor(current=>({...current,validation:{message,issues:[]}}))
  }

  const removePending=index=>setPendingFiles(current=>{const next=[...current];const [removed]=next.splice(index,1);if(removed)URL.revokeObjectURL(removed.preview);return next})
  const removeExisting=path=>updateDraft('attachments',editor.draft.attachments.filter(item=>item.path!==path))

  const validate=()=>{
    if(!editor.draft.report_date)return{message:'请选择报告日期',issues:[]}
    if(!editor.members.length)return{message:editor.assignmentMode==='unmatched'?'居家排班表没有找到当前账号负责的线上培训人员':'请选择需要代填的线上培训人员',issues:[]}
    const issues=[]
    editor.members.forEach((member,index)=>{
      const hireDate=text(member.hire_date).slice(0,10)
      if(member.attendance_status==='not_started'&&!hireDate)issues.push({index,employee_no:member.employee_no,employee_name:member.employee_name,detail:'员工档案缺少入职日期，不能选择未入'})
      else if(member.attendance_status==='not_started'&&!editor.draft.report_date)issues.push({index,employee_no:member.employee_no,employee_name:member.employee_name,detail:'请先选择报告日期再使用未入'})
      else if(member.attendance_status==='not_started'&&editor.draft.report_date>=hireDate)issues.push({index,employee_no:member.employee_no,employee_name:member.employee_name,detail:`已到入职日期 ${hireDate}，不能选择未入`})
      else if(member.attendance_status==='normal'&&!text(member.work_details))issues.push({index,employee_no:member.employee_no,employee_name:member.employee_name,detail:'未填写当天工作情况'})
      else if(REASON_REQUIRED.has(member.attendance_status)&&!text(member.status_note))issues.push({index,employee_no:member.employee_no,employee_name:member.employee_name,detail:`${ATTENDANCE[member.attendance_status]?.label||'异常状态'}未填写原因`})
    })
    if(issues.length)return{message:`还有 ${issues.length} 名人员的记录未完成，请补齐后再提交`,issues}
    if(!text(editor.draft.report_summary))return{message:'请填写团队总体工作情况',issues:[],summary:true}
    return null
  }

  const saveReport=async()=>{
    const validation=validate()
    if(validation){
      setEditor(current=>({...current,validation}))
      if(validation.issues?.length)window.setTimeout(()=>document.getElementById(`ot-member-${validation.issues[0].index}`)?.scrollIntoView({behavior:'smooth',block:'center'}),0)
      else if(validation.summary)window.setTimeout(()=>document.getElementById('ot-team-summary')?.scrollIntoView({behavior:'smooth',block:'center'}),0)
      return
    }
    setSaving(true);setError('');setEditor(current=>({...current,validation:null}))
    const uploaded=[]
    let reportSaved=false
    let cleanupWarning=''
    const saveOperation=editor.original?'编辑线上培训日报':'提交线上培训日报'
    const saveDedupeKey=`online-training:report:${editor.original?'update':'create'}`
    try{
      for(const item of pendingFiles){
        const path=`${bootstrap.access.user_id}/${editor.draft.id}/${crypto.randomUUID()}-${safeFileName(item.file.name)}`
        const {error:uploadError}=await supabase.storage.from(BUCKET).upload(path,item.file,{cacheControl:'3600',upsert:false,contentType:item.file.type})
        if(uploadError)throw uploadError
        uploaded.push({path,name:item.file.name,size:item.file.size,type:item.file.type})
      }
      const kept=(editor.draft.attachments||[]).map(cleanAttachment)
      const report={...editor.draft,title:text(editor.draft.title)||`线上培训日报 · ${editor.draft.report_date}`,attachments:[...kept,...uploaded]}
      const members=editor.members.map((member,index)=>({...member,sort_order:index,metrics:member.metrics||{}}))
      await call('online_training_save_report',{p_report:report,p_members:members})
      reportSaved=true
      notify({
        type:'success',module:ONLINE_TRAINING_TOAST_MODULE,operation:saveOperation,
        reason:'日报及人员记录已保存。',dedupeKey:`${saveDedupeKey}:success`,
      })

      if(editor.original){
        const keptPaths=new Set(kept.map(item=>item.path))
        const removed=(editor.original.attachments||[]).map(item=>item.path).filter(path=>path&&!keptPaths.has(path))
        if(removed.length){
          const removeError=await removeStoredPaths(removed)
          if(removeError)cleanupWarning='日报已保存，但旧附件未能自动清理；附件已从日报隐藏，请联系管理员清理存储文件。'
        }
      }
      if(cleanupWarning)notify({
        type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:'清理旧附件',reason:cleanupWarning,
        dedupeKey:'online-training:attachment:cleanup:error',
      })
      discardEditor();await loadList({silent:true,nextPage:1,throwOnError:true});setPage(1)
      if(cleanupWarning)setError(cleanupWarning)
    }catch(err){
      if(reportSaved){
        discardEditor()
        const reason=`日报已经保存，但列表刷新失败：${err.message||'请稍后刷新重试'}`
        setError(reason)
        notify({
          type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:'保存后刷新日报列表',reason,
          dedupeKey:'online-training:report:post-save-refresh:error',
          retry:()=>loadList({silent:true,announceFailure:true,operation:'刷新线上培训记录'}),retryLabel:'刷新确认',
        })
      }else{
        let rollbackError=null
        if(uploaded.length){
          rollbackError=await removeStoredPaths(uploaded.map(item=>item.path))
        }
        const rollbackNotice=rollbackError?'；新上传附件未能自动回滚，请联系管理员清理存储文件':''
        const reason=`${err.message||'线上培训日报保存失败'}${rollbackNotice}`
        setEditor(current=>current?({...current,validation:{message:reason,issues:[]}}):current)
        notify({
          type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:saveOperation,reason,
          dedupeKey:`${saveDedupeKey}:error`,
          retry:()=>loadList({silent:true,announceFailure:true,operation:'刷新确认日报状态'}),retryLabel:'刷新确认',
        })
      }
    }finally{setSaving(false)}
  }

  const archiveReport=async()=>{
    if(!deleteTarget)return
    const target=deleteTarget
    const openTrainer=trainerHistory?.trainer
    const deletingViewedReport=Boolean(viewing?.id&&viewing.id===target.id)
    setSaving(true)
    setDeleteError('')
    let reportArchived=false
    try{
      await call('online_training_archive_report',{p_report_id:target.id})
      if(deletingViewedReport)closeViewer()
      reportArchived=true
      notify({
        type:'success',module:ONLINE_TRAINING_TOAST_MODULE,operation:'删除线上培训日报',
        reason:'日报已归档并从正常列表移除。',dedupeKey:'online-training:report:archive:success',
      })
      setDeleteTarget(null)
      setDeleteError('')
      if(history?.person)await loadHistory(history.person,history.period,history.basePeriod)
      if(openTrainer)await loadTrainerHistory(openTrainer)
      await loadList({silent:true,throwOnError:true})
    }
    catch(err){
      const reason=reportArchived
        ?`日报已经删除，但列表刷新失败：${readableError(err,'请稍后刷新确认')}`
        :readableError(err,'报告删除失败')
      if(reportArchived)setError(reason)
      else setDeleteError(reason)
      notify({
        type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:reportArchived?'删除后刷新日报列表':'删除线上培训日报',reason,
        dedupeKey:`online-training:report:${reportArchived?'post-archive-refresh':'archive'}:error`,
        retry:()=>loadList({silent:true,announceFailure:true,operation:'刷新确认删除结果'}),retryLabel:'刷新确认',
      })
    }
    finally{setSaving(false)}
  }

  const requestDelete=row=>{
    setDeleteError('')
    setDeleteTarget(row)
  }

  const cancelDelete=()=>{
    setDeleteError('')
    setDeleteTarget(null)
  }

  const reviewReport=async(status,note)=>{
    let reviewSaved=false
    try{
      await call('online_training_review_report',{p_report_id:viewing.id,p_status:status,p_note:note||''})
      reviewSaved=true
      notify({
        type:'success',module:ONLINE_TRAINING_TOAST_MODULE,operation:'保存日报批注',
        reason:'查看状态与批注已保存。',dedupeKey:'online-training:review:save:success',
      })
      setViewing(current=>({...current,review_status:status,review_note:note||''}))
      await loadList({silent:true,throwOnError:true})
    }catch(err){
      const reason=reviewSaved
        ?`批注已经保存，但列表刷新失败：${err.message||'请稍后刷新确认'}`
        :(err.message||'批注保存失败')
      setError(reason)
      notify({
        type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:reviewSaved?'保存批注后刷新列表':'保存日报批注',reason,
        dedupeKey:`online-training:review:${reviewSaved?'post-save-refresh':'save'}:error`,
        retry:()=>loadList({silent:true,announceFailure:true,operation:'刷新确认批注状态'}),retryLabel:'刷新确认',
      })
    }
  }

  const openProfile=async employeeId=>{
    const requestId=++profileRequestRef.current
    setProfile({loading:true,detail:{employee:{id:employeeId}},error:''})
    try{
      const {data,error:edgeError}=await supabase.functions.invoke('admin-employees',{body:{action:'detail',employee_id:employeeId}})
      if(requestId!==profileRequestRef.current)return
      if(edgeError||data?.error)throw new Error(await edgeFunctionErrorMessage({data,error:edgeError,fallback:'员工完整档案读取失败'}))
      setProfile({loading:false,detail:data,error:''})
    }catch(err){
      if(requestId!==profileRequestRef.current)return
      const reason=readableError(err,'员工完整档案读取失败')
      setProfile({loading:false,detail:null,error:reason})
      notify({
        type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:'读取员工档案',reason,
        dedupeKey:'online-training:employee-profile:read:error',retry:()=>openProfile(employeeId),retryLabel:'重试',
      })
    }
  }
  const closeProfile=()=>{profileRequestRef.current+=1;setProfile(null)}

  const loadHistory=async(person,period,basePeriod=period)=>{
    const requestId=++historyRequestRef.current
    setHistory({person,period,basePeriod,loading:true,rows:[],total:0,error:''})
    try{
      const args={
        p_query:'',p_date_from:period.from||null,p_date_to:period.to||null,
        p_employee_id:person.employee_id,p_page:1,p_page_size:50,
      }
      const first=await readCall('online_training_list',args)
      const rows=[...(first?.rows||[])]
      const pages=Math.max(1,Number(first?.pages||1))
      const remaining=Array.from({length:Math.max(0,pages-1)},(_,index)=>index+2)
      for(let index=0;index<remaining.length;index+=6){
        const batch=await Promise.all(remaining.slice(index,index+6).map(nextPage=>
          readCall('online_training_list',{...args,p_page:nextPage})
        ))
        batch.forEach(next=>rows.push(...(next?.rows||[])))
      }
      if(requestId!==historyRequestRef.current)return
      const access=bootstrap?.access||{}
      const currentUserId=text(access.user_id)
      const canManage=Boolean(access.can_manage||access.is_founder)
      const visibleRows=rows.map(row=>({
        ...row,
        // The filtered history RPC intentionally omits edit flags.  This only
        // controls whether the button is shown; the archive RPC performs the
        // authoritative permission check again before changing any data.
        can_edit:canManage||Boolean(currentUserId&&text(row.created_by)===currentUserId),
      }))
      setHistory({person,period,basePeriod,loading:false,rows:visibleRows,total:Number(first?.total||visibleRows.length),error:''})
    }catch(err){
      if(requestId!==historyRequestRef.current)return
      const reason=readableError(err,'员工历史记录读取失败')
      setHistory({person,period,basePeriod,loading:false,rows:[],total:0,error:reason})
      notify({
        type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:'读取员工历史记录',reason,
        dedupeKey:'online-training:employee-history:read:error',retry:()=>loadHistory(person,period,basePeriod),retryLabel:'重试',
      })
    }
  }

  const openHistory=person=>{
    // The people RPC clips the requested range to this employee's hire and
    // resignation dates. Preserve that authoritative period in the modal so a
    // mid-month hire is not incorrectly counted as missing before joining.
    const basePeriod={
      from:person.period_from||filters.from||'',
      to:person.period_to||filters.to||'',
    }
    loadHistory(person,basePeriod,basePeriod)
  }

  const selectHistoryDate=date=>{
    if(!history?.person)return
    const period=date?{from:date,to:date}:history.basePeriod
    loadHistory(history.person,period,history.basePeriod)
  }

  const closeHistory=()=>{
    historyRequestRef.current+=1
    setHistory(null)
  }

  const loadTrainerHistory=async trainer=>{
    const requestId=++trainerHistoryRequestRef.current
    setTrainerHistory({trainer,loading:true,rows:[],error:''})
    try{
      const trainerFilters={...filters,trainer:trainer.trainer_name}
      const first=await readCall('online_training_search_reports',{p_filters:trainerFilters,p_page:1,p_page_size:RPC_PAGE_SIZE})
      const rows=[...(first?.rows||[])]
      const pages=Math.max(1,Number(first?.pages||1))
      const remaining=Array.from({length:Math.max(0,pages-1)},(_,index)=>index+2)
      for(let index=0;index<remaining.length;index+=6){
        const batch=await Promise.all(remaining.slice(index,index+6).map(nextPage=>readCall('online_training_search_reports',{
          p_filters:trainerFilters,p_page:nextPage,p_page_size:RPC_PAGE_SIZE,
        })))
        batch.forEach(next=>rows.push(...(next?.rows||[])))
      }
      const exact=rows.filter(row=>onlineTrainingReportMatchesTrainer(row,trainer.trainer_key))
      if(requestId!==trainerHistoryRequestRef.current)return
      setTrainerHistory({trainer,loading:false,rows:exact,error:''})
    }catch(err){
      if(requestId!==trainerHistoryRequestRef.current)return
      const reason=readableError(err,'培训日报读取失败')
      setTrainerHistory({trainer,loading:false,rows:[],error:reason})
      notify({
        type:'error',module:ONLINE_TRAINING_TOAST_MODULE,operation:'读取培训老师日报',reason,
        dedupeKey:'online-training:trainer-history:read:error',retry:()=>loadTrainerHistory(trainer),retryLabel:'重试',
      })
    }
  }

  const closeTrainerHistory=()=>{
    trainerHistoryRequestRef.current+=1
    viewingRequestRef.current+=1
    setViewing(null)
    setTrainerHistory(null)
  }

  const changeMode=nextMode=>{
    if(nextMode===mode)return
    listRequestRef.current+=1
    historyRequestRef.current+=1
    trainerHistoryRequestRef.current+=1
    listIntentRef.current='切换线上培训视图'
    setHistory(null);setTrainerHistory(null);setError('')
    setMode(nextMode);setPage(1);setResult({rows:[],total:0,pages:1,report_total:0});setSearching(true)
  }

  const copyTelegram=async row=>{
    const lines=[
      '线上培训日报',`日期：${row.report_date}`,`平台：${row.platform||'—'}`,`班次：${row.shift_name||'—'}`,
      `团队负责人：${row.leader_name||'—'}`,`线上培训：${row.trainer_name||row.author_name||'—'}`,'',
    ]
    ;(row.members||[]).forEach(member=>{
      lines.push(`${member.employee_no} · ${member.employee_name} · ${member.position_name||'—'}`)
      lines.push(`状态：${ATTENDANCE[member.attendance_status]?.label||member.attendance_status}`)
      if(member.status_note)lines.push(`原因：${member.status_note}`)
      if(member.work_details)lines.push(`今日工作：${member.work_details}`)
      if(member.performance)lines.push(`工作表现：${member.performance}`)
      if(member.issues)lines.push(`发现问题：${member.issues}`)
      if(member.follow_up)lines.push(`后续安排：${member.follow_up}`)
      if(text(member.metrics?.response_time))lines.push(`数据：${member.metrics.response_time}`)
      lines.push('')
    })
    try{await navigator.clipboard.writeText(lines.join('\n'));window.alert('已复制 Telegram 格式')}
    catch{setError('浏览器未允许复制，请在报告详情中手动复制')}
  }

  const setDraftFilter=(key,value)=>setDraftFilters(current=>({...current,[key]:value}))
  const queryFilters=()=>{
    if(draftFilters.from&&draftFilters.to&&draftFilters.from>draftFilters.to){setError('日期起不能晚于日期止');return}
    const next=Object.fromEntries(Object.entries(draftFilters).map(([key,value])=>[key,text(value)]))
    listIntentRef.current='查询线上培训记录'
    setFilters(next);setPage(1);setSearchVersion(version=>version+1)
  }
  const clearFilters=()=>{const next=defaultFilters();listIntentRef.current='重置线上培训查询';setDraftFilters(next);setFilters(next);setPage(1);setSearchVersion(version=>version+1)}
  const refreshPage=()=>{listIntentRef.current='刷新线上培训记录';return loadBootstrap({announceFailure:true})}
  const filterDirty=JSON.stringify(draftFilters)!==JSON.stringify(filters)
  const activeFilterCount=Object.values(filters).filter(Boolean).length
  const pagePresentation=adminPagePresentation('/admin/daily','线上培训报告')

  return <div className="content-page ot-page">
    <header className="ot-header">
      <div><div className="module-kicker">ATTENDANCE · EXAMS · REWARDS</div><h1>{pagePresentation.sectionLabel||'考勤考试奖惩统计'}</h1><p>{pagePresentation.itemLabel||'线上培训日报记录表'}</p></div>
      <div className="ot-header-actions">
        <span className={`ot-access ${canOpenSubmit?'ok':'read'}`}>{myRoster.length?`已关联 ${myRoster.length} 名组员`:canAdminSelect?'管理员代填':'仅查看'}</span>
        <button onClick={refreshPage} disabled={loading||searching}>{loading?'读取中…':'刷新'}</button>
        {canOpenSubmit&&<button className="primary" onClick={openCreate}>＋ 提交线上培训日报</button>}
      </div>
    </header>

    <AdminModuleNav />

    {error&&<div className="ot-error"><span>{error}</span><div>{error.includes('重新读取')&&<button className="retry" onClick={refreshPage}>重新读取</button>}<button className="close" onClick={()=>setError('')}>×</button></div></div>}

    <section className="ot-kpis">
      <div><span>我负责的培训人员</span><strong>{myRoster.length||'—'}</strong><small>{myRoster.length?'按账号档案自动匹配':'主管账号仅查看或代填'}</small></div>
      <div><span>培训人员日报</span><strong>{mode==='reports'?(result.total??0):'—'}</strong><small>{mode==='reports'?`共 ${result.report_total||0} 份日报（含零日报人员）`:'切换日报记录查看'}</small></div>
      <div><span>员工培训档案</span><strong>{mode==='people'?result.total:'—'}</strong><small>排班培训员工（含零日报）</small></div>
      <div><span>排班数据最近同步</span><strong className="date">{bootstrap?.roster_synced_at?timeText(bootstrap.roster_synced_at):'读取中'}</strong><small>系统每 5 分钟检查变更</small></div>
    </section>

    <div className="ot-view-tabs">
      <button className={mode==='reports'?'active':''} onClick={()=>changeMode('reports')}>培训日报记录</button>
      <button className={mode==='people'?'active':''} onClick={()=>changeMode('people')}>人员详细记录</button>
    </div>

    <form className="ot-filters" onSubmit={event=>{event.preventDefault();queryFilters()}}>
      <div className="ot-filter-row primary-row">
        <label><span>员工ID</span><input value={draftFilters.employee_no} onChange={event=>setDraftFilter('employee_no',event.target.value)} placeholder="输入员工ID"/></label>
        <label><span>员工姓名</span><input value={draftFilters.employee_name} onChange={event=>setDraftFilter('employee_name',event.target.value)} placeholder="输入姓名"/></label>
        <label><span>提交人 / 线上培训</span><input value={draftFilters.trainer} onChange={event=>setDraftFilter('trainer',event.target.value)} placeholder="输入提交人或培训"/></label>
        <label className="keyword"><span>报告内容</span><input value={draftFilters.keyword} onChange={event=>setDraftFilter('keyword',event.target.value)} placeholder="搜索平台、报告、评语或问题"/></label>
        <label><span>日期起</span><input type="date" value={draftFilters.from} onChange={event=>setDraftFilter('from',event.target.value)}/></label>
        <label><span>日期止</span><input type="date" value={draftFilters.to} onChange={event=>setDraftFilter('to',event.target.value)}/></label>
      </div>
      <div className="ot-filter-row secondary-row">
        <label><span>团队</span><select value={draftFilters.team} onChange={event=>setDraftFilter('team',event.target.value)}><option value="">全部团队</option>{filterOptions.team.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>组别</span><select value={draftFilters.group} onChange={event=>setDraftFilter('group',event.target.value)}><option value="">全部组别</option>{filterOptions.group.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>岗位</span><select value={draftFilters.position} onChange={event=>setDraftFilter('position',event.target.value)}><option value="">全部岗位</option>{filterOptions.position.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>班次</span><select value={draftFilters.shift} onChange={event=>setDraftFilter('shift',event.target.value)}><option value="">全部班次</option>{filterOptions.shift.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>盘口</span><select value={draftFilters.platform} onChange={event=>setDraftFilter('platform',event.target.value)}><option value="">全部盘口</option>{filterOptions.platform.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>当日状态</span><select value={draftFilters.attendance} onChange={event=>setDraftFilter('attendance',event.target.value)}><option value="">全部状态</option>{ATTENDANCE_OPTIONS.map(([value,item])=><option value={value} key={value}>{item.label}</option>)}</select></label>
        <div className="ot-filter-actions"><button type="submit" className="query" disabled={searching}>{searching?'查询中…':filterDirty?'查询新条件':'查询'}</button><button type="button" onClick={clearFilters} disabled={searching}>重置</button></div>
      </div>
      <div className="ot-filter-foot"><span>首次进入显示本月至今；修改任何条件后点击“查询”</span><strong>{activeFilterCount?`已应用 ${activeFilterCount} 项条件 · `:''}{mode==='reports'?`${result.total||0} 名培训人员 · 共 ${result.report_total||0} 份日报`:`${result.total||0} 名员工`}</strong></div>
    </form>
    {(loading&&!bootstrap)||(searching&&!result.rows.length)?<ListSkeleton mode={mode}/>:
      mode==='reports'?<ReportList rows={result.rows} onHistory={loadTrainerHistory}/>
      :<PeopleList rows={result.rows} onHistory={openHistory}/>
    }

    {!loading&&result.total>0&&<Pagination page={page} pages={result.pages||1} total={result.total} pageSize={pageSize} pageSizeOptions={[20,30,50,100]} onPage={next=>{listIntentRef.current='查询线上培训分页';setPage(next);setSearchVersion(version=>version+1)}} onPageSize={next=>{listIntentRef.current='调整线上培训分页';setPageSize(next);setPage(1);setSearchVersion(version=>version+1)}}/>}

    {editor&&<OverlayPortal><EditorModal editor={editor} updateDraft={updateDraft} updateMember={updateMember} updateMetric={updateMetric}
      assignment={bootstrap.auto_assignment||{}} trainerOptions={bootstrap.manager_options||[]} onSelectTrainer={selectAdminTrainer}
      rosterSyncedAt={bootstrap.roster_synced_at} pendingFiles={pendingFiles} onFiles={addFiles} onRemovePending={removePending}
      onRemoveExisting={removeExisting} onOpenImage={setLightbox} onProfile={openProfile} onClose={closeEditor} onSave={saveReport} saving={saving}/></OverlayPortal>} 
    {trainerHistory&&<OverlayPortal><TrainerHistoryModal state={trainerHistory} onClose={closeTrainerHistory} onOpen={openView} onDelete={requestDelete}/></OverlayPortal>}
    {viewing&&<OverlayPortal><ViewModal row={viewing} returnToHistory={Boolean(trainerHistory)} onClose={closeViewer} onProfile={openProfile} onOpenImage={setLightbox} onEdit={()=>{const source=viewing;closeViewer();closeTrainerHistory();openEdit(source)}} onDelete={()=>requestDelete(viewing)} onCopy={()=>copyTelegram(viewing)} onReview={reviewReport}/></OverlayPortal>}
    {deleteTarget&&<OverlayPortal><ConfirmModal saving={saving} title={deleteTarget.title} error={deleteError} onCancel={cancelDelete} onConfirm={archiveReport}/></OverlayPortal>}
    {profile&&!profile.error&&<EmployeeDrawer key={profile.detail?.employee?.id||profile.detail?.employee?.employee_no||profile.person?.employee_id||'training-employee'} detail={profile.detail||{employee:{}}} loading={profile.loading} readOnly onClose={closeProfile}/>}
    {profile?.error&&<OverlayPortal><ProfileErrorDrawer state={profile} onClose={closeProfile}/></OverlayPortal>}
    {history&&<OverlayPortal><HistoryModal state={history} onClose={closeHistory} onProfile={openProfile} onSelectDate={selectHistoryDate} onDelete={requestDelete}/></OverlayPortal>}
    {lightbox&&<OverlayPortal><div className="ot-lightbox" onClick={()=>setLightbox(null)}><button>×</button><img src={lightbox.url} alt={lightbox.name||'培训截图'}/><span>{lightbox.name||'培训截图'}</span></div></OverlayPortal>}
  </div>
}

function ReportList({rows,onHistory}){
  if(!rows?.length)return <div className="ot-empty"><span>培</span><h3>没有匹配的培训人员</h3><p>可以调整员工、组织或日期条件后重新查询。</p></div>
  return <section className="ot-compact-table-shell" aria-label="培训人员日报列表"><table className="ot-compact-table">
    <thead><tr><th>入职日期</th><th>员工ID</th><th>姓名</th><th>团队 / 岗位</th><th>培训人</th><th>日报数量</th><th>最近日报</th><th>操作</th></tr></thead>
    <tbody>{rows.map(trainer=>{const item=trainerTrainingTableRow(trainer);return <tr key={item.key}>
      <td data-label="入职日期">{dateText(item.hireDate)}</td>
      <td data-label="员工ID"><strong className="ot-cell-id">{item.employeeNo||'—'}</strong></td>
      <td data-label="姓名"><strong className="ot-person-name">{item.name||'未填写'}</strong></td>
      <td data-label="团队 / 岗位"><div className="ot-stacked-cell"><strong>{item.teams.join(' / ')||'—'}</strong><span>{item.positions.join(' / ')||'—'}</span></div></td>
      <td data-label="培训人"><div className="ot-stacked-cell"><strong>{item.name||'—'}</strong><span>{trainer.group_names?.join(' / ')||'线上培训'}</span></div></td>
      <td data-label="日报数量"><div className="ot-report-count-cell"><strong>{item.reportCount} 份</strong><span>{item.recordedDays} 个记录日 · {item.employeeCount} 名员工</span></div></td>
      <td data-label="最近日报"><strong>{dateText(item.lastReportDate)}</strong></td>
      <td data-label="操作"><button type="button" className="ot-table-action" onClick={()=>onHistory(trainer)}>查看日报</button></td>
    </tr>})}</tbody>
  </table></section>
}

function ListSkeleton({mode}){
  const count=mode==='reports'?6:8
  return <section className="ot-compact-table-shell ot-compact-table-loading" aria-label="正在读取日报列表" aria-busy="true"><div className="ot-loading-columns" aria-hidden="true">{Array.from({length:8},(_,index)=><i key={index}/>)}</div>{Array.from({length:count},(_,index)=><div className="ot-loading-row" key={index} aria-hidden="true">{Array.from({length:8},(_,cell)=><i key={cell}/>)}</div>)}</section>
}

function PeopleList({rows,onHistory}){
  if(!rows?.length)return <div className="ot-empty"><span>人</span><h3>没有找到员工培训记录</h3><p>可以输入员工ID或姓名搜索。</p></div>
  return <section className="ot-compact-table-shell" aria-label="员工日报列表"><table className="ot-compact-table">
    <thead><tr><th>入职日期</th><th>员工ID</th><th>姓名</th><th>团队 / 岗位</th><th>培训人</th><th>日报数量</th><th>最近日报</th><th>操作</th></tr></thead>
    <tbody>{rows.map(person=>{const item=employeeTrainingTableRow(person);return <tr key={item.key}>
      <td data-label="入职日期">{dateText(item.hireDate)}</td>
      <td data-label="员工ID"><strong className="ot-cell-id">{item.employeeNo||'—'}</strong></td>
      <td data-label="姓名"><strong className="ot-person-name">{item.name||'未填写'}</strong></td>
      <td data-label="团队 / 岗位"><div className="ot-stacked-cell"><strong>{item.team||'—'}</strong><span>{item.position||'—'}</span></div></td>
      <td data-label="培训人"><div className="ot-stacked-cell"><strong>{item.trainer||'—'}</strong><span>{person.group_name||person.shift_name||'—'}</span></div></td>
      <td data-label="日报数量"><div className="ot-report-count-cell"><strong>{item.reportCount} 份</strong><span>有记录 {item.recordedDays} · 未记录 {item.missingDays}</span></div></td>
      <td data-label="最近日报"><strong>{dateText(item.lastReportDate)}</strong></td>
      <td data-label="操作"><button type="button" className="ot-table-action" onClick={()=>onHistory(person)}>查看日报</button></td>
    </tr>})}</tbody>
  </table></section>
}

function EditorModal({editor,updateDraft,updateMember,updateMetric,assignment,trainerOptions,onSelectTrainer,rosterSyncedAt,pendingFiles,onFiles,onRemovePending,onRemoveExisting,onOpenImage,onProfile,onClose,onSave,saving}){
  const d=editor.draft
  const linked=editor.assignmentMode==='linked',admin=editor.assignmentMode==='admin',editing=editor.assignmentMode==='edit'
  const facts=[['线上培训',d.trainer_name],['团队',d.team_name],['组别',d.group_name],['班次',d.shift_name],['平台 / 盘口',d.platform]]
  const invalidIndexes=new Set((editor.validation?.issues||[]).map(issue=>issue.index))
  const locateInvalid=()=>{const first=editor.validation?.issues?.[0];if(first)document.getElementById(`ot-member-${first.index}`)?.scrollIntoView({behavior:'smooth',block:'center'});else if(editor.validation?.summary)document.getElementById('ot-team-summary')?.scrollIntoView({behavior:'smooth',block:'center'})}
  return <div className="ot-backdrop" onMouseDown={event=>{if(!saving&&event.target===event.currentTarget)onClose()}}><div className="ot-modal ot-editor">
    <header><div><span>{editor.original?'EDIT TRAINING REPORT':'NEW TRAINING REPORT'}</span><h2>{editor.original?'编辑线上培训日报':'提交线上培训日报'}</h2></div><button type="button" onClick={onClose} disabled={saving}>×</button></header>
    {editor.validation&&<div className="ot-editor-alert" role="alert"><div><strong>{editor.validation.message}</strong>{editor.validation.issues?.length>0&&<span>{editor.validation.issues.map(issue=>`${issue.employee_no} · ${issue.employee_name}（${issue.detail}）`).join('；')}</span>}</div>{(editor.validation.issues?.length>0||editor.validation.summary)&&<button type="button" onClick={locateInvalid}>定位填写</button>}</div>}
    <div className="ot-modal-scroll">
      <section className="ot-form-section ot-auto-roster"><div className="section-title"><div><b>1. 账号与居家排班已自动关联</b><small>人员以「居家排班表 · 填表」的线上培训字段为准，不需要自行筛选</small></div><strong>{editor.members.length} 名组员</strong></div>
        <div className="ot-auto-top">
          <label><span>报告日期 *</span><input type="date" value={d.report_date} onChange={e=>{updateDraft('report_date',e.target.value);if(d.title.startsWith('线上培训日报 · '))updateDraft('title',`线上培训日报 · ${e.target.value}`)}}/></label>
          <div className="identity"><span>{text(d.trainer_name||assignment.trainer_name).slice(0,1).toUpperCase()||'培'}</span><div><small>当前提交人 / 线上培训</small><strong>{d.trainer_name||assignment.trainer_name||'管理员代填'}</strong><em>{assignment.employee_no||'管理账号'} · 排班更新 {timeText(rosterSyncedAt)}</em></div></div>
        </div>
        {linked&&<div className="ot-assignment-ok"><b>✓ 已自动载入本人负责的 {editor.members.length} 名组员</b><span>账号一旦关联员工档案，以后打开日报都会直接显示这份名单。</span></div>}
        {editing&&<div className="ot-assignment-ok edit"><b>正在编辑原日报</b><span>名单沿用提交当天保存的排班快照，不会被当前排班覆盖。</span></div>}
        {admin&&<div className="ot-admin-picker"><label><span>管理员测试 / 代填线上培训</span><select value={d.manager_filter} onChange={e=>onSelectTrainer(e.target.value)} disabled={editor.rosterLoading}><option value="">{editor.rosterLoading?'正在读取负责人员…':'请选择一名线上培训人员'}</option>{trainerOptions.map(x=><option key={x}>{x}</option>)}</select></label><small>普通线上培训账号不会看到这个选择框，系统会按其关联档案直接载入。</small></div>}
        {editor.rosterError&&<div className="ot-assignment-missing"><b>人员读取失败</b><span>{editor.rosterError}，请重新选择该线上培训人员。</span></div>}
        {editor.assignmentMode==='unmatched'&&<div className="ot-assignment-missing"><b>居家排班表暂时没有匹配到你的组员</b><span>当前账号已关联 {assignment.employee_no} · {assignment.trainer_name}，请检查排班表“线上培训”填写的姓名是否一致。</span></div>}
        {editor.members.length>0&&<div className="ot-auto-facts">{facts.filter(([,value])=>text(value)).map(([label,value])=><span key={label}><b>{label}</b>{value}</span>)}</div>}
      </section>

      <section className="ot-form-section"><div className="section-title"><div><b>2. 填写组员当天工作情况</b><small>名单已经带入；未到入职日期可选“未入”，公休、未入无需原因，请假、缺席、回家必须填写原因</small></div><strong>{editor.members.length} 人</strong></div>
        {!editor.members.length?<div className={`ot-no-members ${editor.rosterLoading?'loading':''}`}>{editor.rosterLoading?'正在从居家排班表读取该培训负责的人员…':admin?'请选择一名线上培训人员，组员会立即自动出现。':'当前没有可填写的线上培训人员。'}</div>:<div className="ot-member-edit-list">{editor.members.map((member,index)=><MemberEditor key={member.employee_id} member={member} reportDate={d.report_date} index={index} invalid={invalidIndexes.has(index)} onChange={updateMember} onMetric={updateMetric} onProfile={onProfile}/>)}</div>}
      </section>

      <section className="ot-form-section"><div className="section-title"><div><b>3. 上传关键图片</b><small>只上传必要证据；系统会自动压缩，列表不预加载大图；最多{MAX_ATTACHMENTS}张</small></div></div>
        <div className="ot-upload"><div><strong>工作截图 / 培训截图</strong><small>JPG / PNG / WEBP / GIF，自动压缩至1600px / 4MB以内</small></div><label>选择图片<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={onFiles}/></label></div>
        {(d.attachments.length>0||pendingFiles.length>0)&&<div className="ot-upload-list">
          {d.attachments.map(item=><div key={item.path}><button type="button" className="preview" disabled={!item.url} onClick={()=>item.url&&onOpenImage(item)}>{item.url?<img src={item.url} alt={item.name}/>:<span>已上传</span>}<b>{item.name}</b><small>点击查看大图</small></button><button type="button" className="remove" onClick={()=>onRemoveExisting(item.path)}>移除</button></div>)}
          {pendingFiles.map((item,index)=><div key={item.preview}><button type="button" className="preview" onClick={()=>onOpenImage({url:item.preview,name:item.file.name})}><img src={item.preview} alt={item.file.name}/><b>{item.file.name}</b><small>点击查看大图</small></button><button type="button" className="remove" onClick={()=>onRemovePending(index)}>移除</button></div>)}
        </div>}
      </section>

      <section id="ot-team-summary" className={`ot-form-section ot-team-summary ${editor.validation?.summary?'invalid':''}`}><div className="section-title"><div><b>4. 团队总体工作情况 *</b><small>必填；概括当天整体工作与培训情况，共同问题和下一步安排可继续补充</small></div><strong>必填</strong></div>
        <div className="ot-form-grid">
          <label className="wide"><span>团队总体工作情况 *</span><textarea required aria-required="true" rows="4" value={d.report_summary} onChange={e=>updateDraft('report_summary',e.target.value)} placeholder="概括今天团队整体完成情况与培训表现"/></label>
          <label className="wide"><span>共同问题（选填）</span><textarea rows="3" value={d.issues_summary} onChange={e=>updateDraft('issues_summary',e.target.value)} placeholder="多人出现的共同问题"/></label>
          <label className="wide"><span>下一步安排（选填）</span><textarea rows="3" value={d.next_plan} onChange={e=>updateDraft('next_plan',e.target.value)} placeholder="明日培训重点或需要主管跟进的事项"/></label>
        </div>
      </section>
    </div>
    <footer className="ot-modal-actions"><button type="button" onClick={onClose} disabled={saving}>取消</button><button type="button" className="primary" onClick={onSave} disabled={saving||!editor.members.length}>{saving?'保存中…':editor.original?'保存修改':'提交日报'}</button></footer>
  </div></div>
}

function MemberEditor({member,reportDate,index,invalid,onChange,onMetric,onProfile}){
  const prompt=positionPrompts(member.position_name),normal=member.attendance_status==='normal',requiresReason=REASON_REQUIRED.has(member.attendance_status)
  const hireDate=text(member.hire_date).slice(0,10)
  const canUseNotStarted=Boolean(hireDate&&reportDate&&reportDate<hireDate)
  return <article id={`ot-member-${index}`} className={`ot-member-editor ${invalid?'invalid':''}`}>
    <header><button type="button" className="person" onClick={()=>onProfile(member.employee_id)}><span>{index+1}</span><div><strong>{member.employee_no} · {member.employee_name}</strong><small>{member.position_name||'未填写岗位'} · {member.team_name||'—'} · {member.shift_name||'—'}</small></div></button><em>排班自动带入</em></header>
    <div className="ot-member-status"><label><span>当日状态</span><select value={member.attendance_status} onChange={e=>onChange(index,'attendance_status',e.target.value)}>{ATTENDANCE_OPTIONS.map(([value,item])=><option value={value} disabled={value==='not_started'&&!canUseNotStarted&&member.attendance_status!==value} key={value}>{item.label}</option>)}</select>{hireDate&&<small>入职日期：{hireDate}{canUseNotStarted?' · 报告日在入职前可选“未入”':''}</small>}</label>{requiresReason&&<label className="note"><span>原因 *</span><input value={member.status_note} onChange={e=>onChange(index,'status_note',e.target.value)} placeholder={REASON_PLACEHOLDER[member.attendance_status]}/></label>}</div>
    {normal&&<div className="ot-member-fields compact">
      <label className="wide"><span>当天工作情况 / 培训评语 *</span><textarea rows="4" value={member.work_details} onChange={e=>onChange(index,'work_details',e.target.value)} placeholder={`${prompt.work}；也可以直接粘贴 Telegram 报告中的完整说明。`}/></label>
      <label className="wide"><span>岗位数据 / 首次响应（选填）</span><input value={member.metrics?.response_time||''} onChange={e=>onMetric(index,e.target.value)} placeholder={prompt.metric}/></label>
      <details className="ot-member-more wide"><summary>可选：分别补充工作表现、发现问题、后续安排</summary><div>
        <label><span>工作表现</span><textarea rows="3" value={member.performance} onChange={e=>onChange(index,'performance',e.target.value)} placeholder={prompt.performance}/></label>
        <label><span>发现问题</span><textarea rows="3" value={member.issues} onChange={e=>onChange(index,'issues',e.target.value)} placeholder={prompt.issues}/></label>
        <label><span>后续安排</span><textarea rows="3" value={member.follow_up} onChange={e=>onChange(index,'follow_up',e.target.value)} placeholder={prompt.follow}/></label>
      </div></details>
    </div>}
  </article>
}

function ViewModal({row,returnToHistory=false,onClose,onProfile,onOpenImage,onEdit,onDelete,onCopy,onReview}){
  const [note,setNote]=useState(row.review_note||'')
  const [selectedMemberId,setSelectedMemberId]=useState(()=>text(row.members?.[0]?.id)||text(row.members?.[0]?.employee_id)||text(row.members?.[0]?.employee_no))
  useEffect(()=>{
    const first=row.members?.[0]
    setSelectedMemberId(text(first?.id)||text(first?.employee_id)||text(first?.employee_no))
    setNote(row.review_note||'')
  },[row.id])
  const counts=Object.fromEntries(Object.keys(ATTENDANCE).map(key=>[key,(row.members||[]).filter(m=>m.attendance_status===key).length]))
  const selectedMember=selectedTrainingHistoryRow(row.members||[],selectedMemberId)
  return <div className="ot-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div className="ot-modal ot-view">
    <header><div><span>ONLINE TRAINING REPORT</span><h2>{row.title}</h2></div><button onClick={onClose}>×</button></header>
    <div className="ot-modal-scroll">
      <div className="ot-view-head"><div className="date"><span>{dateText(row.report_date)}</span><strong>{row.platform||'未填写平台'} · {row.shift_name||'未填写班次'}</strong></div><div><span>提交人</span><strong>{row.author_name||'后台用户'}</strong><small>{row.author_employee_no||'后台账号'} · {timeText(row.created_at)}</small></div></div>
      <div className="ot-view-meta"><span>负责人：{row.leader_name||'—'}</span><span>培训：{row.trainer_name||'—'}</span><span>课程：{row.course_type||'—'}</span><span>人员：{row.members?.length||0}人</span></div>
      <div className="ot-counts large"><b>排班记录</b><span>正常 {counts.normal||0}</span><span>公休 {counts.rest||0}</span><span>未入 {counts.not_started||0}</span><span>请假 {counts.leave||0}</span><span className={counts.absent?'danger':''}>缺席 {counts.absent||0}</span><span>回家 {counts.transferred||0}</span></div>
      {(row.report_summary||row.issues_summary||row.next_plan)&&<section className="ot-summary-box compact ot-report-global-summary">{row.report_summary&&<div><b>整体培训总结</b><p>{row.report_summary}</p></div>}{row.issues_summary&&<div><b>共同问题</b><p>{row.issues_summary}</p></div>}{row.next_plan&&<div><b>下一步安排</b><p>{row.next_plan}</p></div>}</section>}
      <div className="ot-report-detail-workspace">
        <aside className="ot-member-index"><header><strong>人员列表</strong><span>{row.members?.length||0} 人</span></header><div>{(row.members||[]).map((member,index)=>{const status=ATTENDANCE[member.attendance_status]||ATTENDANCE.normal;const key=text(member.id)||text(member.employee_id)||text(member.employee_no);const active=selectedMember===member;return <button type="button" className={active?'active':''} key={key||index} onClick={()=>setSelectedMemberId(key)}><span>{index+1}</span><div><strong>{member.employee_no||'—'} · {member.employee_name||'未填写姓名'}</strong><small>{member.position_name||'未填写岗位'} · {member.team_name||'未填写团队'}</small></div><em className={status.tone}>{status.label}</em></button>})}</div></aside>
        <section className="ot-selected-member-detail">
          {selectedMember?<MemberView member={selectedMember} index={(row.members||[]).indexOf(selectedMember)} onProfile={onProfile}/>:<div className="ot-empty small"><h3>这份日报没有人员明细</h3></div>}
          <AttachmentGrid items={row.attachments} onOpen={onOpenImage} compact/>
        </section>
      </div>
      {(row.review_note||row.review_status!=='pending')&&<div className={`ot-review-note ${row.review_status}`}><strong>{REVIEW[row.review_status]}</strong><p>{row.review_note||'已查看，无补充批注。'}</p></div>}
      {row.can_review&&<div className="ot-review-box"><label>组长 / 主管批注<textarea rows="2" value={note} onChange={e=>setNote(e.target.value)} placeholder="可填写需补充内容；仅查看可直接标记已阅"/></label><div><button onClick={()=>onReview('read',note)}>标记已阅</button><button className="warn" onClick={()=>onReview('needs_changes',note)}>需要补充</button></div></div>}
    </div>
    <footer className="ot-modal-actions"><button onClick={onCopy}>复制 Telegram 格式</button>{row.can_edit&&<button onClick={onEdit}>编辑</button>}{row.can_edit&&<button className="danger" onClick={onDelete}>删除</button>}<button className="primary" onClick={onClose}>{returnToHistory?'返回日报列表':'关闭'}</button></footer>
  </div></div>
}

function MemberView({member,index,onProfile}){
  const status=ATTENDANCE[member.attendance_status]||ATTENDANCE.normal
  return <article className="ot-member-view"><header><button onClick={()=>onProfile(member.employee_id)}><span>{index+1}</span><div><strong>{member.employee_no} · {member.employee_name}</strong><small>{member.position_name||'—'} · {member.team_name||'—'} · {member.shift_name||'—'}</small></div></button><em className={status.tone}>{status.label}</em></header>
    {member.status_note&&<div className="status-note"><b>原因</b><p>{member.status_note}</p></div>}
    {member.attendance_status==='normal'&&<div className="ot-member-detail-grid">{member.work_details&&<div><b>今日工作</b><p>{member.work_details}</p></div>}{member.performance&&<div><b>工作表现</b><p>{member.performance}</p></div>}{member.issues&&<div><b>发现问题</b><p>{member.issues}</p></div>}{member.follow_up&&<div><b>后续安排</b><p>{member.follow_up}</p></div>}{text(member.metrics?.response_time)&&<div className="wide"><b>岗位数据 / 首次响应</b><p>{member.metrics.response_time}</p></div>}</div>}
  </article>
}

function ProfileErrorDrawer({state,onClose}){
  return <div className="ot-backdrop drawer-mask" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><aside className="ot-profile-drawer"><header><div><span>!</span><div><small>EMPLOYEE PROFILE</small><h2>无法打开员工档案</h2><b>权限与负责范围已由后台核验</b></div></div><button onClick={onClose}>×</button></header><div className="ot-drawer-state error">{state.error}</div></aside></div>
}

function TrainerHistoryModal({state,onClose,onOpen,onDelete}){
  const trainer=state.trainer||{}
  const [date,setDate]=useState('')
  const visibleRows=date?state.rows.filter(row=>row.report_date===date):state.rows
  const employeeCount=new Set(visibleRows.flatMap(row=>(row.members||[]).map(member=>member.employee_id))).size
  return <div className="ot-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div className="ot-modal ot-trainer-history">
    <header><div><span>TRAINER REPORT HISTORY</span><h2>{trainer.trainer_name||'线上培训'} · 全部日报</h2></div><button onClick={onClose}>×</button></header>
    <div className="ot-modal-scroll">
      <section className="ot-trainer-history-summary"><div className="identity text-only"><div><small>线上培训</small><strong>{trainer.trainer_name||'未填写'}</strong><em>{trainer.team_names?.join(' / ')||'未填写团队'} · {trainer.position_names?.join(' / ')||'未填写岗位'}</em></div></div><div className="metrics"><span><small>日报</small><b>{state.rows.length}</b></span><span><small>记录日</small><b>{new Set(state.rows.map(row=>row.report_date)).size}</b></span><span><small>培训员工</small><b>{employeeCount}</b></span></div></section>
      <div className="ot-trainer-date-filter"><label><span>只看某一天</span><input type="date" value={date} onChange={event=>setDate(event.target.value)}/></label><button type="button" disabled={!date} onClick={()=>setDate('')}>清除日期</button><small>{date?`${dateText(date)} · ${visibleRows.length} 份`:`全部 ${state.rows.length} 份日报`}</small></div>
      {state.loading?<div className="ot-inline-skeleton"><i/><i/><i/></div>:state.error?<div className="ot-drawer-state error">{state.error}</div>:!visibleRows.length?<div className="ot-empty small"><h3>{date?'该日没有日报':'当前培训人员尚无日报'}</h3><p>零日报培训人员会保留在列表中。</p></div>:<section className="ot-compact-table-shell in-modal"><table className="ot-compact-table ot-trainer-report-table"><thead><tr><th>日报日期</th><th>日报内容</th><th>提交人</th><th>员工</th><th>状态统计</th><th>操作</th></tr></thead><tbody>{visibleRows.map(row=>{
        const counts=Object.fromEntries(Object.keys(ATTENDANCE).map(key=>[key,(row.members||[]).filter(member=>member.attendance_status===key).length]))
        return <tr key={row.id}><td data-label="日报日期"><div className="ot-stacked-cell"><strong>{dateText(row.report_date)}</strong><span>{timeText(row.created_at)}</span></div></td><td data-label="日报内容"><div className="ot-stacked-cell"><strong>{row.title||`线上培训日报 · ${row.report_date}`}</strong><span className="summary">{row.report_summary||row.issues_summary||row.next_plan||'已保存当天培训记录'}</span></div></td><td data-label="提交人"><div className="ot-stacked-cell"><strong>{row.author_name||row.trainer_name||'后台账号'}</strong><span>{row.author_employee_no||'—'}</span></div></td><td data-label="员工"><strong>{row.members?.length||0} 名</strong></td><td data-label="状态统计"><div className="ot-status-inline"><span>正常 {counts.normal||0}</span><span>公休 {counts.rest||0}</span><span>未入 {counts.not_started||0}</span><span>请假 {counts.leave||0}</span><span className={counts.absent?'danger':''}>缺席 {counts.absent||0}</span></div></td><td data-label="操作"><div className="ot-table-actions"><button type="button" onClick={()=>onOpen(row)}>查看</button>{row.can_edit&&<button type="button" className="danger" onClick={()=>onDelete(row)}>删除</button>}</div></td></tr>
      })}</tbody></table></section>}
    </div><footer className="ot-modal-actions"><button className="primary" onClick={onClose}>关闭</button></footer>
  </div></div>
}

function HistoryModal({state,onClose,onProfile,onSelectDate,onDelete}){
  const person=state.person||{}
  const [selectedDate,setSelectedDate]=useState(state.period?.from===state.period?.to?(state.period.from||''):'')
  const [selectedRowId,setSelectedRowId]=useState('')
  useEffect(()=>{setSelectedRowId('')},[person.employee_id])
  const summary=historySummary(person,state.rows,state.period)
  const baseLabel=state.basePeriod?.from&&state.basePeriod?.to?`${dateText(state.basePeriod.from)} 至 ${dateText(state.basePeriod.to)}`:'全部可见日期'
  const viewingSingleDay=Boolean(state.period?.from&&state.period.from===state.period?.to)
  const selectedRow=selectedTrainingHistoryRow(state.rows,selectedRowId)
  const member=(selectedRow?.members||[])[0]||{}
  const status=ATTENDANCE[member.attendance_status]||ATTENDANCE.normal
  const normal=member.attendance_status==='normal'
  const details=normal
    ?[['当天工作 / 培训评语',member.work_details],['工作表现',member.performance],['发现问题',member.issues],['后续安排',member.follow_up],['岗位数据 / 首次响应',member.metrics?.response_time]]
    :[['状态说明',member.status_note]]
  const detailRows=details.filter(([,value])=>text(value))

  return <div className="ot-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div className="ot-modal ot-history"><header><div><span>EMPLOYEE TRAINING HISTORY</span><h2>{person.employee_no} · {person.employee_name}</h2></div><button onClick={onClose}>×</button></header><div className="ot-modal-scroll">
    <div className="ot-history-profile"><div><strong>{person.position_name||'未填写岗位'} · {person.team_name||'未填写团队'} · {person.shift_name||'未填写班次'}</strong><span>入职 {dateText(person.hire_date)} · {state.period?.from&&state.period?.to?`${dateText(state.period.from)} 至 ${dateText(state.period.to)}`:'所选日期范围'}</span></div><div><b>{state.loading?'读取中':`${summary.recorded_days} 个有记录日 · ${state.total||state.rows.length} 份日报`}</b><button onClick={()=>onProfile(person.employee_id)}>查看完整员工档案</button></div></div>
    <form className="ot-history-date-filter" onSubmit={event=>{event.preventDefault();if(selectedDate)onSelectDate(selectedDate)}}>
      <label><span>查看某一天</span><input type="date" min={state.basePeriod?.from||undefined} max={state.basePeriod?.to||undefined} value={selectedDate} onChange={event=>setSelectedDate(event.target.value)}/></label>
      <button type="submit" className="query" disabled={!selectedDate||state.loading}>只看该日</button>
      <button type="button" disabled={state.loading||!viewingSingleDay} onClick={()=>{setSelectedDate('');setSelectedRowId('');onSelectDate('')}}>返回筛选区间</button>
      <small>当前累计范围：{viewingSingleDay?dateText(state.period.from):baseLabel}</small>
    </form>
    <div className="ot-history-kpis"><span><small>区间天数</small><b>{summary.period_days}</b></span><span><small>有记录</small><b>{summary.recorded_days}</b></span><span className={summary.missing_days?'warn':''}><small>未记录</small><b>{summary.missing_days}</b></span><span><small>正常</small><b>{summary.normal_count}</b></span><span><small>公休</small><b>{summary.rest_count}</b></span><span><small>未入</small><b>{summary.not_started_count}</b></span><span><small>请假</small><b>{summary.leave_count}</b></span><span className={summary.absent_count?'danger':''}><small>缺席</small><b>{summary.absent_count}</b></span><span><small>回家</small><b>{summary.home_count}</b></span></div>
    {state.loading?<div className="ot-drawer-state">正在读取该员工每天记录…</div>:state.error?<div className="ot-drawer-state error">{state.error}</div>:!state.rows.length?<div className="ot-empty small"><h3>所选日期内暂无该员工记录</h3></div>:<div className="ot-history-workspace">
      <aside className="ot-history-index"><header><strong>日报日期</strong><span>{state.rows.length} 份</span></header><div>{state.rows.map(row=>{const rowMember=(row.members||[])[0]||{};const rowStatus=ATTENDANCE[rowMember.attendance_status]||ATTENDANCE.normal;const active=selectedRow===row;return <button type="button" key={row.id} className={active?'active':''} onClick={()=>setSelectedRowId(row.id)}><div><strong>{dateText(row.report_date)}</strong><small>{rowMember.shift_name||row.shift_name||'未填写班次'} · {rowMember.platform||row.platform||'未填写盘口'}</small></div><em className={rowStatus.tone}>{rowStatus.label}</em><p>{rowMember.status_note||rowMember.work_details||row.report_summary||'已记录当天情况'}</p></button>})}</div></aside>
      <section className="ot-history-selected">
        <header className="ot-history-selected-head"><div><small>当前日报</small><h3>{dateText(selectedRow?.report_date)} · {selectedRow?.title||'线上培训日报'}</h3><span>{member.shift_name||selectedRow?.shift_name||'未填写班次'} · {member.platform||selectedRow?.platform||'未填写盘口'}</span></div><em className={status.tone}>{status.label}</em></header>
        <div className="ot-history-scope"><span>团队 <b>{member.team_name||person.team_name||'—'}</b></span><span>岗位 <b>{member.position_name||person.position_name||'—'}</b></span><span>线上培训 <b>{member.trainer_name||selectedRow?.trainer_name||selectedRow?.author_name||'—'}</b></span></div>
        <div className="ot-history-details">{detailRows.map(([label,value],index)=><div className={index===0?'wide':''} key={label}><b>{label}</b><p>{value}</p></div>)}{!detailRows.length&&<div className="wide"><b>当天记录</b><p>已记录当天情况，暂无补充说明。</p></div>}</div>
        {(selectedRow?.report_summary||selectedRow?.issues_summary||selectedRow?.next_plan)&&<section className="ot-summary-box compact">{selectedRow.report_summary&&<div><b>整体培训总结</b><p>{selectedRow.report_summary}</p></div>}{selectedRow.issues_summary&&<div><b>共同问题</b><p>{selectedRow.issues_summary}</p></div>}{selectedRow.next_plan&&<div><b>下一步安排</b><p>{selectedRow.next_plan}</p></div>}</section>}
        <div className="ot-history-audit"><div><span>提交人：{selectedRow?.author_name||'后台用户'}</span><span>提交时间：{timeText(selectedRow?.created_at)}</span>{selectedRow?.updated_at&&selectedRow.updated_at!==selectedRow.created_at&&<span>最后更新：{timeText(selectedRow.updated_at)}</span>}</div>{selectedRow?.can_edit&&<button type="button" onClick={()=>onDelete(selectedRow)}>删除测试日报</button>}</div>
      </section>
    </div>}
  </div><footer className="ot-modal-actions"><button className="primary" onClick={onClose}>关闭</button></footer></div></div>
}

function ConfirmModal({saving,title,error,onCancel,onConfirm}){
  return <div className="ot-backdrop ot-confirm-backdrop"><div className="ot-confirm" role="dialog" aria-modal="true" aria-labelledby="ot-delete-title"><span>删</span><h3 id="ot-delete-title">确定删除这份日报？</h3><p>“{title}”会归档并从正常列表移除，操作日志仍然保留。</p>{error&&<p className="ot-confirm-error" role="alert">{error}</p>}<div><button onClick={onCancel} disabled={saving}>取消</button><button className="danger" onClick={onConfirm} disabled={saving}>{saving?'处理中…':'确认删除'}</button></div></div></div>
}
