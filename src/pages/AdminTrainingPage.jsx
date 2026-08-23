import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { EmployeeDrawer } from './AdminEmployeesPage'

const TABS=['考试概览','考试记录','题库','人工批改']
const blankQuestion={series_name:'',team_name:'',position_name:'',question_en:'',question_zh:'',question_vi:'',points:5,difficulty:1,image_urls:[],active:true}
const blankSessionFilters={employeeNo:'',employeeName:'',exam:'',team:'',position:'',status:'',grader:'',source:'',dateFrom:'',dateTo:''}
const message=e=>e?.message||String(e||'操作失败')
const fmt=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—'
const score=v=>v==null?'—':Number(v).toLocaleString('zh-CN',{maximumFractionDigits:2})
const breakdown=x=>{
  const result=`正确 ${x.correct_count||0} · 半对 ${x.partial_count||0} · 错误 ${x.wrong_count||0} · 待评 ${x.pending_count||0}`
  if(x.source_system!=='legacy')return result
  if(!x.answer_detail_available)return x.percentage==null?'逐题明细等待同步':'总成绩已保留 · 逐题明细未同步'
  const total=Number(x.total_question_count||0),answered=Number(x.answer_detail_count||0)
  const unanswered=Number(x.unanswered_count??Math.max(total-answered,0))
  return `已答 ${answered}${total?`/${total}`:''} · 未答 ${unanswered} · ${result}`
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
  const tab=TABS.includes(params.get('tab'))?params.get('tab'):TABS[0]
  const [draft,setDraft]=useState({search:'',team:'',position:''})
  const [filters,setFilters]=useState(draft)
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(30)
  const [data,setData]=useState(null)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [question,setQuestion]=useState(null)
  const [questionView,setQuestionView]=useState(null)
  const [grading,setGrading]=useState(null)
  const [sessionDraft,setSessionDraft]=useState(blankSessionFilters)
  const [sessionFilters,setSessionFilters]=useState(blankSessionFilters)
  const [sessionPage,setSessionPage]=useState(1)
  const [sessionPageSize,setSessionPageSize]=useState(30)
  const [sessionData,setSessionData]=useState({rows:[],total:0})
  const [sessionLoading,setSessionLoading]=useState(false)
  const [employeeDetail,setEmployeeDetail]=useState(null)
  const [employeeDetailLoading,setEmployeeDetailLoading]=useState(false)

  const load=async()=>{
    setLoading(true);setError('')
    const [dashboard,analytics,legacy]=await Promise.all([
      supabase.rpc('admin_exam_dashboard',{p_search:filters.search,p_team:filters.team,p_position:filters.position,p_page:page,p_page_size:pageSize}),
      supabase.rpc('admin_exam_analytics_v3'),
      supabase.rpc('admin_legacy_exam_overview')
    ])
    if(dashboard.error||analytics.error||legacy.error)setError(message(dashboard.error||analytics.error||legacy.error)); else {
      const current=dashboard.data||{},old=legacy.data||{},currentCounts=current.counts||{},oldCounts=old.counts||{}
      const sessions=[...(current.sessions||[]),...(old.sessions||[])].sort((a,b)=>new Date(b.started_at||0)-new Date(a.started_at||0)).slice(0,12)
      setData({...current,analytics:analytics.data||current.analytics,legacy:old,sessions,counts:{...currentCounts,total_sessions:Number(currentCounts.total_sessions||0)+Number(oldCounts.total_sessions||0),pending_grading:Number(currentCounts.pending_grading||0)+Number(oldCounts.pending_grading||0),completed:Number(currentCounts.completed||0)+Number(oldCounts.completed||0)}})
    }
    setLoading(false)
  }
  useEffect(()=>{load()},[filters,page,pageSize])
  const loadSessions=async()=>{
    if(!['考试记录','人工批改'].includes(tab))return
    setSessionLoading(true);setError('')
    const forcedStatus=tab==='人工批改'?'pending':sessionFilters.status
    const {data:result,error:e}=await supabase.rpc('admin_exam_sessions_search_v3',{p_employee_no:sessionFilters.employeeNo,p_employee_name:sessionFilters.employeeName,p_exam:sessionFilters.exam,p_team:sessionFilters.team,p_position:sessionFilters.position,p_status:forcedStatus,p_grader:sessionFilters.grader,p_source:sessionFilters.source,p_date_from:sessionFilters.dateFrom||null,p_date_to:sessionFilters.dateTo||null,p_page:sessionPage,p_page_size:sessionPageSize})
    if(e)setError(message(e));else setSessionData(result||{rows:[],total:0})
    setSessionLoading(false)
  }
  useEffect(()=>{loadSessions()},[tab,sessionFilters,sessionPage,sessionPageSize])
  const setTab=x=>setParams(x===TABS[0]?{}:{tab:x})
  const apply=()=>{setPage(1);setFilters({...draft})}
  const reset=()=>{const x={search:'',team:'',position:''};setDraft(x);setFilters(x);setPage(1)}
  const applySessions=()=>{setSessionPage(1);setSessionFilters({...sessionDraft})}
  const resetSessions=()=>{setSessionDraft(blankSessionFilters);setSessionFilters(blankSessionFilters);setSessionPage(1)}
  const showEmployeeRecords=s=>{
    const next={...blankSessionFilters,employeeNo:s.employee_no||''}
    setSessionDraft(next);setSessionFilters(next);setSessionPage(1);setTab('考试记录')
  }
  const openEmployee=async s=>{
    if(!s.employee_id)return
    setEmployeeDetail({employee:{id:s.employee_id,employee_no:s.employee_no,full_name:s.employee_name},missing_fields:[]})
    setEmployeeDetailLoading(true);setError('')
    const {data:detail,error:e}=await supabase.functions.invoke('admin-employees',{body:{action:'detail',employee_id:s.employee_id}})
    if(e||detail?.error){setError(message(e||detail?.error));setEmployeeDetail(null)}else setEmployeeDetail(detail)
    setEmployeeDetailLoading(false)
  }
  const counts=data?.counts||{}

  return <div className="exam-page">
    <header className="exam-head"><div><small>EXAM MANAGEMENT</small><h1>考试管理</h1></div><div className="exam-head-actions"><span className="exam-sync-pill">Google 题库 · {data?.last_sync?.status==='success'?'已同步':'等待同步'}</span><span className={`exam-sync-pill legacy ${data?.legacy?.sync_state?.status||''}`} title={data?.legacy?.sync_state?.last_error||''}>旧考试 · {data?.legacy?.sync_state?.status==='success'?'自动同步正常':data?.legacy?.sync_state?.status==='error'&&String(data?.legacy?.sync_state?.last_error||'').includes('402')?'来源暂停':data?.legacy?.sync_state?.status==='error'?'同步异常':'等待同步'}</span><button onClick={load}>刷新</button></div></header>
    {error&&<div className="exam-error">{error}<button onClick={()=>setError('')}>×</button></div>}
    <nav className="exam-tabs">{TABS.map(x=><button key={x} className={x===tab?'active':''} onClick={()=>setTab(x)}>{x}</button>)}</nav>

    {tab==='考试概览'&&<Overview counts={counts} data={data} onTab={setTab} onEmployee={showEmployeeRecords}/>}
    {tab==='题库'&&<>
      <FilterBar draft={draft} setDraft={setDraft} data={data} onApply={apply} onReset={reset}/>
      <section className="exam-panel"><div className="exam-section-title"><div><h2>考试题库</h2></div><button className="primary" onClick={()=>setQuestion({...blankQuestion,team_name:draft.team,position_name:draft.position})}>＋ 新增题目</button></div>
      <QuestionTable data={data} loading={loading} page={page} setPage={setPage} pageSize={pageSize} setPageSize={x=>{setPage(1);setPageSize(x)}} onView={setQuestionView} onEdit={setQuestion} onChanged={load} setError={setError}/></section>
    </>}
    {['考试记录','人工批改'].includes(tab)&&<SessionFilterBar draft={sessionDraft} setDraft={setSessionDraft} data={data} tab={tab} onApply={applySessions} onReset={resetSessions}/>}
    {tab==='考试记录'&&<Sessions rows={sessionData.rows||[]} total={sessionData.total||0} page={sessionPage} pageSize={sessionPageSize} setPage={setSessionPage} setPageSize={x=>{setSessionPage(1);setSessionPageSize(x)}} loading={sessionLoading} onEmployee={showEmployeeRecords} onEmployeeArchive={openEmployee} onOpen={open=>setGrading({session:open,detail:null})}/>}
    {tab==='人工批改'&&<Sessions rows={sessionData.rows||[]} total={sessionData.total||0} page={sessionPage} pageSize={sessionPageSize} setPage={setSessionPage} setPageSize={x=>{setSessionPage(1);setSessionPageSize(x)}} loading={sessionLoading} onEmployee={showEmployeeRecords} onEmployeeArchive={openEmployee} onOpen={open=>setGrading({session:open,detail:null})} grading/>}
    {question&&<QuestionModal value={question} series={data?.series||[]} teams={data?.teams||[]} positions={data?.positions||[]} onClose={()=>setQuestion(null)} onSaved={()=>{setQuestion(null);load()}}/>}
    {questionView&&<QuestionView value={questionView} onClose={()=>setQuestionView(null)} onEdit={()=>{setQuestion(questionView);setQuestionView(null)}}/>}
    {grading&&<GradeModal session={grading.session} onClose={()=>setGrading(null)} onChanged={()=>{load();loadSessions()}}/>} 
    {employeeDetail&&<EmployeeDrawer detail={employeeDetail} loading={employeeDetailLoading} readOnly onClose={()=>setEmployeeDetail(null)}/>}
  </div>
}

