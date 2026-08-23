import React,{useEffect,useMemo,useRef,useState} from 'react'
import {useSearchParams} from 'react-router-dom'
import {supabase} from '../lib/supabase'
import {Pagination} from '../components/DataPageControls'

const text=v=>String(v??'').trim()
const OPS=['总汇','人员','排班表','盘口人数','统计','错误统计']
const SPECIAL_POSITIONS=['出款','彩金','客服','查单']
const blankFilters=()=>({q:'',shift:'',team:'',group:'',position:'',country:'',supervisor:'',platform:''})
const FILTER_PROFILES={
  总汇:['q','team','group','position','country','supervisor','platform'],
  人员:['q','team','group','position','country','supervisor'],
  排班表:['q','shift','team','group','position'],
  盘口人数:['q','platform','shift','team','position','country'],
  统计:['q','team','group','position','country','supervisor','platform'],
}
const SEARCH_PLACEHOLDERS={
  总汇:'姓名 / ID / 团队 / 岗位 / 负责人',
  人员:'姓名 / ID / 工作内容',
  排班表:'姓名 / ID / 班次 / 工作内容',
  盘口人数:'姓名 / ID / 盘口',
  统计:'姓名 / ID / 岗位 / 盘口',
}
const uniq=arr=>[...new Set((arr||[]).map(text).filter(Boolean))]
const ERROR_GRADE_CHOICES=[['','全部等级'],['excellent','优秀（0错误）'],['normal','正常（1–8）'],['attention','注意（9–15）'],['watch','重点（16–30）'],['high','高频（31+）']]
const errorGradeKey=value=>{const count=Number(value||0);return count>=31?'high':count>=16?'watch':count>=9?'attention':count>=1?'normal':'excellent'}
const errorGradeLabel=value=>({excellent:'优秀',normal:'正常',attention:'注意',watch:'重点',high:'高频'}[text(value)]||'优秀')
const employeeStatusName=value=>({active:'在职',probation:'试用',suspended:'停用',inactive:'停用',resigned:'离职'}[text(value)]||text(value)||'—')
const employeeTypeName=value=>({home_ph:'纯居家菲律宾',onsite_to_home:'现场转居家',home_vn:'纯居家越南',home_id:'纯居家印尼',home_mm:'纯居家缅甸'}[text(value)]||text(value)||'—')
const formatDate=value=>text(value).slice(0,10)||'—'
const formatDateTime=value=>{if(!text(value))return'—';const d=new Date(value);return Number.isNaN(d.getTime())?text(value):d.toLocaleString('zh-CN',{hour12:false})}
function parseIsoDateOnly(value){
  const raw=text(value).slice(0,10)
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return null
  const [year,month,day]=raw.split('-').map(Number)
  const date=new Date(Date.UTC(year,month-1,day,12))
  return Number.isNaN(date.getTime())?null:date
}
function tenureDurationLabel(hireDate,resignDate,status){
  const start=parseIsoDateOnly(hireDate)
  if(!start)return'入职日期待完善'
  const today=new Date()
  const todayUtc=new Date(Date.UTC(today.getFullYear(),today.getMonth(),today.getDate(),12))
  const resign=parseIsoDateOnly(resignDate)
  const end=status==='resigned'&&resign?resign:todayUtc
  const totalDays=Math.floor((end.getTime()-start.getTime())/86400000)
  if(totalDays<0)return`待入职 · 还有 ${Math.abs(totalDays)} 天`
  let years=end.getUTCFullYear()-start.getUTCFullYear()
  let months=end.getUTCMonth()-start.getUTCMonth()
  let days=end.getUTCDate()-start.getUTCDate()
  if(days<0){
    const previousMonthDays=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),0,12)).getUTCDate()
    days+=previousMonthDays
    months-=1
  }
  if(months<0){months+=12;years-=1}
  const parts=[]
  if(years>0)parts.push(`${years}年`)
  if(months>0||years>0)parts.push(`${months}个月`)
  parts.push(`${days}天`)
  return`${parts.join(' ')} · 共 ${totalDays} 天`
}
const personKey=r=>text(r.name)
const uniqueCount=rows=>new Set((rows||[]).map(personKey).filter(Boolean)).size
const fmtPct=(n,d)=>d?`${((Number(n)||0)/(Number(d)||1)*100).toFixed(2)}%`:'0.00%'
const isoToday=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
const isoAdd=(base,days)=>{const d=new Date(`${base}T12:00:00`);d.setDate(d.getDate()+days);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
const peoplePriority=r=>{const pos=text(r.position),grp=text(r.group),work=text(r.work_content);if(pos==='组长'||grp.includes('组长')||work.includes('组长'))return 0;if(pos==='培训'||grp.includes('培训'))return 1;return 2}
const sortPeopleRows=rows=>[...(rows||[])].sort((a,b)=>peoplePriority(a)-peoplePriority(b)||text(a.group).localeCompare(text(b.group),'zh-CN')||text(a.team).localeCompare(text(b.team),'zh-CN')||text(a.name).localeCompare(text(b.name),'zh-CN'))

function filterRoster(rows,f){
  const q=text(f.q).toLowerCase()
  return (rows||[]).filter(r=>{
    if(f.shift&&text(r.shift)!==f.shift)return false
    if(f.team&&text(r.team)!==f.team)return false
    if(f.group&&text(r.group)!==f.group)return false
    if(f.position&&text(r.position)!==f.position)return false
    if(f.country&&text(r.country)!==f.country)return false
    if(f.platform&&text(r.platform)!==f.platform)return false
    if(f.supervisor&&!([r.responsible,r.onsite_trainer,r.online_leader,r.online_trainer].map(text).includes(f.supervisor)))return false
    if(q){
      const hay=[r.name,r.employee_id,r.team,r.group,r.position,r.shift,r.platform,r.country,r.work_content,r.responsible,r.onsite_trainer,r.online_leader,r.online_trainer].map(text).join(' ').toLowerCase()
      if(!hay.includes(q))return false
    }
    return true
  })
}

export default function AdminReportsPage(){
  const [sp,setSp]=useSearchParams()
  const requestedTab=sp.get('tab')
  const [tab,setTabState]=useState(OPS.includes(requestedTab)?requestedTab:'总汇')
  const [overview,setOverview]=useState(null)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [filters,setFilters]=useState(blankFilters())
  const [draftFilters,setDraftFilters]=useState(blankFilters())

  const invoke=async body=>{
    const {data,error}=await supabase.functions.invoke('admin-reports',{body})
    if(error){
      let detail=''
      try{
        const response=error.context?.clone?error.context.clone():error.context
        const payload=await response?.json?.()
        detail=text(payload?.error||payload?.message)
      }catch{}
      throw new Error(detail||error.message||'统计数据读取失败')
    }
    if(data?.error)throw new Error(data.error)
    return data
  }
  const load=async(silent=false)=>{
    if(!silent)setLoading(true)
    try{setOverview(await invoke({action:'overview'}));setError('')}
    catch(e){setError(e.message||'统计数据读取失败')}
    finally{if(!silent)setLoading(false)}
  }
  useEffect(()=>{load();const t=setInterval(()=>{if(!document.hidden)load(true)},300000);return()=>clearInterval(t)},[])
  useEffect(()=>{const next=OPS.includes(requestedTab)?requestedTab:'总汇';setTabState(current=>current===next?current:next)},[requestedTab])

  const setTab=next=>{setTabState(next);setSp(next==='总汇'?{}:{tab:next},{replace:true})}

  const roster=useMemo(()=>filterRoster(overview?.roster||[],filters),[overview,filters])
  const applyFilters=()=>setFilters({...draftFilters})
  const resetFilters=()=>{const next=blankFilters();setDraftFilters(next);setFilters(next)}

  return <div className="content-page reports-page rp-page">
    <div className="rp-head">
      <div><div className="module-kicker">REPORTS & OPERATIONS</div><h1>统计报表</h1></div>
      <div className="rp-live"><i/><div><small>{overview?.updated_at?`最近读取 ${new Date(overview.updated_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})} · 5分钟自动刷新`:'读取中'}</small></div><button onClick={()=>load()}>刷新</button></div>
    </div>
    {error&&<div className="rp-error">{error}<button onClick={()=>setError('')}>×</button></div>}
    <div className="rp-tabs">{OPS.map(x=><button key={x} className={tab===x?'active':''} onClick={()=>setTab(x)}>{x}</button>)}</div>
    {!['错误统计','统计'].includes(tab)&&<GlobalFilters tab={tab} value={draftFilters} onChange={setDraftFilters} onQuery={applyFilters} onReset={resetFilters} options={overview?.options||{}} meta={`筛选后 ${uniqueCount(roster)} 人`}/>}
    {loading&&!overview?<Loading/>:<>
      {tab==='总汇'&&<Overview data={overview} rows={roster}/>} 
      {tab==='人员'&&<People rows={roster}/>} 
      {tab==='排班表'&&<Schedule rows={roster}/>} 
      {tab==='盘口人数'&&<Platforms rows={roster}/>} 
      {tab==='统计'&&<OrdersManualQuery invoke={invoke} roster={roster} onError={setError} filterValue={draftFilters} onFilterChange={setDraftFilters} onFilterQuery={applyFilters} onFilterReset={resetFilters} filterOptions={overview?.options||{}} filterMeta={`筛选后 ${uniqueCount(roster)} 人`}/>}
      {tab==='错误统计'&&<Errors onError={setError}/>}
    </>}
  </div>
}

function Loading(){return <div className="rp-card rp-loading">正在读取 Supabase 同步数据…</div>}
function GlobalFilters({tab,value,onChange,onQuery,onReset,options,meta,extraFields,extraActions,loading=false}){
  const set=(key,next)=>onChange({...value,[key]:next})
  const visible=new Set(FILTER_PROFILES[tab]||FILTER_PROFILES.总汇)
  return <div className={`rp-filterbar rp-filterbar-${tab}`}>
    {visible.has('q')&&<label className="rp-filter-field rp-filter-search"><span>综合搜索</span><input className="rp-search" value={value.q} onChange={event=>set('q',event.target.value)} onKeyDown={event=>{if(event.key==='Enter')onQuery()}} placeholder={SEARCH_PLACEHOLDERS[tab]||SEARCH_PLACEHOLDERS.总汇}/></label>}
    {visible.has('shift')&&<label className="rp-filter-field"><span>班次</span><Select value={value.shift} onChange={next=>set('shift',next)} options={options.shifts} all="全部班次"/></label>}
    {visible.has('team')&&<label className="rp-filter-field"><span>团队</span><Select value={value.team} onChange={next=>set('team',next)} options={options.teams} all="全部团队"/></label>}
    {visible.has('group')&&<label className="rp-filter-field"><span>组别</span><Select value={value.group} onChange={next=>set('group',next)} options={options.groups} all="全部组别"/></label>}
    {visible.has('position')&&<label className="rp-filter-field"><span>岗位</span><Select value={value.position} onChange={next=>set('position',next)} options={options.positions} all="全部岗位"/></label>}
    {visible.has('country')&&<label className="rp-filter-field"><span>国家</span><Select value={value.country} onChange={next=>set('country',next)} options={options.countries} all="全部国家"/></label>}
    {visible.has('supervisor')&&<label className="rp-filter-field"><span>负责人</span><input list="rp-supervisors" value={value.supervisor} onChange={event=>set('supervisor',event.target.value)} onKeyDown={event=>{if(event.key==='Enter')onQuery()}} placeholder="负责人 / 培训 / 组长"/></label>}
    <datalist id="rp-supervisors">{(options.supervisors||[]).map(x=><option key={x} value={x}/>)}</datalist>
    {visible.has('platform')&&<label className="rp-filter-field"><span>盘口</span><Select value={value.platform} onChange={next=>set('platform',next)} options={options.platforms} all="全部盘口"/></label>}
    {extraFields}
    <div className="rp-filter-actions"><button className="rp-query" disabled={loading} onClick={onQuery}>{loading?'查询中…':'查询'}</button><button className="rp-reset" disabled={loading} onClick={onReset}>重置</button>{extraActions}</div>
    <div className="rp-filter-meta">{meta}</div>
  </div>
}
function Select({value,onChange,options,all}){return <select value={value||''} onChange={e=>onChange(e.target.value)}><option value="">{all}</option>{(options||[]).map(x=><option key={x} value={x}>{x}</option>)}</select>}

function Overview({data,rows}){
  const [modal,setModal]=useState(null),[manager,setManager]=useState(null)
  const positions=uniq(rows.map(r=>r.position)).filter(p=>!SPECIAL_POSITIONS.includes(p)).sort((a,b)=>a.localeCompare(b,'zh-CN'))
  const teams=useMemo(()=>{const m=new Map();rows.forEach(r=>{const k=text(r.team)||'未填写';if(!m.has(k))m.set(k,[]);m.get(k).push(r)});return [...m.entries()].map(([team,list])=>({team,list,total:uniqueCount(list)})).sort((a,b)=>b.total-a.total)},[rows])
  const managerSet=field=>uniq(rows.map(r=>r[field]))
  const managers={responsible:managerSet('responsible'),onsite_trainer:managerSet('onsite_trainer'),online_leader:managerSet('online_leader'),online_trainer:managerSet('online_trainer')}
  const specialStats=(list,pos)=>{const people=list.filter(r=>text(r.position)===pos),ids=uniq(people.map(r=>r.employee_id));let total=0,days=0;ids.forEach(id=>{const s=data?.order_summary?.[id];if(s){total+=Number(s.total||0);days+=Number(s.working_days||0)}});return {count:uniqueCount(people),avg:days?(total/days).toFixed(1):'0.0',people}}
  const openPeople=(title,list)=>setModal({title,rows:list})
  return <><section className="rp-card"><div className="rp-card-title"><div><h2>统计总览</h2><p>与原版相同：按姓名去重；负责人 / 现场培训 / 线上组长 / 线上培训均来自排班表。</p></div><span>数据源：居家排班表 · 填表</span></div><div className="rp-kpis"><Kpi label="总人数（去重）" value={uniqueCount(rows)} sub="姓名 unique" onClick={()=>openPeople('总人数名单',rows)}/><Kpi label="负责人" value={managers.responsible.length} sub="点击姓名再看下属" onClick={()=>setManager({label:'负责人',field:'responsible',names:managers.responsible})}/><Kpi label="现场培训" value={managers.onsite_trainer.length} sub="点击姓名再看下属" onClick={()=>setManager({label:'现场培训',field:'onsite_trainer',names:managers.onsite_trainer})}/><Kpi label="线上组长" value={managers.online_leader.length} sub="点击姓名再看下属" onClick={()=>setManager({label:'线上组长',field:'online_leader',names:managers.online_leader})}/><Kpi label="线上培训" value={managers.online_trainer.length} sub="点击姓名再看下属" onClick={()=>setManager({label:'线上培训',field:'online_trainer',names:managers.online_trainer})}/></div></section>
    <section className="rp-card rp-team-matrix-card"><div className="rp-card-title"><div><h2>团队统计表</h2><p>普通岗位显示人数；出款 / 彩金 / 客服 / 查单显示人数 + 平均每天处理。</p></div><span>{teams.length} 个团队</span></div><div className="rp-table-scroll"><table className="rp-table rp-team-table"><thead><tr><th>团队</th><th>总人数</th>{positions.map(p=><th key={p}>{p}</th>)}{SPECIAL_POSITIONS.map(p=><th key={p}>{p}</th>)}</tr></thead><tbody>{teams.map(t=><tr key={t.team}><td><button className="rp-link" onClick={()=>openPeople(`${t.team} 员工名单`,t.list)}>{t.team}</button></td><td><button className="rp-link" onClick={()=>openPeople(`${t.team} 员工名单`,t.list)}>{t.total}</button></td>{positions.map(p=>{const list=t.list.filter(r=>text(r.position)===p);return <td key={p}><button className="rp-link" onClick={()=>openPeople(`${t.team} · ${p}`,list)}>{uniqueCount(list)}</button></td>})}{SPECIAL_POSITIONS.map(p=>{const s=specialStats(t.list,p);return <td key={p}><button className="rp-special-count" onClick={()=>openPeople(`${t.team} · ${p}`,s.people)}>{s.count}</button><button className="rp-avg" onClick={()=>setModal({average:true,title:`${t.team} · ${p}`,rows:s.people,avg:s.avg})}>📊 {s.avg}</button></td>})}</tr>)}</tbody></table></div></section>
    <div className="rp-grid2"><Ranking title="岗位分布" rows={rows} field="position" onOpen={openPeople}/><Ranking title="团队人数" rows={rows} field="team" onOpen={openPeople}/></div>{modal?.average?<AverageModal data={data} modal={modal} onClose={()=>setModal(null)} onOpenPeople={openPeople}/>:modal&&<RosterModal title={modal.title} rows={modal.rows} onClose={()=>setModal(null)}/>} {manager&&<ManagerModal cfg={manager} roster={rows} onClose={()=>setManager(null)} onOpen={openPeople}/>}</>}
function Kpi({label,value,sub,onClick}){return <button className="rp-kpi" onClick={onClick}><span>{label}</span><strong>{value}</strong><small>{sub}</small></button>}
function Ranking({title,rows,field,onOpen}){const groups=useMemo(()=>{const m=new Map();rows.forEach(r=>{const k=text(r[field])||'未填写';if(!m.has(k))m.set(k,[]);m.get(k).push(r)});return [...m].map(([name,list])=>({name,list,count:uniqueCount(list)})).sort((a,b)=>b.count-a.count)},[rows,field]);const total=uniqueCount(rows)||1;return <section className="rp-card"><div className="rp-card-title"><div><h3>{title}</h3><p>点击条目查看人员</p></div></div><div className="rp-bars">{groups.map(x=><button key={x.name} onClick={()=>onOpen(`${x.name} · ${x.count} 人`,x.list)}><span>{x.name}</span><strong>{x.count}</strong><i><b style={{width:`${Math.min(100,x.count/total*100)}%`}}/></i></button>)}</div></section>}
function ManagerModal({cfg,roster,onClose,onOpen}){return <Modal title={`${cfg.label} 名单（${cfg.names.length}）`} onClose={onClose}><div className="rp-manager-grid">{cfg.names.map(n=>{const subs=roster.filter(r=>text(r[cfg.field])===n);return <button key={n} onClick={()=>onOpen(`${cfg.label}：${n}（下属 ${uniqueCount(subs)}）`,subs)}><strong>{n}</strong><span>下属 {uniqueCount(subs)} 人</span></button>})}</div></Modal>}
function AverageModal({data,modal,onClose,onOpenPeople}){const dates=data?.recent_order_dates||[];const list=modal.rows.map(r=>({r,total:dates.reduce((s,d)=>s+Number(data?.recent_orders?.[r.employee_id]?.[d]||0),0)})).filter(x=>x.total>0).sort((a,b)=>b.total-a.total);const lows={};dates.forEach(d=>{const vals=uniq(list.map(x=>String(data?.recent_orders?.[x.r.employee_id]?.[d]||0))).map(Number).filter(v=>v>0).sort((a,b)=>a-b);lows[d]=vals.slice(0,3)});return <Modal title={`${modal.title}（平均 ${modal.avg} 单/天）`} onClose={onClose} wide><div className="rp-average-summary">最近7天员工处理明细 · 红 / 橙 / 黄 = 当天倒数前三个正数</div><div className="rp-table-scroll"><table className="rp-table"><thead><tr><th>#</th><th>ID</th><th>姓名</th><th>总7天</th>{dates.map(d=><th key={d}>{d.slice(5)}</th>)}</tr></thead><tbody>{list.map((x,i)=><tr key={`${x.r.employee_id}-${i}`}><td>{i+1}</td><td><button className="rp-link" onClick={()=>onOpenPeople('员工详情',[x.r])}>{x.r.employee_id||'—'}</button></td><td>{x.r.name}</td><td><strong>{x.total}</strong></td>{dates.map(d=>{const v=Number(data?.recent_orders?.[x.r.employee_id]?.[d]||0),rank=lows[d].indexOf(v);return <td key={d}><span className={v>0?rank===0?'rp-low1':rank===1?'rp-low2':rank===2?'rp-low3':'rp-positive':'rp-zero'}>{v||'—'}</span></td>})}</tr>)}</tbody></table></div></Modal>}

function People({rows}){const [mode,setMode]=useState('cards'),[page,setPage]=useState(1),[size,setSize]=useState(24),[modal,setModal]=useState(null);const sorted=useMemo(()=>sortPeopleRows(rows),[rows]);useEffect(()=>setPage(1),[rows,mode,size]);const pages=Math.max(1,Math.ceil(sorted.length/size)),slice=sorted.slice((page-1)*size,page*size);return <section className="rp-card"><div className="rp-card-title"><div><h2>Employees</h2><p>字段按原版展示；组长 / 现场组长优先。现场人员只要在排班表就显示，不要求存在于居家员工名单。</p></div><div className="rp-view-buttons"><button className={mode==='cards'?'active':''} onClick={()=>setMode('cards')}>Cards view（不横滚）</button><button className={mode==='table'?'active':''} onClick={()=>setMode('table')}>Table view（完整列）</button><button onClick={()=>setModal({title:'Employees 完整表',rows:sorted})}>弹窗全屏查看</button></div></div>{mode==='cards'?<div className="rp-cards">{slice.map(r=>{const leader=peoplePriority(r)===0;return <article className={`rp-person-card ${leader?'is-leader':''}`} key={r.key}><div className="rp-person-top"><div className="rp-person-main"><strong>{r.name||'(未填写姓名)'}</strong><div className="rp-person-badges"><span>{r.position||'未填写'}</span><span>团队: {r.team||'未填写'}</span><span>组别: {r.group||'未填写'}</span>{r.shift&&<span>班次: {r.shift}</span>}</div></div><div className="rp-person-side"><em>{r.employee_id||'No ID'}</em><small>{r.country||'—'}</small></div></div><dl><div><dt>负责人</dt><dd>{r.responsible||'—'}</dd></div><div><dt>现场培训</dt><dd>{r.onsite_trainer||'—'}</dd></div><div><dt>线上组长</dt><dd>{r.online_leader||'—'}</dd></div><div><dt>线上培训</dt><dd>{r.online_trainer||'—'}</dd></div><div className="wide"><dt>盘口</dt><dd>{r.platform||'—'}</dd></div><div className="wide"><dt>工作内容</dt><dd>{r.work_content||'—'}</dd></div></dl></article>})}</div>:<RosterTable rows={slice}/>}<Pagination page={page} pages={pages} total={sorted.length} pageSize={size} onPage={setPage} onPageSize={n=>{setSize(n);setPage(1)}}/>{modal&&<RosterModal title={modal.title} rows={modal.rows} onClose={()=>setModal(null)}/>}</section>}
function Schedule({rows}){const [modal,setModal]=useState(null),[page,setPage]=useState(1),[size,setSize]=useState(30);const shifts=useMemo(()=>{const m=new Map();rows.forEach(r=>{const k=text(r.shift);if(!k)return;if(!m.has(k))m.set(k,[]);m.get(k).push(r)});return [...m].map(([name,list])=>({name,list,count:uniqueCount(list)})).sort((a,b)=>b.count-a.count)},[rows]);const noShift=rows.filter(r=>!text(r.shift)),pages=Math.max(1,Math.ceil(rows.length/size)),slice=rows.slice((page-1)*size,page*size);useEffect(()=>setPage(1),[rows,size]);return <><section className="rp-card"><div className="rp-card-title"><div><h2>排班表</h2><p>实时读取居家排班表「填表」；所有有效姓名都纳入，不要求 ID。</p></div><span>{uniqueCount(rows)} 人</span></div><div className="rp-shift-grid">{shifts.map(x=><button key={x.name} onClick={()=>setModal({title:`班次：${x.name}`,rows:x.list})}><span>班次</span><strong>{x.name}</strong><em>{x.count} 人</em></button>)}<button onClick={()=>setModal({title:'未填写班次',rows:noShift})}><span>班次</span><strong>未填写班次</strong><em>{uniqueCount(noShift)} 人</em></button></div></section><section className="rp-card"><div className="rp-card-title"><div><h3>排班明细</h3><p>负责人 / 现场培训 / 线上组长 / 线上培训 / 团队 / 组别 / 班次 / 岗位 / 姓名 / ID / 国家 / 盘口 / 工作内容</p></div><button className="rp-soft-btn" onClick={()=>setModal({title:'排班明细',rows})}>弹窗全屏查看</button></div><RosterTable rows={slice}/><Pagination page={page} pages={pages} total={rows.length} pageSize={size} onPage={setPage} onPageSize={n=>{setSize(n);setPage(1)}}/></section>{modal&&<RosterModal title={modal.title} rows={modal.rows} onClose={()=>setModal(null)}/>}</>}
function Platforms({rows}){
  const [modal,setModal]=useState(null),total=uniqueCount(rows)
  const list=useMemo(()=>{const groups=new Map();rows.forEach(row=>{const platform=text(row.platform)||'未填写',name=text(row.name);if(!name)return;if(!groups.has(platform))groups.set(platform,{rows:[],names:new Set(),day:new Set(),night:new Set(),mid:new Set(),positions:new Map()});const item=groups.get(platform);item.rows.push(row);item.names.add(name);const shift=text(row.shift).toLowerCase();if(shift.includes('day')||shift.includes('白'))item.day.add(name);else if(shift.includes('night')||shift.includes('夜'))item.night.add(name);else if(shift.includes('mid')||shift.includes('中'))item.mid.add(name);const position=text(row.position)||'未填写';if(!item.positions.has(position))item.positions.set(position,new Set());item.positions.get(position).add(name)});return [...groups].map(([platform,item])=>({platform,rows:item.rows,total:item.names.size,day:item.day.size,night:item.night.size,mid:item.mid.size,positions:[...item.positions].map(([name,names])=>({name,count:names.size})).sort((a,b)=>b.count-a.count)})).sort((a,b)=>b.total-a.total)},[rows])
  const largest=list[0],missing=list.find(item=>item.platform==='未填写')?.total||0
  return <><section className="rp-card rp-platforms"><div className="rp-card-title"><div><h2>盘口人数统计</h2><p>按员工姓名去重；点击任一盘口卡片可查看完整员工名单。</p></div><span>{list.length} 个盘口</span></div><div className="rp-platform-kpis"><div><span>筛选后总人数</span><strong>{total}</strong><small>当前筛选范围</small></div><div><span>盘口类别</span><strong>{list.length}</strong><small>包含未填写</small></div><div><span>最大盘口</span><strong>{largest?.total||0}</strong><small>{largest?.platform||'—'}</small></div><div className={missing?'warn':''}><span>未填写盘口</span><strong>{missing}</strong><small>{missing?'建议补充资料':'资料完整'}</small></div></div><div className="rp-platform-grid">{list.map((item,index)=><button className={`rp-platform-card ${index<3?'is-top':''}`} key={item.platform} onClick={()=>setModal({title:`盘口：${item.platform}`,rows:item.rows})}><header><span className="rp-platform-rank">#{index+1}</span><strong title={item.platform}>{item.platform}</strong><em>{fmtPct(item.total,total)}</em></header><div className="rp-platform-total"><strong>{item.total}</strong><span>人</span></div><div className="rp-platform-progress"><i style={{width:`${Math.min(100,item.total/Math.max(1,largest?.total||1)*100)}%`}}/></div><div className="rp-platform-shifts"><span>白班 <b>{item.day}</b></span><span>夜班 <b>{item.night}</b></span><span>中班 <b>{item.mid}</b></span></div><div className="rp-platform-positions">{item.positions.slice(0,4).map(position=><span key={position.name}>{position.name} <b>{position.count}</b></span>)}{item.positions.length>4&&<span>+{item.positions.length-4} 岗位</span>}</div><footer>查看员工名单 →</footer></button>)}</div>{!list.length&&<div className="rp-empty">当前筛选条件下没有盘口人员</div>}</section>{modal&&<RosterModal title={modal.title} rows={modal.rows} onClose={()=>setModal(null)}/>}</>
}

function Orders({invoke,roster,onError}){const [range,setRange]=useState({from:'',to:''}),[position,setPosition]=useState(''),[data,setData]=useState(null),[loading,setLoading]=useState(true),[sort,setSort]=useState({key:'total',asc:false}),[page,setPage]=useState(1),[size,setSize]=useState(30),[mistakes,setMistakes]=useState(null);const load=async(next=range)=>{setLoading(true);try{const d=await invoke({action:'orders',date_from:next.from,date_to:next.to});setData(d);onError('')}catch(e){onError(e.message||'统计读取失败')}finally{setLoading(false)}};useEffect(()=>{load()},[]);useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)load(range)},300000);return()=>clearInterval(t)},[range.from,range.to]);const allowed=useMemo(()=>new Set(roster.map(r=>r.employee_id).filter(Boolean)),[roster]);const rows=useMemo(()=>{let x=(data?.rows||[]).filter(r=>allowed.has(r.employee_id)&&(!position||r.position===position));x=[...x].sort((a,b)=>{const av=Number(a[sort.key]||0),bv=Number(b[sort.key]||0);return sort.asc?av-bv:bv-av});return x},[data,allowed,position,sort]);useEffect(()=>setPage(1),[position,sort,size,roster]);const pages=Math.max(1,Math.ceil(rows.length/size)),slice=rows.slice((page-1)*size,page*size),dates=data?.dates||[];const changeSort=key=>setSort(s=>({key,asc:s.key===key?!s.asc:false}));const quick=kind=>{const end=data?.available_to||isoToday();let next={from:'',to:''};if(kind==='7d')next={from:isoAdd(end,-6),to:end};if(kind==='month')next={from:`${end.slice(0,7)}-01`,to:end};setRange(next);load(next)};const openMistakes=async id=>{try{const d=await invoke({action:'errors',date_from:range.from,date_to:range.to,employee_id:id,date_basis:'review'});setMistakes({id,rows:d.rows||[]})}catch(e){onError(e.message||'错误记录读取失败')}};return <section className="rp-card"><div className="rp-card-title"><div><h2>员工订单处理统计</h2><p>与原版同源：效率表「网站数据」（由 工作表4 + 填表 生成）+ 居家排班表「账号」做后台账号 → ID 映射。</p></div><span>{data?`${data.from||'—'} ~ ${data.to||'—'}`:'读取中'}</span></div><div className="rp-order-toolbar"><label>日期起<input type="date" value={range.from} onChange={e=>setRange({...range,from:e.target.value})}/></label><label>日期止<input type="date" value={range.to} onChange={e=>setRange({...range,to:e.target.value})}/></label><Select value={position} onChange={setPosition} options={data?.options?.positions||[]} all="全部岗位"/><button className="primary" onClick={()=>load()}>查询</button><button onClick={()=>quick('7d')}>最近7天</button><button onClick={()=>quick('month')}>本月</button><button onClick={()=>quick('all')}>全部</button></div>{loading&&!data?<div className="rp-loading-inline">读取订单统计…</div>:<><div className="rp-table-scroll rp-order-scroll"><table className="rp-table rp-order-table"><thead><tr><th>入职日期</th><th>ID</th><th>姓名</th><th>团队</th><th>班次</th><th>国家</th><th>岗位</th><th>盘口</th><th><button onClick={()=>changeSort('total')}>总 ⇅</button></th><th><button onClick={()=>changeSort('avg')}>平均每天处理 ⇅</button></th><th><button onClick={()=>changeSort('mistake_count')}>错误次数 ⇅</button></th>{dates.map(d=><th key={d}>{d}<br/>成功/驳回</th>)}</tr></thead><tbody>{slice.map(r=><tr key={r.employee_id}><td>{r.hire_date||'—'}</td><td><strong>{r.employee_id}</strong></td><td>{r.name}</td><td>{r.team||'—'}</td><td>{r.shift||'—'}</td><td>{r.country||'—'}</td><td>{r.position||'—'}</td><td className="rp-pan-cell">{r.platform||'—'}</td><td><strong>{r.total}</strong></td><td>{r.avg}</td><td><button className="rp-link" onClick={()=>openMistakes(r.employee_id)}>{r.mistake_count}</button></td>{dates.map(d=>{const day=r.daily?.[d]||{success:0,reject:0},before=r.hire_date&&d<r.hire_date;return <td key={d}>{before?'0 / 0':`${day.success||0} / ${day.reject||0}`}</td>})}</tr>)}</tbody></table></div><Pagination page={page} pages={pages} total={rows.length} pageSize={size} loading={loading} onPage={setPage} onPageSize={n=>{setSize(n);setPage(1)}}/></>}{mistakes&&<MistakeListModal id={mistakes.id} rows={mistakes.rows} onClose={()=>setMistakes(null)}/>}</section>}

