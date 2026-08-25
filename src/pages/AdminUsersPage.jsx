import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAdminAccess } from '../lib/adminAccess'
import { useAdminI18n } from '../lib/adminI18n'

const USER_TABS = ['backend', 'staff', 'roles']

const blankAccount = () => ({
  auth_user_id: '',
  employee_id: '',
  employee_search: '',
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
  submit: '提交',
  edit: '编辑',
  delete: '删除',
  approve: '审批',
  review: '批注 / 复核',
  grade: '批改',
  export: '导出',
  publish: '发布',
  manage: '管理',
  disable: '停用',
  generate: '生成',
  reset_password: '重置密码',
  otp_toggle: 'OTP开关',
  mfa_reset: '重置OTP',
  resign: '办理离职',
  general: '通用导出',
}

const permissionSectionDefinitions = [
  { key: 'employee', label: '员工管理', description: '员工档案、薪资资料、团队与人员状态' },
  { key: 'attendance', label: '排班与考勤', description: '排班、考勤、请假及离岗审批' },
  { key: 'work', label: '每日工作', description: '工作日报、线上培训与出错奖惩' },
  { key: 'exam', label: '考试管理', description: '考试查看、分配、题库与批改' },
  { key: 'payroll', label: '工资中心', description: '工资资料、规则、审核、发布与导出' },
  { key: 'report', label: '统计报表', description: '经营统计、报表查看与数据导出' },
  { key: 'access', label: '用户与权限', description: '账号安全、角色权限与登录控制' },
  { key: 'system', label: '系统与审计', description: '敏感资料、操作日志及系统功能' },
  { key: 'other', label: '其他功能', description: '尚未归类的系统权限' },
]

const permissionModuleMeta = {
  account: { section: 'access', label: '后台账号', description: '创建、停用、删除账号及登录安全设置' },
  user: { section: 'access', label: '用户与权限', description: '查看账号并管理角色权限' },
  'user.account': { section: 'access', label: '员工登录账号', description: '创建、启停及删除员工前端登录账号' },
  'user.activation': { section: 'access', label: '员工激活码', description: '生成或重置员工前端账号激活码' },
  'user.email': { section: 'access', label: '员工登录邮箱', description: '修改员工前端账号登录邮箱' },
  'user.password': { section: 'access', label: '员工登录密码', description: '重置员工前端账号登录密码' },
  role: { section: 'access', label: '角色管理', description: '创建、编辑及分配系统角色' },
  employee: { section: 'employee', label: '员工档案', description: '员工资料的查看、新增、编辑与离职操作' },
  'employee.compensation': { section: 'employee', label: '员工薪资资料', description: '员工固定薪资及补贴等资料' },
  connectivity: { section: 'employee', label: '停电 / 断网记录', description: '按负责范围查看与录入员工停电、断网记录' },
  team: { section: 'employee', label: '团队管理', description: '团队资料、组织关系及成员归属' },
  schedule: { section: 'attendance', label: '排班管理', description: '排班表与轮班规则' },
  attendance: { section: 'attendance', label: '考勤管理', description: '员工考勤记录的查看与维护' },
  leave: { section: 'attendance', label: '请假与离岗', description: '请假、公休、回家及换班审批' },
  daily_work: { section: 'work', label: '每日工作报告', description: '每日工作记录的提交与管理' },
  online_training: { section: 'work', label: '线上培训报告', description: '培训日报的提交、批注及管理' },
  adjustment: { section: 'work', label: '出错 / 扣款 / 奖金', description: '奖惩记录的录入与审核' },
  exam: { section: 'exam', label: '考试管理', description: '考试、题库、分配及成绩批改' },
  payroll: { section: 'payroll', label: '工资管理', description: '工资批次的查看、编辑、审核与发布' },
  'payroll.rule': { section: 'payroll', label: '工资规则', description: '工资计算规则及阈值配置' },
  'sensitive.payment': { section: 'payroll', label: '敏感收款资料', description: '完整收款资料的查看、修改与审核' },
  'sensitive.payout': { section: 'payroll', label: '敏感收款资料', description: '完整收款资料的查看、修改与审核' },
  report: { section: 'report', label: '统计报表', description: '统计页面与范围内报表数据' },
  export: { section: 'report', label: '数据导出', description: '通用数据导出能力' },
  'sensitive.employee': { section: 'system', label: '员工敏感资料', description: '受保护的员工个人资料' },
  sensitive: { section: 'system', label: '敏感资料', description: '系统内受保护的敏感数据' },
  audit: { section: 'system', label: '操作日志', description: '后台操作与安全审计记录' },
}

const permissionModuleOrder = Object.keys(permissionModuleMeta)
const permissionActionOrder = ['view', 'create', 'generate', 'submit', 'edit', 'review', 'manage', 'approve', 'grade', 'publish', 'export', 'delete', 'disable', 'resign', 'reset_password', 'otp_toggle', 'mfa_reset', 'general']

function getRole(a) {
  return Array.isArray(a?.roles) ? a.roles[0] : a?.roles
}

function scopeLabel(scope) {
  if (scope === 'all') return '全部'
  if (scope === 'assigned_teams') return '指定范围'
  if (scope === 'self') return '仅本人'
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
  const sharedAccess = useAdminAccess()
  const { t: adminT } = useAdminI18n()
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
    if ((!sharedAccess.loading || data) && !tabAllowed(next)) return
    setTabState(next)
    setSearchDraft('')
    setSearchQuery('')
    setSearchParams(next === 'backend' ? {} : { tab: next }, { replace: true })
  }

  const callerFounder = sharedAccess.founder || data?.caller?.is_founder
  const callerPermissions = new Set(data?.caller?.permissions || [])
  const callerCan = code => Boolean(callerFounder || sharedAccess.hasPermission(code) || callerPermissions.has('*') || callerPermissions.has(code))
  const backendPermissionCodes = ['user.view','account.view','account.create','account.edit','account.disable','account.delete','account.reset_password','account.otp_toggle','account.mfa_reset']
  const staffPermissionCodes = ['user.view','user.account.create','user.account.disable','user.account.delete','user.password.reset','account.mfa_reset']
  const tabAllowed = key => key === 'backend'
    ? backendPermissionCodes.some(callerCan)
    : key === 'staff'
      ? staffPermissionCodes.some(callerCan)
      : callerCan('role.manage')
  const visibleTabs = sharedAccess.loading && !data ? [] : USER_TABS.filter(tabAllowed)
  const canCreateBackend = callerCan('account.create')
  const canEditBackend = callerCan('account.edit')
  const canToggleBackend = callerCan('account.disable')
  const canDeleteBackend = callerCan('account.delete')
  const canResetBackendPassword = callerCan('account.reset_password')
  const canToggleOtp = callerCan('account.otp_toggle')
  const canResetMfa = callerCan('account.mfa_reset')
  const canManageScope = callerCan('scope.manage')
  const canCreateStaff = callerCan('user.account.create')
  const canToggleStaff = callerCan('user.account.disable')
  const canDeleteStaff = callerCan('user.account.delete')
  const canResetStaffPassword = callerCan('user.password.reset')
  const backend = data?.backend_accounts || []
  const staff = data?.employee_accounts || []
  const employees = data?.employees || []
  const roles = (data?.roles || []).filter(r => r.active !== false)
  const permissions = data?.permissions || []
  const rolePermissions = data?.role_permissions || []
  const teams = data?.teams || []
  const scopeTeams = data?.scope_teams || []
  const scopeEmployees = data?.scope_employees || []

  useEffect(() => {
    if ((sharedAccess.loading && !data) || tabAllowed(tab)) return
    const fallback = visibleTabs[0]
    if (!fallback) return
    setTabState(fallback)
    setSearchParams(fallback === 'backend' ? {} : { tab: fallback }, { replace: true })
  }, [data, tab, sharedAccess.loading, sharedAccess.permissionKey])

  const editableRoles = roles.filter(r => !['founder', 'employee'].includes(r.code))
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const matchesSearch = (...values) => !normalizedSearch || values.some(value => String(value || '').toLowerCase().includes(normalizedSearch))
  const visibleBackend = backend.filter(a => {
    const role = getRole(a)
    return matchesSearch(a.login_username, a.employee?.employee_no, a.employee?.full_name, role?.name, scopeLabel(a.data_scope))
  })
  const visibleStaff = staff.filter(a => matchesSearch(a.login_email, a.employee?.employee_no, a.employee?.full_name, a.employee?.teams?.name, a.employee?.positions?.name))
  const visibleRoles = roles.filter(r => r.code !== 'employee' && matchesSearch(r.name, r.code))
  const visibleTab = visibleTabs.includes(tab) ? tab : ''

  const rolePermissionMap = useMemo(() => {
    const map = new Map()
    for (const r of rolePermissions) {
      if (!map.has(r.role_id)) map.set(r.role_id, new Set())
      map.get(r.role_id).add(r.permission_id)
    }
    return map
  }, [rolePermissions])

  const groupedPermissionSections = useMemo(() => {
    const sections = new Map(permissionSectionDefinitions.map(section => [section.key, {
      ...section,
      pages: new Map(),
    }]))

    for (const permission of permissions) {
      const shape = permissionShape(permission.code)
      const moduleMeta = permissionModuleMeta[shape.module] || {
        section: 'other',
        label: permission.category || shape.module,
        description: '系统扩展功能',
      }
      const section = sections.get(moduleMeta.section) || sections.get('other')
      if (!section.pages.has(shape.module)) {
        section.pages.set(shape.module, {
          key: shape.module,
          label: moduleMeta.label,
          description: moduleMeta.description,
          items: [],
        })
      }
      section.pages.get(shape.module).items.push({ ...permission, actionKey: shape.action })
    }

    return [...sections.values()]
      .map(section => ({
        ...section,
        pages: [...section.pages.values()]
          .sort((a, b) => {
            const aIndex = permissionModuleOrder.indexOf(a.key)
            const bIndex = permissionModuleOrder.indexOf(b.key)
            return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex)
          })
          .map(page => ({
            ...page,
            items: [...page.items].sort((a, b) => {
              const aIndex = permissionActionOrder.indexOf(a.actionKey)
              const bIndex = permissionActionOrder.indexOf(b.actionKey)
              return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex)
            }),
          })),
      }))
      .filter(section => section.pages.length > 0)
  }, [permissions])

  const visiblePermissionSections = useMemo(() => {
    const query = String(roleModal?.permission_search || '').trim().toLowerCase()
    if (!query) return groupedPermissionSections

    return groupedPermissionSections.map(section => {
      const sectionMatches = `${section.label} ${section.description}`.toLowerCase().includes(query)
      const pages = section.pages.map(page => {
        const pageMatches = `${page.label} ${page.description} ${page.key}`.toLowerCase().includes(query)
        const items = sectionMatches || pageMatches
          ? page.items
          : page.items.filter(permission => `${permission.name || ''} ${permission.code || ''} ${actionLabels[permission.actionKey] || ''}`.toLowerCase().includes(query))
        return { ...page, items }
      }).filter(page => page.items.length > 0)
      return { ...section, pages }
    }).filter(section => section.pages.length > 0)
  }, [groupedPermissionSections, roleModal?.permission_search])

  const openCreate = () => setAccountModal({ mode: 'create', form: blankAccount(), batch: [], error: '', saving: false })
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
        employee_search: a.employee ? `${a.employee.employee_no} · ${a.employee.full_name}` : '',
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

  const validateAccountDraft = (form) => {
    const username = String(form.username || '').trim().toLowerCase()
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return '用户名只允许 3–32 位小写字母、数字、点、下划线或短横线。'
    const password = String(form.password || '')
    if (!(password.length >= 10 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password))) {
      return '临时密码至少 10 位，并包含大小写字母、数字和特殊符号。'
    }
    if (!form.role_id) return '请选择角色。'
    if (['self', 'own_team'].includes(form.data_scope) && !form.employee_id) return '“仅本人”或“关联员工所在团队”必须先关联员工档案。'
    if (form.data_scope === 'assigned_teams' && !(form.team_ids.length || form.employee_ids.length)) return '指定范围至少选择一个团队或一名员工。'
    return ''
  }

  const queueAccount = () => {
    setAccountModal(current => {
      if (!current || current.mode !== 'create') return current
      const form = { ...current.form, username: current.form.username.trim().toLowerCase() }
      const validationError = validateAccountDraft(form)
      if (validationError) return { ...current, error: validationError }
      if (current.batch.some(item => item.username === form.username)) return { ...current, error: '创建清单中已有相同用户名。' }
      if (current.batch.length >= 20) return { ...current, error: '每次最多批量创建 20 个后台账号。' }
      return {
        ...current,
        error: '',
        batch: [...current.batch, form],
        form: {
          ...blankAccount(),
          role_id: form.role_id,
          data_scope: form.data_scope,
          otp_required: form.otp_required,
          team_ids: [...form.team_ids],
          employee_ids: [...form.employee_ids],
        },
      }
    })
  }

  const saveAccount = async () => {
    const { mode, form } = accountModal
    setAccountModal(x => ({ ...x, error: '', saving: true }))
    try {
      if (mode === 'create') {
        const accounts = accountModal.batch.length ? accountModal.batch : [form]
        const validationError = accounts.length === 1 && !accountModal.batch.length ? validateAccountDraft(form) : ''
        if (validationError) throw new Error(validationError)
        const result = await call({ action: 'create_backend_batch', accounts })
        const failed = (result?.results || []).filter(item => !item.ok)
        if (failed.length) {
          setAccountModal(current => current ? ({
            ...current,
            saving: false,
            batch: failed.map(item => ({ ...accounts[item.index], batch_error: item.error })),
            error: `已成功创建 ${result.created_count || 0} 个，${failed.length} 个失败；失败账号已保留在清单中。`,
          }) : current)
          await load()
          return
        }
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
    if (!callerFounder || !newRoleName.trim()) return
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
      permission_search: '',
      collapsed_sections: [],
      error: '',
      saving: false,
    })
  }

  const saveRole = async () => {
    if (!roleModal || !callerFounder) return
    if (!roleModal.name.trim()) {
      setRoleModal(x => ({ ...x, error: '角色名称不能为空。' }))
      return
    }
    setRoleModal(x => ({ ...x, error: '', saving: true }))
    try {
      if (!roleModal.role.system_locked && roleModal.name.trim() !== roleModal.role.name) {
        await call({ action: 'rename_role', role_id: roleModal.role.id, name: roleModal.name.trim() })
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
    } catch (e) {
      setRoleModal(x => x ? ({ ...x, error: e.message, saving: false }) : x)
    }
  }

  const deleteRole = async (role) => {
    if (!callerFounder) return
    if (!window.confirm(`确认删除角色「${role.name}」？`)) return
    try {
      await call({ action: 'delete_role', role_id: role.id })
      await load()
    } catch (e) { setError(e.message) }
  }

  const roleIsLocked = roleModal?.role.code === 'founder'
  const roleReadOnly = !callerFounder || roleIsLocked
  const selectedPermissionIds = new Set(roleModal?.permission_ids || [])
  const accountEmployeeQuery = String(accountModal?.form?.employee_search || '').trim().toLowerCase()
  const accountEmployeeMatches = accountEmployeeQuery
    ? employees.filter(emp => `${emp.employee_no} ${emp.full_name}`.toLowerCase().includes(accountEmployeeQuery)).slice(0, 8)
    : []

  const updatePermissionSelection = (permissionIds, checked) => {
    if (!callerFounder) return
    setRoleModal(current => {
      if (!current || current.role.code === 'founder') return current
      const next = new Set(current.permission_ids)
      permissionIds.forEach(id => checked ? next.add(id) : next.delete(id))
      return { ...current, permission_ids: [...next], error: '' }
    })
  }

  const displayPermissionName = permission => {
    const name = String(permission.name || '').trim()
    if (name.includes('·')) return name.split('·').slice(1).join('·').trim()
    return name || actionLabels[permission.actionKey] || permission.actionKey
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
        .roles-workspace{overflow:hidden;border:1px solid #dce5f0;border-radius:16px;background:#fff;box-shadow:0 8px 24px rgba(29,51,82,.04)}
        .roles-overview{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:22px 24px;border-bottom:1px solid #e5ebf3;background:linear-gradient(135deg,#f8fbff 0%,#f3f7ff 62%,#f8f6ff 100%)}
        .roles-overview-copy span{display:block;margin-bottom:5px;color:#315fc8;font-size:10px;font-weight:900;letter-spacing:.12em}.roles-overview-copy h2{margin:0 0 6px;color:#1f3552;font-size:20px}.roles-overview-copy p{max-width:660px;margin:0;color:#718198;font-size:13px;line-height:1.65}
        .roles-overview-stats{display:flex;gap:10px;flex:0 0 auto}.roles-overview-stats div{min-width:92px;padding:11px 14px;border:1px solid #dce5f1;border-radius:11px;background:rgba(255,255,255,.82)}.roles-overview-stats strong,.roles-overview-stats small{display:block}.roles-overview-stats strong{color:#243d5c;font-size:20px}.roles-overview-stats small{margin-top:3px;color:#8492a5;font-size:10px}
        .roles-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid #e8edf4}.role-search{display:flex;align-items:center;gap:7px;min-width:280px;max-width:520px;flex:1}.role-search input,.create-role-row input{width:100%;height:39px;border:1px solid #d7e0eb;border-radius:9px;background:#fff;padding:0 11px;color:#334b68;outline:none}.role-search input:focus,.create-role-row input:focus{border-color:#4d77dd;box-shadow:0 0 0 3px rgba(77,119,221,.09)}.role-search button,.create-role-row button{height:39px;white-space:nowrap}.create-role-row{display:flex;gap:7px;min-width:330px}.create-role-row input{min-width:180px}
        .role-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:16px;background:#f7f9fc}
        .role-card{display:flex;min-height:208px;flex-direction:column;border:1px solid #dfe7f0;background:#fff;border-radius:13px;padding:16px;box-shadow:0 3px 12px rgba(30,54,85,.035);transition:border-color .18s,box-shadow .18s,transform .18s}.role-card:hover{border-color:#cbd9ec;box-shadow:0 9px 24px rgba(31,55,88,.08);transform:translateY(-1px)}
        .role-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.role-card-title{display:flex;align-items:center;gap:10px;min-width:0}.role-avatar{display:grid;place-items:center;width:38px;height:38px;flex:0 0 auto;border-radius:10px;background:#edf3ff;color:#3465d5;font-size:14px;font-weight:900}.role-card h3{overflow:hidden;margin:0;color:#253b58;font-size:15px;white-space:nowrap;text-overflow:ellipsis}.role-card-title small{display:block;margin-top:4px;color:#8996a8;font-size:10px}.role-lock{display:inline-flex;align-items:center;padding:4px 7px;border-radius:999px;background:#edf8f2;color:#20805a;font-size:9px;font-weight:850}
        .role-permission-summary{margin-top:16px}.role-permission-summary>div:first-child{display:flex;align-items:center;justify-content:space-between;color:#697b92;font-size:10px}.role-permission-summary strong{color:#315fc8;font-size:11px}.role-progress{height:6px;margin:7px 0 10px;overflow:hidden;border-radius:999px;background:#edf1f6}.role-progress i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#3971df,#765ce1)}.role-module-tags{display:flex;min-height:24px;gap:5px;flex-wrap:wrap}.role-module-tags span{padding:4px 7px;border-radius:6px;background:#f2f5f9;color:#60728a;font-size:9px}.role-module-tags span.more{background:#edf2ff;color:#3f67c5}.role-module-tags small{padding-top:4px;color:#9aa6b5;font-size:9px}
        .role-card-actions{display:flex;gap:7px;margin-top:auto;padding-top:14px}.role-card-actions button{height:34px;border:1px solid #d5dfeb;background:#fff;border-radius:8px;padding:0 11px;color:#486078;font-size:11px;font-weight:800;cursor:pointer}.role-card-actions button.primary{border-color:#d3dfff;background:#f1f5ff;color:#2d61d3}.role-card-actions button.danger{margin-left:auto;color:#b85050}
        .access-searchbar{display:grid;grid-template-columns:minmax(300px,1fr) auto auto auto;align-items:center;gap:9px;margin-bottom:14px;padding:12px;background:#fff;border:1px solid #dfe7f0;border-radius:12px}.access-searchbar input{height:40px;width:100%;border:1px solid #d6e0eb;border-radius:9px;padding:0 12px}.access-searchbar .secondary-action,.access-searchbar .primary-action{height:40px;white-space:nowrap}
        .account-modal{width:min(760px,94vw);max-height:min(760px,88vh);display:flex;flex-direction:column;overflow:hidden}.account-modal .modal-head{flex:0 0 auto}.account-modal .account-modal-body{overflow:auto;padding:2px 3px 8px}.account-modal .modal-actions{flex:0 0 auto;position:sticky;bottom:0;background:#fff;border-top:1px solid #edf1f5;padding-top:12px;margin-top:6px;z-index:2}
        .scope-panel{grid-column:1/-1;border:1px solid #e3e9f1;border-radius:11px;padding:12px;background:#fafbfd}
        .scope-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.scope-column-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}.scope-column-head span{font-size:10px;color:#5873a1}.scope-search{width:100%;height:36px!important;margin-bottom:7px}.check-list{max-height:180px;overflow:auto;border:1px solid #e2e8f0;border-radius:9px;background:#fff;padding:8px}
        .check-list label{display:flex;gap:8px;align-items:center;padding:7px 5px;font-size:12px;color:#46566d}
        .permissions-modal-mask{padding:clamp(10px,2vw,24px)}.role-modal{display:flex;width:min(1180px,calc(100vw - 36px));height:min(860px,calc(100dvh - 36px));max-height:none;flex-direction:column;overflow:hidden;padding:0;border-radius:18px;background:#f5f7fa}.role-modal .role-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex:0 0 auto;margin:0;padding:17px 20px;border-bottom:1px solid #dfe6ef;background:#fff}.role-modal-heading{display:flex;align-items:center;gap:11px}.role-modal-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:#eaf1ff;color:#3265da;font-weight:900}.role-modal-head h2{margin:0 0 4px;color:#203754;font-size:19px}.role-modal-head p{margin:0;color:#7c8ba0;font-size:12px}.role-modal-head>button{width:34px;height:34px;flex:0 0 auto;border:0;border-radius:9px;background:#f0f3f7;color:#748297;font-size:21px;cursor:pointer}.role-modal-head>button:hover{background:#e9edf3;color:#344b67}
        .role-modal-body{min-height:0;overflow:auto;padding:16px 18px 24px;overscroll-behavior:contain;scrollbar-gutter:stable}.role-modal .page-error{margin-bottom:12px}.role-identity-panel{display:grid;grid-template-columns:minmax(260px,1fr) auto;align-items:end;gap:18px;margin-bottom:12px;padding:14px 15px;border:1px solid #dfe6ef;border-radius:12px;background:#fff}.role-name-field{display:flex;flex-direction:column;gap:6px;color:#5e718a;font-size:11px;font-weight:850}.role-name-field input{width:100%;height:39px;border:1px solid #d3deea;border-radius:9px;padding:0 11px;color:#2e4561;outline:none}.role-name-field input:focus{border-color:#4b76dc;box-shadow:0 0 0 3px rgba(75,118,220,.09)}.role-name-field input:disabled{background:#f3f5f8;color:#728196}.role-selection-summary{display:flex;gap:8px}.role-selection-summary div{min-width:108px;padding:9px 11px;border-radius:9px;background:#f4f7fb}.role-selection-summary strong,.role-selection-summary small{display:block}.role-selection-summary strong{color:#2d5fce;font-size:17px}.role-selection-summary small{margin-top:2px;color:#8391a4;font-size:10px}
        .permission-guidance{display:flex;align-items:flex-start;gap:8px;margin:-2px 0 12px;padding:10px 12px;border:1px solid #d9e4f5;border-radius:10px;background:#f4f8ff;color:#58708f;font-size:11px;line-height:1.55}.permission-guidance strong{flex:0 0 auto;color:#3564c8}.permission-toolbar{position:sticky;top:-16px;z-index:4;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;padding:11px 12px;border:1px solid #dce5ef;border-radius:11px;background:rgba(255,255,255,.96);box-shadow:0 5px 16px rgba(31,51,79,.05);backdrop-filter:blur(8px)}.permission-search{display:flex;align-items:center;min-width:260px;max-width:520px;flex:1;height:39px;border:1px solid #d3deea;border-radius:9px;background:#fff;padding:0 10px}.permission-search span{margin-right:7px;color:#91a0b3}.permission-search input{min-width:0;flex:1;height:35px;border:0;background:transparent;color:#344b67;outline:none}.permission-toolbar-actions{display:flex;gap:7px}.permission-toolbar-actions button{height:35px;border:1px solid #d3deea;border-radius:8px;background:#fff;padding:0 10px;color:#51677f;font-size:11px;font-weight:800;cursor:pointer}.permission-toolbar-actions button:hover{border-color:#b9cae2;background:#f7f9fc}.permission-toolbar-actions button:disabled{opacity:.5;cursor:not-allowed}.founder-permission-note{display:flex;align-items:flex-start;gap:9px;margin-bottom:12px;padding:11px 13px;border:1px solid #cce7d9;border-radius:10px;background:#f1fbf6;color:#34775b;font-size:11px;line-height:1.55}.founder-permission-note strong{flex:0 0 auto}
        .permission-sections{display:flex;flex-direction:column;gap:11px}.permission-section{overflow:hidden;border:1px solid #dce4ee;border-radius:13px;background:#fff}.permission-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 14px;border-bottom:1px solid #e7ecf3;background:#f9fbfd}.permission-section-head-main{display:flex;align-items:center;gap:10px;min-width:0}.permission-section-head-main>input,.permission-page-title>input,.permission-option>input{width:17px;height:17px;flex:0 0 auto;margin:0;accent-color:#3568da;cursor:pointer}.permission-section-head-main>input:disabled,.permission-page-title>input:disabled,.permission-option>input:disabled{cursor:not-allowed}.permission-section-head h3{margin:0;color:#263e5b;font-size:14px}.permission-section-head p{margin:3px 0 0;color:#8290a3;font-size:10px}.permission-section-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}.permission-count{padding:4px 7px;border-radius:999px;background:#edf3ff;color:#3d65c3;font-size:10px;font-weight:850}.permission-section-actions button{width:29px;height:29px;border:0;border-radius:7px;background:#eef2f6;color:#667991;cursor:pointer}.permission-section.collapsed .permission-section-head{border-bottom:0}
        .permission-page-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:11px}.permission-page{overflow:hidden;border:1px solid #e1e7ef;border-radius:11px;background:#fbfcfe}.permission-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:11px 12px;border-bottom:1px solid #e8edf3;background:#fff}.permission-page-title{display:flex;align-items:flex-start;gap:9px;min-width:0}.permission-page-title>input{margin-top:2px}.permission-page-title strong,.permission-page-title small{display:block}.permission-page-title strong{color:#334b67;font-size:12px}.permission-page-title small{margin-top:3px;color:#8996a7;font-size:10px;line-height:1.45}.permission-page-head>span{flex:0 0 auto;color:#7c8ca0;font-size:10px}.permission-options{display:grid;grid-template-columns:1fr;gap:6px;padding:9px}.permission-option{display:flex;align-items:flex-start;gap:9px;min-width:0;padding:9px 10px;border:1px solid #e4e9f0;border-radius:8px;background:#fff;cursor:pointer;transition:border-color .15s,background .15s}.permission-option:hover{border-color:#c8d6e9;background:#f9fbff}.permission-option.selected{border-color:#bfd0f4;background:#f2f6ff}.permission-option.locked{cursor:default}.permission-option>input{margin-top:2px}.permission-option-copy{min-width:0;flex:1}.permission-option-copy strong,.permission-option-copy small{display:block}.permission-option-copy strong{color:#3c5069;font-size:12px;line-height:1.4}.permission-option-copy small{overflow:hidden;margin-top:3px;color:#96a1b0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;white-space:nowrap;text-overflow:ellipsis}.sensitive-badge{flex:0 0 auto;padding:3px 5px;border-radius:5px;background:#fff0db;color:#a76520;font-size:9px;font-style:normal;font-weight:850}.permission-empty-state{padding:35px 18px;border:1px dashed #ccd7e5;border-radius:12px;background:#fff;color:#7d8da2;text-align:center}.permission-empty-state strong,.permission-empty-state span{display:block}.permission-empty-state strong{margin-bottom:5px;color:#465d78;font-size:13px}.permission-empty-state span{font-size:11px}
        .role-modal>.modal-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:0 0 auto;margin:0;padding:12px 18px;border-top:1px solid #dde5ef;background:#fff}.role-modal-actions-note{color:#8291a4;font-size:11px}.role-modal-actions-buttons{display:flex;gap:8px}.role-modal>.modal-actions button{height:39px}.role-modal>.modal-actions button:disabled{opacity:.55;cursor:not-allowed}
        .employee-search-results{grid-column:1/-1;max-height:235px;overflow:auto;border:1px solid #dce5ef;border-radius:10px;background:#fff;padding:5px}.employee-search-option{width:100%;display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center;border:0;border-bottom:1px solid #edf1f5;background:#fff;padding:10px;text-align:left;cursor:pointer}.employee-search-option:hover{background:#f3f7ff}.employee-search-option:last-child{border-bottom:0}.employee-search-option strong{color:#24415f}.employee-search-option small{color:#738198}.employee-search-option span{font-size:11px;color:#376ac5}.linked-employee{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid #bfe6d0;background:#f0fbf5;border-radius:9px;color:#18784a;font-size:12px}.linked-employee button{border:0;background:transparent;color:#b34b4b;cursor:pointer}
        .account-batch-builder{margin:13px 0 3px;padding:12px;border:1px solid #dce5f0;border-radius:12px;background:#f7f9fc}.account-batch-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}.account-batch-toolbar strong,.account-batch-toolbar small{display:block}.account-batch-toolbar strong{color:#29425f;font-size:13px}.account-batch-toolbar small{margin-top:3px;color:#7f8da0;font-size:10px}.account-batch-toolbar button{height:36px;white-space:nowrap}.account-batch-empty{margin-top:10px;padding:12px;border:1px dashed #d5dfeb;border-radius:9px;background:#fff;color:#8a97a9;font-size:11px;text-align:center}.account-batch-list{display:flex;max-height:210px;flex-direction:column;gap:6px;margin-top:10px;overflow:auto}.account-batch-row{display:grid;grid-template-columns:25px minmax(0,1fr) auto;align-items:center;gap:9px;padding:9px 10px;border:1px solid #e0e7f0;border-radius:9px;background:#fff}.account-batch-row>span{display:grid;width:23px;height:23px;place-items:center;border-radius:7px;background:#edf3ff;color:#3567d1;font-size:10px;font-weight:900}.account-batch-row strong,.account-batch-row small,.account-batch-row em{display:block}.account-batch-row strong{color:#2e4561;font-size:12px}.account-batch-row small{overflow:hidden;margin-top:3px;color:#7e8b9d;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.account-batch-row em{margin-top:3px;color:#bd4343;font-size:10px;font-style:normal}.account-batch-row>button{border:0;background:transparent;color:#b64a4a;font-size:10px;cursor:pointer}.account-batch-row.failed{border-color:#efc4c4;background:#fff8f8}
        @media(max-width:1100px){.role-list{grid-template-columns:repeat(2,minmax(0,1fr))}.roles-toolbar{align-items:stretch;flex-direction:column}.role-search{max-width:none}.create-role-row{min-width:0}.permission-page-grid{grid-template-columns:1fr}}
        @media(max-width:700px){.roles-overview{align-items:flex-start;flex-direction:column}.roles-overview-stats{width:100%}.roles-overview-stats div{min-width:0;flex:1}.role-list{grid-template-columns:1fr}.role-search,.create-role-row{min-width:0;width:100%}.create-role-row{flex-direction:column}.permissions-modal-mask{padding:6px}.role-modal{width:calc(100vw - 12px);height:calc(100dvh - 12px);border-radius:13px}.role-identity-panel{grid-template-columns:1fr}.role-selection-summary div{flex:1}.permission-toolbar{align-items:stretch;flex-direction:column}.permission-search{min-width:0;width:100%}.permission-toolbar-actions{display:grid;grid-template-columns:1fr 1fr}.role-modal>.modal-actions{align-items:stretch;flex-direction:column}.role-modal-actions-buttons{display:grid;grid-template-columns:1fr 1fr}.scope-columns{grid-template-columns:1fr}.access-searchbar{grid-template-columns:1fr 1fr}.access-searchbar input{grid-column:1/-1}.employee-search-option{grid-template-columns:95px 1fr}.account-batch-toolbar{align-items:stretch;flex-direction:column}.account-batch-row{grid-template-columns:23px minmax(0,1fr) auto}}
      `}</style>

      <div className="page-toolbar">
        <h1>{adminT('用户与权限')}</h1>
      </div>

      <div className="access-tabs">
        {visibleTabs.includes('backend') && <button className={visibleTab === 'backend' ? 'active' : ''} onClick={() => setTab('backend')}>{adminT('后台账号')}</button>}
        {visibleTabs.includes('staff') && <button className={visibleTab === 'staff' ? 'active' : ''} onClick={() => setTab('staff')}>{adminT('员工账号')}</button>}
        {visibleTabs.includes('roles') && <button className={visibleTab === 'roles' ? 'active' : ''} onClick={() => setTab('roles')}>{adminT('角色与权限')}</button>}
      </div>

      {error && <div className="page-error">{error}</div>}

      {visibleTab && visibleTab !== 'roles' && <div className="access-searchbar">
        <input value={searchDraft} onChange={e => setSearchDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && setSearchQuery(searchDraft)}
          placeholder={adminT(visibleTab === 'backend' ? '搜索用户名、员工ID、姓名、角色或管理范围' : '搜索用户名、员工ID、姓名、团队或岗位')} />
        <button className="primary-action" onClick={() => setSearchQuery(searchDraft)}>{adminT('查询')}</button>
        <button className="secondary-action" onClick={() => { setSearchDraft(''); setSearchQuery('') }}>{adminT('重置')}</button>
        {((visibleTab === 'backend' && canCreateBackend) || (visibleTab === 'staff' && canCreateStaff)) && <button className="primary-action" onClick={visibleTab === 'backend' ? openCreate : openCreateStaff}>
          {adminT(visibleTab === 'backend' ? '＋ 新增后台账号' : '＋ 新增员工账号')}
        </button>}
      </div>}

      {loading ? <div className="data-card"><div className="empty-state">{adminT('读取中...')}</div></div> : (
        <>
          {visibleTab === 'backend' && (
            <div className="data-card table-scroll">
              <table className="data-table">
                <thead><tr><th>{adminT('用户名')}</th><th>{adminT('关联员工ID')}</th><th>{adminT('姓名')}</th><th>{adminT('角色')}</th><th>{adminT('范围')}</th><th>OTP</th><th>{adminT('状态')}</th><th>{adminT('操作')}</th></tr></thead>
                <tbody>
                  {visibleBackend.map(a => {
                    const role = getRole(a)
                    const founder = role?.code === 'founder'
                    return <tr key={a.auth_user_id}>
                      <td><strong>{a.login_username || '-'}</strong></td>
                      <td><strong>{a.employee?.employee_no || adminT('未关联')}</strong></td>
                      <td>{a.employee?.full_name || '-'}</td>
                      <td>{role?.name || '-'}</td>
                      <td>{adminT(scopeLabel(a.data_scope))}</td>
                      <td>
                        {canToggleOtp
                          ? <button className={`switch-button ${a.otp_required ? 'on' : ''}`} onClick={() => toggleOtp(a)}><i/><span>{a.otp_required ? '开' : '关'}</span></button>
                          : <span className={`status-chip ${a.otp_required ? '' : 'off'}`}>{adminT(a.otp_required ? '开启' : '关闭')}</span>}
                      </td>
                      <td><span className={`status-chip ${a.active ? '' : 'off'}`}>{adminT(a.active ? '正常' : '停用')}</span></td>
                      <td><div className="access-grid-actions">
                        {!founder && canEditBackend && <button onClick={() => openEdit(a)}>{adminT('编辑')}</button>}
                        {canResetBackendPassword && <button onClick={() => resetPassword(a)}>{adminT('重置密码')}</button>}
                        {canResetMfa && <button onClick={() => resetMfa(a)}>{adminT('重置OTP')}</button>}
                        {!founder && canToggleBackend && <button onClick={() => toggleActive(a)}>{adminT(a.active ? '停用' : '启用')}</button>}
                        {!founder && canDeleteBackend && <button className="danger" onClick={() => deleteAccount(a)}>{adminT('删除账号')}</button>}
                      </div></td>
                    </tr>
                  })}
                </tbody>
              </table>
            </div>
          )}

          {visibleTab === 'staff' && (
            <div className="data-card table-scroll">
              {staff.length === 0 ? <div className="empty-state">{adminT('暂无员工账号')}</div> :
              <table className="data-table">
                <thead><tr><th>{adminT('登录邮箱')}</th><th>{adminT('员工ID')}</th><th>{adminT('姓名')}</th><th>{adminT('团队')}</th><th>{adminT('岗位')}</th><th>{adminT('状态')}</th><th>{adminT('操作')}</th></tr></thead>
                <tbody>{visibleStaff.map(a => <tr key={a.auth_user_id}>
                  <td><strong>{a.login_email || '-'}</strong></td>
                  <td><strong>{a.employee?.employee_no || '-'}</strong></td>
                  <td>{a.employee?.full_name || '-'}</td>
                  <td>{a.employee?.teams?.name || '-'}</td>
                  <td>{a.employee?.positions?.name || '-'}</td>
                  <td><span className={`status-chip ${a.active ? '' : 'off'}`}>{adminT(a.active ? '正常' : '停用')}</span></td>
                  <td><div className="access-grid-actions">
                    {canResetStaffPassword && <button onClick={() => resetPassword(a)}>{adminT('重置密码')}</button>}
                    {canResetMfa && <button onClick={() => resetMfa(a)}>{adminT('重置OTP')}</button>}
                    {canToggleStaff && <button onClick={() => toggleActive(a)}>{adminT(a.active ? '停用' : '启用')}</button>}
                    {canDeleteStaff && <button className="danger" onClick={() => deleteAccount(a)}>{adminT('删除登录账号')}</button>}
                  </div></td>
                </tr>)}</tbody>
              </table>}
            </div>
          )}

          {visibleTab === 'roles' && (
            <div className="roles-workspace">
              <div className="roles-overview">
                <div className="roles-overview-copy">
                  <span>ACCESS CONTROL</span>
                  <h2>{adminT('按模块、页面和具体操作配置权限')}</h2>
                </div>
                <div className="roles-overview-stats">
                  <div><strong>{visibleRoles.length}</strong><small>{adminT('当前角色')}</small></div>
                  <div><strong>{permissions.length}</strong><small>{adminT('权限项目')}</small></div>
                  <div><strong>{permissions.filter(permission => permission.sensitive).length}</strong><small>{adminT('敏感权限')}</small></div>
                </div>
              </div>

              <div className="roles-toolbar">
                <div className="role-search">
                  <input value={searchDraft} onChange={e => setSearchDraft(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && setSearchQuery(searchDraft)}
                    placeholder={adminT('搜索角色名称或角色代码')} />
                  <button className="primary-action" onClick={() => setSearchQuery(searchDraft)}>{adminT('查询')}</button>
                  {(searchDraft || searchQuery) && <button className="secondary-action" onClick={() => { setSearchDraft(''); setSearchQuery('') }}>{adminT('清除')}</button>}
                </div>
                {callerFounder && <div className="create-role-row">
                  <input placeholder={adminT('输入新角色名称')} value={newRoleName} onChange={e => setNewRoleName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && createRole()} />
                  <button className="primary-action" onClick={createRole}>{adminT('＋ 新增角色')}</button>
                </div>}
              </div>

              <div className="role-list">
                {visibleRoles.map(role => {
                  const grantedIds = role.code === 'founder'
                    ? new Set(permissions.map(permission => permission.id))
                    : rolePermissionMap.get(role.id) || new Set()
                  const grantedCount = grantedIds.size
                  const sectionLabels = groupedPermissionSections
                    .filter(section => section.pages.some(page => page.items.some(permission => grantedIds.has(permission.id))))
                    .map(section => adminT(section.label))
                  const progress = permissions.length ? Math.round((grantedCount / permissions.length) * 100) : 0

                  return <div className="role-card" key={role.id}>
                    <div className="role-card-head">
                      <div className="role-card-title">
                        <span className="role-avatar">{String(role.name || '角').trim().slice(0, 1).toUpperCase()}</span>
                        <div><h3>{role.name}</h3><small>{role.code} · {adminT(role.system_locked ? '系统角色' : '自定义角色')}</small></div>
                      </div>
                      {role.system_locked && <span className="role-lock">{adminT('锁定')}</span>}
                    </div>
                    <div className="role-permission-summary">
                      <div><span>{adminT('已授权项目')}</span><strong>{grantedCount} / {permissions.length}</strong></div>
                      <div className="role-progress"><i style={{width:`${progress}%`}} /></div>
                      <div className="role-module-tags">
                        {sectionLabels.slice(0, 3).map(label => <span key={label}>{label}</span>)}
                        {sectionLabels.length > 3 && <span className="more">+{sectionLabels.length - 3} {adminT('个模块', 'modules')}</span>}
                        {sectionLabels.length === 0 && <small>{adminT('尚未配置任何页面权限')}</small>}
                      </div>
                    </div>
                    <div className="role-card-actions">
                      <button className="primary" onClick={() => openRole(role)}>{adminT(role.code === 'founder' ? '查看固定权限' : callerFounder ? '配置权限' : '查看权限')}</button>
                      {callerFounder&&!role.system_locked && <button className="danger" onClick={() => deleteRole(role)}>{adminT('删除角色')}</button>}
                    </div>
                  </div>
                })}
                {visibleRoles.length === 0 && <div className="permission-empty-state" style={{gridColumn:'1 / -1'}}><strong>{adminT('没有匹配的角色')}</strong><span>{adminT('请调整搜索内容后再试。')}</span></div>}
              </div>
            </div>
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
              <label className="form-span">搜索并关联员工档案（可选）
                <input
                  disabled={accountModal.mode === 'edit' && !canManageScope}
                  placeholder="输入员工 ID 或姓名搜索；也可不关联"
                  value={accountModal.form.employee_search}
                  onChange={e => {
                    const value = e.target.value
                    setAccountModal(x => ({...x, error:'', form:{
                      ...x.form,
                      employee_search:value,
                      employee_id:'',
                      data_scope:!value && ['own_team','self'].includes(x.form.data_scope) ? 'all' : x.form.data_scope,
                    }}))
                  }}
                />
              </label>
              {accountModal.form.employee_id ? <div className="linked-employee"><strong>✓ 已关联：{accountModal.form.employee_search}</strong>{(accountModal.mode !== 'edit' || canManageScope) && <button type="button" onClick={()=>setAccountModal(x=>({...x,error:'',form:{...x.form,employee_id:'',employee_search:'',data_scope:['own_team','self'].includes(x.form.data_scope)?'all':x.form.data_scope}}))}>重新选择</button>}</div> : accountEmployeeQuery && <div className="employee-search-results">
                {accountEmployeeMatches.map(emp => <button type="button" className="employee-search-option" key={emp.id} onClick={()=>setAccountModal(x=>({...x,error:'',form:{...x.form,employee_id:emp.id,employee_search:`${emp.employee_no} · ${emp.full_name}`}}))}><strong>{emp.employee_no}</strong><small>{emp.full_name}</small><span>{emp.teams?.name||'未分团队'} · {emp.positions?.name||'未分岗位'}</span></button>)}
                {accountEmployeeMatches.length===0 && <div className="empty-state">没有匹配的员工档案，请检查员工 ID 或姓名。</div>}
              </div>}
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
                <select disabled={accountModal.mode === 'edit' && !canManageScope} value={accountModal.form.data_scope} onChange={e => setAccountModal(x => ({...x, form:{...x.form, data_scope:e.target.value}}))}>
                  {accountModal.form.employee_id && <option value="self">仅关联员工本人</option>}
                  {accountModal.form.employee_id && <option value="own_team">关联员工所在团队</option>}
                  <option value="assigned_teams">指定团队 / 指定员工</option>
                  <option value="all">全部数据</option>
                </select>
                {accountModal.mode === 'edit' && !canManageScope && <small>当前账号没有“管理账号数据范围”权限。</small>}
              </label>

              {accountModal.mode === 'create' && <label>登录 OTP
                <select value={accountModal.form.otp_required ? '1':'0'} onChange={e => setAccountModal(x => ({...x, form:{...x.form, otp_required:e.target.value==='1'}}))}>
                  <option value="0">关闭</option>
                  <option value="1">开启</option>
                </select>
              </label>}

              {accountModal.form.data_scope === 'assigned_teams' && (
                <div className="scope-panel">
                  <div className="scope-columns">
                    <div><div className="scope-column-head"><strong>团队</strong><span>已选 {accountModal.form.team_ids.length}</span></div><input className="scope-search" disabled={accountModal.mode === 'edit' && !canManageScope} placeholder="搜索团队" value={accountModal.form.scope_team_search} onChange={e=>setAccountModal(x=>({...x,form:{...x.form,scope_team_search:e.target.value}}))}/><div className="check-list">
                      {teams.length === 0 ? <div className="empty-state">暂无团队</div> : teams.filter(t=>String(t.name||'').toLowerCase().includes(accountModal.form.scope_team_search.toLowerCase())).map(t => (
                        <label key={t.id}><input type="checkbox"
                          disabled={accountModal.mode === 'edit' && !canManageScope}
                          checked={accountModal.form.team_ids.includes(t.id)}
                          onChange={e => setAccountModal(x => ({...x,form:{...x.form,team_ids:e.target.checked?[...x.form.team_ids,t.id]:x.form.team_ids.filter(id=>id!==t.id)}}))}
                        />{t.name}</label>
                      ))}
                    </div></div>
                    <div><div className="scope-column-head"><strong>指定员工</strong><span>已选 {accountModal.form.employee_ids.length}</span></div><input className="scope-search" disabled={accountModal.mode === 'edit' && !canManageScope} placeholder="搜索员工ID或姓名" value={accountModal.form.scope_employee_search} onChange={e=>setAccountModal(x=>({...x,form:{...x.form,scope_employee_search:e.target.value}}))}/><div className="check-list">
                      {employees.length === 0 ? <div className="empty-state">暂无员工</div> : employees.filter(emp=>`${emp.employee_no} ${emp.full_name}`.toLowerCase().includes(accountModal.form.scope_employee_search.toLowerCase())).slice(0,100).map(emp => (
                        <label key={emp.id}><input type="checkbox"
                          disabled={accountModal.mode === 'edit' && !canManageScope}
                          checked={accountModal.form.employee_ids.includes(emp.id)}
                          onChange={e => setAccountModal(x => ({...x,form:{...x.form,employee_ids:e.target.checked?[...x.form.employee_ids,emp.id]:x.form.employee_ids.filter(id=>id!==emp.id)}}))}
                        />{emp.employee_no} · {emp.full_name}</label>
                      ))}
                    </div></div>
                  </div>
                </div>
              )}
            </div>

              {accountModal.mode === 'create' && <div className="account-batch-builder">
                <div className="account-batch-toolbar">
                  <div><strong>批量创建清单</strong><small>逐个填写上方资料并加入清单，一次最多创建 20 个账号。</small></div>
                  <button type="button" className="secondary-action" onClick={queueAccount}>＋ 加入清单</button>
                </div>
                {accountModal.batch.length > 0 ? <div className="account-batch-list">
                  {accountModal.batch.map((item, index) => {
                    const employee = employees.find(emp => emp.id === item.employee_id)
                    const role = editableRoles.find(roleItem => roleItem.id === item.role_id)
                    return <div className={`account-batch-row${item.batch_error ? ' failed' : ''}`} key={`${item.username}-${index}`}>
                      <span>{index + 1}</span>
                      <div><strong>{item.username}</strong><small>{employee ? `${employee.employee_no} · ${employee.full_name}` : '未关联员工'} · {role?.name || '未选角色'} · {scopeLabel(item.data_scope)}</small>{item.batch_error && <em>{item.batch_error}</em>}</div>
                      <button type="button" onClick={()=>setAccountModal(x=>({...x,error:'',batch:x.batch.filter((_,rowIndex)=>rowIndex!==index)}))}>移除</button>
                    </div>
                  })}
                </div> : <div className="account-batch-empty">尚未加入清单；也可以直接点击下方“创建当前账号”创建一名账号。</div>}
              </div>}
            </div>

            <div className="modal-actions">
              <button className="secondary-action" onClick={() => setAccountModal(null)}>取消</button>
              <button className="primary-action" disabled={accountModal.saving} onClick={saveAccount}>{accountModal.saving?'处理中…':accountModal.mode === 'create' ? (accountModal.batch.length ? `创建 ${accountModal.batch.length} 个账号` : '创建当前账号') : '保存'}</button>
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
        <div className="modal-mask permissions-modal-mask" onMouseDown={() => !roleModal.saving && setRoleModal(null)}>
          <div className="modal-card role-modal" role="dialog" aria-modal="true" aria-labelledby="role-permission-title" onMouseDown={e => e.stopPropagation()}>
            <div className="role-modal-head">
              <div className="role-modal-heading">
                <span className="role-modal-icon">权</span>
                <div>
                  <h2 id="role-permission-title">{adminT(roleReadOnly?'查看':'配置')}「{roleModal.role.name}」{adminT('的权限')}</h2>
                  <p>{adminT(roleReadOnly?'当前账号仅可查看角色权限，修改操作仅限 Founder。':'按业务模块与对应页面逐项授权；带“敏感”标记的权限请谨慎开放。')}</p>
                </div>
              </div>
              <button aria-label="关闭" disabled={roleModal.saving} onClick={() => setRoleModal(null)}>×</button>
            </div>

            <div className="role-modal-body">
              {roleModal.error && <div className="page-error">{roleModal.error}</div>}

              <div className="role-identity-panel">
                <label className="role-name-field"><span>{adminT('角色名称')}</span>
                  <input disabled={roleReadOnly||roleModal.role.system_locked} value={roleModal.name}
                    onChange={e => setRoleModal(x => ({...x, name:e.target.value, error:''}))}/>
                </label>
                <div className="role-selection-summary">
                  <div><strong>{roleIsLocked ? permissions.length : permissions.filter(permission => selectedPermissionIds.has(permission.id)).length}</strong><small>{adminT('已选权限')}</small></div>
                  <div><strong>{groupedPermissionSections.filter(section => section.pages.some(page => page.items.some(permission => roleIsLocked || selectedPermissionIds.has(permission.id)))).length}</strong><small>{adminT('已开模块')}</small></div>
                </div>
              </div>

              <div className="permission-toolbar">
                <label className="permission-search"><span>⌕</span>
                  <input value={roleModal.permission_search} placeholder={adminT('搜索模块、页面、功能或权限代码')}
                    onChange={e => setRoleModal(x => ({...x, permission_search:e.target.value}))} />
                </label>
                <div className="permission-toolbar-actions">
                  {roleModal.permission_search && <button onClick={() => setRoleModal(x => ({...x, permission_search:''}))}>{adminT('清除搜索')}</button>}
                  <button disabled={roleReadOnly} onClick={() => updatePermissionSelection(permissions.map(permission => permission.id), true)}>{adminT('全部勾选')}</button>
                  <button disabled={roleReadOnly} onClick={() => updatePermissionSelection(permissions.map(permission => permission.id), false)}>{adminT('全部取消')}</button>
                  <button disabled={roleModal.collapsed_sections.length === 0} onClick={() => setRoleModal(x => ({...x, collapsed_sections:[]}))}>{adminT('全部展开')}</button>
                </div>
              </div>

              {roleIsLocked && <div className="founder-permission-note"><strong>{adminT('Founder 固定权限')}</strong><span>{adminT('创办人角色始终拥有全部页面及操作权限，系统已锁定，不能取消勾选。')}</span></div>}

              {visiblePermissionSections.length > 0 ? <div className="permission-sections">
                {visiblePermissionSections.map(section => {
                  const sourceSection = groupedPermissionSections.find(item => item.key === section.key) || section
                  const sectionPermissionIds = sourceSection.pages.flatMap(page => page.items.map(permission => permission.id))
                  const sectionSelectedCount = roleIsLocked
                    ? sectionPermissionIds.length
                    : sectionPermissionIds.filter(id => selectedPermissionIds.has(id)).length
                  const sectionCollapsed = !roleModal.permission_search && roleModal.collapsed_sections.includes(section.key)

                  return <section className={`permission-section ${sectionCollapsed ? 'collapsed' : ''}`} key={section.key}>
                    <div className="permission-section-head">
                      <label className="permission-section-head-main">
                        <input type="checkbox" disabled={roleReadOnly}
                          ref={node => { if (node) node.indeterminate = sectionSelectedCount > 0 && sectionSelectedCount < sectionPermissionIds.length }}
                          checked={sectionSelectedCount === sectionPermissionIds.length && sectionPermissionIds.length > 0}
                          onChange={e => updatePermissionSelection(sectionPermissionIds, e.target.checked)} />
                        <div><h3>{adminT(section.label)}</h3><p>{adminT(section.description)}</p></div>
                      </label>
                      <div className="permission-section-actions">
                        <span className="permission-count">{sectionSelectedCount} / {sectionPermissionIds.length}</span>
                        {!roleModal.permission_search && <button aria-label={sectionCollapsed ? `展开${section.label}` : `收起${section.label}`} aria-expanded={!sectionCollapsed}
                          onClick={() => setRoleModal(current => ({
                            ...current,
                            collapsed_sections: sectionCollapsed
                              ? current.collapsed_sections.filter(key => key !== section.key)
                              : [...current.collapsed_sections, section.key],
                          }))}>{sectionCollapsed ? '⌄' : '⌃'}</button>}
                      </div>
                    </div>

                    {!sectionCollapsed && <div className="permission-page-grid">
                      {section.pages.map(page => {
                        const sourcePage = sourceSection.pages.find(item => item.key === page.key) || page
                        const pagePermissionIds = sourcePage.items.map(permission => permission.id)
                        const pageSelectedCount = roleIsLocked
                          ? pagePermissionIds.length
                          : pagePermissionIds.filter(id => selectedPermissionIds.has(id)).length

                        return <article className="permission-page" key={page.key}>
                          <div className="permission-page-head">
                            <label className="permission-page-title">
                              <input type="checkbox" disabled={roleReadOnly}
                                ref={node => { if (node) node.indeterminate = pageSelectedCount > 0 && pageSelectedCount < pagePermissionIds.length }}
                                checked={pageSelectedCount === pagePermissionIds.length && pagePermissionIds.length > 0}
                                onChange={e => updatePermissionSelection(pagePermissionIds, e.target.checked)} />
                              <span><strong>{adminT(page.label)}</strong><small>{adminT(page.description)}</small></span>
                            </label>
                            <span>{pageSelectedCount}/{pagePermissionIds.length}</span>
                          </div>
                          <div className="permission-options">
                            {page.items.map(permission => {
                              const checked = roleIsLocked || selectedPermissionIds.has(permission.id)
                              return <label className={`permission-option ${checked ? 'selected' : ''} ${roleReadOnly ? 'locked' : ''}`} key={permission.id}>
                                <input type="checkbox" disabled={roleReadOnly} checked={checked}
                                  onChange={e => updatePermissionSelection([permission.id], e.target.checked)} />
                                <span className="permission-option-copy"><strong>{displayPermissionName(permission)}</strong><small>{permission.code}</small></span>
                                {permission.sensitive && <em className="sensitive-badge">{adminT('敏感')}</em>}
                              </label>
                            })}
                          </div>
                        </article>
                      })}
                    </div>}
                  </section>
                })}
              </div> : <div className="permission-empty-state"><strong>{adminT('没有匹配的权限')}</strong><span>{adminT('请更换关键词，或清除搜索查看全部模块。')}</span></div>}
            </div>

            <div className="modal-actions">
              <span className="role-modal-actions-note">{adminT(roleReadOnly?'只读查看，不会修改角色或权限。':'权限保存后立即应用于使用该角色的后台账号。')}</span>
              <div className="role-modal-actions-buttons">
                {!roleReadOnly && <button className="secondary-action" disabled={roleModal.saving} onClick={() => setRoleModal(null)}>{adminT('取消')}</button>}
                <button className="primary-action" disabled={roleModal.saving} onClick={roleReadOnly ? () => setRoleModal(null) : saveRole}>{adminT(roleReadOnly ? '完成' : roleModal.saving ? '保存中…' : '保存权限')}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
