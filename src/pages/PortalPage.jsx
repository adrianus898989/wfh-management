import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { EmployeeConnectivityPanel } from '../components/ConnectivityRecords'
import { StaffPayrollWorkspace } from './StaffPayrollPage'

const inactiveStatuses = ['left', 'resigned', 'inactive', 'terminated', '离职', '停用']
const text = v => String(v ?? '').trim()

function isActive(row) {
  return !inactiveStatuses.includes(text(row?.status).toLowerCase())
}

function groupCount(rows, getter) {
  const map = new Map()
  rows.forEach(row => {
    const name = getter(row) || '未设置'
    map.set(name, (map.get(name) || 0) + 1)
  })
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

export const AdminHome = () => {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data, error } = await supabase.functions.invoke('admin-accounts', {
        body: { action: 'bootstrap' },
      })
      if (!alive) return
      if (error || data?.error) setError(data?.error || error?.message || '读取失败')
      else setData(data)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [])

  const view = useMemo(() => {
    const employees = data?.employees || []
    const active = employees.filter(isActive)
    const staffAccounts = data?.employee_accounts || []
    const backendAccounts = data?.backend_accounts || []
    const staffIds = new Set(staffAccounts.map(x => x.employee_id).filter(Boolean))
    const onsite = active.filter(e => ['onsite', '现场人员'].includes(text(e.source_type)) || text(e.employment_type) === '现场人员')
    const needsProfile = active.filter(e => text(e.profile_status).startsWith('needs_'))
    const recentHires = active
      .filter(e => e.hire_date)
      .sort((a,b) => text(b.hire_date).localeCompare(text(a.hire_date)))
      .slice(0,6)

    return {
      total: employees.length,
      active: active.length,
      teams: groupCount(active, e => e?.teams?.name),
      positions: groupCount(active, e => e?.positions?.name),
      types: groupCount(active, e => e?.employment_type),
      countries: groupCount(active, e => e?.country || e?.nationality),
      staffAccounts: staffAccounts.length,
      backendAccounts: backendAccounts.length,
      pendingAccounts: active.filter(e => !staffIds.has(e.id)).length,
      onsite: onsite.length,
      needsProfile: needsProfile.length,
      recentHires,
    }
  }, [data])

  return (
    <div className="content-page dashboard-page pro-dashboard">
      <div className="dashboard-head dashboard-head-pro">
        <div>
          <div className="dashboard-kicker">MANAGEMENT OVERVIEW</div>
          <h1>综合 Dashboard</h1>
          <p className="page-subtitle">员工主档、团队与账号数据已接入；出勤、日报、工资等未接模块保持“—”，不显示假数据。</p>
        </div>
        <div className="dashboard-date">
          {new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date())}
        </div>
      </div>

      {error && <div className="page-error">{error}</div>}

      <div className="quick-actions">
        <Link to="/admin/employees" className="quick-action primary-quick">查看员工档案</Link>
        <Link to="/admin/schedule" className="quick-action">查看排班</Link>
        <Link to="/admin/daily" className="quick-action">每日工作</Link>
        <Link to="/admin/reports" className="quick-action">统计报表</Link>
      </div>

      <div className="kpi-grid kpi-grid-pro">
        <Kpi label="员工总数" value={loading ? '—' : view.total} hint="当前数据库" />
        <Kpi label="在职员工" value={loading ? '—' : view.active} hint="排除离职/停用" />
        <Kpi label="团队数" value={loading ? '—' : view.teams.length} hint="已匹配团队" />
        <Kpi label="现场 / 补录" value={loading ? '—' : view.onsite} hint="来自排班补录" />
        <Kpi label="待补资料" value={loading ? '—' : view.needsProfile} hint="需要人工完善" tone="warn" />
        <Kpi label="员工账号" value={loading ? '—' : view.staffAccounts} hint="已开通 Portal" />
        <Kpi label="待开通账号" value={loading ? '—' : view.pendingAccounts} hint="可生成激活码" />
        <Kpi label="后台账号" value={loading ? '—' : view.backendAccounts} hint="管理端账号" />
      </div>

      <div className="dashboard-grid">
        <DashboardCard title="团队人数分布" meta="TOP 8">
          <BarList rows={view.teams} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="员工类型" meta="当前主档">
          <BarList rows={view.types} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="国家 / 国籍分布" meta="TOP 8">
          <BarList rows={view.countries} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="岗位分布" meta="TOP 8">
          <BarList rows={view.positions} total={view.active || 1} />
        </DashboardCard>

        <DashboardCard title="今日出勤" meta="等待出勤表接入">
          <CompactStats rows={[
            ['正常', '—'], ['请假', '—'], ['公休', '—'], ['回家', '—'], ['缺席', '—']
          ]} />
        </DashboardCard>

        <DashboardCard title="待处理" meta="后续工作流">
          <CompactStats rows={[
            ['请假审批', '—'], ['日报未提交', '—'], ['待接收交接', '—'], ['资料修改', '—'], ['待发布工资', '—']
          ]} />
        </DashboardCard>

        <DashboardCard title="最近入职" meta="已录入日期">
          {view.recentHires.length ? (
            <div className="recent-list">
              {view.recentHires.map(e => (
                <div className="recent-row" key={e.id}>
                  <div><strong>{e.full_name}</strong><span>{e.employee_no}</span></div>
                  <div><span>{e?.teams?.name || '未匹配团队'}</span><b>{text(e.hire_date).slice(0,10)}</b></div>
                </div>
              ))}
            </div>
          ) : <div className="empty-state compact">暂无日期资料</div>}
        </DashboardCard>

        <DashboardCard title="系统接入状态" meta="当前阶段">
          <CompactStats rows={[
            ['员工主档', loading ? '读取中' : '已接入'],
            ['团队 / 岗位', loading ? '读取中' : '已接入'],
            ['排班关系', '部分已接入'],
            ['出勤 / 请假', '待接入'],
            ['日报 / 交接', '待接入'],
          ]} />
        </DashboardCard>
      </div>
    </div>
  )
}

