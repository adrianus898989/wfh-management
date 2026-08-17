import React,{useEffect,useMemo,useRef,useState} from 'react'
import {useSearchParams} from 'react-router-dom'
import {supabase} from '../lib/supabase'
import {Pagination} from '../components/DataPageControls'

const text=v=>String(v??'').trim()
const pct=v=>`${(Number(v)||0).toFixed((Number(v)||0)>=10?1:2).replace(/\.0$/,'')}%`
const OUTER=['排班运营统计','人员统计','出勤统计','工资统计','离职率','账号统计']
const OPS=['总汇','人员','排班表','盘口人数','统计','错误统计']
const blankFilters=()=>({employee_id:'',name:'',team:'',position:'',country:'',shift:'',platform:'',account:''})
const isoToday=()=>new Date().toISOString().slice(0,10)
const isoAdd=(base,days)=>{const d=new Date(`${base}T12:00:00`);d.setDate(d.getDate()+days);return d.toISOString().slice(0,10)}

export default function AdminReportsPage(){
  const [sp,setSp]=useSearchParams()
  const outer=OUTER.includes(sp.get('tab'))?sp.get('tab'):'排班运营统计'
  const ops=OPS.includes(sp.get('view'))?sp.get('view'):'总汇'
  const [overview,setOverview]=useState(null)
  const [overviewLoading,setOverviewLoading]=useState(true)
  const [error,setError]=useState('')
  const [lastRefresh,setLastRefresh]=useState('')

  const invoke=async body=>{
    const {data,error}=await supabase.functions.invoke('admin-reports',{body})
    if(error||data?.error) throw new Error(data?.error||error?.message||'统计读取失败')
    return data
  }
  const loadOverview=async(silent=false)=>{
    if(!silent)setOverviewLoading(true)
    try{const d=await invoke({action:'overview'});setOverview(d);setLastRefresh(d.updated_at||new Date().toISOString());setError('')}
    catch(e){setError(e.message)}finally{if(!silent)setOverviewLoading(false)}
  }
  useEffect(()=>{loadOverview();const t=setInterval(()=>loadOverview(true),60000);return()=>clearInterval(t)},[])

  const setOuter=v=>setSp(v==='排班运营统计'?{view:ops}:{tab:v})
  const setOps=v=>setSp({view:v})

  return <div className="content-page reports-page">
    <div className="reports-title-row">
      <div><div className="module-kicker">WFH MANAGEMENT</div><h1>统计报表</h1><p>排班、人员、盘口、效率与错误数据统一查看。</p></div>
      <div className="reports-live"><i/><span>{lastRefresh?`更新 ${new Date(lastRefresh).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`:'读取中'}</span><button onClick={()=>loadOverview()}>刷新</button></div>
    </div>
    <div className="module-tabs reports-outer-tabs">{OUTER.map(x=><button key={x} className={outer===x?'active':''} onClick={()=>setOuter(x)}>{x}</button>)}</div>
    {error&&<div className="reports-error">{error}<button onClick={()=>setError('')}>×</button></div>}
    {outer==='排班运营统计'?<>
      <div className="reports-legacy-tabs">{OPS.map(x=><button key={x} className={ops===x?'active':''} onClick={()=>setOps(x)}>{x}</button>)}</div>
      {ops==='总汇'&&<Overview data={overview} loading={overviewLoading}/>} 
      {ops==='人员'&&<PeopleTable data={overview} loading={overviewLoading}/>} 
      {ops==='排班表'&&<ScheduleView data={overview} loading={overviewLoading}/>} 
      {ops==='盘口人数'&&<PlatformView data={overview} loading={overviewLoading}/>} 
      {ops==='统计'&&<EfficiencyView invoke={invoke}/>} 
      {ops==='错误统计'&&<ErrorStatsView invoke={invoke}/>} 
    </>:<Coming title={outer}/>} 
  </div>
}

