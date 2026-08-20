import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const USER_TABS = ['backend', 'staff', 'roles']

const blankAccount = () => ({
  auth_user_id: '',
  employee_id: '',
  username: '',
  password: '',
  role_id: '',
  data_scope: 'own_team',
  otp_required: false,
  team_ids: [],
  employee_ids: [],
})

const actionLabels = {
  view: '查看',
  create: '新增',
  edit: '编辑',
  delete: '删除',
  approve: '审批',
  export: '导出',
  publish: '发布',
  manage: '管理',
  disable: '停用',
  reset_password: '重置密码',
  otp_toggle: 'OTP开关',
  mfa_reset: '重置OTP',
}

function getRole(a) {
  return Array.isArray(a?.roles) ? a.roles[0] : a?.roles
}

function scopeLabel(scope) {
  if (scope === 'all') return '全部'
  if (scope === 'assigned') return '指定范围'
  return '自己团队'
}

function permissionShape(code) {
  const parts = String(code || '').split('.')
  return {
    module: parts.slice(0, -1).join('.') || 'other',
    action: parts.at(-1) || 'other',
  }
}

export default function AdminUsersPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const [tab, setTabState] = useState(USER_TABS.includes(requestedTab) ? requestedTab : 'backend')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [accountModal, setAccountModal] = useState(null)
  const [roleModal, setRoleModal] = useState(null)
  const [newRoleName, setNewRoleName] = useState('')

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
  useEffect(() => {
    setTabState(USER_TABS.includes(requestedTab) ? requestedTab : 'backend')
  }, [requestedTab])

  const setTab = next => {
    setTabState(next)
    setSearchParams(next === 'backend' ? {} : { tab: next }, { replace: true })
  }

  const callerFounder = data?.caller?.is_founder
  const backend = data?.backend_accounts || []
  const staff = data?.employee_accounts || []
  const employees = data?.employees || []
  const roles = (data?.roles || []).filter(r => r.active !== false)
  const permissions = data?.permissions || []
  const rolePermissions = data?.role_permissions || []
  const teams = data?.teams || []
  const scopeTeams = data?.scope_teams || []
  const scopeEmployees = data?.scope_employees || []

  const editableRoles = roles.filter(r => !['founder', 'employee'].includes(r.code))

  const rolePermissionMap = useMemo(() => {
    const map = new Map()
    for (const r of rolePermissions) {
      if (!map.has(r.role_id)) map.set(r.role_id, new Set())
      map.get(r.role_id).add(r.permission_id)
    }
    return map
  }, [rolePermissions])

  const groupedPermissions = useMemo(() => {
    const groups = new Map()
    for (const p of permissions) {
      const s = permissionShape(p.code)
      if (!groups.has(s.module)) groups.set(s.module, [])
      groups.get(s.module).push({ ...p, actionKey: s.action })
    }
    return [...groups.entries()].map(([module, items]) => ({ module, items }))
  }, [permissions])

  const openCreate = () => setAccountModal({ mode: 'create', form: blankAccount() })

  const openEdit = (a) => {
    const role = getRole(a)
    setAccountModal({
      mode: 'edit',
      form: {
        auth_user_id: a.auth_user_id,
        employee_id: a.employee_id || '',
        username: a.login_username || '',
        password: '',
        role_id: role?.id || a.role_id || '',
        data_scope: a.data_scope || 'own_team',
        otp_required: Boolean(a.otp_required),
        team_ids: scopeTeams.filter(x => x.auth_user_id === a.auth_user_id).map(x => x.team_id),
        employee_ids: scopeEmployees.filter(x => x.auth_user_id === a.auth_user_id).map(x => x.employee_id),
      }
    })
  }

  const saveAccount = async () => {
    const { mode, form } = accountModal
    setError('')
    try {
      if (mode === 'create') {
        await call({ action: 'create_backend', ...form })
      } else {
        await call({
          action: 'update_backend',
          auth_user_id: form.auth_user_id,
          role_id: form.role_id,
          data_scope: form.data_scope,
          team_ids: form.team_ids,
          employee_ids: form.employee_ids,
        })
      }
      setAccountModal(null)
      await load()
    } catch (e) {
      setError(e.message)
    }
  }

  const toggleOtp = async (a) => {
    try {
      await call({ action: 'toggle_otp', auth_user_id: a.auth_user_id, otp_required: !a.otp_required })
      await load()
    } catch (e) { setError(e.message) }
  }

  const toggleActive = async (a) => {
    try {
      await call({ action: 'toggle_active', auth_user_id: a.auth_user_id, active: !a.active })
      await load()
    } catch (e) { setError(e.message) }
  }

  const resetPassword = async (a) => {
    const password = window.prompt('输入新的临时密码')
    if (!password) return
    try {
      await call({ action: 'reset_password', auth_user_id: a.auth_user_id, password })
      window.alert('密码已重置')
    } catch (e) { setError(e.message) }
  }

  const resetMfa = async (a) => {
    if (!window.confirm('确认重置该账号的 Google OTP？')) return
    try {
      await call({ action: 'reset_mfa', auth_user_id: a.auth_user_id })
      window.alert('OTP 已重置')
    } catch (e) { setError(e.message) }
  }

  const deleteAccount = async (a) => {
    if (!window.confirm('只删除登录账号，员工资料会保留。确认继续？')) return
    try {
      await call({ action: 'delete_account', auth_user_id: a.auth_user_id })
      await load()
    } catch (e) { setError(e.message) }
  }

  const createRole = async () => {
    if (!newRoleName.trim()) return
    try {
      await call({ action: 'create_role', name: newRoleName.trim() })
      setNewRoleName('')
      await load()
    } catch (e) { setError(e.message) }
  }

  const openRole = (role) => {
    const selected = role.code === 'founder'
      ? permissions.map(p => p.id)
      : [...(rolePermissionMap.get(role.id) || new Set())]

    setRoleModal({
      role,
      name: role.name,
      permission_ids: selected,
    })
  }

  const saveRole = async () => {
    if (!roleModal) return
    try {
      if (!roleModal.role.system_locked && roleModal.name !== roleModal.role.name) {
        await call({ action: 'rename_role', role_id: roleModal.role.id, name: roleModal.name })
      }
      if (roleModal.role.code !== 'founder') {
        await call({
          action: 'save_role_permissions',
          role_id: roleModal.role.id,
          permission_ids: roleModal.permission_ids,
        })
      }
      setRoleModal(null)
      await load()
    } catch (e) { setError(e.message) }
  }

  const deleteRole = async (role) => {
    if (!window.confirm(`确认删除角色「${role.name}」？`)) return
    try {
      await call({ action: 'delete_role', role_id: role.id })
      await load()
    } catch (e) { setError(e.message) }
  }

  return (
    <div className="content-page access-page">
      <style>{`
        .access-page .page-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
        .access-page .page-toolbar h1{margin:0;font-size:28px}
        .access-tabs{display:inline-flex;padding:4px;background:#e8eef6;border-radius:11px;margin-bottom:14px}
        .access-tabs button{border:0;background:transparent;padding:9px 17px;border-radius:8px;color:#718096;font-weight:800;cursor:pointer}
        .access-tabs button.active{background:#fff;color:#255ec7;box-shadow:0 2px 8px rgba(35,55,85,.08)}
        .access-grid-actions{display:flex;gap:7px;flex-wrap:wrap}
        .access-grid-actions button{border:1px solid #d9e2ed;background:#fff;border-radius:7px;padding:6px 8px;font-size:11px;cursor:pointer}
        .access-grid-actions button.danger{color:#bd4242}
        .role-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
        .role-card{border:1px solid #e0e7ef;background:#fff;border-radius:13px;padding:16px}
        .role-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
        .role-card h3{margin:0;font-size:15px}.role-card small{color:#8995a6}
        .role-card-actions{display:flex;gap:7px;margin-top:13px}.role-card-actions button{border:1px solid #dbe3ed;background:#fff;border-radius:8px;padding:7px 10px}
        .create-role-row{display:flex;gap:8px;margin-bottom:14px}.create-role-row input{height:40px;border:1px solid #d8e1eb;border-radius:9px;padding:0 11px}
        .scope-panel{grid-column:1/-1;border:1px solid #e3e9f1;border-radius:11px;padding:12px;background:#fafbfd}
        .scope-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.check-list{max-height:180px;overflow:auto;border:1px solid #e2e8f0;border-radius:9px;background:#fff;padding:8px}
        .check-list label{display:flex;gap:8px;align-items:center;padding:7px 5px;font-size:12px;color:#46566d}
        .permission-matrix{overflow:auto;border:1px solid #e1e8f0;border-radius:11px}.permission-matrix table{width:100%;border-collapse:collapse}
        .permission-matrix th,.permission-matrix td{padding:10px 11px;border-bottom:1px solid #edf1f5;font-size:12px;text-align:center}.permission-matrix th:first-child,.permission-matrix td:first-child{text-align:left}
        .permission-matrix th{background:#f8fafc;color:#67778d;position:sticky;top:0}.sensitive-row{background:#fff9f1}
        .role-modal{width:min(920px,96vw)}
        @media(max-width:900px){.role-list{grid-template-columns:1fr}.scope-columns{grid-template-columns:1fr}}
      `}</style>

      <div className="page-toolbar">
        <h1>用户与权限</h1>
        {tab === 'backend' && <button className="primary-action" onClick={openCreate}>+ 新增后台账号</button>}
      </div>

      <div className="access-tabs">
        <button className={tab === 'backend' ? 'active' : ''} onClick={() => setTab('backend')}>后台账号</button>
        <button className={tab === 'staff' ? 'active' : ''} onClick={() => setTab('staff')}>员工账号</button>
        <button className={tab === 'roles' ? 'active' : ''} onClick={() => setTab('roles')}>角色与权限</button>
      </div>

      {error && <div className="page-error">{error}</div>}

      {loading ? <div className="data-card"><div className="empty-state">读取中...</div></div> : (
        <>
          {tab === 'backend' && (
            <div className="data-card table-scroll">
              <table className="data-table">
                <thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>范围</th><th>OTP</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  {backend.map(a => {
                    const role = getRole(a)
                    const founder = role?.code === 'founder'
                    return <tr key={a.auth_user_id}>
                      <td><strong>{a.login_username || '-'}</strong></td>
                      <td>{a.employee?.full_name || '-'}</td>
                      <td>{role?.name || '-'}</td>
                      <td>{scopeLabel(a.data_scope)}</td>
                      <td>
                        <button className={`switch-button ${a.otp_required ? 'on' : ''}`} onClick={() => toggleOtp(a)}>
                          <i/><span>{a.otp_required ? '开' : '关'}</span>
                        </button>
                      </td>
                      <td><span className={`status-chip ${a.active ? '' : 'off'}`}>{a.active ? '正常' : '停用'}</span></td>
                      <td><div className="access-grid-actions">
                        {!founder && <button onClick={() => openEdit(a)}>编辑</button>}
                        <button onClick={() => resetPassword(a)}>重置密码</button>
                        <button onClick={() => resetMfa(a)}>重置OTP</button>
                        {!founder && <button onClick={() => toggleActive(a)}>{a.active ? '停用' : '启用'}</button>}
                        {!founder && <button className="danger" onClick={() => deleteAccount(a)}>删除账号</button>}
                      </div></td>
                    </tr>
                  })}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'staff' && (
            <div className="data-card table-scroll">
              {staff.length === 0 ? <div className="empty-state">暂无员工账号</div> :
              <table className="data-table">
                <thead><tr><th>员工ID</th><th>姓名</th><th>邮箱</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>{staff.map(a => <tr key={a.auth_user_id}>
                  <td><strong>{a.employee?.employee_no || '-'}</strong></td>
                  <td>{a.employee?.full_name || '-'}</td>
                  <td>{a.login_email || '-'}</td>
                  <td><span className={`status-chip ${a.active ? '' : 'off'}`}>{a.active ? '正常' : '停用'}</span></td>
                  <td><div className="access-grid-actions">
                    <button onClick={() => resetPassword(a)}>重置密码</button>
                    <button onClick={() => resetMfa(a)}>重置OTP</button>
                    <button onClick={() => toggleActive(a)}>{a.active ? '停用' : '启用'}</button>
                    <button className="danger" onClick={() => deleteAccount(a)}>删除登录账号</button>
                  </div></td>
                </tr>)}</tbody>
              </table>}
            </div>
          )}

          {tab === 'roles' && (
            <>
              {callerFounder && <div className="create-role-row">
                <input placeholder="新角色名称" value={newRoleName} onChange={e => setNewRoleName(e.target.value)} />
                <button className="primary-action" onClick={createRole}>新增角色</button>
              </div>}
              <div className="role-list">
                {roles.filter(r => r.code !== 'employee').map(role => (
                  <div className="role-card" key={role.id}>
                    <div className="role-card-head">
                      <div><h3>{role.name}</h3><small>{role.code === 'founder' ? '系统角色' : '可编辑'}</small></div>
                      {role.code === 'founder' && <span className="status-chip">锁定</span>}
                    </div>
                    <div className="role-card-actions">
                      <button onClick={() => openRole(role)}>权限</button>
                      {!role.system_locked && <button onClick={() => deleteRole(role)}>删除</button>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {accountModal && (
        <div className="modal-mask" onMouseDown={() => setAccountModal(null)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{accountModal.mode === 'create' ? '新增后台账号' : '编辑后台账号'}</h2>
              <button onClick={() => setAccountModal(null)}>×</button>
            </div>

            <div className="form-grid">
              {accountModal.mode === 'create' && <>
                <label>关联员工
                  <select value={accountModal.form.employee_id} onChange={e => setAccountModal(x => ({...x, form:{...x.form, employee_id:e.target.value}}))}>
                    <option value="">不关联</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.employee_no} · {e.full_name}</option>)}
                  </select>
                </label>
                <label>用户名
                  <input value={accountModal.form.username} onChange={e => setAccountModal(x => ({...x, form:{...x.form, username:e.target.value.toLowerCase()}}))}/>
                </label>
                <label>临时密码
                  <input type="password" value={accountModal.form.password} onChange={e => setAccountModal(x => ({...x, form:{...x.form, password:e.target.value}}))}/>
                </label>
              </>}

              <label>角色
                <select value={accountModal.form.role_id} onChange={e => setAccountModal(x => ({...x, form:{...x.form, role_id:e.target.value}}))}>
                  <option value="">请选择</option>
                  {editableRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>

              <label>管理范围
                <select value={accountModal.form.data_scope} onChange={e => setAccountModal(x => ({...x, form:{...x.form, data_scope:e.target.value}}))}>
                  <option value="own_team">自己团队</option>
                  <option value="assigned">指定范围</option>
                  <option value="all">全部</option>
                </select>
              </label>

              {accountModal.mode === 'create' && <label>登录 OTP
                <select value={accountModal.form.otp_required ? '1':'0'} onChange={e => setAccountModal(x => ({...x, form:{...x.form, otp_required:e.target.value==='1'}}))}>
                  <option value="0">关闭</option>
                  <option value="1">开启</option>
                </select>
              </label>}

              {accountModal.form.data_scope === 'assigned' && (
                <div className="scope-panel">
                  <div className="scope-columns">
                    <div><strong>团队</strong><div className="check-list">
                      {teams.length === 0 ? <div className="empty-state">暂无团队</div> : teams.map(t => (
                        <label key={t.id}><input type="checkbox"
                          checked={accountModal.form.team_ids.includes(t.id)}
                          onChange={e => setAccountModal(x => ({...x,form:{...x.form,team_ids:e.target.checked?[...x.form.team_ids,t.id]:x.form.team_ids.filter(id=>id!==t.id)}}))}
                        />{t.name}</label>
                      ))}
                    </div></div>
                    <div><strong>指定员工</strong><div className="check-list">
                      {employees.length === 0 ? <div className="empty-state">暂无员工</div> : employees.map(emp => (
                        <label key={emp.id}><input type="checkbox"
                          checked={accountModal.form.employee_ids.includes(emp.id)}
                          onChange={e => setAccountModal(x => ({...x,form:{...x.form,employee_ids:e.target.checked?[...x.form.employee_ids,emp.id]:x.form.employee_ids.filter(id=>id!==emp.id)}}))}
                        />{emp.employee_no} · {emp.full_name}</label>
                      ))}
                    </div></div>
                  </div>
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button className="secondary-action" onClick={() => setAccountModal(null)}>取消</button>
              <button className="primary-action" onClick={saveAccount}>保存</button>
            </div>
          </div>
        </div>
      )}

      {roleModal && (
        <div className="modal-mask" onMouseDown={() => setRoleModal(null)}>
          <div className="modal-card role-modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-head">
              <h2>角色权限</h2>
              <button onClick={() => setRoleModal(null)}>×</button>
            </div>

            <label>角色名称
              <input disabled={roleModal.role.system_locked} value={roleModal.name}
                onChange={e => setRoleModal(x => ({...x, name:e.target.value}))}/>
            </label>

            <div className="permission-matrix" style={{marginTop:14}}>
              <table>
                <thead><tr><th>模块 / 权限</th><th>权限项</th></tr></thead>
                <tbody>
                  {groupedPermissions.map(group => (
                    <tr key={group.module} className={group.items.some(x=>x.sensitive) ? 'sensitive-row' : ''}>
                      <td><strong>{group.module}</strong></td>
                      <td>
                        <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
                          {group.items.map(p => (
                            <label key={p.id} style={{display:'inline-flex',gap:6,alignItems:'center'}}>
                              <input type="checkbox"
                                disabled={roleModal.role.code === 'founder'}
                                checked={roleModal.role.code === 'founder' || roleModal.permission_ids.includes(p.id)}
                                onChange={e => setRoleModal(x => ({
                                  ...x,
                                  permission_ids: e.target.checked
                                    ? [...x.permission_ids, p.id]
                                    : x.permission_ids.filter(id => id !== p.id)
                                }))}
                              />
                              {p.name || actionLabels[p.actionKey] || p.actionKey}
                              {p.sensitive && <span style={{color:'#b76a21'}}>敏感</span>}
                            </label>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="modal-actions">
              <button className="secondary-action" onClick={() => setRoleModal(null)}>取消</button>
              <button className="primary-action" onClick={saveRole}>保存权限</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