function Kpi({ label, value, hint, tone }) {
  return (
    <div className={`kpi-card kpi-card-pro ${tone ? `kpi-${tone}` : ''}`}>
      <div className="kpi-label-row"><span>{label}</span><i /></div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  )
}

function DashboardCard({ title, meta, children }) {
  return (
    <section className="dashboard-card dashboard-card-pro">
      <div className="card-head"><h2>{title}</h2><span>{meta}</span></div>
      {children}
    </section>
  )
}

function BarList({ rows, total }) {
  if (!rows?.length) return <div className="empty-state compact">暂无数据</div>
  return (
    <div className="bar-list">
      {rows.slice(0,8).map(row => (
        <div className="bar-row" key={row.name}>
          <div className="bar-meta"><span>{row.name}</span><strong>{row.count}</strong></div>
          <div className="bar-track"><div className="bar-fill" style={{ width:`${Math.max(3, Math.round(row.count/total*100))}%` }} /></div>
        </div>
      ))}
    </div>
  )
}

function CompactStats({ rows }) {
  return (
    <div className="compact-stats">
      {rows.map(([label,value]) => (
        <div className="compact-stat" key={label}><span>{label}</span><strong>{value}</strong></div>
      ))}
    </div>
  )
}

const staffTenure = date => {
  if (!date) return '—'
  const start = new Date(`${date}T00:00:00`), days = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000))
  const years = Math.floor(days / 365), months = Math.floor((days % 365) / 30), rest = days - years * 365 - months * 30
  return `${years ? `${years}年 ` : ''}${months}个月 ${rest}天 · 共 ${days} 天`
}

