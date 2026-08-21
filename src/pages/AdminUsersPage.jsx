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
  data_scope: 'all',
  otp_required: false,
  team_ids: [],
  employee_ids: [],
  scope_team_search: '',
  scope_employee_search: '',
})

const blankStaffAccount = () => ({
  employee_id: '',
  employee_search: '',
  email: '',
  password: '',
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

const moduleLabels = {
  account: '账号安全',
  user: '用户与权限',
  employee: '员工档案',
  'employee.compensation': '员工薪资资料',
  team: '团队管理',
  schedule: '排班表',
  attendance: '考勤管理',
  leave: '请假与离岗',
  daily_work: '每日工作报告',
  online_training: '线上培训报告',
  report: '统计报表',
  exam: '培训与考试',
  adjustment: '调整与奖惩',
  payroll: '工资中心',
  'payroll.rule': '工资规则',
  audit: '操作日志',
  export: '数据导出',
  sensitive: '敏感资料',
}

const permissionActionOrder = ['view', 'create', 'submit', 'edit', 'manage', 'approve', 'grade', 'publish', 'export', 'delete', 'disable', 'reset_password', 'otp_toggle', 'mfa_reset']
const permissionColumns = [
  { key: 'view', label: '查看', actions: ['view'] },
  { key: 'create', label: '新增 / 提交', actions: ['create', 'submit'] },
  { key: 'edit', label: '编辑', actions: ['edit'] },
  { key: 'delete', label: '删除', actions: ['delete'] },
  { key: 'manage', label: '审批 / 管理', actions: ['approve', 'manage', 'grade', 'publish'] },
  { key: 'other', label: '其他', actions: ['export', 'disable', 'reset_password', 'otp_toggle', 'mfa_reset'] },
]

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
  const [staffModal, setStaffModal] = useState(null)
  const [roleModal, setRoleModal] = useState(null)
  const [newRoleName, setNewRoleName] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  const call = async (body) => {
    const { data, error } = await supabase.functions.invoke('admin-accounts', { body })
    if (error) {
      let detail = ''
      try { detail = (await error.context?.json())?.error || '' } catch {}
      throw new Error(detail || data?.error || error?.message || '操作失败')
    }
    if (data?.error) throw new Error(data.error)
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
    setSearchDraft('')
    setSearchQuery('')
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
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const matchesSearch = (...values) => !normalizedSearch || values.some(value => String(value || '').toLowerCase().includes(normalizedSearch))
  const visibleBackend = backend.filter(a => {
    const role = getRole(a)
    return matchesSearch(a.login_username, a.employee?.employee_no, a.employee?.full_name, role?.name, scopeLabel(a.data_scope))
  })
  const visibleStaff = staff.filter(a => matchesSearch(a.login_email, a.employee?.employee_no, a.employee?.full_name, a.employee?.teams?.name, a.employee?.positions?.name))
  const visibleRoles = roles.filter(r => r.code !== 'employee' && matchesSearch(r.name, r.code))

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
    return [...groups.entries()].map(([module, items]) => ({
      module,
      label: moduleLabels[module] || module,
      items: [...items].sort((a, b) => permissionActionOrder.indexOf(a.actionKey) - permissionActionOrder.indexOf(b.actionKey)),
    }))
  }, [permissions])

  const openCreate = () => setAccountModal({ mode: 'create', form: blankAccount(), error: '', saving: false })
  const openCreateStaff = () => setStaffModal({ form: blankStaffAccount(), error: '', saving: false })

  const openEdit = (a) => {
    const role = getRole(a)
    setAccountModal({
      mode: 'edit',
      error: '',
      saving: false,
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
        scope_team_search: '',
        scope_employee_search: '',
      }
    })
  }

  const saveAccount = async () => {
    const { mode, form } = accountModal
    setAccountModal(x => ({ ...x, error: '', saving: true }))
    try {
      if (mode === 'create') {
        await call({ action: 'create_backend', ...form })
      } else {
        await call({
          action: 'update_backend',
          auth_user_id: form.auth_user_id,
          employee_id: form.employee_id,
          role_id: form.role_id,
          data_scope: form.data_scope,
          team_ids: form.team_ids,
          employee_ids: form.employee_ids,
        })
      }
      setAccountModal(null)
      await load()
    } catch (e) {
      setAccountModal(x => ({ ...x, error: e.message, saving: false }))
    }
  }

  const saveStaffAccount = async () => {
    setStaffModal(x => ({ ...x, error: '', saving: true }))
    if (!staffModal.form.employee_id) {
      setStaffModal(x => ({ ...x, error: '请先输入员工ID或姓名，并从搜索建议中确认员工档案。', saving: false }))
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(staffModal.form.email.trim())) {
      setStaffModal(x => ({ ...x, error: '请填写正确的登录邮箱格式。', saving: false }))
      return
    }
    if (!staffModal.form.password) {
      setStaffModal(x => ({ ...x, error: '请填写临时密码。', saving: false }))
      return
    }
    try {
      await call({ action: 'create_staff', ...staffModal.form })
      setStaffModal(null)
      await load()
    } catch (e) { setStaffModal(x => ({ ...x, error: e.message, saving: false })) }
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

  const permissionToggle = (p) => (
    <label key={p.id} className="permission-choice">
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
      <span>{p.name || actionLabels[p.actionKey] || p.actionKey}</span>
      {p.sensitive && <em>敏感</em>}
    </label>
  )

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
        .access-searchbar{display:grid;grid-template-columns:minmax(300px,1fr) auto auto auto;align-items:center;gap:9px;margin-bottom:14px;padding:12px;background:#fff;border:1px solid #dfe7f0;border-radius:12px}.access-searchbar input{height:40px;width:100%;border:1px solid #d6e0eb;border-radius:9px;padding:0 12px}.access-searchbar .secondary-action,.access-searchbar .primary-action{height:40px;white-space:nowrap}
        .account-modal{width:min(760px,94vw);max-height:min(760px,88vh);display:flex;flex-direction:column;overflow:hidden}.account-modal .modal-head{flex:0 0 auto}.account-modal .account-modal-body{overflow:auto;padding:2px 3px 8px}.account-modal .modal-actions{flex:0 0 auto;position:sticky;bottom:0;background:#fff;border-top:1px solid #edf1f5;padding-top:12px;margin-top:6px;z-index:2}
        .scope-panel{grid-column:1/-1;border:1px solid #e3e9f1;border-radius:11px;padding:12px;background:#fafbfd}
        .scope-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.scope-column-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}.scope-column-head span{font-size:10px;color:#5873a1}.scope-search{width:100%;height:36px!important;margin-bottom:7px}.check-list{max-height:180px;overflow:auto;border:1px solid #e2e8f0;border-radius:9px;background:#fff;padding:8px}
        .check-list label{display:flex;gap:8px;align-items:center;padding:7px 5px;font-size:12px;color:#46566d}
        .permission-matrix{overflow:auto;border:1px solid #e1e8f0;border-radius:11px}.permission-matrix table{width:100%;border-collapse:collapse}
        .permission-matrix th,.permission-matrix td{padding:10px 11px;border-bottom:1px solid #edf1f5;font-size:12px;text-align:center}.permission-matrix th:first-child,.permission-matrix td:first-child{text-align:left}
        .permission-matrix th{background:#f8fafc;color:#67778d;position:sticky;top:0}.sensitive-row{background:#fff9f1}
        .permission-matrix td.permission-cell{min-width:110px;vertical-align:top}.permission-empty{color:#c2cad5}
        .permission-choice{display:flex;align-items:flex-start;gap:6px;text-align:left;margin:2px 0;color:#3e4f66}.permission-choice input{margin-top:2px}.permission-choice em{font-size:9px;color:#a96019;background:#fff1dc;padding:1px 4px;border-radius:4px;font-style:normal}
        .role-modal{width:min(920px,96vw)}
        .employee-search-results{grid-column:1/-1;max-height:235px;overflow:auto;border:1px solid #dce5ef;border-radius:10px;background:#fff;padding:5px}.employee-search-option{width:100%;display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center;border:0;border-bottom:1px solid #edf1f5;background:#fff;padding:10px;text-align:left;cursor:pointer}.employee-search-option:hover{background:#f3f7ff}.employee-search-option:last-child{border-bottom:0}.employee-search-option strong{color:#24415f}.employee-search-option small{color:#738198}.employee-search-option span{font-size:11px;color:#376ac5}.linked-employee{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid #bfe6d0;background:#f0fbf5;border-radius:9px;color:#18784a;font-size:12px}.linked-employee button{border:0;background:transparent;color:#b34b4b;cursor:pointer}
        @media(max-width:900px){.role-list{grid-template-columns:1fr}.scope-columns{grid-template-columns:1fr}.access-searchbar{grid-template-columns:1fr 1fr}.access-searchbar input{grid-column:1/-1}.employee-search-option{grid-template-columns:95px 1fr}}
      `}</style>

      <div className="page-toolbar">
        <h1>用户与权限</h1>
      </div>

      <div className="access-tabs">
        <button className={tab === 'backend' ? 'active' : ''} onClick={() => setTab('backend')}>后台账号</button>
        <button className={tab === 'staff' ? 'active' : ''} onClick={() => setTab('staff')}>员工账号</button>
        <button className={tab === 'roles' ? 'active' : ''} onClick={() => setTab('roles')}>角色与权限</button>
      </div>

      {error && <div className="page-error">{error}</div>}

      {tab !== 'roles' && <div className="access-searchbar">
        <input value={searchDraft} onChange={e => setSearchDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && setSearchQuery(searchDraft)}
          placeholder={tab === 'backend' ? '搜索用户名、员工ID、姓名、角色或管理范围' : '搜索用户名、员工ID、姓名、团队或岗位'} />
        <button className="primary-action" onClick={() => setSearchQuery(searchDraft)}>查询</button>
        <button className="secondary-action" onClick={() => { setSearchDraft(''); setSearchQuery('') }}>重置</button>
        <button className="primary-action" onClick={tab === 'backend' ? openCreate : openCreateStaff}>
          {tab === 'backend' ? '＋ 新增后台账号' : '＋ 新增员工账号'}
        </button>
      </div>}

      {loading ? <div className="data-card"><div className="empty-state">读取中...</div></div> : (
        <>
          {tab === 'backend' && (
            <div className="data-card table-scroll">
              <table className="data-table">
                <thead><tr><th>用户名</th><th>关联员工ID</th><th>姓名</th><th>角色</th><th>范围</th><th>OTP</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  {visibleBackend.map(a => {
                    const role = getRole(a)
                    const founder = role?.code === 'founder'
                    return <tr key={a.auth_user_id}>
                      <td><strong>{a.login_username || '-'}</strong></td>
                      <td><strong>{a.employee?.employee_no || '未关联'}</strong></td>
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
                <thead><tr><th>登录邮箱</th><th>员工ID</th><th>姓名</th><th>团队</th><th>岗位</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>{visibleStaff.map(a => <tr key={a.auth_user_id}>
                  <td><strong>{a.login_email || '-'}</strong></td>
                  <td><strong>{a.employee?.employee_no || '-'}</strong></td>
                  <td>{a.employee?.full_name || '-'}</td>
                  <td>{a.employee?.teams?.name || '-'}</td>
                  <td>{a.employee?.positions?.name || '-'}</td>
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
                {visibleRoles.map(role => (
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
          <div className="modal-card account-modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{accountModal.mode === 'create' ? '新增后台账号' : '编辑后台账号'}</h2>
              <button onClick={() => setAccountModal(null)}>×</button>
            </div>

            {accountModal.error && <div className="page-error" style={{margin:'0 0 12px'}}>{accountModal.error}</div>}
            <div className="account-modal-body"><div className="form-grid">
              <label>关联员工档案
                <select value={accountModal.form.employee_id} onChange={e => setAccountModal(x => ({...x, form:{...x.form, employee_id:e.target.value, data_scope:!e.target.value&&x.form.data_scope==='own_team'?'all':x.form.data_scope}}))}>
                  <option value="">不关联（请选择全部或指定范围）</option>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.employee_no} · {e.full_name}</option>)}
                </select>
              </label>
              {accountModal.mode === 'create' && <>
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
                  {accountModal.form.employee_id && <option value="own_team">关联员工所在团队</option>}
                  <option value="assigned">指定团队 / 指定员工</option>
                  <option value="all">全部数据</option>
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
                    <div><div className="scope-column-head"><strong>团队</strong><span>已选 {accountModal.form.team_ids.length}</span></div><input className="scope-search" placeholder="搜索团队" value={accountModal.form.scope_team_search} onChange={e=>setAccountModal(x=>({...x,form:{...x.form,scope_team_search:e.target.value}}))}/><div className="check-list">
                      {teams.length === 0 ? <div className="empty-state">暂无团队</div> : teams.filter(t=>String(t.name||'').toLowerCase().includes(accountModal.form.scope_team_search.toLowerCase())).map(t => (
                        <label key={t.id}><input type="checkbox"
                          checked={accountModal.form.team_ids.includes(t.id)}
                          onChange={e => setAccountModal(x => ({...x,form:{...x.form,team_ids:e.target.checked?[...x.form.team_ids,t.id]:x.form.team_ids.filter(id=>id!==t.id)}}))}
                        />{t.name}</label>
                      ))}
                    </div></div>
                    <div><div className="scope-column-head"><strong>指定员工</strong><span>已选 {accountModal.form.employee_ids.length}</span></div><input className="scope-search" placeholder="搜索员工ID或姓名" value={accountModal.form.scope_employee_search} onChange={e=>setAccountModal(x=>({...x,form:{...x.form,scope_employee_search:e.target.value}}))}/><div className="check-list">
                      {employees.length === 0 ? <div className="empty-state">暂无员工</div> : employees.filter(emp=>`${emp.employee_no} ${emp.full_name}`.toLowerCase().includes(accountModal.form.scope_employee_search.toLowerCase())).slice(0,100).map(emp => (
                        <label key={emp.id}><input type="checkbox"
                          checked={accountModal.form.employee_ids.includes(emp.id)}
                          onChange={e => setAccountModal(x => ({...x,form:{...x.form,employee_ids:e.target.checked?[...x.form.employee_ids,emp.id]:x.form.employee_ids.filter(id=>id!==emp.id)}}))}
                        />{emp.employee_no} · {emp.full_name}</label>
                      ))}
                    </div></div>
                  </div>
                </div>
              )}
            </div></div>

            <div className="modal-actions">
              <button className="secondary-action" onClick={() => setAccountModal(null)}>取消</button>
              <button className="primary-action" disabled={accountModal.saving} onClick={saveAccount}>{accountModal.saving?'保存中…':'保存'}</button>
            </div>
          </div>
        </div>
      )}

      {staffModal && (
        <div className="modal-mask" onMouseDown={() => setStaffModal(null)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-head">
              <div><h2>新增员工前端账号</h2><small>员工账号必须关联唯一员工档案，登录后自动读取本人团队、岗位及考试。</small></div>
              <button onClick={() => setStaffModal(null)}>×</button>
            </div>
            {staffModal.error && <div className="page-error" style={{margin:'0 0 12px'}}>{staffModal.error}</div>}
            <div className="form-grid">
              <label className="form-span">搜索并关联在职员工（必选）
                <input placeholder="输入员工ID或姓名；输入后显示匹配结果"
                  value={staffModal.form.employee_search}
                  onChange={e => {
                    const value = e.target.value
                    setStaffModal(x => ({...x, error:'', form:{...x.form, employee_search:value, employee_id:''}}))
                  }} />
                <small>已开账号及离职人员不会出现在结果中，同一员工ID不能重复开户。</small>
              </label>
              {staffModal.form.employee_id ? <div className="linked-employee"><strong>✓ 已确认：{staffModal.form.employee_search}</strong><button type="button" onClick={()=>setStaffModal(x=>({...x,form:{...x.form,employee_id:'',employee_search:''}}))}>重新选择</button></div> : staffModal.form.employee_search.trim() && <div className="employee-search-results">
                {employees.filter(emp => !staff.some(a => a.employee_id === emp.id)).filter(emp => `${emp.employee_no} ${emp.full_name}`.toLowerCase().includes(staffModal.form.employee_search.trim().toLowerCase())).slice(0,8).map(emp => <button type="button" className="employee-search-option" key={emp.id} onClick={()=>setStaffModal(x=>({...x,error:'',form:{...x.form,employee_id:emp.id,employee_search:`${emp.employee_no} · ${emp.full_name}`}}))}><strong>{emp.employee_no}</strong><small>{emp.full_name}</small><span>{emp.teams?.name||'未分团队'} · {emp.positions?.name||'未分岗位'}</span></button>)}
                {employees.filter(emp => !staff.some(a => a.employee_id === emp.id)).filter(emp => `${emp.employee_no} ${emp.full_name}`.toLowerCase().includes(staffModal.form.employee_search.trim().toLowerCase())).length===0 && <div className="empty-state">没有可开户的在职员工；可能已开户、已离职或ID不存在。</div>}
              </div>}
              <label>登录邮箱
                <input type="email" placeholder="例如 name@example.com" value={staffModal.form.email} onChange={e => setStaffModal(x => ({...x,error:'',form:{...x.form,email:e.target.value.toLowerCase()}}))}/>
              </label>
              <label>临时密码
                <input type="password" placeholder="至少10位，含大小写、数字和符号" value={staffModal.form.password} onChange={e => setStaffModal(x => ({...x, form:{...x.form, password:e.target.value}}))}/>
              </label>
            </div>
            <div className="modal-actions">
              <button className="secondary-action" onClick={() => setStaffModal(null)}>取消</button>
              <button className="primary-action" disabled={staffModal.saving} onClick={saveStaffAccount}>{staffModal.saving?'创建中…':'创建账号'}</button>
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
                <thead><tr><th>对应页面 / 功能</th>{permissionColumns.map(col => <th key={col.key}>{col.label}</th>)}</tr></thead>
                <tbody>
                  {groupedPermissions.map(group => (
                    <tr key={group.module} className={group.items.some(x=>x.sensitive) ? 'sensitive-row' : ''}>
                      <td><strong>{group.label}</strong><small style={{display:'block',marginTop:3,color:'#98a4b3'}}>{group.module}</small></td>
                      {permissionColumns.map(col => {
                        const items = group.items.filter(p => col.actions.includes(p.actionKey))
                        return <td key={col.key} className="permission-cell">{items.length ? items.map(permissionToggle) : <span className="permission-empty">—</span>}</td>
                      })}
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