function Kpi({label,value,sub,onClick}){return <button type="button" className={`report-kpi ${onClick?'clickable':''}`} onClick={onClick} disabled={!onClick}><span>{label}</span><strong>{value??'—'}</strong>{sub&&<small>{sub}</small>}</button>}
function LoadingCard(){return <div className="report-card reports-loading">正在读取实时 Google Sheet…</div>}

function Overview({data,loading}){
  const [modal,setModal]=useState(null)
  if(loading&&!data)return <LoadingCard/>
  const s=data?.stats||{}, roster=data?.roster||[]
  const open=(title,pred)=>setModal({title,rows:roster.filter(pred)})
  return <>
    <div className="report-kpi-grid">
      <Kpi label="当前排班人数" value={s.people||0} sub="居家排班表 · 填表" onClick={()=>setModal({title:'当前排班人员',rows:roster})}/>
      <Kpi label="团队" value={s.teams||0}/><Kpi label="岗位" value={s.positions||0}/><Kpi label="班次" value={s.shifts||0}/><Kpi label="盘口" value={s.platforms||0}/><Kpi label="后台账号已匹配" value={s.account_mapped||0} sub={`待匹配 ${s.account_unmapped||0}`}/>
    </div>
    <div className="reports-dashboard-grid">
      <StatCard title="团队人数" subtitle="点击团队查看成员" rows={s.team_stats||[]} onRow={x=>open(`${x.name} · 团队成员`,r=>r.team===x.name)}/>
      <StatCard title="岗位人数" subtitle="点击岗位查看人员" rows={s.position_stats||[]} onRow={x=>open(`${x.name} · 岗位人员`,r=>r.position===x.name)}/>
      <StatCard title="班次人数" subtitle="当前排班结构" rows={s.shift_stats||[]} onRow={x=>open(`${x.name} · 班次人员`,r=>r.shift===x.name)}/>
      <StatCard title="员工国家" subtitle="排班表当前员工国家" rows={s.country_stats||[]} onRow={x=>open(`${x.name} · 员工`,r=>r.country===x.name)}/>
      <RecentRoster rows={roster.slice(0,12)} onAll={()=>setModal({title:'当前排班人员',rows:roster})}/>
    </div>
    {modal&&<RosterModal title={modal.title} rows={modal.rows} onClose={()=>setModal(null)}/>} 
  </>
}

function StatCard({title,subtitle,rows,onRow}){return <section className="report-card report-stat-card"><div className="report-card-head"><div><h3>{title}</h3><p>{subtitle}</p></div><span>{rows.reduce((s,x)=>s+(x.count||0),0)} 人</span></div><div className="report-ratios">{rows.slice(0,10).map(x=><button key={x.name} onClick={()=>onRow?.(x)}><div><span>{x.name}</span><strong>{x.count}<em>{pct(x.share)}</em></strong></div><i><b style={{width:`${Math.min(100,x.share||0)}%`}}/></i></button>)}</div></section>}
function RecentRoster({rows,onAll}){return <section className="report-card recent-roster"><div className="report-card-head"><div><h3>排班人员预览</h3><p>直接来自居家排班表</p></div><button onClick={onAll}>查看全部</button></div><div className="mini-roster-grid">{rows.map(r=><div key={r.key}><strong>{r.name||r.employee_id}</strong><span>{r.team||'—'} · {r.shift||'—'}</span><small>{r.position||'—'} · {r.country||'—'}</small></div>)}</div></section>}