const staffDate = value => value ? String(value).slice(0,10) : '—'
const staffDateTime = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '—'
const staffExamBreakdown = row => {
  if(row?.source_system==='legacy'&&!row?.answer_detail_available)return row?.percentage==null?'逐题明细等待同步':'总成绩已保留 · 逐题明细未同步'
  const answered=Number(row?.answer_detail_count||0),total=Number(row?.total_question_count||0)
  const prefix=row?.source_system==='legacy'&&total?`已答 ${answered}/${total} · 未答 ${Number(row?.unanswered_count||Math.max(total-answered,0))} · `:''
  return `${prefix}正确 ${row?.correct_count||0} · 半对 ${row?.partial_count||0} · 错误 ${row?.wrong_count||0} · 待评 ${row?.pending_count||0}`
}

export const StaffHome = () => {
  const [data,setData] = useState(null), [loading,setLoading] = useState(true), [error,setError] = useState('')
  const [activity,setActivity] = useState({loading:true,error:'',data:null})
  const [errorHistory,setErrorHistory] = useState({rows:[],total:0,page:1,pages:1}), [errorPage,setErrorPage] = useState(1), [errorsLoading,setErrorsLoading] = useState(false)
  const [revealed,setRevealed] = useState({}), [revealLoading,setRevealLoading] = useState('')
  const [activeSection,setActiveSection] = useState('info')
  const [examDetail,setExamDetail] = useState(null), [examDetailLoading,setExamDetailLoading] = useState(false), [examDetailError,setExamDetailError] = useState('')
  const load = async () => {
    setLoading(true); setError('')
    setActivity(current=>({...current,loading:true,error:''}))
    const [{data:result,error:loadError},{data:activityResult,error:activityError}] = await Promise.all([
      supabase.rpc('staff_portal_home'),
      supabase.rpc('staff_activity_home'),
    ])
    if(loadError)setError(loadError.message || '个人资料读取失败'); else setData(result)
    setActivity(activityError?{loading:false,error:activityError.message||'出勤与断网记录读取失败',data:null}:{loading:false,error:'',data:activityResult||null})
    setLoading(false)
  }
  useEffect(()=>{load()},[])
  useEffect(()=>{if(activeSection!=='errors')return;let alive=true;(async()=>{setErrorsLoading(true);const {data:result,error:e}=await supabase.rpc('staff_portal_errors',{p_page:errorPage,p_page_size:20});if(!alive)return;if(e)setError(e.message||'错误记录读取失败');else setErrorHistory(result||{rows:[],total:0,page:1,pages:1});setErrorsLoading(false)})();return()=>{alive=false}},[errorPage,activeSection])
  if(loading)return <div className="staff-portal-page"><div className="staff-portal-loading">正在读取个人资料…</div></div>
  const p=data?.profile||{}, pay=data?.payment||{}, summary=data?.error_summary||{}, exam=data?.exam_summary||{}, errors=errorHistory?.rows||[]
  const attendance=activity.data?.attendance||{}, connectivity=activity.data?.connectivity||{}
  const toggleSensitive = async field => {
    if(revealed[field]) { setRevealed(current=>({...current,[field]:''})); return }
    setRevealLoading(field); setError('')
    const {data:value,error:e}=await supabase.rpc('staff_portal_reveal_payment',{p_field:field})
    if(e)setError(e.message||'敏感资料读取失败'); else setRevealed(current=>({...current,[field]:value||'—'}))
    setRevealLoading('')
  }
  const fields=[['员工ID',p.employee_no],['员工国家',p.country||p.nationality],['员工类型',p.employment_type],['状态',p.status==='active'?'在职':p.status],['入职日期',staffDate(p.hire_date)],['入职时长',staffTenure(p.hire_date)],['团队',p.team_name],['组别',p.group_name],['岗位',p.position_name],['班次',p.shift_name],['负责人 / 组长',p.person_in_charge||p.leader_name],['培训老师',p.online_trainer||p.trainer_name],['盘口 / 平台',p.platform_scope],['工作内容',p.work_content]]
  const examRows=data?.exam_history||[]
  const openExam=async row=>{
    setExamDetail({session:row,answers:[]});setExamDetailLoading(true);setExamDetailError('')
    const {data:result,error:e}=await supabase.rpc('staff_exam_result_detail',{p_session_id:row.id})
    if(e)setExamDetailError(e.message||'考试明细读取失败');else setExamDetail(result)
    setExamDetailLoading(false)
  }
  return <div className="staff-portal-page">
    <header className="staff-portal-hero"><div className="staff-avatar">{(p.full_name||'W').slice(0,1).toUpperCase()}</div><div><small>MY WORKSPACE</small><h1>{p.full_name||'我的首页'}</h1><p>{p.employee_no||'—'} · {p.team_name||'未设置团队'} · {p.position_name||'未设置岗位'}</p><div className="staff-hero-tags"><span>{p.shift_name||'班次未设置'}</span><span>{staffTenure(p.hire_date)}</span></div></div><button onClick={load}>↻ 刷新资料</button></header>
    {error&&<div className="exam-error">{error}<button onClick={()=>setError('')}>×</button></div>}
    <section className="staff-dashboard-metrics"><div><span>本月错误</span><strong>{summary.month_error_count||0}</strong><small>累计 {summary.total_error_count||0} 笔</small></div><div><span>考试记录</span><strong>{exam.total||0}</strong><small>通过 {exam.passed||0} 次</small></div><div><span>平均成绩</span><strong>{exam.average||0}%</strong><small>已批改 {exam.completed||0} 次</small></div><div><span>本月缺席</span><strong>{activity.loading?'—':attendance.summary?.month_absent||0}</strong><small>出勤记录</small></div><div><span>本月休假</span><strong>{activity.loading?'—':attendance.summary?.month_leave||0}</strong><small>休假 / 公休天数</small></div><div><span>停电 / 断网</span><strong>{activity.loading?'—':connectivity.total||0}</strong><small>停电 {connectivity.power||0} · 断网 {connectivity.internet||0}</small></div></section>
    <nav className="staff-profile-tabs">
      {[['info','个人信息'],['errors','出错记录'],['exams','考试结果'],['attendance','出勤记录'],['connectivity','停电 / 断网记录'],['payroll','工资记录']].map(([key,label])=><button key={key} className={activeSection===key?'active':''} onClick={()=>setActiveSection(key)}>{label}</button>)}
    </nav>
    {activeSection==='info'&&<div className="staff-portal-columns"><div className="staff-profile-stack"><section className="staff-profile-panel"><header><div><small>PERSONAL PROFILE</small><h2>个人信息</h2></div><span>仅本人可见</span></header><div className="staff-profile-fields">{fields.map(([label,value])=><div key={label}><span>{label}</span><strong>{value||'—'}</strong></div>)}</div></section>
      <section className="staff-payment-panel"><header><div><small>PAYMENT & CONTACT</small><h2>收款与联系资料</h2></div><span>🔒 已安全隐藏</span></header><div className="staff-payment-grid">
        <div><span>收款方式</span><strong>{pay.transfer_using||pay.payment_mode||'—'}</strong></div><div><span>收款姓名</span><strong>{pay.account_name||'—'}</strong></div>
        <div className="staff-sensitive-row"><span>银行卡 / 钱包账号</span><strong>{revealed.bank_account||pay.bank_account_masked||'—'}</strong>{pay.bank_account_masked&&<button onClick={()=>toggleSensitive('bank_account')} disabled={revealLoading==='bank_account'}>{revealLoading==='bank_account'?'读取中':revealed.bank_account?'隐藏':'查看'}</button>}</div>
        <div className="staff-sensitive-row"><span>USDT 地址</span><strong>{revealed.usdt_address||pay.usdt_address_masked||'—'}</strong>{pay.usdt_address_masked&&<button onClick={()=>toggleSensitive('usdt_address')} disabled={revealLoading==='usdt_address'}>{revealLoading==='usdt_address'?'读取中':revealed.usdt_address?'隐藏':'查看'}</button>}</div>
        <div><span>联系电话</span><strong>{pay.contact_phone||'—'}</strong></div><div><span>WhatsApp</span><strong>{pay.whatsapp_number||'—'}</strong></div><div><span>Facebook</span><strong>{pay.facebook||'—'}</strong></div><div><span>联系地址</span><strong>{pay.employee_address||'—'}</strong></div>
      </div></section></div>
      <section className="staff-quick-panel"><header><small>QUICK ACCESS</small><h2>快捷入口</h2></header><Link to="/staff/exams"><b>参加考试</b><span>选择岗位与盘口 →</span></Link><Link to="/staff/schedule"><b>排班记录</b><span>查看本人排班 →</span></Link><Link to="/staff/attendance"><b>出勤记录</b><span>查看本人出勤 →</span></Link></section></div>}
    {activeSection==='errors'&&<section className="staff-own-errors"><header><div><small>ERROR RECORDS</small><h2>出错记录</h2></div><span>共 {errorHistory.total||0} 条</span></header>{errorsLoading?<div className="staff-history-empty">正在读取错误记录…</div>:errors.length?<><div className="staff-error-list">{errors.map((row,index)=><article key={row.record_key||`${row.qc_date}-${index}`}><div className="staff-error-date"><b>{staffDate(row.qc_date)}</b><span>{row.error_type||'未分类错误'}</span></div><div><small>错误情况</small><p>{row.error_note||'—'}</p></div><div><small>正确处理方式</small><p>{row.correct_action||'—'}</p></div><span className="staff-error-score">{row.score?`${row.score} 分`:'—'}</span></article>)}</div><div className="staff-error-pager"><button disabled={errorPage<=1} onClick={()=>setErrorPage(x=>Math.max(1,x-1))}>上一页</button><span>第 {errorHistory.page||1} / {errorHistory.pages||1} 页</span><button disabled={errorPage>=(errorHistory.pages||1)} onClick={()=>setErrorPage(x=>x+1)}>下一页</button></div></>:<div className="staff-history-empty">目前没有与你员工ID关联的错误记录。</div>}</section>}
    {activeSection==='exams'&&<section className="staff-portal-exams"><header><div><small>EXAM RESULTS</small><h2>考试结果</h2></div><span>本系统 {exam.current||0} · 旧考试 {exam.legacy||0}</span></header>{examRows.length?<div className="staff-portal-exam-list">{examRows.map(row=><article key={`${row.source_system}-${row.id}`}><div><span className={`exam-source-badge ${row.source_system==='legacy'?'legacy':'current'}`}>{row.source_label||'本系统'}</span><strong>{row.title}</strong><small>第 {row.attempt_no} 次 · {staffDateTime(row.submitted_at||row.started_at)}</small></div><div><b>{row.percentage==null?'待批改':`${Number(row.earned_score||0).toLocaleString()}/${Number(row.total_score||100).toLocaleString()} · ${Number(row.percentage).toFixed(1)}%`}</b><small>{staffExamBreakdown(row)}</small></div><button onClick={()=>openExam(row)}>查看答卷</button></article>)}</div>:<div className="staff-history-empty">暂无考试记录。</div>}</section>}
    {activeSection==='attendance'&&<StaffAttendancePanel data={attendance} loading={activity.loading} error={activity.error}/>}
    {activeSection==='connectivity'&&<EmployeeConnectivityPanel data={connectivity} loading={activity.loading} error={activity.error}/>}
    {activeSection==='payroll'&&<StaffPayrollWorkspace embedded/>}
    {examDetail&&<StaffPortalExamModal detail={examDetail} loading={examDetailLoading} error={examDetailError} onClose={()=>setExamDetail(null)}/>}
  </div>
}

