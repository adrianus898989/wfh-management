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

export default function AdminEmployeesPage() {
  const [rows, setRows] = useState([])
  const [accounts, setAccounts] = useState([])
  const [teams, setTeams] = useState([])
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [generated, setGenerated] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(freshEmployee())

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r =>
      `${r.employee_no} ${r.full_name} ${r.country || ''} ${r.teams?.name || ''} ${r.positions?.name || ''}`
        .toLowerCase()
        .includes(q)
    )
  }, [rows, query])

  const createEmployee = async () => {
    try {
      await call({ action: 'create_employee', ...form })
      setShowCreate(false)
      setForm(freshEmployee())
      await load()
    } catch (e) {
      setError(e.message)
    }
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

  return (
    <div className="content-page">
      <style>{`
        .employee-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
        .employee-head-left{display:flex;align-items:center;gap:10px}.employee-head h1{margin:0;font-size:28px}
        .employee-tools{display:flex;gap:8px}.employee-tools input{height:40px;width:280px;border:1px solid #d8e1eb;border-radius:9px;padding:0 11px}
      `}</style>

      <div className="employee-head">
        <div className="employee-head-left"><h1>员工管理</h1></div>
        <div className="employee-tools">
          <input placeholder="搜索员工ID / 姓名 / 团队" value={query} onChange={e => setQuery(e.target.value)} />
          <button className="primary-action" onClick={() => setShowCreate(true)}>+ 新增员工</button>
        </div>
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
          filtered.length === 0 ? <div className="empty-state">暂无员工资料</div> :
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>员工ID</th><th>姓名</th><th>国家</th><th>团队</th><th>岗位</th><th>状态</th><th>员工账号</th><th>操作</th></tr></thead>
            <tbody>{filtered.map(r => {
              const hasAccount = opened.has(r.id)
              return <tr key={r.id}>
                <td><strong>{r.employee_no}</strong></td>
                <td>{r.full_name}</td>
                <td>{r.country || '-'}</td>
                <td>{r.teams?.name || '-'}</td>
                <td>{r.positions?.name || '-'}</td>
                <td><span className="status-chip">{r.status || 'active'}</span></td>
                <td>{hasAccount ? '已开通' : '未开通'}</td>
                <td>{!hasAccount &&
                  <button className="table-action" onClick={() => generateCode(r.employee_no)}>生成激活码</button>
                }</td>
              </tr>
            })}</tbody>
          </table></div>
        }
      </div>

      {showCreate && (
        <div className="modal-mask" onMouseDown={() => setShowCreate(false)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-head"><h2>新增员工</h2><button onClick={() => setShowCreate(false)}>×</button></div>

            <div className="form-grid">
              <label>员工ID
                <input value={form.employee_no} onChange={e => setForm({...form,employee_no:e.target.value.toUpperCase()})}/>
              </label>
              <label>姓名
                <input value={form.full_name} onChange={e => setForm({...form,full_name:e.target.value})}/>
              </label>
              <label>国家
                <input value={form.country} onChange={e => setForm({...form,country:e.target.value})}/>
              </label>
              <label>国籍
                <input value={form.nationality} onChange={e => setForm({...form,nationality:e.target.value})}/>
              </label>
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
