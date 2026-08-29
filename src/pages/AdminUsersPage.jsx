import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AdminModuleNav from '../components/AdminModuleNav'
import { adminLocalPageTabs } from '../config/navigation'
import { buildRolePermissionSections, uniquePermissionIds } from '../config/rolePermissionCatalog'
import { useAdminAccess } from '../lib/adminAccess'
import { useAdminI18n } from '../lib/adminI18n'
import { assignedScopeCandidates, pruneAssignedScopeSelection } from '../lib/adminAccountScopeSelection'

const USER_TABS = ['backend', 'staff', 'roles']
const blankAccessSearch = () => ({ account:'', employee:'', context:'', status:'all' })

const accountDateTime = value => {
  const date = new Date(value || '')
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12:false,
  }).format(date)
}

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
  position_ids: [],
  employee_ids: [],
  scope_team_search: '',
  scope_position_search: '',
  scope_employee_search: '',
  scope_team_selected_only: false,
  scope_position_selected_only: false,
  scope_employee_selected_only: false,
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
  disable_employee: '停用员工账号',
  generate: '生成',
  change: '变更',
  reactivate: '恢复在职',
  reset_password: '重置密码',
  otp_toggle: 'OTP开关',
  mfa_reset: '重置OTP',
  resign: '办理离职',
  general: '通用导出',
}

function getRole(a) {
  return Array.isArray(a?.roles) ? a.roles[0] : a?.roles
}