function StaffAttendancePanel({data,loading,error}){
  const rows=data?.rows||[], summary=data?.summary||{}
  const label=value=>({normal:'正常',rest:'公休',absent:'缺席',leave:'休假',late:'迟到'}[String(value||'').toLowerCase()]||value||'—')
  return <section className="staff-activity-panel"><header><div><small>ATTENDANCE</small><h2>出勤记录</h2></div><span>{data?.total||0} 条</span></header><div className="staff-activity-summary"><div><span>正常</span><strong>{summary.normal||0}</strong></div><div><span>公休</span><strong>{summary.rest||0}</strong></div><div><span>缺席</span><strong>{summary.absent||0}</strong></div><div><span>休假</span><strong>{summary.leave||0}</strong></div></div>{loading?<div className="staff-history-empty">正在读取出勤记录…</div>:error?<div className="staff-history-empty">{error}</div>:rows.length?<div className="staff-attendance-list">{rows.map(row=><article key={row.id}><strong>{row.report_date}</strong><span className={`staff-attendance-status ${row.attendance_status}`}>{label(row.attendance_status)}</span><span>{row.shift_name||'—'}</span><span>{row.status_note||'—'}</span></article>)}</div>:<div className="staff-history-empty">暂无出勤记录。</div>}</section>
}