function Overview({counts,data,onTab,onEmployee}){
  const analytics=data?.analytics||{},summary=analytics.summary||{}
  const old=data?.legacy?.counts||{},sync=data?.legacy?.sync_state||{}
  const sourcePaused=sync.status==='error'&&String(sync.last_error||'').includes('402')
  const daily=recentDays(analytics.daily_activity,7)
  const cards=[
    ['题库',counts.questions||0,'题库','题目'],['记录',counts.total_sessions||0,'考试记录','全部'],['待批改',counts.pending_grading||0,'人工批改','份'],['已完成',counts.completed||0,'考试记录','份'],
    ['本系统',summary.current_attempts||0,null,'份'],['旧考试',old.total_sessions||0,null,`已评 ${old.completed||0} · 待评 ${old.pending_grading||0}`],['已匹配',old.matched||0,null,`未匹配 ${old.unmatched||0}`],['同步',sync.status==='success'?'正常':sourcePaused?'来源暂停':sync.status==='error'?'异常':'等待',null,sourcePaused?'朋友项目返回 402 · 本地记录已保留':sync.last_success_at?fmt(sync.last_success_at):'等待首次同步']
  ]
  return <><section className="exam-overview-strip">{cards.map(([label,value,target,note],index)=>{const content=<><span>{label}</span><strong>{value}</strong><small>{note}{target?' · 查看 →':''}</small></>;return target?<button key={label} onClick={()=>onTab(target)}>{content}</button>:<div key={label} className={index===5?'legacy':''}>{content}</div>})}</section><div className="exam-two exam-overview-lower"><section className="exam-panel exam-recent-panel"><div className="exam-section-title"><div><h2>最近考试</h2><p>近 7 天每日提交与最新记录</p></div><button onClick={()=>onTab('考试记录')}>查看全部</button></div><div className="exam-daily-strip">{daily.map((x,index)=><div key={x.activity_day} className={index===0?'today':''}><span>{index===0?'今日':String(x.activity_day).slice(5)}</span><strong>{x.submitted} 份</strong><small>本系统 {x.current_submitted} · 旧考试 {x.legacy_submitted}</small><small>已评 {x.graded} · 待评 {x.pending}</small></div>)}</div><div className="exam-recent-scroll"><Sessions rows={(data?.sessions||[]).slice(0,12)} compact onEmployee={onEmployee}/></div></section><section className="exam-panel adaptive-rule-panel"><h2>考试规则</h2><div><b>仅匹配团队</b><span>员工自行选择岗位与盘口</span></div><div><b>14 题 · 100 分</b><span>10×5分＋3×10分＋1×20分</span></div><div><b>60 分钟</b><span>连续计时 · 自动保存</span></div></section></div><ExamAnalytics analytics={analytics} onEmployee={onEmployee}/></>
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

function QuestionTable({data,loading,page,setPage,pageSize,setPageSize,onView,onEdit,onChanged,setError}){
  const rows=data?.questions||[],pages=Math.max(1,Math.ceil((data?.total||0)/(data?.page_size||pageSize)))
  const deleteQuestion=async q=>{if(!confirm(`确认删除题目 ${q.external_key}？\n历史考试仍会保留题目快照，Google 表格将在双向同步接通后删除对应行。`))return;const {error}=await supabase.rpc('admin_exam_delete_question',{p_question_id:q.id});if(error)return setError(message(error));onChanged()}
  const nums=pageNumbers(page,pages)
  return <>{loading?<div className="exam-empty">正在读取题库…</div>:!rows.length?<div className="exam-empty">没有符合条件的题目</div>:<div className="exam-table-wrap"><table className="exam-table exam-question-table"><thead><tr><th>题目ID</th><th>团队</th><th>岗位</th><th>英文</th><th>中文</th><th>越南文</th><th>分数</th><th>难度</th><th>图片</th><th>同步</th><th>操作</th></tr></thead><tbody>{rows.map(q=><tr key={q.id}><td><button className="exam-id-link" onClick={()=>onView(q)}>{q.external_key}</button></td><td>{q.team_name}</td><td>{q.position_name}</td><LanguageCell label="英文" text={q.question_en} onOpen={()=>onView(q)}/><LanguageCell label="中文" text={q.question_zh} onOpen={()=>onView(q)}/><LanguageCell label="越南文" text={q.question_vi} onOpen={()=>onView(q)}/><td><b>{q.points}</b></td><td>{q.difficulty}</td><td>{q.image_urls?.length||0}</td><td><span className={`sync-${q.sync_status}`}>{q.sync_status==='synced'?'已同步':'待回写'}</span></td><td><div className="exam-row-actions"><button onClick={()=>onEdit(q)}>编辑</button><button className="danger" onClick={()=>deleteQuestion(q)}>删除</button></div></td></tr>)}</tbody></table></div>}<footer className="exam-pager"><div className="exam-page-size"><span>共 {data?.total||0} 题</span><select value={pageSize} onChange={e=>setPageSize(Number(e.target.value))}><option value="20">20 条 / 页</option><option value="30">30 条 / 页</option><option value="50">50 条 / 页</option></select></div><div className="exam-page-buttons"><button disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</button>{nums.map((n,i)=>n==='…'?<span key={`dots-${i}`} className="pager-dots">…</span>:<button key={n} className={n===page?'active':''} onClick={()=>setPage(n)}>{n}</button>)}<button disabled={page>=pages} onClick={()=>setPage(page+1)}>下一页</button></div></footer></>
}

const pageNumbers=(page,pages)=>{if(pages<=7)return Array.from({length:pages},(_,i)=>i+1);const out=[1],start=Math.max(2,page-1),end=Math.min(pages-1,page+1);if(start>2)out.push('…');for(let i=start;i<=end;i++)out.push(i);if(end<pages-1)out.push('…');out.push(pages);return out}
function LanguageCell({label,text,onOpen}){return <td className="question-language"><button title={`查看${label}全文`} onClick={onOpen}>{text||'—'}</button></td>}

function QuestionView({value,onClose,onEdit}){return <Modal title={`${value.external_key} · 三语题目`} onClose={onClose} wide><div className="question-detail"><div className="question-detail-meta"><span>盘口 <b>{value.series_name}</b></span><span>团队 <b>{value.team_name}</b></span><span>岗位 <b>{value.position_name}</b></span><span>分数 <b>{value.points}</b></span><span>难度 <b>{value.difficulty}</b></span></div><LanguageBlock tag="EN" title="英文" text={value.question_en}/><LanguageBlock tag="中" title="中文" text={value.question_zh}/><LanguageBlock tag="VI" title="越南文" text={value.question_vi}/>{value.image_urls?.length>0&&<div className="question-images detail">{value.image_urls.map(u=><a href={u} target="_blank" rel="noreferrer" key={u}><img src={u}/></a>)}</div>}</div><footer><button onClick={onClose}>关闭</button><button className="primary" onClick={onEdit}>编辑题目</button></footer></Modal>}
function LanguageBlock({tag,title,text}){return <section className="question-language-block"><span>{tag}</span><div><b>{title}</b><p>{text||'未填写'}</p></div></section>}

function Assignments({data,onNew,onEdit,onPreview,onChanged,setError}){
  const remove=async a=>{if(!confirm(`确认删除考试“${a.title}”？\n已有作答记录时将改为关闭，历史成绩不会丢失。`))return;const {error}=await supabase.rpc('admin_exam_delete_assignment',{p_assignment_id:a.id});if(error)return setError(message(error));onChanged()}
  return <section className="exam-panel"><div className="exam-section-title"><div><h2>创建与分配考试</h2><p>先保存草稿并预览员工画面；确认后再发布给相同团队＋岗位或指定员工。</p></div><button className="primary" onClick={onNew}>＋ 创建考试</button></div><div className="exam-table-wrap"><table className="exam-table"><thead><tr><th>考试名称</th><th>分配范围</th><th>时长</th><th>及格分</th><th>次数</th><th>有效期</th><th>状态</th><th>操作</th></tr></thead><tbody>{(data?.assignments||[]).map(a=><tr key={a.id}><td><strong>{a.title}</strong></td><td>{a.employee_no?<><b>{a.employee_no}</b><br/>{a.employee_name}</>:<>{a.team_name} · {a.position_name}</>}</td><td>{a.duration_minutes}分钟</td><td>{a.pass_score}%</td><td>{a.max_attempts}</td><td>{fmt(a.start_at)}<br/>{fmt(a.end_at)}</td><td><span className={`assignment-status ${a.status}`}>{({draft:'草稿',published:'已发布',closed:'已关闭'}[a.status]||a.status)}</span></td><td><div className="exam-row-actions"><button onClick={()=>onPreview(a)}>预览</button><button onClick={()=>onEdit({...a,start_at:a.start_at?new Date(a.start_at).toISOString().slice(0,16):'',end_at:a.end_at?new Date(a.end_at).toISOString().slice(0,16):'',question_rules:a.question_rules||{5:10,10:3,20:1}})}>编辑</button><button className="danger" onClick={()=>remove(a)}>删除</button></div></td></tr>)}</tbody></table>{!(data?.assignments||[]).length&&<div className="exam-empty compact">还没有考试，点击“创建考试”先保存草稿并预览。</div>}</div></section>
}

function Sessions({rows,onOpen,onEmployee,onEmployeeArchive,compact=false,grading=false,loading=false,total=0,page=1,pageSize=30,setPage,setPageSize}){
  if(compact)return rows.length?<>{rows.map(s=><button className="exam-line exam-recent-line" key={`${s.source_system||'current'}-${s.id}`} onClick={()=>onEmployee?.(s)}><div><strong>{s.employee_name} · {s.title} {s.source_system==='legacy'&&<em className="exam-source-badge legacy">旧考试</em>}</strong><small>第 {s.attempt_no} 次 · {fmt(s.submitted_at||s.started_at)}</small><small className="exam-recent-result">{s.status==='graded'?`${score(s.earned_score)}/${score(s.total_score)} · ${breakdown(s)}`:statusText(s.status)}</small></div><span>{s.status==='graded'?(s.passed?'通过':'未通过'):statusText(s.status)}</span></button>)}</>:<div className="exam-empty compact">暂时没有考试记录</div>
  const pages=Math.max(1,Math.ceil(total/pageSize))
  return <section className="exam-panel"><div className="exam-section-title"><div><h2>{grading?'待人工批改':'员工考试记录与成绩'}</h2><p>本系统与旧考试统一查询；旧考试为只读记录。</p></div><span className="exam-total-pill">共 {total} 条</span></div>{loading?<div className="exam-empty">正在查询考试记录…</div>:!rows.length?<div className="exam-empty">{grading?'当前没有待批改考试':'没有符合条件的考试记录'}</div>:<div className="exam-table-wrap"><table className="exam-table exam-session-table"><thead><tr><th>来源</th><th>员工ID</th><th>姓名</th><th>团队 / 岗位</th><th>考试</th><th>次数</th><th>开始作答时间</th><th>完成作答时间</th><th>评分完成时间</th><th>得分</th><th>答题结果</th><th>评分人</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(s=><tr key={`${s.source_system||'current'}-${s.id}`}><td><span className={`exam-source-badge ${s.source_system==='legacy'?'legacy':'current'}`}>{s.source_label||'本系统'}</span></td><td>{s.employee_id?<button className="exam-record-id" onClick={()=>onEmployeeArchive?.(s)}>{s.employee_no}</button>:<span>{s.employee_no}</span>}</td><td><button className="exam-record-name" onClick={()=>onEmployee?.(s)}>{s.employee_name}</button>{s.employee_match_status==='unmatched'&&<small className="exam-unmatched">未匹配员工档案</small>}</td><td>{s.team_name||'—'}<br/><small>{s.position_name||'—'}</small></td><td>{s.title}</td><td><b>第 {s.attempt_no} 次</b></td><td>{fmt(s.started_at)}</td><td>{fmt(s.submitted_at)}</td><td>{fmt(s.graded_at)}</td><td><b>{s.percentage==null?'—':`${score(s.earned_score)}/${score(s.total_score)}`}</b>{s.percentage!=null&&<small className="exam-record-percent">{score(s.percentage)}%</small>}</td><td><span className="exam-record-breakdown">{breakdown(s)} · 待评 {s.pending_count||0}</span></td><td>{s.grader_name||'—'}</td><td><span className={`result-chip ${s.status==='graded'?(s.passed?'pass':'fail'):'pending'}`}>{statusText(s.status)}</span></td><td>{onOpen&&<button onClick={()=>onOpen(s)}>{s.read_only?'查看详情':grading?'开始批改':'查看答卷'}</button>}</td></tr>)}</tbody></table></div>}{setPage&&<footer className="exam-pager"><div className="exam-page-size"><span>第 {page} / {pages} 页</span><select value={pageSize} onChange={e=>setPageSize(Number(e.target.value))}><option value="20">20 条 / 页</option><option value="30">30 条 / 页</option><option value="50">50 条 / 页</option></select></div><div className="exam-page-buttons"><button disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</button>{pageNumbers(page,pages).map((n,i)=>n==='…'?<span key={i} className="pager-dots">…</span>:<button key={n} className={n===page?'active':''} onClick={()=>setPage(n)}>{n}</button>)}<button disabled={page>=pages} onClick={()=>setPage(page+1)}>下一页</button></div></footer>}</section>
}
const statusText=x=>({in_progress:'答题中',submitted:'待批改',grading:'批改中',graded:'已完成',expired:'已过期'}[x]||x)

