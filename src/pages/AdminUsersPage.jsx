import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const fresh = () => ({
  employee_id: '',
  username: '',
  password: '',
  role_id: '',
  data_scope: 'own_team',
  otp_required: false,
})

export default function AdminUsersPage() {
  const [tab, setTab] = useState('backend')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(fresh())

  const call = async (body) => {
    const { data, error } = await supabase.functions.invoke('admin-accounts', { body })
    if (error || data?.error) throw new Error(data?.error || error?.message || '操作失败')
    return data
  }

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setData(await call({ action: 'bootstrap' }))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const create = async () => {
    setError('')
    try {
      await call({ action: 'create_backend', ...form })
      setShowCreate(false)
      setForm(fresh())
      await load()
    } catch (e) {
      setError(e.message)
    }
  }

  const toggleOtp = async (account) => {
    try {
      await call({
        action: 'toggle_otp',
        auth_user_id: account.auth_user_id,
        otp_required: !account.otp_required,
      })
      await load()
    } catch (e) {
      setError(e.message)
    }
  }

  const toggleActive = async (account) => {
    try {
      await call({
        action: 'toggle_active',
        auth_user_id: account.auth_user_id,
        active: !account.active,
      })
      await load()
    } catch (e) {
      setError(e.message)
    }
  }

  const resetPassword = async (account) => {
    const password = window.prompt('输入新的临时密码')
    if (!password) return

    try {
      await call({
        action: 'reset_password',
        auth_user_id: account.auth_user_id,
        password,
      })
      window.alert('密码已重置')
    } catch (e) {
      setError(e.message)
    }
  }

  const backend = data?.backend_accounts || []
  const staff = data?.employee_accounts || []
  const employees = data?.employees || []
  const roles = data?.roles || []

  return (
    <div className="content-page">
      <div className="page-toolbar">
        <h1>用户与权限</h1>
        {tab === 'backend' && (
          <button className="primary-action" onClick={() => setShowCreate(true)}>
            + 新增后台账号
          </button>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'backend' ? 'active' : ''} onClick={() => setTab('backend')}>
          后台账号
        </button>
        <button className={tab === 'staff' ? 'active' : ''} onClick={() => setTab('staff')}>
          员工账号
        </button>
      </div>

      {error && <div className="page-error">{error}</div>}

      <div className="data-card">
        {loading ? (
          <div className="empty-state">读取中...</div>
        ) : tab === 'backend' ? (
          backend.length === 0 ? <div className="empty-state">暂无后台账号</div> :
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>用户名</th>
                  <th>姓名</th>
                  <th>角色</th>
                  <th>范围</th>
                  <th>OTP</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {backend.map(a => {
                  const role = Array.isArray(a.roles) ? a.roles[0] : a.roles
                  return (
                    <tr key={a.auth_user_id}>
                      <td><strong>{a.login_username || '-'}</strong></td>
                      <td>{a.employee?.full_name || '-'}</td>
                      <td>{role?.name || role?.code || '-'}</td>
                      <td>{a.data_scope || '-'}</td>
                      <td>
                        <button
                          className={`switch-button ${a.otp_required ? 'on' : ''}`}
                          onClick={() => toggleOtp(a)}
                        >
                          <i />
                          <span>{a.otp_required ? '开' : '关'}</span>
                        </button>
                      </td>
                      <td><span className={`status-chip ${a.active ? '' : 'off'}`}>{a.active ? '正常' : '停用'}</span></td>
                      <td>
                        <div className="row-actions">
                          <button onClick={() => resetPassword(a)}>重置密码</button>
                          <button onClick={() => toggleActive(a)}>{a.active ? '停用' : '启用'}</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          staff.length === 0 ? <div className="empty-state">暂无员工账号</div> :
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>员工ID</th>
                  <th>姓名</th>
                  <th>邮箱</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {staff.map(a => (
                  <tr key={a.auth_user_id}>
                    <td><strong>{a.employee?.employee_no || '-'}</strong></td>
                    <td>{a.employee?.full_name || '-'}</td>
                    <td>{a.login_email || '-'}</td>
                    <td><span className={`status-chip ${a.active ? '' : 'off'}`}>{a.active ? '正常' : '停用'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <div className="modal-mask" onMouseDown={() => setShowCreate(false)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-head">
              <h2>新增后台账号</h2>
              <button onClick={() => setShowCreate(false)}>×</button>
            </div>

            <div className="form-grid">
              <label>
                关联员工
                <select value={form.employee_id} onChange={e => setForm({ ...form, employee_id: e.target.value })}>
                  <option value="">不关联</option>
                  {employees.map(e => (
                    <option key={e.id} value={e.id}>{e.employee_no} · {e.full_name}</option>
                  ))}
                </select>
              </label>

              <label>
                用户名
                <input
                  value={form.username}
                  onChange={e => setForm({ ...form, username: e.target.value.toLowerCase() })}
                />
              </label>

              <label>
                临时密码
                <input
                  type="password"
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                />
              </label>

              <label>
                角色
                <select value={form.role_id} onChange={e => setForm({ ...form, role_id: e.target.value })}>
                  <option value="">请选择</option>
                  {roles.filter(r => r.code !== 'employee').map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </label>

              <label>
                管理范围
                <select value={form.data_scope} onChange={e => setForm({ ...form, data_scope: e.target.value })}>
                  <option value="own_team">自己团队</option>
                  <option value="assigned">指定范围</option>
                  <option value="all">全部</option>
                </select>
              </label>

              <label>
                登录 OTP
                <select
                  value={form.otp_required ? '1' : '0'}
                  onChange={e => setForm({ ...form, otp_required: e.target.value === '1' })}
                >
                  <option value="0">关闭</option>
                  <option value="1">开启</option>
                </select>
              </label>
            </div>

            <div className="modal-actions">
              <button className="secondary-action" onClick={() => setShowCreate(false)}>取消</button>
              <button className="primary-action" onClick={create}>创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