function OrdersManualQuery({invoke,roster,onError,filterValue,onFilterChange,onFilterQuery,onFilterReset,filterOptions,filterMeta}){
  const [range,setRange]=useState({from:'',to:''})
  const [appliedRange,setAppliedRange]=useState({from:'',to:''})
  const [data,setData]=useState(null)
  const [loading,setLoading]=useState(true)
  const [sort,setSort]=useState({key:'total',asc:false})
  const [page,setPage]=useState(1)
  const [size,setSize]=useState(30)
  const [mistakes,setMistakes]=useState(null)
  const requestRef=useRef(0)
  const load=async(nextRange=appliedRange)=>{
    const requestId=++requestRef.current
    setLoading(true)
    try{
      // Read the synchronized dataset once and apply the current employee scope
      // locally. This keeps the request body small and prevents an older request
      // from overwriting a newer result when several admin windows refresh.
      const d=await invoke({action:'orders',date_from:nextRange.from,date_to:nextRange.to})
      if(requestId!==requestRef.current)return
      setData(d);setAppliedRange(nextRange);setPage(1);onError('')
    }catch(e){if(requestId===requestRef.current)onError(e.message||'统计读取失败')}
    finally{if(requestId===requestRef.current)setLoading(false)}
  }
  useEffect(()=>{load({from:'',to:''})},[])
  useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)load(appliedRange)},300000);return()=>clearInterval(t)},[appliedRange.from,appliedRange.to])
  const allowed=useMemo(()=>new Set(roster.map(r=>r.employee_id).filter(Boolean)),[roster])
  const rows=useMemo(()=>{
    let next=(data?.rows||[]).filter(r=>allowed.has(r.employee_id))
    return [...next].sort((a,b)=>{const av=Number(a[sort.key]||0),bv=Number(b[sort.key]||0);return sort.asc?av-bv:bv-av})
  },[data,allowed,sort])
  useEffect(()=>setPage(1),[sort,size,roster])
  const pages=Math.max(1,Math.ceil(rows.length/size)),slice=rows.slice((page-1)*size,page*size),dates=data?.dates||[]
  const changeSort=key=>setSort(current=>({key,asc:current.key===key?!current.asc:false}))
  const quick=kind=>{
    const end=data?.available_to||isoToday()
    let next={from:'',to:''}
    if(kind==='7d')next={from:isoAdd(end,-6),to:end}
    if(kind==='month')next={from:`${end.slice(0,7)}-01`,to:end}
    setRange(next);onFilterQuery();load(next)
  }
  const query=()=>{onFilterQuery();load({...range})}
  const reset=()=>{const next={from:'',to:''};setRange(next);onFilterReset();load(next)}
  const openMistakes=async id=>{try{const d=await invoke({action:'errors',date_from:appliedRange.from,date_to:appliedRange.to,employee_id:id,date_basis:'review'});setMistakes({id,rows:d.rows||[]})}catch(e){onError(e.message||'错误记录读取失败')}}
  const dateFields=<><label className="rp-filter-field rp-filter-date"><span>日期起</span><input type="date" value={range.from} onChange={e=>setRange({...range,from:e.target.value})}/></label><label className="rp-filter-field rp-filter-date"><span>日期止</span><input type="date" value={range.to} onChange={e=>setRange({...range,to:e.target.value})}/></label></>
  const quickActions=<div className="rp-quick-actions"><button type="button" onClick={()=>quick('7d')}>近7天</button><button type="button" onClick={()=>quick('month')}>本月</button><button type="button" onClick={()=>quick('all')}>全部</button></div>
  return <><GlobalFilters tab="统计" value={filterValue} onChange={onFilterChange} onQuery={query} onReset={reset} options={filterOptions} meta={filterMeta} extraFields={dateFields} extraActions={quickActions} loading={loading}/><section className="rp-card"><div className="rp-card-title"><h2>员工订单处理统计</h2><span>{data?`${data.from||'—'} ~ ${data.to||'—'}`:'读取中'}</span></div>{loading&&!data?<div className="rp-loading-inline">读取订单统计…</div>:<><div className="rp-table-scroll rp-order-scroll"><table className="rp-table rp-order-table"><thead><tr><th>入职日期</th><th>ID</th><th>姓名</th><th>团队</th><th>班次</th><th>国家</th><th>岗位</th><th>盘口</th><th><button onClick={()=>changeSort('total')}>总 ⇅</button></th><th><button onClick={()=>changeSort('avg')}>平均每天处理 ⇅</button></th><th><button onClick={()=>changeSort('mistake_count')}>错误次数 ⇅</button></th>{dates.map(d=><th key={d}>{d}<br/>成功/驳回</th>)}</tr></thead><tbody>{slice.map(r=><tr key={r.employee_id}><td>{r.hire_date||'—'}</td><td><strong>{r.employee_id}</strong></td><td>{r.name}</td><td>{r.team||'—'}</td><td>{r.shift||'—'}</td><td>{r.country||'—'}</td><td>{r.position||'—'}</td><td className="rp-pan-cell">{r.platform||'—'}</td><td><strong>{r.total}</strong></td><td>{r.avg}</td><td><button className="rp-link" onClick={()=>openMistakes(r.employee_id)}>{r.mistake_count}</button></td>{dates.map(d=>{const day=r.daily?.[d]||{success:0,reject:0},before=r.hire_date&&d<r.hire_date;return <td key={d}>{before?'0 / 0':`${day.success||0} / ${day.reject||0}`}</td>})}</tr>)}</tbody></table></div><Pagination page={page} pages={pages} total={rows.length} pageSize={size} loading={loading} onPage={setPage} onPageSize={n=>{setSize(n);setPage(1)}}/></>}{mistakes&&<MistakeListModal id={mistakes.id} rows={mistakes.rows} onClose={()=>setMistakes(null)}/>}</section></>
}

