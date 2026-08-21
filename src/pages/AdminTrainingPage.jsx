import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const TABS=['考试概览','考试记录','题库','创建 / 分配考试','人工批改','成绩统计']
const blankQuestion={team_name:'',position_name:'',question_en:'',question_zh:'',question_vi:'',points:5,difficulty:1,image_urls:[],active:true}
const message=e=>e?.message||String(e||'操作失败')
const fmt=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—'

export default function AdminTrainingPage(){
  const [params,setParams]=useSearchParams()
  const tab=TABS.includes(params.get('tab'))?params.get('tab'):TABS[0]
  const [draft,setDraft]=useState({search:'',team:'',position:''})
  const [filters,setFilters]=useState(draft)
  const [page,setPage]=useState(1)
  const [data,setData]=useState(null)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [question,setQuestion]=useState(null)
  const [assignment,setAssignment]=useState(null)
  const [grading,setGrading]=useState(null)

  const load=async()=>{
    setLoading(true);setError('')
    const {data:result,error:e}=await supabase.rpc('admin_exam_dashboard',{p_search:filters.search,p_team:filters.team,p_position:filters.position,p_page:page,p_page_size:30})
    if(e)setError(message(e)); else setData(result)
    setLoading(false)
  }
  useEffect(()=>{load()},[filters,page])
  const setTab=x=>setParams(x===TABS[0]?{}:{tab:x})
  const apply=()=>{setPage(1);setFilters({...draft})}
  const reset=()=>{const x={search:'',team:'',position:''};setDraft(x);setFilters(x);setPage(1)}
  const counts=data?.counts||{}

  return <div className="exam-page">
    <header className="exam-head"><div><small>TRAINING & EXAM</small><h1>培训与考试</h1><p>题库按团队＋岗位分配；员工在前端答题，后台统一批改与统计。</p></div><div className="exam-head-actions"><span className="exam-sync-pill">Google 题库 · {data?.last_sync?.status==='success'?'已同步':'等待同步'}</span><button onClick={load}>刷新</button></div></header>
    {error&&<div className="exam-error">{error}<button onClick={()=>setError('')}>×</button></div>}
    <nav className="exam-tabs">{TABS.map(x=><button key={x} className={x===tab?'active':''} onClick={()=>setTab(x)}>{x}</button>)}</nav>

    {tab==='考试概览'&&<Overview counts={counts} data={data} onTab={setTab}/>} 
    {tab==='题库'&&<>
      <FilterBar draft={draft} setDraft={setDraft} data={data} onApply={apply} onReset={reset}/>
      <section className="exam-panel"><div className="exam-section-title"><div><h2>考试题库</h2><p>Google 表格中的“盘口”对应团队，题目仅匹配同团队、同岗位员工。</p></div><button className="primary" onClick={()=>setQuestion({...blankQuestion,team_name:draft.team,position_name:draft.position})}>＋ 新增题目</button></div>
      <QuestionTable data={data} loading={loading} page={page} setPage={setPage} onEdit={setQuestion}/></section>
    </>}
    {tab==='创建 / 分配考试'&&<Assignments data={data} onNew={()=>setAssignment({title:'',team_name:'',position_name:'',duration_minutes:60,pass_score:60,max_attempts:1,start_at:new Date().toISOString().slice(0,16),end_at:''})}/>} 
    {tab==='考试记录'&&<Sessions rows={data?.sessions||[]} onOpen={open=>setGrading({session:open,detail:null})}/>} 
    {tab==='人工批改'&&<Sessions rows={(data?.sessions||[]).filter(x=>['submitted','grading'].includes(x.status))} onOpen={open=>setGrading({session:open,detail:null})} grading/>}
    {tab==='成绩统计'&&<Stats rows={data?.sessions||[]}/>} 
    {question&&<QuestionModal value={question} teams={data?.teams||[]} positions={data?.positions||[]} onClose={()=>setQuestion(null)} onSaved={()=>{setQuestion(null);load()}}/>}
    {assignment&&<AssignmentModal value={assignment} teams={data?.teams||[]} positions={data?.positions||[]} onClose={()=>setAssignment(null)} onSaved={()=>{setAssignment(null);load()}}/>}
    {grading&&<GradeModal session={grading.session} onClose={()=>setGrading(null)} onChanged={load}/>} 
  </div>
}

