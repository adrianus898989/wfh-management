import React,{useEffect,useRef,useState} from 'react'
import AdminModuleNav from '../components/AdminModuleNav'
import { useAppToast } from '../components/AppToastProvider'
import { writeFailureToast } from '../lib/appMutationToast'
import {supabase} from '../lib/supabase'
import {
  ACTIVITY_LOG_ACTION_OPTIONS,
  ACTIVITY_LOG_MODULE_OPTIONS,
  activityActionLabel,
  activityCategoryLabel,
  activityModuleLabel,
  activitySourceLabel,
  buildActivityLogRpcParams,
  formatActivityTime,
} from '../lib/adminActivityLogPresentation'
import '../styles-admin-activity-log.css'

const localIsoDate=date=>{
  const year=date.getFullYear()
  const month=String(date.getMonth()+1).padStart(2,'0')
  const day=String(date.getDate()).padStart(2,'0')
  return `${year}-${month}-${day}`
}
const today=new Date()
const thirtyDaysAgo=new Date(today)
thirtyDaysAgo.setDate(today.getDate()-29)
const DEFAULT_FILTERS=Object.freeze({
  dateFrom:localIsoDate(thirtyDaysAgo),dateTo:localIsoDate(today),
  actor:'',module:'',action:'',object:'',
})

const errorMessage=error=>{
  const message=String(error?.message||error||'')
  if(message.includes('session_not_current'))return '当前后台会话已失效，请重新登录后再试。'
  if(message.includes('permission_denied'))return '当前账号没有查看后台操作日志的权限。'
  if(message.includes('invalid_date_range'))return '开始日期不能晚于结束日期。'
  return '后台操作日志读取失败，请稍后重试。'
}