const blankErrorFilters=()=>({employee_id:'',employee_name:'',risk_level:'',error_type:'',qc_person:'',shift:'',team:'',group:'',position:'',country:'',manager:'',platform:''})

function Errors({onError}){
  const [range,setRange]=useState({from:'',to:''}),[appliedRange,setAppliedRange]=useState({from:'',to:''}),[filters,setFilters]=useState(blankErrorFilters()),[appliedFilters,setAppliedFilters]=useState(blankErrorFilters()),[data,setData]=useState(null),[loading,setLoading]=useState(true),[sort,setSort]=useState({key:'qc_date',asc:false}),[page,setPage]=useState(1),[size,setSize]=useState(30),[detail,setDetail]=useState(null),[employeeNo,setEmployeeNo]=useState('')
  const load=async({nextRange=appliedRange,nextFilters=appliedFilters,nextSort=sort,nextPage=page,nextSize=size,silent=false}={})=>{
    if(!silent)setLoading(true)
    try{
      const {data:result,error}=await supabase.functions.invoke('admin-report-errors',{body:{date_from:nextRange.from,date_to:nextRange.to,...nextFilters,page:nextPage,page_size:nextSize,sort_key:nextSort.key,sort_dir:nextSort.asc?'asc':'desc'}})
      if(error||result?.error)throw new Error(result?.error||error?.message||'错误统计读取失败')
      setData(result);setPage(Number(result?.page||nextPage));onError('')
    }catch(e){onError(e.message||'错误统计读取失败')}
    finally{if(!silent)setLoading(false)}
  }
  useEffect(()=>{load({nextRange:{from:'',to:''},nextFilters:blankErrorFilters(),nextPage:1})},[])
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden)load({silent:true})},300000);return()=>clearInterval(timer)},[appliedRange,appliedFilters,sort,page,size])
  const updateFilter=(key,value)=>setFilters(current=>({...current,[key]:value}))
  const query=()=>{const nextRange={...range},nextFilters={...filters};setAppliedRange(nextRange);setAppliedFilters(nextFilters);setPage(1);load({nextRange,nextFilters,nextPage:1})}
  const quick=kind=>{const end=data?.available_to||isoToday();let next={from:'',to:''};if(kind==='7d')next={from:isoAdd(end,-6),to:end};if(kind==='month')next={from:`${end.slice(0,7)}-01`,to:end};setRange(next);setAppliedRange(next);setAppliedFilters({...filters});setPage(1);load({nextRange:next,nextFilters:{...filters},nextPage:1})}
  const reset=()=>{const nextFilters=blankErrorFilters(),nextRange={from:'',to:''},nextSort={key:'qc_date',asc:false};setFilters(nextFilters);setAppliedFilters(nextFilters);setRange(nextRange);setAppliedRange(nextRange);setSort(nextSort);setPage(1);load({nextFilters,nextRange,nextSort,nextPage:1})}
  const showEmployeeErrors=employeeId=>{const nextFilters={...blankErrorFilters(),employee_id:text(employeeId)},nextRange={from:'',to:''},nextSort={key:'qc_date',asc:false};setDetail(null);setEmployeeNo('');setFilters(nextFilters);setAppliedFilters(nextFilters);setRange(nextRange);setAppliedRange(nextRange);setSort(nextSort);setPage(1);load({nextFilters,nextRange,nextSort,nextPage:1})}
  const setSortKey=key=>{const next={key,asc:sort.key===key?!sort.asc:true};setSort(next);setPage(1);load({nextSort:next,nextPage:1})}
  const changePage=next=>{setPage(next);load({nextPage:next})}
  const changeSize=next=>{setSize(next);setPage(1);load({nextSize:next,nextPage:1})}
  const sortMark=key=>sort.key===key?(sort.asc?' ↑':' ↓'):' ↕'
  const SortTh=({field,children})=><th><button className="rp-sort-head" onClick={()=>setSortKey(field)}>{children}{sortMark(field)}</button></th>
  const options=data?.options||{}
  const total=Number(data?.total||0),pages=Math.max(1,Number(data?.pages||1)),rows=data?.rows||[]

  return <section className="rp-card rp-native-errors-card" aria-busy={loading}>
    <div className="rp-card-title"><div><h2>员工错误统计</h2></div><span>{loading&&!data?'读取中…':loading?`搜索中 · 共 ${total} 条`:`共 ${total} 条`}</span></div>
    <div className="rp-order-toolbar"><label>质检时间起<input type="date" value={range.from} onChange={e=>setRange({...range,from:e.target.value})}/></label><label>质检时间止<input type="date" value={range.to} onChange={e=>setRange({...range,to:e.target.value})}/></label><button className="primary" disabled={loading} onClick={query}>{loading?'搜索中…':'查询'}</button><button disabled={loading} onClick={reset}>重置</button><button onClick={()=>quick('7d')}>最近7天</button><button onClick={()=>quick('month')}>本月</button><button onClick={()=>quick('all')}>全部</button></div>
    <div className="rp-native-error-filters primary"><input value={filters.employee_id} onChange={e=>updateFilter('employee_id',e.target.value)} onKeyDown={e=>{if(e.key==='Enter')query()}} placeholder="输入员工ID"/><input value={filters.employee_name} onChange={e=>updateFilter('employee_name',e.target.value)} onKeyDown={e=>{if(e.key==='Enter')query()}} placeholder="输入姓名"/><select value={filters.risk_level} onChange={e=>updateFilter('risk_level',e.target.value)}>{ERROR_GRADE_CHOICES.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><Select value={filters.error_type} onChange={value=>updateFilter('error_type',value)} options={options.error_types||[]} all="全部错误类型"/><Select value={filters.qc_person} onChange={value=>updateFilter('qc_person',value)} options={options.qc_people||[]} all="全部质检人"/></div>
    <div className="rp-native-error-filters advanced"><Select value={filters.shift} onChange={value=>updateFilter('shift',value)} options={options.shifts||[]} all="全部班次"/><Select value={filters.team} onChange={value=>updateFilter('team',value)} options={options.teams||[]} all="全部团队"/><Select value={filters.group} onChange={value=>updateFilter('group',value)} options={options.groups||[]} all="全部组别"/><Select value={filters.position} onChange={value=>updateFilter('position',value)} options={options.positions||[]} all="全部岗位"/><Select value={filters.country} onChange={value=>updateFilter('country',value)} options={options.countries||[]} all="全部国家"/><input list="rp-error-managers" value={filters.manager} onChange={e=>updateFilter('manager',e.target.value)} onKeyDown={e=>{if(e.key==='Enter')query()}} placeholder="负责人 / 培训 / 组长"/><datalist id="rp-error-managers">{(options.managers||[]).map(value=><option key={value} value={value}/>)}</datalist><Select value={filters.platform} onChange={value=>updateFilter('platform',value)} options={options.platforms||[]} all="全部盘口"/></div>
    {loading&&data&&<div className="rp-searching-state" role="status" aria-live="polite"><i/><span>正在搜索员工错误记录…</span></div>}
    {loading&&!data?<div className="rp-loading-inline">正在读取员工错误统计…</div>:<><div className="rp-table-scroll rp-errors-scroll"><table className="rp-table rp-errors-table" data-native-errors-v2723="1"><thead><tr><th>等级</th><SortTh field="employee_id">员工ID</SortTh><SortTh field="name">姓名</SortTh><SortTh field="team">团队</SortTh><SortTh field="position">岗位</SortTh><SortTh field="platform">盘口</SortTh><SortTh field="error_type">错误类型</SortTh><SortTh field="score">扣分</SortTh><SortTh field="qc_person">质检人</SortTh><SortTh field="qc_date">质检时间</SortTh><SortTh field="leader_review">小组长复审</SortTh><SortTh field="qc_result">质检人对/错</SortTh><SortTh field="review_date">复检时间</SortTh><th>操作</th></tr></thead><tbody>{rows.map(r=><tr key={r.key}><td><button className="rp-error-grade rp-error-grade-action" data-grade={errorGradeLabel(r.risk_level)} title={`${r.employee_id} · 点击查看该员工全部错误记录`} onClick={()=>showEmployeeErrors(r.employee_id)}>{errorGradeLabel(r.risk_level)}</button></td><td><button className="rp-link rp-employee-profile-link" onClick={()=>setEmployeeNo(r.employee_id)}>{r.employee_id}</button></td><td>{r.name||'—'}</td><td>{r.team||'—'}</td><td>{r.position||'—'}</td><td><div className="rp-cell-clamp" title={r.platform}>{r.platform||'—'}</div></td><td><div className="rp-cell-clamp" title={r.error_type}>{r.error_type||'—'}</div></td><td>{text(r.score)===''?'—':r.score}</td><td>{r.qc_person||'—'}</td><td>{r.qc_date||'—'}</td><td><div className="rp-cell-clamp">{r.leader_review||'—'}</div></td><td><div className="rp-cell-clamp">{r.qc_result||'—'}</div></td><td>{r.review_date||'—'}</td><td><button className="rp-view-error" onClick={()=>setDetail(r)}>查看错误</button></td></tr>)}</tbody></table></div><Pagination page={page} pages={pages} total={total} pageSize={size} loading={loading} onPage={changePage} onPageSize={changeSize}/></>}
    {detail&&<ErrorDetailModal row={detail} onClose={()=>setDetail(null)}/>} 
    {employeeNo&&<ReportEmployeeDrawer employeeNo={employeeNo} onClose={()=>setEmployeeNo('')}/>}
  </section>
}

