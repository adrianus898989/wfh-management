import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const freshEmployee = () => ({
  employee_no:'', full_name:'', country:'', nationality:'', employment_type:'',
  team_id:'', position_id:'', status:'active',
})

const text = v => String(v ?? '').trim()
const statusName = s => ({ active:'在职', inactive:'停用', resigned:'离职' }[s] || s || '-')
const legacyType = {
  home_ph:'纯居家菲律宾', onsite_to_home:'现场转居家',
  home_vn:'纯居家越南', home_id:'纯居家印尼', home_mm:'纯居家缅甸',
}
const typeName = value => legacyType[text(value)] || text(value) || '-'

function leaderText(row){
  const t = row?.teams || {}
  return text(row?.leader_name || row?.team_leader_name || row?.supervisor_name || t?.leader_name || t?.team_leader_name || t?.supervisor_name || '')
}
function trainerText(row){ return text(row?.trainer_name || row?.online_trainer_name || '') }
function hireDate(row){ return text(row?.hire_date || row?.join_date || row?.employment_date || '') }
function resignDate(row){ return text(row?.resign_date || row?.leave_date || '') }
function profileLabel(v){
  const x = text(v)
  return ({
    complete_basic:'基础资料完整',
    needs_profile_completion:'待补员工资料',
    needs_schedule_match:'待匹配排班',
    needs_official_id:'待补正式ID',
  })[x] || x || '-'
}

