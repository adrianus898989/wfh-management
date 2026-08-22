import React,{useEffect,useRef,useState} from 'react'
import { supabase } from '../lib/supabase'
const msg=e=>e?.message||String(e||'操作失败')
const fmt=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—'
const driveId=url=>String(url||'').match(/\/d\/([^/?]+)/)?.[1]||String(url||'').match(/[?&]id=([^&]+)/)?.[1]||''
const imageSources=url=>{const id=driveId(url);return id?[`https://drive.google.com/thumbnail?id=${id}&sz=w1600`,`https://lh3.googleusercontent.com/d/${id}=w1600`,url]:[url]}

export default function StaffExamPage(){
  const [home,setHome]=useState(null),[session,setSession]=useState(null),[result,setResult]=useState(null),[answers,setAnswers]=useState({}),[loading,setLoading]=useState(true),[error,setError]=useState('')
  const load=async()=>{setLoading(true);const {data,error:e}=await supabase.rpc('staff_exam_home');if(e)setError(msg(e));else{setHome(data);setError('')}setLoading(false)}
  useEffect(()=>{load()},[])
  const start=async resume=>{if(!resume&&!confirm('确认开始考试？开始后将连续计时 60 分钟。'))return;const {data,error:e}=await supabase.rpc('staff_exam_start_adaptive');if(e)return setError(msg(e));setSession(data);setAnswers(data?.saved_answers||{})}
  const viewResult=async id=>{setLoading(true);const {data,error:e}=await supabase.rpc('staff_exam_result_detail',{p_session_id:id});setLoading(false);if(e)return setError(msg(e));setResult(data)}
  if(session)return <ExamRunner session={session} answers={answers} setAnswers={setAnswers} onDone={()=>{setSession(null);load()}}/>
  const pending=home?.assignments||[],exam=pending[0],history=home?.history||[],passed=history.filter(x=>x.status==='graded'&&x.passed).length
  return <div className="staff-exam-page">
    <header className="staff-exam-hero"><div><small>W F H · LEARNING CENTER</small><h1>我的考试</h1><p>{home?.profile?`${home.profile.employee_no} · ${home.profile.employee_name}`:'考试会根据员工档案自动匹配'}</p>{home?.profile&&<div className="staff-profile-tags"><span>{home.profile.team_name}</span><span>{home.profile.position_name}</span></div>}</div><button onClick={load}>↻ 刷新</button></header>
    {error&&<div className="exam-error">{error}<button onClick={()=>setError('')}>×</button></div>}
    {loading?<div className="exam-empty">正在读取考试…</div>:<>
      <div className="staff-exam-metrics"><div><span>待完成</span><strong>{pending.length}</strong><small>项考试</small></div><div><span>历史考试</span><strong>{history.length}</strong><small>次记录</small></div><div><span>已通过</span><strong>{passed}</strong><small>次通过</small></div></div>
      <section className="staff-pending-section"><div className="staff-section-head"><div><small>MY POSITION EXAM</small><h2>我的岗位考试</h2><p>无需选择或创建考试，系统只按你的员工档案匹配题库并随机组卷。</p></div><span>自动匹配</span></div>{exam?<article className="adaptive-exam-card"><div><span className="adaptive-status">{exam.resume_session_id?'考试进行中':'岗位已匹配'}</span><h3>{exam.team_name} · {exam.position_name}</h3><p>每次随机抽取 14 题，总分 100 分，考试时间固定 60 分钟。</p><div className="adaptive-exam-facts"><b>14<small>题目</small></b><b>100<small>总分</small></b><b>60<small>分钟</small></b><b>{exam.pass_score}%<small>及格</small></b></div>{!exam.pool_ready&&<div className="pool-warning">该岗位题库数量不足，暂时无法生成完整试卷，请联系管理员补充。</div>}</div><button disabled={!exam.pool_ready||(!exam.resume_session_id&&exam.attempts>=exam.max_attempts)} onClick={()=>start(!!exam.resume_session_id)}>{exam.resume_session_id?'继续考试 →':!exam.pool_ready?'题库准备中':exam.attempts>=exam.max_attempts?'考试次数已用完':'开始岗位考试 →'}</button></article>:<div className="staff-empty-state"><span>!</span><h3>暂时无法生成岗位考试</h3><p>你的档案是“{home?.profile?.team_name||'未设置'} · {home?.profile?.position_name||'未设置'}”。请管理员检查岗位题库范围。</p></div>}</section>
      <section><div className="staff-section-head"><div><small>MY RESULTS</small><h2>我的考试结果</h2><p>只有本人能够查看自己的答案、得分及批改意见。</p></div><span>{history.length} 次</span></div>{history.length?<div className="exam-table-wrap"><table className="exam-table staff-history-table"><thead><tr><th>考试</th><th>次数</th><th>开始时间</th><th>成绩</th><th>结果</th><th>操作</th></tr></thead><tbody>{history.map(x=><tr key={x.id}><td><strong>{x.title}</strong></td><td>第 {x.attempt_no} 次</td><td>{fmt(x.started_at)}</td><td><b>{x.percentage==null?'待批改':`${x.percentage}%`}</b></td><td><span className={`result-chip ${x.status==='graded'?(x.passed?'pass':'fail'):'pending'}`}>{x.status==='graded'?(x.passed?'通过':'未通过'):'待批改'}</span></td><td><button onClick={()=>viewResult(x.id)}>查看结果</button></td></tr>)}</tbody></table></div>:<div className="staff-history-empty">完成考试后，成绩与历史记录会显示在这里。</div>}</section>
      {result&&<ExamResult result={result} onClose={()=>setResult(null)}/>} 
    </>}
  </div>
}

