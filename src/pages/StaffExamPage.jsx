import React,{useEffect,useRef,useState} from 'react'
import { supabase } from '../lib/supabase'
const msg=e=>e?.message||String(e||'操作失败')
const fmt=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—'

export default function StaffExamPage(){
  const [home,setHome]=useState(null),[session,setSession]=useState(null),[answers,setAnswers]=useState({}),[loading,setLoading]=useState(true),[error,setError]=useState('')
  const load=async()=>{setLoading(true);const {data,error:e}=await supabase.rpc('staff_exam_home');if(e)setError(msg(e));else{setHome(data);setError('')}setLoading(false)}
  useEffect(()=>{load()},[])
  const start=async (id,resume=false)=>{if(!resume&&!confirm('确认开始考试？开始后计时不会暂停。'))return;const {data,error:e}=await supabase.rpc('staff_exam_start',{p_assignment_id:id});if(e)return setError(msg(e));setSession(data);setAnswers(data?.saved_answers||{})}
  if(session)return <ExamRunner session={session} answers={answers} setAnswers={setAnswers} onDone={()=>{setSession(null);load()}}/>
  const pending=home?.assignments||[],history=home?.history||[],passed=history.filter(x=>x.status==='graded'&&x.passed).length
  return <div className="staff-exam-page">
    <header className="staff-exam-hero"><div><small>W F H · LEARNING CENTER</small><h1>我的考试</h1><p>{home?.profile?`${home.profile.employee_no} · ${home.profile.employee_name}`:'考试会根据员工档案自动匹配'}</p>{home?.profile&&<div className="staff-profile-tags"><span>{home.profile.team_name}</span><span>{home.profile.position_name}</span></div>}</div><button onClick={load}>↻ 刷新</button></header>
    {error&&<div className="exam-error">{error}<button onClick={()=>setError('')}>×</button></div>}
    {loading?<div className="exam-empty">正在读取考试…</div>:<>
      <div className="staff-exam-metrics"><div><span>待完成</span><strong>{pending.length}</strong><small>项考试</small></div><div><span>历史考试</span><strong>{history.length}</strong><small>次记录</small></div><div><span>已通过</span><strong>{passed}</strong><small>次通过</small></div></div>
      <section className="staff-pending-section"><div className="staff-section-head"><div><small>TO DO</small><h2>待完成考试</h2></div><span>{pending.length} 项</span></div><div className="assignment-grid">{pending.map(a=><article key={a.id}><div className="assignment-card-top"><span>{a.resume_session_id?'进行中':'待完成'}</span><b>{a.duration_minutes} 分钟</b></div><h3>{a.title}</h3><p>{a.team_name} <i>·</i> {a.position_name}</p><div className="assignment-facts"><b><small>及格分</small>{a.pass_score}%</b><b><small>考试次数</small>{Math.min(a.attempts+1,a.max_attempts)} / {a.max_attempts}</b><b><small>截止时间</small>{a.end_at?fmt(a.end_at):'长期有效'}</b></div><button disabled={!a.resume_session_id&&a.attempts>=a.max_attempts} onClick={()=>start(a.id,!!a.resume_session_id)}>{a.resume_session_id?'继续答题 →':a.attempts>=a.max_attempts?'次数已用完':'开始考试 →'}</button></article>)}{!pending.length&&<div className="staff-empty-state"><span>✓</span><h3>目前没有待完成考试</h3><p>新考试会按照你的团队和岗位自动出现在这里。</p></div>}</div></section>
      <section><div className="staff-section-head"><div><small>HISTORY</small><h2>历史考试记录</h2></div><span>{history.length} 次</span></div>{history.length?<div className="exam-table-wrap"><table className="exam-table staff-history-table"><thead><tr><th>考试</th><th>次数</th><th>开始时间</th><th>成绩</th><th>结果</th></tr></thead><tbody>{history.map(x=><tr key={x.id}><td><strong>{x.title}</strong></td><td>第 {x.attempt_no} 次</td><td>{fmt(x.started_at)}</td><td><b>{x.percentage==null?'待批改':`${x.percentage}%`}</b></td><td><span className={`result-chip ${x.status==='graded'?(x.passed?'pass':'fail'):'pending'}`}>{x.status==='graded'?(x.passed?'通过':'未通过'):'待批改'}</span></td></tr>)}</tbody></table></div>:<div className="staff-history-empty">完成考试后，成绩与历史记录会显示在这里。</div>}</section>
    </>}
  </div>
}