function SmartCombo({value,options,onChange,placeholder='全部'}){
  const [open,setOpen]=useState(false),[query,setQuery]=useState('');const ref=useRef(null)
  const values=useMemo(()=>[...new Set((options||[]).map(text).filter(Boolean))],[options])
  const list=useMemo(()=>values.filter(x=>!query||x.toLowerCase().includes(query.toLowerCase())).slice(0,100),[values,query])
  useEffect(()=>{const f=e=>{if(ref.current&&!ref.current.contains(e.target)){setOpen(false);setQuery('')}};document.addEventListener('mousedown',f);return()=>document.removeEventListener('mousedown',f)},[])
  return <div className="report-combo" ref={ref}>
    <input value={open?query:(value||'')} onFocus={()=>{setOpen(true);setQuery('')}} onChange={e=>{setQuery(e.target.value);setOpen(true)}} placeholder={value||placeholder}/>
    {value&&!open?<button className="combo-clear" onClick={()=>onChange('')}>×</button>:<button className="combo-arrow" onMouseDown={e=>e.preventDefault()} onClick={()=>{setOpen(v=>!v);setQuery('')}}>⌄</button>}
    {open&&<div className="report-combo-menu"><button className={!value?'active':''} onClick={()=>{onChange('');setOpen(false);setQuery('')}}>{placeholder}</button>{list.map(x=><button key={x} className={x===value?'active':''} onClick={()=>{onChange(x);setOpen(false);setQuery('')}}>{x}</button>)}{!list.length&&<div>没有匹配项</div>}</div>}
  </div>
}

function RosterFilters({filters,setFilters,options,showAccount=true}){return <div className="report-filter-grid">
  <label><span>员工ID</span><input value={filters.employee_id} onChange={e=>setFilters({...filters,employee_id:e.target.value})} placeholder="输入员工ID"/></label>
  <label><span>姓名</span><input value={filters.name} onChange={e=>setFilters({...filters,name:e.target.value})} placeholder="输入姓名"/></label>
  <label><span>团队</span><SmartCombo value={filters.team} options={options.teams} onChange={v=>setFilters({...filters,team:v})} placeholder="全部团队"/></label>
  <label><span>岗位</span><SmartCombo value={filters.position} options={options.positions} onChange={v=>setFilters({...filters,position:v})} placeholder="全部岗位"/></label>
  <label><span>员工国家</span><SmartCombo value={filters.country} options={options.countries} onChange={v=>setFilters({...filters,country:v})} placeholder="全部国家"/></label>
  <label><span>班次</span><SmartCombo value={filters.shift} options={options.shifts} onChange={v=>setFilters({...filters,shift:v})} placeholder="全部班次"/></label>
  <label><span>盘口</span><SmartCombo value={filters.platform} options={options.platforms} onChange={v=>setFilters({...filters,platform:v})} placeholder="全部盘口"/></label>
  {showAccount&&<label><span>后台账号</span><input value={filters.account} onChange={e=>setFilters({...filters,account:e.target.value})} placeholder="输入后台账号"/></label>}
  <button className="report-reset" onClick={()=>setFilters(blankFilters())}>重置</button>
</div>}

function filterRoster(rows,f){const has=(a,b)=>!text(b)||text(a).toLowerCase().includes(text(b).toLowerCase());return (rows||[]).filter(r=>has(r.employee_id,f.employee_id)&&has(r.name,f.name)&&has(r.team,f.team)&&has(r.position,f.position)&&has(r.country,f.country)&&has(r.shift,f.shift)&&has(r.platform,f.platform)&&(!f.account||(r.backend_accounts||[]).some(a=>has(a,f.account))))}

function PeopleTable({data,loading}){const [filters,setFilters]=useState(blankFilters()),[page,setPage]=useState(1),[size,setSize]=useState(20);const rows=useMemo(()=>filterRoster(data?.roster||[],filters),[data,filters]);useEffect(()=>setPage(1),[filters,size]);const pages=Math.max(1,Math.ceil(rows.length/size)),slice=rows.slice((page-1)*size,page*size);if(loading&&!data)return <LoadingCard/>;return <section className="report-card report-table-card"><div className="report-card-head"><div><h3>人员</h3><p>负责人、培训、团队、班次、岗位、盘口和后台账号统一查看。</p></div><span>{rows.length} 人</span></div><RosterFilters filters={filters} setFilters={setFilters} options={data?.options||{}}/><TableWrap><table className="report-table"><thead><tr><th>员工ID</th><th>姓名</th><th>团队</th><th>班次</th><th>国家</th><th>岗位</th><th>盘口</th><th>负责人</th><th>线上组长</th><th>培训</th><th>后台账号</th></tr></thead><tbody>{slice.map(r=><tr key={r.key}><td><strong>{r.employee_id}</strong></td><td>{r.name||'—'}</td><td>{r.team||'—'}</td><td>{r.shift||'—'}</td><td>{r.country||'—'}</td><td>{r.position||'—'}</td><td className="wide">{r.platform||'—'}</td><td>{r.responsible||'—'}</td><td>{r.online_leader||'—'}</td><td>{r.online_trainer||r.onsite_trainer||'—'}</td><td className="wide">{(r.backend_accounts||[]).join(' / ')||'—'}</td></tr>)}</tbody></table></TableWrap><Pagination page={page} pages={pages} total={rows.length} pageSize={size} onPage={setPage} onPageSize={n=>{setSize(n);setPage(1)}}/></section>}

