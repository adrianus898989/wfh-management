import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const text = v => String(v ?? '').trim()

const CONFIG = {
  schedule:{
    title:'排班与考勤',
    tabs:['排班表','今日考勤','考勤记录','请假审批','换班记录'],
    subtitle:'员工排班关系已经从排班表导入；出勤与请假历史下一阶段接入。',
  },
  daily:{
    title:'每日工作',
    tabs:['组长日报','培训日报','交接事项','异常问题','奖惩记录'],
    subtitle:'这里将承载组长日报、培训反馈、员工问题、评论和跨班交接。',
  },
  training:{
    title:'考试管理',
    tabs:['考试概览','考试记录','题库','人工批改'],
    subtitle:'题库将读取现有 Google Sheet，考试结果与员工 ID 关联。',
  },
  payroll:{
    title:'工资中心',
    tabs:['工资计算','待复核','已发布','工资规则','导出记录'],
    subtitle:'工资规则保持参数化，流程为生成 → 预览审核 → 批准 → 发布。',
  },
  reports:{
    title:'统计报表',
    tabs:['排班运营统计','人员统计','出勤统计','工资统计','离职率','账号统计'],
    subtitle:'排班运营统计后续会一比一还原现有 paibantongji 六页结构。',
  },
}

function groupCount(rows, getter){
  const m = new Map()
  rows.forEach(r => {
    const k = getter(r) || '未设置'
    m.set(k,(m.get(k)||0)+1)
  })
  return [...m.entries()].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count)
}