export default function AdminEmployeesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlTab = searchParams.get('tab')
  const tabs = ['员工档案','团队管理','岗位管理','入离职记录']
  const [tab, setTabState] = useState(tabs.includes(urlTab) ? urlTab : '员工档案')

  const [rows,setRows] = useState([])
  const [accounts,setAccounts] = useState([])
  const [teams,setTeams] = useState([])
  const [positions,setPositions] = useState([])
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')
  const [generated,setGenerated] = useState(null)
  const [showCreate,setShowCreate] = useState(false)
  const [selected,setSelected] = useState(null)
  const [showFilters,setShowFilters] = useState(true)
  const [form,setForm] = useState(freshEmployee())
  const [filters,setFilters] = useState({
    keyword:'', team:'', position:'', country:'', status:'', employment_type:'',
    leader:'', shift:'', profile_status:'', hire_from:'', hire_to:'',
  })

  useEffect(() => {
    if (tabs.includes(urlTab)) setTabState(urlTab)
  }, [urlTab])

  const setTab = value => {
    setTabState(value)
    setSearchParams(value === '员工档案' ? {} : { tab:value })
  }

  const call = async body => {
    const { data,error } = await supabase.functions.invoke('admin-accounts',{ body })
    if (error || data?.error) throw new Error(data?.error || error?.message || '操作失败')
    return data
  }

  const load = async () => {
    setLoading(true); setError('')
    try{
      const data = await call({ action:'bootstrap' })
      setRows(data?.employees || [])
      setAccounts(data?.employee_accounts || [])
      setTeams(data?.teams || [])
      setPositions(data?.positions || [])
    }catch(e){ setError(e.message) }
    finally{ setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const opened = useMemo(() => new Set(accounts.map(a => a.employee_id).filter(Boolean)),[accounts])
  const countries = useMemo(() => [...new Set(rows.map(r => text(r.country || r.nationality)).filter(Boolean))].sort(),[rows])
  const employeeTypes = useMemo(() => [...new Set(rows.map(r => typeName(r.employment_type)).filter(x => x && x !== '-'))].sort(),[rows])
  const shifts = useMemo(() => [...new Set(rows.map(r => text(r.shift_name)).filter(Boolean))].sort(),[rows])
  const profileStatuses = useMemo(() => [...new Set(rows.map(r => text(r.profile_status)).filter(Boolean))].sort(),[rows])

  const filtered = useMemo(() => {
    const q = filters.keyword.trim().toLowerCase()
    return rows.filter(r => {
      const teamName = text(r?.teams?.name)
      const positionName = text(r?.positions?.name)
      const leader = leaderText(r)
      const trainer = trainerText(r)
      const join = hireDate(r)
      if (q && ![
        r.employee_no,r.full_name,r.country,r.nationality,r.employment_type,
        r.shift_name,r.platform_scope,r.backend_accounts,r.work_tg,
        teamName,positionName,leader,trainer,
      ].some(v => text(v).toLowerCase().includes(q))) return false
      if (filters.team && String(r.team_id || '') !== filters.team) return false
      if (filters.position && String(r.position_id || '') !== filters.position) return false
      if (filters.country && text(r.country || r.nationality) !== filters.country) return false
      if (filters.status && text(r.status) !== filters.status) return false
      if (filters.employment_type && typeName(r.employment_type) !== filters.employment_type) return false
      if (filters.leader && !leader.toLowerCase().includes(filters.leader.toLowerCase())) return false
      if (filters.shift && text(r.shift_name) !== filters.shift) return false
      if (filters.profile_status && text(r.profile_status) !== filters.profile_status) return false
      if (filters.hire_from && join && join.slice(0,10) < filters.hire_from) return false
      if (filters.hire_to && join && join.slice(0,10) > filters.hire_to) return false
      return true
    }).sort((a,b) => text(a.employee_no).localeCompare(text(b.employee_no)))
  },[rows,filters])

  const activeRows = useMemo(() => rows.filter(r => text(r.status) === 'active' || !text(r.status)),[rows])
  const teamStats = useMemo(() => teams.map(t => {
    const members = activeRows.filter(r => String(r.team_id || '') === String(t.id))
    const leaders = [...new Set(members.map(leaderText).filter(Boolean))]
    const trainers = [...new Set(members.map(trainerText).filter(Boolean))]
    return { ...t, members:members.length, leaders, trainers }
  }).sort((a,b) => b.members-a.members),[teams,activeRows])

  const positionStats = useMemo(() => positions.map(p => ({
    ...p, members:activeRows.filter(r => String(r.position_id || '') === String(p.id)).length,
  })).sort((a,b) => b.members-a.members),[positions,activeRows])

  const moveRows = useMemo(() => rows
    .filter(r => hireDate(r) || resignDate(r) || text(r.status) !== 'active')
    .sort((a,b) => text(resignDate(b) || hireDate(b)).localeCompare(text(resignDate(a) || hireDate(a)))
  ),[rows])

  const summary = useMemo(() => ({
    total:rows.length,
    active:activeRows.length,
    teams:teamStats.filter(x => x.members > 0).length,
    needs:activeRows.filter(r => text(r.profile_status).startsWith('needs_')).length,
    noTeam:activeRows.filter(r => !r.team_id).length,
  }),[rows,activeRows,teamStats])

  const clearFilters = () => setFilters({
    keyword:'', team:'', position:'', country:'', status:'', employment_type:'',
    leader:'', shift:'', profile_status:'', hire_from:'', hire_to:'',
  })

  const createEmployee = async () => {
    try{
      await call({ action:'create_employee', ...form })
      setShowCreate(false); setForm(freshEmployee()); await load()
    }catch(e){ setError(e.message) }
  }

  const generateCode = async employeeNo => {
    setError(''); setGenerated(null)
    const { data,error } = await supabase.rpc('generate_employee_activation_code',{ p_employee_no:employeeNo,p_valid_hours:72 })
    if (error) return setError(error.message)
    setGenerated(data?.[0] || null)
  }

  return (
    <div className="content-page employee-page pro-employee-page">
      <div className="module-title-row">
        <div>
          <div className="module-kicker">PEOPLE & ORGANIZATION</div>
          <h1>员工管理</h1>
          <p className="page-subtitle">员工主档、团队、岗位与账号状态统一查看；导入数据按员工 ID 关联排班关系。</p>
        </div>
        {tab === '员工档案' && <button className="primary-action" onClick={() => setShowCreate(true)}>+ 新增员工</button>}
      </div>

      <div className="module-tabs">
        {tabs.map(x => <button key={x} className={tab===x?'active':''} onClick={() => setTab(x)}>{x}</button>)}
      </div>

      <div className="module-summary-grid employee-summary-grid">
        <div className="summary-card"><span>员工总数</span><strong>{loading?'—':summary.total}</strong></div>
        <div className="summary-card"><span>在职员工</span><strong>{loading?'—':summary.active}</strong></div>
        <div className="summary-card"><span>有效团队</span><strong>{loading?'—':summary.teams}</strong></div>
        <div className="summary-card"><span>待补资料</span><strong>{loading?'—':summary.needs}</strong></div>
        <div className="summary-card"><span>未匹配团队</span><strong>{loading?'—':summary.noTeam}</strong></div>
      </div>

      {error && <div className="page-error">{error}</div>}

      {tab === '员工档案' && <>
        <div className="filter-card employee-filter-card">
          <div className="filter-main-row">
            <div className="search-box"><span>⌕</span><input placeholder="搜索员工ID / 姓名 / 工作账号 / TG / 团队 / 组长 / 盘口" value={filters.keyword} onChange={e=>setFilters({...filters,keyword:e.target.value})}/></div>
            <div className="filter-actions">
              <button className="secondary-action" onClick={()=>setShowFilters(v=>!v)}>{showFilters?'收起筛选':'更多筛选'}</button>
              <button className="secondary-action" onClick={clearFilters}>重置</button>
            </div>
          </div>

          {showFilters && <div className="filter-grid employee-filter-grid">
            <label>团队<select value={filters.team} onChange={e=>setFilters({...filters,team:e.target.value})}><option value="">全部</option>{teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <label>岗位<select value={filters.position} onChange={e=>setFilters({...filters,position:e.target.value})}><option value="">全部</option>{positions.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>国家<select value={filters.country} onChange={e=>setFilters({...filters,country:e.target.value})}><option value="">全部</option>{countries.map(c=><option key={c}>{c}</option>)}</select></label>
            <label>员工类型<select value={filters.employment_type} onChange={e=>setFilters({...filters,employment_type:e.target.value})}><option value="">全部</option>{employeeTypes.map(x=><option key={x}>{x}</option>)}</select></label>
            <label>班次<select value={filters.shift} onChange={e=>setFilters({...filters,shift:e.target.value})}><option value="">全部</option>{shifts.map(x=><option key={x}>{x}</option>)}</select></label>
            <label>资料状态<select value={filters.profile_status} onChange={e=>setFilters({...filters,profile_status:e.target.value})}><option value="">全部</option>{profileStatuses.map(x=><option key={x} value={x}>{profileLabel(x)}</option>)}</select></label>
            <label>组长 / 负责人<input value={filters.leader} onChange={e=>setFilters({...filters,leader:e.target.value})} placeholder="输入姓名"/></label>
            <label>状态<select value={filters.status} onChange={e=>setFilters({...filters,status:e.target.value})}><option value="">全部</option><option value="active">在职</option><option value="inactive">停用</option><option value="resigned">离职</option></select></label>
            <label>入职日期起<input type="date" value={filters.hire_from} onChange={e=>setFilters({...filters,hire_from:e.target.value})}/></label>
            <label>入职日期止<input type="date" value={filters.hire_to} onChange={e=>setFilters({...filters,hire_to:e.target.value})}/></label>
          </div>}
        </div>

        <div className="list-meta-row"><span>筛选结果 {filtered.length} / {rows.length}</span><div>点击“查看”打开完整员工档案</div></div>

        {generated && <div className="activation-banner"><div><span>{generated.employee_no} · {generated.employee_name}</span><strong>{generated.activation_code}</strong></div><button onClick={()=>navigator.clipboard.writeText(generated.activation_code)}>复制激活码</button></div>}

        <div className="data-card">
          {loading ? <div className="empty-state">读取中...</div> :
          filtered.length===0 ? <div className="empty-state">暂无符合条件的员工资料</div> :
          <div className="table-scroll"><table className="data-table employee-master-table">
            <thead><tr>
              <th>员工ID</th><th>姓名</th><th>国家</th><th>团队</th><th>组长</th><th>岗位</th><th>班次</th>
              <th>员工类型</th><th>入职日期</th><th>资料</th><th>账号</th><th>操作</th>
            </tr></thead>
            <tbody>{filtered.map(r => {
              const hasAccount = opened.has(r.id)
              return <tr key={r.id}>
                <td><strong>{r.employee_no}</strong></td>
                <td>{r.full_name}</td>
                <td>{r.country || r.nationality || '-'}</td>
                <td>{r.teams?.name || '-'}</td>
                <td>{leaderText(r) || '-'}</td>
                <td>{r.positions?.name || '-'}</td>
                <td>{r.shift_name || '-'}</td>
                <td>{typeName(r.employment_type)}</td>
                <td>{hireDate(r).slice(0,10) || '-'}</td>
                <td><span className={`profile-chip ${text(r.profile_status).startsWith('needs_')?'warn':''}`}>{profileLabel(r.profile_status)}</span></td>
                <td>{hasAccount ? <span className="status-chip">已开通</span> : <span className="status-chip off">未开通</span>}</td>
                <td><div className="row-actions"><button className="table-action" onClick={()=>setSelected(r)}>查看</button>{!hasAccount && <button className="table-action" onClick={()=>generateCode(r.employee_no)}>激活码</button>}</div></td>
              </tr>
            })}</tbody>
          </table></div>}
        </div>
      </>}

      {tab === '团队管理' && <div className="data-card">
        <div className="section-head"><div><h2>团队管理</h2><p>团队来自真实排班匹配，当前先展示人数与管理关系。</p></div><span>{teamStats.length} 个团队记录</span></div>
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>团队</th><th>国家</th><th>在职人数</th><th>组长 / 负责人</th><th>培训老师</th><th>状态</th></tr></thead>
          <tbody>{teamStats.map(t=><tr key={t.id}><td><strong>{t.name}</strong></td><td>{t.country||'-'}</td><td>{t.members}</td><td>{t.leaders.slice(0,3).join(' / ')||'-'}</td><td>{t.trainers.slice(0,3).join(' / ')||'-'}</td><td><span className="status-chip">{t.status||'active'}</span></td></tr>)}</tbody>
        </table></div>
      </div>}

      {tab === '岗位管理' && <div className="data-card">
        <div className="section-head"><div><h2>岗位管理</h2><p>岗位与员工档案直接关联，工资封顶规则以后从这里进入配置。</p></div><span>{positionStats.length} 个岗位</span></div>
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>岗位</th><th>编码</th><th>在职人数</th><th>工资封顶</th><th>币种</th><th>状态</th></tr></thead>
          <tbody>{positionStats.map(p=><tr key={p.id}><td><strong>{p.name}</strong></td><td>{p.code||'-'}</td><td>{p.members}</td><td>{p.salary_cap??'-'}</td><td>{p.currency||'-'}</td><td>{p.status||'-'}</td></tr>)}</tbody>
        </table></div>
      </div>}

      {tab === '入离职记录' && <div className="data-card">
        <div className="section-head"><div><h2>入职 / 离职记录</h2><p>从员工主档日期与状态自动汇总。</p></div><span>{moveRows.length} 条有日期或状态记录</span></div>
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>员工ID</th><th>姓名</th><th>团队</th><th>员工类型</th><th>入职日期</th><th>离职日期</th><th>状态</th></tr></thead>
          <tbody>{moveRows.slice(0,500).map(r=><tr key={r.id}><td><strong>{r.employee_no}</strong></td><td>{r.full_name}</td><td>{r.teams?.name||'-'}</td><td>{typeName(r.employment_type)}</td><td>{hireDate(r).slice(0,10)||'-'}</td><td>{resignDate(r).slice(0,10)||'-'}</td><td>{statusName(r.status)}</td></tr>)}</tbody>
        </table></div>
      </div>}

      {showCreate && <div className="modal-mask" onMouseDown={()=>setShowCreate(false)}>
        <div className="modal-card" onMouseDown={e=>e.stopPropagation()}>
          <div className="modal-head"><h2>新增员工</h2><button onClick={()=>setShowCreate(false)}>×</button></div>
          <div className="form-grid">
            <label>员工ID<input value={form.employee_no} onChange={e=>setForm({...form,employee_no:e.target.value.toUpperCase()})}/></label>
            <label>姓名<input value={form.full_name} onChange={e=>setForm({...form,full_name:e.target.value})}/></label>
            <label>国家<input value={form.country} onChange={e=>setForm({...form,country:e.target.value})}/></label>
            <label>国籍<input value={form.nationality} onChange={e=>setForm({...form,nationality:e.target.value})}/></label>
            <label>员工类型<input value={form.employment_type} onChange={e=>setForm({...form,employment_type:e.target.value})} placeholder="例如：纯居家菲律宾"/></label>
            <label>团队<select value={form.team_id} onChange={e=>setForm({...form,team_id:e.target.value})}><option value="">未设置</option>{teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <label>岗位<select value={form.position_id} onChange={e=>setForm({...form,position_id:e.target.value})}><option value="">未设置</option>{positions.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>状态<select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option value="active">在职</option><option value="inactive">停用</option><option value="resigned">离职</option></select></label>
          </div>
          <div className="modal-actions"><button className="secondary-action" onClick={()=>setShowCreate(false)}>取消</button><button className="primary-action" onClick={createEmployee}>创建员工</button></div>
        </div>
      </div>}

      {selected && <div className="modal-mask detail-mask" onMouseDown={()=>setSelected(null)}>
        <div className="employee-detail-drawer" onMouseDown={e=>e.stopPropagation()}>
          <div className="detail-head"><div><span>{selected.employee_no}</span><h2>{selected.full_name}</h2><p>{typeName(selected.employment_type)} · {selected.teams?.name||'未匹配团队'} · {selected.positions?.name||'未设置岗位'}</p></div><button onClick={()=>setSelected(null)}>×</button></div>
          <div className="detail-sections">
            <DetailSection title="基本资料" rows={[
              ['员工ID',selected.employee_no],['姓名',selected.full_name],['国家',selected.country],['国籍',selected.nationality],
              ['员工类型',typeName(selected.employment_type)],['状态',statusName(selected.status)],['入职日期',hireDate(selected).slice(0,10)],['资料状态',profileLabel(selected.profile_status)],
            ]}/>
            <DetailSection title="组织与排班" rows={[
              ['团队',selected.teams?.name],['岗位',selected.positions?.name],['班次',selected.shift_name],['组别',selected.group_name],
              ['组长 / 负责人',leaderText(selected)],['培训老师',trainerText(selected)],['盘口',selected.platform_scope],['工作内容',selected.work_content],
            ]}/>
            <DetailSection title="账号与联系" rows={[
              ['工作TG',selected.work_tg],['后台账号',selected.backend_accounts],['资料来源',selected.source_type],['来源表',selected.source_sheet],
            ]}/>
          </div>
        </div>
      </div>}
    </div>
  )
}

function DetailSection({ title, rows }){
  return <section className="detail-section"><h3>{title}</h3><div className="detail-grid">{rows.map(([k,v])=><div className="detail-item" key={k}><span>{k}</span><strong>{text(v)||'—'}</strong></div>)}</div></section>
}
