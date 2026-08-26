import { createClient } from 'npm:@supabase/supabase-js@2'
import { decideBackendDataScope, delegatedBackendDataScopeError } from './scope.ts'

const allowedOrigin = 'https://adrianus898989.github.io'

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin === allowedOrigin ? origin : allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(req.headers.get('origin')),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

function passwordOk(p: string) {
  return p.length >= 10 &&
    /[A-Z]/.test(p) &&
    /[a-z]/.test(p) &&
    /[0-9]/.test(p) &&
    /[^A-Za-z0-9]/.test(p)
}

function cleanString(v: unknown) {
  return String(v ?? '').trim()
}

function cleanStringList(v: unknown) {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map(cleanString).filter(Boolean))]
}

function jwtSessionId(authorization: string) {
  const token = authorization.replace(/^Bearer\s+/i, '').trim()
  const payloadPart = token.split('.')[1]
  if (!payloadPart) return ''
  try {
    const base64 = payloadPart.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    return cleanString(JSON.parse(atob(padded))?.session_id)
  } catch {
    return ''
  }
}

async function sha256(text: string) {
  const data = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors(req.headers.get('origin')) })
  }
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
    const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
    const secretKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const publishableKey = publishableKeys.default || Deno.env.get('SUPABASE_ANON_KEY')

    if (!supabaseUrl || !secretKey || !publishableKey) {
      return json(req, { error: '服务配置缺失' }, 500)
    }

    const authorization = req.headers.get('Authorization') || ''

    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return json(req, { error: '登录已失效' }, 401)
    const authenticatedUser = userData.user

    const admin = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const sessionId = jwtSessionId(authorization)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return json(req, { error: '当前登录会话无效，请重新登录' }, 401)
    }

    const { data: sessionLease, error: sessionLeaseError } = await admin
      .from('app_session_leases')
      .select('session_id,portal,lease_expires_at')
      .eq('user_id', userData.user.id)
      .maybeSingle()

    if (sessionLeaseError) return json(req, { error: '无法验证当前浏览器会话' }, 500)
    const leaseExpiresAt = Date.parse(sessionLease?.lease_expires_at || '')
    if (!sessionLease ||
      cleanString(sessionLease.session_id).toLowerCase() !== sessionId.toLowerCase() ||
      sessionLease.portal !== 'admin' ||
      !Number.isFinite(leaseExpiresAt) ||
      leaseExpiresAt <= Date.now()) {
      return json(req, { error: '当前浏览器会话已失效或账号已在其他设备登录' }, 401)
    }

    const { data: caller, error: callerError } = await admin
      .from('user_access')
      .select('auth_user_id,employee_id,role_id,data_scope,backend_enabled,active,roles(id,code,name)')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle()

    if (callerError || !caller || !caller.active || !caller.backend_enabled) {
      return json(req, { error: '无后台权限' }, 403)
    }
    const activeCaller = caller

    const callerRole = Array.isArray(caller.roles) ? caller.roles[0] : caller.roles
    const isFounder = callerRole?.code === 'founder'

    const { data: callerRp, error: callerRpError } = await admin
      .from('role_permissions')
      .select('permission_id,permissions(code)')
      .eq('role_id', caller.role_id)

    const { data: callerOverrides, error: callerOverridesError } = await admin
      .from('user_permission_overrides')
      .select('allowed,permission_id,permissions(code)')
      .eq('auth_user_id', userData.user.id)

    if (callerRpError || callerOverridesError) {
      console.error('permission bootstrap failed', callerRpError || callerOverridesError)
      return json(req, { error: '无法验证当前账号权限' }, 500)
    }

    const rolePerms = new Set<string>()
    for (const row of callerRp || []) {
      const p = Array.isArray(row.permissions) ? row.permissions[0] : row.permissions
      if (p?.code) rolePerms.add(p.code)
    }

    const overrideMap = new Map<string, boolean>()
    for (const row of callerOverrides || []) {
      const p = Array.isArray(row.permissions) ? row.permissions[0] : row.permissions
      if (p?.code) overrideMap.set(p.code, Boolean(row.allowed))
    }

    const callerEffectivePermissions = new Set(rolePerms)
    overrideMap.forEach((allowed, code) => {
      if (allowed) callerEffectivePermissions.add(code)
      else callerEffectivePermissions.delete(code)
    })

    const can = (code: string) => {
      if (isFounder) return true
      return callerEffectivePermissions.has(code)
    }

    const audit = async (action: string, reason: string) => {
      await admin.from('audit_logs').insert({
        actor_user_id: userData.user.id,
        employee_id: caller.employee_id || null,
        module: 'access_control',
        action,
        reason,
      })
    }

    const body = await req.json()
    const action = cleanString(body.action || 'bootstrap')

    const rolePermissionCache = new Map<string, Promise<Set<string>>>()

    async function getRolePermissionCodes(roleId: string) {
      if (!rolePermissionCache.has(roleId)) {
        rolePermissionCache.set(roleId, (async () => {
          const { data, error } = await admin.from('role_permissions')
            .select('permissions(code)')
            .eq('role_id', roleId)
          if (error) throw error
          const codes = new Set<string>()
          for (const row of data || []) {
            const permission = Array.isArray(row.permissions) ? row.permissions[0] : row.permissions
            if (permission?.code) codes.add(permission.code)
          }
          return codes
        })())
      }
      return rolePermissionCache.get(roleId)!
    }

    async function getAccountPermissionCodes(targetAuthUserId: string, roleId: string) {
      const roleCodes = await getRolePermissionCodes(roleId)
      const result = new Set(roleCodes)
      const { data: overrides, error } = await admin.from('user_permission_overrides')
        .select('allowed,permissions(code)')
        .eq('auth_user_id', targetAuthUserId)
      if (error) throw error
      for (const row of overrides || []) {
        const permission = Array.isArray(row.permissions) ? row.permissions[0] : row.permissions
        if (!permission?.code) continue
        if (row.allowed) result.add(permission.code)
        else result.delete(permission.code)
      }
      return result
    }

    function permissionsWithinCaller(permissionCodes: Set<string>, strict = false) {
      if (isFounder) return true
      for (const code of permissionCodes) {
        if (!callerEffectivePermissions.has(code)) return false
      }
      return !strict || permissionCodes.size < callerEffectivePermissions.size
    }

    async function roleCanBeAssigned(roleId: string, targetAuthUserId = '') {
      if (isFounder) return true
      const permissionCodes = targetAuthUserId
        ? await getAccountPermissionCodes(targetAuthUserId, roleId)
        : await getRolePermissionCodes(roleId)
      return permissionsWithinCaller(permissionCodes, true)
    }

    let scopeContextPromise: Promise<any> | null = null

    async function getAllEmployeeRows() {
      const pageSize = 1000
      const rows: any[] = []

      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await admin.from('employees')
          .select('id,employee_no,full_name,status,team_id,position_id,hire_date,resign_date,country,nationality,employment_type,shift_name,source_type,profile_status,created_at,updated_at,teams(id,name),positions(id,name)')
          .order('employee_no')
          .order('id')
          .range(offset, offset + pageSize - 1)
        if (error) throw error

        const page = data || []
        rows.push(...page)
        if (page.length < pageSize) return rows
      }
    }

    async function getScopeContext() {
      if (scopeContextPromise) return scopeContextPromise
      scopeContextPromise = (async () => {
        const [allEmployees, teamRes, scopeTeamRes, scopeEmployeeRes] = await Promise.all([
          getAllEmployeeRows(),
          admin.from('teams').select('id,name').order('name').limit(5000),
          admin.from('user_scope_teams').select('team_id').eq('auth_user_id', authenticatedUser.id),
          admin.from('user_scope_employees').select('employee_id').eq('auth_user_id', authenticatedUser.id),
        ])

        if (teamRes.error) throw teamRes.error
        if (scopeTeamRes.error) throw scopeTeamRes.error
        if (scopeEmployeeRes.error) throw scopeEmployeeRes.error

        const allTeams = teamRes.data || []
        const employeeMap = new Map(allEmployees.map((employee: any) => [employee.id, employee]))
        const allTeamIds = new Set(allTeams.map((team: any) => team.id))
        const allowedEmployeeIds = new Set<string>()
        const delegableTeamIds = new Set<string>()

        if (isFounder || activeCaller.data_scope === 'all') {
          allEmployees.forEach((employee: any) => allowedEmployeeIds.add(employee.id))
          allTeams.forEach((team: any) => delegableTeamIds.add(team.id))
        } else if (activeCaller.data_scope === 'self') {
          if (activeCaller.employee_id && employeeMap.has(activeCaller.employee_id)) {
            allowedEmployeeIds.add(activeCaller.employee_id)
          }
        } else if (activeCaller.data_scope === 'own_team') {
          const me: any = activeCaller.employee_id ? employeeMap.get(activeCaller.employee_id) : null
          if (me?.team_id) {
            delegableTeamIds.add(me.team_id)
            allEmployees.forEach((employee: any) => {
              if (employee.team_id === me.team_id) allowedEmployeeIds.add(employee.id)
            })
          }
        } else if (activeCaller.data_scope === 'assigned_teams') {
          const assignedTeamIds = new Set((scopeTeamRes.data || []).map((row: any) => row.team_id))
          const assignedEmployeeIds = new Set((scopeEmployeeRes.data || []).map((row: any) => row.employee_id))
          assignedTeamIds.forEach((teamId: string) => {
            if (allTeamIds.has(teamId)) delegableTeamIds.add(teamId)
          })
          allEmployees.forEach((employee: any) => {
            if (assignedTeamIds.has(employee.team_id) || assignedEmployeeIds.has(employee.id)) {
              allowedEmployeeIds.add(employee.id)
            }
          })
        }

        return { allEmployees, allTeams, employeeMap, allTeamIds, allowedEmployeeIds, delegableTeamIds }
      })()
      return scopeContextPromise
    }

    async function getScopedEmployees(activeOnly = true) {
      const scope = await getScopeContext()
      return scope.allEmployees.filter((employee: any) =>
        scope.allowedEmployeeIds.has(employee.id) && (!activeOnly || employee.status === 'active')
      )
    }

    async function requireEmployeeInScope(employeeId: string) {
      const scope = await getScopeContext()
      const employee = scope.employeeMap.get(employeeId)
      if (!employee || !scope.allowedEmployeeIds.has(employeeId)) {
        throw new Error('找不到员工或无操作权限')
      }
      return employee
    }

    async function validateDelegatedScope(
      employeeId: string | null,
      dataScope: string,
      teamIds: string[],
      employeeIds: string[],
    ) {
      const scope = await getScopeContext()

      const delegationError = delegatedBackendDataScopeError(isFounder, dataScope, employeeId)
      if (delegationError === 'founder_required') {
        throw new Error('只有 Founder 可以授予全部数据范围')
      }
      if (delegationError === 'employee_required') {
        throw new Error('非 Founder 创建或编辑账号时必须关联可管理的员工档案')
      }
      if (employeeId) await requireEmployeeInScope(employeeId)

      if (dataScope === 'self' && !employeeId) {
        throw new Error('“仅本人”范围必须关联员工档案')
      }

      if (dataScope === 'own_team') {
        if (!employeeId) throw new Error('“自己团队”范围必须关联员工档案')
        const employee: any = scope.employeeMap.get(employeeId)
        if (!employee?.team_id) throw new Error('关联员工尚未设置团队，不能授予“自己团队”范围')
        if (!isFounder && !scope.delegableTeamIds.has(employee.team_id)) {
          throw new Error('关联员工所在团队超出当前账号可授权范围')
        }
      }

      if (dataScope === 'assigned_teams') {
        if (!teamIds.length && !employeeIds.length) {
          throw new Error('指定范围至少选择一个团队或一名员工')
        }
        const invalidTeam = teamIds.find(teamId =>
          !scope.allTeamIds.has(teamId) || (!isFounder && !scope.delegableTeamIds.has(teamId))
        )
        if (invalidTeam) throw new Error('选择的团队超出当前账号可授权范围')

        const invalidEmployee = employeeIds.find(scopedEmployeeId =>
          !scope.employeeMap.has(scopedEmployeeId) || (!isFounder && !scope.allowedEmployeeIds.has(scopedEmployeeId))
        )
        if (invalidEmployee) throw new Error('选择的员工超出当前账号可授权范围')
      }
    }

    async function readScope(targetAuthUserId: string) {
      const [teamRes, employeeRes] = await Promise.all([
        admin.from('user_scope_teams').select('team_id').eq('auth_user_id', targetAuthUserId),
        admin.from('user_scope_employees').select('employee_id').eq('auth_user_id', targetAuthUserId),
      ])
      if (teamRes.error) throw teamRes.error
      if (employeeRes.error) throw employeeRes.error
      return {
        teamIds: (teamRes.data || []).map((row: any) => row.team_id),
        employeeIds: (employeeRes.data || []).map((row: any) => row.employee_id),
      }
    }

    async function restoreScope(targetAuthUserId: string, previous: { teamIds: string[], employeeIds: string[] }) {
      const current = await readScope(targetAuthUserId)
      const previousTeams = new Set(previous.teamIds)
      const previousEmployees = new Set(previous.employeeIds)
      const currentTeams = new Set(current.teamIds)
      const currentEmployees = new Set(current.employeeIds)
      const extraTeams = current.teamIds.filter(teamId => !previousTeams.has(teamId))
      const extraEmployees = current.employeeIds.filter(employeeId => !previousEmployees.has(employeeId))
      const missingTeams = previous.teamIds.filter(teamId => !currentTeams.has(teamId))
      const missingEmployees = previous.employeeIds.filter(employeeId => !currentEmployees.has(employeeId))

      if (extraTeams.length) {
        const { error } = await admin.from('user_scope_teams')
          .delete().eq('auth_user_id', targetAuthUserId).in('team_id', extraTeams)
        if (error) throw error
      }
      if (extraEmployees.length) {
        const { error } = await admin.from('user_scope_employees')
          .delete().eq('auth_user_id', targetAuthUserId).in('employee_id', extraEmployees)
        if (error) throw error
      }
      if (missingTeams.length) {
        const { error } = await admin.from('user_scope_teams').insert(
          missingTeams.map(team_id => ({ auth_user_id: targetAuthUserId, team_id }))
        )
        if (error) throw error
      }
      if (missingEmployees.length) {
        const { error } = await admin.from('user_scope_employees').insert(
          missingEmployees.map(employee_id => ({ auth_user_id: targetAuthUserId, employee_id }))
        )
        if (error) throw error
      }
    }

    async function saveScope(targetAuthUserId: string, teamIds: string[], employeeIds: string[]) {
      const desiredTeams = cleanStringList(teamIds)
      const desiredEmployees = cleanStringList(employeeIds)
      const previous = await readScope(targetAuthUserId)
      const previousTeams = new Set(previous.teamIds)
      const previousEmployees = new Set(previous.employeeIds)
      const desiredTeamSet = new Set(desiredTeams)
      const desiredEmployeeSet = new Set(desiredEmployees)
      const teamsToAdd = desiredTeams.filter(teamId => !previousTeams.has(teamId))
      const employeesToAdd = desiredEmployees.filter(employeeId => !previousEmployees.has(employeeId))
      const teamsToDelete = previous.teamIds.filter(teamId => !desiredTeamSet.has(teamId))
      const employeesToDelete = previous.employeeIds.filter(employeeId => !desiredEmployeeSet.has(employeeId))

      try {
        if (teamsToAdd.length) {
          const { error } = await admin.from('user_scope_teams').insert(
            teamsToAdd.map(team_id => ({ auth_user_id: targetAuthUserId, team_id }))
          )
          if (error) throw error
        }
        if (employeesToAdd.length) {
          const { error } = await admin.from('user_scope_employees').insert(
            employeesToAdd.map(employee_id => ({ auth_user_id: targetAuthUserId, employee_id }))
          )
          if (error) throw error
        }

        // Destructive removals are deliberately last. On any failure, restore the exact previous mapping.
        if (teamsToDelete.length) {
          const { error } = await admin.from('user_scope_teams')
            .delete().eq('auth_user_id', targetAuthUserId).in('team_id', teamsToDelete)
          if (error) throw error
        }
        if (employeesToDelete.length) {
          const { error } = await admin.from('user_scope_employees')
            .delete().eq('auth_user_id', targetAuthUserId).in('employee_id', employeesToDelete)
          if (error) throw error
        }
      } catch (error) {
        try {
          await restoreScope(targetAuthUserId, previous)
        } catch (rollbackError) {
          console.error('scope rollback failed', rollbackError)
          throw new Error('管理范围保存失败且自动回滚未完整完成，请立即联系 Founder 检查该账号')
        }
        throw error
      }

      return previous
    }

    async function getTargetAccount(targetAuthUserId: string) {
      const { data: targetAccess, error } = await admin.from('user_access')
        .select('auth_user_id,employee_id,role_id,data_scope,backend_enabled,employee_portal_enabled,roles(id,code,name)')
        .eq('auth_user_id', targetAuthUserId)
        .maybeSingle()
      if (error) throw error
      if (!targetAccess) throw new Error('账号不存在')

      const targetRole = Array.isArray(targetAccess.roles) ? targetAccess.roles[0] : targetAccess.roles
      if (!isFounder && targetRole?.code === 'founder') {
        throw new Error('只有 Founder 可以管理 Founder 账号')
      }
      if (!isFounder) {
        if (!targetAccess.employee_id) throw new Error('该账号未关联员工档案，只有 Founder 可以管理')
        await requireEmployeeInScope(targetAccess.employee_id)
        const isStaffPortalAccount = !targetAccess.backend_enabled &&
          targetAccess.employee_portal_enabled &&
          targetRole?.code === 'employee'
        if (!isStaffPortalAccount) {
          const targetPermissions = await getAccountPermissionCodes(targetAuthUserId, targetAccess.role_id)
          if (!permissionsWithinCaller(targetPermissions, true)) {
            throw new Error('不能管理权限级别相同、较高或权限集合不同的账号')
          }
        }
      }
      return { ...targetAccess, targetRole }
    }

    if (action === 'access') {
      let employeeContext: Record<string, unknown> | null = null
      if (caller.employee_id) {
        const { data: employee, error: employeeError } = await admin
          .from('employees')
          .select('id,team_id,position_id')
          .eq('id', caller.employee_id)
          .maybeSingle()
        if (employeeError) return json(req, { error: '无法读取当前账号的数据范围' }, 500)
        employeeContext = employee
      }
      return json(req, {
        ok: true,
        caller: {
          auth_user_id: userData.user.id,
          role_code: callerRole?.code || null,
          is_founder: isFounder,
          permissions: isFounder ? ['*'] : [...callerEffectivePermissions],
          employee_id: caller.employee_id || null,
          data_scope: caller.data_scope || null,
          team_id: employeeContext?.team_id || null,
          position_id: employeeContext?.position_id || null,
        },
      })
    }

    if (action === 'dashboard') {
      if (!can('dashboard.view')) return json(req, { error: '无后台首页权限' }, 403)
      const mayViewEmployees = can('employee.view')
      const mayViewStaffCoverage = can('user.view') || can('account.view') ||
        can('user.activation.generate') || can('user.account.create')
      const mayViewBackendAccounts = can('user.view') || can('account.view') ||
        can('account.create') || can('account.edit')
      const scopedEmployees = (mayViewEmployees || mayViewStaffCoverage)
        ? await getScopedEmployees(false)
        : []
      const employees = mayViewEmployees
        ? scopedEmployees.filter((employee: any) => {
          const employeeNo = cleanString(employee.employee_no).toUpperCase()
          return employeeNo && !['SYSTEM', 'ADMIN'].includes(employeeNo) &&
            !employeeNo.startsWith('TEST') && cleanString(employee.source_type) !== 'google_deleted'
        })
        : []

      let accountSummary: Record<string, number> | null = null
      if (mayViewStaffCoverage || mayViewBackendAccounts) {
        const scope = await getScopeContext()
        const { data: accessRows, error: accessError } = await admin.from('user_access')
          .select('auth_user_id,employee_id,backend_enabled,employee_portal_enabled,active')
        if (accessError) return json(req, { error: accessError.message }, 500)

        const visibleAccounts = (accessRows || []).filter((row: any) =>
          isFounder || (row.employee_id && scope.allowedEmployeeIds.has(row.employee_id))
        )
        const activeEmployeeStatuses = new Set(['active', '在职'])
        const activeScopedEmployees = scopedEmployees.filter((employee: any) => {
          const employeeNo = cleanString(employee.employee_no).toUpperCase()
          return activeEmployeeStatuses.has(cleanString(employee.status).toLowerCase()) && employeeNo &&
            !['SYSTEM', 'ADMIN'].includes(employeeNo) && !employeeNo.startsWith('TEST') &&
            cleanString(employee.source_type) !== 'google_deleted'
        })
        const activeScopedEmployeeIds = new Set(activeScopedEmployees.map((employee: any) => employee.id))
        const portalEmployeeIds = new Set(visibleAccounts
          .filter((row: any) => row.employee_portal_enabled && row.active !== false &&
            row.employee_id && activeScopedEmployeeIds.has(row.employee_id))
          .map((row: any) => row.employee_id))

        accountSummary = {
          can_view_staff_accounts: mayViewStaffCoverage ? 1 : 0,
          active_staff_scope: mayViewStaffCoverage ? activeScopedEmployees.length : 0,
          staff_accounts: mayViewStaffCoverage ? portalEmployeeIds.size : 0,
          pending_staff_accounts: mayViewStaffCoverage
            ? activeScopedEmployees.filter((employee: any) => !portalEmployeeIds.has(employee.id)).length
            : 0,
          backend_accounts: mayViewBackendAccounts
            ? visibleAccounts.filter((row: any) => row.backend_enabled && row.active !== false).length
            : 0,
        }
      }

      return json(req, {
        ok: true,
        caller: {
          auth_user_id: userData.user.id,
          role_code: callerRole?.code || null,
          is_founder: isFounder,
          permissions: isFounder ? ['*'] : [...callerEffectivePermissions],
        },
        employees,
        account_summary: accountSummary,
        dashboard_access: {
          employee_metrics: mayViewEmployees,
          staff_account_metrics: mayViewStaffCoverage,
          backend_account_metrics: mayViewBackendAccounts,
        },
      })
    }

    if (action === 'bootstrap') {
      const backendActionPermissions = [
        'user.view', 'account.view', 'account.create', 'account.edit',
        'account.delete', 'account.disable', 'account.mfa_reset',
        'account.otp_toggle', 'account.reset_password',
      ]
      const staffActionPermissions = [
        'user.view', 'user.account.create', 'user.account.delete',
        'user.account.disable', 'user.password.reset', 'account.mfa_reset',
      ]
      const mayViewBackendAccounts = backendActionPermissions.some(code => can(code))
      const mayViewStaffAccounts = staffActionPermissions.some(code => can(code))
      const mayViewAccounts = mayViewBackendAccounts || mayViewStaffAccounts
      if (!mayViewAccounts && !can('role.manage')) {
        return json(req, { error: '无账号与权限查看权限' }, 403)
      }
      const mayManageRoles = can('role.manage')
      const mayCreateAccounts = can('account.create')
      const scope = await getScopeContext()
      const employees = mayViewAccounts ? await getScopedEmployees(true) : []
      const emptyResult = () => Promise.resolve({ data: [] as any[], error: null })

      const [
        accessRes,
        roleRes,
        permissionRes,
        rpRes,
        positionRes,
        scopeTeamRes,
        scopeEmployeeRes,
      ] = await Promise.all([
        mayViewAccounts ? admin.from('user_access')
          .select('auth_user_id,employee_id,role_id,login_username,login_email,backend_enabled,employee_portal_enabled,otp_required,data_scope,active,must_change_password,roles(id,code,name,system_locked,active)')
          .order('created_at', { ascending: true }) : emptyResult(),
        (mayManageRoles || mayCreateAccounts || can('account.edit'))
          ? admin.from('roles').select('id,code,name,system_locked,active').order('name')
          : emptyResult(),
        mayManageRoles
          ? admin.from('permissions').select('id,code,name,category,sensitive').order('category').order('name')
          : emptyResult(),
        mayManageRoles
          ? admin.from('role_permissions').select('role_id,permission_id')
          : emptyResult(),
        mayViewAccounts
          ? admin.from('positions').select('id,name').order('name')
          : emptyResult(),
        mayViewAccounts
          ? admin.from('user_scope_teams').select('auth_user_id,team_id')
          : emptyResult(),
        mayViewAccounts
          ? admin.from('user_scope_employees').select('auth_user_id,employee_id')
          : emptyResult(),
      ])

      if (accessRes.error) return json(req, { error: accessRes.error.message }, 500)
      if (roleRes.error) return json(req, { error: roleRes.error.message }, 500)
      if (permissionRes.error) return json(req, { error: permissionRes.error.message }, 500)
      if (rpRes.error) return json(req, { error: rpRes.error.message }, 500)
      if (positionRes.error) return json(req, { error: positionRes.error.message }, 500)
      if (scopeTeamRes.error) return json(req, { error: scopeTeamRes.error.message }, 500)
      if (scopeEmployeeRes.error) return json(req, { error: scopeEmployeeRes.error.message }, 500)

      const manageableAccounts: any[] = []
      for (const account of accessRes.data || []) {
        if (isFounder) {
          manageableAccounts.push(account)
          continue
        }
        const role = Array.isArray(account.roles) ? account.roles[0] : account.roles
        if (role?.code === 'founder' || !account.employee_id || !scope.allowedEmployeeIds.has(account.employee_id)) {
          continue
        }
        const isStaffPortalAccount = !account.backend_enabled && account.employee_portal_enabled && role?.code === 'employee'
        if (isStaffPortalAccount) {
          manageableAccounts.push(account)
          continue
        }
        const targetPermissions = await getAccountPermissionCodes(account.auth_user_id, account.role_id)
        if (permissionsWithinCaller(targetPermissions, true)) manageableAccounts.push(account)
      }
      const decorate = (x: any) => ({
        ...x,
        employee: x.employee_id ? scope.employeeMap.get(x.employee_id) || null : null,
      })

      const backendAccounts = (mayViewBackendAccounts ? manageableAccounts : [])
        .filter((x: any) => x.backend_enabled)
        .map(decorate)

      const employeeAccounts = (mayViewStaffAccounts ? manageableAccounts : [])
        .filter((x: any) => x.employee_portal_enabled)
        .map(decorate)
      const manageableAccountIds = new Set(
        [...backendAccounts, ...employeeAccounts].map((account: any) => account.auth_user_id)
      )

      let roles = roleRes.data || []
      if (!mayManageRoles) {
        const assignableRoles = []
        for (const role of roles) {
          if (role.active === false || ['founder', 'employee'].includes(role.code)) continue
          if (await roleCanBeAssigned(role.id)) assignableRoles.push(role)
        }
        roles = assignableRoles
      }

      const teams = mayViewAccounts
        ? scope.allTeams.filter((team: any) => isFounder || scope.delegableTeamIds.has(team.id))
        : []

      return json(req, {
        ok: true,
        caller: {
          auth_user_id: userData.user.id,
          role_code: callerRole?.code || null,
          is_founder: isFounder,
          permissions: isFounder ? ['*'] : [...callerEffectivePermissions],
        },
        employees,
        backend_accounts: backendAccounts,
        employee_accounts: employeeAccounts,
        roles,
        permissions: mayManageRoles ? permissionRes.data || [] : [],
        role_permissions: mayManageRoles ? rpRes.data || [] : [],
        teams,
        positions: positionRes.data || [],
        scope_teams: (scopeTeamRes.data || []).filter((row: any) => manageableAccountIds.has(row.auth_user_id)),
        scope_employees: (scopeEmployeeRes.data || []).filter((row: any) => manageableAccountIds.has(row.auth_user_id)),
      })
    }

    if (action === 'create_role') {
      if (!isFounder) return json(req, { error: '只有 Founder 可以修改全局角色' }, 403)
      const name = cleanString(body.name)
      if (name.length < 2 || name.length > 40) return json(req, { error: '角色名称不正确' }, 400)

      const code = `custom_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
      const { data: role, error } = await admin.from('roles')
        .insert({ code, name, system_locked: false, active: true })
        .select('id,code,name,system_locked,active')
        .single()

      if (error) return json(req, { error: error.message }, 400)
      await audit('role_create', `创建角色 ${name}`)
      return json(req, { ok: true, role })
    }

    if (action === 'rename_role') {
      if (!isFounder) return json(req, { error: '只有 Founder 可以修改全局角色' }, 403)
      const roleId = cleanString(body.role_id)
      const name = cleanString(body.name)

      const { data: role } = await admin.from('roles')
        .select('id,code,system_locked')
        .eq('id', roleId).maybeSingle()

      if (!role) return json(req, { error: '角色不存在' }, 404)
      if (role.code === 'founder' || role.system_locked) return json(req, { error: '系统角色不能改名' }, 400)

      const { error } = await admin.from('roles').update({ name }).eq('id', roleId)
      if (error) return json(req, { error: error.message }, 400)
      await audit('role_rename', `修改角色名称 ${roleId} -> ${name}`)
      return json(req, { ok: true })
    }

    if (action === 'delete_role') {
      if (!isFounder) return json(req, { error: '只有 Founder 可以修改全局角色' }, 403)
      const roleId = cleanString(body.role_id)

      const { data: role } = await admin.from('roles')
        .select('id,code,name,system_locked')
        .eq('id', roleId).maybeSingle()

      if (!role) return json(req, { error: '角色不存在' }, 404)
      if (role.code === 'founder' || role.code === 'employee' || role.system_locked) {
        return json(req, { error: '系统角色不能删除' }, 400)
      }

      const { count } = await admin.from('user_access')
        .select('auth_user_id', { count: 'exact', head: true })
        .eq('role_id', roleId)

      if ((count || 0) > 0) return json(req, { error: '该角色仍有账号正在使用' }, 400)

      // role_permissions.role_id uses ON DELETE CASCADE, so the role delete is one database transaction.
      const { error } = await admin.from('roles').delete().eq('id', roleId)
      if (error) return json(req, { error: error.message }, 400)
      await audit('role_delete', `删除角色 ${role.name}`)
      return json(req, { ok: true })
    }

    if (action === 'save_role_permissions') {
      if (!isFounder) return json(req, { error: '只有 Founder 可以修改全局角色权限' }, 403)
      const roleId = cleanString(body.role_id)
      const permissionIds = cleanStringList(body.permission_ids)

      const { data: role } = await admin.from('roles')
        .select('id,code,system_locked')
        .eq('id', roleId).maybeSingle()

      if (!role) return json(req, { error: '角色不存在' }, 404)
      if (role.code === 'founder') return json(req, { error: 'Founder 固定拥有全部权限' }, 400)

      if (permissionIds.length) {
        const { data: validPermissions, error: permissionError } = await admin.from('permissions')
          .select('id').in('id', permissionIds)
        if (permissionError) return json(req, { error: permissionError.message }, 400)
        const validIds = new Set((validPermissions || []).map((permission: any) => permission.id))
        if (permissionIds.some(permissionId => !validIds.has(permissionId))) {
          return json(req, { error: '包含不存在的权限项目' }, 400)
        }
      }

      const { data: currentRows, error: currentError } = await admin.from('role_permissions')
        .select('permission_id').eq('role_id', roleId)
      if (currentError) return json(req, { error: currentError.message }, 400)

      const currentIds = new Set((currentRows || []).map((row: any) => row.permission_id))
      const desiredIds = new Set(permissionIds)
      const additions = permissionIds.filter(permissionId => !currentIds.has(permissionId))
      const removals = [...currentIds].filter(permissionId => !desiredIds.has(permissionId)) as string[]

      if (additions.length) {
        const { error } = await admin.from('role_permissions').insert(
          additions.map(permission_id => ({ role_id: roleId, permission_id }))
        )
        if (error) return json(req, { error: error.message }, 400)
      }

      if (removals.length) {
        const { error } = await admin.from('role_permissions')
          .delete().eq('role_id', roleId).in('permission_id', removals)
        if (error) {
          if (additions.length) {
            const { error: rollbackError } = await admin.from('role_permissions')
              .delete().eq('role_id', roleId).in('permission_id', additions)
            if (rollbackError) {
              console.error('role permission rollback failed', rollbackError)
              return json(req, { error: '角色权限保存失败且自动回滚未完整完成，请立即联系 Founder 检查该角色' }, 500)
            }
          }
          return json(req, { error: error.message }, 400)
        }
      }

      await audit('role_permissions_update', `更新角色权限 ${roleId}`)
      return json(req, { ok: true })
    }

    const createAccountError = (message: string, status = 400) => {
      const error = new Error(message) as Error & { status?: number }
      error.status = status
      return error
    }

    const createBackendAccount = async (input: Record<string, unknown>) => {
      const username = cleanString(input.username).toLowerCase()
      const password = String(input.password || '')
      const roleId = cleanString(input.role_id)
      const employeeId = cleanString(input.employee_id) || null
      const scopeDecision = decideBackendDataScope(input.data_scope, employeeId)
      const otpRequired = Boolean(input.otp_required)
      const teamIds = cleanStringList(input.team_ids)
      const employeeIds = cleanStringList(input.employee_ids)

      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        throw createAccountError('用户名只允许3-32位字母、数字、._-')
      }
      if (!passwordOk(password)) {
        throw createAccountError('密码至少10位，并包含大小写字母、数字和特殊符号')
      }
      if (!scopeDecision.ok) {
        throw createAccountError(scopeDecision.reason === 'employee_required'
          ? '“仅本人”或“自己团队”范围必须关联员工档案'
          : '管理范围不正确')
      }
      const dataScope = scopeDecision.dataScope

      const { data: role, error: roleError } = await admin.from('roles')
        .select('id,code,active').eq('id', roleId).maybeSingle()
      if (roleError) throw createAccountError(roleError.message)
      if (!role || !role.active) throw createAccountError('角色不可用')
      if (role.code === 'employee' || (role.code === 'founder' && !isFounder)) {
        throw createAccountError('该角色不能用于新增后台账号')
      }
      if (!await roleCanBeAssigned(role.id)) {
        throw createAccountError('只能授予权限严格低于当前账号的角色', 403)
      }

      try {
        await validateDelegatedScope(employeeId, dataScope, teamIds, employeeIds)
      } catch (error) {
        throw createAccountError(error instanceof Error ? error.message : '管理范围不正确', 403)
      }

      const { data: exists, error: existsError } = await admin.from('user_access')
        .select('auth_user_id').ilike('login_username', username).maybeSingle()
      if (existsError) throw createAccountError(existsError.message)
      if (exists) throw createAccountError('用户名已存在', 409)

      const internalEmail = `${username}.${crypto.randomUUID().slice(0, 8)}@admin.wfh.invalid`
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: internalEmail,
        password,
        email_confirm: true,
      })
      if (createError || !created.user) {
        throw createAccountError(createError?.message || '创建登录账号失败')
      }

      const { error: insertError } = await admin.from('user_access').insert({
        auth_user_id: created.user.id,
        employee_id: employeeId,
        role_id: roleId,
        login_username: username,
        login_email: internalEmail,
        backend_enabled: true,
        employee_portal_enabled: false,
        otp_required: otpRequired,
        data_scope: dataScope,
        active: true,
        must_change_password: true,
        account_created_by: userData.user.id,
      })

      if (insertError) {
        await admin.auth.admin.deleteUser(created.user.id)
        throw createAccountError(insertError.message)
      }

      if (dataScope === 'assigned_teams') {
        try {
          await saveScope(created.user.id, teamIds, employeeIds)
        } catch (error) {
          await admin.from('user_access').delete().eq('auth_user_id', created.user.id)
          await admin.auth.admin.deleteUser(created.user.id)
          throw createAccountError(error instanceof Error ? error.message : '指定范围保存失败')
        }
      }

      await audit('backend_account_create', `创建后台账号 ${username}`)
      return { auth_user_id: created.user.id, username }
    }

    if (action === 'create_backend') {
      if (!can('account.create')) return json(req, { error: '无创建账号权限' }, 403)
      try {
        const created = await createBackendAccount(body)
        return json(req, { ok: true, created })
      } catch (error) {
        const status = Number((error as Error & { status?: number })?.status || 400)
        return json(req, { error: error instanceof Error ? error.message : '创建后台账号失败' }, status)
      }
    }

    if (action === 'create_backend_batch') {
      if (!can('account.create')) return json(req, { error: '无创建账号权限' }, 403)
      if (!Array.isArray(body.accounts) || body.accounts.length < 1 || body.accounts.length > 20) {
        return json(req, { error: '每次必须提交 1–20 个后台账号' }, 400)
      }

      const results: Array<Record<string, unknown>> = []
      for (let index = 0; index < body.accounts.length; index += 1) {
        const input = body.accounts[index]
        const username = cleanString(input?.username).toLowerCase()
        try {
          const created = await createBackendAccount(input || {})
          results.push({ index, ok: true, username, auth_user_id: created.auth_user_id })
        } catch (error) {
          results.push({
            index,
            ok: false,
            username,
            status: Number((error as Error & { status?: number })?.status || 400),
            error: error instanceof Error ? error.message : '创建后台账号失败',
          })
        }
      }

      const createdCount = results.filter(result => result.ok).length
      return json(req, {
        ok: createdCount === results.length,
        created_count: createdCount,
        failed_count: results.length - createdCount,
        results,
      })
    }

    if (action === 'update_backend') {
      if (!can('account.edit')) return json(req, { error: '无编辑账号权限' }, 403)

      const target = cleanString(body.auth_user_id)
      const roleId = cleanString(body.role_id)
      const employeeId = cleanString(body.employee_id) || null
      const scopeDecision = decideBackendDataScope(body.data_scope, employeeId)
      const teamIds = cleanStringList(body.team_ids)
      const employeeIds = cleanStringList(body.employee_ids)

      if (!scopeDecision.ok) {
        return json(req, {
          error: scopeDecision.reason === 'employee_required'
            ? '“仅本人”或“自己团队”范围必须关联员工档案'
            : '管理范围不正确',
        }, 400)
      }
      const dataScope = scopeDecision.dataScope

      let current: any
      try {
        current = await getTargetAccount(target)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '无账号操作权限' }, 403)
      }
      if (!current.backend_enabled) return json(req, { error: '该账号不是后台账号' }, 400)

      const { data: role } = await admin.from('roles').select('id,code,active').eq('id', roleId).maybeSingle()
      if (!role || !role.active || role.code === 'employee' || (role.code === 'founder' && !isFounder)) {
        return json(req, { error: '角色不可用' }, 400)
      }
      if (!await roleCanBeAssigned(role.id, target)) {
        return json(req, { error: '只能授予权限严格低于当前账号的角色' }, 403)
      }

      let previousScope: { teamIds: string[], employeeIds: string[] }
      try {
        previousScope = await readScope(target)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '管理范围读取失败' }, 400)
      }
      const sameIds = (left: string[], right: string[]) => {
        const a = [...new Set(left)].sort()
        const b = [...new Set(right)].sort()
        return a.length === b.length && a.every((value, index) => value === b[index])
      }
      const assignedScopeChanged = dataScope === 'assigned_teams' && (
        !sameIds(previousScope.teamIds, teamIds) || !sameIds(previousScope.employeeIds, employeeIds)
      )
      const scopeChanged = cleanString(current.employee_id) !== cleanString(employeeId) ||
        cleanString(current.data_scope) !== dataScope || assignedScopeChanged
      if (scopeChanged && !can('scope.manage')) {
        return json(req, { error: '无管理账号数据范围权限' }, 403)
      }

      try {
        await validateDelegatedScope(employeeId, dataScope, teamIds, employeeIds)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '管理范围不正确' }, 403)
      }

      try {
        if (dataScope === 'assigned_teams') {
          await saveScope(target, teamIds, employeeIds)
        }
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '管理范围保存失败' }, 400)
      }

      const { error } = await admin.from('user_access')
        .update({ employee_id: employeeId, role_id: roleId, data_scope: dataScope })
        .eq('auth_user_id', target)

      if (error) {
        if (dataScope === 'assigned_teams') {
          try {
            await restoreScope(target, previousScope!)
          } catch (rollbackError) {
            console.error('account update scope rollback failed', rollbackError)
            return json(req, { error: '账号保存失败且管理范围自动回滚未完整完成，请立即联系 Founder 检查该账号' }, 500)
          }
        }
        return json(req, { error: error.message }, 400)
      }

      if (dataScope !== 'assigned_teams') {
        try {
          await saveScope(target, [], [])
        } catch (scopeError) {
          const { error: rollbackError } = await admin.from('user_access')
            .update({
              employee_id: current.employee_id,
              role_id: current.role_id,
              data_scope: current.data_scope,
            })
            .eq('auth_user_id', target)
          if (rollbackError) {
            console.error('account update rollback failed', rollbackError, scopeError)
            return json(req, { error: '账号与管理范围保存不一致，请立即联系 Founder 检查该账号' }, 500)
          }
          return json(req, { error: scopeError instanceof Error ? scopeError.message : '管理范围保存失败' }, 400)
        }
      }

      await audit('backend_account_update', `编辑后台账号 ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'create_staff') {
      if (!can('user.account.create')) return json(req, { error: '无创建员工账号权限' }, 403)

      const employeeId = cleanString(body.employee_id)
      const email = cleanString(body.email).toLowerCase()
      const password = String(body.password || '')

      if (!employeeId) return json(req, { error: '员工前端账号必须关联员工档案' }, 400)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(req, { error: '请填写正确的登录邮箱格式' }, 400)
      }
      if (!passwordOk(password)) {
        return json(req, { error: '密码至少10位，并包含大小写字母、数字和特殊符号' }, 400)
      }

      try {
        await requireEmployeeInScope(employeeId)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '无员工账号创建权限' }, 403)
      }

      const [{ data: employee }, { data: emailExists }, { data: linkedExists }, { data: employeeRole }] = await Promise.all([
        admin.from('employees').select('id,employee_no,full_name,status').eq('id', employeeId).maybeSingle(),
        admin.from('user_access').select('auth_user_id').ilike('login_email', email).maybeSingle(),
        admin.from('user_access').select('auth_user_id').eq('employee_id', employeeId).eq('employee_portal_enabled', true).maybeSingle(),
        admin.from('roles').select('id').eq('code', 'employee').eq('active', true).maybeSingle(),
      ])

      if (!employee) return json(req, { error: '关联的员工档案不存在' }, 404)
      if (employee.status !== 'active') return json(req, { error: '只有在职员工可以开通前端账号' }, 400)
      if (emailExists) return json(req, { error: '此邮箱已经注册过账号' }, 409)
      if (linkedExists) return json(req, { error: '该员工已开通过前端账号' }, 409)
      if (!employeeRole) return json(req, { error: '员工角色未配置' }, 500)

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (createError || !created.user) {
        return json(req, { error: createError?.message || '创建员工登录账号失败' }, 400)
      }

      const { error: insertError } = await admin.from('user_access').insert({
        auth_user_id: created.user.id,
        employee_id: employeeId,
        role_id: employeeRole.id,
        login_username: email,
        login_email: email,
        backend_enabled: false,
        employee_portal_enabled: true,
        otp_required: false,
        data_scope: 'self',
        active: true,
        must_change_password: true,
        account_created_by: userData.user.id,
      })

      if (insertError) {
        await admin.auth.admin.deleteUser(created.user.id)
        return json(req, { error: insertError.message }, 400)
      }

      await audit('staff_account_create', `创建员工前端账号 ${employee.employee_no} / ${email}`)
      return json(req, { ok: true })
    }

    if (action === 'generate_activation_code') {
      if (!can('user.activation.generate')) return json(req, { error: '无生成激活码权限' }, 403)
      const employeeNo = cleanString(body.employee_no).toUpperCase()
      const hours = Math.max(1, Math.min(Number(body.valid_hours) || 72, 168))
      const employees = await getScopedEmployees()
      const employee = employees.find((x: any) => cleanString(x.employee_no).toUpperCase() === employeeNo)
      if (!employee) return json(req, { error: '找不到可管理的在职员工，或该员工已经离职' }, 404)

      const { data: linked } = await admin.from('user_access')
        .select('auth_user_id').eq('employee_id', employee.id).eq('employee_portal_enabled', true).maybeSingle()
      if (linked) return json(req, { error: '该员工已经开通过前端账号，不能重复生成激活码' }, 409)

      const code = `${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}-${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`.toUpperCase()
      const expiresAt = new Date(Date.now() + hours * 3600000).toISOString()
      const { error: revokeError } = await admin.from('employee_activation_codes').update({ revoked_at: new Date().toISOString() })
        .eq('employee_id', employee.id).is('used_at', null).is('revoked_at', null)
      if (revokeError) return json(req, { error: revokeError.message }, 400)
      const { error } = await admin.from('employee_activation_codes').insert({
        employee_id: employee.id,
        code_hash: await sha256(code),
        code_hint: code.slice(-4),
        expires_at: expiresAt,
        created_by: userData.user.id,
      })
      if (error) return json(req, { error: error.message }, 400)
      await audit('activation_code_generate', `生成员工激活码 ${employee.employee_no}`)
      return json(req, { ok: true, employee_no: employee.employee_no, employee_name: employee.full_name, activation_code: code, expires_at: expiresAt })
    }

    if (action === 'toggle_otp') {
      if (!can('account.otp_toggle')) return json(req, { error: '无OTP设置权限' }, 403)
      const target = cleanString(body.auth_user_id)
      const required = Boolean(body.otp_required)
      try {
        await getTargetAccount(target)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '无账号操作权限' }, 403)
      }
      const { error } = await admin.from('user_access')
        .update({ otp_required: required })
        .eq('auth_user_id', target)
      if (error) return json(req, { error: error.message }, 400)
      await audit('otp_toggle', `OTP=${required} ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'toggle_active') {
      const target = cleanString(body.auth_user_id)
      const active = Boolean(body.active)

      if (target === userData.user.id && !active) {
        return json(req, { error: '不能停用当前登录账号' }, 400)
      }

      let current: any
      try {
        current = await getTargetAccount(target)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '无账号操作权限' }, 403)
      }
      const requiredPermission = current.backend_enabled ? 'account.disable' : 'user.account.disable'
      if (!can(requiredPermission)) return json(req, { error: '无停用 / 启用该类账号的权限' }, 403)

      const { error } = await admin.from('user_access').update({ active }).eq('auth_user_id', target)
      if (error) return json(req, { error: error.message }, 400)

      await audit('account_active_toggle', `active=${active} ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'reset_password') {
      const target = cleanString(body.auth_user_id)
      const password = String(body.password || '')
      if (!passwordOk(password)) {
        return json(req, { error: '新密码至少10位，并包含大小写字母、数字和特殊符号' }, 400)
      }

      let current: any
      try {
        current = await getTargetAccount(target)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '无账号操作权限' }, 403)
      }
      const requiredPermission = current.backend_enabled ? 'account.reset_password' : 'user.password.reset'
      if (!can(requiredPermission)) return json(req, { error: '无重置该类账号密码的权限' }, 403)

      const { error } = await admin.auth.admin.updateUserById(target, { password })
      if (error) return json(req, { error: error.message }, 400)

      const { error: passwordFlagError } = await admin.from('user_access')
        .update({ must_change_password: true, password_reset_at: new Date().toISOString() })
        .eq('auth_user_id', target)
      if (passwordFlagError) {
        await audit('password_reset_partial', `密码已重置但强制改密标记失败 ${target}`)
        return json(req, { error: '密码已经重置，但强制改密标记保存失败，请立即联系 Founder 检查该账号' }, 500)
      }

      await audit('password_reset', `重置密码 ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'reset_mfa') {
      if (!can('account.mfa_reset')) return json(req, { error: '无重置OTP权限' }, 403)
      const target = cleanString(body.auth_user_id)

      try {
        await getTargetAccount(target)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '无账号操作权限' }, 403)
      }

      const { data: factors, error: listError } = await admin.auth.admin.mfa.listFactors({ userId: target })
      if (listError) return json(req, { error: listError.message }, 400)

      const items = [
        ...(((factors as any)?.factors || []) as any[]),
        ...(((factors as any)?.totp || []) as any[]),
        ...(((factors as any)?.phone || []) as any[]),
      ]

      const done = new Set<string>()
      for (const factor of items) {
        if (!factor?.id || done.has(factor.id)) continue
        done.add(factor.id)
        const { error } = await admin.auth.admin.mfa.deleteFactor({
          userId: target,
          id: factor.id,
        })
        if (error) return json(req, { error: error.message }, 400)
      }

      await audit('mfa_reset', `重置OTP ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'delete_account') {
      const target = cleanString(body.auth_user_id)
      if (target === userData.user.id) return json(req, { error: '不能删除当前登录账号' }, 400)

      let current: any
      try {
        current = await getTargetAccount(target)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '无账号操作权限' }, 403)
      }
      const requiredPermission = current.backend_enabled ? 'account.delete' : 'user.account.delete'
      if (!can(requiredPermission)) return json(req, { error: '无删除该类账号的权限' }, 403)

      // Related access/scope/override rows all have ON DELETE CASCADE from auth.users.
      // Auth deletion is therefore the only destructive call and cannot leave a live user with partial access rows.
      const { error } = await admin.auth.admin.deleteUser(target)
      if (error) return json(req, { error: error.message }, 400)

      await audit('account_delete', `删除登录账号 ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'create_employee') {
      if (!can('employee.create')) return json(req, { error: '无新增员工权限' }, 403)

      const employeeNo = cleanString(body.employee_no).toUpperCase()
      const fullName = cleanString(body.full_name)
      if (!employeeNo || !fullName) return json(req, { error: '员工ID和姓名必填' }, 400)

      const teamId = cleanString(body.team_id) || null
      const scope = await getScopeContext()
      if (teamId && !scope.allTeamIds.has(teamId)) {
        return json(req, { error: '团队不存在' }, 400)
      }
      if (!isFounder && (!teamId || !scope.delegableTeamIds.has(teamId))) {
        return json(req, { error: '只能在当前账号可管理的完整团队范围内新增员工' }, 403)
      }

      const { data: exists } = await admin.from('employees')
        .select('id').eq('employee_no', employeeNo).maybeSingle()
      if (exists) return json(req, { error: '员工ID已存在' }, 409)

      const row: any = {
        employee_no: employeeNo,
        full_name: fullName,
        country: cleanString(body.country),
        nationality: cleanString(body.nationality),
        employment_type: cleanString(body.employment_type),
        status: cleanString(body.status || 'active'),
        team_id: teamId,
        position_id: cleanString(body.position_id) || null,
      }

      const { data: employee, error } = await admin.from('employees')
        .insert(row)
        .select('id,employee_no,full_name')
        .single()

      if (error) return json(req, { error: error.message }, 400)
      await audit('employee_create', `新增员工 ${employeeNo}`)
      return json(req, { ok: true, employee })
    }

    return json(req, { error: 'Unknown action' }, 400)
  } catch (error) {
    console.error(error)
    return json(req, { error: error instanceof Error ? error.message : '服务器错误' }, 500)
  }
})