function ExamResult({result,onClose}){
  const s=result?.session||{},items=result?.answers||[]
  return <div className="exam-modal-backdrop"><div className="exam-modal wide staff-result-modal"><header><div><small>MY EXAM RESULT</small><h2>{s.title}</h2><p>第 {s.attempt_no} 次 · {fmt(s.submitted_at)}</p></div><button onClick={onClose}>×</button></header><div className="staff-result-summary"><div><span>成绩</span><strong>{s.percentage==null?'待批改':`${s.percentage}%`}</strong></div><div><span>结果</span><strong>{s.status==='graded'?(s.passed?'通过':'未通过'):'待批改'}</strong></div><div><span>得分</span><strong>{s.earned_score??'—'} / {s.total_score??'—'}</strong></div></div>{s.grader_note&&<div className="staff-result-note"><b>总体评语</b><p>{s.grader_note}</p></div>}<div className="staff-result-list">{items.map((x,i)=>{const q=x.question||{};return <article key={q.id||i}><header><b>{i+1}</b><div><strong>{q.question_zh||q.question_en||q.question_vi}</strong><small>{q.points} 分</small></div><span className={`result-chip ${x.grade_status==='correct'?'pass':x.grade_status==='wrong'?'fail':'pending'}`}>{x.awarded_score==null?'待批改':`${x.awarded_score} 分`}</span></header><details><summary>查看 English / Tiếng Việt</summary>{q.question_en&&<p><b>EN</b>{q.question_en}</p>}{q.question_vi&&<p><b>VI</b>{q.question_vi}</p>}</details><ExamMedia urls={q.image_urls}/><div className="staff-result-answer"><b>我的答案</b><p>{x.answer_text||'（未作答）'}</p></div>{x.grader_feedback&&<div className="staff-result-feedback"><b>批改意见</b><p>{x.grader_feedback}</p></div>}</article>})}</div><footer><button className="primary" onClick={onClose}>关闭</button></footer></div></div>
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
  return <div className="exam-runner"><header><div><small>ONLINE EXAM</small><h1>{session.title||'正在考试'}</h1><p>14 题 · 100 分 · 答案自动保存</p></div><div className={remaining<300?'timer danger':'timer'}><small>剩余时间</small><strong>{mm}:{ss}</strong></div></header>{error&&<div className="exam-error runner-error">{error}</div>}<div className="runner-layout"><aside><strong>答题进度</strong><div className="question-nav">{questions.map((x,i)=><button key={x.id} className={`${i===index?'active':''} ${answers[x.id]?.trim()?'done':''}`} onClick={()=>go(i)}>{i+1}</button>)}</div><p>已答 {Object.values(answers).filter(x=>String(x||'').trim()).length} / {questions.length}</p></aside><main><div className="question-head"><span>第 {index+1} 题 / 共 {questions.length} 题</span><b>{q.points} 分 · 难度 {q.difficulty}</b></div><div className="runner-languages">{q.question_zh&&<div><span>中</span><p>{q.question_zh}</p></div>}{q.question_en&&<div><span>EN</span><p>{q.question_en}</p></div>}{q.question_vi&&<div><span>VI</span><p>{q.question_vi}</p></div>}</div><ExamMedia urls={q.image_urls}/><label>填写答案<textarea autoFocus value={answer} onChange={e=>setAnswers({...answers,[q.id]:e.target.value})} onBlur={()=>save(q,answers[q.id]||'')} placeholder="请输入你的完整回答…"/></label><footer><button disabled={index===0} onClick={()=>go(index-1)}>上一题</button><span>{saving?'正在保存…':'答案已自动保存'}</span>{index<questions.length-1?<button className="primary" onClick={()=>go(index+1)}>下一题</button>:<button className="primary" onClick={()=>submit(false)}>提交考试</button>}</footer></main></div></div>
}

function ExamMedia({urls=[]}){
  const [preview,setPreview]=useState('')
  if(!urls?.length)return null
  return <><div className="exam-media-grid">{urls.map((url,i)=><ProgressiveImage key={`${url}-${i}`} url={url} onOpen={setPreview}/>)}</div>{preview&&<div className="exam-image-lightbox" onClick={()=>setPreview('')}><button aria-label="关闭图片">×</button><img src={preview} alt="考试题目大图" referrerPolicy="no-referrer" onClick={e=>e.stopPropagation()}/></div>}</>
}

function ProgressiveImage({url,onOpen}){
  const sources=imageSources(url)
  const [index,setIndex]=useState(0),src=sources[index]
  if(!src)return <a className="exam-media-fallback" href={url} target="_blank" rel="noreferrer">图片暂时无法预览<br/>点击打开原图</a>
  return <button type="button" className="exam-media-thumb" onClick={()=>onOpen(src)}><img src={src} alt="考试题目图片" referrerPolicy="no-referrer" onError={()=>setIndex(x=>x+1)}/><span>点击放大</span></button>
}