function StaffPortalExamModal({detail,loading,error,onClose}){
  const session=detail?.session||{},answers=detail?.answers||[]
  return <div className="exam-modal-backdrop" onMouseDown={onClose}><div className="exam-modal wide staff-result-modal" onMouseDown={event=>event.stopPropagation()}><header><div><small>MY EXAM RESULT</small><h2>{session.title||'考试结果'}</h2><p>{session.source_label||'本系统'} · 第 {session.attempt_no||'—'} 次</p></div><button onClick={onClose}>×</button></header>{loading?<div className="staff-history-empty">正在读取完整答卷…</div>:error?<div className="exam-error">{error}</div>:<><div className="staff-result-summary"><div><span>成绩</span><strong>{session.percentage==null?'待批改':`${Number(session.percentage).toFixed(1)}%`}</strong></div><div><span>得分</span><strong>{session.earned_score==null?'—':`${session.earned_score}/${session.total_score}`}</strong></div><div><span>完成时间</span><strong>{staffDateTime(session.submitted_at)}</strong></div><div><span>答题统计</span><strong>{staffExamBreakdown(session)}</strong></div></div><div className="staff-result-list">{answers.length?answers.map((answer,index)=>{const q=answer.question||{};return <article key={q.id||index}><header><b>{index+1}</b><div><strong>{q.question_zh||q.question_en||q.question_vi||'题目内容未保留'}</strong><small>本题 {q.points||0} 分</small></div><span className={`result-chip ${answer.grade_status==='correct'?'pass':answer.grade_status==='partial'?'partial':answer.grade_status==='wrong'?'fail':'pending'}`}>{answer.awarded_score==null?'待批改':`${answer.awarded_score}/${q.points||0} 分`}</span></header><div className="staff-result-answer"><b>我的答案</b><p>{answer.answer_text||'（未作答）'}</p></div>{answer.grader_feedback&&<div className="staff-result-feedback"><b>老师评语</b><p>{answer.grader_feedback}</p></div>}</article>}):<div className="staff-history-empty">该场考试仅保留总成绩，逐题答卷尚未同步。</div>}</div></>}<footer><button className="primary" onClick={onClose}>关闭</button></footer></div></div>
}

export const ComingSoon = ({ title }) => (
  <div className="content-page">
    <div className="page-toolbar"><h1>{title}</h1></div>
    <div className="data-card"><div className="empty-state">暂无数据</div></div>
  </div>
)
