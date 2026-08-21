import React,{useEffect,useMemo,useState} from 'react'
import {createPortal} from 'react-dom'
import {supabase} from '../lib/supabase'
import {Pagination} from '../components/DataPageControls'
import '../styles-online-training.css'

const BUCKET='online-training'
const REPORT_PAGE_SIZE=12
const PEOPLE_PAGE_SIZE=20
const text=value=>String(value??'').trim()
const isoToday=()=>{const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,10)}
const dateText=value=>value?new Date(`${value}T00:00:00`).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}):'—'
const timeText=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—'
const safeFileName=name=>text(name).replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'screenshot'
const cleanAttachment=item=>({path:text(item?.path),name:text(item?.name),size:Number(item?.size||0),type:text(item?.type)})
const attachmentWithUrl=item=>({...cleanAttachment(item),url:text(item?.url)})
const uniq=values=>[...new Set((values||[]).map(text).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'))
const rosterValue=(rows,key)=>uniq((rows||[]).map(row=>row?.[key])).join(' / ')
const EMPTY_FILTERS={employee_no:'',employee_name:'',trainer:'',keyword:'',team:'',group:'',position:'',shift:'',platform:'',attendance:'',from:'',to:''}
const defaultFilters=()=>{const today=isoToday();return {...EMPTY_FILTERS,from:today,to:today}}
const delay=ms=>new Promise(resolve=>window.setTimeout(resolve,ms))
const isTransientError=error=>/failed to fetch|networkerror|network request failed|load failed|connection|timeout/i.test(text(error?.message||error))
const readableError=(error,fallback)=>isTransientError(error)?'连接短暂中断，请点击“重新读取”':text(error?.message)||fallback

const ATTENDANCE={
  normal:{label:'正常上班',tone:'green'},
  rest:{label:'公休',tone:'gray'},
  leave:{label:'请假',tone:'amber'},
  absent:{label:'缺席',tone:'red'},
  transferred:{label:'回家',tone:'blue'},
}
const ATTENDANCE_OPTIONS=Object.entries(ATTENDANCE)
const REASON_REQUIRED=new Set(['leave','absent','transferred'])
const REASON_PLACEHOLDER={leave:'填写请假原因',absent:'填写缺席原因',transferred:'填写回家原因'}
const REVIEW={pending:'待查看',read:'已阅',needs_changes:'需补充'}

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
  const [bootstrap,setBootstrap]=useState(null)
  const [mode,setMode]=useState('reports')
  const [filters,setFilters]=useState(defaultFilters)
  const [draftFilters,setDraftFilters]=useState(defaultFilters)
  const [searchVersion,setSearchVersion]=useState(0)
  const [page,setPage]=useState(1)
  const [result,setResult]=useState({rows:[],total:0,pages:1})
  const [loading,setLoading]=useState(true)
  const [searching,setSearching]=useState(false)
  const [error,setError]=useState('')
  const [editor,setEditor]=useState(null)
  const [pendingFiles,setPendingFiles]=useState([])
  const [saving,setSaving]=useState(false)
  const [viewing,setViewing]=useState(null)
  const [deleteTarget,setDeleteTarget]=useState(null)
  const [profile,setProfile]=useState(null)
  const [history,setHistory]=useState(null)
  const [lightbox,setLightbox]=useState(null)

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

  const loadBootstrap=async()=>{
    setLoading(true)
    try{
      const data=await readCall('online_training_context')
      setBootstrap(data)
      setError('')
      return data
    }catch(err){setError(readableError(err,'线上培训模块读取失败'));return null}
    finally{setLoading(false)}
  }

  const loadList=async({silent=false,nextPage=page}={})=>{
    if(silent)setSearching(true);else setLoading(true)
    try{
      const data=mode==='people'
        ?await readCall('online_training_search_people',{
          p_filters:filters,p_page:nextPage,p_page_size:PEOPLE_PAGE_SIZE,
        })
        :await readCall('online_training_search_reports',{
          p_filters:filters,p_page:nextPage,p_page_size:REPORT_PAGE_SIZE,
        })
      const rows=mode==='reports'?await hydrateAttachments(data?.rows||[]):data?.rows||[]
      setResult({...data,rows})
      setError('')
    }catch(err){setError(readableError(err,'线上培训记录读取失败'))}
    finally{setLoading(false);setSearching(false)}
  }

  useEffect(()=>{loadBootstrap()},[])
  useEffect(()=>{
    if(!bootstrap)return
    const timer=setTimeout(()=>loadList({silent:true}),0)
    return()=>clearTimeout(timer)
  },[bootstrap,mode,page,searchVersion])
  useEffect(()=>setPage(1),[mode])
  useEffect(()=>{
    if(!(editor||viewing||deleteTarget||profile||history||lightbox))return
    const prior=document.body.style.overflow;document.body.style.overflow='hidden'
    return()=>{document.body.style.overflow=prior}
  },[editor,viewing,deleteTarget,profile,history,lightbox])

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
    const assignmentMode=myRoster.length?'linked':canAdminSelect?'admin':'unmatched'
    const sourceRows=assignmentMode==='linked'?myRoster:[]
    const draft=reportWithRoster(blankReport(bootstrap.access),sourceRows,bootstrap.access.employee_name)
    setError('')
    setPendingFiles([])
    setEditor({original:null,assignmentMode,rosterLoading:false,validation:null,draft,members:sourceRows.map(memberFromRoster)})
  }

  const openEdit=row=>{
    setError('')
    setPendingFiles([])
    setEditor({original:row,assignmentMode:'edit',rosterLoading:false,validation:null,draft:draftFromReport(row),members:(row.members||[]).map(memberFromReport)})
  }

  const releasePending=items=>items.forEach(item=>URL.revokeObjectURL(item.preview))
  const closeEditor=()=>{releasePending(pendingFiles);setPendingFiles([]);setEditor(null)}

  const selectAdminTrainer=async value=>{
    if(!value){
      setEditor(current=>({...current,rosterLoading:false,rosterError:'',draft:{...current.draft,manager_filter:'',trainer_name:'',leader_name:'',shift_name:'',team_name:'',group_name:'',platform:''},members:[]}))
      return
    }
    setEditor(current=>({...current,rosterLoading:true,rosterError:'',draft:{...current.draft,manager_filter:value,trainer_name:value},members:[]}))
    setError('')
    try{
      const selected=await readCall('online_training_roster_for_trainer',{p_trainer_name:value})||[]
      setEditor(current=>current?({...current,rosterLoading:false,
        draft:reportWithRoster({...current.draft,manager_filter:value,trainer_name:value},selected,value),
        members:selected.map(memberFromRoster),
      }):current)
    }catch(err){
      const message=readableError(err,'线上培训人员读取失败')
      setEditor(current=>current?({...current,rosterLoading:false,rosterError:message}):current)
    }
  }

  const addFiles=event=>{
    const files=[...(event.target.files||[])];event.target.value=''
    const slots=12-(editor?.draft?.attachments?.length||0)-pendingFiles.length
    if(slots<=0){setEditor(current=>({...current,validation:{message:'每份报告最多上传12张截图',issues:[]}}));return}
    const accepted=[]
    files.slice(0,slots).forEach(file=>{
      if(!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)){setEditor(current=>({...current,validation:{message:`${file.name} 不是支持的图片格式`,issues:[]}}));return}
      if(file.size>10*1024*1024){setEditor(current=>({...current,validation:{message:`${file.name} 超过10MB`,issues:[]}}));return}
      accepted.push({file,preview:URL.createObjectURL(file)})
    })
    setPendingFiles(current=>[...current,...accepted])
  }

  const removePending=index=>setPendingFiles(current=>{const next=[...current];const [removed]=next.splice(index,1);if(removed)URL.revokeObjectURL(removed.preview);return next})
  const removeExisting=path=>updateDraft('attachments',editor.draft.attachments.filter(item=>item.path!==path))

  const validate=()=>{
    if(!editor.draft.report_date)return{message:'请选择报告日期',issues:[]}
    if(!editor.members.length)return{message:editor.assignmentMode==='unmatched'?'居家排班表没有找到当前账号负责的线上培训人员':'请选择需要代填的线上培训人员',issues:[]}
    const issues=[]
    editor.members.forEach((member,index)=>{
      if(member.attendance_status==='normal'&&!text(member.work_details))issues.push({index,employee_no:member.employee_no,employee_name:member.employee_name,detail:'未填写当天工作情况'})
      else if(REASON_REQUIRED.has(member.attendance_status)&&!text(member.status_note))issues.push({index,employee_no:member.employee_no,employee_name:member.employee_name,detail:`${ATTENDANCE[member.attendance_status]?.label||'异常状态'}未填写原因`})
    })
    if(!issues.length)return null
    return{message:`还有 ${issues.length} 名人员的记录未完成，请补齐后再提交`,issues}
  }

  const saveReport=async()=>{
    const validation=validate()
    if(validation){
      setEditor(current=>({...current,validation}))
      if(validation.issues?.length)window.setTimeout(()=>document.getElementById(`ot-member-${validation.issues[0].index}`)?.scrollIntoView({behavior:'smooth',block:'center'}),0)
      return
    }
    setSaving(true);setError('');setEditor(current=>({...current,validation:null}))
    const uploaded=[]
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

      if(editor.original){
        const keptPaths=new Set(kept.map(item=>item.path))
        const removed=(editor.original.attachments||[]).map(item=>item.path).filter(path=>path&&!keptPaths.has(path))
        if(removed.length)await supabase.storage.from(BUCKET).remove(removed)
      }
      closeEditor();await loadList({silent:true,nextPage:1});setPage(1)
    }catch(err){
      if(uploaded.length)await supabase.storage.from(BUCKET).remove(uploaded.map(item=>item.path))
      setEditor(current=>current?({...current,validation:{message:err.message||'线上培训日报保存失败',issues:[]}}):current)
    }finally{setSaving(false)}
  }

  const archiveReport=async()=>{
    if(!deleteTarget)return
    setSaving(true)
    try{await call('online_training_archive_report',{p_report_id:deleteTarget.id});setDeleteTarget(null);await loadList({silent:true})}
    catch(err){setError(err.message||'报告删除失败')}
    finally{setSaving(false)}
  }

  const reviewReport=async(status,note)=>{
    try{
      await call('online_training_review_report',{p_report_id:viewing.id,p_status:status,p_note:note||''})
      setViewing(current=>({...current,review_status:status,review_note:note||''}))
      await loadList({silent:true})
    }catch(err){setError(err.message||'批注保存失败')}
  }

  const openProfile=async employeeId=>{
    setProfile({loading:true,data:null,error:''})
    try{setProfile({loading:false,data:await call('online_training_employee_profile',{p_employee_id:employeeId}),error:''})}
    catch(err){setProfile({loading:false,data:null,error:err.message||'员工基础档案读取失败'})}
  }

  const openHistory=async person=>{
    setHistory({person,loading:true,rows:[],error:''})
    try{
      const data=await call('online_training_list',{
        p_query:'',p_date_from:null,p_date_to:null,
        p_employee_id:person.employee_id,p_page:1,p_page_size:50,
      })
      setHistory({person,loading:false,rows:await hydrateAttachments(data?.rows||[]),error:''})
    }catch(err){setHistory({person,loading:false,rows:[],error:err.message||'员工历史记录读取失败'})}
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
    setFilters(next);setPage(1);setSearchVersion(version=>version+1)
  }
  const clearFilters=()=>{const next=defaultFilters();setDraftFilters(next);setFilters(next);setPage(1);setSearchVersion(version=>version+1)}
  const filterDirty=JSON.stringify(draftFilters)!==JSON.stringify(filters)
  const activeFilterCount=Object.values(filters).filter(Boolean).length

  return <div className="content-page ot-page">
    <header className="ot-header">
      <div><div className="module-kicker">ONLINE TRAINING</div><h1>线上培训日报</h1><p>人员来自居家排班表；逐人记录当天表现、公休、请假、缺席或回家情况。</p></div>
      <div className="ot-header-actions">
        <span className={`ot-access ${canOpenSubmit?'ok':'read'}`}>{myRoster.length?`已关联 ${myRoster.length} 名组员`:canAdminSelect?'管理员代填':'仅查看'}</span>
        <button onClick={loadBootstrap} disabled={loading||searching}>{loading?'读取中…':'刷新'}</button>
        {canOpenSubmit&&<button className="primary" onClick={openCreate}>＋ 提交线上培训日报</button>}
      </div>
    </header>

    {error&&<div className="ot-error"><span>{error}</span><div>{error.includes('重新读取')&&<button className="retry" onClick={loadBootstrap}>重新读取</button>}<button className="close" onClick={()=>setError('')}>×</button></div></div>}

    <section className="ot-kpis">
      <div><span>我负责的培训人员</span><strong>{myRoster.length||'—'}</strong><small>{myRoster.length?'按账号档案自动匹配':'主管账号仅查看或代填'}</small></div>
      <div><span>历史培训日报</span><strong>{mode==='reports'?result.total:'—'}</strong><small>当前搜索结果</small></div>
      <div><span>员工培训档案</span><strong>{mode==='people'?result.total:'—'}</strong><small>有日报记录的员工</small></div>
      <div><span>排班数据更新时间</span><strong className="date">{bootstrap?.roster_synced_at?timeText(bootstrap.roster_synced_at):'读取中'}</strong><small>保存日报时固定人员快照</small></div>
    </section>

    <div className="ot-view-tabs">
      <button className={mode==='reports'?'active':''} onClick={()=>setMode('reports')}>日报记录</button>
      <button className={mode==='people'?'active':''} onClick={()=>setMode('people')}>员工培训记录</button>
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
      <div className="ot-filter-foot"><span>首次进入只显示当天；修改任何条件后点击“查询”</span><strong>{activeFilterCount?`已应用 ${activeFilterCount} 项条件 · `:''}共 ${result.total||0} 条</strong></div>
    </form>
    {searching&&<div className="ot-searching"><i/><span>正在搜索线上培训记录…</span></div>}

    {loading&&!bootstrap?<div className="ot-loading"><i/><span>正在读取排班与线上培训记录…</span></div>:
      mode==='reports'?<ReportList rows={result.rows} onView={setViewing} onEdit={openEdit} onDelete={setDeleteTarget} onProfile={openProfile} onOpenImage={setLightbox}/>
      :<PeopleList rows={result.rows} onHistory={openHistory} onProfile={openProfile}/>
    }

    {!loading&&result.total>0&&<Pagination page={page} pages={result.pages||1} total={result.total} pageSize={mode==='reports'?REPORT_PAGE_SIZE:PEOPLE_PAGE_SIZE} onPage={setPage}/>}

    {editor&&<OverlayPortal><EditorModal editor={editor} updateDraft={updateDraft} updateMember={updateMember} updateMetric={updateMetric}
      assignment={bootstrap.auto_assignment||{}} trainerOptions={bootstrap.manager_options||[]} onSelectTrainer={selectAdminTrainer}
      rosterSyncedAt={bootstrap.roster_synced_at} pendingFiles={pendingFiles} onFiles={addFiles} onRemovePending={removePending}
      onRemoveExisting={removeExisting} onOpenImage={setLightbox} onProfile={openProfile} onClose={closeEditor} onSave={saveReport} saving={saving}/></OverlayPortal>} 
    {viewing&&<OverlayPortal><ViewModal row={viewing} onClose={()=>setViewing(null)} onProfile={openProfile} onOpenImage={setLightbox} onEdit={()=>{setViewing(null);openEdit(viewing)}} onDelete={()=>{setViewing(null);setDeleteTarget(viewing)}} onCopy={()=>copyTelegram(viewing)} onReview={reviewReport}/></OverlayPortal>} 
    {deleteTarget&&<OverlayPortal><ConfirmModal saving={saving} title={deleteTarget.title} onCancel={()=>setDeleteTarget(null)} onConfirm={archiveReport}/></OverlayPortal>} 
    {profile&&<OverlayPortal><ProfileDrawer state={profile} onClose={()=>setProfile(null)}/></OverlayPortal>} 
    {history&&<OverlayPortal><HistoryModal state={history} onClose={()=>setHistory(null)} onView={row=>{setHistory(null);setViewing(row)}} onProfile={openProfile}/></OverlayPortal>} 
    {lightbox&&<OverlayPortal><div className="ot-lightbox" onClick={()=>setLightbox(null)}><button>×</button><img src={lightbox.url} alt={lightbox.name||'培训截图'}/><span>{lightbox.name||'培训截图'}</span></div></OverlayPortal>}
  </div>
}