function ScheduleView({data,loading}){const [filters,setFilters]=useState(blankFilters()),[page,setPage]=useState(1),[size,setSize]=useState(20);const rows=useMemo(()=>filterRoster(data?.roster||[],filters).sort((a,b)=>(a.team||'').localeCompare(b.team||'','zh-CN')||(a.shift||'').localeCompare(b.shift||'','zh-CN')),[data,filters]);useEffect(()=>setPage(1),[filters,size]);const pages=Math.max(1,Math.ceil(rows.length/size)),slice=rows.slice((page-1)*size,page*size);if(loading&&!data)return <LoadingCard/>;return <section className="report-card report-table-card"><div className="report-card-head"><div><h3>排班表</h3><p>实时读取居家排班表「填表」；排班变化刷新后直接更新。</p></div><span>{rows.length} 条</span></div><RosterFilters filters={filters} setFilters={setFilters} options={data?.options||{}} showAccount={false}/><TableWrap><table className="report-table schedule-report-table"><thead><tr><th>团队</th><th>姓名</th><th>ID</th><th>班次</th><th>国家</th><th>岗位</th><th>盘口</th><th>工作内容</th></tr></thead><tbody>{slice.map(r=><tr key={r.key}><td><strong>{r.team||'—'}</strong></td><td>{r.name||'—'}</td><td>{r.employee_id}</td><td>{r.shift||'—'}</td><td>{r.country||'—'}</td><td>{r.position||'—'}</td><td className="wide">{r.platform||'—'}</td><td className="wide">{r.work_content||'—'}</td></tr>)}</tbody></table></TableWrap><Pagination page={page} pages={pages} total={rows.length} pageSize={size} onPage={setPage} onPageSize={n=>{setSize(n);setPage(1)}}/></section>}

function PlatformView({data,loading}){const [q,setQ]=useState(''),[page,setPage]=useState(1),[size,setSize]=useState(20),[modal,setModal]=useState(null);const rows=useMemo(()=>(data?.platform_rows||[]).filter(x=>!q||[x.name,x.market_country,x.series].some(v=>text(v).toLowerCase().includes(q.toLowerCase()))),[data,q]);useEffect(()=>setPage(1),[q,size]);const pages=Math.max(1,Math.ceil(rows.length/size)),slice=rows.slice((page-1)*size,page*size);if(loading&&!data)return <LoadingCard/>;return <section className="report-card report-table-card"><div className="report-card-head"><div><h3>盘口人数</h3><p>组合盘口按 / 拆分计数；国家与系列来自排班表 W:X:Y 映射。</p></div><span>{rows.length} 个盘口</span></div><div className="single-search"><span>⌕</span><input value={q} onChange={e=>setQ(e.target.value)} placeholder="搜索盘口 / 国家 / 系列"/></div><TableWrap><table className="report-table"><thead><tr><th>盘口</th><th>国家</th><th>系列 / 团队</th><th>人数</th><th>占排班人数</th><th>操作</th></tr></thead><tbody>{slice.map(x=><tr key={x.name}><td><strong>{x.name}</strong></td><td>{x.market_country||'—'}</td><td>{x.series||'—'}</td><td>{x.count}</td><td>{pct((x.count/(data?.stats?.people||1))*100)}</td><td><button className="table-action" onClick={()=>setModal({title:`${x.name} · 盘口人员`,rows:(data?.roster||[]).filter(r=>text(r.platform).split(/[\/，,；;\n\r]+/).map(text).includes(x.name))})}>查看人员</button></td></tr>)}</tbody></table></TableWrap><Pagination page={page} pages={pages} total={rows.length} pageSize={size} onPage={setPage} onPageSize={n=>{setSize(n);setPage(1)}}/>{modal&&<RosterModal title={modal.title} rows={modal.rows} onClose={()=>setModal(null)}/>}</section>}