function ExamRunner({session,answers,setAnswers,onDone}){
  const questions=session.question_snapshot||[]
  const [index,setIndex]=useState(0),[remaining,setRemaining]=useState(Math.max(0,Math.floor((new Date(session.expires_at)-Date.now())/1000))),[saving,setSaving]=useState(false),[error,setError]=useState('')
  const submitting=useRef(false)
  useEffect(()=>{const t=setInterval(()=>setRemaining(x=>Math.max(0,x-1)),1000);return()=>clearInterval(t)},[])
  useEffect(()=>{if(remaining===0)submit(true)},[remaining])
  const q=questions[index],answer=answers[q?.id]||''
  const save=async(question=q,value=answer)=>{if(!question)return true;setSaving(true);const {error:e}=await supabase.rpc('staff_exam_save_answer',{p_session_id:session.id,p_question_id:question.id,p_answer:value,p_attachments:[]});setSaving(false);if(e){setError(`答案保存失败：${msg(e)}`);return false}setError('');return true}
  const go=async n=>{await save();setIndex(n)}
  const submit=async(auto=false)=>{if(submitting.current)return;if(!auto&&!confirm('提交后不能再修改，确认提交？'))return;submitting.current=true;const saved=await save();if(!saved&&!auto){submitting.current=false;return}const {error:e}=await supabase.rpc('staff_exam_submit',{p_session_id:session.id});if(e){submitting.current=false;setError(msg(e));return}alert(auto?'考试时间到，已自动提交。':'考试已提交，等待后台批改。');onDone()}
  const mm=String(Math.floor(remaining/60)).padStart(2,'0'),ss=String(remaining%60).padStart(2,'0')
  if(!q)return <div className="exam-empty">试卷没有可用题目，请联系管理员。</div>
  return <div className="exam-runner"><header><div><small>ONLINE EXAM</small><h1>{session.title||'正在考试'}</h1></div><div className={remaining<300?'timer danger':'timer'}><small>剩余时间</small><strong>{mm}:{ss}</strong></div></header>{error&&<div className="exam-error runner-error">{error}</div>}<div className="runner-layout"><aside><strong>答题进度</strong><div className="question-nav">{questions.map((x,i)=><button key={x.id} className={`${i===index?'active':''} ${answers[x.id]?.trim()?'done':''}`} onClick={()=>go(i)}>{i+1}</button>)}</div><p>已答 {Object.values(answers).filter(x=>String(x||'').trim()).length} / {questions.length}</p></aside><main><div className="question-head"><span>第 {index+1} 题 / 共 {questions.length} 题</span><b>{q.points} 分 · 难度 {q.difficulty}</b></div><div className="runner-languages">{q.question_zh&&<div><span>中</span><p>{q.question_zh}</p></div>}{q.question_en&&<div><span>EN</span><p>{q.question_en}</p></div>}{q.question_vi&&<div><span>VI</span><p>{q.question_vi}</p></div>}</div>{q.image_urls?.length>0&&<div className="question-images">{q.image_urls.map(u=><a href={u} target="_blank" rel="noreferrer" key={u}><img src={u}/></a>)}</div>}<label>填写答案<textarea autoFocus value={answer} onChange={e=>setAnswers({...answers,[q.id]:e.target.value})} onBlur={()=>save(q,answers[q.id]||'')} placeholder="请输入你的完整回答…"/></label><footer><button disabled={index===0} onClick={()=>go(index-1)}>上一题</button><span>{saving?'正在保存…':'答案已自动保存'}</span>{index<questions.length-1?<button className="primary" onClick={()=>go(index+1)}>下一题</button>:<button className="primary" onClick={()=>submit(false)}>提交考试</button>}</footer></main></div></div>
}
