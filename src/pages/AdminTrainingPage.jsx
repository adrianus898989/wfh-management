import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AdminModuleNav from '../components/AdminModuleNav'
import { useAppToast } from '../components/AppToastProvider'
import { adminLocalPageTabs, adminTabParams, adminTabSlug, canonicalAdminTab } from '../config/navigation'
import { PERMISSIONS } from '../config/permissions'
import { useAdminAccess } from '../lib/adminAccess'
import { EmployeeDrawer } from './AdminEmployeesPage'
import { ExamImageGallery } from '../components/ExamImageGallery'
import { edgeFunctionErrorMessage } from '../lib/edgeFunctionError'
import { businessTodayIso } from '../lib/adminQueryDefaults'
import { isCurrentLiveRequest, staleSnapshotNotice } from '../lib/requestConsistency'

const TABS=['考试概览','考试记录','题库','人工批改']
const TRAINING_TOAST_MODULE='考试管理'
const OVERVIEW_RPC_TIMEOUT_MS=8000
const blankQuestion={series_name:'',team_name:'',position_name:'',question_en:'',question_zh:'',question_vi:'',points:5,difficulty:1,image_urls:[],active:true}
const blankSessionFilters={employeeNo:'',employeeName:'',exam:'',team:'',position:'',status:'',grader:'',source:'',dateFrom:'',dateTo:''}
const overviewAnalyticsRpcs=[
  ['admin_exam_overview_analytics_summary',['summary','score_bands','sources']],
  ['admin_exam_overview_analytics_dimensions',['series','positions','teams']],
  ['admin_exam_overview_analytics_activity',['trend','daily_activity']],
  ['admin_exam_overview_analytics_leaderboard',['leaderboard']]
]
const withOverviewAnalytics=(overview,analytics)=>({...overview,analytics:{...(overview?.analytics||{}),...(analytics||{})}})
const plainObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)
const validOverviewHome=value=>plainObject(value)&&typeof value._scope_key==='string'&&value._scope_key.length>0&&plainObject(value.counts)&&plainObject(value.current_counts)&&Array.isArray(value.sessions)&&plainObject(value.last_sync)&&plainObject(value.legacy)&&plainObject(value.legacy.counts)&&Array.isArray(value.legacy.sessions)&&plainObject(value.legacy.sync_state)
const hasKeys=(value,keys)=>plainObject(value)&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key))
const validOverviewAnalytics=(value,keys)=>plainObject(value)&&typeof value._scope_key==='string'&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key)&&(key==='summary'||key==='score_bands'?plainObject(value[key]):Array.isArray(value[key])))&&(!keys.includes('summary')||hasKeys(value.summary,['total_attempts','graded_attempts','current_attempts','legacy_attempts']))&&(!keys.includes('score_bands')||hasKeys(value.score_bands,['excellent','good','pass','fail']))
const overviewAccessFailure=value=>/(not_authenticated|session_not_current|permission_denied|not authenticated|permission denied|\b401\b|\b403\b)/i.test(message(value))
const todaySessionFilters=()=>{const day=businessTodayIso();return {...blankSessionFilters,dateFrom:day,dateTo:day}}
const message=e=>e?.message||String(e||'操作失败')
const labelValue=value=>String(value||'').trim()||'全部'
const questionRequestLabel=(filters,page,pageSize)=>`题库：搜索 ${labelValue(filters.search)}，团队 ${labelValue(filters.team)}，岗位 ${labelValue(filters.position)}，第 ${page} 页 / ${pageSize} 条`
const sessionRequestLabel=(tab,filters,page,pageSize)=>`${tab}：员工 ${labelValue(filters.employeeNo||filters.employeeName)}，团队 ${labelValue(filters.team)}，岗位 ${labelValue(filters.position)}，日期 ${labelValue(filters.dateFrom)} 至 ${labelValue(filters.dateTo)}，第 ${page} 页 / ${pageSize} 条`
const fmt=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—'
const score=v=>v==null?'—':Number(v).toLocaleString('zh-CN',{maximumFractionDigits:2})
const breakdown=x=>{
  if(x.source_system==='legacy'&&!x.answer_detail_available)return x.percentage==null?'逐题明细未同步':'总成绩已保留 · 逐题明细未同步'
  const result=[`正确 ${x.correct_count||0}`]
  if(Number(x.partial_count||0)>0)result.push(`半对 ${x.partial_count}`)
  result.push(`错误 ${x.wrong_count||0}`)
  if(Number(x.pending_count||0)>0)result.push(`待评 ${x.pending_count}`)
  if(x.source_system!=='legacy')return result.join(' · ')
  const total=Number(x.total_question_count||0),answered=Number(x.answer_detail_count||0)
  const unanswered=Number(x.unanswered_count??Math.max(total-answered,0))
  if(unanswered>0)result.unshift(`未答 ${unanswered}`)
  return result.join(' · ')
}
const recentDays=(rows,count=7)=>{
  const byDay=new Map((rows||[]).map(x=>[String(x.activity_day||'').slice(0,10),x]))
  return Array.from({length:count},(_,index)=>{
    const day=new Date();day.setHours(12,0,0,0);day.setDate(day.getDate()-index)
    const key=`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`
    return byDay.get(key)||{activity_day:key,submitted:0,current_submitted:0,legacy_submitted:0,graded:0,pending:0}
  })
}