function ReportList({rows,onView,onEdit,onDelete,onProfile,onOpenImage}){
  if(!rows?.length)return <div className="ot-empty"><span>培</span><h3>暂时没有匹配的线上培训日报</h3><p>提交后会在这里显示，并可按员工搜索全部历史。</p></div>
  return <section className="ot-report-grid">{rows.map(row=>{
    const counts=Object.fromEntries(Object.keys(ATTENDANCE).map(key=>[key,(row.members||[]).filter(m=>m.attendance_status===key).length]))
    return <article className="ot-report-card" key={row.id}>
      <div className="ot-card-top"><div><span>{dateText(row.report_date)}</span><strong>{row.title}</strong></div><em className={`review ${row.review_status}`}>{REVIEW[row.review_status]||'待查看'}</em></div>
      <div className="ot-meta"><span>{row.platform||'未填写平台'}</span><span>{row.shift_name||'未填写班次'}</span><span>{row.trainer_name||row.author_name}</span></div>
      <p>{row.report_summary||row.issues_summary||'已完成逐人培训记录'}</p>
      <div className="ot-counts"><b>{row.members?.length||0} 人</b><span>正常 {counts.normal||0}</span><span>公休 {counts.rest||0}</span><span>请假 {counts.leave||0}</span><span className={counts.absent?'danger':''}>缺席 {counts.absent||0}</span><span>回家 {counts.transferred||0}</span></div>
      <div className="ot-member-chips">{(row.members||[]).slice(0,8).map(member=><button key={member.id} onClick={()=>onProfile(member.employee_id)}>{member.employee_no} · {member.employee_name}</button>)}{row.members?.length>8&&<span>+{row.members.length-8}</span>}</div>
      {row.attachments?.length>0&&<AttachmentGrid items={row.attachments.slice(0,4)} onOpen={onOpenImage} compact/>}
      <footer><div><strong>{row.author_name||'后台用户'}</strong><small>{row.author_employee_no||'后台账号'} · {timeText(row.created_at)}</small></div><div><button onClick={()=>onView(row)}>查看</button>{row.can_edit&&<button onClick={()=>onEdit(row)}>编辑</button>}{row.can_edit&&<button className="danger" onClick={()=>onDelete(row)}>删除</button>}</div></footer>
    </article>
  })}</section>
}