function Modal({title,onClose,children,wide=false}){return <div className="exam-modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><div className={`exam-modal ${wide?'wide':''}`}><header><h2>{title}</h2><button onClick={onClose}>×</button></header>{children}</div></div>}

function QuestionModal({value,series,teams,positions,onClose,onSaved}){const [v,setV]=useState({...blankQuestion,...value});const [busy,setBusy]=useState(false);const save=async()=>{setBusy(true);const {error}=await supabase.rpc('admin_exam_save_question',{p_question:v});setBusy(false);if(error)return alert(message(error));onSaved()};return <Modal title={v.id?'编辑考试题目':'新增考试题目'} onClose={onClose} wide><div className="exam-form grid"><label>盘口（A 列）<input list="exam-series" value={v.series_name} onChange={e=>setV({...v,series_name:e.target.value})}/></label><label>团队（K 列）<input list="exam-teams" value={v.team_name} onChange={e=>setV({...v,team_name:e.target.value})}/></label><label>岗位<input list="exam-positions" value={v.position_name} onChange={e=>setV({...v,position_name:e.target.value})}/></label><datalist id="exam-series">{series.map(x=><option key={x} value={x}/>)}</datalist><datalist id="exam-teams">{teams.map(x=><option key={x} value={x}/>)}</datalist><datalist id="exam-positions">{positions.map(x=><option key={x} value={x}/>)}</datalist><label className="full">中文题目<textarea value={v.question_zh} onChange={e=>setV({...v,question_zh:e.target.value})}/></label><label className="full">英文题目<textarea value={v.question_en} onChange={e=>setV({...v,question_en:e.target.value})}/></label><label className="full">越南文题目<textarea value={v.question_vi} onChange={e=>setV({...v,question_vi:e.target.value})}/></label><label>分数<select value={v.points} onChange={e=>setV({...v,points:Number(e.target.value)})}><option>5</option><option>10</option><option>20</option></select></label><label>难度<select value={v.difficulty} onChange={e=>setV({...v,difficulty:Number(e.target.value)})}><option value="1">1 · 基础</option><option value="2">2 · 进阶</option><option value="3">3 · 困难</option></select></label><label className="full">图片链接（每行一个）<textarea value={(v.image_urls||[]).join('\n')} onChange={e=>setV({...v,image_urls:e.target.value.split('\n').map(x=>x.trim()).filter(Boolean).slice(0,3)})}/></label></div><footer><button onClick={onClose}>取消</button><button className="primary" disabled={busy||!v.series_name||!v.team_name||!v.position_name||!(v.question_zh||v.question_en||v.question_vi)} onClick={save}>{busy?'保存中…':'保存并等待同步'}</button></footer></Modal>}

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

function GradeModal({session,onClose,onChanged}){
  const [detail,setDetail]=useState(null),[error,setError]=useState(''),[drafts,setDrafts]=useState({}),[busy,setBusy]=useState('')
  const readOnly=session.source_system==='legacy'||session.read_only
  const load=async()=>{const rpc=readOnly?'admin_legacy_exam_session_detail':'admin_exam_session_detail';const {data,error:e}=await supabase.rpc(rpc,{p_session_id:session.id});if(e)setError(message(e));else{setDetail(data);setDrafts(Object.fromEntries((data?.answers||[]).map(a=>[a.answer_id,{score:a.awarded_score??'',feedback:a.grader_feedback||''}])))} }
  useEffect(()=>{load()},[])
  const grade=async(a,status,score)=>{setBusy(a.answer_id);const feedback=drafts[a.answer_id]?.feedback||'';const {error:e}=await supabase.rpc('admin_exam_grade_answer',{p_answer_id:a.answer_id,p_status:status,p_score:score,p_feedback:feedback});setBusy('');if(e)return setError(message(e));await load();onChanged()}
  const s=detail?.session||{}
  return <Modal title={`考试答卷 · ${session.employee_name} · 第 ${session.attempt_no} 次`} onClose={onClose} wide><div className="grade-body">{error&&<div className="exam-error">{error}</div>}{readOnly&&<div className="legacy-readonly-note"><b>旧考试 · 只读记录</b><span>题目、员工答案、每题满分、实际得分与评语均来自旧系统；尚未评分的题目会明确标为“待评分”。</span></div>}{detail?.session&&<><div className="grade-summary"><span>{s.employee_no}</span><span>{s.team_name} · {s.position_name}</span><span>第 {s.attempt_no} 次</span><span>{statusText(s.status)}</span><span>{s.percentage==null?'待完成评分':`${score(s.earned_score)}/${score(s.total_score)} · ${score(s.percentage)}%`}</span></div><div className="grade-audit-grid"><span><small>已作答</small><b>{s.answer_detail_count||0} / {s.total_question_count||s.answer_detail_count||0} 题</b></span><span><small>未作答</small><b>{s.unanswered_count||0} 题</b></span><span><small>正确</small><b>{s.correct_count||0} 题</b></span><span><small>半对</small><b>{s.partial_count||0} 题</b></span><span><small>错误</small><b>{s.wrong_count||0} 题</b></span><span><small>待评分</small><b>{s.pending_count||0} 题</b></span><span><small>开始作答时间</small><b>{fmt(s.started_at)}</b></span><span><small>完成作答时间</small><b>{fmt(s.submitted_at)}</b></span><span><small>评分完成时间</small><b>{fmt(s.graded_at)}</b></span><span><small>评分人</small><b>{s.grader_name||'—'}</b></span></div></>}{!detail?<div className="exam-empty">读取答卷中…</div>:(detail.answers||[]).map((a,i)=><article className="grade-item" key={a.answer_id||a.question_id}><header><b>{i+1}</b><strong>{a.question_zh||a.question_en||a.question_vi}</strong><span className={`grade-score-pill ${a.grade_status||'pending'}`}>{a.awarded_score==null||a.grade_status==='pending'?'待评分':Number(a.points)>0?`${score(a.awarded_score)}/${score(a.points)} 分`:`旧系统得分 ${score(a.awarded_score)}`}</span></header>{(a.question_en||a.question_vi)&&<details className="grade-translations"><summary>查看英文 / 越南文题目</summary>{a.question_en&&<p><b>EN</b>{a.question_en}</p>}{a.question_vi&&<p><b>VI</b>{a.question_vi}</p>}</details>}{a.image_urls?.length>0&&<div className="question-images">{a.image_urls.map(u=><a href={u} target="_blank" rel="noreferrer" key={u}><img src={u}/></a>)}</div>}<div className="answer-box"><small>员工答案</small><p>{a.answer_text||'未作答'}</p></div>{readOnly?<div className="legacy-answer-feedback"><small>旧系统评语</small><p>{a.grader_feedback||'无评语'}</p></div>:<><label className="grade-feedback">老师评语<textarea value={drafts[a.answer_id]?.feedback||''} onChange={e=>setDrafts({...drafts,[a.answer_id]:{...drafts[a.answer_id],feedback:e.target.value}})} placeholder="填写错误原因、正确处理方式或复训要求"/></label>{a.graded_at&&<div className="grade-item-audit">本题评分：{a.grader_name||'—'} · {fmt(a.graded_at)}</div>}<div className="grade-actions"><button className={a.grade_status==='wrong'?'picked':''} disabled={busy===a.answer_id} onClick={()=>grade(a,'wrong',0)}>错误 · 0/{score(a.points)}</button><button className={a.grade_status==='partial'?'picked':''} disabled={busy===a.answer_id} onClick={()=>grade(a,'partial',a.points/2)}>半对 · {score(a.points/2)}/{score(a.points)}</button><button className={a.grade_status==='correct'?'picked':''} disabled={busy===a.answer_id} onClick={()=>grade(a,'correct',a.points)}>正确 · {score(a.points)}/{score(a.points)}</button></div></>}</article>)}</div><footer><button className="primary" onClick={onClose}>{readOnly?'关闭':'完成并关闭'}</button></footer></Modal>
}