function ReportEmployeeDrawer({employeeNo,onClose}){
  const [state,setState]=useState({loading:true,error:'',detail:null,summary:null})
  useEffect(()=>{let alive=true;(async()=>{try{
    const found=await supabase.functions.invoke('admin-employees',{body:{action:'list',page:1,page_size:20,filters:{employee_no:employeeNo,status:''}}})
    if(found.error||found.data?.error)throw new Error(found.data?.error||found.error?.message||'员工读取失败')
    const row=(found.data?.rows||[]).find(item=>upperText(item.employee_no)===upperText(employeeNo))||(found.data?.rows||[])[0]
    if(!row?.id)throw new Error('找不到对应员工档案')
    const [profile,summaryResult]=await Promise.all([supabase.functions.invoke('admin-employees',{body:{action:'detail',employee_id:row.id}}),supabase.from('employee_error_summary').select('employee_no,month_error_count,last_30d_error_count,total_error_count,last_error_date,main_error_type,risk_level').eq('employee_no',employeeNo).maybeSingle()])
    if(profile.error||profile.data?.error)throw new Error(profile.data?.error||profile.error?.message||'员工档案读取失败')
    if(alive)setState({loading:false,error:'',detail:profile.data,summary:summaryResult.data||null})
  }catch(error){if(alive)setState({loading:false,error:error.message||'员工档案读取失败',detail:null,summary:null})}})();return()=>{alive=false}},[employeeNo])
  const detail=state.detail||{},employee=detail.employee||{},contact=detail.contact||{},payment=detail.payment||{},compensation=detail.compensation||{},summary=state.summary||{},missing=detail.missing_fields||[],grade=errorGradeLabel(errorGradeKey(summary.total_error_count))
  return <div className="modal-mask detail-mask wfh-report-employee-mask" onMouseDown={onClose}><div className="employee-detail-drawer employee-detail-v12" onMouseDown={event=>event.stopPropagation()}>
    <div className="employee-hero"><div className="employee-avatar">{text(employee.full_name).slice(0,1).toUpperCase()||'E'}</div><div className="employee-hero-copy"><div className="employee-id-line">{employeeNo}</div><h2>{employee.full_name||'读取员工档案...'}</h2>{employee.id&&<div className="employee-tags"><span>{employeeTypeName(employee.employment_type)}</span><span>{employee.teams?.name||'未匹配团队'}</span><span>{employee.positions?.name||'未设置主档岗位'}</span>{employee.hire_date&&<span className="employee-tenure-chip">{tenureDurationLabel(employee.hire_date,employee.resign_date,employee.status)}</span>}</div>}</div><div className="drawer-head-actions"><button className="drawer-close" onClick={onClose}>×</button></div></div>
    {state.loading?<div className="empty-state">读取完整员工档案...</div>:state.error?<div className="empty-state">{state.error}</div>:<>
      <div className="wfh-v2722-risk-summary" data-grade={grade}><div className="risk-grade"><span>等级</span><strong>{grade}</strong></div><div><span>本月错误</span><strong>{Number(summary.month_error_count||0)} 笔</strong></div><div><span>近30天错误</span><strong>{Number(summary.last_30d_error_count||0)} 笔</strong></div><div><span>总错误</span><strong>{Number(summary.total_error_count||0)} 笔</strong></div><div><span>主要错误 / 最近错误</span><strong>{text(summary.main_error_type)||'—'}{summary.last_error_date?` · ${formatDate(summary.last_error_date)}`:''}</strong></div></div>
      {missing.length>0&&<div className="profile-status-line has-missing"><div><strong>资料待完善 {missing.length} 项</strong><span>{missing.join(' · ')}</span></div></div>}
      <div className="detail-sections detail-sections-v11"><EmployeeInfoPanel title="基本资料" rows={[['员工ID',employee.employee_no],['姓名',employee.full_name],['员工国家',employee.country||employee.nationality],['员工类型',employeeTypeName(employee.employment_type)],['状态',employeeStatusName(employee.status)],['入职日期',formatDate(employee.hire_date)],['入职时长',tenureDurationLabel(employee.hire_date,employee.resign_date,employee.status)],['录入时间',formatDateTime(employee.created_at)],['离职日期',formatDate(employee.resign_date)],...(employee.status==='resigned'?[['离职原因',detail.resignation_reason||'—']]:[])]}/><EmployeeInfoPanel title="组织与排班" rows={[['团队',employee.teams?.name],['主档岗位',employee.positions?.name],['排班岗位',employee.schedule_position],['班次',employee.shift_name],['负责人 / 组长',employee.leader_name],['培训老师',employee.trainer_name],['盘口',employee.platform_scope],['工作内容',employee.work_content]]}/><EmployeeInfoPanel title="联系方式" rows={[['工作TG',employee.work_tg],['后台账号',employee.backend_accounts],['Telegram',contact.telegram_username],['Workfolio邮箱',contact.work_email],['Zoom邮箱',contact.zoom_email],['Facebook',contact.facebook],['WhatsApp',contact.whatsapp_phone]]}/><EmployeeInfoPanel title="工资设置" rows={[['底薪',compensation.base_salary],['日薪',compensation.daily_rate],['默认绩效',compensation.performance_default],['餐补',compensation.meal_allowance],['备注',compensation.note]]}/><EmployeeInfoPanel title="收款资料" rows={[['收款方式',payment.transfer_using||payment.mode],['银行卡 / 钱包账号',payment.bank_wallet_account],['收款姓名',payment.account_name],['USDT 地址',payment.usdt_address],['联系电话',payment.contact_phone],['WhatsApp',payment.whatsapp_number],['员工地址',payment.employee_address]]}/></div>
    </>}
  </div></div>
}
const upperText=value=>text(value).toUpperCase()
function EmployeeInfoPanel({title,rows}){return <section className="detail-panel"><div className="detail-panel-head"><h3>{title}</h3></div><div className="info-rows">{rows.map(([label,value])=><div className="info-row" key={label}><span>{label}</span><strong>{text(value)||'—'}</strong></div>)}</div></section>}