function PeopleList({rows,onHistory,onProfile}){
  if(!rows?.length)return <div className="ot-empty"><span>人</span><h3>没有找到员工培训记录</h3><p>可以输入员工ID或姓名搜索。</p></div>
  return <section className="ot-people-list">{rows.map(person=><article key={person.employee_id}>
    <button className="identity" onClick={()=>onProfile(person.employee_id)}><span>{text(person.employee_name).slice(0,1).toUpperCase()}</span><div><strong>{person.employee_name}</strong><small>{person.employee_no} · {person.position_name||'未填写岗位'}</small></div></button>
    <div className="scope"><span>{person.team_name||'—'}</span><span>{person.group_name||'—'}</span><span>{person.shift_name||'—'}</span></div>
    <div className="stats"><span><b>{person.report_count}</b>日报</span><span><b>{person.normal_count}</b>正常</span><span><b>{person.rest_count}</b>公休</span><span><b>{person.leave_count}</b>请假</span><span className={person.absent_count?'danger':''}><b>{person.absent_count}</b>缺席</span><span><b>{person.home_count||0}</b>回家</span><span className={person.issue_count?'warn':''}><b>{person.issue_count}</b>有问题</span></div>
    <div className="last"><small>最近记录</small><strong>{dateText(person.last_report_date)}</strong><button onClick={()=>onHistory(person)}>查看全部每天记录</button></div>
  </article>)}</section>
}