function scopeLabel(scope) {
  if (scope === 'all') return '全部'
  if (scope === 'assigned_teams') return '指定范围'
  if (scope === 'self') return '仅本人'
  return '自己团队'
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
  const [creatingRole, setCreatingRole] = useState(false)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [accessSearchDraft, setAccessSearchDraft] = useState(blankAccessSearch)
  const [accessSearchQuery, setAccessSearchQuery] = useState(blankAccessSearch)
  const [deletingAccountId, setDeletingAccountId] = useState('')
  const [mutatingAccountId, setMutatingAccountId] = useState('')
  const [accountToast, setAccountToast] = useState(null)
  const [accountPage, setAccountPage] = useState(1)

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

  const fetchRecoveryAccounts = (search, page = 1, extra = {}) => call({
    action:'account_list',
    page,
    search:{
      username:String(search?.account || ''),
      employee:String(search?.employee || ''),
      context:String(search?.context || ''),
    },
    status:String(search?.status || 'all'),
    ...extra,
  })
  const fetchRecoveryRoles = () => call({ action:'role_list' })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const bootstrap = await call({ action: 'bootstrap' })
      const bootstrapPermissions = new Set(bootstrap?.caller?.permissions || [])
      const mayReadRecoveryAccounts = Boolean(
        bootstrap?.caller?.is_founder ||
        bootstrapPermissions.has('*') ||
        bootstrapPermissions.has('backend_account.view')
      )
      const mayReadRecoveryRoles = Boolean(
        bootstrap?.caller?.is_founder ||
        bootstrapPermissions.has('*') ||
        bootstrapPermissions.has('role.view')
      )
      if (bootstrap?.degraded && (mayReadRecoveryAccounts || mayReadRecoveryRoles)) {
        const [boundedAccounts, boundedRoles] = await Promise.all([
          mayReadRecoveryAccounts ? fetchRecoveryAccounts(blankAccessSearch(), 1) : null,
          mayReadRecoveryRoles ? fetchRecoveryRoles() : null,
        ])
        if (boundedAccounts) setAccountPage(Number(boundedAccounts?.account_pagination?.page || 1))
        setData({
          ...bootstrap,
          ...(boundedAccounts || {}),
          ...(boundedRoles || {}),
          caller:{ ...bootstrap.caller, ...boundedAccounts?.caller, ...boundedRoles?.caller },
        })
      } else {
        setData(bootstrap)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!accountToast) return undefined
    const timer = window.setTimeout(() => setAccountToast(null), 3600)
    return () => window.clearTimeout(timer)
  }, [accountToast])
  useEffect(() => {
    setTabState(USER_TABS.includes(requestedTab) ? requestedTab : 'backend')
  }, [requestedTab])
  useEffect(() => {
    if (!data?.recovery_account_mode || accountModal?.mode !== 'create' || accountModal?.form?.employee_id) return undefined
    const employeeQuery = String(accountModal?.form?.employee_search || '').trim()
    if (employeeQuery.length < 2) return undefined
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const result = await fetchRecoveryAccounts(blankAccessSearch(), 1, {
          employee_lookup_only:true,
          employee_query:employeeQuery,
        })
        if (!cancelled) setData(current => current ? ({ ...current, employees:result?.employees || [] }) : current)
      } catch {
        // A transient lookup error must not clear the session or the form.
      }
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [data?.recovery_account_mode, accountModal?.mode, accountModal?.form?.employee_id, accountModal?.form?.employee_search])

  const setTab = next => {
    if (data?.degraded && next === 'staff') return
    if (data?.degraded && next === 'backend' && !data?.recovery_account_mode) return
    if (data?.degraded && next === 'roles' && !data?.recovery_role_mode) return
    if ((!sharedAccess.loading || data) && !tabAllowed(next)) return
    setTabState(next)
    setSearchDraft('')
    setSearchQuery('')
    setAccessSearchDraft(blankAccessSearch())
    setAccessSearchQuery(blankAccessSearch())
    setSearchParams(next === 'backend' ? {} : { tab: next }, { replace: true })
  }

  const callerFounder = sharedAccess.founder || data?.caller?.is_founder
  const callerPermissions = new Set(data?.caller?.permissions || [])
  const callerCan = code => Boolean(callerFounder || sharedAccess.hasPermission(code) || callerPermissions.has('*') || callerPermissions.has(code))
  const recoveryAccountMode = Boolean(data?.recovery_account_mode)
  const recoveryAccountActions = new Set(data?.supported_account_actions || [])
  const recoveryAccountFilters = new Set(data?.supported_account_filters || [])
  const recoveryCan = action => Boolean(recoveryAccountMode && recoveryAccountActions.has(action))
  const recoveryRoleMode = Boolean(data?.recovery_role_mode)
  const recoveryRolePermissionsWritable = Boolean(
    recoveryRoleMode && callerFounder && data?.role_permissions_writable !== false
  )
  const canSaveRolePermissions = Boolean(
    callerFounder && (!recoveryRoleMode || recoveryRolePermissionsWritable)
  )
  const backendPermissionCodes = ['backend_account.view']
  const staffPermissionCodes = ['staff_account.view']
  const tabAllowed = key => key === 'backend'
    ? backendPermissionCodes.some(callerCan)
    : key === 'staff'
      ? staffPermissionCodes.some(callerCan)
      : callerCan('role.view')
  const visibleTabs = sharedAccess.loading && !data
    ? []
    : USER_TABS.filter(key => tabAllowed(key) && (
      !data?.degraded ||
      (key === 'backend' && recoveryAccountMode) ||
      (key === 'roles' && recoveryRoleMode)
    ))
  const canCreateBackend = callerCan('account.create')
  const canEditBackend = !recoveryAccountMode && callerCan('account.edit')
  const canToggleBackend = (!recoveryAccountMode && callerCan('account.disable')) || recoveryCan('toggle_active')
  const canDeleteBackend = !recoveryAccountMode && callerCan('account.delete')
  const canResetBackendPassword = (!recoveryAccountMode && callerCan('account.reset_password')) || recoveryCan('reset_password')
  const canToggleOtp = (!recoveryAccountMode && callerCan('account.otp_toggle')) || recoveryCan('toggle_otp')
  const canResetBackendMfa = (!recoveryAccountMode && callerCan('backend_account.mfa_reset')) || recoveryCan('reset_mfa')
  const canResetStaffMfa = callerCan('staff_account.mfa_reset')
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
  const positions = data?.positions || []
  const scopeTeams = data?.scope_teams || []
  const scopePositions = data?.scope_positions || []
  const staleScopeTeams = data?.stale_scope_teams || []
  const scopeEmployees = data?.scope_employees || []
  const scopeDirectoryDiagnostics = data?.scope_directory_diagnostics || {}
  const ambiguousScopeTeamNames = scopeDirectoryDiagnostics.ambiguousTeamNames || []
  const ambiguousScopePositionNames = scopeDirectoryDiagnostics.ambiguousPositionNames || []
  const unmatchedScopeRowCount = [
    ...(scopeDirectoryDiagnostics.unmatchedEmployeeNos || []),
    ...(scopeDirectoryDiagnostics.unmatchedTeamEmployeeNos || []),
    ...(scopeDirectoryDiagnostics.unmatchedPositionEmployeeNos || []),
  ].length
  const recoverySupportedScopes = new Set(
    recoveryAccountMode
      ? data?.supported_data_scopes || []
      : ['all', 'self', 'own_team', 'assigned_teams']
  )

  useEffect(() => {
    if ((sharedAccess.loading && !data) || visibleTabs.includes(tab)) return
    const fallback = visibleTabs[0]
    if (!fallback) return
    setTabState(fallback)
    setSearchParams(fallback === 'backend' ? {} : { tab: fallback }, { replace: true })
  }, [data, tab, sharedAccess.loading, sharedAccess.permissionKey])

  const editableRoles = roles.filter(r => !['founder', 'employee'].includes(r.code))
  const assignableRoleIds = new Set(data?.assignable_role_ids || [])
  const creationRoles = callerFounder
    ? editableRoles
    : editableRoles.filter(role => assignableRoleIds.has(role.id))
  const modalRoles = accountModal?.mode === 'create' ? creationRoles : editableRoles
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const matchesSearch = (...values) => !normalizedSearch || values.some(value => String(value || '').toLowerCase().includes(normalizedSearch))
  const normalizedAccessSearch = Object.fromEntries(Object.entries(accessSearchQuery).map(([key, value]) => [key, String(value || '').trim().toLowerCase()]))
  const matchesAccessField = (key, ...values) => !normalizedAccessSearch[key] || values.some(value => String(value || '').toLowerCase().includes(normalizedAccessSearch[key]))
  const visibleBackend = backend.filter(a => {
    const role = getRole(a)
    return matchesAccessField('account', a.login_username) &&
      matchesAccessField('employee', a.employee?.employee_no, a.employee?.full_name) &&
      matchesAccessField('context', role?.name, role?.code, scopeLabel(a.data_scope), a.account_created_by_label) &&
      (!normalizedAccessSearch.status || normalizedAccessSearch.status === 'all' ||
        (normalizedAccessSearch.status === 'active' ? a.active : !a.active))
  })
  const visibleStaff = staff.filter(a =>
    matchesAccessField('account', a.login_email) &&
    matchesAccessField('employee', a.employee?.employee_no, a.employee?.full_name) &&
    matchesAccessField('context', a.employee?.teams?.name, a.employee?.positions?.name)
  )
  const visibleRoles = roles.filter(r => r.code !== 'employee' && matchesSearch(r.name, r.code))
  const accountPagination = data?.account_pagination || {}
  const accountTotal = Number(accountPagination.total || 0)
  const accountPageSize = Number(accountPagination.page_size || 20)
  const accountPageCount = Math.max(1, Math.ceil(accountTotal / accountPageSize))
  const visibleTab = visibleTabs.includes(tab) ? tab : ''
  const pageChrome = adminLocalPageTabs('/admin/users', visibleTabs, visibleTab)
  const sectionTitle = pageChrome.active.sectionLabel || '后台账号使用情况'

  const rolePermissionMap = useMemo(() => {
    const map = new Map()
    for (const r of rolePermissions) {
      if (!map.has(r.role_id)) map.set(r.role_id, new Set())
      map.get(r.role_id).add(r.permission_id)
    }
    return map
  }, [rolePermissions])

  const groupedPermissionSections = useMemo(
    () => buildRolePermissionSections(permissions),
    [permissions],
  )
  const catalogPermissionIds = useMemo(
    () => uniquePermissionIds(groupedPermissionSections.flatMap(section => section.pages).flatMap(page => page.items)),
    [groupedPermissionSections],
  )
  const catalogPermissionIdSet = useMemo(() => new Set(catalogPermissionIds), [catalogPermissionIds])
  const catalogPermissions = useMemo(
    () => permissions.filter(permission => catalogPermissionIdSet.has(permission.id)),
    [permissions, catalogPermissionIdSet],
  )

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
        const pendingItems = sectionMatches || pageMatches
          ? (page.pendingItems || [])
          : (page.pendingItems || []).filter(permission => `${permission.name || ''} ${permission.code || ''} ${actionLabels[permission.actionKey] || ''} 待拆分 旧共享`.toLowerCase().includes(query))
        return { ...page, items, pendingItems, pendingCodes: pendingItems.map(permission => permission.code) }
      }).filter(page => page.items.length > 0 || page.pendingItems.length > 0)
      return { ...section, pages }
    }).filter(section => section.pages.length > 0)
  }, [groupedPermissionSections, roleModal?.permission_search])

  const openCreate = () => {
    const form = blankAccount()
    if (recoveryAccountMode) {
      form.data_scope = recoverySupportedScopes.has('all') ? 'all' : [...recoverySupportedScopes][0] || 'self'
    }
    setAccountModal({ mode: 'create', form, batch: [], error: '', saving: false })
  }
  const openCreateStaff = () => setStaffModal({ form: blankStaffAccount(), error: '', saving: false })

  const openEdit = (a) => {
    const role = getRole(a)
    const removedStaleTeamIds = staleScopeTeams
      .filter(x => x.auth_user_id === a.auth_user_id)
      .map(x => x.team_id)
    const currentSelection = pruneAssignedScopeSelection({
      teamIds: scopeTeams.filter(x => x.auth_user_id === a.auth_user_id).map(x => x.team_id),
      positionIds: scopePositions.filter(x => x.auth_user_id === a.auth_user_id).map(x => x.position_id),
      employeeIds: scopeEmployees.filter(x => x.auth_user_id === a.auth_user_id).map(x => x.employee_id),
    }, employees, teams)
    setAccountModal({
      mode: 'edit',
      error: '',
      saving: false,
      removedStaleTeamIds,
      form: {
        auth_user_id: a.auth_user_id,
        employee_id: a.employee_id || '',
        employee_search: a.employee ? `${a.employee.employee_no} · ${a.employee.full_name}` : '',
        username: a.login_username || '',
        password: '',
        role_id: role?.id || a.role_id || '',
        data_scope: a.data_scope || 'own_team',
        otp_required: Boolean(a.otp_required),
        team_ids: currentSelection.teamIds,
        position_ids: currentSelection.positionIds,
        employee_ids: currentSelection.employeeIds,
        scope_team_search: '',
        scope_position_search: '',
        scope_employee_search: '',
        scope_team_selected_only: false,
        scope_position_selected_only: false,
        scope_employee_selected_only: false,
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
    if (recoveryAccountMode && !recoverySupportedScopes.has(form.data_scope)) {
      return '恢复期间该管理范围暂不可安全授权，请选择当前允许的范围。'
    }
    if (['self', 'own_team'].includes(form.data_scope) && !form.employee_id) return '“仅本人”或“关联员工所在团队”必须先关联员工档案。'
    if (form.data_scope === 'assigned_teams' && !form.team_ids.length) return '指定范围必须先选择至少一个团队；团队是不可越过的数据边界。'
    if (form.data_scope === 'assigned_teams') {
      const pruned = pruneAssignedScopeSelection({
        teamIds: form.team_ids,
        positionIds: form.position_ids,
        employeeIds: form.employee_ids,
      }, employees, teams)
      if (pruned.teamIds.length !== form.team_ids.length) return '已选团队不在当前排班组织目录，请重新选择。'
      if (pruned.positionIds.length !== form.position_ids.length) return '已选岗位不属于所选团队，请重新选择。'
      if (pruned.employeeIds.length !== form.employee_ids.length) return '指定员工必须属于所选团队，不能添加团队外人员。'
    }
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
          position_ids: [...form.position_ids],
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
        const accounts = recoveryAccountMode
          ? [form]
          : accountModal.batch.length ? accountModal.batch : [form]
        const validationError = accounts.length === 1 && !accountModal.batch.length ? validateAccountDraft(form) : ''
        if (validationError) throw new Error(validationError)
        if (recoveryAccountMode) {
          await call({
            action:'create_backend',
            username:form.username,
            password:form.password,
            role_id:form.role_id,
            employee_id:form.employee_id,
            data_scope:form.data_scope,
            otp_required:form.otp_required,
          })
          setAccountModal(null)
          await load()
          return
        }
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
          position_ids: form.position_ids,
          employee_ids: form.employee_ids,
        })
      }
      setAccountModal(null)
      await load()
    } catch (e) {
      setAccountModal(x => ({ ...x, error: e.message, saving: false }))
    }
  }

  const refreshRecoveryAccountPage = async (search, page) => {
    setLoading(true)
    setError('')
    try {
      let boundedAccounts = await fetchRecoveryAccounts(search, page)
      const requestedPage = Number(boundedAccounts?.account_pagination?.page || page || 1)
      const pageSize = Number(boundedAccounts?.account_pagination?.page_size || 20)
      const total = Number(boundedAccounts?.account_pagination?.total || 0)
      const lastPage = Math.max(1, Math.ceil(total / pageSize))
      if (requestedPage > lastPage) boundedAccounts = await fetchRecoveryAccounts(search, lastPage)
      setAccountPage(Number(boundedAccounts?.account_pagination?.page || lastPage))
      setData(current => current ? ({
        ...current,
        ...boundedAccounts,
        caller:{ ...current.caller, ...boundedAccounts.caller },
      }) : boundedAccounts)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const applyAccessSearch = () => {
    const next = { ...accessSearchDraft }
    setAccessSearchQuery(next)
    if (recoveryAccountMode && visibleTab === 'backend') refreshRecoveryAccountPage(next, 1)
  }

  const resetAccessSearch = () => {
    const empty = blankAccessSearch()
    setAccessSearchDraft(empty)
    setAccessSearchQuery(empty)
    if (recoveryAccountMode && visibleTab === 'backend') refreshRecoveryAccountPage(empty, 1)
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
    if (!a?.auth_user_id || mutatingAccountId) return
    setMutatingAccountId(a.auth_user_id)
    setError('')
    try {
      await call({ action: 'toggle_otp', auth_user_id: a.auth_user_id, otp_required: !a.otp_required })
      if (recoveryAccountMode) await refreshRecoveryAccountPage(accessSearchQuery, accountPage)
      else await load()
      setAccountToast({ type:'success', message:`${a.login_username || '账号'} 的登录 OTP 已${a.otp_required ? '关闭' : '开启'}。` })
    } catch (e) { setError(e.message) }
    finally { setMutatingAccountId('') }
  }

  const toggleActive = async (a) => {
    if (!a?.auth_user_id || mutatingAccountId) return
    setMutatingAccountId(a.auth_user_id)
    setError('')
    try {
      await call({ action: 'toggle_active', auth_user_id: a.auth_user_id, active: !a.active })
      if (recoveryAccountMode) await refreshRecoveryAccountPage(accessSearchQuery, accountPage)
      else await load()
      setAccountToast({ type:'success', message:`${a.login_username || '账号'} 已${a.active ? '停用' : '启用'}。` })
    } catch (e) { setError(e.message) }
    finally { setMutatingAccountId('') }
  }

  const resetPassword = async (a) => {
    const password = window.prompt('输入新的临时密码')
    if (!password) return
    if (!a?.auth_user_id || mutatingAccountId) return
    setMutatingAccountId(a.auth_user_id)
    setError('')
    try {
      await call({ action: 'reset_password', auth_user_id: a.auth_user_id, password })
      window.alert('密码已重置')
    } catch (e) { setError(e.message) }
    finally { setMutatingAccountId('') }
  }

  const resetMfa = async (a) => {
    if (!window.confirm('确认重置该账号的 Google OTP？')) return
    if (!a?.auth_user_id || mutatingAccountId) return
    setMutatingAccountId(a.auth_user_id)
    setError('')
    try {
      await call({ action: 'reset_mfa', auth_user_id: a.auth_user_id })
      window.alert('OTP 已重置')
    } catch (e) { setError(e.message) }
    finally { setMutatingAccountId('') }
  }

  const deleteAccount = async (a, accountKind) => {
    if (!a?.auth_user_id || deletingAccountId) return
    if (!window.confirm('只删除登录账号，员工资料会保留。确认继续？')) return
    setDeletingAccountId(a.auth_user_id)
    setError('')
    setAccountToast(null)
    try {
      await call({ action: 'delete_account', auth_user_id: a.auth_user_id })
      setData(current => current ? ({
        ...current,
        backend_accounts: (current.backend_accounts || []).filter(account => account.auth_user_id !== a.auth_user_id),
        employee_accounts: (current.employee_accounts || []).filter(account => account.auth_user_id !== a.auth_user_id),
      }) : current)
      setAccountToast({ type: 'success', message: accountKind === 'staff' ? '员工登录账号已删除，员工档案已保留。' : '后台账号已删除，员工档案已保留。' })
    } catch (e) {
      setError(e.message)
      setAccountToast({ type: 'error', message: `删除失败：${e.message}` })
    } finally {
      setDeletingAccountId('')
    }
  }

  const createRole = async () => {
    if (recoveryRoleMode || !callerFounder || creatingRole) return
    const name = newRoleName.trim()
    if (name.length < 2 || name.length > 40) {
      setAccountToast({ type: 'error', message: '请先输入 2–40 个字的角色名称。' })
      return
    }
    setCreatingRole(true)
    setError('')
    setAccountToast(null)
    try {
      const created = await call({ action: 'create_role', name })
      setNewRoleName('')
      setSearchDraft('')
      setSearchQuery('')
      await load()
      if (created?.role) openRole(created.role)
      setAccountToast({ type: 'success', message: `角色「${name}」已新增，请继续勾选并保存权限。` })
    } catch (e) {
      setError(e.message)
      setAccountToast({ type: 'error', message: `新增角色失败：${e.message}` })
    } finally {
      setCreatingRole(false)
    }
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
    if (!roleModal || !canSaveRolePermissions) return
    if (recoveryRoleMode && (roleModal.role.system_locked || roleModal.role.active === false)) return
    if (!recoveryRoleMode && !roleModal.name.trim()) {
      setRoleModal(x => ({ ...x, error: '角色名称不能为空。' }))
      return
    }
    setRoleModal(x => ({ ...x, error: '', saving: true }))
    try {
      if (!recoveryRoleMode && !roleModal.role.system_locked && roleModal.name.trim() !== roleModal.role.name) {
        await call({ action: 'rename_role', role_id: roleModal.role.id, name: roleModal.name.trim() })
      }
      if (roleModal.role.code !== 'founder') {
        const savedResult = await call({
          action: 'save_role_permissions',
          role_id: roleModal.role.id,
          permission_ids: roleModal.permission_ids,
        })
        if (recoveryRoleMode && Array.isArray(savedResult?.saved?.permission_ids)) {
          const roleId = roleModal.role.id
          setData(current => current ? ({
            ...current,
            role_permissions: [
              ...(current.role_permissions || []).filter(grant => grant.role_id !== roleId),
              ...savedResult.saved.permission_ids.map(permission_id => ({ role_id:roleId, permission_id })),
            ],
          }) : current)
        }
      }
      setRoleModal(null)
      if (!recoveryRoleMode) await load()
    } catch (e) {
      setRoleModal(x => x ? ({ ...x, error: e.message, saving: false }) : x)
    }
  }

  const deleteRole = async (role) => {
    if (recoveryRoleMode || !callerFounder) return
    if (!window.confirm(`确认删除角色「${role.name}」？`)) return
    try {
      await call({ action: 'delete_role', role_id: role.id })
      await load()
    } catch (e) { setError(e.message) }
  }

  const roleIsLocked = roleModal?.role.code === 'founder'
  const recoveryTargetLocked = Boolean(
    recoveryRoleMode && (roleModal?.role.system_locked || roleModal?.role.active === false)
  )
  const roleReadOnly = !canSaveRolePermissions || roleIsLocked || recoveryTargetLocked
  const selectedPermissionIds = new Set(roleModal?.permission_ids || [])
  const accountEmployeeQuery = String(accountModal?.form?.employee_search || '').trim().toLowerCase()
  const accountEmployeeMatches = accountEmployeeQuery
    ? employees.filter(emp => `${emp.employee_no} ${emp.full_name}`.toLowerCase().includes(accountEmployeeQuery)).slice(0, 8)
    : []
  const scopeCanEdit = accountModal?.mode !== 'edit' || canManageScope
  const scopeTeamIds = accountModal?.form?.team_ids || []
  const scopePositionIds = accountModal?.form?.position_ids || []
  const scopeEmployeeIds = accountModal?.form?.employee_ids || []
  const scopeTeamIdSet = new Set(scopeTeamIds)
  const scopePositionIdSet = new Set(scopePositionIds)
  const scopeEmployeeIdSet = new Set(scopeEmployeeIds)
  const scopeTeamQuery = String(accountModal?.form?.scope_team_search || '').trim().toLowerCase()
  const scopePositionQuery = String(accountModal?.form?.scope_position_search || '').trim().toLowerCase()
  const scopeEmployeeQuery = String(accountModal?.form?.scope_employee_search || '').trim().toLowerCase()
  const teamActiveCounts = new Map(teams.map(team => [team.id, Number(team.member_count) || 0]))
  const selectedScopeTeams = scopeTeamIds.map(id => teams.find(team => team.id === id) || { id, name: `团队 ${id}` })
  const selectedScopePositions = scopePositionIds.map(id => positions.find(position => position.id === id) || { id, name: `已失效岗位 ${id}` })
  const selectedScopeEmployees = scopeEmployeeIds.map(id => employees.find(employee => employee.id === id) || { id, employee_no: '未知员工', full_name: id })
  const assignedCandidates = assignedScopeCandidates(employees, positions, scopeTeamIds)
  const eligibleScopeEmployees = assignedCandidates.employees
  const eligibleScopePositions = assignedCandidates.positions
  const selectedTeamPositionCounts = eligibleScopeEmployees.reduce((counts, employee) => {
    const positionId = String(employee.current_position_id || employee.position_id || '').trim()
    if (positionId) counts.set(positionId, (counts.get(positionId) || 0) + 1)
    return counts
  }, new Map())
  const visibleScopeTeams = teams.filter(team => {
    if (accountModal?.form?.scope_team_selected_only && !scopeTeamIdSet.has(team.id)) return false
    return !scopeTeamQuery || String(team.name || '').toLowerCase().includes(scopeTeamQuery)
  })
  const matchingScopeEmployees = eligibleScopeEmployees.filter(employee => {
    if (accountModal?.form?.scope_employee_selected_only && !scopeEmployeeIdSet.has(employee.id)) return false
    return !scopeEmployeeQuery || `${employee.employee_no} ${employee.full_name}`.toLowerCase().includes(scopeEmployeeQuery)
  })
  const visibleScopePositions = eligibleScopePositions.filter(position => {
    if (accountModal?.form?.scope_position_selected_only && !scopePositionIdSet.has(position.id)) return false
    return !scopePositionQuery || String(position.name || '').toLowerCase().includes(scopePositionQuery)
  })
  const visibleScopeEmployees = accountModal?.form?.scope_employee_selected_only
    ? matchingScopeEmployees
    : matchingScopeEmployees.slice(0, 100)

  const updateScopeIds = (key, id, checked) => {
    setAccountModal(current => {
      if (!current || !scopeCanEdit) return current
      const ids = current.form[key] || []
      const next = checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id)
      const nextForm = { ...current.form, [key]: next }
      if (key === 'team_ids') {
        const pruned = pruneAssignedScopeSelection({
          teamIds: next,
          positionIds: nextForm.position_ids,
          employeeIds: nextForm.employee_ids,
        }, employees, teams)
        nextForm.team_ids = pruned.teamIds
        nextForm.position_ids = pruned.positionIds
        nextForm.employee_ids = pruned.employeeIds
      }
      return { ...current, error: '', form: nextForm }
    })
  }

  const clearScopeIds = key => {
    if (!scopeCanEdit) return
    setAccountModal(current => {
      if (!current) return current
      const nextForm = { ...current.form, [key]: [] }
      if (key === 'team_ids') {
        nextForm.position_ids = []
        nextForm.employee_ids = []
      }
      return { ...current, error: '', form: nextForm }
    })
  }

  const updatePermissionSelection = (permissionIds, checked) => {
    if (!canSaveRolePermissions) return
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
        .access-grid-actions button:disabled{opacity:.55;cursor:wait}.access-account-row-deleting{background:#fbfcfe}.access-account-row-deleting>td{opacity:.72}
        .access-grid-actions button.danger{color:#bd4242}
        .recovery-account-note{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 12px;border-top:1px solid #e5ebf3;background:#f8fbff;color:#677b95;font-size:11px}.recovery-account-note strong{color:#345dba}.recovery-account-pager{display:flex;align-items:center;gap:8px}.recovery-account-pager button{height:32px;padding:0 12px;border:1px solid #d6e0ed;border-radius:8px;background:#fff;color:#34506f;cursor:pointer}.recovery-account-pager button:disabled{opacity:.45;cursor:not-allowed}
        .access-toast{position:fixed;z-index:1200;top:76px;right:24px;display:flex;align-items:center;gap:10px;max-width:min(420px,calc(100vw - 32px));padding:12px 15px;border:1px solid #bfe5cf;border-radius:11px;background:#f0fbf5;color:#166c45;box-shadow:0 12px 28px rgba(30,55,85,.16);font-size:12px;font-weight:800}.access-toast.error{border-color:#efc5c5;background:#fff5f5;color:#a83d3d}.access-toast button{border:0;background:transparent;color:inherit;font-size:17px;cursor:pointer}
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
        .access-searchbar{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr)) auto auto auto;align-items:end;justify-content:start;gap:9px;margin-bottom:14px;padding:12px;background:#fff;border:1px solid #dfe7f0;border-radius:12px}.access-searchbar label{display:flex;min-width:0;flex-direction:column;gap:5px;color:#6f8096;font-size:10px;font-weight:850}.access-searchbar input,.access-searchbar select{height:40px;width:100%;border:1px solid #d6e0eb;border-radius:9px;padding:0 12px;background:#fff}.access-searchbar .secondary-action,.access-searchbar .primary-action{height:40px;white-space:nowrap}
        .account-modal{width:min(1180px,96vw);max-height:min(820px,90vh);display:flex;flex-direction:column;overflow:hidden}.account-modal .modal-head{flex:0 0 auto}.account-modal .account-modal-body{overflow:auto;padding:2px 3px 8px}.account-modal .modal-actions{flex:0 0 auto;position:sticky;bottom:0;background:#fff;border-top:1px solid #edf1f5;padding-top:12px;margin-top:6px;z-index:2}
        .account-session-note{display:flex;align-items:flex-start;gap:8px;margin:0 0 12px;padding:10px 12px;border:1px solid #d9e4f5;border-radius:10px;background:#f4f8ff;color:#58708f;font-size:11px;line-height:1.55}.account-session-note strong{flex:0 0 auto;color:#3564c8}.account-session-note span{min-width:0}
        .scope-current-team-note{grid-column:1/-1;display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border:1px solid #d7e6df;border-radius:9px;background:#f3faf6;color:#557365;font-size:10px;line-height:1.55}.scope-current-team-note strong{flex:0 0 auto;color:#28734f}.scope-current-team-note.warning{border-color:#ecd8ae;background:#fff9ed;color:#826a3c}.scope-current-team-note.warning strong{color:#9a681f}.scope-current-team-note+.scope-columns{margin-top:10px}
        .scope-panel{grid-column:1/-1;border:1px solid #dbe4f0;border-radius:12px;padding:12px;background:#f7f9fc}.scope-columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.scope-column{min-width:0;overflow:hidden;border:1px solid #dfe7f1;border-radius:11px;background:#fff}.scope-column-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 11px 7px}.scope-column-head strong{color:#2d425e;font-size:13px}.scope-column-head span{padding:3px 7px;border-radius:999px;background:#edf3ff;color:#4168bd;font-size:9px;font-weight:850}.scope-column-tools{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;padding:0 9px 8px}.form-grid .scope-column-tools .scope-search{min-width:0;width:100%;height:34px;margin:0;padding:0 9px}.scope-filter-button,.scope-clear-button{height:34px;border:1px solid #d7e1ed;border-radius:8px;background:#fff;padding:0 8px;color:#60738b;font-size:9px;font-weight:800;white-space:nowrap;cursor:pointer}.scope-filter-button.active{border-color:#bdd0f4;background:#edf3ff;color:#2f62cd}.scope-clear-button{color:#a45555}.scope-clear-button:disabled{opacity:.4;cursor:not-allowed}.scope-selected-list{display:flex;max-height:68px;gap:5px;flex-wrap:wrap;overflow:auto;margin:0 9px 8px;padding:7px;border:1px solid #e4eaf2;border-radius:8px;background:#f8fafc}.scope-chip{display:inline-flex;min-width:0;align-items:center;gap:5px;max-width:100%;padding:4px 7px;border:1px solid #d6e1f0;border-radius:999px;background:#fff;color:#3c5879;font-size:9px}.scope-chip span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.scope-chip button{display:grid;width:16px;height:16px;flex:0 0 auto;place-items:center;border:0;border-radius:50%;background:#eef2f7;color:#7b899b;line-height:1;cursor:pointer}.scope-chip button:disabled{cursor:not-allowed;opacity:.45}.scope-selection-empty{margin:0 9px 8px;padding:7px;border:1px dashed #dce4ee;border-radius:8px;background:#fafbfd;color:#95a1b1;font-size:9px;text-align:center}.check-list{height:186px;overflow:auto;border-width:1px 0 0;border-style:solid;border-color:#e5ebf2;background:#fff;padding:5px}.check-list label{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:36px;padding:6px 7px;border-radius:7px;color:#46566d;font-size:11px;cursor:pointer}.check-list label:hover{background:#f4f7fc}.check-list label.scope-row-selected{background:#f0f5ff}.check-list label>span{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.check-list label>small{color:#8897a9;font-size:8px;white-space:nowrap}.form-grid .scope-panel input.scope-check[type="checkbox"]{width:16px!important;height:16px!important;min-width:16px;margin:0!important;padding:0!important;border-radius:4px;box-shadow:none;accent-color:#3568da}.form-grid .scope-panel input.scope-check[type="checkbox"]:focus{box-shadow:0 0 0 3px rgba(53,104,218,.1)}
        .permissions-modal-mask{padding:clamp(10px,2vw,24px)}.role-modal{display:flex;width:min(1180px,calc(100vw - 36px));height:min(860px,calc(100dvh - 36px));max-height:none;flex-direction:column;overflow:hidden;padding:0;border-radius:18px;background:#f5f7fa}.role-modal .role-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex:0 0 auto;margin:0;padding:17px 20px;border-bottom:1px solid #dfe6ef;background:#fff}.role-modal-heading{display:flex;align-items:center;gap:11px}.role-modal-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:#eaf1ff;color:#3265da;font-weight:900}.role-modal-head h2{margin:0 0 4px;color:#203754;font-size:19px}.role-modal-head p{margin:0;color:#7c8ba0;font-size:12px}.role-modal-head>button{width:34px;height:34px;flex:0 0 auto;border:0;border-radius:9px;background:#f0f3f7;color:#748297;font-size:21px;cursor:pointer}.role-modal-head>button:hover{background:#e9edf3;color:#344b67}
        .role-modal-body{min-height:0;overflow:auto;padding:16px 18px 24px;overscroll-behavior:contain;scrollbar-gutter:stable}.role-modal .page-error{margin-bottom:12px}.role-identity-panel{display:grid;grid-template-columns:minmax(260px,1fr) auto;align-items:end;gap:18px;margin-bottom:12px;padding:14px 15px;border:1px solid #dfe6ef;border-radius:12px;background:#fff}.role-name-field{display:flex;flex-direction:column;gap:6px;color:#5e718a;font-size:11px;font-weight:850}.role-name-field input{width:100%;height:39px;border:1px solid #d3deea;border-radius:9px;padding:0 11px;color:#2e4561;outline:none}.role-name-field input:focus{border-color:#4b76dc;box-shadow:0 0 0 3px rgba(75,118,220,.09)}.role-name-field input:disabled{background:#f3f5f8;color:#728196}.role-selection-summary{display:flex;gap:8px}.role-selection-summary div{min-width:108px;padding:9px 11px;border-radius:9px;background:#f4f7fb}.role-selection-summary strong,.role-selection-summary small{display:block}.role-selection-summary strong{color:#2d5fce;font-size:17px}.role-selection-summary small{margin-top:2px;color:#8391a4;font-size:10px}
        .permission-guidance{display:flex;align-items:flex-start;gap:8px;margin:-2px 0 12px;padding:10px 12px;border:1px solid #d9e4f5;border-radius:10px;background:#f4f8ff;color:#58708f;font-size:11px;line-height:1.55}.permission-guidance strong{flex:0 0 auto;color:#3564c8}.permission-toolbar{position:sticky;top:-16px;z-index:4;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;padding:11px 12px;border:1px solid #dce5ef;border-radius:11px;background:rgba(255,255,255,.96);box-shadow:0 5px 16px rgba(31,51,79,.05);backdrop-filter:blur(8px)}.permission-search{display:flex;align-items:center;min-width:260px;max-width:520px;flex:1;height:39px;border:1px solid #d3deea;border-radius:9px;background:#fff;padding:0 10px}.permission-search span{margin-right:7px;color:#91a0b3}.permission-search input{min-width:0;flex:1;height:35px;border:0;background:transparent;color:#344b67;outline:none}.permission-toolbar-actions{display:flex;gap:7px}.permission-toolbar-actions button{height:35px;border:1px solid #d3deea;border-radius:8px;background:#fff;padding:0 10px;color:#51677f;font-size:11px;font-weight:800;cursor:pointer}.permission-toolbar-actions button:hover{border-color:#b9cae2;background:#f7f9fc}.permission-toolbar-actions button:disabled{opacity:.5;cursor:not-allowed}.founder-permission-note{display:flex;align-items:flex-start;gap:9px;margin-bottom:12px;padding:11px 13px;border:1px solid #cce7d9;border-radius:10px;background:#f1fbf6;color:#34775b;font-size:11px;line-height:1.55}.founder-permission-note strong{flex:0 0 auto}
        .permission-sections{display:flex;flex-direction:column;gap:11px}.permission-section{overflow:hidden;border:1px solid #dce4ee;border-radius:13px;background:#fff}.permission-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 14px;border-bottom:1px solid #e7ecf3;background:#f9fbfd}.permission-section-head-main{display:flex;align-items:center;gap:10px;min-width:0}.permission-section-head-main>input,.permission-page-title>input,.permission-option>input{width:17px;height:17px;flex:0 0 auto;margin:0;accent-color:#3568da;cursor:pointer}.permission-section-head-main>input:disabled,.permission-page-title>input:disabled,.permission-option>input:disabled{cursor:not-allowed}.permission-section-head h3{margin:0;color:#263e5b;font-size:14px}.permission-section-head p{margin:3px 0 0;color:#8290a3;font-size:10px}.permission-section-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}.permission-count{padding:4px 7px;border-radius:999px;background:#edf3ff;color:#3d65c3;font-size:10px;font-weight:850}.permission-section-actions button{width:29px;height:29px;border:0;border-radius:7px;background:#eef2f6;color:#667991;cursor:pointer}.permission-section.collapsed .permission-section-head{border-bottom:0}
        .permission-page-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:11px}.permission-page{overflow:hidden;border:1px solid #e1e7ef;border-radius:11px;background:#fbfcfe}.permission-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:11px 12px;border-bottom:1px solid #e8edf3;background:#fff}.permission-page-title{display:flex;align-items:flex-start;gap:9px;min-width:0}.permission-page-title>input{margin-top:2px}.permission-page-title strong,.permission-page-title small{display:block}.permission-page-title strong{color:#334b67;font-size:12px}.permission-page-title small{margin-top:3px;color:#8996a7;font-size:10px;line-height:1.45}.permission-page-head>span{flex:0 0 auto;color:#7c8ca0;font-size:10px}.permission-options{display:grid;grid-template-columns:1fr;gap:6px;padding:9px}.permission-option{display:flex;align-items:flex-start;gap:9px;min-width:0;padding:9px 10px;border:1px solid #e4e9f0;border-radius:8px;background:#fff;cursor:pointer;transition:border-color .15s,background .15s}.permission-option:hover{border-color:#c8d6e9;background:#f9fbff}.permission-option.selected{border-color:#bfd0f4;background:#f2f6ff}.permission-option.locked{cursor:default}.permission-option.pending{border-style:dashed;border-color:#e5d4b5;background:#fffaf1;cursor:not-allowed}.permission-option.pending:hover{border-color:#e5d4b5;background:#fffaf1}.permission-option.pending.selected{border-color:#dcc18f;background:#fff7e7}.permission-option.pending>input{accent-color:#b68434}.permission-option>input{margin-top:2px}.permission-option-copy{min-width:0;flex:1}.permission-option-copy strong,.permission-option-copy small{display:block}.permission-option-copy strong{color:#3c5069;font-size:12px;line-height:1.4}.permission-option-copy small{overflow:hidden;margin-top:3px;color:#96a1b0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;white-space:nowrap;text-overflow:ellipsis}.permission-option-badges{display:flex;flex:0 0 auto;gap:4px}.permission-action-badge,.sensitive-badge,.permission-pending-badge{flex:0 0 auto;padding:3px 5px;border-radius:5px;font-size:9px;font-style:normal;font-weight:850}.permission-action-badge{background:#eaf1ff;color:#3564c8}.permission-pending-badge{background:#f8e8c9;color:#8b6328}.sensitive-badge{background:#fff0db;color:#a76520}.permission-empty-state{padding:35px 18px;border:1px dashed #ccd7e5;border-radius:12px;background:#fff;color:#7d8da2;text-align:center}.permission-empty-state strong,.permission-empty-state span{display:block}.permission-empty-state strong{margin-bottom:5px;color:#465d78;font-size:13px}.permission-empty-state span{font-size:11px}
        .permission-page-pending{padding:9px 10px;border:1px dashed #e5d4b5;border-radius:8px;background:#fffaf1;color:#8a6733;font-size:10px;line-height:1.5}
        .role-modal>.modal-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:0 0 auto;margin:0;padding:12px 18px;border-top:1px solid #dde5ef;background:#fff}.role-modal-actions-note{color:#8291a4;font-size:11px}.role-modal-actions-buttons{display:flex;gap:8px}.role-modal>.modal-actions button{height:39px}.role-modal>.modal-actions button:disabled{opacity:.55;cursor:not-allowed}
        .employee-search-results{grid-column:1/-1;max-height:235px;overflow:auto;border:1px solid #dce5ef;border-radius:10px;background:#fff;padding:5px}.employee-search-option{width:100%;display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center;border:0;border-bottom:1px solid #edf1f5;background:#fff;padding:10px;text-align:left;cursor:pointer}.employee-search-option:hover{background:#f3f7ff}.employee-search-option:last-child{border-bottom:0}.employee-search-option strong{color:#24415f}.employee-search-option small{color:#738198}.employee-search-option span{font-size:11px;color:#376ac5}.linked-employee{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid #bfe6d0;background:#f0fbf5;border-radius:9px;color:#18784a;font-size:12px}.linked-employee button{border:0;background:transparent;color:#b34b4b;cursor:pointer}
        .account-batch-builder{margin:13px 0 3px;padding:12px;border:1px solid #dce5f0;border-radius:12px;background:#f7f9fc}.account-batch-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}.account-batch-toolbar strong,.account-batch-toolbar small{display:block}.account-batch-toolbar strong{color:#29425f;font-size:13px}.account-batch-toolbar small{margin-top:3px;color:#7f8da0;font-size:10px}.account-batch-toolbar button{height:36px;white-space:nowrap}.account-batch-empty{margin-top:10px;padding:12px;border:1px dashed #d5dfeb;border-radius:9px;background:#fff;color:#8a97a9;font-size:11px;text-align:center}.account-batch-list{display:flex;max-height:210px;flex-direction:column;gap:6px;margin-top:10px;overflow:auto}.account-batch-row{display:grid;grid-template-columns:25px minmax(0,1fr) auto;align-items:center;gap:9px;padding:9px 10px;border:1px solid #e0e7f0;border-radius:9px;background:#fff}.account-batch-row>span{display:grid;width:23px;height:23px;place-items:center;border-radius:7px;background:#edf3ff;color:#3567d1;font-size:10px;font-weight:900}.account-batch-row strong,.account-batch-row small,.account-batch-row em{display:block}.account-batch-row strong{color:#2e4561;font-size:12px}.account-batch-row small{overflow:hidden;margin-top:3px;color:#7e8b9d;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.account-batch-row em{margin-top:3px;color:#bd4343;font-size:10px;font-style:normal}.account-batch-row>button{border:0;background:transparent;color:#b64a4a;font-size:10px;cursor:pointer}.account-batch-row.failed{border-color:#efc4c4;background:#fff8f8}
        @media(max-width:1100px){.role-list{grid-template-columns:repeat(2,minmax(0,1fr))}.roles-toolbar{align-items:stretch;flex-direction:column}.role-search{max-width:none}.create-role-row{min-width:0}.permission-page-grid{grid-template-columns:1fr}}
        @media(max-width:700px){.roles-overview{align-items:flex-start;flex-direction:column}.roles-overview-stats{width:100%}.roles-overview-stats div{min-width:0;flex:1}.role-list{grid-template-columns:1fr}.role-search,.create-role-row{min-width:0;width:100%}.create-role-row{flex-direction:column}.permissions-modal-mask{padding:6px}.role-modal{width:calc(100vw - 12px);height:calc(100dvh - 12px);border-radius:13px}.role-identity-panel{grid-template-columns:1fr}.role-selection-summary div{flex:1}.permission-toolbar{align-items:stretch;flex-direction:column}.permission-search{min-width:0;width:100%}.permission-toolbar-actions{display:grid;grid-template-columns:1fr 1fr}.role-modal>.modal-actions{align-items:stretch;flex-direction:column}.role-modal-actions-buttons{display:grid;grid-template-columns:1fr 1fr}.scope-columns{grid-template-columns:1fr}.scope-column-tools{grid-template-columns:minmax(0,1fr) auto}.scope-clear-button{grid-column:2}.access-searchbar{grid-template-columns:1fr 1fr}.access-searchbar input{grid-column:1/-1}.employee-search-option{grid-template-columns:95px 1fr}.account-batch-toolbar{align-items:stretch;flex-direction:column}.account-batch-row{grid-template-columns:23px minmax(0,1fr) auto}}
      `}</style>

      <div className="page-toolbar">
        <h1>{adminT(sectionTitle)}</h1>
      </div>

      <AdminModuleNav />

      {accountToast && <div className={`access-toast ${accountToast.type === 'error' ? 'error' : ''}`} role="status" aria-live="polite"><span>{accountToast.message}</span><button type="button" aria-label="关闭提示" onClick={() => setAccountToast(null)}>×</button></div>}

      {error && <div className="page-error">{error}</div>}

      {visibleTab && visibleTab !== 'roles' && <div className="access-searchbar">
        <label><span>{adminT(visibleTab === 'backend' ? '用户名' : '登录邮箱')}</span><input value={accessSearchDraft.account}
          onChange={e => setAccessSearchDraft(current => ({ ...current, account:e.target.value }))}
          onKeyDown={e => e.key === 'Enter' && applyAccessSearch()}
          placeholder={adminT(visibleTab === 'backend' ? '输入后台用户名' : '输入员工登录邮箱')} /></label>
        <label><span>{adminT('员工')}</span><input value={accessSearchDraft.employee}
          onChange={e => setAccessSearchDraft(current => ({ ...current, employee:e.target.value }))}
          onKeyDown={e => e.key === 'Enter' && applyAccessSearch()}
          placeholder={adminT('输入员工ID或姓名')} /></label>
        <label><span>{adminT(visibleTab === 'backend' ? '角色 / 范围 / 创建人' : '团队 / 岗位')}</span><input value={accessSearchDraft.context}
          onChange={e => setAccessSearchDraft(current => ({ ...current, context:e.target.value }))}
          onKeyDown={e => e.key === 'Enter' && applyAccessSearch()}
          placeholder={adminT(visibleTab === 'backend' ? '输入角色、管理范围或创建人' : '输入团队或岗位')} /></label>
        {visibleTab === 'backend' && (!recoveryAccountMode || recoveryAccountFilters.has('status')) && <label><span>{adminT('账号状态')}</span>
          <select value={accessSearchDraft.status || 'all'} onChange={e => setAccessSearchDraft(current => ({ ...current, status:e.target.value }))}>
            <option value="all">{adminT('全部状态')}</option>
            <option value="active">{adminT('启用')}</option>
            <option value="inactive">{adminT('停用')}</option>
          </select>
        </label>}
        <button className="primary-action" onClick={applyAccessSearch}>{adminT('查询')}</button>
        <button className="secondary-action" onClick={resetAccessSearch}>{adminT('重置')}</button>
        {((visibleTab === 'backend' && canCreateBackend) || (visibleTab === 'staff' && canCreateStaff)) && <button className="primary-action" onClick={visibleTab === 'backend' ? openCreate : openCreateStaff}>
          {adminT(visibleTab === 'backend' ? '＋ 新增后台账号' : '＋ 新增员工账号')}
        </button>}
      </div>}

      {loading ? <div className="data-card"><div className="empty-state">{adminT('读取中...')}</div></div> : (
        <>
          {visibleTab === 'backend' && (
            <div className="data-card table-scroll">
              <table className="data-table">
                <thead><tr><th>{adminT('用户名')}</th><th>{adminT('关联员工ID')}</th><th>{adminT('姓名')}</th><th>{adminT('角色')}</th><th>{adminT('范围')}</th><th>OTP</th><th>{adminT('状态')}</th><th>{adminT('创建人')}</th><th>{adminT('创建时间')}</th><th>{adminT('操作')}</th></tr></thead>
                <tbody>
                  {visibleBackend.map(a => {
                    const role = getRole(a)
                    const founder = role?.code === 'founder'
                    const deleting = deletingAccountId === a.auth_user_id
                    const mutating = mutatingAccountId === a.auth_user_id
                    return <tr key={a.auth_user_id} className={deleting ? 'access-account-row-deleting' : ''} aria-busy={(deleting || mutating) || undefined}>
                      <td><strong>{a.login_username || '-'}</strong></td>
                      <td><strong>{a.employee?.employee_no || adminT('未关联')}</strong></td>
                      <td>{a.employee?.full_name || '-'}</td>
                      <td>{role?.name || '-'}</td>
                      <td>{adminT(scopeLabel(a.data_scope))}</td>
                      <td>
                        {!founder && canToggleOtp
                          ? <button disabled={mutating} className={`switch-button ${a.otp_required ? 'on' : ''}`} onClick={() => toggleOtp(a)}><i/><span>{a.otp_required ? '开' : '关'}</span></button>
                          : <span className={`status-chip ${a.otp_required ? '' : 'off'}`}>{adminT(a.otp_required ? '开启' : '关闭')}</span>}
                      </td>
                      <td><span className={`status-chip ${a.active ? '' : 'off'}`}>{adminT(a.active ? '正常' : '停用')}</span></td>
                      <td><strong>{a.account_created_by_label || adminT('系统 / 历史导入')}</strong></td>
                      <td style={{whiteSpace:'nowrap'}}>{accountDateTime(a.created_at)}</td>
                      <td><div className="access-grid-actions">
                        {!founder && canEditBackend && <button disabled={deleting || mutating} onClick={() => openEdit(a)}>{adminT('编辑')}</button>}
                        {!founder && canResetBackendPassword && <button disabled={deleting || mutating} onClick={() => resetPassword(a)}>{adminT(mutating ? '处理中…' : '重置密码')}</button>}
                        {!founder && canResetBackendMfa && <button disabled={deleting || mutating} onClick={() => resetMfa(a)}>{adminT(mutating ? '处理中…' : '重置OTP')}</button>}
                        {!founder && canToggleBackend && <button disabled={deleting || mutating} onClick={() => toggleActive(a)}>{adminT(mutating ? '处理中…' : a.active ? '停用' : '启用')}</button>}
                        {!founder && canDeleteBackend && <button disabled={deleting || mutating} className="danger" onClick={() => deleteAccount(a, 'backend')}>{adminT(deleting ? '删除中…' : '删除账号')}</button>}
                      </div></td>
                    </tr>
                  })}
                </tbody>
              </table>
              {recoveryAccountMode && <div className="recovery-account-note">
                <span><strong>稳定恢复模式</strong>：账号列表固定每页 20 条；拥有对应权限的账号可操作其可管理角色与范围内的账号。编辑、删除与批量创建继续暂停。</span>
                <div className="recovery-account-pager">
                  <button type="button" disabled={accountPage <= 1 || loading} onClick={() => refreshRecoveryAccountPage(accessSearchQuery, accountPage - 1)}>上一页</button>
                  <span>{accountTotal} 条 · {accountPage} / {accountPageCount} 页</span>
                  <button type="button" disabled={accountPage >= accountPageCount || loading} onClick={() => refreshRecoveryAccountPage(accessSearchQuery, accountPage + 1)}>下一页</button>
                </div>
              </div>}
            </div>
          )}

          {visibleTab === 'staff' && (
            <div className="data-card table-scroll">
              {staff.length === 0 ? <div className="empty-state">{adminT('暂无员工账号')}</div> :
              <table className="data-table">
                <thead><tr><th>{adminT('登录邮箱')}</th><th>{adminT('员工ID')}</th><th>{adminT('姓名')}</th><th>{adminT('团队')}</th><th>{adminT('岗位')}</th><th>{adminT('状态')}</th><th>{adminT('激活时间')}</th><th>{adminT('操作')}</th></tr></thead>
                <tbody>{visibleStaff.map(a => {
                  const deleting = deletingAccountId === a.auth_user_id
                  return <tr key={a.auth_user_id} className={deleting ? 'access-account-row-deleting' : ''} aria-busy={deleting || undefined}>
                  <td><strong>{a.login_email || '-'}</strong></td>
                  <td><strong>{a.employee?.employee_no || '-'}</strong></td>
                  <td>{a.employee?.full_name || '-'}</td>
                  <td>{a.employee?.teams?.name || '-'}</td>
                  <td>{a.employee?.positions?.name || '-'}</td>
                  <td><span className={`status-chip ${a.active ? '' : 'off'}`}>{adminT(a.active ? '正常' : '停用')}</span></td>
                  <td style={{whiteSpace:'nowrap'}}>{accountDateTime(a.created_at)}</td>
                  <td><div className="access-grid-actions">
                    {canResetStaffPassword && <button disabled={deleting} onClick={() => resetPassword(a)}>{adminT('重置密码')}</button>}
                    {canResetStaffMfa && <button disabled={deleting} onClick={() => resetMfa(a)}>{adminT('重置OTP')}</button>}
                    {canToggleStaff && <button disabled={deleting} onClick={() => toggleActive(a)}>{adminT(a.active ? '停用' : '启用')}</button>}
                    {canDeleteStaff && <button disabled={deleting} className="danger" onClick={() => deleteAccount(a, 'staff')}>{adminT(deleting ? '删除中…' : '删除登录账号')}</button>}
                  </div></td>
                </tr>})}</tbody>
              </table>}
            </div>
          )}

          {visibleTab === 'roles' && (
            <div className="roles-workspace">
              {recoveryRoleMode && <div className="recovery-account-note"><span><strong>稳定恢复模式</strong>：Founder 可勾选并保存现有角色权限，其他账号保持只读；角色新增、改名和删除继续暂停。</span></div>}
              <div className="roles-overview">
                <div className="roles-overview-copy">
                  <span>ACCESS CONTROL</span>
                  <h2>{adminT('按模块、页面和具体操作配置权限')}</h2>
                </div>
                <div className="roles-overview-stats">
                  <div><strong>{visibleRoles.length}</strong><small>{adminT('当前角色')}</small></div>
                  <div><strong>{catalogPermissions.length}</strong><small>{adminT('可独立配置')}</small></div>
                  <div><strong>{catalogPermissions.filter(permission => permission.sensitive).length}</strong><small>{adminT('敏感权限')}</small></div>
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
                {callerFounder && !recoveryRoleMode && <div className="create-role-row">
                  <input placeholder={adminT('输入新角色名称')} value={newRoleName} onChange={e => setNewRoleName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && createRole()} />
                  <button className="primary-action" onClick={createRole} disabled={creatingRole}>{adminT(creatingRole ? '新增中…' : '＋ 新增角色')}</button>
                </div>}
              </div>

              <div className="role-list">
                {visibleRoles.map(role => {
                  const grantedIds = role.code === 'founder'
                    ? new Set(permissions.map(permission => permission.id))
                    : rolePermissionMap.get(role.id) || new Set()
                  const grantedCount = role.code === 'founder'
                    ? catalogPermissionIds.length
                    : catalogPermissionIds.filter(permissionId => grantedIds.has(permissionId)).length
                  const sectionLabels = groupedPermissionSections
                    .filter(section => section.pages.some(page =>
                      page.items.some(permission => role.code === 'founder' || grantedIds.has(permission.id))
                      || (page.pendingItems || []).some(permission => role.code === 'founder' || grantedIds.has(permission.id))))
                    .map(section => adminT(section.label))
                  const progress = catalogPermissionIds.length ? Math.round((grantedCount / catalogPermissionIds.length) * 100) : 0

                  return <div className="role-card" key={role.id}>
                    <div className="role-card-head">
                      <div className="role-card-title">
                        <span className="role-avatar">{String(role.name || '角').trim().slice(0, 1).toUpperCase()}</span>
                        <div><h3>{role.name}</h3><small>{role.code} · {adminT(role.system_locked ? '系统角色' : '自定义角色')}</small></div>
                      </div>
                      {role.system_locked && <span className="role-lock">{adminT('锁定')}</span>}
                    </div>
                    <div className="role-permission-summary">
                      <div><span>{adminT('独立授权项目')}</span><strong>{grantedCount} / {catalogPermissionIds.length}</strong></div>
                      <div className="role-progress"><i style={{width:`${progress}%`}} /></div>
                      <div className="role-module-tags">
                        {sectionLabels.slice(0, 3).map(label => <span key={label}>{label}</span>)}
                        {sectionLabels.length > 3 && <span className="more">+{sectionLabels.length - 3} {adminT('个模块', 'modules')}</span>}
                        {sectionLabels.length === 0 && <small>{adminT('尚未配置任何页面权限')}</small>}
                      </div>
                    </div>
                    <div className="role-card-actions">
                      <button className="primary" onClick={() => openRole(role)}>{adminT(role.code === 'founder' ? '查看固定权限' : canSaveRolePermissions && (!recoveryRoleMode || (!role.system_locked && role.active !== false)) ? '配置权限' : '查看权限')}</button>
                      {callerFounder&&!recoveryRoleMode&&!role.system_locked && <button className="danger" onClick={() => deleteRole(role)}>{adminT('删除角色')}</button>}
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
            <div className="account-session-note"><strong>范围与登录</strong><span>关联员工只提供身份与团队上下文；管理范围选择“全部数据”时不会自动降级为“自己团队”。同一个后台账号同时只保留一个浏览器会话，新设备登录会结束旧设备会话。</span></div>
            {recoveryAccountMode && <div className="account-session-note"><strong>稳定恢复模式</strong><span>当前一次只创建 1 个账号，并只显示服务端确认可委派的角色与范围；指定团队范围将在完整范围选择器安全恢复后再开放。</span></div>}
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
                  {modalRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                {accountModal.mode === 'create' && modalRoles.length === 0 && <small>当前角色尚未获授权创建任何下级角色账号。</small>}
              </label>

              <label>管理范围
                <select disabled={accountModal.mode === 'edit' && !canManageScope} value={accountModal.form.data_scope} onChange={e => setAccountModal(x => ({...x, form:{...x.form, data_scope:e.target.value}}))}>
                  {recoverySupportedScopes.has('self') && <option value="self" disabled={!accountModal.form.employee_id}>仅关联员工本人</option>}
                  {recoverySupportedScopes.has('own_team') && <option value="own_team" disabled={!accountModal.form.employee_id}>关联员工所在团队</option>}
                  {recoverySupportedScopes.has('assigned_teams') && <option value="assigned_teams">指定团队 / 岗位 / 指定员工</option>}
                  {recoverySupportedScopes.has('all') && <option value="all">全部数据</option>}
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
                  <div className="scope-current-team-note">
                    <strong>范围计算规则</strong>
                    <span>已选团队是硬边界。基础范围 = 已选团队 ∩ 可选岗位；不选岗位表示团队内全部当前人员。指定员工只能从已选团队内补充，不能查看任何团队外数据；所有页面和预警中心都按同一结果限制。</span>
                  </div>
                  <div className={`scope-current-team-note ${(accountModal.removedStaleTeamIds || []).length ? 'warning' : ''}`}>
                    <strong>{(accountModal.removedStaleTeamIds || []).length ? '已自动清理' : '当前团队口径'}</strong>
                    <span>{(accountModal.removedStaleTeamIds || []).length
                      ? `本账号有 ${accountModal.removedStaleTeamIds.length} 个旧名、已移除或当前无排班成员的历史团队，已从本次选择中剔除；保存后不会恢复。`
                      : '团队清单只读取当前居家排班 / 当前组织目录；旧名、已移除或当前无排班成员的历史团队不会显示，服务端也不会接受保存。'}</span>
                  </div>
                  {(ambiguousScopeTeamNames.length > 0 || ambiguousScopePositionNames.length > 0 || unmatchedScopeRowCount > 0) && <div className="scope-current-team-note warning">
                    <strong>已安全排除</strong>
                    <span>当前排班中有 {unmatchedScopeRowCount} 条员工/组织映射未完成，已按无权限处理。{ambiguousScopeTeamNames.length > 0 && ` 重名团队：${ambiguousScopeTeamNames.join('、')}（已排除）。`}{ambiguousScopePositionNames.length > 0 && ` 重名岗位：${ambiguousScopePositionNames.join('、')}（已合并为唯一标准岗位）。`}请后续清理组织目录重复项。</span>
                  </div>}
                  <div className="scope-columns">
                    <div className="scope-column">
                      <div className="scope-column-head"><strong>团队</strong><span>已选 {scopeTeamIds.length}</span></div>
                      <div className="scope-column-tools">
                        <input className="scope-search" placeholder="搜索团队" value={accountModal.form.scope_team_search} onChange={e=>setAccountModal(x=>({...x,form:{...x.form,scope_team_search:e.target.value}}))}/>
                        <button type="button" className={`scope-filter-button ${accountModal.form.scope_team_selected_only ? 'active' : ''}`} onClick={()=>setAccountModal(x=>({...x,form:{...x.form,scope_team_selected_only:!x.form.scope_team_selected_only}}))}>只看已选</button>
                        <button type="button" className="scope-clear-button" disabled={!scopeCanEdit || scopeTeamIds.length === 0} onClick={()=>clearScopeIds('team_ids')}>清空</button>
                      </div>
                      {selectedScopeTeams.length > 0 ? <div className="scope-selected-list" aria-label="已选团队">
                        {selectedScopeTeams.map(team => <span className="scope-chip" key={team.id}><span title={team.name}>{team.name}</span><button type="button" aria-label={`移除团队 ${team.name}`} disabled={!scopeCanEdit} onClick={()=>updateScopeIds('team_ids', team.id, false)}>×</button></span>)}
                      </div> : <div className="scope-selection-empty">尚未选择团队</div>}
                      <div className="check-list">
                        {teams.length === 0 ? <div className="empty-state">暂无团队</div> : visibleScopeTeams.length === 0 ? <div className="empty-state">没有匹配的团队</div> : visibleScopeTeams.map(team => (
                          <label className={scopeTeamIdSet.has(team.id) ? 'scope-row-selected' : ''} key={team.id}><input className="scope-check" type="checkbox"
                            disabled={!scopeCanEdit}
                            checked={scopeTeamIdSet.has(team.id)}
                            onChange={event => updateScopeIds('team_ids', team.id, event.target.checked)}
                          /><span title={team.name}>{team.name}</span><small>当前排班 {teamActiveCounts.get(team.id) || 0} 人</small></label>
                        ))}
                      </div>
                    </div>
                    <div className="scope-column">
                      <div className="scope-column-head"><strong>岗位（收窄团队）</strong><span>已选 {scopePositionIds.length}</span></div>
                      <div className="scope-column-tools">
                        <input className="scope-search" placeholder="搜索岗位" value={accountModal.form.scope_position_search} onChange={e=>setAccountModal(x=>({...x,form:{...x.form,scope_position_search:e.target.value}}))}/>
                        <button type="button" className={`scope-filter-button ${accountModal.form.scope_position_selected_only ? 'active' : ''}`} onClick={()=>setAccountModal(x=>({...x,form:{...x.form,scope_position_selected_only:!x.form.scope_position_selected_only}}))}>只看已选</button>
                        <button type="button" className="scope-clear-button" disabled={!scopeCanEdit || scopePositionIds.length === 0} onClick={()=>clearScopeIds('position_ids')}>清空</button>
                      </div>
                      {selectedScopePositions.length > 0 ? <div className="scope-selected-list" aria-label="已选岗位">
                        {selectedScopePositions.map(position => <span className="scope-chip" key={position.id}><span title={position.name}>{position.name}</span><button type="button" aria-label={`移除岗位 ${position.name}`} disabled={!scopeCanEdit} onClick={()=>updateScopeIds('position_ids', position.id, false)}>×</button></span>)}
                      </div> : <div className="scope-selection-empty">未选岗位：将包含已选团队的全部岗位</div>}
                      <div className="check-list">
                        {!scopeTeamIds.length ? <div className="empty-state">请先选择团队</div> : eligibleScopePositions.length === 0 ? <div className="empty-state">所选团队当前没有可用岗位</div> : visibleScopePositions.length === 0 ? <div className="empty-state">没有匹配的岗位</div> : visibleScopePositions.map(position => (
                          <label className={scopePositionIdSet.has(position.id) ? 'scope-row-selected' : ''} key={position.id}><input className="scope-check" type="checkbox"
                            disabled={!scopeCanEdit}
                            checked={scopePositionIdSet.has(position.id)}
                            onChange={event => updateScopeIds('position_ids', position.id, event.target.checked)}
                          /><span title={position.name}>{position.name}</span><small>所选团队 {selectedTeamPositionCounts.get(position.id) || 0} 人</small></label>
                        ))}
                      </div>
                    </div>
                    <div className="scope-column">
                      <div className="scope-column-head"><strong>指定员工（团队内补充）</strong><span>已选 {scopeEmployeeIds.length}</span></div>
                      <div className="scope-column-tools">
                        <input className="scope-search" placeholder="搜索员工ID或姓名" value={accountModal.form.scope_employee_search} onChange={e=>setAccountModal(x=>({...x,form:{...x.form,scope_employee_search:e.target.value}}))}/>
                        <button type="button" className={`scope-filter-button ${accountModal.form.scope_employee_selected_only ? 'active' : ''}`} onClick={()=>setAccountModal(x=>({...x,form:{...x.form,scope_employee_selected_only:!x.form.scope_employee_selected_only}}))}>只看已选</button>
                        <button type="button" className="scope-clear-button" disabled={!scopeCanEdit || scopeEmployeeIds.length === 0} onClick={()=>clearScopeIds('employee_ids')}>清空</button>
                      </div>
                      {selectedScopeEmployees.length > 0 ? <div className="scope-selected-list" aria-label="已选员工">
                        {selectedScopeEmployees.map(employee => <span className="scope-chip" key={employee.id}><span title={`${employee.employee_no} · ${employee.full_name}`}>{employee.employee_no} · {employee.full_name}</span><button type="button" aria-label={`移除员工 ${employee.employee_no}`} disabled={!scopeCanEdit} onClick={()=>updateScopeIds('employee_ids', employee.id, false)}>×</button></span>)}
                      </div> : <div className="scope-selection-empty">尚未选择指定员工</div>}
                      <div className="check-list">
                        {!scopeTeamIds.length ? <div className="empty-state">请先选择团队</div> : eligibleScopeEmployees.length === 0 ? <div className="empty-state">所选团队当前没有人员</div> : visibleScopeEmployees.length === 0 ? <div className="empty-state">没有匹配的员工</div> : visibleScopeEmployees.map(employee => (
                          <label className={scopeEmployeeIdSet.has(employee.id) ? 'scope-row-selected' : ''} key={employee.id}><input className="scope-check" type="checkbox"
                            disabled={!scopeCanEdit}
                            checked={scopeEmployeeIdSet.has(employee.id)}
                            onChange={event => updateScopeIds('employee_ids', employee.id, event.target.checked)}
                          /><span title={`${employee.employee_no} · ${employee.full_name}`}>{employee.employee_no} · {employee.full_name}</span><small>{employee.teams?.name || '未分团队'}</small></label>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

              {accountModal.mode === 'create' && !recoveryAccountMode && <div className="account-batch-builder">
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
              <button className="primary-action" disabled={accountModal.saving} onClick={saveAccount}>{accountModal.saving?'处理中…':accountModal.mode === 'create' ? (!recoveryAccountMode && accountModal.batch.length ? `创建 ${accountModal.batch.length} 个账号` : '创建当前账号') : '保存'}</button>
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
                  <p>{adminT(roleReadOnly?'当前账号仅可查看角色权限，修改操作仅限 Founder。':'按最新左侧菜单、子页面和具体操作逐项授权；带“敏感”标记的权限请谨慎开放。')}</p>
                </div>
              </div>
              <button aria-label="关闭" disabled={roleModal.saving} onClick={() => setRoleModal(null)}>×</button>
            </div>

            <div className="role-modal-body">
              {roleModal.error && <div className="page-error">{roleModal.error}</div>}

              <div className="role-identity-panel">
                <label className="role-name-field"><span>{adminT('角色名称')}</span>
                  <input disabled={roleReadOnly||recoveryRoleMode||roleModal.role.system_locked} value={roleModal.name}
                    onChange={e => setRoleModal(x => ({...x, name:e.target.value, error:''}))}/>
                </label>
                <div className="role-selection-summary">
                  <div><strong>{roleIsLocked ? catalogPermissions.length : catalogPermissions.filter(permission => selectedPermissionIds.has(permission.id)).length}</strong><small>{adminT('已选权限')}</small></div>
                  <div><strong>{groupedPermissionSections.filter(section => section.pages.some(page =>
                    page.items.some(permission => roleIsLocked || selectedPermissionIds.has(permission.id))
                    || (page.pendingItems || []).some(permission => roleIsLocked || selectedPermissionIds.has(permission.id)))).length}</strong><small>{adminT('已开模块')}</small></div>
                </div>
              </div>

              <div className="permission-guidance"><strong>授权说明</strong><span>模块和子页面与当前左侧菜单保持一致；每个页面的查看、新增、编辑、审批、导出或删除权限均为独立授权。Founder 固定拥有全部权限，其他角色按勾选结果生效。</span></div>

              <div className="permission-toolbar">
                <label className="permission-search"><span>⌕</span>
                  <input value={roleModal.permission_search} placeholder={adminT('搜索模块、页面、功能或权限代码')}
                    onChange={e => setRoleModal(x => ({...x, permission_search:e.target.value}))} />
                </label>
                <div className="permission-toolbar-actions">
                  {roleModal.permission_search && <button onClick={() => setRoleModal(x => ({...x, permission_search:''}))}>{adminT('清除搜索')}</button>}
                  <button disabled={roleReadOnly} onClick={() => updatePermissionSelection(catalogPermissionIds, true)}>{adminT('全部勾选')}</button>
                  <button disabled={roleReadOnly} onClick={() => updatePermissionSelection(catalogPermissionIds, false)}>{adminT('全部取消')}</button>
                  <button disabled={roleModal.collapsed_sections.length === 0} onClick={() => setRoleModal(x => ({...x, collapsed_sections:[]}))}>{adminT('全部展开')}</button>
                </div>
              </div>

              {roleIsLocked && <div className="founder-permission-note"><strong>{adminT('Founder 固定权限')}</strong><span>{adminT('创办人角色始终拥有全部页面及操作权限，系统已锁定，不能取消勾选。')}</span></div>}

              {visiblePermissionSections.length > 0 ? <div className="permission-sections">
                {visiblePermissionSections.map(section => {
                  const sourceSection = groupedPermissionSections.find(item => item.key === section.key) || section
                  const sectionPermissionIds = uniquePermissionIds(sourceSection.pages.flatMap(page => page.items))
                  const sectionSelectedCount = roleIsLocked
                    ? sectionPermissionIds.length
                    : sectionPermissionIds.filter(id => selectedPermissionIds.has(id)).length
                  const sectionCollapsed = !roleModal.permission_search && roleModal.collapsed_sections.includes(section.key)

                  return <section className={`permission-section ${sectionCollapsed ? 'collapsed' : ''}`} key={section.key}>
                    <div className="permission-section-head">
                      <label className="permission-section-head-main">
                        <input type="checkbox" disabled={roleReadOnly || sectionPermissionIds.length === 0}
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
                        const pagePermissionIds = uniquePermissionIds(sourcePage.items)
                        const pageSelectedCount = roleIsLocked
                          ? pagePermissionIds.length
                          : pagePermissionIds.filter(id => selectedPermissionIds.has(id)).length

                        return <article className="permission-page" key={page.key}>
                          <div className="permission-page-head">
                            <label className="permission-page-title">
                              <input type="checkbox" disabled={roleReadOnly || pagePermissionIds.length === 0}
                                ref={node => { if (node) node.indeterminate = pageSelectedCount > 0 && pageSelectedCount < pagePermissionIds.length }}
                                checked={pageSelectedCount === pagePermissionIds.length && pagePermissionIds.length > 0}
                                onChange={e => updatePermissionSelection(pagePermissionIds, e.target.checked)} />
                              <span><strong>{adminT(page.label)}</strong><small>{adminT(page.description)}</small></span>
                            </label>
                            <span>{pageSelectedCount}/{pagePermissionIds.length}{page.pendingItems?.length ? ` · 待拆分 ${page.pendingItems.length}` : ''}</span>
                          </div>
                          <div className="permission-options">
                            {page.items.map(permission => {
                              const checked = roleIsLocked || selectedPermissionIds.has(permission.id)
                              return <label className={`permission-option ${checked ? 'selected' : ''} ${roleReadOnly ? 'locked' : ''}`} key={permission.id}>
                                <input type="checkbox" disabled={roleReadOnly} checked={checked}
                                  onChange={e => updatePermissionSelection([permission.id], e.target.checked)} />
                                <span className="permission-option-copy"><strong>{displayPermissionName(permission)}</strong><small>{permission.code}</small></span>
                                <span className="permission-option-badges"><em className="permission-action-badge">{adminT(actionLabels[permission.actionKey] || permission.actionKey)}</em>{permission.sensitive && <em className="sensitive-badge">{adminT('敏感')}</em>}</span>
                              </label>
                            })}
                            {(page.pendingItems || []).map(permission => {
                              const checked = roleIsLocked || selectedPermissionIds.has(permission.id)
                              return <label className={`permission-option pending ${checked ? 'selected' : ''}`} title="旧共享权限尚未完成逐页面后端迁移，当前只读" key={`pending-${page.key}-${permission.id}`}>
                                <input type="checkbox" disabled readOnly checked={checked} />
                                <span className="permission-option-copy"><strong>{displayPermissionName(permission)}</strong><small>{permission.code}</small></span>
                                <span className="permission-option-badges"><em className="permission-pending-badge">待拆分 · 只读</em>{permission.sensitive && <em className="sensitive-badge">{adminT('敏感')}</em>}</span>
                              </label>
                            })}
                            {page.items.length === 0 && !page.pendingItems?.length && <div className="permission-page-pending">当前页面尚无可单独配置的操作权限。</div>}
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