export default function AdminTrainingPage(){
  const [params,setParams]=useSearchParams()
  const access=useAdminAccess()
  const {notify}=useAppToast()
  const requestedRouteTab=params.get('tab')
  const requestedTab=canonicalAdminTab('/admin/training',requestedRouteTab)
  const visibleTabs=access.loading?[]:TABS.filter(value=>{
    if(value==='考试概览')return access.hasPermission(PERMISSIONS.EXAM_OVERVIEW_VIEW)
    if(value==='考试记录')return access.hasPermission(PERMISSIONS.EXAM_RECORDS_VIEW)
    if(value==='题库')return access.hasPermission(PERMISSIONS.EXAM_QUESTION_BANK_VIEW)
    if(value==='人工批改')return access.hasPermission(PERMISSIONS.EXAM_GRADING_VIEW)
    return false
  })
  const tab=access.loading?(TABS.includes(requestedTab)?requestedTab:TABS[0]):(visibleTabs.includes(requestedTab)?requestedTab:(visibleTabs[0]||''))
  const [draft,setDraft]=useState({search:'',team:'',position:''})
  const [filters,setFilters]=useState(draft)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(30)
  const [questionSearchVersion,setQuestionSearchVersion]=useState(0)
  const [questionSnapshot,setQuestionSnapshot]=useState({scopeKey:'',label:'',hasData:false,data:null})
  const [authIdentity,setAuthIdentity]=useState(null)
  const [overviewSnapshot,setOverviewSnapshot]=useState({scopeKey:'',hasData:false,data:null})
  const [loading,setLoading]=useState(true)
  const [overviewLoading,setOverviewLoading]=useState(false)
  const [error,setError]=useState('')
  const [questionStaleNotice,setQuestionStaleNotice]=useState('')
  const [overviewStaleNotice,setOverviewStaleNotice]=useState('')
  const overviewFlight=useRef(null)
  const [question,setQuestion]=useState(null)
  const [questionView,setQuestionView]=useState(null)
  const [grading,setGrading]=useState(null)
  const initialSessionFilters=()=>requestedTab==='人工批改'?blankSessionFilters:todaySessionFilters()
  const [sessionDraft,setSessionDraft]=useState(initialSessionFilters)
  const [sessionFilters,setSessionFilters]=useState(initialSessionFilters)
  const [sessionPage,setSessionPage]=useState(1)
  const [sessionPageSize,setSessionPageSize]=useState(30)
  const [sessionSearchVersion,setSessionSearchVersion]=useState(0)
  const [sessionSnapshot,setSessionSnapshot]=useState({scopeKey:'',label:'',hasData:false,data:{rows:[],total:0}})
  const [sessionLoading,setSessionLoading]=useState(false)
  const [sessionStaleNotice,setSessionStaleNotice]=useState('')
  const [employeeDetail,setEmployeeDetail]=useState(null)
  const [employeeDetailLoading,setEmployeeDetailLoading]=useState(false)
  const [deleteSession,setDeleteSession]=useState(null)
  const canDeleteSessions=access.hasPermission(PERMISSIONS.EXAM_RECORDS_DELETE)
  const canGrade=access.hasPermission(PERMISSIONS.EXAM_GRADING_GRADE)
  const canManageQuestions=access.hasPermission(PERMISSIONS.EXAM_QUESTION_BANK_MANAGE)
  const canDeleteQuestions=access.hasPermission(PERMISSIONS.EXAM_QUESTION_BANK_DELETE)
  const canViewEmployeeDirectory=access.hasPermission(PERMISSIONS.EMPLOYEE_DIRECTORY_VIEW)
  const aliveRef=useRef(true)
  const tabRef=useRef(tab)
  const questionRequestRef=useRef(0)
  const overviewRequestRef=useRef(0)
  const overviewAbortRef=useRef(null)
  const sessionRequestRef=useRef(0)
  const questionReadIntentRef=useRef('')
  const overviewReadIntentRef=useRef('')
  const sessionReadIntentRef=useRef('')
  const questionSnapshotRef=useRef(questionSnapshot)
  const overviewSnapshotRef=useRef(overviewSnapshot)
  const sessionSnapshotRef=useRef(sessionSnapshot)
  tabRef.current=tab
  questionSnapshotRef.current=questionSnapshot
  overviewSnapshotRef.current=overviewSnapshot
  sessionSnapshotRef.current=sessionSnapshot
  const overviewScopeKey=useMemo(()=>[
    authIdentity||'',access.loading?'loading':'ready',access.founder?'founder':'member',access.permissionKey,
    access.roleCode,access.employeeId,access.dataScope,access.teamId,access.positionId
  ].join('|'),[authIdentity,access.loading,access.founder,access.permissionKey,access.roleCode,access.employeeId,access.dataScope,access.teamId,access.positionId])
  const overviewScopeKeyRef=useRef(overviewScopeKey)
  overviewScopeKeyRef.current=overviewScopeKey
  const overviewHasSnapshot=overviewSnapshot.scopeKey===overviewScopeKey&&overviewSnapshot.hasData
  const overviewData=overviewHasSnapshot?overviewSnapshot.data:null
  const questionHasSnapshot=questionSnapshot.scopeKey===overviewScopeKey&&questionSnapshot.hasData
  const data=questionHasSnapshot?questionSnapshot.data:null
  const sessionHasSnapshot=sessionSnapshot.scopeKey===overviewScopeKey&&sessionSnapshot.hasData
  const sessionData=sessionHasSnapshot?sessionSnapshot.data:{rows:[],total:0}
  const currentQuestionLabel=questionRequestLabel(filters,page,pageSize)
  const currentSessionLabel=sessionRequestLabel(tab,sessionFilters,sessionPage,sessionPageSize)
  const questionDisplayNotice=questionHasSnapshot&&(questionStaleNotice||questionSnapshot.label!==currentQuestionLabel)
    ?(questionStaleNotice||staleSnapshotNotice(questionSnapshot.label)):''
  const sessionDisplayNotice=sessionHasSnapshot&&(sessionStaleNotice||sessionSnapshot.label!==currentSessionLabel)
    ?(sessionStaleNotice||staleSnapshotNotice(sessionSnapshot.label)):''
  const activeSnapshotNotice=tab==='考试概览'&&overviewHasSnapshot?overviewStaleNotice:tab==='题库'?questionDisplayNotice:['考试记录','人工批改'].includes(tab)?sessionDisplayNotice:''

  useEffect(()=>{
    aliveRef.current=true
    return()=>{
      aliveRef.current=false
      questionRequestRef.current+=1
      overviewRequestRef.current+=1
      sessionRequestRef.current+=1
      overviewAbortRef.current?.abort();overviewAbortRef.current=null
      overviewFlight.current=null
    }
  },[])
  useEffect(()=>{
    let active=true
    const apply=session=>{if(active)setAuthIdentity(session?.user?.id||'')}
    supabase.auth.getSession().then(({data:sessionData})=>apply(sessionData?.session)).catch(()=>apply(null))
    const {data:listener}=supabase.auth.onAuthStateChange((_event,session)=>apply(session))
    return()=>{active=false;listener?.subscription?.unsubscribe()}
  },[])
  useEffect(()=>{
    questionRequestRef.current+=1
    overviewRequestRef.current+=1
    sessionRequestRef.current+=1
    overviewAbortRef.current?.abort();overviewAbortRef.current=null
    overviewFlight.current=null;setOverviewLoading(false)
    setOverviewSnapshot(current=>current.scopeKey===overviewScopeKey?current:{scopeKey:overviewScopeKey,hasData:false,data:null})
    setQuestionSnapshot(current=>current.scopeKey===overviewScopeKey?current:{scopeKey:overviewScopeKey,label:'',hasData:false,data:null})
    setSessionSnapshot(current=>current.scopeKey===overviewScopeKey?current:{scopeKey:overviewScopeKey,label:'',hasData:false,data:{rows:[],total:0}})
    setOverviewStaleNotice('');setQuestionStaleNotice('');setSessionStaleNotice('')
    setError('')
  },[overviewScopeKey])
  useEffect(()=>{
    if(tab==='考试概览')return
    overviewRequestRef.current+=1
    overviewAbortRef.current?.abort();overviewAbortRef.current=null
    overviewFlight.current=null;setOverviewLoading(false)
  },[tab])

  const loadQuestionBank=async()=>{
    const requestToken=++questionRequestRef.current
    const requestScopeKey=overviewScopeKey
    const requestLabel=questionRequestLabel(filters,page,pageSize)
    const requestedOperation=questionReadIntentRef.current
    questionReadIntentRef.current=''
    const prior=questionSnapshotRef.current
    setLoading(true);setError('')
    setQuestionStaleNotice(prior.scopeKey===requestScopeKey&&prior.hasData&&prior.label!==requestLabel?staleSnapshotNotice(prior.label):'')
    try{
      const {data:result,error:e}=await supabase.rpc('admin_exam_question_bank_dashboard',{p_search:filters.search,p_team:filters.team,p_position:filters.position,p_page:page,p_page_size:pageSize})
      if(!isCurrentLiveRequest(aliveRef.current,questionRequestRef.current,requestToken)||overviewScopeKeyRef.current!==requestScopeKey)return
      if(e){
        const reason=message(e)
        if(tabRef.current==='题库')setError(reason)
        const snapshot=questionSnapshotRef.current
        if(snapshot.scopeKey===requestScopeKey&&snapshot.hasData)setQuestionStaleNotice(staleSnapshotNotice(snapshot.label))
        else setQuestionStaleNotice('')
        if(requestedOperation)notify({
          type:'error',module:TRAINING_TOAST_MODULE,operation:requestedOperation,reason,
          dedupeKey:'training:question-bank:read:error',
          retry:()=>{questionReadIntentRef.current='刷新考试题库';return loadQuestionBank()},retryLabel:'重试',
        })
      }else{
        const snapshot={scopeKey:requestScopeKey,label:requestLabel,hasData:true,data:result||null}
        questionSnapshotRef.current=snapshot;setQuestionSnapshot(snapshot);setQuestionStaleNotice('')
      }
    }catch(e){
      if(isCurrentLiveRequest(aliveRef.current,questionRequestRef.current,requestToken)&&overviewScopeKeyRef.current===requestScopeKey){
        const reason=message(e)
        if(tabRef.current==='题库')setError(reason)
        const snapshot=questionSnapshotRef.current
        setQuestionStaleNotice(snapshot.scopeKey===requestScopeKey&&snapshot.hasData?staleSnapshotNotice(snapshot.label):'')
        if(requestedOperation)notify({
          type:'error',module:TRAINING_TOAST_MODULE,operation:requestedOperation,reason,
          dedupeKey:'training:question-bank:read:error',
          retry:()=>{questionReadIntentRef.current='刷新考试题库';return loadQuestionBank()},retryLabel:'重试',
        })
      }
    }finally{
      if(isCurrentLiveRequest(aliveRef.current,questionRequestRef.current,requestToken))setLoading(false)
    }
  }
  const loadOverview=()=>{
    if(!authIdentity)return Promise.resolve()
    if(overviewFlight.current?.scopeKey===overviewScopeKey)return overviewFlight.current.promise
    const requestToken=++overviewRequestRef.current
    const requestedOperation=overviewReadIntentRef.current
    overviewReadIntentRef.current=''
    let failureNotified=false
    const publishFailure=reason=>{
      if(!requestedOperation||failureNotified)return
      failureNotified=true
      notify({
        type:'error',module:TRAINING_TOAST_MODULE,operation:requestedOperation,reason,
        dedupeKey:'training:overview:read:error',
        retry:()=>{overviewReadIntentRef.current='刷新考试概览';return loadOverview()},retryLabel:'重试',
      })
    }
    setOverviewLoading(true);setError('')
    const requestScopeKey=overviewScopeKey
    const invokeOverviewRpc=async rpcName=>{
      const controller=new AbortController()
      overviewAbortRef.current?.abort();overviewAbortRef.current=controller
      const timeoutId=setTimeout(()=>controller.abort(),OVERVIEW_RPC_TIMEOUT_MS)
      try{return await supabase.rpc(rpcName).abortSignal(controller.signal)}
      finally{
        clearTimeout(timeoutId)
        if(overviewAbortRef.current===controller)overviewAbortRef.current=null
      }
    }
    const promise=(async()=>{
      const invalidateOverview=()=>{
        const empty={scopeKey:requestScopeKey,hasData:false,data:null}
        overviewSnapshotRef.current=empty;setOverviewSnapshot(empty);setOverviewStaleNotice('')
      }
      try{
        const {data:result,error:e}=await invokeOverviewRpc('admin_exam_overview_home')
        if(!isCurrentLiveRequest(aliveRef.current,overviewRequestRef.current,requestToken)||overviewScopeKeyRef.current!==requestScopeKey||tabRef.current!=='考试概览')return
        if(e||!validOverviewHome(result)){
          const homeFailure=e||new Error('考试基础数据响应不完整')
          const reason=message(homeFailure)
          if(tabRef.current==='考试概览')setError(reason)
          publishFailure(reason)
          if(overviewAccessFailure(homeFailure)){invalidateOverview();return}
          const snapshot=overviewSnapshotRef.current
          setOverviewStaleNotice(snapshot.scopeKey===requestScopeKey&&snapshot.hasData?staleSnapshotNotice('当前账号与权限范围'):'')
          return
        }

        const prior=overviewSnapshotRef.current
        const serverScopeKey=result._scope_key
        const priorReady=prior.scopeKey===requestScopeKey&&prior.hasData&&prior.data?._analytics_ready===true&&prior.data?._scope_key===serverScopeKey
        let merged={...(result||{}),analytics:priorReady?prior.data.analytics:null,_analytics_ready:priorReady,_analytics_partial:false}
        const publish=()=>{
          if(!isCurrentLiveRequest(aliveRef.current,overviewRequestRef.current,requestToken)||overviewScopeKeyRef.current!==requestScopeKey||tabRef.current!=='考试概览')return false
          const snapshot={scopeKey:requestScopeKey,hasData:true,data:merged}
          overviewSnapshotRef.current=snapshot;setOverviewSnapshot(snapshot)
          return true
        }
        if(!publish())return
        setOverviewStaleNotice(priorReady?'基础数据已更新；考试分析刷新中，暂显示上次成功结果。':'')

        let partialAnalytics=false,completedAnalytics=0
        for(const [rpcName,requiredKeys] of overviewAnalyticsRpcs){
          if(tabRef.current!=='考试概览')return
          try{
            const {data:analyticsPart,error:analyticsError}=await invokeOverviewRpc(rpcName)
            if(!isCurrentLiveRequest(aliveRef.current,overviewRequestRef.current,requestToken)||overviewScopeKeyRef.current!==requestScopeKey||tabRef.current!=='考试概览')return
            if(analyticsError){
              partialAnalytics=true
              if(overviewAccessFailure(analyticsError)){const reason=message(analyticsError);setError(reason);publishFailure(reason);invalidateOverview();return}
              continue
            }
            if(!validOverviewAnalytics(analyticsPart,requiredKeys)){
              partialAnalytics=true
              continue
            }
            if(analyticsPart._scope_key!==serverScopeKey){const reason='权限范围已变化，请刷新重试。';setError(reason);publishFailure(reason);invalidateOverview();return}
            const {_scope_key:_ignoredScopeKey,...analyticsPatch}=analyticsPart
            merged=withOverviewAnalytics(merged,analyticsPatch)
            completedAnalytics+=1
            if(!publish())return
          }catch(analyticsError){
            if(!isCurrentLiveRequest(aliveRef.current,overviewRequestRef.current,requestToken)||overviewScopeKeyRef.current!==requestScopeKey||tabRef.current!=='考试概览')return
            partialAnalytics=true
            if(overviewAccessFailure(analyticsError)){const reason=message(analyticsError);setError(reason);publishFailure(reason);invalidateOverview();return}
          }
        }
        merged={...merged,_analytics_ready:priorReady||completedAnalytics===overviewAnalyticsRpcs.length,_analytics_partial:partialAnalytics}
        if(!publish())return
        setOverviewStaleNotice(partialAnalytics?'部分分析暂不可用；已保留本次成功结果，请稍后刷新重试。':'')
      }catch(e){
        if(isCurrentLiveRequest(aliveRef.current,overviewRequestRef.current,requestToken)&&overviewScopeKeyRef.current===requestScopeKey&&tabRef.current==='考试概览'){
          const reason=message(e)
          if(tabRef.current==='考试概览')setError(reason)
          publishFailure(reason)
          if(overviewAccessFailure(e)){invalidateOverview();return}
          const snapshot=overviewSnapshotRef.current
          setOverviewStaleNotice(snapshot.scopeKey===requestScopeKey&&snapshot.hasData?staleSnapshotNotice('当前账号与权限范围'):'')
        }
      }
    })()
    overviewFlight.current={scopeKey:requestScopeKey,promise}
    return promise.finally(()=>{
      if(overviewFlight.current?.promise===promise){
        overviewFlight.current=null
        if(isCurrentLiveRequest(aliveRef.current,overviewRequestRef.current,requestToken))setOverviewLoading(false)
      }
    })
  }
  const load=()=>tab==='题库'?loadQuestionBank():loadOverview()
  useEffect(()=>{if(!access.loading&&['考试概览','题库'].includes(tab)&&(tab==='题库'||authIdentity))load()},[access.loading,overviewScopeKey,tab,filters,page,pageSize,questionSearchVersion])
  const loadSessions=async()=>{
    if(access.loading||!['考试记录','人工批改'].includes(tab)){sessionRequestRef.current+=1;setSessionLoading(false);return}
    const requestToken=++sessionRequestRef.current
    const requestedOperation=sessionReadIntentRef.current
    sessionReadIntentRef.current=''
    const requestScopeKey=overviewScopeKey
    const requestTab=tab
    const requestLabel=sessionRequestLabel(requestTab,sessionFilters,sessionPage,sessionPageSize)
    const prior=sessionSnapshotRef.current
    setSessionLoading(true);setError('')
    setSessionStaleNotice(prior.scopeKey===requestScopeKey&&prior.hasData&&prior.label!==requestLabel?staleSnapshotNotice(prior.label):'')
    const forcedStatus=tab==='人工批改'?'pending':sessionFilters.status
    try{
      const {data:result,error:e}=await supabase.rpc(requestTab==='人工批改'?'admin_exam_grading_search':'admin_exam_records_search',{p_employee_no:sessionFilters.employeeNo,p_employee_name:sessionFilters.employeeName,p_exam:sessionFilters.exam,p_team:sessionFilters.team,p_position:sessionFilters.position,p_status:forcedStatus,p_grader:sessionFilters.grader,p_source:sessionFilters.source,p_date_from:sessionFilters.dateFrom||null,p_date_to:sessionFilters.dateTo||null,p_page:sessionPage,p_page_size:sessionPageSize})
      if(!isCurrentLiveRequest(aliveRef.current,sessionRequestRef.current,requestToken)||overviewScopeKeyRef.current!==requestScopeKey)return
      if(e){
        const reason=message(e)
        if(tabRef.current===requestTab)setError(reason)
        const snapshot=sessionSnapshotRef.current
        setSessionStaleNotice(snapshot.scopeKey===requestScopeKey&&snapshot.hasData?staleSnapshotNotice(snapshot.label):'')
        if(requestedOperation)notify({
          type:'error',module:TRAINING_TOAST_MODULE,operation:requestedOperation,reason,
          dedupeKey:'training:sessions:read:error',
          retry:()=>{sessionReadIntentRef.current='刷新考试记录';return loadSessions()},retryLabel:'重试',
        })
      }else{
        const snapshot={scopeKey:requestScopeKey,label:requestLabel,hasData:true,data:result||{rows:[],total:0}}
        sessionSnapshotRef.current=snapshot;setSessionSnapshot(snapshot);setSessionStaleNotice('')
      }
    }catch(e){
      if(isCurrentLiveRequest(aliveRef.current,sessionRequestRef.current,requestToken)&&overviewScopeKeyRef.current===requestScopeKey){
        const reason=message(e)
        if(tabRef.current===requestTab)setError(reason)
        const snapshot=sessionSnapshotRef.current
        setSessionStaleNotice(snapshot.scopeKey===requestScopeKey&&snapshot.hasData?staleSnapshotNotice(snapshot.label):'')
        if(requestedOperation)notify({
          type:'error',module:TRAINING_TOAST_MODULE,operation:requestedOperation,reason,
          dedupeKey:'training:sessions:read:error',
          retry:()=>{sessionReadIntentRef.current='刷新考试记录';return loadSessions()},retryLabel:'重试',
        })
      }
    }finally{
      if(isCurrentLiveRequest(aliveRef.current,sessionRequestRef.current,requestToken))setSessionLoading(false)
    }
  }
  useEffect(()=>{loadSessions()},[access.loading,overviewScopeKey,tab,sessionFilters,sessionPage,sessionPageSize,sessionSearchVersion])
  useEffect(()=>{
    if(access.loading||!tab)return
    const desiredRouteTab=tab===TABS[0]?null:adminTabSlug('/admin/training',tab)
    if(requestedRouteTab===desiredRouteTab)return
    setParams(desiredRouteTab?{tab:desiredRouteTab}:{},{replace:true})
  },[access.loading,access.founder,access.permissionKey,requestedRouteTab,tab,setParams])
  const setTab=x=>{
    if(!visibleTabs.includes(x))return
    if(x==='考试记录'||x==='人工批改'){
      const next=x==='人工批改'?blankSessionFilters:todaySessionFilters()
      setSessionDraft(next);setSessionFilters(next);setSessionPage(1)
    }
    setParams(x===TABS[0]?{}:adminTabParams('/admin/training',x))
  }
  const apply=()=>{questionReadIntentRef.current='查询考试题库';setPage(1);setFilters({...draft});setQuestionSearchVersion(version=>version+1)}
  const reset=()=>{questionReadIntentRef.current='重置题库查询';const x={search:'',team:'',position:''};setDraft(x);setFilters(x);setPage(1);setQuestionSearchVersion(version=>version+1)}
  const applySessions=()=>{sessionReadIntentRef.current=`查询${tab}`;setSessionPage(1);setSessionFilters({...sessionDraft});setSessionSearchVersion(version=>version+1)}
  const resetSessions=()=>{sessionReadIntentRef.current=`重置${tab}查询`;const next=tab==='人工批改'?blankSessionFilters:todaySessionFilters();setSessionDraft(next);setSessionFilters(next);setSessionPage(1);setSessionSearchVersion(version=>version+1)}
  const showEmployeeRecords=s=>{
    const next={...blankSessionFilters,employeeNo:s.employee_no||''}
    sessionReadIntentRef.current='查询员工考试记录'
    setTab('考试记录');setSessionDraft(next);setSessionFilters(next);setSessionPage(1);setSessionSearchVersion(version=>version+1)
  }
  const openEmployee=async s=>{
    if(!canViewEmployeeDirectory||!s.employee_id)return
    setEmployeeDetail({employee:{id:s.employee_id,employee_no:s.employee_no,full_name:s.employee_name},missing_fields:[]})
    setEmployeeDetailLoading(true);setError('')
    try{
      const {data:detail,error:e}=await supabase.functions.invoke('admin-employees',{body:{action:'detail',employee_id:s.employee_id}})
      if(e||detail?.error)throw new Error(await edgeFunctionErrorMessage({data:detail,error:e,fallback:'员工档案读取失败'}))
      setEmployeeDetail(detail)
    }catch(error){
      const reason=message(error)
      setError(reason);setEmployeeDetail(null)
      notify({
        type:'error',module:TRAINING_TOAST_MODULE,operation:'读取员工档案',reason,
        dedupeKey:'training:employee-detail:read:error',retry:()=>openEmployee(s),retryLabel:'重试',
      })
    }finally{setEmployeeDetailLoading(false)}
  }
  const counts=overviewData?.counts||{}
  const legacySync=overviewData?.legacy?.sync_state||{}
  const legacySourcePaused=legacySync.status==='source_paused'||Boolean(legacySync.last_error)
  const legacySyncLabel=legacySourcePaused?'旧考试 · 历史已保留（源暂停）':'旧考试 · 已存本库'
  const pageChrome=adminLocalPageTabs('/admin/training',visibleTabs,tab)
  const sectionTitle=pageChrome.active.sectionLabel||'考试管理'
  const refresh=()=>{
    if(['考试记录','人工批改'].includes(tab)){sessionReadIntentRef.current=`刷新${tab}`;return loadSessions()}
    if(tab==='题库'){questionReadIntentRef.current='刷新考试题库';return loadQuestionBank()}
    overviewReadIntentRef.current='刷新考试概览';return loadOverview()
  }
  const refreshQuestionAfterMutation=(operation='刷新确认题库状态')=>{questionReadIntentRef.current=operation;return loadQuestionBank()}
  const refreshSessionsAfterMutation=(operation='刷新确认考试记录')=>{sessionReadIntentRef.current=operation;return loadSessions()}

  return <div className="content-page exam-page">
    <header className="exam-head"><div><small>ATTENDANCE · EXAMS · REWARDS</small><h1>{sectionTitle}</h1><p>{pageChrome.active.itemLabel||tab}</p></div><div className="exam-head-actions"><span className="exam-sync-pill">Google 题库 · {(tab==='题库'?data:overviewData)?.last_sync?.status==='success'?'已同步':'等待同步'}</span><span className={`exam-sync-pill legacy ${legacySourcePaused?'':'success'}`} title={legacySync.last_success_at?`最后同步：${fmt(legacySync.last_success_at)}`:''}>{legacySyncLabel}</span><button onClick={refresh} disabled={tab==='考试概览'?overviewLoading:['考试记录','人工批改'].includes(tab)?sessionLoading:loading}>刷新</button></div></header>
    {error&&<div className="exam-error">{error}<button onClick={()=>setError('')}>×</button></div>}
    {activeSnapshotNotice&&<div className="exam-error exam-snapshot-notice" role="status">{activeSnapshotNotice}</div>}
    <AdminModuleNav />

    {access.loading&&<div className="exam-empty">正在读取页面权限…</div>}
    {!access.loading&&!tab&&<div className="exam-error">当前账号没有考试管理页面权限。</div>}

    {tab==='考试概览'&&(overviewData
      ?<Overview counts={counts} data={overviewData} onTab={setTab} visibleTabs={visibleTabs} onEmployee={showEmployeeRecords}/>
      :<div className="exam-empty">{overviewLoading?'正在读取考试数据…':'考试数据暂时无法读取，请点击刷新重试。'}</div>
    )}
    {tab==='题库'&&<>
      <FilterBar draft={draft} setDraft={setDraft} data={data} onApply={apply} onReset={reset}/>
      <section className="exam-panel"><div className="exam-section-title"><div><h2>考试题库</h2></div>{canManageQuestions&&<button className="primary" onClick={()=>setQuestion({...blankQuestion,team_name:draft.team,position_name:draft.position})}>＋ 新增题目</button>}</div>
      <QuestionTable data={data} loading={loading} page={page} setPage={next=>{questionReadIntentRef.current='查询题库分页';setPage(next);setQuestionSearchVersion(version=>version+1)}} pageSize={pageSize} setPageSize={x=>{questionReadIntentRef.current='调整题库分页';setPage(1);setPageSize(x);setQuestionSearchVersion(version=>version+1)}} onView={setQuestionView} onEdit={canManageQuestions?setQuestion:null} canDelete={canDeleteQuestions} onChanged={()=>refreshQuestionAfterMutation('删除后刷新考试题库')} onRefreshConfirm={()=>refreshQuestionAfterMutation()} setError={setError}/></section>
    </>}
    {['考试记录','人工批改'].includes(tab)&&<SessionFilterBar draft={sessionDraft} setDraft={setSessionDraft} data={sessionData} tab={tab} onApply={applySessions} onReset={resetSessions}/>}
    {tab==='考试记录'&&<Sessions rows={sessionData.rows||[]} total={sessionData.total||0} page={sessionPage} pageSize={sessionPageSize} setPage={next=>{sessionReadIntentRef.current='查询考试记录分页';setSessionPage(next);setSessionSearchVersion(version=>version+1)}} setPageSize={x=>{sessionReadIntentRef.current='调整考试记录分页';setSessionPage(1);setSessionPageSize(x);setSessionSearchVersion(version=>version+1)}} loading={sessionLoading} onEmployee={showEmployeeRecords} onEmployeeArchive={canViewEmployeeDirectory?openEmployee:null} onOpen={open=>setGrading({session:open,detail:null})} canDelete={canDeleteSessions} onDelete={setDeleteSession}/>}
    {tab==='人工批改'&&<Sessions rows={sessionData.rows||[]} total={sessionData.total||0} page={sessionPage} pageSize={sessionPageSize} setPage={next=>{sessionReadIntentRef.current='查询人工批改分页';setSessionPage(next);setSessionSearchVersion(version=>version+1)}} setPageSize={x=>{sessionReadIntentRef.current='调整人工批改分页';setSessionPage(1);setSessionPageSize(x);setSessionSearchVersion(version=>version+1)}} loading={sessionLoading} onEmployee={showEmployeeRecords} onEmployeeArchive={canViewEmployeeDirectory?openEmployee:null} onOpen={open=>setGrading({session:open,detail:null})} grading/>}
    {question&&<QuestionModal value={question} series={data?.series||[]} teams={data?.teams||[]} positions={data?.positions||[]} onClose={()=>setQuestion(null)} onRefreshConfirm={()=>refreshQuestionAfterMutation()} onSaved={()=>{setQuestion(null);return refreshQuestionAfterMutation('保存后刷新考试题库')}}/>}
    {questionView&&<QuestionView value={questionView} onClose={()=>setQuestionView(null)} onEdit={canManageQuestions?()=>{setQuestion(questionView);setQuestionView(null)}:null}/>}
    {grading&&(
      <GradeModal session={grading.session} permissionPage={tab==='人工批改'?'grading':'records'} forceReadOnly={!canGrade} onClose={()=>setGrading(null)} onChanged={()=>refreshSessionsAfterMutation('评分后刷新考试记录')} onRefreshConfirm={()=>refreshSessionsAfterMutation('刷新确认评分状态')}/>
    )}
    {deleteSession&&<DeleteSessionModal session={deleteSession} onClose={()=>setDeleteSession(null)} onRefreshConfirm={()=>{setDeleteSession(null);return refreshSessionsAfterMutation('刷新确认删除结果')}} onDeleted={async()=>{setDeleteSession(null);await refreshSessionsAfterMutation('删除后刷新考试记录')}}/>}
    {employeeDetail&&<EmployeeDrawer key={employeeDetail?.employee?.id||employeeDetail?.employee?.employee_no||employeeDetail?.id||'exam-employee'} detail={employeeDetail} loading={employeeDetailLoading} readOnly onClose={()=>setEmployeeDetail(null)}/>}
  </div>
}