function EditorModal({editor,updateDraft,updateMember,updateMetric,assignment,trainerOptions,onSelectTrainer,rosterSyncedAt,pendingFiles,onFiles,onRemovePending,onRemoveExisting,onOpenImage,onProfile,onClose,onSave,saving}){
  const d=editor.draft
  const linked=editor.assignmentMode==='linked',admin=editor.assignmentMode==='admin',editing=editor.assignmentMode==='edit'
  const facts=[['线上培训',d.trainer_name],['团队',d.team_name],['组别',d.group_name],['班次',d.shift_name],['平台 / 盘口',d.platform]]
  const invalidIndexes=new Set((editor.validation?.issues||[]).map(issue=>issue.index))
  const locateInvalid=()=>{const first=editor.validation?.issues?.[0];if(first)document.getElementById(`ot-member-${first.index}`)?.scrollIntoView({behavior:'smooth',block:'center'})}
  return <div className="ot-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div className="ot-modal ot-editor">
    <header><div><span>{editor.original?'EDIT TRAINING REPORT':'NEW TRAINING REPORT'}</span><h2>{editor.original?'编辑线上培训日报':'提交线上培训日报'}</h2></div><button type="button" onClick={onClose}>×</button></header>
    {editor.validation&&<div className="ot-editor-alert" role="alert"><div><strong>{editor.validation.message}</strong>{editor.validation.issues?.length>0&&<span>{editor.validation.issues.map(issue=>`${issue.employee_no} · ${issue.employee_name}（${issue.detail}）`).join('；')}</span>}</div>{editor.validation.issues?.length>0&&<button type="button" onClick={locateInvalid}>定位第一处</button>}</div>}
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

      <section className="ot-form-section"><div className="section-title"><div><b>2. 填写组员当天工作情况</b><small>名单已经带入；公休无需原因，请假、缺席、回家必须填写原因</small></div><strong>{editor.members.length} 人</strong></div>
        {!editor.members.length?<div className={`ot-no-members ${editor.rosterLoading?'loading':''}`}>{editor.rosterLoading?'正在从居家排班表读取该培训负责的人员…':admin?'请选择一名线上培训人员，组员会立即自动出现。':'当前没有可填写的线上培训人员。'}</div>:<div className="ot-member-edit-list">{editor.members.map((member,index)=><MemberEditor key={member.employee_id} member={member} index={index} invalid={invalidIndexes.has(index)} onChange={updateMember} onMetric={updateMetric} onProfile={onProfile}/>)}</div>}
      </section>

      <section className="ot-form-section"><div className="section-title"><div><b>3. 上传当日图片</b><small>页面平时只显示小图，点击缩略图才会打开大图；最多12张</small></div></div>
        <div className="ot-upload"><div><strong>工作截图 / 培训截图</strong><small>JPG / PNG / WEBP / GIF，单张不超过10MB</small></div><label>选择图片<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={onFiles}/></label></div>
        {(d.attachments.length>0||pendingFiles.length>0)&&<div className="ot-upload-list">
          {d.attachments.map(item=><div key={item.path}><button type="button" className="preview" disabled={!item.url} onClick={()=>item.url&&onOpenImage(item)}>{item.url?<img src={item.url} alt={item.name}/>:<span>已上传</span>}<b>{item.name}</b><small>点击查看大图</small></button><button type="button" className="remove" onClick={()=>onRemoveExisting(item.path)}>移除</button></div>)}
          {pendingFiles.map((item,index)=><div key={item.preview}><button type="button" className="preview" onClick={()=>onOpenImage({url:item.preview,name:item.file.name})}><img src={item.preview} alt={item.file.name}/><b>{item.file.name}</b><small>点击查看大图</small></button><button type="button" className="remove" onClick={()=>onRemovePending(index)}>移除</button></div>)}
        </div>}
        <details className="ot-optional-summary"><summary>可选：补充团队整体总结、共同问题或下一步安排</summary><div className="ot-form-grid">
          <label className="wide"><span>整体培训总结</span><textarea rows="3" value={d.report_summary} onChange={e=>updateDraft('report_summary',e.target.value)} placeholder="概括今天整体完成情况"/></label>
          <label className="wide"><span>共同问题</span><textarea rows="3" value={d.issues_summary} onChange={e=>updateDraft('issues_summary',e.target.value)} placeholder="多人出现的共同问题"/></label>
          <label className="wide"><span>下一步安排</span><textarea rows="3" value={d.next_plan} onChange={e=>updateDraft('next_plan',e.target.value)} placeholder="明日培训重点或需要主管跟进的事项"/></label>
        </div></details>
      </section>
    </div>
    <footer className="ot-modal-actions"><button type="button" onClick={onClose} disabled={saving}>取消</button><button type="button" className="primary" onClick={onSave} disabled={saving||!editor.members.length}>{saving?'保存中…':editor.original?'保存修改':'提交日报'}</button></footer>
  </div></div>
}

