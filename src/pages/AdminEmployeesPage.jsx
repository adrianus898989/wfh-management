import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function AdminEmployeesPage() {
  const [rows, setRows] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [generated, setGenerated] = useState(null)

  const load = async () => {
    setLoading(true)
    setError('')

    const { data, error } = await supabase.functions.invoke('admin-accounts', {
      body: { action: 'bootstrap' },
    })

    if (error || data?.error) {
      setError(data?.error || error?.message || '读取失败')
    } else {
      setRows(data?.employees || [])
      setAccounts(data?.employee_accounts || [])
    }

    setLoading(false)
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
      `${r.employee_no} ${r.full_name} ${r.teams?.name || ''} ${r.positions?.name || ''}`
        .toLowerCase()
        .includes(q)
    )
  }, [rows, query])

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
      <div className="page-toolbar">
        <h1>员工管理</h1>
        <input
          className="table-search"
          placeholder="搜索员工ID / 姓名 / 团队"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </div>

      {generated && (
        <div className="activation-banner">
          <div>
            <span>{generated.employee_no} · {generated.employee_name}</span>
            <strong>{generated.activation_code}</strong>
          </div>
          <button onClick={() => navigator.clipboard.writeText(generated.activation_code)}>
            复制
          </button>
        </div>
      )}

      {error && <div className="page-error">{error}</div>}

      <div className="data-card">
        {loading ? (
          <div className="empty-state">读取中...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">暂无员工资料</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>员工ID</th>
                  <th>姓名</th>
                  <th>团队</th>
                  <th>岗位</th>
                  <th>状态</th>
                  <th>员工账号</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const hasAccount = opened.has(r.id)
                  return (
                    <tr key={r.id}>
                      <td><strong>{r.employee_no}</strong></td>
                      <td>{r.full_name}</td>
                      <td>{r.teams?.name || '-'}</td>
                      <td>{r.positions?.name || '-'}</td>
                      <td><span className="status-chip">{r.status || '在职'}</span></td>
                      <td>{hasAccount ? '已开通' : '未开通'}</td>
                      <td>
                        {!hasAccount && (
                          <button className="table-action" onClick={() => generateCode(r.employee_no)}>
                            生成激活码
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