function Overview({counts,data,onTab}){
  const cards=[['题库题目',counts.questions||0,'题库'],['已发布考试',counts.assignments||0,'创建 / 分配考试'],['待人工批改',counts.pending_grading||0,'人工批改'],['已完成考试',counts.completed||0,'考试记录']]
  return <><div className="exam-metrics">{cards.map(([l,v,t])=><button key={l} onClick={()=>onTab(t)}><span>{l}</span><strong>{v}</strong><small>查看详情 →</small></button>)}</div><div className="exam-two"><section className="exam-panel"><h2>最近考试</h2><Sessions rows={(data?.sessions||[]).slice(0,8)} compact/></section><section className="exam-panel"><h2>当前分配</h2>{(data?.assignments||[]).slice(0,8).map(a=><div className="exam-line" key={a.id}><div><strong>{a.title}</strong><small>{a.team_name} · {a.position_name}</small></div><span>{a.status==='published'?'进行中':a.status}</span></div>)}</section></div></>
}

function FilterBar({draft,setDraft,data,onApply,onReset}){return <section className="exam-filter"><input value={draft.search} onChange={e=>setDraft({...draft,search:e.target.value})} onKeyDown={e=>e.key==='Enter'&&onApply()} placeholder="搜索题目ID或英 / 中 / 越文内容"/><select value={draft.team} onChange={e=>setDraft({...draft,team:e.target.value})}><option value="">全部团队</option>{(data?.teams||[]).map(x=><option key={x}>{x}</option>)}</select><select value={draft.position} onChange={e=>setDraft({...draft,position:e.target.value})}><option value="">全部岗位</option>{(data?.positions||[]).map(x=><option key={x}>{x}</option>)}</select><button className="primary" onClick={onApply}>查询</button><button onClick={onReset}>重置</button></section>}

function QuestionTable({data,loading,page,setPage,onEdit}){const rows=data?.questions||[];const pages=Math.max(1,Math.ceil((data?.total||0)/(data?.page_size||30)));return <>{loading?<div className="exam-empty">正在读取题库…</div>:!rows.length?<div className="exam-empty">没有符合条件的题目</div>:<div className="exam-table-wrap"><table className="exam-table"><thead><tr><th>题目ID</th><th>团队</th><th>岗位</th><th>中文题目</th><th>分数</th><th>难度</th><th>图片</th><th>同步</th><th>操作</th></tr></thead><tbody>{rows.map(q=><tr key={q.id}><td>{q.external_key}</td><td>{q.team_name}</td><td>{q.position_name}</td><td className="question-copy">{q.question_zh||q.question_en||q.question_vi}</td><td>{q.points}</td><td>{q.difficulty}</td><td>{q.image_urls?.length||0}</td><td><span className={`sync-${q.sync_status}`}>{q.sync_status==='synced'?'已同步':'待回写'}</span></td><td><button onClick={()=>onEdit(q)}>编辑</button></td></tr>)}</tbody></table></div>}<footer className="exam-pager"><span>共 {data?.total||0} 题</span><div><button disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</button><b>{page} / {pages}</b><button disabled={page>=pages} onClick={()=>setPage(page+1)}>下一页</button></div></footer></>}

function Assignments({data,onNew}){return <section className="exam-panel"><div className="exam-section-title"><div><h2>创建与分配考试</h2><p>发布后只会出现在相同团队＋岗位员工的考试前端。</p></div><button className="primary" onClick={onNew}>＋ 创建考试</button></div><div className="exam-table-wrap"><table className="exam-table"><thead><tr><th>考试名称</th><th>团队</th><th>岗位</th><th>时长</th><th>及格分</th><th>次数</th><th>有效期</th><th>状态</th></tr></thead><tbody>{(data?.assignments||[]).map(a=><tr key={a.id}><td><strong>{a.title}</strong></td><td>{a.team_name}</td><td>{a.position_name}</td><td>{a.duration_minutes}分钟</td><td>{a.pass_score}%</td><td>{a.max_attempts}</td><td>{fmt(a.start_at)}<br/>{fmt(a.end_at)}</td><td>{a.status}</td></tr>)}</tbody></table></div></section>}