export default function AdminActivityLogPage(){
  const {notify}=useAppToast()
  const requestRef=useRef(0)
  const readIntentRef=useRef('')
  const [draft,setDraft]=useState({...DEFAULT_FILTERS})
  const [applied,setApplied]=useState({...DEFAULT_FILTERS})
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(20)
  const [refreshKey,setRefreshKey]=useState(0)
  const [state,setState]=useState({loading:true,error:'',rows:[],total:0,pages:1})

  useEffect(()=>{
    const requestId=++requestRef.current
    const requestedOperation=readIntentRef.current
    readIntentRef.current=''
    setState(current=>({...current,loading:true,error:''}))
    ;(async()=>{
      const {data,error}=await supabase.rpc('admin_activity_log_search',buildActivityLogRpcParams(applied,page,pageSize))
      if(error)throw error
      if(requestId!==requestRef.current)return
      setState({
        loading:false,
        error:'',
        rows:Array.isArray(data?.rows)?data.rows:[],
        total:Number(data?.total||0),
        pages:Math.max(1,Number(data?.pages||1)),
      })
    })().catch(error=>{
      if(requestId!==requestRef.current)return
      const reason=errorMessage(error)
      setState({loading:false,error:reason,rows:[],total:0,pages:1})
      if(requestedOperation)notify(writeFailureToast({
        module:'后台操作日志',operation:requestedOperation,error,reason,
        dedupeKey:`activity-log:${requestedOperation}:error`,
        refresh:()=>{readIntentRef.current=requestedOperation;setRefreshKey(value=>value+1)},
      }))
    })
    return()=>{requestRef.current+=1}
  },[applied,page,pageSize,refreshKey])

  const update=(key,value)=>setDraft(current=>({...current,[key]:value}))
  const search=event=>{
    event.preventDefault()
    readIntentRef.current='查询操作日志'
    setPage(1)
    setApplied({...draft})
  }
  const reset=()=>{
    readIntentRef.current='重置操作日志查询'
    const defaults={...DEFAULT_FILTERS}
    setDraft(defaults)
    setApplied(defaults)
    setPage(1)
  }
  const refresh=()=>{readIntentRef.current='刷新操作日志';setRefreshKey(value=>value+1)}
  const changePage=next=>{readIntentRef.current='切换操作日志分页';setPage(next)}
  const changePageSize=next=>{readIntentRef.current='调整操作日志每页条数';setPageSize(next);setPage(1)}
  const from=state.total?(page-1)*pageSize+1:0
  const to=Math.min(state.total,page*pageSize)

  return <div className="admin-activity-log-page">
    <header className="admin-activity-log-hero">
      <div><span>ADMIN ACTIVITY LOG</span><h1>后台操作日志</h1><p>集中查询现有审计记录，快速追查操作人、模块、动作和业务对象。</p></div>
      <button type="button" onClick={refresh} disabled={state.loading}>{state.loading?'刷新中…':'刷新记录'}</button>
    </header>

    <AdminModuleNav/>

    <section className="admin-activity-log-notice">
      <strong>记录范围</strong>
      <p>本页默认读取最近 30 天，并合并通用业务审计、员工档案审计、工资审计及考勤 / 奖惩人工记录。可清空日期查询更早记录；只显示脱敏摘要，数据库从未记录的历史不会自动补出。</p>
    </section>

    <form className="admin-activity-log-filters" onSubmit={search}>
      <label><span>日期起</span><input type="date" value={draft.dateFrom} max={draft.dateTo||undefined} onChange={event=>update('dateFrom',event.target.value)}/></label>
      <label><span>日期止</span><input type="date" value={draft.dateTo} min={draft.dateFrom||undefined} onChange={event=>update('dateTo',event.target.value)}/></label>
      <label><span>操作人</span><input value={draft.actor} onChange={event=>update('actor',event.target.value)} maxLength={100} placeholder="账号 / 姓名 / 邮箱"/></label>
      <label><span>模块</span><select value={draft.module} onChange={event=>update('module',event.target.value)}>{ACTIVITY_LOG_MODULE_OPTIONS.map(([value,label])=><option value={value} key={value||'all'}>{label}</option>)}</select></label>
      <label><span>动作</span><select value={draft.action} onChange={event=>update('action',event.target.value)}>{ACTIVITY_LOG_ACTION_OPTIONS.map(([value,label])=><option value={value} key={value||'all'}>{label}</option>)}</select></label>
      <label className="admin-activity-log-object"><span>对象搜索</span><input value={draft.object} onChange={event=>update('object',event.target.value)} maxLength={100} placeholder="对象 ID / 员工 ID / 姓名"/></label>
      <div className="admin-activity-log-filter-actions"><button type="submit" disabled={state.loading}>查询</button><button type="button" className="secondary" onClick={reset} disabled={state.loading}>重置</button></div>
    </form>

    <section className="admin-activity-log-results" aria-busy={state.loading}>
      <header><div><h2>操作记录</h2><p>非全部数据范围仅显示本人操作或账号范围内员工 / 团队相关记录。</p></div><strong>{state.total} 条</strong></header>
      {state.error&&<div className="admin-activity-log-state error" role="alert"><strong>读取失败</strong><p>{state.error}</p><button type="button" onClick={refresh}>重试</button></div>}
      {!state.error&&state.loading&&<div className="admin-activity-log-state" aria-live="polite"><strong>正在读取操作日志…</strong><p>正在按当前账号权限和数据范围筛选。</p></div>}
      {!state.error&&!state.loading&&!state.rows.length&&<div className="admin-activity-log-state"><strong>没有匹配记录</strong><p>请调整日期或筛选条件后重试。</p><button type="button" onClick={reset}>恢复最近 30 天</button></div>}
      {!state.error&&!state.loading&&state.rows.length>0&&<>
        <div className="admin-activity-log-table-wrap">
          <table>
            <thead><tr><th>时间</th><th>操作人</th><th>模块</th><th>动作</th><th>分类</th><th>对象 ID / 姓名</th><th>脱敏摘要</th><th>来源</th></tr></thead>
            <tbody>{state.rows.map(row=><tr key={row.id}>
              <td><time dateTime={row.created_at||undefined}>{formatActivityTime(row.created_at)}</time></td>
              <td><strong data-admin-i18n-skip>{row.actor_name||'系统 / 外部同步'}</strong></td>
              <td><span className="admin-activity-log-module">{activityModuleLabel(row.module)}</span></td>
              <td><strong>{activityActionLabel(row.action,row.action_category)}</strong><small data-admin-i18n-skip>{row.action||'—'}</small></td>
              <td><span className={`admin-activity-log-category ${row.action_category||'other'}`}>{activityCategoryLabel(row.action_category)}</span></td>
              <td><strong data-admin-i18n-skip>{row.object_name||'未记录对象名称'}</strong><small data-admin-i18n-skip>{row.object_id||'—'}</small></td>
              <td>{row.summary||'已记录后台操作（不含敏感详情）'}</td>
              <td><span className="admin-activity-log-source">{activitySourceLabel(row.source)}</span></td>
            </tr>)}</tbody>
          </table>
        </div>
        <footer className="admin-activity-log-pagination">
          <span>显示 {from}–{to}，共 {state.total} 条</span>
          <label>每页<select value={pageSize} onChange={event=>changePageSize(Number(event.target.value))}><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></label>
          <div><button type="button" className="secondary" disabled={page<=1} onClick={()=>changePage(Math.max(1,page-1))}>上一页</button><span>第 {page} / {state.pages} 页</span><button type="button" className="secondary" disabled={page>=state.pages} onClick={()=>changePage(Math.min(state.pages,page+1))}>下一页</button></div>
        </footer>
      </>}
    </section>
  </div>
}
