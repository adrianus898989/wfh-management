import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Pagination } from '../components/DataPageControls'
import '../styles-daily-work.css'

const BUCKET = 'daily-work'
const PAGE_SIZE = 12
const TABS = [
  { label:'每日工作报告', value:'work', icon:'工', color:'blue' },
  { label:'线上培训报告', value:'training', icon:'培', color:'violet' },
  { label:'交接记录', value:'handover', icon:'交', color:'amber' },
]
const TYPE_MAP = Object.fromEntries(TABS.map(item => [item.value, item]))
const STATUS_MAP = {
  pending:['待跟进','amber'],
  in_progress:['跟进中','blue'],
  done:['已完成','green'],
}

const text = value => String(value ?? '').trim()
const today = () => {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
const dateText = value => value ? new Date(value + 'T00:00:00').toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' }) : '—'
const timeText = value => value ? new Date(value).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—'
const sameTime = (a,b) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 1500
const cleanAttachment = item => ({
  path:text(item?.path),
  name:text(item?.name),
  size:Number(item?.size || 0),
  type:text(item?.type),
})
const safeFileName = name => text(name).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'screenshot'

const blankDraft = type => ({
  report_type:type,
  report_date:today(),
  report_end_date:'',
  title:'',
  platform:'',
  shift_name:'',
  team_name:'',
  team_leader:'',
  trainer_name:'',
  course_type:'',
  staff_list:'',
  work_summary:'',
  employee_updates:'',
  response_metrics:'',
  handover_notes:'',
  issues:'',
  next_plan:'',
  handover_status:'pending',
  attachments:[],
})

function reportDraft(row) {
  const draft = blankDraft(row.report_type)
  for (const key of Object.keys(draft)) {
    if (key === 'attachments') draft.attachments = (row.attachments || []).map(cleanAttachment)
    else if (row[key] != null) draft[key] = row[key]
  }
  return draft
}

function MetaChip({ children }) {
  if (!text(children)) return null
  return <span className="dw-meta-chip">{children}</span>
}

function TextBlock({ title, value, accent }) {
  if (!text(value)) return null
  return <section className={'dw-detail-block ' + (accent || '')}>
    <h4>{title}</h4>
    <div>{value}</div>
  </section>
}

function AttachmentGrid({ attachments, onOpen, compact=false }) {
  if (!attachments?.length) return null
  return <div className={'dw-attachment-grid ' + (compact ? 'compact' : '')}>
    {attachments.map((item,index)=><button type="button" key={item.path || index} onClick={()=>onOpen(item)}>
      {item.url ? <img src={item.url} alt={item.name || '报告截图'}/> : <span>图片读取失败</span>}
      {!compact && <em>{item.name || '截图 ' + (index + 1)}</em>}
    </button>)}
  </div>
}

export default function AdminDailyWorkPage() {
  const [searchParams,setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const tab = TABS.find(item => item.label === requestedTab) || TABS[0]
  const [rows,setRows] = useState([])
  const [access,setAccess] = useState({ userId:'', canSubmit:false, canManage:false })
  const [loading,setLoading] = useState(true)
  const [refreshing,setRefreshing] = useState(false)
  const [saving,setSaving] = useState(false)
  const [error,setError] = useState('')
  const [filters,setFilters] = useState({ q:'', from:'', to:'', author:'' })
  const [page,setPage] = useState(1)
  const [modal,setModal] = useState(null)
  const [pendingFiles,setPendingFiles] = useState([])
  const [deleteTarget,setDeleteTarget] = useState(null)
  const [lightbox,setLightbox] = useState(null)

  const hydrateAttachments = async records => {
    const paths = [...new Set(records.flatMap(row => (row.attachments || []).map(item => text(item.path))).filter(Boolean))]
    if (!paths.length) return records
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)
    const urlMap = new Map((data || []).map(item => [item.path,item.signedUrl]))
    return records.map(row => ({
      ...row,
      attachments:(row.attachments || []).map(item => ({ ...cleanAttachment(item), url:urlMap.get(item.path) || '' })),
    }))
  }

  const loadRows = async (silent=false) => {
    if (silent) setRefreshing(true)
    else setLoading(true)
    try {
      const { data,error:loadError } = await supabase
        .from('daily_work_reports')
        .select('*')
        .order('report_date',{ ascending:false })
        .order('created_at',{ ascending:false })
        .limit(1000)
      if (loadError) throw loadError
      setRows(await hydrateAttachments(data || []))
      setError('')
    } catch (err) {
      setError(err.message || '每日工作记录读取失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(()=>{
    let alive = true
    ;(async()=>{
      try {
        const { data:{ user } } = await supabase.auth.getUser()
        if (!user) throw new Error('登录已失效')
        const [submitResult,manageResult] = await Promise.all([
          supabase.rpc('has_permission',{ p_permission_code:'daily_work.submit' }),
          supabase.rpc('has_permission',{ p_permission_code:'daily_work.manage' }),
        ])
        if (alive) setAccess({
          userId:user.id,
          canSubmit:submitResult.data === true,
          canManage:manageResult.data === true,
        })
        await loadRows()
      } catch (err) {
        if (alive) {
          setError(err.message || '每日工作模块初始化失败')
          setLoading(false)
        }
      }
    })()
    return()=>{ alive=false }
  },[])

  useEffect(()=>setPage(1),[requestedTab,filters.q,filters.from,filters.to,filters.author])
  useEffect(()=>{
    const locked = Boolean(modal || deleteTarget || lightbox)
    if (!locked) return
    const old = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return()=>{ document.body.style.overflow = old }
  },[modal,deleteTarget,lightbox])

  const authors = useMemo(()=>[...new Set(rows.map(row=>row.author_name).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN')),[rows])
  const filtered = useMemo(()=>{
    const q = filters.q.toLowerCase().trim()
    return rows.filter(row => {
      if (row.report_type !== tab.value) return false
      if (filters.from && row.report_date < filters.from) return false
      if (filters.to && row.report_date > filters.to) return false
      if (filters.author && row.author_name !== filters.author) return false
      if (!q) return true
      return [
        row.title,row.author_name,row.author_employee_no,row.platform,row.shift_name,row.team_name,
        row.team_leader,row.trainer_name,row.course_type,row.staff_list,row.work_summary,
        row.employee_updates,row.response_metrics,row.handover_notes,row.issues,row.next_plan,
      ].some(value=>text(value).toLowerCase().includes(q))
    })
  },[rows,tab.value,filters])

  const pages = Math.max(1,Math.ceil(filtered.length / PAGE_SIZE))
  const slice = filtered.slice((page - 1) * PAGE_SIZE,page * PAGE_SIZE)
  const todayKey = today()
  const summary = useMemo(()=>({
    today:rows.filter(row=>row.report_date===todayKey).length,
    work:rows.filter(row=>row.report_type==='work').length,
    training:rows.filter(row=>row.report_type==='training').length,
    handover:rows.filter(row=>row.report_type==='handover').length,
  }),[rows,todayKey])

  const changeTab = item => {
    setSearchParams(item === TABS[0] ? {} : { tab:item.label },{ replace:true })
  }

  const releasePending = items => {
    for (const item of items) URL.revokeObjectURL(item.preview)
  }

  const closeEditor = () => {
    releasePending(pendingFiles)
    setPendingFiles([])
    setModal(null)
  }

  const openCreate = () => {
    if (!access.canSubmit) {
      setError('当前账号没有“每日工作 · 提交记录”权限')
      return
    }
    setPendingFiles([])
    setModal({ mode:'edit', original:null, draft:blankDraft(tab.value) })
  }

  const canEdit = row => row.created_by === access.userId || access.canManage

  const openEdit = row => {
    if (!canEdit(row)) return
    setPendingFiles([])
    setModal({ mode:'edit', original:row, draft:reportDraft(row) })
  }

  const updateDraft = (key,value) => setModal(current=>({
    ...current,
    draft:{ ...current.draft,[key]:value },
  }))

  const addFiles = event => {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    if (!files.length) return
    const slots = 12 - (modal?.draft?.attachments?.length || 0) - pendingFiles.length
    if (slots <= 0) {
      setError('每份报告最多上传 12 张截图')
      return
    }
    const accepted = []
    for (const file of files.slice(0,slots)) {
      if (!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)) {
        setError('只支持 JPG、PNG、WEBP 或 GIF 图片')
        continue
      }
      if (file.size > 10 * 1024 * 1024) {
        setError(file.name + ' 超过 10MB')
        continue
      }
      accepted.push({ file,preview:URL.createObjectURL(file) })
    }
    setPendingFiles(current=>[...current,...accepted])
  }

  const removePending = index => {
    setPendingFiles(current=>{
      const next = [...current]
      const [removed] = next.splice(index,1)
      if (removed) URL.revokeObjectURL(removed.preview)
      return next
    })
  }

  const removeExisting = path => {
    updateDraft('attachments',modal.draft.attachments.filter(item=>item.path!==path))
  }

  const validateDraft = draft => {
    if (text(draft.title).length < 2) return '请填写报告标题'
    if (draft.report_end_date && draft.report_end_date < draft.report_date) return '结束日期不能早于开始日期'
    if (![draft.work_summary,draft.employee_updates,draft.handover_notes].some(value=>text(value))) {
      return '请至少填写工作情况、员工情况或交接内容'
    }
    return ''
  }

  const saveReport = async () => {
    const draft = modal.draft
    const validation = validateDraft(draft)
    if (validation) {
      setError(validation)
      return
    }
    setSaving(true)
    setError('')
    const uploaded = []
    try {
      for (const item of pendingFiles) {
        const path = access.userId + '/' + draft.report_date + '/' + crypto.randomUUID() + '-' + safeFileName(item.file.name)
        const { error:uploadError } = await supabase.storage.from(BUCKET).upload(path,item.file,{
          cacheControl:'3600',
          upsert:false,
          contentType:item.file.type,
        })
        if (uploadError) throw uploadError
        uploaded.push({ path,name:item.file.name,size:item.file.size,type:item.file.type })
      }

      const kept = (draft.attachments || []).map(cleanAttachment)
      const payload = {
        report_type:draft.report_type,
        report_date:draft.report_date,
        report_end_date:draft.report_end_date || null,
        title:text(draft.title),
        platform:text(draft.platform),
        shift_name:text(draft.shift_name),
        team_name:text(draft.team_name),
        team_leader:text(draft.team_leader),
        trainer_name:text(draft.trainer_name),
        course_type:text(draft.course_type),
        staff_list:text(draft.staff_list),
        work_summary:text(draft.work_summary),
        employee_updates:text(draft.employee_updates),
        response_metrics:text(draft.response_metrics),
        handover_notes:text(draft.handover_notes),
        issues:text(draft.issues),
        next_plan:text(draft.next_plan),
        handover_status:draft.handover_status,
        attachments:[...kept,...uploaded],
      }

      const request = modal.original
        ? supabase.from('daily_work_reports').update(payload).eq('id',modal.original.id).select().single()
        : supabase.from('daily_work_reports').insert(payload).select().single()
      const { error:saveError } = await request
      if (saveError) throw saveError

      if (modal.original) {
        const keptPaths = new Set(kept.map(item=>item.path))
        const removed = (modal.original.attachments || []).map(item=>item.path).filter(path=>path && !keptPaths.has(path))
        if (removed.length) await supabase.storage.from(BUCKET).remove(removed)
      }

      closeEditor()
      await loadRows(true)
    } catch (err) {
      if (uploaded.length) await supabase.storage.from(BUCKET).remove(uploaded.map(item=>item.path))
      setError(err.message || '报告保存失败')
    } finally {
      setSaving(false)
    }
  }

  const deleteReport = async () => {
    if (!deleteTarget) return
    setSaving(true)
    try {
      const paths = (deleteTarget.attachments || []).map(item=>item.path).filter(Boolean)
      const { error:deleteError } = await supabase.from('daily_work_reports').delete().eq('id',deleteTarget.id)
      if (deleteError) throw deleteError
      if (paths.length) await supabase.storage.from(BUCKET).remove(paths)
      setDeleteTarget(null)
      await loadRows(true)
    } catch (err) {
      setError(err.message || '报告删除失败')
    } finally {
      setSaving(false)
    }
  }

  return <div className="content-page dw-page">
    <header className="dw-header">
      <div>
        <div className="module-kicker">DAILY WORKSPACE</div>
        <h1>每日工作</h1>
        <p>负责人、组长与线上培训在系统提交每日工作、培训情况和交接记录。</p>
      </div>
      <div className="dw-header-actions">
        <span className={'dw-access-pill ' + (access.canSubmit ? 'ok' : 'read')}>
          {access.canSubmit ? '可提交报告' : '仅查看'}
        </span>
        <button className="dw-refresh" onClick={()=>loadRows(true)} disabled={refreshing}>{refreshing?'刷新中…':'刷新'}</button>
        {access.canSubmit && <button className="dw-primary" onClick={openCreate}>＋ 提交报告</button>}
      </div>
    </header>

    {error && <div className="dw-error"><span>{error}</span><button onClick={()=>setError('')}>×</button></div>}

    <section className="dw-summary-grid">
      <div><span>今日提交</span><strong>{summary.today}</strong><em>份报告</em></div>
      <div><span>工作报告</span><strong>{summary.work}</strong><em>累计记录</em></div>
      <div><span>线上培训</span><strong>{summary.training}</strong><em>累计记录</em></div>
      <div><span>交接记录</span><strong>{summary.handover}</strong><em>累计记录</em></div>
    </section>

    <nav className="dw-tabs" aria-label="每日工作子页面">
      {TABS.map(item=><button key={item.value} className={tab.value===item.value?'active':''} onClick={()=>changeTab(item)}>
        <span className={'dw-tab-icon ' + item.color}>{item.icon}</span>
        <span>{item.label}</span>
        <em>{rows.filter(row=>row.report_type===item.value).length}</em>
      </button>)}
    </nav>

    <section className="dw-filter-card">
      <div className="dw-search"><span>⌕</span><input value={filters.q} onChange={event=>setFilters({...filters,q:event.target.value})} placeholder="搜索标题、提交人、盘口、员工或工作内容"/></div>
      <label>日期起<input type="date" value={filters.from} onChange={event=>setFilters({...filters,from:event.target.value})}/></label>
      <label>日期止<input type="date" value={filters.to} onChange={event=>setFilters({...filters,to:event.target.value})}/></label>
      <select value={filters.author} onChange={event=>setFilters({...filters,author:event.target.value})}>
        <option value="">全部提交人</option>
        {authors.map(author=><option value={author} key={author}>{author}</option>)}
      </select>
      <button onClick={()=>setFilters({ q:'',from:'',to:'',author:'' })}>重置</button>
    </section>

    <div className="dw-list-head">
      <div><h2>{tab.label}</h2><p>所有后台成员均可查看；提交人管理自己的记录，获授权人员可管理全部记录。</p></div>
      <strong>{filtered.length} 条</strong>
    </div>

    {loading ? <div className="dw-loading"><i/><span>正在读取每日工作记录…</span></div> :
      slice.length ? <section className="dw-report-grid">
        {slice.map(row=>{
          const type = TYPE_MAP[row.report_type] || TYPE_MAP.work
          const status = STATUS_MAP[row.handover_status] || STATUS_MAP.pending
          return <article className="dw-report-card" key={row.id}>
            <div className="dw-card-top">
              <div className={'dw-type-mark ' + type.color}><span>{type.icon}</span><div><b>{type.label}</b><small>{dateText(row.report_date)}{row.report_end_date?' — '+dateText(row.report_end_date):''}</small></div></div>
              {row.report_type==='handover'&&<span className={'dw-status ' + status[1]}>{status[0]}</span>}
            </div>
            <h3>{row.title}</h3>
            <div className="dw-author"><span>{text(row.author_name).slice(0,1).toUpperCase() || 'W'}</span><div><b>{row.author_name || '后台用户'}</b><small>{row.author_employee_no || '后台账号'} · {timeText(row.created_at)}</small></div></div>
            <div className="dw-meta-row">
              <MetaChip>{row.platform}</MetaChip><MetaChip>{row.shift_name}</MetaChip><MetaChip>{row.team_name}</MetaChip>
            </div>
            <div className="dw-card-summary">{row.work_summary || row.employee_updates || row.handover_notes}</div>
            <AttachmentGrid attachments={(row.attachments || []).slice(0,4)} compact onOpen={setLightbox}/>
            <div className="dw-card-foot">
              <span>{!sameTime(row.created_at,row.updated_at)?'已编辑 '+timeText(row.updated_at):'已提交'}</span>
              <div>
                <button onClick={()=>setModal({ mode:'view',record:row })}>查看</button>
                {canEdit(row)&&<button onClick={()=>openEdit(row)}>编辑</button>}
                {canEdit(row)&&<button className="danger" onClick={()=>setDeleteTarget(row)}>删除</button>}
              </div>
            </div>
          </article>
        })}
      </section> : <div className="dw-empty">
        <span>{tab.icon}</span><h3>暂时没有{tab.label}</h3>
        <p>提交后，所有后台成员都可以在这里查看完整记录。</p>
        {access.canSubmit&&<button className="dw-primary" onClick={openCreate}>提交第一份报告</button>}
      </div>
    }

    {!loading&&filtered.length>0&&<Pagination page={page} pages={pages} total={filtered.length} pageSize={PAGE_SIZE} onPage={setPage}/>}

    {modal?.mode==='view'&&<div className="dw-modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setModal(null)}}>
      <div className="dw-modal dw-view-modal">
        <div className="dw-modal-head">
          <div><span className={'dw-type-badge '+(TYPE_MAP[modal.record.report_type]?.color||'blue')}>{TYPE_MAP[modal.record.report_type]?.label}</span><h2>{modal.record.title}</h2></div>
          <button className="dw-close" onClick={()=>setModal(null)}>×</button>
        </div>
        <div className="dw-view-byline">
          <div className="dw-author"><span>{text(modal.record.author_name).slice(0,1).toUpperCase()||'W'}</span><div><b>{modal.record.author_name}</b><small>{modal.record.author_employee_no||'后台账号'}</small></div></div>
          <div><b>{dateText(modal.record.report_date)}{modal.record.report_end_date?' — '+dateText(modal.record.report_end_date):''}</b><small>提交于 {timeText(modal.record.created_at)}</small></div>
        </div>
        <div className="dw-view-meta">
          {modal.record.platform&&<MetaChip>{'盘口：'+modal.record.platform}</MetaChip>}
          {modal.record.shift_name&&<MetaChip>{'班次：'+modal.record.shift_name}</MetaChip>}
          {modal.record.team_name&&<MetaChip>{'团队：'+modal.record.team_name}</MetaChip>}
          {modal.record.team_leader&&<MetaChip>{'负责人：'+modal.record.team_leader}</MetaChip>}
          {modal.record.trainer_name&&<MetaChip>{'培训：'+modal.record.trainer_name}</MetaChip>}
          {modal.record.course_type&&<MetaChip>{'课程：'+modal.record.course_type}</MetaChip>}
        </div>
        <div className="dw-detail-scroll">
          <TextBlock title="人员名单" value={modal.record.staff_list}/>
          <TextBlock title={modal.record.report_type==='handover'?'交接概况':'今日工作情况'} value={modal.record.work_summary} accent="primary"/>
          <TextBlock title="员工工作 / 培训情况" value={modal.record.employee_updates}/>
          <TextBlock title="响应时间 / 数据" value={modal.record.response_metrics}/>
          <TextBlock title="交接内容" value={modal.record.handover_notes} accent="handover"/>
          <TextBlock title="问题与风险" value={modal.record.issues} accent="danger"/>
          <TextBlock title="后续计划" value={modal.record.next_plan}/>
          {!!modal.record.attachments?.length&&<section className="dw-detail-block"><h4>报告截图 · {modal.record.attachments.length} 张</h4><AttachmentGrid attachments={modal.record.attachments} onOpen={setLightbox}/></section>}
        </div>
        <div className="dw-modal-actions">
          <button onClick={()=>setModal(null)}>关闭</button>
          {canEdit(modal.record)&&<button className="dw-primary" onClick={()=>openEdit(modal.record)}>编辑报告</button>}
        </div>
      </div>
    </div>}

    {modal?.mode==='edit'&&<div className="dw-modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!saving)closeEditor()}}>
      <div className="dw-modal dw-editor-modal">
        <div className="dw-modal-head">
          <div><span>{modal.original?'编辑记录':'新建记录'}</span><h2>{modal.original?'编辑'+TYPE_MAP[modal.draft.report_type].label:'提交每日工作'}</h2></div>
          <button className="dw-close" onClick={closeEditor} disabled={saving}>×</button>
        </div>
        <div className="dw-editor-scroll">
          <div className="dw-type-switch">
            {TABS.map(item=><button type="button" key={item.value} className={modal.draft.report_type===item.value?'active '+item.color:''} onClick={()=>updateDraft('report_type',item.value)}><span>{item.icon}</span>{item.label}</button>)}
          </div>
          <div className="dw-form-grid">
            <label className="wide"><span>报告标题 *</span><input value={modal.draft.title} maxLength={160} onChange={event=>updateDraft('title',event.target.value)} placeholder="例如：AR 夜班客服团队每日工作报告"/></label>
            <label><span>日期起 *</span><input type="date" value={modal.draft.report_date} onChange={event=>updateDraft('report_date',event.target.value)}/></label>
            <label><span>日期止</span><input type="date" value={modal.draft.report_end_date||''} onChange={event=>updateDraft('report_end_date',event.target.value)}/></label>
            <label><span>盘口 / 平台</span><input value={modal.draft.platform} onChange={event=>updateDraft('platform',event.target.value)} placeholder="例如：55five / MZPLAY"/></label>
            <label><span>班次</span><input value={modal.draft.shift_name} onChange={event=>updateDraft('shift_name',event.target.value)} placeholder="例如：夜班 20:00–08:00"/></label>
            <label><span>团队 / 组别</span><input value={modal.draft.team_name} onChange={event=>updateDraft('team_name',event.target.value)} placeholder="例如：AR 印度"/></label>
            <label><span>课程类型</span><input value={modal.draft.course_type} onChange={event=>updateDraft('course_type',event.target.value)} placeholder="例如：轮盘课程"/></label>
            <label><span>团队负责人</span><input value={modal.draft.team_leader} onChange={event=>updateDraft('team_leader',event.target.value)} placeholder="负责人姓名"/></label>
            <label><span>线上培训</span><input value={modal.draft.trainer_name} onChange={event=>updateDraft('trainer_name',event.target.value)} placeholder="培训人员姓名"/></label>
            {modal.draft.report_type==='handover'&&<label><span>交接状态</span><select value={modal.draft.handover_status} onChange={event=>updateDraft('handover_status',event.target.value)}><option value="pending">待跟进</option><option value="in_progress">跟进中</option><option value="done">已完成</option></select></label>}
            <label className="wide"><span>人员名单</span><textarea rows="3" value={modal.draft.staff_list} onChange={event=>updateDraft('staff_list',event.target.value)} placeholder="可填写员工ID、姓名；每人一行"/></label>
            <label className="wide"><span>{modal.draft.report_type==='handover'?'交接概况 *':'今日工作情况 *'}</span><textarea rows="5" value={modal.draft.work_summary} onChange={event=>updateDraft('work_summary',event.target.value)} placeholder="填写当天整体工作、完成事项和团队情况"/></label>
            {modal.draft.report_type!=='handover'&&<label className="wide"><span>员工工作 / 培训情况</span><textarea rows="7" value={modal.draft.employee_updates} onChange={event=>updateDraft('employee_updates',event.target.value)} placeholder="可按 Telegram 原格式逐人填写：员工ID、姓名、今日表现和需要跟进的问题"/></label>}
            {modal.draft.report_type!=='handover'&&<label className="wide"><span>响应时间 / 数据</span><textarea rows="3" value={modal.draft.response_metrics} onChange={event=>updateDraft('response_metrics',event.target.value)} placeholder="例如：KKVIP 19s、FF555 12s"/></label>}
            <label className="wide"><span>交接内容</span><textarea rows="4" value={modal.draft.handover_notes} onChange={event=>updateDraft('handover_notes',event.target.value)} placeholder="需要下一班、负责人或其他同事继续处理的事项"/></label>
            <label className="wide"><span>问题与风险</span><textarea rows="3" value={modal.draft.issues} onChange={event=>updateDraft('issues',event.target.value)} placeholder="异常、员工问题、待处理风险"/></label>
            <label className="wide"><span>后续计划</span><textarea rows="3" value={modal.draft.next_plan} onChange={event=>updateDraft('next_plan',event.target.value)} placeholder="下一步计划或明日安排"/></label>
          </div>
          <section className="dw-upload-panel">
            <div><h3>报告截图</h3><p>支持 JPG、PNG、WEBP、GIF；每张最多 10MB，每份报告最多 12 张。</p></div>
            <label className="dw-upload-button"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={addFiles}/>＋ 选择截图</label>
          </section>
          {(modal.draft.attachments.length>0||pendingFiles.length>0)&&<div className="dw-upload-preview">
            {modal.draft.attachments.map(item=><div key={item.path}><span>已上传</span><b>{item.name||'报告截图'}</b><button type="button" onClick={()=>removeExisting(item.path)}>移除</button></div>)}
            {pendingFiles.map((item,index)=><div className="new" key={item.preview}><img src={item.preview} alt={item.file.name}/><b>{item.file.name}</b><button type="button" onClick={()=>removePending(index)}>移除</button></div>)}
          </div>}
        </div>
        <div className="dw-modal-actions">
          <button onClick={closeEditor} disabled={saving}>取消</button>
          <button className="dw-primary" onClick={saveReport} disabled={saving}>{saving?'保存中…':modal.original?'保存修改':'提交报告'}</button>
        </div>
      </div>
    </div>}

    {deleteTarget&&<div className="dw-modal-backdrop">
      <div className="dw-confirm">
        <span>删</span><h3>确定删除这份记录？</h3><p>“{deleteTarget.title}”删除后无法恢复，相关截图也会一并移除。</p>
        <div><button onClick={()=>setDeleteTarget(null)} disabled={saving}>取消</button><button className="danger" onClick={deleteReport} disabled={saving}>{saving?'删除中…':'确认删除'}</button></div>
      </div>
    </div>}

    {lightbox&&<div className="dw-lightbox" onClick={()=>setLightbox(null)}>
      <button onClick={()=>setLightbox(null)}>×</button>
      <img src={lightbox.url} alt={lightbox.name||'报告截图'}/>
      <span>{lightbox.name||'报告截图'}</span>
    </div>}
  </div>
}