function EfficiencyView({invoke}){const today=isoToday();const [range,setRange]=useState({from:isoAdd(today,-6),to:today}),[data,setData]=useState(null),[loading,setLoading]=useState(true),[filters,setFilters]=useState({employee_id:'',name:'',account:'',team:''}),[page,setPage]=useState(1),[size,setSize]=useState(20);const load=async()=>{setLoading(true);try{setData(await invoke({action:'efficiency',date_from:range.from,date_to:range.to}))}finally{setLoading(false)}};useEffect(()=>{load()},[]);const rows=useMemo(()=>{const has=(a,b)=>!text(b)||text(a).toLowerCase().includes(text(b).toLowerCase());return (data?.rows||[]).filter(r=>has(r.employee_id,filters.employee_id)&&has(r.name,filters.name)&&has(r.backend_account,filters.account)&&has(r.team,filters.team))},[data,filters]);useEffect(()=>setPage(1),[filters,size]);const pages=Math.max(1,Math.ceil(rows.length/size)),slice=rows.slice((page-1)*size,page*size),k=data?.kpis||{};return <><div className="report-range-toolbar"><label>日期起<input type="date" value={range.from} onChange={e=>setRange({...range,from:e.target.value})}/></label><label>日期止<input type="date" value={range.to} onChange={e=>setRange({...range,to:e.target.value})}/></label><button onClick={load}>查询</button><span>仅展示效率表原始「已处理 / 驳回」数据，不在这里推断扣分规则。</span></div><div className="report-kpi-grid compact"><Kpi label="已处理" value={k.processed??'—'}/><Kpi label="驳回" value={k.rejected??'—'}/><Kpi label="原始记录" value={k.records??'—'}/><Kpi label="后台账号" value={k.accounts??'—'}/><Kpi label="已匹配员工" value={k.employees??'—'}/><Kpi label="未匹配记录" value={k.unmatched??'—'}/></div><section className="report-card report-table-card"><div className="report-card-head"><div><h3>统计</h3><p>后台账号 → 居家员工名单员工ID → 居家排班表团队/岗位。</p></div><span>{data?.from||range.from} — {data?.to||range.to}</span></div><div className="report-filter-grid efficiency-filter-grid"><label><span>员工ID</span><input value={filters.employee_id} onChange={e=>setFilters({...filters,employee_id:e.target.value})}/></label><label><span>姓名</span><input value={filters.name} onChange={e=>setFilters({...filters,name:e.target.value})}/></label><label><span>后台账号</span><input value={filters.account} onChange={e=>setFilters({...filters,account:e.target.value})}/></label><label><span>团队</span><SmartCombo value={filters.team} options={data?.options?.teams||[]} onChange={v=>setFilters({...filters,team:v})} placeholder="全部团队"/></label><button className="report-reset" onClick={()=>setFilters({employee_id:'',name:'',account:'',team:''})}>重置</button></div>{loading&&!data?<div className="reports-loading-inline">读取效率表…</div>:<><TableWrap><table className="report-table"><thead><tr><th>日期</th><th>后台账号</th><th>员工ID</th><th>姓名</th><th>团队</th><th>岗位</th><th>已处理</th><th>驳回</th><th>状态</th><th>匹配</th></tr></thead><tbody>{slice.map(r=><tr key={r.key}><td>{r.date}</td><td><strong>{r.backend_account}</strong></td><td>{r.employee_id||'—'}</td><td>{r.name||'—'}</td><td>{r.team||'—'}</td><td>{r.position||'—'}</td><td>{r.processed}</td><td>{r.rejected}</td><td>{r.status||'—'}</td><td><span className={`match-chip ${r.matched?'ok':'warn'}`}>{r.matched?'已匹配':'未匹配'}</span></td></tr>)}</tbody></table></TableWrap><Pagination page={page} pages={pages} total={rows.length} pageSize={size} loading={loading} onPage={setPage} onPageSize={n=>{setSize(n);setPage(1)}}/></>}</section></>}