function Overview({counts,data,onTab,visibleTabs,onEmployee}){
  const analytics=data?.analytics||{},analyticsReady=data?._analytics_ready===true
  const old=data?.legacy?.counts||{}
  const current=data?.current_counts||{}
  const daily=analyticsReady?recentDays(analytics.daily_activity,7):[]
  const cards=[
    ['题库',counts.questions||0,'题库','题目'],['记录',counts.total_sessions||0,'考试记录','全部'],['待批改',counts.pending_grading||0,'人工批改','份'],['已完成',counts.completed||0,'考试记录','份'],
    ['本系统',current.total_sessions||0,null,'份'],['旧考试',old.total_sessions||0,null,`已评 ${old.completed||0} · 待评 ${old.pending_grading||0}`],['已匹配',old.matched||0,null,`未匹配 ${old.unmatched||0}`]
  ]
  const analyticsMessage=data?._analytics_partial?'部分分析暂不可用，基础记录与计数不受影响。':'正在读取考试分析…'
  return <><section className="exam-overview-strip">{cards.map(([label,value,target,note],index)=>{const allowed=target&&visibleTabs.includes(target);const content=<><span>{label}</span><strong>{value}</strong><small>{note}{allowed?' · 查看 →':''}</small></>;return allowed?<button key={label} onClick={()=>onTab(target)}>{content}</button>:<div key={label} className={index===5?'legacy':''}>{content}</div>})}</section><div className="exam-two exam-overview-lower"><section className="exam-panel exam-recent-panel"><div className="exam-section-title"><div><h2>最近考试</h2><p>近 7 天每日提交与最新记录</p></div>{visibleTabs.includes('考试记录')&&<button onClick={()=>onTab('考试记录')}>查看全部</button>}</div>{analyticsReady?<div className="exam-daily-strip">{daily.map((x,index)=><div key={x.activity_day} className={index===0?'today':''}><span>{index===0?'今日':String(x.activity_day).slice(5)}</span><strong>{x.submitted} 份</strong><small>本系统 {x.current_submitted} · 旧考试 {x.legacy_submitted}</small><small>已评 {x.graded} · 待评 {x.pending}</small></div>)}</div>:<div className="exam-empty compact">{analyticsMessage}</div>}<div className="exam-recent-scroll"><Sessions rows={(data?.sessions||[]).slice(0,12)} compact onEmployee={onEmployee}/></div></section><section className="exam-panel adaptive-rule-panel"><h2>考试规则</h2><div><b>仅匹配团队</b><span>员工自行选择岗位与盘口</span></div><div><b>14 题 · 100 分</b><span>10×5分＋3×10分＋1×20分</span></div><div><b>60 分钟</b><span>连续计时 · 自动保存</span></div></section></div>{analyticsReady?<ExamAnalytics analytics={analytics} onEmployee={onEmployee}/>:<section className="exam-panel exam-analytics"><div className="exam-empty">{analyticsMessage}</div></section>}</>
}