export default function ModulePage({ module }) {
  const cfg = CONFIG[module]
  const [searchParams,setSearchParams] = useSearchParams()
  const urlTab = searchParams.get('tab')
  const [tab,setTabState] = useState(cfg.tabs.includes(urlTab)?urlTab:cfg.tabs[0])
  const [q,setQ] = useState('')
  const [draftQ,setDraftQ] = useState('')
  const [advanced,setAdvanced] = useState(true)
  const [data,setData] = useState(null)
  const [loading,setLoading] = useState(true)

  useEffect(()=>{ if(cfg.tabs.includes(urlTab)) setTabState(urlTab) },[urlTab,module])

  const setTab = value => {
    setTabState(value)
    setSearchParams(value===cfg.tabs[0]?{}:{tab:value})
  }

  useEffect(()=>{
    let alive=true
    ;(async()=>{
      const { data } = await supabase.functions.invoke('admin-accounts',{ body:{action:'bootstrap'} })
      if(alive){ setData(data||null); setLoading(false) }
    })()
    return()=>{alive=false}
  },[module])

  const employees = useMemo(() => (data?.employees||[]).filter(e => text(e.status)==='active' || !text(e.status)),[data])
  const filtered = useMemo(()=>{
    const k=q.trim().toLowerCase()
    if(!k) return employees
    return employees.filter(e=>[
      e.employee_no,e.full_name,e.country,e.nationality,e.shift_name,e.platform_scope,
      e?.teams?.name,e?.positions?.name,e.leader_name,e.trainer_name
    ].some(v=>text(v).toLowerCase().includes(k)))
  },[employees,q])

  const teamStats = useMemo(()=>groupCount(employees,e=>e?.teams?.name),[employees])
  const countryStats = useMemo(()=>groupCount(employees,e=>e.country||e.nationality),[employees])
  const typeStats = useMemo(()=>groupCount(employees,e=>e.employment_type),[employees])
  const shiftStats = useMemo(()=>groupCount(employees,e=>e.shift_name),[employees])

  return (
    <div className="content-page module-page pro-module-page">
      <div className="module-title-row">
        <div>
          <div className="module-kicker">WFH MANAGEMENT</div>
          <h1>{cfg.title}</h1>
          <p className="page-subtitle">{cfg.subtitle}</p>
        </div>
        <span className="module-stage-badge">{module==='schedule'||module==='reports'?'已有部分真实数据':'业务结构预览'}</span>
      </div>

      <div className="module-tabs">
        {cfg.tabs.map(x=><button key={x} className={tab===x?'active':''} onClick={()=>setTab(x)}>{x}</button>)}
      </div>

      {(module==='schedule'||module==='reports') && <div className="filter-card">
        <div className="filter-main-row">
          <div className="search-box"><span>⌕</span><input value={draftQ} onChange={e=>setDraftQ(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')setQ(draftQ)}} placeholder="搜索员工ID / 姓名 / 团队 / 班次 / 盘口"/></div>
          <button className="primary-action" onClick={()=>setQ(draftQ)}>查询</button>
          <button className="secondary-action" onClick={()=>{setDraftQ('');setQ('')}}>重置</button>
          <button className="filter-toggle" onClick={()=>setAdvanced(v=>!v)}>{advanced?'收起筛选':'更多筛选'}</button>
        </div>
        {advanced && <div className="filter-hint-row"><span>当前先使用已导入员工与排班字段展示；高级筛选随 paibantongji 页面迁移一起完成。</span></div>}
      </div>}

      {module==='schedule' && tab==='排班表' && <ScheduleTable rows={filtered} loading={loading}/>}
      {module==='reports' && tab==='排班运营统计' && <OpsPreview teamStats={teamStats} shiftStats={shiftStats}/>}
      {module==='reports' && tab==='人员统计' && <PeopleStats teams={teamStats} countries={countryStats} types={typeStats} total={employees.length}/>}
      {module==='daily' && <DailyPreview tab={tab} teamStats={teamStats}/>}
      {module==='training' && <TrainingPreview tab={tab}/>}
      {module==='payroll' && <PayrollPreview tab={tab}/>}
      {module==='schedule' && tab!=='排班表' && <DataPending title={`${cfg.title} · ${tab}`} text="页面位置已固定，等出勤/请假原表导入后接真实记录。"/>}
      {module==='reports' && !['排班运营统计','人员统计'].includes(tab) && <DataPending title={`${cfg.title} · ${tab}`} text="该统计等待对应业务数据接入后自动计算，不显示假数。"/>}
    </div>
  )
}

function ScheduleTable({ rows,loading }){
  return <div className="data-card">
    <div className="section-head"><div><h2>当前排班关系</h2><p>来自已导入员工 + 排班匹配结果。</p></div><span>{loading?'—':`${rows.length} 人`}</span></div>
    {loading?<div className="empty-state">读取中...</div>:<div className="table-scroll"><table className="data-table">
      <thead><tr><th>员工ID</th><th>姓名</th><th>团队</th><th>班次</th><th>岗位</th><th>组长 / 负责人</th><th>培训</th><th>国家</th><th>盘口</th></tr></thead>
      <tbody>{rows.slice(0,700).map(r=><tr key={r.id}><td><strong>{r.employee_no}</strong></td><td>{r.full_name}</td><td>{r?.teams?.name||'-'}</td><td>{r.shift_name||'-'}</td><td>{r?.positions?.name||'-'}</td><td>{r.leader_name||'-'}</td><td>{r.trainer_name||'-'}</td><td>{r.country||r.nationality||'-'}</td><td className="wide-cell">{r.platform_scope||'-'}</td></tr>)}</tbody>
    </table></div>}
  </div>
}

function OpsPreview({teamStats,shiftStats}){
  return <>
    <div className="legacy-tabs-preview">{['总汇','人员','排班表','盘口人数','统计','错误统计'].map((x,i)=><span className={i===0?'active':''} key={x}>{x}</span>)}</div>
    <div className="module-summary-grid">
      <div className="summary-card"><span>排班员工</span><strong>{teamStats.reduce((s,x)=>s+x.count,0)}</strong></div>
      <div className="summary-card"><span>团队</span><strong>{teamStats.length}</strong></div>
      <div className="summary-card"><span>班次</span><strong>{shiftStats.length}</strong></div>
      <div className="summary-card"><span>旧页面迁移</span><strong>待进行</strong></div>
    </div>
    <div className="data-card">
      <div className="section-head"><div><h2>排班运营统计</h2><p>这里就是现有 paibantongji 的固定位置；下一步按原页面一比一迁移六个页签。</p></div><span>当前先展示团队人数</span></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>团队</th><th>人数</th></tr></thead><tbody>{teamStats.map(x=><tr key={x.name}><td><strong>{x.name}</strong></td><td>{x.count}</td></tr>)}</tbody></table></div>
    </div>
  </>
}

function PeopleStats({teams,countries,types,total}){
  return <>
    <div className="module-summary-grid">
      <div className="summary-card"><span>在职人员</span><strong>{total}</strong></div>
      <div className="summary-card"><span>团队</span><strong>{teams.length}</strong></div>
      <div className="summary-card"><span>国家</span><strong>{countries.length}</strong></div>
      <div className="summary-card"><span>员工类型</span><strong>{types.length}</strong></div>
    </div>
    <div className="stats-three-grid">
      <StatBox title="团队人数" rows={teams}/>
      <StatBox title="国家人数" rows={countries}/>
      <StatBox title="员工类型" rows={types}/>
    </div>
  </>
}

function StatBox({title,rows}){
  return <div className="data-card stat-box"><h2>{title}</h2>{rows.slice(0,15).map(x=><div className="stat-line" key={x.name}><span>{x.name}</span><strong>{x.count}</strong></div>)}</div>
}

function DailyPreview({tab,teamStats}){
  const copy = {
    '组长日报':['组长每日提交','团队人数自动带出','员工状态 / 问题 / 明日计划','Founder 查看 / 评论 / 退回'],
    '培训日报':['培训人员','培训主题','掌握度 / 测试分数','Passed / Retrain / Failed'],
    '交接事项':['根据对班关系自动带接班人','待接收 → 已接收 → 已完成','可关联员工和问题','全部评论留痕'],
    '异常问题':['员工问题','严重程度','处理措施','负责人 / 跟进日期'],
    '奖惩记录':['员工','奖励 / 扣款','金额','原因 / 审批记录'],
  }[tab] || []

  return <>
    <div className="workflow-strip">{copy.map((x,i)=><div key={x}><b>{String(i+1).padStart(2,'0')}</b><span>{x}</span></div>)}</div>
    {tab==='组长日报' ? <div className="data-card">
      <div className="section-head"><div><h2>组长日报 · 团队入口</h2><p>真实保存/评论/交接功能下一模块接入；现在先确认后台入口和团队范围。</p></div><span>{teamStats.length} 个团队</span></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>团队</th><th>员工人数</th><th>今日日报</th><th>异常</th><th>待交接</th></tr></thead><tbody>{teamStats.map(x=><tr key={x.name}><td><strong>{x.name}</strong></td><td>{x.count}</td><td>—</td><td>—</td><td>—</td></tr>)}</tbody></table></div>
    </div> : <DataPending title={`每日工作 · ${tab}`} text="页面与流程已放到固定位置；下一模块建立真实保存、评论和审批数据表。"/>}
  </>
}

function TrainingPreview({tab}){
  return <><div className="workflow-strip">{['题库同步','员工答题','人工批改','成绩 / 复训'].map((x,i)=><div key={x}><b>{String(i+1).padStart(2,'0')}</b><span>{x}</span></div>)}</div><DataPending title={`考试管理 · ${tab}`} text="保留 Google Sheet 题库同步、图片题目、多语言、人工批改和历史成绩。"/></>
}

function PayrollPreview({tab}){
  return <><div className="workflow-strip">{['生成工资','预览审核','批准','发布','导出明细'].map((x,i)=><div key={x}><b>{String(i+1).padStart(2,'0')}</b><span>{x}</span></div>)}</div><DataPending title={`工资中心 · ${tab}`} text="工资规则继续做成后台可配置参数；金额按现有员工类型和考勤记录计算。"/></>
}

function DataPending({title,text}){
  return <div className="data-card module-empty pro-empty"><div><span className="empty-icon">◇</span><h2>{title}</h2><p>{text}</p></div></div>
}
