import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const freshEmployee = () => ({
  employee_no: '',
  full_name: '',
  country: '',
  nationality: '',
  employment_type: '',
  team_id: '',
  position_id: '',
  status: 'active',
})

const statusName = s => ({
  active: '在职',
  inactive: '停用',
  resigned: '离职',
}[s] || s || '-')

function text(v){ return String(v ?? '').trim() }

function leaderText(row){
  const t = row?.teams || {}
  return text(
    row?.leader_name ||
    row?.team_leader_name ||
    row?.supervisor_name ||
    t?.leader_name ||
    t?.team_leader_name ||
    t?.supervisor_name ||
    t?.leader ||
    ''
  )
}

function hireDate(row){
  return text(row?.hire_date || row?.join_date || row?.employment_date || '')
}

export default function AdminEmployeesPage() {
  const [tab, setTab] = useState('员工档案')
  const [rows, setRows] = useState([])
  const [accounts, setAccounts] = useState([])
  const [teams, setTeams] = useState([])
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [generated, setGenerated] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showFilters, setShowFilters] = useState(true)
  const [form, setForm] = useState(freshEmployee())

  const [filters, setFilters] = useState({
    keyword: '',
    team: '',
    position: '',
    country: '',
    status: '',
    employment_type: '',
    leader: '',
    hire_from: '',
    hire_to: '',
  })

  const call = async (body) => {
    const { data, error } = await supabase.functions.invoke('admin-accounts', { body })
    if (error || data?.error) throw new Error(data?.error || error?.message || '操作失败')
    return data
  }

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await call({ action: 'bootstrap' })
      setRows(data?.employees || [])
      setAccounts(data?.employee_accounts || [])
      setTeams(data?.teams || [])
      setPositions(data?.positions || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const opened = useMemo(
    () => new Set(accounts.map(a => a.employee_id).filter(Boolean)),
    [accounts]
  )

  const countries = useMemo(
    () => [...new Set(rows.map(r => text(r.country)).filter(Boolean))].sort(),
    [rows]
  )

  const filtered = useMemo(() => {
    const q = filters.keyword.trim().toLowerCase()
    return rows.filter(r => {
      const teamName = text(r?.teams?.name)
      const positionName = text(r?.positions?.name)
      const leader = leaderText(r)
      const join = hireDate(r)

      if (q && ![
        r.employee_no, r.full_name, r.country, r.nationality,
        r.employment_type, teamName, positionName, leader
      ].some(v => text(v).toLowerCase().includes(q))) return false

      if (filters.team && String(r.team_id || '') !== filters.team) return false
      if (filters.position && String(r.position_id || '') !== filters.position) return false
      if (filters.country && text(r.country) !== filters.country) return false
      if (filters.status && text(r.status) !== filters.status) return false
      if (filters.employment_type && text(r.employment_type) !== filters.employment_type) return false
      if (filters.leader && !leader.toLowerCase().includes(filters.leader.toLowerCase())) return false
      if (filters.hire_from && join && join.slice(0,10) < filters.hire_from) return false
      if (filters.hire_to && join && join.slice(0,10) > filters.hire_to) return false

      return true
    })
  }, [rows, filters])

  const clearFilters = () => setFilters({
    keyword: '', team: '', position: '', country: '', status: '',
    employment_type: '', leader: '', hire_from: '', hire_to: '',
  })

  const createEmployee = async () => {
    try {
      await call({ action: 'create_employee', ...form })
      setShowCreate(false)
      setForm(freshEmployee())
      await load()
    } catch (e) { setError(e.message) }
  }

  const generateCode = async (employeeNo) => {
    setError('')
    setGenerated(null)
    const { data, error } = await supabase.rpc('generate_employee_activation_code', {
      p_employee_no: employeeNo,
      p_valid_hours: 72,
    })
    if (error) return setError(error.message)
    setGenerated(data?.[0] || null)
  }

  const tabs = ['员工档案', '团队管理', '岗位管理', '入离职记录']

  return (
    <div className="content-page employee-page">
      <div className="module-title-row">
        <div>
          <div className="module-kicker">PEOPLE</div>
          <h1>员工管理</h1>
        </div>
        {tab === '员工档案' && (
          <button className="primary-action" onClick={() => setShowCreate(true)}>+ 新增员工</button>
        )}
      </div>

      <div className="module-tabs">
        {tabs.map(x => (
          <button key={x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>{x}</button>
        ))}
      </div>

      {tab === '员工档案' && <>
        <div className="filter-card employee-filter-card">
          <div className="filter-main-row">
            <div className="search-box">
              <span>⌕</span>
              <input
                placeholder="搜索员工ID / 姓名 / 团队 / 岗位 / 组长"
                value={filters.keyword}
                onChange={e => setFilters({...filters, keyword:e.target.value})}
              />
            </div>
            <div className="filter-actions">
              <button className="secondary-action" onClick={() => setShowFilters(v => !v)}>
                {showFilters ? '收起筛选' : '更多筛选'}
              </button>
              <button className="secondary-action" onClick={clearFilters}>重置</button>
            </div>
          </div>

          {showFilters && (
            <div className="filter-grid employee-filter-grid">
              <label>团队
                <select value={filters.team} onChange={e => setFilters({...filters,team:e.target.value})}>
                  <option value="">全部</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label>岗位
                <select value={filters.position} onChange={e => setFilters({...filters,position:e.target.value})}>
                  <option value="">全部</option>
                  {positions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label>国家
                <select value={filters.country} onChange={e => setFilters({...filters,country:e.target.value})}>
                  <option value="">全部</option>
                  {countries.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label>状态
                <select value={filters.status} onChange={e => setFilters({...filters,status:e.target.value})}>
                  <option value="">全部</option>
                  <option value="active">在职</option>
                  <option value="inactive">停用</option>
                  <option value="resigned">离职</option>
                </select>
              </label>
              <label>员工类型
                <select value={filters.employment_type} onChange={e => setFilters({...filters,employment_type:e.target.value})}>
                  <option value="">全部</option>
                  <option value="home_ph">纯居家菲律宾</option>
                  <option value="onsite_to_home">现场转居家</option>
                  <option value="home_vn">纯居家越南</option>
                  <option value="home_id">纯居家印尼</option>
                  <option value="home_mm">纯居家缅甸</option>
                </select>
              </label>
              <label>组长 / 负责人
                <input value={filters.leader} onChange={e => setFilters({...filters,leader:e.target.value})} placeholder="输入姓名" />
              </label>
              <label>入职日期起
                <input type="date" value={filters.hire_from} onChange={e => setFilters({...filters,hire_from:e.target.value})} />
              </label>
              <label>入职日期止
                <input type="date" value={filters.hire_to} onChange={e => setFilters({...filters,hire_to:e.target.value})} />
              </label>
            </div>
          )}
        </div>

        <div className="list-meta-row">
          <span>共 {filtered.length} 条</span>
          <div>默认按员工ID排序</div>
        </div>

        {generated && (
          <div className="activation-banner">
            <div>
              <span>{generated.employee_no} · {generated.employee_name}</span>
              <strong>{generated.activation_code}</strong>
            </div>
            <button onClick={() => navigator.clipboard.writeText(generated.activation_code)}>复制激活码</button>
          </div>
        )}

        {error && <div className="page-error">{error}</div>}

        <div className="data-card">
          {loading ? <div className="empty-state">读取中...</div> :
            filtered.length === 0 ? <div className="empty-state">暂无符合条件的员工资料</div> :
            <div className="table-scroll"><table className="data-table">
              <thead><tr>
                <th>员工ID</th><th>姓名</th><th>国家</th><th>团队</th><th>组长</th>
                <th>岗位</th><th>员工类型</th><th>入职日期</th><th>状态</th><th>员工账号</th><th>操作</th>
              </tr></thead>
              <tbody>{filtered.map(r => {
                const hasAccount = opened.has(r.id)
                return <tr key={r.id}>
                  <td><strong>{r.employee_no}</strong></td>
                  <td>{r.full_name}</td>
                  <td>{r.country || '-'}</td>
                  <td>{r.teams?.name || '-'}</td>
                  <td>{leaderText(r) || '-'}</td>
                  <td>{r.positions?.name || '-'}</td>
                  <td>{r.employment_type || '-'}</td>
                  <td>{hireDate(r) || '-'}</td>
                  <td><span className="status-chip">{statusName(r.status)}</span></td>
                  <td>{hasAccount ? '已开通' : '未开通'}</td>
                  <td>{!hasAccount &&
                    <button className="table-action" onClick={() => generateCode(r.employee_no)}>生成激活码</button>
                  }</td>
                </tr>
              })}</tbody>
            </table></div>
          }
        </div>
      </>}

      {tab !== '员工档案' && (
        <div className="data-card module-empty">
          <div>
            <h2>{tab}</h2>
            <p>子页面结构已建立；接下来按这个入口接入真实管理功能。</p>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="modal-mask" onMouseDown={() => setShowCreate(false)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-head"><h2>新增员工</h2><button onClick={() => setShowCreate(false)}>×</button></div>
            <div className="form-grid">
              <label>员工ID<input value={form.employee_no} onChange={e => setForm({...form,employee_no:e.target.value.toUpperCase()})}/></label>
              <label>姓名<input value={form.full_name} onChange={e => setForm({...form,full_name:e.target.value})}/></label>
              <label>国家<input value={form.country} onChange={e => setForm({...form,country:e.target.value})}/></label>
              <label>国籍<input value={form.nationality} onChange={e => setForm({...form,nationality:e.target.value})}/></label>
              <label>员工类型
                <select value={form.employment_type} onChange={e => setForm({...form,employment_type:e.target.value})}>
                  <option value="">请选择</option>
                  <option value="home_ph">纯居家菲律宾</option>
                  <option value="onsite_to_home">现场转居家</option>
                  <option value="home_vn">纯居家越南</option>
                  <option value="home_id">纯居家印尼</option>
                  <option value="home_mm">纯居家缅甸</option>
                </select>
              </label>
              <label>团队
                <select value={form.team_id} onChange={e => setForm({...form,team_id:e.target.value})}>
                  <option value="">未设置</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label>岗位
                <select value={form.position_id} onChange={e => setForm({...form,position_id:e.target.value})}>
                  <option value="">未设置</option>
                  {positions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label>状态
                <select value={form.status} onChange={e => setForm({...form,status:e.target.value})}>
                  <option value="active">在职</option>
                  <option value="inactive">停用</option>
                  <option value="resigned">离职</option>
                </select>
              </label>
            </div>
            <div className="modal-actions">
              <button className="secondary-action" onClick={() => setShowCreate(false)}>取消</button>
              <button className="primary-action" onClick={createEmployee}>创建员工</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