function ExamAnalytics({analytics,onEmployee}){
  const summary=analytics.summary||{},series=analytics.series||[],positions=analytics.positions||[],teams=analytics.teams||[],leaderboard=analytics.leaderboard||[],bands=analytics.score_bands||{},trend=analytics.trend||[]
  const duration=Number(summary.avg_duration_seconds||0),durationText=duration?`${Math.floor(duration/60)}分${Math.round(duration%60)}秒`:'—'
  const facts=[['考试总次数',summary.total_attempts||0,'次'],['平均分',score(summary.avg_score),'分'],['平均用时',durationText,''],['通过率',score(summary.pass_rate),'%'],['已通过',summary.pass_count||0,'次'],['未通过',summary.fail_count||0,'次']]
  const graded=Number(summary.graded_attempts||0),bandRows=[['优秀 90–100',bands.excellent||0,'excellent'],['良好 80–89',bands.good||0,'good'],['及格 60–79',bands.pass||0,'pass'],['未通过 0–59',bands.fail||0,'fail']]
  return <section className="exam-panel exam-analytics"><div className="exam-analytics-title"><div><small>EXAM INTELLIGENCE</small><h2>考试数据分析中心</h2><p>成绩、团队表现与排行榜合并本系统及旧考试；逐题统计只采用已同步的真实答案。</p></div><div className="exam-answer-block"><small>逐题真实结果</small><div className="exam-answer-source"><b>本系统</b><div className="exam-answer-totals"><span className="correct">正确 <b>{summary.correct_count||0}</b></span><span className="partial">半对 <b>{summary.partial_count||0}</b></span><span className="wrong">错误 <b>{summary.wrong_count||0}</b></span><span className="pending">待评 <b>{summary.pending_count||0}</b></span></div></div><div className="exam-answer-source legacy"><b>旧考试</b><div className="exam-answer-totals"><span className="correct">正确 <b>{summary.legacy_correct_count||0}</b></span><span className="partial">半对 <b>{summary.legacy_partial_count||0}</b></span><span className="wrong">错误 <b>{summary.legacy_wrong_count||0}</b></span><span className="pending">待评 <b>{summary.legacy_answer_pending_count||0}</b></span></div></div></div></div><div className="exam-analytics-facts">{facts.map(([label,value,unit])=><div key={label}><span>{label}</span><strong>{value}<small>{unit}</small></strong></div>)}</div><div className="exam-analytics-visuals"><AnalyticsColumnChart title="盘口 / 系列平均分" rows={series}/><AnalyticsColumnChart title="岗位平均分" rows={positions} green/><div className="exam-distribution-card"><header><div><h3>成绩分布</h3><p>已完成评分的考试</p></div><b>{graded}<small>份</small></b></header><div className="exam-score-bands">{bandRows.map(([label,value,tone])=><div key={label}><span>{label}</span><i><em className={tone} style={{width:`${graded?Math.max(3,value/graded*100):0}%`}}/></i><b>{value}</b></div>)}</div></div><TrendChart rows={trend}/></div><div className="exam-analytics-charts"><AnalyticsBars title="团队平均分" rows={teams}/><Leaderboard rows={leaderboard} onEmployee={onEmployee}/></div></section>
}