function ErrorStatsView({invoke}){const today=isoToday();const [range,setRange]=useState({from:isoAdd(today,-29),to:today}),[data,setData]=useState(null),[loading,setLoading]=useState(true),[filters,setFilters]=useState({employee_id:'',name:'',error_type:'',qc:'',team:''}),[page,setPage]=useState(1),[size,setSize]=useState(20);const load=async()=>{setLoading(true);try{setData(await invoke({action:'errors',date_from:range.from,date_to:range.to}))}finally{setLoading(false)}};useEffect(()=>{load()},[]);const rows=useMemo(()=>{const has=(a,b)=>!text(b)||text(a).toLowerCase().includes(text(b).toLowerCase());return (data?.rows||[]).filter(r=>has(r.employee_id,filters.employee_id)&&has(r.name,filters.name)&&has(r.error_type,filters.error_type)&&has(r.qc_person,filters.qc)&&has(r.team,filters.team))},[data,filters]);useEffect(()=>setPage(1),[filters,size]);const pages=Math.max(1,Math.ceil(rows.length/size)),slice=rows.slice((page-1)*size,page*size),k=data?.kpis||{};return <><div className="report-range-toolbar"><label>质检日期起<input type="date" value={range.from} onChange={e=>setRange({...range,from:e.target.value})}/></label><label>质检日期止<input type="date" value={range.to} onChange={e=>setRange({...range,to:e.target.value})}/></label><button onClick={load}>查询</button><span>扣分列为空时保持为空，不自动猜分。</span></div><div className="report-kpi-grid compact"><Kpi label="错误记录" value={k.records??'—'}/><Kpi label="涉及员工" value={k.employees??'—'}/><Kpi label="错误类型" value={k.error_types??'—'}/><Kpi label="已有扣分" value={k.scored??'—'}/><Kpi label="未填写扣分" value={k.unscored??'—'}/><Kpi label="未匹配排班" value={k.unmatched??'—'}/></div><div className="error-layout"><section className="report-card error-ranking"><div className="report-card-head"><div><h3>错误类型</h3><p>按当前日期区间</p></div></div><div className="report-ratios">{(data?.by_type||[]).slice(0,12).map(x=><button key={x.name} onClick={()=>setFilters({...filters,error_type:x.name})}><div><span>{x.name}</span><strong>{x.count}<em>{pct(x.share)}</em></strong></div><i><b style={{width:`${Math.min(100,x.share||0)}%`}}/></i></button>)}</div></section><section className="report-card report-table-card error-table-card"><div className="report-card-head"><div><h3>错误统计</h3><p>员工错误表原始记录，可按员工、类型、质检人继续查。</p></div><span>{rows.length} 条</span></div><div className="report-filter-grid error-filter-grid"><label><span>员工ID</span><input value={filters.employee_id} onChange={e=>setFilters({...filters,employee_id:e.target.value})}/></label><label><span>姓名</span><input value={filters.name} onChange={e=>setFilters({...filters,name:e.target.value})}/></label><label><span>错误类型</span><SmartCombo value={filters.error_type} options={data?.options?.error_types||[]} onChange={v=>setFilters({...filters,error_type:v})} placeholder="全部错误类型"/></label><label><span>质检人</span><SmartCombo value={filters.qc} options={data?.options?.qc_people||[]} onChange={v=>setFilters({...filters,qc:v})} placeholder="全部质检人"/></label><label><span>团队</span><SmartCombo value={filters.team} options={data?.options?.teams||[]} onChange={v=>setFilters({...filters,team:v})} placeholder="全部团队"/></label><button className="report-reset" onClick={()=>setFilters({employee_id:'',name:'',error_type:'',qc:'',team:''})}>重置</button></div>{loading&&!data?<div className="reports-loading-inline">读取员工错误…</div>:<><TableWrap><table className="report-table error-table"><thead><tr><th>质检日期</th><th>员工ID</th><th>姓名</th><th>团队</th><th>错误类型</th><th>扣分</th><th>质检人</th><th>错误备注</th><th>复审</th></tr></thead><tbody>{slice.map(r=><tr key={r.key}><td>{r.qc_date}</td><td><strong>{r.employee_id}</strong></td><td>{r.name||'—'}</td><td>{r.team||'—'}</td><td>{r.error_type||'未分类'}</td><td>{text(r.score)===''?'—':r.score}</td><td>{r.qc_person||'—'}</td><td className="wide error-note">{r.error_note||'—'}</td><td>{r.leader_review||r.qc_result||'—'}</td></tr>)}</tbody></table></TableWrap><Pagination page={page} pages={pages} total={rows.length} pageSize={size} loading={loading} onPage={setPage} onPageSize={n=>{setSize(n);setPage(1)}}/></>}</section></div></>}