function Sessions({rows,onOpen,compact=false,grading=false}){if(!rows.length)return <div className="exam-empty">{grading?'当前没有待批改考试':'暂时没有考试记录'}</div>;if(compact)return <>{rows.map(s=><div className="exam-line" key={s.id}><div><strong>{s.employee_name} · {s.title}</strong><small>{fmt(s.submitted_at||s.started_at)}</small></div><span>{statusText(s.status)}</span></div>)}</>;return <section className="exam-panel"><div className="exam-section-title"><div><h2>{grading?'待人工批改':'员工考试记录'}</h2><p>成绩与员工ID永久关联，后续员工档案直接读取这里的历史。</p></div></div><div className="exam-table-wrap"><table className="exam-table"><thead><tr><th>员工ID</th><th>姓名</th><th>考试</th><th>次数</th><th>提交时间</th><th>成绩</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(s=><tr key={s.id}><td>{s.employee_no}</td><td>{s.employee_name}</td><td>{s.title}</td><td>第{s.attempt_no}次</td><td>{fmt(s.submitted_at)}</td><td>{s.percentage==null?'—':`${s.percentage}%`}</td><td>{statusText(s.status)}</td><td>{onOpen&&<button onClick={()=>onOpen(s)}>{grading?'开始批改':'查看'}</button>}</td></tr>)}</tbody></table></div></section>}
const statusText=x=>({in_progress:'答题中',submitted:'待批改',grading:'批改中',graded:'已完成',expired:'已过期'}[x]||x)

function Stats({rows}){const graded=rows.filter(x=>x.status==='graded'),avg=graded.length?graded.reduce((s,x)=>s+Number(x.percentage||0),0)/graded.length:0,pass=graded.length?graded.filter(x=>x.passed).length/graded.length*100:0;return <><div className="exam-metrics"><button><span>完成次数</span><strong>{graded.length}</strong></button><button><span>平均分</span><strong>{avg.toFixed(1)}</strong></button><button><span>通过率</span><strong>{pass.toFixed(1)}%</strong></button><button><span>参考人数</span><strong>{new Set(graded.map(x=>x.employee_no)).size}</strong></button></div><Sessions rows={graded}/></>}