function AnalyticsColumnChart({title,rows,green=false}){
  const visible=(rows||[]).slice(0,16)
  return <div className={`exam-column-card ${green?'green':''}`}><header><h3>{title}</h3><span>{rows?.length||0} 类</span></header>{visible.length?<><div className="exam-column-plot"><div className="exam-y-axis"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div><div className="exam-columns">{visible.map(row=><div key={row.name} title={`${row.name}：${score(row.average)} 分，${row.attempts} 次`}><b style={{height:`${Math.max(3,Math.min(92,Number(row.average)||0))}%`}}><em>{score(row.average)}</em></b><span>{row.name}</span></div>)}</div></div><div className="exam-chart-legend">{(rows||[]).map(row=><span key={row.name} title={row.name}><i/>{row.name} · <b>{score(row.average)}分</b> · {row.attempts}次</span>)}</div></>:<div className="exam-empty compact">暂无已完成考试数据</div>}</div>
}

function TrendChart({rows}){
  const visible=(rows||[]).slice(-12),max=Math.max(100,...visible.map(x=>Number(x.average)||0))
  const attempts=visible.reduce((n,x)=>n+Number(x.attempts||0),0)
  return <div className="exam-trend-card"><header><div><h3>近 30 天成绩趋势</h3><p>最近 30 天内已完成考试，按日期显示平均分</p></div><span>{attempts} 次</span></header>{visible.length?<div className="exam-trend-bars">{visible.map((x,index)=>{const day=x.day||x.trend_day||'';return <div className="exam-trend-point" key={`${day}-${index}`} title={`${day} · ${score(x.average)}分 · ${x.attempts}次`}><div><i style={{height:`${Math.max(5,(Number(x.average)||0)/max*100)}%`}}><em>{score(x.average)}</em></i></div><span>{day?String(day).slice(5):'—'}<small>{x.attempts}次</small></span></div>})}</div>:<div className="exam-empty compact">近 30 天暂无已完成考试</div>}</div>
}

function Leaderboard({rows,onEmployee}){
  const [showAll,setShowAll]=useState(false)
  const [rankSearch,setRankSearch]=useState('')
  const visible=(rows||[]).slice(0,20)
  const allRows=(rows||[]).filter(row=>!rankSearch||`${row.employee_name||''} ${row.employee_no||''} ${row.team_name||''}`.toLowerCase().includes(rankSearch.toLowerCase()))
  return <><div className="exam-leaderboard"><header><div><h3>考试排行榜</h3><p>合并本系统与旧考试，姓名和员工 ID 可直接选择复制</p></div><div className="exam-leaderboard-actions"><span>TOP {visible.length}</span>{(rows?.length||0)>visible.length&&<button onClick={()=>setShowAll(true)}>查看全部</button>}</div></header>{visible.length?<LeaderboardRows rows={visible} onEmployee={onEmployee}/>:<div className="exam-empty compact">暂无排行榜数据</div>}</div>{showAll&&<Modal title={`考试排行榜 · 全部 ${rows.length} 人`} onClose={()=>setShowAll(false)} wide><div className="exam-leaderboard-modal-tools"><input value={rankSearch} onChange={e=>setRankSearch(e.target.value)} placeholder="搜索姓名 / 员工ID / 团队"/><span>显示 {allRows.length} 人</span></div><div className="exam-leaderboard-modal-note">姓名和员工 ID 可以复制；点击右侧按钮才会打开考试记录。</div><LeaderboardRows rows={allRows} onEmployee={row=>{setShowAll(false);onEmployee?.(row)}}/><footer><button onClick={()=>setShowAll(false)}>关闭</button></footer></Modal>}</>
}

function LeaderboardRows({rows,onEmployee}){
  return <div className="exam-leaderboard-list">{(rows||[]).map(row=>{const rank=Number(row.rank??row.rank_no);return <article key={`${row.employee_id||row.employee_no}-${rank}`}><b className={`rank r${rank}`}>{rank<=3?['🥇','🥈','🥉'][rank-1]:rank}</b><span><strong>{row.employee_name}</strong><small>{row.employee_no} · {row.team_name}{row.legacy_attempts?` · 旧考试 ${row.legacy_attempts}`:''}</small></span><em>{score(row.average_score)}<small>平均分</small></em><em>{score(row.best_score)}<small>最高分</small></em><em>{row.attempts}<small>次数</small></em><button onClick={()=>onEmployee?.(row)}>查看记录 →</button></article>})}</div>
}

function AnalyticsBars({title,rows}){
  const visible=(rows||[]).slice(0,18)
  return <div className="exam-bar-card"><header><h3>{title}</h3><span>{rows?.length||0} 类</span></header>{visible.length?<div className="exam-bars">{visible.map(row=><div key={row.name}><div><b title={row.name}>{row.name||'未分类'}</b><span>{score(row.average)} 分 · {row.attempts} 次</span></div><i><em style={{width:`${Math.max(0,Math.min(100,Number(row.average)||0))}%`}}/></i></div>)}</div>:<div className="exam-empty compact">暂无已完成考试数据</div>}{(rows?.length||0)>visible.length&&<small className="exam-chart-note">显示前 {visible.length} 类，共 {rows.length} 类</small>}</div>
}

function FilterBar({draft,setDraft,data,onApply,onReset}){return <section className="exam-filter"><label className="exam-search-field"><span>题目搜索</span><input value={draft.search} onChange={e=>setDraft({...draft,search:e.target.value})} onKeyDown={e=>e.key==='Enter'&&onApply()} placeholder="题目ID / 英文 / 中文 / 越南文"/></label><label><span>团队</span><select value={draft.team} onChange={e=>setDraft({...draft,team:e.target.value})}><option value="">全部团队</option>{(data?.teams||[]).map(x=><option key={x}>{x}</option>)}</select></label><label><span>岗位</span><select value={draft.position} onChange={e=>setDraft({...draft,position:e.target.value})}><option value="">全部岗位</option>{(data?.positions||[]).map(x=><option key={x}>{x}</option>)}</select></label><div className="exam-filter-actions"><button className="primary" onClick={onApply}>查询</button><button onClick={onReset}>重置</button></div></section>}

function SessionFilterBar({draft,setDraft,data,tab,onApply,onReset}){
  const fixedStatus=tab==='人工批改'?'待批改':''
  return <section className="exam-session-filter compact"><label><span>员工ID</span><input value={draft.employeeNo} onChange={e=>setDraft({...draft,employeeNo:e.target.value})} onKeyDown={e=>e.key==='Enter'&&onApply()} placeholder="输入员工ID"/></label><label><span>姓名</span><input value={draft.employeeName} onChange={e=>setDraft({...draft,employeeName:e.target.value})} onKeyDown={e=>e.key==='Enter'&&onApply()} placeholder="输入姓名"/></label><label className="wide"><span>考试名称</span><input value={draft.exam} onChange={e=>setDraft({...draft,exam:e.target.value})} onKeyDown={e=>e.key==='Enter'&&onApply()} placeholder="输入考试名称"/></label><label><span>记录来源</span><select value={draft.source} onChange={e=>setDraft({...draft,source:e.target.value})}><option value="">全部来源</option><option value="current">本系统</option><option value="legacy">旧考试</option></select></label><label><span>团队</span><select value={draft.team} onChange={e=>setDraft({...draft,team:e.target.value})}><option value="">全部团队</option>{(data?.teams||[]).map(x=><option key={x}>{x}</option>)}</select></label><label><span>岗位</span><select value={draft.position} onChange={e=>setDraft({...draft,position:e.target.value})}><option value="">全部岗位</option>{(data?.positions||[]).map(x=><option key={x}>{x}</option>)}</select></label><label><span>评分人</span><input value={draft.grader} onChange={e=>setDraft({...draft,grader:e.target.value})} placeholder="用户名 / 邮箱"/></label><label><span>状态</span>{fixedStatus?<input value={fixedStatus} disabled/>:<select value={draft.status} onChange={e=>setDraft({...draft,status:e.target.value})}><option value="">全部状态</option><option value="in_progress">答题中</option><option value="pending">待批改</option><option value="graded">已完成</option><option value="expired">已过期</option></select>}</label><label><span>完成日期起</span><input type="date" value={draft.dateFrom} onChange={e=>setDraft({...draft,dateFrom:e.target.value})}/></label><label><span>完成日期止</span><input type="date" value={draft.dateTo} onChange={e=>setDraft({...draft,dateTo:e.target.value})}/></label><div className="exam-filter-actions"><button className="primary" onClick={onApply}>查询</button><button onClick={onReset}>重置</button></div></section>
}

function QuestionTable({data,loading,page,setPage,pageSize,setPageSize,onView,onEdit,canDelete=false,onChanged,onRefreshConfirm,setError}){
  const {notify}=useAppToast()
  const rows=data?.questions||[],pages=Math.max(1,Math.ceil((data?.total||0)/(data?.page_size||pageSize)))
  const deleteQuestion=async q=>{
    if(!confirm(`确认删除题目 ${q.external_key}？\n历史考试仍会保留题目快照，Google 表格将在双向同步接通后删除对应行。`))return
    try{
      const {error}=await supabase.rpc('admin_exam_delete_question',{p_question_id:q.id})
      if(error)throw error
      notify({
        type:'success',module:TRAINING_TOAST_MODULE,operation:'删除考试题目',
        reason:`题目 ${q.external_key} 已删除，历史考试快照仍保留。`,dedupeKey:'training:question:delete:success',
      })
      await onChanged()
    }catch(error){
      const reason=message(error)
      setError(reason)
      notify({
        type:'error',module:TRAINING_TOAST_MODULE,operation:'删除考试题目',reason,
        dedupeKey:'training:question:delete:error',retry:onRefreshConfirm,retryLabel:'刷新确认',
      })
    }
  }
  return <>{loading?<div className="exam-empty">正在读取题库…</div>:!rows.length?<div className="exam-empty">没有符合条件的题目</div>:<div className="exam-table-wrap exam-question-wrap"><table className="exam-table exam-question-table"><thead><tr><th>题目ID</th><th>题库范围</th><th>三语题干</th><th>规格</th><th>同步</th><th>操作</th></tr></thead><tbody>{rows.map(q=><tr key={q.id}><td><button className="exam-id-link" onClick={()=>onView(q)}>{q.external_key}</button></td><td className="exam-question-scope"><strong title={q.team_name}>{q.team_name||'—'}</strong><span title={q.position_name}>{q.position_name||'—'}</span>{q.series_name&&<small title={q.series_name}>{q.series_name}</small>}</td><QuestionSummaryCell question={q} onOpen={()=>onView(q)}/><td className="exam-question-spec"><b>{q.points} 分</b><span>难度 {q.difficulty}</span>{(q.image_urls?.length||0)>0&&<small>{q.image_urls.length} 张图</small>}</td><td><span className={`sync-${q.sync_status}`}>{q.sync_status==='synced'?'已同步':'待回写'}</span></td><td><div className="exam-row-actions">{onEdit&&<button onClick={()=>onEdit(q)}>编辑</button>}{canDelete&&<button className="danger" onClick={()=>deleteQuestion(q)}>删除</button>}</div></td></tr>)}</tbody></table></div>}<ExamPagination page={page} pages={pages} total={data?.total||0} pageSize={pageSize} loading={loading} onPage={setPage} onPageSize={setPageSize} noun="题"/></>
}