function RosterTable({rows}){return <div className="rp-table-scroll"><table className="rp-table rp-roster-table"><thead><tr><th>负责人</th><th>现场培训</th><th>线上组长</th><th>线上培训</th><th>团队</th><th>组别</th><th>班次</th><th>岗位</th><th>姓名</th><th>ID</th><th>国家</th><th>盘口</th><th>工作内容</th></tr></thead><tbody>{(rows||[]).map((r,i)=><tr key={r.key||`${r.employee_id}-${i}`}><td>{r.responsible||'—'}</td><td>{r.onsite_trainer||'—'}</td><td>{r.online_leader||'—'}</td><td>{r.online_trainer||'—'}</td><td>{r.team||'—'}</td><td>{r.group||'—'}</td><td>{r.shift||'—'}</td><td>{r.position||'—'}</td><td><strong>{r.name||'—'}</strong></td><td>{r.employee_id||'—'}</td><td>{r.country||'—'}</td><td className="rp-pan-cell">{r.platform||'—'}</td><td className="rp-wrap">{r.work_content||'—'}</td></tr>)}</tbody></table></div>}
function RosterModal({title,rows,onClose}){return <Modal title={`${title}（${uniqueCount(rows)} 人）`} onClose={onClose} wide><RosterTable rows={sortPeopleRows(rows)}/></Modal>}
function MistakeListModal({id,rows,onClose}){return <Modal title={`员工错误记录 - ${id}（${rows.length}）`} onClose={onClose} wide><div className="rp-table-scroll"><table className="rp-table"><thead><tr><th>ID</th><th>姓名</th><th>团队</th><th>岗位</th><th>盘口</th><th>会员/id /订单号</th><th>金额</th><th>错误备注</th><th>正确操作方式</th><th>错误类型</th><th>扣分</th><th>质检人</th><th>质检时间</th></tr></thead><tbody>{rows.map(r=><tr key={r.key}><td>{r.employee_id}</td><td>{r.name}</td><td>{r.team}</td><td>{r.position}</td><td className="rp-pan-cell">{r.platform}</td><td className="rp-wrap">{r.member_order}</td><td>{r.amount}</td><td className="rp-wrap">{r.error_note}</td><td className="rp-wrap">{r.correct_action}</td><td>{r.error_type}</td><td>{r.score||'—'}</td><td>{r.qc_person}</td><td>{r.qc_date}</td></tr>)}</tbody></table></div></Modal>}
function ErrorDetailModal({row,onClose}){return <Modal title={`${row.employee_id} · ${row.error_type||'错误记录'}`} onClose={onClose}><div className="rp-detail-grid"><Detail k="姓名" v={row.name}/><Detail k="团队" v={row.team}/><Detail k="岗位" v={row.position}/><Detail k="盘口" v={row.platform}/><Detail k="金额" v={row.amount}/><Detail k="扣分" v={row.score}/><Detail k="质检人" v={row.qc_person}/><Detail k="质检时间" v={row.qc_date}/><Detail k="复检时间" v={row.review_date}/><Detail k="会员/id /订单号" v={row.member_order} wide/><Detail k="错误备注" v={row.error_note} wide/><Detail k="正确操作方式" v={row.correct_action} wide/><Detail k="小组长复审 / 质检人对错" v={[row.leader_review,row.qc_result].filter(Boolean).join(' / ')} wide/></div></Modal>}
function Detail({k,v,wide}){return <div className={wide?'wide':''}><span>{k}</span><p>{text(v)||'—'}</p></div>}
function Modal({title,onClose,children,wide}){return <div className="modal-mask rp-modal-mask" onMouseDown={onClose}><div className={`rp-modal ${wide?'wide':''}`} onMouseDown={e=>e.stopPropagation()}><header><div><span>REPORT DETAIL</span><h2>{title}</h2></div><button onClick={onClose}>×</button></header><div className="rp-modal-body">{children}</div></div></div>}