function Modal({title,onClose,children,wide=false}){return <div className="exam-modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><div className={`exam-modal ${wide?'wide':''}`}><header><h2>{title}</h2><button onClick={onClose}>×</button></header>{children}</div></div>}

function QuestionModal({value,teams,positions,onClose,onSaved}){const [v,setV]=useState({...blankQuestion,...value});const [busy,setBusy]=useState(false);const save=async()=>{setBusy(true);const {error}=await supabase.rpc('admin_exam_save_question',{p_question:v});setBusy(false);if(error)return alert(message(error));onSaved()};return <Modal title={v.id?'编辑考试题目':'新增考试题目'} onClose={onClose} wide><div className="exam-form grid"><label>团队（表格“盘口”）<input list="exam-teams" value={v.team_name} onChange={e=>setV({...v,team_name:e.target.value})}/></label><label>岗位<input list="exam-positions" value={v.position_name} onChange={e=>setV({...v,position_name:e.target.value})}/></label><datalist id="exam-teams">{teams.map(x=><option key={x} value={x}/>)}</datalist><datalist id="exam-positions">{positions.map(x=><option key={x} value={x}/>)}</datalist><label className="full">中文题目<textarea value={v.question_zh} onChange={e=>setV({...v,question_zh:e.target.value})}/></label><label className="full">英文题目<textarea value={v.question_en} onChange={e=>setV({...v,question_en:e.target.value})}/></label><label className="full">越南文题目<textarea value={v.question_vi} onChange={e=>setV({...v,question_vi:e.target.value})}/></label><label>分数<select value={v.points} onChange={e=>setV({...v,points:Number(e.target.value)})}><option>5</option><option>10</option><option>20</option></select></label><label>难度<select value={v.difficulty} onChange={e=>setV({...v,difficulty:Number(e.target.value)})}><option value="1">1 · 基础</option><option value="2">2 · 进阶</option><option value="3">3 · 困难</option></select></label><label className="full">图片链接（每行一个）<textarea value={(v.image_urls||[]).join('\n')} onChange={e=>setV({...v,image_urls:e.target.value.split('\n').map(x=>x.trim()).filter(Boolean).slice(0,3)})}/></label></div><footer><button onClick={onClose}>取消</button><button className="primary" disabled={busy||!v.team_name||!v.position_name||!(v.question_zh||v.question_en||v.question_vi)} onClick={save}>{busy?'保存中…':'保存并等待同步'}</button></footer></Modal>}

function AssignmentModal({value,teams,positions,onClose,onSaved}){const [v,setV]=useState(value),[busy,setBusy]=useState(false);const save=async()=>{setBusy(true);const {error}=await supabase.rpc('admin_exam_create_assignment',{p_data:v});setBusy(false);if(error)return alert(message(error));onSaved()};return <Modal title="创建并分配考试" onClose={onClose}><div className="exam-form"><label>考试名称<input value={v.title} onChange={e=>setV({...v,title:e.target.value})} placeholder="例如：AR印度出款月度考试"/></label><label>团队<select value={v.team_name} onChange={e=>setV({...v,team_name:e.target.value})}><option value="">请选择团队</option>{teams.map(x=><option key={x}>{x}</option>)}</select></label><label>岗位<select value={v.position_name} onChange={e=>setV({...v,position_name:e.target.value})}><option value="">请选择岗位</option>{positions.map(x=><option key={x}>{x}</option>)}</select></label><div className="inline"><label>时长（分钟）<input type="number" value={v.duration_minutes} onChange={e=>setV({...v,duration_minutes:Number(e.target.value)})}/></label><label>及格分（%）<input type="number" value={v.pass_score} onChange={e=>setV({...v,pass_score:Number(e.target.value)})}/></label><label>最多次数<input type="number" value={v.max_attempts} onChange={e=>setV({...v,max_attempts:Number(e.target.value)})}/></label></div><label>开始时间<input type="datetime-local" value={v.start_at} onChange={e=>setV({...v,start_at:e.target.value})}/></label><label>结束时间（可空）<input type="datetime-local" value={v.end_at} onChange={e=>setV({...v,end_at:e.target.value})}/></label><p className="exam-note">默认随机抽取：5分题10道、10分题3道、20分题1道。每名员工开始考试时固定题目，不会中途改变。</p></div><footer><button onClick={onClose}>取消</button><button className="primary" disabled={busy||!v.title||!v.team_name||!v.position_name} onClick={save}>{busy?'发布中…':'发布考试'}</button></footer></Modal>}

function GradeModal({session,onClose,onChanged}){const [detail,setDetail]=useState(null),[error,setError]=useState('');const load=async()=>{const {data,error:e}=await supabase.rpc('admin_exam_session_detail',{p_session_id:session.id});if(e)setError(message(e));else setDetail(data)};useEffect(()=>{load()},[]);const grade=async(a,status,score)=>{const {error:e}=await supabase.rpc('admin_exam_grade_answer',{p_answer_id:a.answer_id,p_status:status,p_score:score,p_feedback:a.grader_feedback||''});if(e)return setError(message(e));await load();onChanged()};return <Modal title={`人工批改 · ${session.employee_name} · ${session.title}`} onClose={onClose} wide><div className="grade-body">{error&&<div className="exam-error">{error}</div>}{!detail?<div className="exam-empty">读取答卷中…</div>:(detail.answers||[]).map((a,i)=><article className="grade-item" key={a.question_id}><header><b>{i+1}</b><strong>{a.question_zh||a.question_en||a.question_vi}</strong><span>{a.points}分</span></header>{a.image_urls?.length>0&&<div className="question-images">{a.image_urls.map(u=><a href={u} target="_blank" rel="noreferrer" key={u}><img src={u}/></a>)}</div>}<div className="answer-box"><small>员工答案</small><p>{a.answer_text||'未作答'}</p></div><div className="grade-actions"><button className={a.grade_status==='wrong'?'picked':''} disabled={!a.answer_id} onClick={()=>grade(a,'wrong',0)}>错误 · 0分</button><button className={a.grade_status==='partial'?'picked':''} disabled={!a.answer_id} onClick={()=>grade(a,'partial',a.points/2)}>部分正确 · {a.points/2}分</button><button className={a.grade_status==='correct'?'picked':''} disabled={!a.answer_id} onClick={()=>grade(a,'correct',a.points)}>正确 · {a.points}分</button></div></article>)}</div><footer><button className="primary" onClick={onClose}>关闭</button></footer></Modal>}