const pageNumbers=(page,pages)=>{if(pages<=7)return Array.from({length:pages},(_,i)=>i+1);const out=[1],start=Math.max(2,page-1),end=Math.min(pages-1,page+1);if(start>2)out.push('…');for(let i=start;i<=end;i++)out.push(i);if(end<pages-1)out.push('…');out.push(pages);return out}
function QuestionSummaryCell({question,onOpen}){
  const lines=[['中',question.question_zh],['EN',question.question_en],['VI',question.question_vi]]
  return <td className="exam-question-summary"><button title="点击查看三语完整题干" onClick={onOpen}>{lines.map(([label,text])=><span key={label}><b>{label}</b><em>{text||'未填写'}</em></span>)}</button></td>
}

function ExamPagination({page,pages,total,pageSize,loading,onPage,onPageSize,noun='条'}){
  const [jump,setJump]=useState('')
  const from=total?(page-1)*pageSize+1:0,to=Math.min(page*pageSize,total)
  useEffect(()=>setJump(''),[page,pages])
  const go=value=>onPage(Math.max(1,Math.min(pages,Number(value)||1)))
  return <div className="table-pagination professional-pagination exam-compact-pagination"><div className="pagination-summary"><strong>共 {total} {noun}</strong><span>{from}–{to}</span></div><div className="pagination-main"><label className="pagination-size-control"><select value={pageSize} onChange={e=>{onPage(1);onPageSize(Number(e.target.value))}}>{[20,30,50,100].map(n=><option key={n} value={n}>{n} 条 / 页</option>)}</select></label><button disabled={page<=1||loading} onClick={()=>go(1)}>首页</button><button disabled={page<=1||loading} onClick={()=>go(page-1)}>上一页</button><div className="pagination-number-list">{pageNumbers(page,pages).map((n,i)=>n==='…'?<span key={`dots-${i}`} className="pager-dots">…</span>:<button key={n} className={n===page?'active':''} disabled={loading} onClick={()=>go(n)}>{n}</button>)}</div><button disabled={page>=pages||loading} onClick={()=>go(page+1)}>下一页</button><button disabled={page>=pages||loading} onClick={()=>go(pages)}>尾页</button><span className="pagination-page-count">共 {pages} 页</span><label className="pagination-jump">前往<input value={jump} inputMode="numeric" onChange={e=>setJump(e.target.value.replace(/\D/g,''))} onKeyDown={e=>{if(e.key==='Enter'&&jump)go(jump)}}/>页<button type="button" disabled={!jump||loading} onClick={()=>go(jump)}>确定</button></label></div></div>
}

function QuestionView({value,onClose,onEdit}){return <Modal title={`${value.external_key} · 三语题目`} onClose={onClose} wide><div className="question-detail"><div className="question-detail-meta"><span>盘口 <b>{value.series_name}</b></span><span>团队 <b>{value.team_name}</b></span><span>岗位 <b>{value.position_name}</b></span><span>分数 <b>{value.points}</b></span><span>难度 <b>{value.difficulty}</b></span></div><LanguageBlock tag="EN" title="英文" text={value.question_en}/><LanguageBlock tag="中" title="中文" text={value.question_zh}/><LanguageBlock tag="VI" title="越南文" text={value.question_vi}/><ExamImageGallery urls={value.image_urls} className="detail"/></div><footer><button onClick={onClose}>关闭</button>{onEdit&&<button className="primary" onClick={onEdit}>编辑题目</button>}</footer></Modal>}
function LanguageBlock({tag,title,text}){return <section className="question-language-block"><span>{tag}</span><div><b>{title}</b><p>{text||'未填写'}</p></div></section>}

function Assignments({data,onNew,onEdit,onPreview,onChanged,setError}){
  const remove=async a=>{if(!confirm(`确认删除考试“${a.title}”？\n已有作答记录时将改为关闭，历史成绩不会丢失。`))return;const {error}=await supabase.rpc('admin_exam_delete_assignment',{p_assignment_id:a.id});if(error)return setError(message(error));onChanged()}
  return <section className="exam-panel"><div className="exam-section-title"><div><h2>创建与分配考试</h2><p>先保存草稿并预览员工画面；确认后再发布给相同团队＋岗位或指定员工。</p></div><button className="primary" onClick={onNew}>＋ 创建考试</button></div><div className="exam-table-wrap"><table className="exam-table"><thead><tr><th>考试名称</th><th>分配范围</th><th>时长</th><th>及格分</th><th>次数</th><th>有效期</th><th>状态</th><th>操作</th></tr></thead><tbody>{(data?.assignments||[]).map(a=><tr key={a.id}><td><strong>{a.title}</strong></td><td>{a.employee_no?<><b>{a.employee_no}</b><br/>{a.employee_name}</>:<>{a.team_name} · {a.position_name}</>}</td><td>{a.duration_minutes}分钟</td><td>{a.pass_score}%</td><td>{a.max_attempts}</td><td>{fmt(a.start_at)}<br/>{fmt(a.end_at)}</td><td><span className={`assignment-status ${a.status}`}>{({draft:'草稿',published:'已发布',closed:'已关闭'}[a.status]||a.status)}</span></td><td><div className="exam-row-actions"><button onClick={()=>onPreview(a)}>预览</button><button onClick={()=>onEdit({...a,start_at:a.start_at?new Date(a.start_at).toISOString().slice(0,16):'',end_at:a.end_at?new Date(a.end_at).toISOString().slice(0,16):'',question_rules:a.question_rules||{5:10,10:3,20:1}})}>编辑</button><button className="danger" onClick={()=>remove(a)}>删除</button></div></td></tr>)}</tbody></table>{!(data?.assignments||[]).length&&<div className="exam-empty compact">还没有考试，点击“创建考试”先保存草稿并预览。</div>}</div></section>
}

function Sessions({rows,onOpen,onEmployee,onEmployeeArchive,onDelete,canDelete=false,compact=false,grading=false,loading=false,total=0,page=1,pageSize=30,setPage,setPageSize}){
  if(compact)return rows.length?<>{rows.map(s=><button className="exam-line exam-recent-line" key={`${s.source_system||'current'}-${s.id}`} onClick={()=>onEmployee?.(s)}><div><strong>{s.employee_name} · {s.title} {s.source_system==='legacy'&&<em className="exam-source-badge legacy">旧考试</em>}</strong><small>第 {s.attempt_no} 次 · {fmt(s.submitted_at||s.started_at)}</small><small className="exam-recent-result">{s.status==='graded'?`${score(s.earned_score)}/${score(s.total_score)} · ${breakdown(s)}`:statusText(s.status)}</small></div><span>{s.status==='graded'?(s.passed?'通过':'未通过'):statusText(s.status)}</span></button>)}</>:<div className="exam-empty compact">暂时没有考试记录</div>
  const pages=Math.max(1,Math.ceil(total/pageSize))
  return <section className="exam-panel"><div className="exam-section-title"><div><h2>{grading?'待人工批改':'员工考试记录与成绩'}</h2><p>本系统与旧考试统一查询；旧考试为只读记录。</p></div><span className="exam-total-pill">共 {total} 条</span></div>{loading?<div className="exam-empty">正在查询考试记录…</div>:!rows.length?<div className="exam-empty">{grading?'当前没有待批改考试':'没有符合条件的考试记录'}</div>:<div className="exam-table-wrap exam-session-wrap"><table className="exam-table exam-session-table"><thead><tr><th>来源</th><th>员工ID</th><th>姓名</th><th>团队 / 岗位</th><th>考试</th><th>次数</th><th>开始作答时间</th><th>完成作答时间</th><th>评分完成时间</th><th>得分</th><th>答题结果</th><th>评分人</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(s=><tr key={`${s.source_system||'current'}-${s.id}`}><td><span className={`exam-source-badge ${s.source_system==='legacy'?'legacy':'current'}`}>{s.source_label||'本系统'}</span></td><td>{s.employee_id&&onEmployeeArchive?<button className="exam-record-id" onClick={()=>onEmployeeArchive(s)}>{s.employee_no}</button>:<span>{s.employee_no}</span>}</td><td><CompactRecordName session={s} onFilter={onEmployee}/></td><td>{s.team_name||'—'}<br/><small>{s.position_name||'—'}</small></td><td className="exam-record-title" title={s.title}>{s.title}</td><td><b>第 {s.attempt_no} 次</b></td><td>{fmt(s.started_at)}</td><td>{fmt(s.submitted_at)}</td><td>{fmt(s.graded_at)}</td><td><b>{s.percentage==null?'—':`${score(s.earned_score)}/${score(s.total_score)}`}</b>{s.percentage!=null&&<small className="exam-record-percent">{score(s.percentage)}%</small>}</td><td><span className={`exam-record-breakdown ${s.answer_detail_available?'has-detail':'summary-only'}`}>{breakdown(s)}</span></td><td>{s.grader_name||'—'}</td><td><span className={`result-chip ${s.status==='graded'?(s.passed?'pass':'fail'):'pending'}`}>{statusText(s.status)}</span></td><td><div className="exam-row-actions">{onOpen&&<button onClick={()=>onOpen(s)}>{s.read_only?'查看详情':grading?'开始批改':'查看答卷'}</button>}{canDelete&&s.source_system!=='legacy'&&!s.read_only&&<button className="danger" onClick={()=>onDelete?.(s)}>删除本系统记录</button>}</div></td></tr>)}</tbody></table></div>}{setPage&&<ExamPagination page={page} pages={pages} total={total} pageSize={pageSize} loading={loading} onPage={setPage} onPageSize={setPageSize}/>}</section>
}

function CompactRecordName({session,onFilter}){
  const [expanded,setExpanded]=useState(false)
  const name=session.employee_name||'—'
  return <div className={`exam-record-name-cell ${expanded?'expanded':''}`}><button className="exam-record-name" title={expanded?'点击收起姓名':'点击查看完整姓名'} aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{name}</button>{expanded&&onFilter&&<button className="exam-record-name-filter" onClick={()=>onFilter(session)}>仅看此员工</button>}{session.employee_match_status==='unmatched'&&<small className="exam-unmatched">未匹配员工档案</small>}</div>
}
const statusText=x=>({in_progress:'答题中',submitted:'待批改',grading:'批改中',graded:'已完成',expired:'已过期'}[x]||x)