function MemberEditor({member,index,invalid,onChange,onMetric,onProfile}){
  const prompt=positionPrompts(member.position_name),normal=member.attendance_status==='normal',requiresReason=REASON_REQUIRED.has(member.attendance_status)
  return <article id={`ot-member-${index}`} className={`ot-member-editor ${invalid?'invalid':''}`}>
    <header><button type="button" className="person" onClick={()=>onProfile(member.employee_id)}><span>{index+1}</span><div><strong>{member.employee_no} · {member.employee_name}</strong><small>{member.position_name||'未填写岗位'} · {member.team_name||'—'} · {member.shift_name||'—'}</small></div></button><em>排班自动带入</em></header>
    <div className="ot-member-status"><label><span>当日状态</span><select value={member.attendance_status} onChange={e=>onChange(index,'attendance_status',e.target.value)}>{ATTENDANCE_OPTIONS.map(([value,item])=><option value={value} key={value}>{item.label}</option>)}</select></label>{requiresReason&&<label className="note"><span>原因 *</span><input value={member.status_note} onChange={e=>onChange(index,'status_note',e.target.value)} placeholder={REASON_PLACEHOLDER[member.attendance_status]}/></label>}</div>
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

function ViewModal({row,onClose,onProfile,onOpenImage,onEdit,onDelete,onCopy,onReview}){
  const [note,setNote]=useState(row.review_note||'')
  const counts=Object.fromEntries(Object.keys(ATTENDANCE).map(key=>[key,(row.members||[]).filter(m=>m.attendance_status===key).length]))
  return <div className="ot-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div className="ot-modal ot-view">
    <header><div><span>ONLINE TRAINING REPORT</span><h2>{row.title}</h2></div><button onClick={onClose}>×</button></header>
    <div className="ot-modal-scroll">
      <div className="ot-view-head"><div className="date"><span>{dateText(row.report_date)}</span><strong>{row.platform||'未填写平台'} · {row.shift_name||'未填写班次'}</strong></div><div><span>提交人</span><strong>{row.author_name||'后台用户'}</strong><small>{row.author_employee_no||'后台账号'} · {timeText(row.created_at)}</small></div></div>
      <div className="ot-view-meta"><span>负责人：{row.leader_name||'—'}</span><span>培训：{row.trainer_name||'—'}</span><span>课程：{row.course_type||'—'}</span><span>人员：{row.members?.length||0}人</span></div>
      <div className="ot-counts large"><b>排班记录</b><span>正常 {counts.normal||0}</span><span>公休 {counts.rest||0}</span><span>请假 {counts.leave||0}</span><span className={counts.absent?'danger':''}>缺席 {counts.absent||0}</span><span>回家 {counts.transferred||0}</span></div>
      {(row.report_summary||row.issues_summary||row.next_plan)&&<section className="ot-summary-box">{row.report_summary&&<div><b>整体培训总结</b><p>{row.report_summary}</p></div>}{row.issues_summary&&<div><b>共同问题</b><p>{row.issues_summary}</p></div>}{row.next_plan&&<div><b>下一步安排</b><p>{row.next_plan}</p></div>}</section>}
      <div className="ot-member-view-list">{(row.members||[]).map((member,index)=><MemberView key={member.id||member.employee_id} member={member} index={index} onProfile={onProfile}/>)}</div>
      <AttachmentGrid items={row.attachments} onOpen={onOpenImage}/>
      {(row.review_note||row.review_status!=='pending')&&<div className={`ot-review-note ${row.review_status}`}><strong>{REVIEW[row.review_status]}</strong><p>{row.review_note||'已查看，无补充批注。'}</p></div>}
      {row.can_review&&<div className="ot-review-box"><label>组长 / 主管批注<textarea rows="2" value={note} onChange={e=>setNote(e.target.value)} placeholder="可填写需补充内容；仅查看可直接标记已阅"/></label><div><button onClick={()=>onReview('read',note)}>标记已阅</button><button className="warn" onClick={()=>onReview('needs_changes',note)}>需要补充</button></div></div>}
    </div>
    <footer className="ot-modal-actions"><button onClick={onCopy}>复制 Telegram 格式</button>{row.can_edit&&<button onClick={onEdit}>编辑</button>}{row.can_edit&&<button className="danger" onClick={onDelete}>删除</button>}<button className="primary" onClick={onClose}>关闭</button></footer>
  </div></div>
}

function MemberView({member,index,onProfile}){
  const status=ATTENDANCE[member.attendance_status]||ATTENDANCE.normal
  return <article className="ot-member-view"><header><button onClick={()=>onProfile(member.employee_id)}><span>{index+1}</span><div><strong>{member.employee_no} · {member.employee_name}</strong><small>{member.position_name||'—'} · {member.team_name||'—'} · {member.shift_name||'—'}</small></div></button><em className={status.tone}>{status.label}</em></header>
    {member.status_note&&<div className="status-note"><b>原因</b><p>{member.status_note}</p></div>}
    {member.attendance_status==='normal'&&<div className="ot-member-detail-grid">{member.work_details&&<div><b>今日工作</b><p>{member.work_details}</p></div>}{member.performance&&<div><b>工作表现</b><p>{member.performance}</p></div>}{member.issues&&<div><b>发现问题</b><p>{member.issues}</p></div>}{member.follow_up&&<div><b>后续安排</b><p>{member.follow_up}</p></div>}{text(member.metrics?.response_time)&&<div className="wide"><b>岗位数据 / 首次响应</b><p>{member.metrics.response_time}</p></div>}</div>}
  </article>
}

function ProfileDrawer({state,onClose}){
  const p=state.data||{}
  const rows=[['员工ID',p.employee_no],['姓名',p.full_name],['状态',p.status==='active'?'在职':p.status],['国家',p.country],['员工类型',p.employment_type],['入职日期',p.hire_date],['团队',p.team],['组别',p.group],['岗位',p.position],['班次',p.shift],['盘口',p.platform],['负责人',p.responsible],['线上组长',p.online_leader],['线上培训',p.online_trainer],['工作内容',p.work_content]]
  return <div className="ot-backdrop drawer-mask" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><aside className="ot-profile-drawer"><header><div><span>{text(p.full_name).slice(0,1).toUpperCase()||'人'}</span><div><small>安全员工档案</small><h2>{p.full_name||'读取中…'}</h2><b>{p.employee_no||'—'}</b></div></div><button onClick={onClose}>×</button></header>
    {state.loading?<div className="ot-drawer-state">正在读取员工基础档案…</div>:state.error?<div className="ot-drawer-state error">{state.error}</div>:<><div className="ot-sensitive-note"><strong>敏感资料已隐藏</strong><span>此处不会返回工资、收款账户、联系方式、地址或后台账号。</span></div><div className="ot-profile-rows">{rows.map(([label,value])=><div key={label}><span>{label}</span><strong>{text(value)||'—'}</strong></div>)}</div></>}
  </aside></div>
}

function HistoryModal({state,onClose,onView,onProfile}){
  const person=state.person||{}
  return <div className="ot-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div className="ot-modal ot-history"><header><div><span>EMPLOYEE TRAINING HISTORY</span><h2>{person.employee_no} · {person.employee_name}</h2></div><button onClick={onClose}>×</button></header><div className="ot-modal-scroll">
    <div className="ot-history-profile"><div><strong>{person.position_name||'未填写岗位'} · {person.team_name||'未填写团队'} · {person.shift_name||'未填写班次'}</strong><span>每一天的培训情况独立成条，点击即可查看当日日报与截图。</span></div><div><b>{state.loading?'读取中':`${state.rows.length} 份记录`}</b><button onClick={()=>onProfile(person.employee_id)}>查看安全员工档案</button></div></div>
    {state.loading?<div className="ot-drawer-state">正在读取全部每天记录…</div>:state.error?<div className="ot-drawer-state error">{state.error}</div>:!state.rows.length?<div className="ot-empty small"><h3>暂无记录</h3></div>:<div className="ot-history-list">{state.rows.map(row=>{const member=(row.members||[]).find(m=>m.employee_id===person.employee_id)||row.members?.[0];const status=ATTENDANCE[member?.attendance_status]||ATTENDANCE.normal;return <article key={row.id}><div className="day"><strong>{dateText(row.report_date)}</strong><span>{row.shift_name||'—'} · {row.platform||'—'}</span></div><em className={status.tone}>{status.label}</em><div className="summary"><b>{member?.attendance_status==='normal'?'当日工作 / 培训评语':'状态说明'}</b><p>{member?.work_details||member?.status_note||'已记录当天情况'}</p><small>线上培训：{row.trainer_name||row.author_name||'—'} · 提交：{timeText(row.created_at)} · {row.attachments?.length||0} 张截图</small></div><button onClick={()=>onView(row)}>查看完整日报</button></article>})}</div>}
  </div><footer className="ot-modal-actions"><button className="primary" onClick={onClose}>关闭</button></footer></div></div>
}

function ConfirmModal({saving,title,onCancel,onConfirm}){
  return <div className="ot-backdrop"><div className="ot-confirm"><span>删</span><h3>确定删除这份日报？</h3><p>“{title}”会归档并从正常列表移除，操作日志仍然保留。</p><div><button onClick={onCancel} disabled={saving}>取消</button><button className="danger" onClick={onConfirm} disabled={saving}>{saving?'处理中…':'确认删除'}</button></div></div></div>
}