function RosterModal({title,rows,onClose}){const [filters,setFilters]=useState(blankFilters()),[page,setPage]=useState(1),[size,setSize]=useState(20);const options=useMemo(()=>({teams:[...new Set(rows.map(x=>x.team).filter(Boolean))],positions:[...new Set(rows.map(x=>x.position).filter(Boolean))],countries:[...new Set(rows.map(x=>x.country).filter(Boolean))],shifts:[...new Set(rows.map(x=>x.shift).filter(Boolean))],platforms:[...new Set(rows.flatMap(x=>text(x.platform).split(/[\/，,；;\n\r]+/).map(text)).filter(Boolean))]}),[rows]);const filtered=useMemo(()=>filterRoster(rows,filters),[rows,filters]);useEffect(()=>setPage(1),[filters,size]);const pages=Math.max(1,Math.ceil(filtered.length/size)),slice=filtered.slice((page-1)*size,page*size);return <div className="modal-mask report-modal-mask" onMouseDown={onClose}><div className="report-modal" onMouseDown={e=>e.stopPropagation()}><div className="report-modal-head"><div><span>REPORT DETAIL</span><h2>{title}</h2><p>{filtered.length} 人</p></div><button onClick={onClose}>×</button></div><RosterFilters filters={filters} setFilters={setFilters} options={options}/><div className="report-modal-body"><TableWrap><table className="report-table"><thead><tr><th>ID</th><th>姓名</th><th>团队</th><th>班次</th><th>国家</th><th>岗位</th><th>盘口</th><th>后台账号</th></tr></thead><tbody>{slice.map(r=><tr key={r.key}><td><strong>{r.employee_id}</strong></td><td>{r.name||'—'}</td><td>{r.team||'—'}</td><td>{r.shift||'—'}</td><td>{r.country||'—'}</td><td>{r.position||'—'}</td><td className="wide">{r.platform||'—'}</td><td className="wide">{(r.backend_accounts||[]).join(' / ')||'—'}</td></tr>)}</tbody></table></TableWrap></div><Pagination page={page} pages={pages} total={filtered.length} pageSize={size} onPage={setPage} onPageSize={n=>{setSize(n);setPage(1)}}/></div></div>}
function TableWrap({children}){return <div className="report-table-wrap">{children}</div>}
function Coming({title}){return <div className="report-card reports-coming"><div><span>◇</span><h2>{title}</h2><p>排班运营统计完成后，再按同一套专业交互接入这里。</p></div></div>}