function Modal({title,onClose,children,wide=false}){return <div className="exam-modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><div className={`exam-modal ${wide?'wide':''}`}><header><h2>{title}</h2><button onClick={onClose}>×</button></header>{children}</div></div>}

function DeleteSessionModal({session,onClose,onDeleted,onRefreshConfirm}){
  const {notify}=useAppToast()
  const [confirmation,setConfirmation]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const expected=`删除 ${session.employee_no||''} ${String(session.id||'').slice(0,8)}`
  const remove=async()=>{
    setBusy(true);setError('')
    try{
      const {error:e}=await supabase.rpc('admin_exam_delete_current_session',{p_session_id:session.id,p_confirmation:confirmation})
      if(e)throw e
      notify({
        type:'success',module:TRAINING_TOAST_MODULE,operation:'删除考试记录',
        reason:'本系统考试记录及逐题答案已删除。',dedupeKey:'training:session:delete:success',
      })
      setBusy(false)
      await onDeleted()
    }catch(error){
      const reason=message(error)
      setError(reason)
      notify({
        type:'error',module:TRAINING_TOAST_MODULE,operation:'删除考试记录',reason,
        dedupeKey:'training:session:delete:error',retry:onRefreshConfirm,retryLabel:'刷新确认',
      })
      setBusy(false)
    }
  }
  return <Modal title="删除本系统考试记录" onClose={()=>!busy&&onClose()}><div className="exam-delete-confirm"><div className="exam-delete-warning"><b>此操作会删除本系统这场考试及其全部逐题答案。</b><span>仅持有敏感权限的账号可操作；旧考试记录不能通过此功能删除。</span></div><dl><div><dt>员工</dt><dd>{session.employee_no} · {session.employee_name}</dd></div><div><dt>考试</dt><dd>{session.title}</dd></div><div><dt>开始时间</dt><dd>{fmt(session.started_at)}</dd></div><div><dt>成绩</dt><dd>{score(session.earned_score)}/{score(session.total_score)} · {score(session.percentage)}%</dd></div></dl>{error&&<div className="exam-error">{error}</div>}<label>输入 <b>{expected}</b> 确认删除<input value={confirmation} onChange={e=>setConfirmation(e.target.value)} autoComplete="off" autoFocus/></label></div><footer><button disabled={busy} onClick={onClose}>取消</button><button className="danger" disabled={busy||confirmation!==expected} onClick={remove}>{busy?'删除中…':'永久删除记录'}</button></footer></Modal>
}

function QuestionModal({value,series,teams,positions,onClose,onSaved,onRefreshConfirm}){
  const {notify}=useAppToast()
  const [v,setV]=useState({...blankQuestion,...value})
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const editing=Boolean(v.id)
  const save=async()=>{
    setBusy(true);setError('')
    try{
      const {error:saveError}=await supabase.rpc('admin_exam_save_question',{p_question:v})
      if(saveError)throw saveError
      notify({
        type:'success',module:TRAINING_TOAST_MODULE,operation:editing?'编辑考试题目':'新增考试题目',
        reason:'题目已保存并等待 Google 同步。',dedupeKey:`training:question:${editing?'update':'create'}:success`,
      })
      setBusy(false)
      await onSaved()
    }catch(saveError){
      const reason=message(saveError)
      setError(reason)
      notify({
        type:'error',module:TRAINING_TOAST_MODULE,operation:editing?'编辑考试题目':'新增考试题目',reason,
        dedupeKey:`training:question:${editing?'update':'create'}:error`,
        retry:onRefreshConfirm,retryLabel:'刷新确认',
      })
      setBusy(false)
    }
  }
  return <Modal title={editing?'编辑考试题目':'新增考试题目'} onClose={onClose} wide>
    {error&&<div className="exam-error">{error}</div>}
    <div className="exam-form grid"><label>盘口（A 列）<input list="exam-series" value={v.series_name} onChange={e=>setV({...v,series_name:e.target.value})}/></label><label>团队（K 列）<input list="exam-teams" value={v.team_name} onChange={e=>setV({...v,team_name:e.target.value})}/></label><label>岗位<input list="exam-positions" value={v.position_name} onChange={e=>setV({...v,position_name:e.target.value})}/></label><datalist id="exam-series">{series.map(x=><option key={x} value={x}/>)}</datalist><datalist id="exam-teams">{teams.map(x=><option key={x} value={x}/>)}</datalist><datalist id="exam-positions">{positions.map(x=><option key={x} value={x}/>)}</datalist><label className="full">中文题目<textarea value={v.question_zh} onChange={e=>setV({...v,question_zh:e.target.value})}/></label><label className="full">英文题目<textarea value={v.question_en} onChange={e=>setV({...v,question_en:e.target.value})}/></label><label className="full">越南文题目<textarea value={v.question_vi} onChange={e=>setV({...v,question_vi:e.target.value})}/></label><label>分数<select value={v.points} onChange={e=>setV({...v,points:Number(e.target.value)})}><option>5</option><option>10</option><option>20</option></select></label><label>难度<select value={v.difficulty} onChange={e=>setV({...v,difficulty:Number(e.target.value)})}><option value="1">1 · 基础</option><option value="2">2 · 进阶</option><option value="3">3 · 困难</option></select></label><label className="full">图片链接（每行一个）<textarea value={(v.image_urls||[]).join('\n')} onChange={e=>setV({...v,image_urls:e.target.value.split('\n').map(x=>x.trim()).filter(Boolean).slice(0,3)})}/></label></div>
    <footer><button onClick={onClose}>取消</button><button className="primary" disabled={busy||!v.series_name||!v.team_name||!v.position_name||!(v.question_zh||v.question_en||v.question_vi)} onClick={save}>{busy?'保存中…':'保存并等待同步'}</button></footer>
  </Modal>
}

function AssignmentModal({value,teams,positions,onClose,onSaved}){
  const [v,setV]=useState({...value,question_rules:value.question_rules||{5:10,10:3,20:1}}),[busy,setBusy]=useState(false),[employeeSearch,setEmployeeSearch]=useState(''),[employees,setEmployees]=useState([]),[searching,setSearching]=useState(false),[formError,setFormError]=useState('')
  const findEmployees=async()=>{setSearching(true);const {data,error}=await supabase.rpc('admin_exam_employee_options',{p_search:employeeSearch,p_limit:20});setSearching(false);if(error)return setFormError(message(error));setEmployees(data||[])}
  const save=async()=>{setBusy(true);setFormError('');const {error}=await supabase.rpc('admin_exam_save_assignment',{p_data:v});setBusy(false);if(error)return setFormError(message(error));onSaved()}
  const setRule=(points,count)=>setV({...v,question_rules:{...v.question_rules,[points]:Math.max(0,Number(count)||0)}})
  return <Modal title={v.id?'编辑考试':'创建并分配考试'} onClose={onClose} wide><div className="exam-form grid">{formError&&<div className="exam-error full">{formError}</div>}<label className="full">考试名称<input value={v.title} onChange={e=>setV({...v,title:e.target.value})} placeholder="例如：AR印度出款月度考试"/></label><label>团队（盘口）<select value={v.team_name} onChange={e=>setV({...v,team_name:e.target.value,employee_id:''})}><option value="">请选择团队</option>{teams.map(x=><option key={x}>{x}</option>)}</select></label><label>岗位<select value={v.position_name} onChange={e=>setV({...v,position_name:e.target.value,employee_id:''})}><option value="">请选择岗位</option>{positions.map(x=><option key={x}>{x}</option>)}</select></label><div className="full assignment-target"><div><b>分配范围</b><p>不指定员工时，发布给相同团队＋岗位的全部在职员工。</p></div><div className="employee-picker"><input value={employeeSearch} onChange={e=>setEmployeeSearch(e.target.value)} onKeyDown={e=>e.key==='Enter'&&findEmployees()} placeholder="可选：搜索员工ID或姓名"/><button type="button" onClick={findEmployees}>{searching?'查询中…':'查找员工'}</button></div>{employees.length>0&&<div className="employee-results"><button className={!v.employee_id?'picked':''} onClick={()=>setV({...v,employee_id:''})}>全部匹配员工</button>{employees.map(x=><button key={x.id} className={v.employee_id===x.id?'picked':''} onClick={()=>setV({...v,employee_id:x.id,team_name:x.team_name||'',position_name:x.position_name||''})}><b>{x.employee_no} · {x.full_name}</b><small>{x.team_name||'—'} · {x.position_name||'—'}</small></button>)}</div>}</div><div className="full question-rules"><b>抽题规则</b>{[5,10,20].map(points=><label key={points}>{points} 分题<input type="number" min="0" max="100" value={v.question_rules?.[points]??0} onChange={e=>setRule(points,e.target.value)}/><span>道</span></label>)}</div><div className="inline full"><label>时长（分钟）<input type="number" min="5" max="240" value={v.duration_minutes} onChange={e=>setV({...v,duration_minutes:Number(e.target.value)})}/></label><label>及格分（%）<input type="number" min="0" max="100" value={v.pass_score} onChange={e=>setV({...v,pass_score:Number(e.target.value)})}/></label><label>最多次数<input type="number" min="1" max="20" value={v.max_attempts} onChange={e=>setV({...v,max_attempts:Number(e.target.value)})}/></label></div><label>开始时间<input type="datetime-local" value={v.start_at} onChange={e=>setV({...v,start_at:e.target.value})}/></label><label>结束时间（可空）<input type="datetime-local" value={v.end_at} onChange={e=>setV({...v,end_at:e.target.value})}/></label><label className="full">保存状态<select value={v.status||'draft'} onChange={e=>setV({...v,status:e.target.value})}><option value="draft">草稿（员工看不到）</option><option value="published">发布（员工立即可见）</option><option value="closed">关闭</option></select></label><p className="exam-note full">员工开始后题目会固定为快照；以后修改或删除题库，不会改变已经作答的历史试卷。</p></div><footer><button onClick={onClose}>取消</button><button className="primary" disabled={busy||!v.title||!v.team_name||!v.position_name} onClick={save}>{busy?'保存中…':v.status==='published'?'保存并发布':'保存草稿'}</button></footer></Modal>
}

function ExamPreview({value,onClose}){
  const [rows,setRows]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState('')
  useEffect(()=>{(async()=>{const {data,error:e}=await supabase.rpc('admin_exam_preview_questions',{p_team:value.team_name,p_position:value.position_name,p_rules:value.question_rules||{5:10,10:3,20:1}});if(e)setError(message(e));else setRows(data||[]);setLoading(false)})()},[value.id])
  return <Modal title={`员工前端预览 · ${value.title}`} onClose={onClose} wide><div className="preview-exam"><div className="preview-summary"><span>{value.team_name} · {value.position_name}</span><span>{value.duration_minutes} 分钟</span><span>及格 {value.pass_score}%</span><span>{rows.length} 题</span></div>{error&&<div className="exam-error">{error}</div>}{loading?<div className="exam-empty">正在生成安全预览…</div>:rows.length?<><div className="question-head"><span>第 1 题 / 共 {rows.length} 题</span><b>{rows[0].points} 分 · 难度 {rows[0].difficulty}</b></div><div className="runner-languages">{rows[0].question_zh&&<div><span>中</span><p>{rows[0].question_zh}</p></div>}{rows[0].question_en&&<div><span>EN</span><p>{rows[0].question_en}</p></div>}{rows[0].question_vi&&<div><span>VI</span><p>{rows[0].question_vi}</p></div>}</div><label className="preview-answer">填写答案<textarea disabled placeholder="员工将在这里填写完整回答…"/></label></>:<div className="exam-empty">该团队与岗位没有符合抽题规则的题目。</div>}</div><footer><button className="primary" onClick={onClose}>关闭预览</button></footer></Modal>
}

function EmployeeExamHistory({employee,onClose,onOpen}){
  const [data,setData]=useState(null),[error,setError]=useState('')
  useEffect(()=>{(async()=>{const {data:result,error:e}=await supabase.rpc('admin_employee_exam_history',{p_employee_id:employee.employee_id});if(e)setError(message(e));else setData(result)})()},[employee.employee_id])
  const person=data?.employee||employee,summary=data?.summary||{},rows=data?.history||[]
  return <Modal title={`${person.employee_no||''} · ${person.full_name||person.employee_name||''} · 全部考试记录`} onClose={onClose} wide>
    <div className="employee-exam-history">
      {error&&<div className="exam-error">{error}</div>}
      {!data?<div className="exam-empty">正在读取该员工全部考试记录…</div>:<>
        <div className="exam-history-summary"><span><small>累计考试</small><b>{summary.attempts||0} 次</b></span><span><small>已完成</small><b>{summary.graded||0} 次</b></span><span><small>已通过</small><b>{summary.passed||0} 次</b></span><span><small>平均分</small><b>{summary.average==null?'—':`${score(summary.average)}%`}</b></span></div>
        <div className="exam-table-wrap"><table className="exam-table"><thead><tr><th>考试</th><th>次数</th><th>提交时间</th><th>评分完成时间</th><th>得分</th><th>正确 / 半对 / 错误</th><th>评分人</th><th>结果</th><th>操作</th></tr></thead><tbody>{rows.map(x=><tr key={x.id}><td><strong>{x.title}</strong></td><td>第 {x.attempt_no} 次</td><td>{fmt(x.submitted_at)}</td><td>{fmt(x.graded_at)}</td><td>{x.percentage==null?'—':`${score(x.earned_score)}/${score(x.total_score)} · ${score(x.percentage)}%`}</td><td>{breakdown(x)}</td><td>{x.grader_name||'—'}</td><td><span className={`result-chip ${x.status==='graded'?(x.passed?'pass':'fail'):'pending'}`}>{statusText(x.status)}</span></td><td><button onClick={()=>onOpen({...x,employee_id:person.id,employee_no:person.employee_no,employee_name:person.full_name})}>查看答卷</button></td></tr>)}</tbody></table></div>
        {!rows.length&&<div className="exam-empty compact">该员工暂无考试记录</div>}
      </>}
    </div>
    <footer><button className="primary" onClick={onClose}>关闭</button></footer>
  </Modal>
}

function GradeModal({session,forceReadOnly=false,permissionPage='records',onClose,onChanged,onRefreshConfirm}){
  const {notify}=useAppToast()
  const [detail,setDetail]=useState(null),[error,setError]=useState(''),[drafts,setDrafts]=useState({}),[busy,setBusy]=useState('')
  const sourceReadOnly=session.source_system==='legacy'||session.read_only
  const readOnly=sourceReadOnly||forceReadOnly
  const load=async(operation='读取考试答卷')=>{
    const prefix=permissionPage==='grading'?'admin_exam_grading':'admin_exam_records'
    const rpc=sourceReadOnly?`${prefix}_legacy_detail`:`${prefix}_session_detail`
    setError('')
    try{
      const {data,error:e}=await supabase.rpc(rpc,{p_session_id:session.id})
      if(e)throw e
      setDetail(data)
      setDrafts(Object.fromEntries((data?.answers||[]).map(a=>[a.answer_id,{score:a.awarded_score??'',feedback:a.grader_feedback||''}])))
      return true
    }catch(loadError){
      const reason=message(loadError)
      setError(reason)
      notify({
        type:'error',module:TRAINING_TOAST_MODULE,operation,reason,
        dedupeKey:'training:answer-detail:read:error',retry:()=>load('重试读取考试答卷'),retryLabel:'重试',
      })
      return false
    }
  }
  useEffect(()=>{load()},[])
  const grade=async(a,status,score)=>{
    setBusy(a.answer_id);setError('')
    const feedback=drafts[a.answer_id]?.feedback||''
    try{
      const {error:e}=await supabase.rpc('admin_exam_grade_answer',{p_answer_id:a.answer_id,p_status:status,p_score:score,p_feedback:feedback})
      if(e)throw e
      notify({
        type:'success',module:TRAINING_TOAST_MODULE,operation:'保存答卷评分',
        reason:'本题评分与评语已保存。',dedupeKey:'training:answer:grade:success',
      })
      await load('评分后刷新答卷')
      await onChanged()
    }catch(gradeError){
      const reason=message(gradeError)
      setError(reason)
      notify({
        type:'error',module:TRAINING_TOAST_MODULE,operation:'保存答卷评分',reason,
        dedupeKey:'training:answer:grade:error',retry:onRefreshConfirm,retryLabel:'刷新确认',
      })
    }finally{setBusy('')}
  }
  const s=detail?.session||session,answers=detail?.answers||[]
  const hasDetail=s.source_system!=='legacy'||Boolean(s.answer_detail_available||answers.length)
  return <Modal title={`考试答卷 · ${session.employee_name} · 第 ${session.attempt_no} 次`} onClose={onClose} wide>
    <div className="grade-body">
      {error&&<div className="exam-error">{error}</div>}
      {readOnly&&<div className="legacy-readonly-note"><b>{s.source_system==='legacy'?'旧考试 · 只读记录':'只读记录'}</b><span>{hasDetail?'逐题题目、答案、得分与评语来自原记录。':'原系统只保留了本次总成绩，没有可核验的逐题答案。'}</span></div>}
      {detail?.session&&<>
        <div className="grade-summary"><span>{s.employee_no}</span><span>{s.team_name} · {s.position_name}</span><span>第 {s.attempt_no} 次</span><span>{statusText(s.status)}</span><span>{s.percentage==null?'待完成评分':`${score(s.earned_score)}/${score(s.total_score)} · ${score(s.percentage)}%`}</span></div>
        {hasDetail?<div className="grade-audit-grid"><span><small>已作答</small><b>{s.answer_detail_count||answers.length} / {s.total_question_count||s.answer_detail_count||answers.length} 题</b></span><span><small>未作答</small><b>{s.unanswered_count||0} 题</b></span><span><small>正确</small><b>{s.correct_count||0} 题</b></span><span><small>半对</small><b>{s.partial_count||0} 题</b></span><span><small>错误</small><b>{s.wrong_count||0} 题</b></span><span><small>待评分</small><b>{s.pending_count||0} 题</b></span><span><small>开始作答时间</small><b>{fmt(s.started_at)}</b></span><span><small>完成作答时间</small><b>{fmt(s.submitted_at)}</b></span><span><small>评分完成时间</small><b>{fmt(s.graded_at)}</b></span><span><small>评分人</small><b>{s.grader_name||'—'}</b></span></div>:<div className="exam-score-only-note"><b>总成绩已保留 · 逐题明细未同步</b><span>没有逐题答案，不能从总分可靠推算正确或错误题数。</span></div>}
      </>}
      {!detail?<div className="exam-empty">读取答卷中…</div>:answers.length?answers.map((a,i)=><article className="grade-item" key={a.answer_id||a.question_id}><header><b>{i+1}</b><strong>{a.question_zh||a.question_en||a.question_vi}</strong><span className={`grade-score-pill ${a.grade_status||'pending'}`}>{a.awarded_score==null||a.grade_status==='pending'?'待评分':Number(a.points)>0?`${score(a.awarded_score)}/${score(a.points)} 分`:`旧系统得分 ${score(a.awarded_score)}`}</span></header>{(a.question_en||a.question_vi)&&<details className="grade-translations"><summary>查看英文 / 越南文题目</summary>{a.question_en&&<p><b>EN</b>{a.question_en}</p>}{a.question_vi&&<p><b>VI</b>{a.question_vi}</p>}</details>}<ExamImageGallery urls={a.image_urls}/><div className="answer-box"><small>员工答案</small><p>{a.answer_text||'未作答'}</p></div>{readOnly?<div className="legacy-answer-feedback"><small>旧系统评语</small><p>{a.grader_feedback||'无评语'}</p></div>:<><label className="grade-feedback">老师评语<textarea value={drafts[a.answer_id]?.feedback||''} onChange={e=>setDrafts({...drafts,[a.answer_id]:{...drafts[a.answer_id],feedback:e.target.value}})} placeholder="填写错误原因、正确处理方式或复训要求"/></label>{a.graded_at&&<div className="grade-item-audit">本题评分：{a.grader_name||'—'} · {fmt(a.graded_at)}</div>}<div className="grade-actions"><button className={a.grade_status==='wrong'?'picked':''} disabled={busy===a.answer_id} onClick={()=>grade(a,'wrong',0)}>错误 · 0/{score(a.points)}</button><button className={a.grade_status==='partial'?'picked':''} disabled={busy===a.answer_id} onClick={()=>grade(a,'partial',a.points/2)}>半对 · {score(a.points/2)}/{score(a.points)}</button><button className={a.grade_status==='correct'?'picked':''} disabled={busy===a.answer_id} onClick={()=>grade(a,'correct',a.points)}>正确 · {score(a.points)}/{score(a.points)}</button></div></>}</article>):hasDetail&&<div className="exam-empty compact">没有可显示的逐题答卷</div>}
    </div>
    <footer><button className="primary" onClick={onClose}>{readOnly?'关闭':'完成并关闭'}</button></footer>
  </Modal>
}
