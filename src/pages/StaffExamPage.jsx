import React,{useEffect,useMemo,useState} from 'react'
import { supabase } from '../lib/supabase'
const msg=e=>e?.message||String(e||'操作失败')
const fmt=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—'

export default function StaffExamPage(){
  const [home,setHome]=useState(null),[session,setSession]=useState(null),[answers,setAnswers]=useState({}),[loading,setLoading]=useState(true),[error,setError]=useState('')
  const load=async()=>{setLoading(true);const {data,error:e}=await supabase.rpc('staff_exam_home');if(e)setError(msg(e));else{setHome(data);setError('')}setLoading(false)}
  useEffect(()=>{load()},[])
  const start=async id=>{if(!confirm('确认开始考试？开始后计时不会暂停。'))return;const {data,error:e}=await supabase.rpc('staff_exam_start',{p_assignment_id:id});if(e)return setError(msg(e));setSession(data);setAnswers({})}
  if(session)return <ExamRunner session={session} answers={answers} setAnswers={setAnswers} onDone={()=>{setSession(null);load()}}/>
  return <div className="staff-exam-page"><header><div><small>MY EXAMS</small><h1>我的考试</h1><p>{home?.profile?`${home.profile.employee_no} · ${home.profile.employee_name} · ${home.profile.team_name} · ${home.profile.position_name}`:'考试会根据你的员工档案自动匹配团队与岗位'}</p></div><button onClick={load}>刷新</button></header>{error&&<div className="exam-error">{error}</div>}{loading?<div className="exam-empty">正在读取考试…</div>:<><section><h2>待完成考试</h2><div className="assignment-grid">{(home?.assignments||[]).map(a=><article key={a.id}><span>进行中</span><h3>{a.title}</h3><p>{a.team_name} · {a.position_name}</p><div><b>{a.duration_minutes} 分钟</b><b>及格 {a.pass_score}%</b><b>第 {a.attempts+1}/{a.max_attempts} 次</b></div><button disabled={a.attempts>=a.max_attempts} onClick={()=>start(a.id)}>{a.attempts>=a.max_attempts?'次数已用完':'开始考试'}</button></article>)}{!(home?.assignments||[]).length&&<div className="exam-empty">当前没有与你团队、岗位匹配的考试</div>}</div></section><section><h2>历史考试记录</h2><div className="exam-table-wrap"><table className="exam-table"><thead><tr><th>考试</th><th>次数</th><th>开始时间</th><th>成绩</th><th>结果</th></tr></thead><tbody>{(home?.history||[]).map(x=><tr key={x.id}><td>{x.title}</td><td>第{x.attempt_no}次</td><td>{fmt(x.started_at)}</td><td>{x.percentage==null?'待批改':`${x.percentage}%`}</td><td>{x.status==='graded'?(x.passed?'通过':'未通过'):'待批改'}</td></tr>)}</tbody></table></div></section></>}</div>
}

function ExamRunner({session,answers,setAnswers,onDone}){
  const questions=session.question_snapshot||[]
  const [index,setIndex]=useState(0),[remaining,setRemaining]=useState(Math.max(0,Math.floor((new Date(session.expires_at)-Date.now())/1000))),[saving,setSaving]=useState(false)
  useEffect(()=>{const t=setInterval(()=>setRemaining(x=>Math.max(0,x-1)),1000);return()=>clearInterval(t)},[])
  useEffect(()=>{if(remaining===0)submit(true)},[remaining])
  const q=questions[index],answer=answers[q?.id]||''
  const save=async(question=q,value=answer)=>{if(!question)return;setSaving(true);await supabase.rpc('staff_exam_save_answer',{p_session_id:session.id,p_question_id:question.id,p_answer:value,p_attachments:[]});setSaving(false)}
  const go=async n=>{await save();setIndex(n)}
  const submit=async(auto=false)=>{if(!auto&&!confirm('提交后不能再修改，确认提交？'))return;await save();const {error}=await supabase.rpc('staff_exam_submit',{p_session_id:session.id});if(error)return alert(msg(error));alert(auto?'考试时间到，已自动提交。':'考试已提交，等待后台批改。');onDone()}
  const mm=String(Math.floor(remaining/60)).padStart(2,'0'),ss=String(remaining%60).padStart(2,'0')
  return <div className="exam-runner"><header><div><small>ONLINE EXAM</small><h1>正在考试</h1></div><div className={remaining<300?'timer danger':'timer'}><small>剩余时间</small><strong>{mm}:{ss}</strong></div></header><div className="runner-layout"><aside><strong>答题进度</strong><div className="question-nav">{questions.map((x,i)=><button key={x.id} className={`${i===index?'active':''} ${answers[x.id]?.trim()?'done':''}`} onClick={()=>go(i)}>{i+1}</button>)}</div><p>已答 {Object.values(answers).filter(x=>x.trim()).length} / {questions.length}</p></aside><main><div className="question-head"><span>第 {index+1} 题 / 共 {questions.length} 题</span><b>{q.points} 分 · 难度 {q.difficulty}</b></div><h2>{q.question_zh||q.question_en||q.question_vi}</h2>{q.question_en&&q.question_zh&&<p className="translation">{q.question_en}</p>}{q.image_urls?.length>0&&<div className="question-images">{q.image_urls.map(u=><a href={u} target="_blank" rel="noreferrer" key={u}><img src={u}/></a>)}</div>}<label>填写答案<textarea autoFocus value={answer} onChange={e=>setAnswers({...answers,[q.id]:e.target.value})} onBlur={()=>save(q,answers[q.id]||'')} placeholder="请输入你的完整回答…"/></label><footer><button disabled={index===0} onClick={()=>go(index-1)}>上一题</button><span>{saving?'正在保存…':'答案自动保存'}</span>{index<questions.length-1?<button className="primary" onClick={()=>go(index+1)}>下一题</button>:<button className="primary" onClick={()=>submit(false)}>提交考试</button>}</footer></main></div></div>
}

