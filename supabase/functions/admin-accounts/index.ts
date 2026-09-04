import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  decideBackendDataScope,
  delegatedBackendDataScopeError,
  partitionCurrentTeamIds,
  validateAssignedScopeBoundary,
} from './scope.ts'
import { loadEffectiveEmployeeScope } from '../_shared/employeeScope.ts'
import { corsGate, corsHeaders } from '../_shared/corsOrigin.ts'
const PRESENCE_DETAIL_TIMEOUT_MS = 4_000

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
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

async function boundedPresence<T>(operation: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = typeof (operation as any)?.abortSignal === 'function'
    ? new AbortController()
    : null
  const boundedOperation = controller
    ? (operation as any).abortSignal(controller.signal)
    : operation
  try {
    return await Promise.race([
      Promise.resolve(boundedOperation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort()
          reject(new Error(`${label}_TIMEOUT`))
        }, PRESENCE_DETAIL_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function cleanStringList(v: unknown) {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map(cleanString).filter(Boolean))]
}

function normalizeEmployeeNo(v: unknown) {
  return cleanString(v).toUpperCase().replace(/[^A-Z0-9]/g, '')
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
  const corsResponse = corsGate(req)
  if (corsResponse) return corsResponse
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
      .select('auth_user_id,employee_id,role_id,data_scope,backend_enabled,active,login_username,login_email,roles(id,code,name,active)')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle()

    const callerRole = Array.isArray(caller?.roles) ? caller.roles[0] : caller?.roles
    if (callerError || !caller || !caller.active || !caller.backend_enabled || callerRole?.active !== true) {
      return json(req, { error: '无后台权限' }, 403)
    }
    const activeCaller = caller

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
    const callerDeniedPermissions = new Set<string>()
    overrideMap.forEach((allowed, code) => {
      if (allowed) {
        callerEffectivePermissions.add(code)
        callerDeniedPermissions.delete(code)
      } else {
        callerEffectivePermissions.delete(code)
        callerDeniedPermissions.add(code)
      }
    })

    const can = (code: string) => isFounder || (
      !callerDeniedPermissions.has(code) && (
        callerEffectivePermissions.has(code) ||
        (!callerDeniedPermissions.has('*') && callerEffectivePermissions.has('*'))
      )
    )

    const audit = async (action: string, reason: string) => {
      await admin.from('audit_logs').insert({
        actor_user_id: userData.user.id,
        employee_id: caller.employee_id || null,
        module: 'access_control',
        action,
        reason,
      })
    }

    const decoratePasswordLockStates = async (rows: any[]) => {
      const ids = [...new Set((rows || []).map(row => cleanString(row?.auth_user_id)).filter(Boolean))]
      if (!ids.length) return rows || []
      const items: any[] = []
      for (let offset = 0; offset < ids.length; offset += 200) {
        const { data:states, error } = await admin.rpc('login_password_lock_states', {
          p_user_ids:ids.slice(offset, offset + 200),
        })
        if (error) throw error
        items.push(...(Array.isArray(states) ? states : Array.isArray(states?.rows) ? states.rows : []))
      }
      const byId = new Map(items.map((state: any) => [cleanString(state?.auth_user_id), state]))
      return (rows || []).map(row => ({
        ...row,
        login_locked:false,
        failed_attempts:0,
        locked_at:null,
        last_failure_portal:null,
        ...(byId.get(cleanString(row?.auth_user_id)) || {}),
      }))
    }

    const loadLoginPasswordPolicy = async () => {
      const { data:policy, error } = await admin.rpc('login_password_lockout_policy_get')
      if (error) throw error
      return policy || { lock_threshold:5 }
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
    const targetEffectiveScopeCache = new Map<string, Promise<string[]>>()

    async function loadEffectiveEmployeeIds(targetAuthUserId: string) {
      if (!targetEffectiveScopeCache.has(targetAuthUserId)) {
        targetEffectiveScopeCache.set(targetAuthUserId, (async () => {
          // Deliberately force the shared loader through the RPC path.  A target
          // account can itself have all-data access, and the caller-subset check
          // must enumerate that full result instead of trusting target metadata.
          const targetScope = await loadEffectiveEmployeeScope(
            admin,
            targetAuthUserId,
            { data_scope: '__server_authoritative__' },
            '',
          )
          return targetScope.employeeIds
        })())
      }
      return targetEffectiveScopeCache.get(targetAuthUserId)!
    }

    async function getAllEmployeeRows() {
      const pageSize = 1000
      const rows: any[] = []

      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await admin.from('employees')
          .select('id,employee_no,full_name,status,team_id,position_id,hire_date,resign_date,country,nationality,employment_type,shift_name,work_tg,source_type,profile_status,created_at,updated_at,teams(id,name),positions(id,name)')
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
        const [allEmployees, teamRes, scopeDirectoryRes, effectiveEmployeeScope] = await Promise.all([
          getAllEmployeeRows(),
          admin.from('teams').select('id,name,status').order('name').limit(5000),
          admin.rpc('admin_scope_current_employee_directory'),
          (isFounder || activeCaller.data_scope === 'all')
            ? Promise.resolve({ mode: 'all', employeeIds: [] } as const)
            : loadEffectiveEmployeeScope(admin, authenticatedUser.id, activeCaller, callerRole?.code || ''),
        ])

        if (teamRes.error) throw teamRes.error
        if (scopeDirectoryRes.error) throw scopeDirectoryRes.error

        const callerScopeSelection = !isFounder && activeCaller.data_scope === 'assigned_teams'
          ? await readScope(authenticatedUser.id)
          : { teamIds: [], positionIds: [], employeeIds: [] }

        const allTeams = teamRes.data || []
        const scopeDirectory: any = scopeDirectoryRes.data || {}
        const currentAssignments = Array.isArray(scopeDirectory.employees) ? scopeDirectory.employees : []
        const unmatchedEmployeeNos = Array.isArray(scopeDirectory.unmatched_employee_nos)
          ? scopeDirectory.unmatched_employee_nos
          : []
        const unmatchedTeamEmployeeNos = Array.isArray(scopeDirectory.unmatched_team_employee_nos)
          ? scopeDirectory.unmatched_team_employee_nos
          : []
        const unmatchedPositionEmployeeNos = Array.isArray(scopeDirectory.unmatched_position_employee_nos)
          ? scopeDirectory.unmatched_position_employee_nos
          : []
        const ambiguousEmployeeNos = Array.isArray(scopeDirectory.ambiguous_employee_nos)
          ? scopeDirectory.ambiguous_employee_nos
          : []
        const ambiguousTeamNames = Array.isArray(scopeDirectory.ambiguous_team_names)
          ? scopeDirectory.ambiguous_team_names
          : []
        const ambiguousPositionNames = Array.isArray(scopeDirectory.ambiguous_position_names)
          ? scopeDirectory.ambiguous_position_names
          : []
        if (!currentAssignments.length) throw new Error('当前排班组织目录为空或全部未匹配，已停止账号范围授权')

        const employeeMap = new Map(allEmployees.map((employee: any) => [employee.id, employee]))
        const allTeamIds = new Set(allTeams.map((team: any) => team.id))
        const currentTeamIds = new Set<string>(currentAssignments
          .map((assignment: any) => cleanString(assignment?.team_id))
          .filter(Boolean))
        const currentTeamMemberCounts = new Map<string, number>()
        const currentPositionMemberCounts = new Map<string, number>()
        const currentTeamIdsByPositionId = new Map<string, Set<string>>()
        for (const assignment of currentAssignments) {
          const teamId = cleanString(assignment?.team_id)
          const positionId = cleanString(assignment?.position_id)
          if (teamId) currentTeamMemberCounts.set(teamId, (currentTeamMemberCounts.get(teamId) || 0) + 1)
          if (positionId) {
            currentPositionMemberCounts.set(positionId, (currentPositionMemberCounts.get(positionId) || 0) + 1)
            if (teamId) {
              if (!currentTeamIdsByPositionId.has(positionId)) {
                currentTeamIdsByPositionId.set(positionId, new Set())
              }
              currentTeamIdsByPositionId.get(positionId)!.add(teamId)
            }
          }
        }
        const currentTeams = allTeams
          .filter((team: any) => currentTeamIds.has(cleanString(team.id)))
          .map((team: any) => ({ ...team, member_count: currentTeamMemberCounts.get(cleanString(team.id)) || 0 }))
        const currentTeamIdByEmployeeId = new Map<string, string>()
        const currentPositionIdByEmployeeId = new Map<string, string>()
        for (const assignment of currentAssignments) {
          const employeeId = cleanString(assignment?.employee_id)
          const teamId = cleanString(assignment?.team_id)
          const positionId = cleanString(assignment?.position_id)
          if (employeeId && currentTeamIds.has(teamId)) currentTeamIdByEmployeeId.set(employeeId, teamId)
          if (employeeId && positionId) currentPositionIdByEmployeeId.set(employeeId, positionId)
        }
        const allowedEmployeeIds = new Set<string>()
        const delegableTeamIds = new Set<string>()
        const currentPositionIds = new Set<string>()
        const delegablePositionIds = new Set<string>()
        allEmployees.forEach((employee: any) => {
          const positionId = currentPositionIdByEmployeeId.get(employee.id)
          if (positionId) currentPositionIds.add(positionId)
        })

        if (isFounder || activeCaller.data_scope === 'all') {
          allEmployees.forEach((employee: any) => allowedEmployeeIds.add(employee.id))
          currentTeamIds.forEach(teamId => delegableTeamIds.add(teamId))
          currentPositionIds.forEach(positionId => delegablePositionIds.add(positionId))
        } else {
          // The database RPC is the sole source of truth for every limited
          // scope. It resolves self/own-team against the current roster and
          // assigned scope as selected team AND (optional position OR selected
          // in-team employee supplement). No team-external exception exists.
          for (const employeeIdRaw of effectiveEmployeeScope.employeeIds) {
            const employeeId = cleanString(employeeIdRaw)
            if (employeeId && employeeMap.has(employeeId)) allowedEmployeeIds.add(employeeId)
          }
        }

        if (!isFounder && activeCaller.data_scope === 'own_team') {
          const me: any = activeCaller.employee_id ? employeeMap.get(activeCaller.employee_id) : null
          const currentTeamId = me ? currentTeamIdByEmployeeId.get(me.id) : ''
          if (currentTeamId) {
            delegableTeamIds.add(currentTeamId)
            for (const assignment of currentAssignments) {
              if (cleanString(assignment?.team_id) === currentTeamId) {
                const positionId = cleanString(assignment?.position_id)
                if (positionId) delegablePositionIds.add(positionId)
              }
            }
          }
        }

        if (!isFounder && activeCaller.data_scope === 'assigned_teams') {
          const callerTeamIds = new Set(callerScopeSelection.teamIds.filter((teamId: string) => currentTeamIds.has(teamId)))
          const callerPositionIds = new Set(callerScopeSelection.positionIds.filter((positionId: string) => currentPositionIds.has(positionId)))
          callerTeamIds.forEach((teamId: string) => delegableTeamIds.add(teamId))
          if (callerPositionIds.size) {
            callerPositionIds.forEach((positionId: string) => delegablePositionIds.add(positionId))
          } else {
            // An unfiltered parent team may delegate a narrower position.
            for (const assignment of currentAssignments) {
              if (!callerTeamIds.has(cleanString(assignment?.team_id))) continue
              const positionId = cleanString(assignment?.position_id)
              if (positionId) delegablePositionIds.add(positionId)
            }
          }
        }

        return {
          allEmployees,
          allTeams,
          currentTeams,
          currentAssignments,
          employeeMap,
          allTeamIds,
          currentTeamIds,
          currentTeamIdByEmployeeId,
          currentPositionIdByEmployeeId,
          currentPositionMemberCounts,
          currentTeamIdsByPositionId,
          allowedEmployeeIds,
          delegableTeamIds,
          currentPositionIds,
          delegablePositionIds,
          callerScopeTeamIds: new Set(callerScopeSelection.teamIds),
          callerScopePositionIds: new Set(callerScopeSelection.positionIds),
          callerScopeEmployeeIds: new Set(callerScopeSelection.employeeIds),
          scopeDirectoryDiagnostics: {
            unmatchedEmployeeNos: (isFounder || activeCaller.data_scope === 'all') ? unmatchedEmployeeNos : [],
            unmatchedTeamEmployeeNos: (isFounder || activeCaller.data_scope === 'all') ? unmatchedTeamEmployeeNos : [],
            unmatchedPositionEmployeeNos: (isFounder || activeCaller.data_scope === 'all') ? unmatchedPositionEmployeeNos : [],
            ambiguousEmployeeNos: (isFounder || activeCaller.data_scope === 'all') ? ambiguousEmployeeNos : [],
            ambiguousTeamNames: (isFounder || activeCaller.data_scope === 'all') ? ambiguousTeamNames : [],
            ambiguousPositionNames: (isFounder || activeCaller.data_scope === 'all') ? ambiguousPositionNames : [],
          },
        }
      })()
      return scopeContextPromise
    }

    async function getScopedEmployees(activeOnly = true) {
      const scope = await getScopeContext()
      return scope.allEmployees.filter((employee: any) =>
        scope.allowedEmployeeIds.has(employee.id) && (!activeOnly || employee.status === 'active')
      )
    }

    function employeeWithoutSensitiveContact(employee: any) {
      if (!employee) return null
      const { work_tg: _workTg, ...safeEmployee } = employee
      return safeEmployee
    }

    async function requireEmployeeInScope(employeeId: string) {
      const scope = await getScopeContext()
      const employee = scope.employeeMap.get(employeeId)
      if (!employee || !scope.allowedEmployeeIds.has(employeeId)) {
        throw new Error('找不到员工或无操作权限')
      }
      return employee
    }

    type ScopeSelection = { teamIds: string[], positionIds: string[], employeeIds: string[] }

    async function scopeStructureWithinCaller(targetAccess: any, selection: ScopeSelection) {
      if (isFounder || activeCaller.data_scope === 'all') return true
      const scope = await getScopeContext()
      const targetDataScope = cleanString(targetAccess?.data_scope)
      const targetEmployeeId = cleanString(targetAccess?.employee_id)

      if (targetDataScope === 'all') return false
      if (targetDataScope === 'self') {
        if (!targetEmployeeId) return false
        if (targetEmployeeId === cleanString(activeCaller.employee_id)) return true
        return activeCaller.data_scope === 'assigned_teams'
          && scope.callerScopeEmployeeIds.has(targetEmployeeId)
      }
      if (targetDataScope === 'own_team') {
        // own_team follows the target employee across future transfers and is
        // therefore not a durable subset of any limited caller's current
        // dynamic scope. Only Founder/all may grant it (handled above).
        return false
      }
      if (targetDataScope !== 'assigned_teams') return false

      const targetTeamIds = cleanStringList(selection.teamIds)
      const targetPositionIds = cleanStringList(selection.positionIds)
      const targetEmployeeIds = cleanStringList(selection.employeeIds)
      const targetBoundary = validateAssignedScopeBoundary(
        targetTeamIds,
        targetPositionIds,
        targetEmployeeIds,
        scope.currentAssignments,
      )
      if (!targetBoundary.ok) return false

      // A fixed assigned grant can outlive an own_team/self caller's future
      // transfer. Those dynamic parent scopes therefore cannot delegate an
      // assigned scope at all.
      if (activeCaller.data_scope === 'self' || activeCaller.data_scope === 'own_team') return false
      if (activeCaller.data_scope === 'assigned_teams') {
        // An in-team employee supplement can outlive a position change. A
        // child may therefore inherit only supplements explicitly configured
        // on the parent, never a current base employee converted into one.
        if (!targetEmployeeIds.every(employeeId => scope.callerScopeEmployeeIds.has(employeeId))) return false
        if (!targetTeamIds.every(teamId => scope.callerScopeTeamIds.has(teamId))) return false
        if (targetTeamIds.length && scope.callerScopePositionIds.size > 0) {
          if (!targetPositionIds.length) return false
          if (!targetPositionIds.every(positionId => scope.callerScopePositionIds.has(positionId))) return false
        }
        return true
      }
      return false
    }

    async function targetEffectiveScopeWithinCaller(targetAuthUserId: string, targetAccess?: any) {
      if (isFounder) return true
      let access = targetAccess
      if (!access) {
        const { data, error } = await admin.from('user_access')
          .select('auth_user_id,employee_id,data_scope,backend_enabled,active')
          .eq('auth_user_id', targetAuthUserId)
          .maybeSingle()
        if (error) throw error
        access = data
      }
      if (!access?.backend_enabled) return false
      const selection = await readScope(targetAuthUserId)
      if (!await scopeStructureWithinCaller(access, selection)) return false
      // Disabling an account intentionally clears its materialized effective
      // scope.  A permissioned parent must still be able to reactivate it, but
      // only after the durable self/assigned-team structure above proves that
      // the grant cannot escape the caller's own scope. Dynamic own-team and
      // all-data targets already fail that structural check for limited callers.
      if (access?.active === false) return true
      const scope = await getScopeContext()
      const targetEmployeeIds = await loadEffectiveEmployeeIds(targetAuthUserId)
      return targetEmployeeIds.every((employeeId) =>
        scope.allowedEmployeeIds.has(cleanString(employeeId))
      )
    }

    async function validateDelegatedScope(
      employeeId: string | null,
      dataScope: string,
      teamIds: string[],
      positionIds: string[],
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

      if (!isFounder && !await scopeStructureWithinCaller(
        { employee_id: employeeId, data_scope: dataScope },
        { teamIds, positionIds, employeeIds },
      )) {
        throw new Error('目标账号的数据范围不是当前账号可持续授权的结构子集')
      }

      if (dataScope === 'own_team') {
        if (!employeeId) throw new Error('“自己团队”范围必须关联员工档案')
        const employee: any = scope.employeeMap.get(employeeId)
        const currentTeamId = employee ? scope.currentTeamIdByEmployeeId.get(employee.id) : ''
        if (!currentTeamId) throw new Error('关联员工不在当前排班或当前组织目录，不能授予“自己团队”范围')
        if (!isFounder && !scope.delegableTeamIds.has(currentTeamId)) {
          throw new Error('关联员工所在团队超出当前账号可授权范围')
        }
        if (!isFounder) {
          const targetTeamEmployeeIds = scope.allEmployees
            .filter((candidate: any) => scope.currentTeamIdByEmployeeId.get(candidate.id) === currentTeamId)
            .map((candidate: any) => candidate.id)
          if (targetTeamEmployeeIds.some(id => !scope.allowedEmployeeIds.has(id))) {
            throw new Error('“自己团队”会包含当前账号岗位/人员范围以外的人员，不能授权；请改用指定团队与岗位')
          }
        }
      }

      if (dataScope === 'assigned_teams') {
        const boundary = validateAssignedScopeBoundary(
          teamIds,
          positionIds,
          employeeIds,
          scope.currentAssignments,
        )
        if (!boundary.ok) {
          if (boundary.reason === 'team_required') {
            throw new Error('指定范围必须选择至少一个当前团队；团队是不可越过的数据边界')
          }
          if (boundary.reason === 'team_not_current') {
            throw new Error('选择的团队已不在当前排班目录，请刷新后重新选择')
          }
          if (boundary.reason === 'position_not_in_selected_team') {
            throw new Error('选择的岗位不属于已选当前团队，请重新选择团队内岗位')
          }
          if (boundary.reason === 'employee_not_in_selected_team') {
            throw new Error('指定员工不属于已选当前团队，不能作为团队外例外')
          }
          throw new Error('团队与岗位组合没有匹配人员，请调整范围')
        }
        const teamPartition = partitionCurrentTeamIds(teamIds, scope.currentTeamIds)
        if (teamPartition.staleTeamIds.length) {
          throw new Error('选择的团队已不在当前排班目录，请刷新后重新选择')
        }
        const invalidTeam = teamPartition.currentTeamIds.find(teamId =>
          !isFounder && !scope.delegableTeamIds.has(teamId)
        )
        if (invalidTeam) throw new Error('选择的团队超出当前账号可授权范围')

        const invalidPosition = boundary.positionIds.find(positionId =>
          !isFounder && !scope.delegablePositionIds.has(positionId)
        )
        if (invalidPosition) throw new Error('选择的团队内岗位超出当前账号可授权范围')

        const invalidEmployee = boundary.employeeIds.find(scopedEmployeeId =>
          !isFounder && !scope.allowedEmployeeIds.has(scopedEmployeeId)
        )
        if (invalidEmployee) throw new Error('选择的员工超出当前账号可授权范围')

        if (!isFounder && boundary.effectiveEmployeeIds.some(id => !scope.allowedEmployeeIds.has(id))) {
          throw new Error('团队与岗位组合会包含当前账号范围以外的人员，不能授权')
        }
      }
    }

    async function readScope(targetAuthUserId: string) {
      const [teamRes, positionRes, employeeRes] = await Promise.all([
        admin.from('user_scope_team_filters').select('team_id').eq('auth_user_id', targetAuthUserId),
        admin.from('user_scope_position_filters').select('position_id').eq('auth_user_id', targetAuthUserId),
        admin.from('user_scope_employee_filters').select('employee_id').eq('auth_user_id', targetAuthUserId),
      ])
      if (teamRes.error) throw teamRes.error
      if (positionRes.error) throw positionRes.error
      if (employeeRes.error) throw employeeRes.error
      return {
        teamIds: (teamRes.data || []).map((row: any) => row.team_id),
        positionIds: (positionRes.data || []).map((row: any) => row.position_id),
        employeeIds: (employeeRes.data || []).map((row: any) => row.employee_id),
      }
    }

    async function saveAccountAccessScope(
      targetAuthUserId: string,
      employeeId: string | null,
      roleId: string,
      dataScope: string,
      selection: ScopeSelection,
    ) {
      const { error } = await admin.rpc('admin_save_account_access_scope', {
        p_auth_user_id: targetAuthUserId,
        p_employee_id: employeeId,
        p_role_id: roleId,
        p_data_scope: dataScope,
        p_team_ids: cleanStringList(selection.teamIds),
        p_position_ids: cleanStringList(selection.positionIds),
        p_employee_ids: cleanStringList(selection.employeeIds),
      })
      if (error) throw error
    }

    async function getTargetAccount(targetAuthUserId: string) {
      if (!targetAuthUserId) throw new Error('账号标识不正确')
      if (targetAuthUserId === authenticatedUser.id) {
        throw new Error('当前登录账号不能在这里修改自身状态、权限或凭据')
      }
      const { data: targetAccess, error } = await admin.from('user_access')
        .select('auth_user_id,employee_id,role_id,data_scope,backend_enabled,employee_portal_enabled,active,roles(id,code,name)')
        .eq('auth_user_id', targetAuthUserId)
        .maybeSingle()
      if (error) throw error
      if (!targetAccess) throw new Error('账号不存在')

      const targetRole = Array.isArray(targetAccess.roles) ? targetAccess.roles[0] : targetAccess.roles
      if (targetRole?.code === 'founder') {
        throw new Error('Founder 账号受保护，不能通过普通账号操作修改')
      }
      if (!isFounder) {
        if (!targetAccess.employee_id) throw new Error('该账号未关联员工档案，只有 Founder 可以管理')
        await requireEmployeeInScope(targetAccess.employee_id)
        const isStaffPortalAccount = !targetAccess.backend_enabled &&
          targetAccess.employee_portal_enabled &&
          targetRole?.code === 'employee'
        // Staff-only accounts cannot read backend modules and therefore have
        // no delegated backend employee scope to contain. Their linked
        // employee was already checked against the caller above.
        if (!isStaffPortalAccount && !await targetEffectiveScopeWithinCaller(targetAuthUserId, targetAccess)) {
          throw new Error('目标账号的数据范围超出当前账号可管理范围')
        }
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
          .select('id,employee_no,full_name,team_id,position_id')
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
          login_username: caller.login_username || null,
          login_email: caller.login_email || userData.user.email || null,
          employee_no: employeeContext?.employee_no || null,
          full_name: employeeContext?.full_name || null,
        },
      })
    }

    if (action === 'online_presence') {
      const includeRows = body?.include_rows === true
      const allowedFields = includeRows
        ? new Set(['action', 'include_rows', 'portal', 'page', 'page_size'])
        : new Set(['action', 'include_rows'])
      if (Object.keys(body || {}).some(key => !allowedFields.has(key))) {
        return json(req, { error:'在线人员请求包含不受支持的字段' }, 400)
      }

      if (includeRows) {
        if (!can('account.online_presence.view')) {
          return json(req, { error:'无在线账号名单查看权限' }, 403)
        }
        const portal = cleanString(body?.portal).toLowerCase()
        const page = Number(body?.page ?? 1)
        const pageSize = Number(body?.page_size ?? 20)
        if (!['admin', 'staff'].includes(portal) ||
            !Number.isInteger(page) || page < 1 || page > 500 ||
            !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
          return json(req, { error:'在线人员分页参数不正确' }, 400)
        }

        try {
          // The authenticated RPC re-checks the current admin session, the
          // explicit permission and the caller's data scope at the database
          // boundary.  It returns at most one small page and has its own 2.5s
          // statement timeout in addition to this 4s network deadline.
          const { data:presencePage, error:presencePageError } = await boundedPresence(
            userClient.rpc('admin_online_presence_page_v1', {
              p_portal:portal,
              p_page:page,
              p_page_size:pageSize,
            }),
            'PRESENCE_DETAIL_PAGE',
          )
          if (presencePageError) {
            const code = cleanString(presencePageError.code).toUpperCase()
            const message = cleanString(presencePageError.message)
            if (code === '42501' || /permission|session|access_denied/i.test(message)) {
              return json(req, { error:'无在线账号查看权限' }, 403)
            }
            if (code === '22023' || /invalid_presence/i.test(message)) {
              return json(req, { error:'在线人员分页参数不正确' }, 400)
            }
            console.error('bounded online presence page failed', presencePageError)
            return json(req, { error:'在线人员名单暂时读取失败，请重试' }, 503)
          }
          const nowIso = new Date().toISOString()
          return json(req, {
            ok:true,
            degraded:false,
            count_only:false,
            refreshed_at:nowIso,
            online_window_seconds:300,
            [portal]:presencePage || {
              portal,
              page,
              page_size:pageSize,
              total:0,
              pages:1,
              rows:[],
            },
          })
        } catch (error) {
          console.error('bounded online presence page failed', error)
          return json(req, { error:'在线人员名单暂时读取失败，请重试' }, 503)
        }
      }

      try {
        // Background badge refreshes stay count-only and head-only.  The guard
        // admits any current backend session but never authorises list rows.
        const { data:presenceAllowed, error:presenceGuardError } = await boundedPresence(
          userClient.rpc('admin_online_presence_counts_allowed'),
          'PRESENCE_COUNT_SESSION_GUARD',
        )
        if (presenceGuardError) {
          console.error('online presence guard failed', presenceGuardError)
          return json(req, { error:'在线状态验证暂时失败，请重试' }, 503)
        }
        if (presenceAllowed !== true) return json(req, { error:'无后台权限' }, 403)

        const nowIso = new Date().toISOString()
        const [adminCountResult, staffCountResult] = await Promise.all([
          boundedPresence(
            admin.from('app_session_leases').select('user_id', { count:'exact', head:true }).eq('portal','admin').gt('lease_expires_at',nowIso),
            'ADMIN_PRESENCE_COUNT',
          ),
          boundedPresence(
            admin.from('app_session_leases').select('user_id', { count:'exact', head:true }).eq('portal','staff').gt('lease_expires_at',nowIso),
            'STAFF_PRESENCE_COUNT',
          ),
        ])
        if (adminCountResult.error || staffCountResult.error) {
          return json(req, { error:'在线人数暂时读取失败，请重试' }, 503)
        }
        return json(req, {
          ok:true,
          degraded:true,
          count_only:true,
          refreshed_at:nowIso,
          online_window_seconds:300,
          admin:{ count:Number(adminCountResult.count || 0), rows:[] },
          staff:{ count:Number(staffCountResult.count || 0), rows:[] },
        })
      } catch (error) {
        console.error('bounded online presence count failed', error)
        return json(req, { error:'在线人数暂时读取失败，请重试' }, 503)
      }
    }

    if (action === 'dashboard') {
      if (!can('dashboard.view')) return json(req, { error: '无后台首页权限' }, 403)
      // Keep the request's user JWT for the RPC.  The database function checks
      // the current admin session, granular permissions and effective employee
      // scope, then returns bounded aggregates.  Do not use the service client
      // here: auth.uid() must remain the signed-in caller, and the old service
      // path fetched and serialized the complete employee directory.
      const { data: dashboard, error: dashboardError } = await userClient
        .rpc('admin_home_dashboard')
      if (dashboardError || !dashboard) {
        console.error('bounded dashboard failed', dashboardError)
        return json(req, { error: '首页数据读取失败，请稍后重试' }, 500)
      }

      return json(req, {
        ...dashboard,
        caller: {
          auth_user_id: userData.user.id,
          role_code: callerRole?.code || null,
          is_founder: isFounder,
          permissions: isFounder ? ['*'] : [...callerEffectivePermissions],
        },
      })
    }

    if (action === 'company_assets') {
      if (!can('asset.view')) return json(req, { error: '无公司资产查看权限' }, 403)
      const employees = (await getScopedEmployees(true))
        .filter((employee: any) => {
          const employeeNo = cleanString(employee.employee_no).toUpperCase()
          return employeeNo && !['SYSTEM', 'ADMIN'].includes(employeeNo) &&
            !employeeNo.startsWith('TEST') && cleanString(employee.source_type) !== 'google_deleted'
        })
        .map((employee: any) => ({
          id: employee.id,
          employee_no: cleanString(employee.employee_no),
          full_name: cleanString(employee.full_name),
          hire_date: cleanString(employee.hire_date).slice(0, 10) || null,
          country: cleanString(employee.country || employee.nationality) || null,
          work_tg: cleanString(employee.work_tg) || null,
          status: employee.status,
          source_type: employee.source_type,
        }))
      return json(req, { ok:true, employees, asset_source_connected:false })
    }

    if (action === 'bootstrap') {
      // Page actions never imply the right to read the page dataset. This also
      // makes malformed roles with a lone edit/delete checkbox fail closed.
      const mayViewBackendAccounts = can('backend_account.view')
      const mayViewStaffAccounts = can('staff_account.view')
      const mayViewAccounts = mayViewBackendAccounts || mayViewStaffAccounts
      if (!mayViewAccounts && !can('role.view')) {
        return json(req, { error: '无账号与权限查看权限' }, 403)
      }
      const mayManageRoles = can('role.view')
      const mayCreateAccounts = can('account.create')
      const scope = await getScopeContext()
      // Scope-picker candidates come only from the strict current roster.
      // Founder/all may still manage archived account records, but stale
      // employees must never reappear as selectable authorization targets.
      const employees = mayViewAccounts
        ? (await getScopedEmployees(true)).filter((employee: any) =>
          scope.currentTeamIdByEmployeeId.has(employee.id) &&
          scope.currentPositionIdByEmployeeId.has(employee.id)
        )
        : []
      const emptyResult = () => Promise.resolve({ data: [] as any[], error: null })

      const [
        accessRes,
        roleRes,
        permissionRes,
        rpRes,
        positionRes,
        scopeTeamRes,
        scopePositionRes,
        scopeEmployeeRes,
      ] = await Promise.all([
        mayViewAccounts ? admin.from('user_access')
          .select('auth_user_id,employee_id,role_id,login_username,login_email,backend_enabled,employee_portal_enabled,otp_required,data_scope,active,must_change_password,created_at,roles(id,code,name,system_locked,active)')
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
          ? admin.from('user_scope_team_filters').select('auth_user_id,team_id')
          : emptyResult(),
        mayViewAccounts
          ? admin.from('user_scope_position_filters').select('auth_user_id,position_id')
          : emptyResult(),
        mayViewAccounts
          ? admin.from('user_scope_employee_filters').select('auth_user_id,employee_id')
          : emptyResult(),
      ])

      if (accessRes.error) return json(req, { error: accessRes.error.message }, 500)
      if (roleRes.error) return json(req, { error: roleRes.error.message }, 500)
      if (permissionRes.error) return json(req, { error: permissionRes.error.message }, 500)
      if (rpRes.error) return json(req, { error: rpRes.error.message }, 500)
      if (positionRes.error) return json(req, { error: positionRes.error.message }, 500)
      if (scopeTeamRes.error) return json(req, { error: scopeTeamRes.error.message }, 500)
      if (scopePositionRes.error) return json(req, { error: scopePositionRes.error.message }, 500)
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
        if (account.backend_enabled && !await targetEffectiveScopeWithinCaller(account.auth_user_id)) {
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
      const decorateScopeEmployee = (employee: any) => employee
        ? {
          ...employeeWithoutSensitiveContact(employee),
          current_team_id: scope.currentTeamIdByEmployeeId.get(employee.id) || null,
          current_position_id: scope.currentPositionIdByEmployeeId.get(employee.id) || null,
        }
        : null
      const decorate = (x: any) => ({
        ...x,
        employee: x.employee_id
          ? decorateScopeEmployee(scope.employeeMap.get(x.employee_id))
          : null,
      })

      let manageableAccountsWithLocks: any[]
      let loginPasswordPolicy: any = null
      try {
        ;[manageableAccountsWithLocks, loginPasswordPolicy] = await Promise.all([
          decoratePasswordLockStates(manageableAccounts),
          mayViewBackendAccounts ? loadLoginPasswordPolicy() : Promise.resolve(null),
        ])
      } catch (lockStateError) {
        console.error('account lock state bootstrap failed', lockStateError)
        return json(req, { error:'账号锁定状态暂时读取失败，请重试' }, 503)
      }

      const backendAccounts = (mayViewBackendAccounts ? manageableAccountsWithLocks : [])
        .filter((x: any) => x.backend_enabled)
        .map(decorate)

      const employeeAccounts = (mayViewStaffAccounts ? manageableAccountsWithLocks : [])
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
        ? scope.currentTeams.filter((team: any) => isFounder || scope.delegableTeamIds.has(team.id))
        : []
      const positions = mayViewAccounts
        ? (positionRes.data || []).filter((position: any) =>
          isFounder ? scope.currentPositionIds.has(position.id) : scope.delegablePositionIds.has(position.id)
        ).map((position: any) => ({
          ...position,
          member_count: scope.currentPositionMemberCounts.get(cleanString(position.id)) || 0,
          team_ids: [...(scope.currentTeamIdsByPositionId.get(cleanString(position.id)) || [])],
        }))
        : []
      const visibleScopeTeamRows = (scopeTeamRes.data || [])
        .filter((row: any) => manageableAccountIds.has(row.auth_user_id))
      const currentScopeTeams = visibleScopeTeamRows
        .filter((row: any) => scope.currentTeamIds.has(row.team_id))
      const staleScopeTeams = visibleScopeTeamRows
        .filter((row: any) => !scope.currentTeamIds.has(row.team_id))

      return json(req, {
        ok: true,
        caller: {
          auth_user_id: userData.user.id,
          role_code: callerRole?.code || null,
          is_founder: isFounder,
          permissions: isFounder ? ['*'] : [...callerEffectivePermissions],
        },
        employees: employees.map(decorateScopeEmployee),
        backend_accounts: backendAccounts,
        employee_accounts: employeeAccounts,
        login_password_policy:loginPasswordPolicy,
        roles,
        permissions: mayManageRoles ? permissionRes.data || [] : [],
        role_permissions: mayManageRoles ? rpRes.data || [] : [],
        teams,
        positions,
        scope_teams: currentScopeTeams,
        stale_scope_teams: staleScopeTeams,
        scope_positions: (scopePositionRes.data || []).filter((row: any) => manageableAccountIds.has(row.auth_user_id)),
        scope_employees: (scopeEmployeeRes.data || []).filter((row: any) => manageableAccountIds.has(row.auth_user_id)),
        scope_directory_diagnostics: scope.scopeDirectoryDiagnostics,
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
      let permissionIds = cleanStringList(body.permission_ids)

      const { data: role } = await admin.from('roles')
        .select('id,code,system_locked')
        .eq('id', roleId).maybeSingle()

      if (!role) return json(req, { error: '角色不存在' }, 404)
      if (role.code === 'founder') return json(req, { error: 'Founder 固定拥有全部权限' }, 400)

      if (permissionIds.length) {
        const { data: validPermissions, error: permissionError } = await admin.from('permissions')
          .select('id,code').in('id', permissionIds)
        if (permissionError) return json(req, { error: permissionError.message }, 400)
        const validIds = new Set((validPermissions || []).map((permission: any) => permission.id))
        if (permissionIds.some(permissionId => !validIds.has(permissionId))) {
          return json(req, { error: '包含不存在的权限项目' }, 400)
        }

        // Never trust hidden legacy ids echoed by a stale or crafted client.
        // Rebuild them only from the selected current-page permissions below,
        // so clearing the new checkbox also clears its private dependency.
        const hiddenLegacyCodes = new Set([
          'employee.view','employee.resign','employee.reactivate','audit.view',
          'schedule.view','attendance.view','attendance.edit','leave.approve',
          'report.view','report.edit','export.general',
          'online_training.view','online_training.submit','online_training.review','online_training.manage',
          'exam.view','exam.manage','exam.grade','exam.delete',
          'adjustment.view','adjustment.create','adjustment.approve','daily_work.submit','daily_work.manage',
          'payroll.view','payroll.edit','payroll.approve','payroll.publish','payroll.export','payroll.rule.edit','payroll.payout_change.view','payroll.payout_change.review',
          'user.view','account.view','account.mfa_reset',
        ])
        const visiblePermissions = (validPermissions || []).filter((permission: any) => !hiddenLegacyCodes.has(cleanString(permission.code)))
        permissionIds = visiblePermissions.map((permission: any) => permission.id)

        // Granular page wrappers reuse proven legacy implementations behind a
        // revoked public entrypoint. Keep the implementation dependency hidden
        // and synchronized whenever Founder saves the visible page checkboxes.
        const legacyDependencies = new Set<string>()
        for (const permission of visiblePermissions) {
          const code = cleanString(permission.code)
          const add = (...codes: string[]) => codes.forEach(item => legacyDependencies.add(item))
          if (code.startsWith('work.event.')) add(code.endsWith('.submit') ? 'daily_work.submit' : code.endsWith('.manage') ? 'daily_work.manage' : code.endsWith('.edit') ? 'report.edit' : 'report.view')
          else if (code.startsWith('work.daily_inspection.')) add(code.endsWith('.edit') ? 'report.edit' : 'daily_work.manage')
          else if (code.startsWith('work.quality_inspection.')) add('report.edit')
          // Payroll readers and mutations are bridged directly to their new
          // page codes. Never restore broad payroll.* grants here: those old
          // grants also unlock unrelated legacy RPCs.
          // Alert internals are bridged directly to the new type permissions;
          // selecting an alert never restores an unrelated legacy page grant.
          else if (code === 'asset.view' || code === 'staff_account.view') add('user.view')
          else if (code === 'backend_account.view') add('account.view')
          else if (code.endsWith('_account.mfa_reset')) add('account.mfa_reset')
          else if (code === 'role.view') { /* role reads are enforced directly */ }
          else if (code === 'role.audit.view') add('audit.view')
        }
        if (legacyDependencies.size) {
          const { data: dependencyRows, error: dependencyError } = await admin.from('permissions')
            .select('id').in('code', [...legacyDependencies])
          if (dependencyError) return json(req, { error: dependencyError.message }, 400)
          permissionIds = [...new Set([...permissionIds,...(dependencyRows || []).map((row: any) => row.id)])]
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
      const positionIds = cleanStringList(input.position_ids)
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
        await validateDelegatedScope(employeeId, dataScope, teamIds, positionIds, employeeIds)
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

      try {
        await saveAccountAccessScope(
          created.user.id,
          employeeId,
          roleId,
          dataScope,
          {
            teamIds: dataScope === 'assigned_teams' ? teamIds : [],
            positionIds: dataScope === 'assigned_teams' ? positionIds : [],
            employeeIds: dataScope === 'assigned_teams' ? employeeIds : [],
          },
        )
      } catch (error) {
        await admin.from('user_access').delete().eq('auth_user_id', created.user.id)
        await admin.auth.admin.deleteUser(created.user.id)
        throw createAccountError(error instanceof Error ? error.message : '管理范围保存失败')
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
      const positionIds = cleanStringList(body.position_ids)
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

      let previousScope: ScopeSelection
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
      const scope = await getScopeContext()
      const previousCurrentTeamIds = partitionCurrentTeamIds(
        previousScope.teamIds,
        scope.currentTeamIds,
      ).currentTeamIds
      const assignedScopeChanged = dataScope === 'assigned_teams' && (
        !sameIds(previousCurrentTeamIds, teamIds) ||
        !sameIds(previousScope.positionIds, positionIds) ||
        !sameIds(previousScope.employeeIds, employeeIds)
      )
      const scopeChanged = cleanString(current.employee_id) !== cleanString(employeeId) ||
        cleanString(current.data_scope) !== dataScope || assignedScopeChanged
      if (scopeChanged && !can('scope.manage')) {
        return json(req, { error: '无管理账号数据范围权限' }, 403)
      }

      try {
        await validateDelegatedScope(employeeId, dataScope, teamIds, positionIds, employeeIds)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '管理范围不正确' }, 403)
      }

      try {
        await saveAccountAccessScope(
          target,
          employeeId,
          roleId,
          dataScope,
          {
            teamIds: dataScope === 'assigned_teams' ? teamIds : [],
            positionIds: dataScope === 'assigned_teams' ? positionIds : [],
            employeeIds: dataScope === 'assigned_teams' ? employeeIds : [],
          },
        )
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '账号与管理范围保存失败' }, 400)
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
      const employees = await getScopedEmployees(false)
      const employee = employees.find((x: any) =>
        cleanString(x.employee_no).toUpperCase() === employeeNo &&
        ['active', 'probation'].includes(cleanString(x.status).toLowerCase())
      )
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
      let current: any
      try {
        current = await getTargetAccount(target)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '无账号操作权限' }, 403)
      }
      if (!current.backend_enabled) {
        return json(req, { error: '后台登录 OTP 开关只能用于后台账号' }, 400)
      }
      const { error } = await admin.from('user_access')
        .update({ otp_required: required })
        .eq('auth_user_id', target)
      if (error) return json(req, { error: error.message }, 400)
      await audit('otp_toggle', `OTP=${required} ${target}`)
      return json(req, { ok: true, saved: { auth_user_id: target, otp_required: required } })
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
      return json(req, { ok: true, saved: { auth_user_id: target, active } })
    }

    if (action === 'unlock_login' || action === 'unlock_staff_login') {
      const target = cleanString(body.auth_user_id)
      const reason = cleanString(body.reason || '后台人工解锁').slice(0, 200)
      if (!target) return json(req, { error:'账号标识不正确' }, 400)

      let current: any
      if (target === authenticatedUser.id && isFounder && action === 'unlock_login') {
        current = { ...activeCaller, targetRole:callerRole }
      } else {
        try {
          current = await getTargetAccount(target)
        } catch (error) {
          return json(req, { error:error instanceof Error ? error.message : '无账号操作权限' }, 403)
        }
      }
      const backendTarget = Boolean(current.backend_enabled)
      const expectedBackendTarget = action === 'unlock_login'
      if (backendTarget !== expectedBackendTarget || (!backendTarget && !current.employee_portal_enabled)) {
        return json(req, { error:'账号类型与解锁入口不一致' }, 400)
      }
      const requiredPermission = backendTarget ? 'backend_account.unlock' : 'staff_account.unlock'
      if (!can(requiredPermission)) return json(req, { error:'无解锁该类账号的权限' }, 403)

      const { data:saved, error } = await admin.rpc('login_password_lock_clear', {
        p_target_user_id:target,
        p_actor_user_id:authenticatedUser.id,
        p_reason:reason || '后台人工解锁',
      })
      if (error) {
        const status = cleanString(error.code) === '42501' ? 403 : 400
        return json(req, { error:status === 403 ? '该账号不在你可解锁的权限或数据范围内' : error.message }, status)
      }
      return json(req, { ok:true, saved })
    }

    if (action === 'update_login_lockout_policy') {
      if (!can('backend_account.lockout_policy_manage')) {
        return json(req, { error:'无密码锁定阈值设置权限' }, 403)
      }
      const threshold = Number(body.lock_threshold)
      if (!Number.isInteger(threshold) || threshold < 3 || threshold > 99) {
        return json(req, { error:'密码错误锁定阈值必须是 3–99 的整数' }, 400)
      }
      const { data:policy, error } = await admin.rpc('login_password_lockout_policy_set', {
        p_actor_user_id:authenticatedUser.id,
        p_lock_threshold:threshold,
        p_reason:cleanString(body.reason || '后台调整密码错误锁定阈值').slice(0, 200),
      })
      if (error) {
        const status = cleanString(error.code) === '42501' ? 403 : 400
        return json(req, { error:status === 403 ? '无密码锁定阈值设置权限' : error.message }, status)
      }
      return json(req, { ok:true, login_password_policy:policy })
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
      const target = cleanString(body.auth_user_id)

      let targetAccount: any
      try {
        targetAccount = await getTargetAccount(target)
      } catch (error) {
        return json(req, { error: error instanceof Error ? error.message : '无账号操作权限' }, 403)
      }
      const resetPermission = targetAccount.backend_enabled ? 'backend_account.mfa_reset' : 'staff_account.mfa_reset'
      if (!can(resetPermission)) return json(req, { error: '无重置OTP权限' }, 403)

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
      // Any portal-only identity must use the recovery endpoint. Do not let a
      // stale/misconfigured role label fall through to the legacy hard delete.
      const pureStaffAccount = !current.backend_enabled &&
        current.employee_portal_enabled === true
      if (pureStaffAccount) {
        return json(req, {
          error:'员工前端账号必须通过“保留历史记录的安全删除”流程处理，请刷新后使用员工账号页的删除按钮',
          code:'staff_delete_requires_recovery',
          retryable:false,
        }, 409)
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
      // This historical shortcut only checked the team and could bypass the
      // current-roster position intersection. All employee writes must use the
      // dedicated admin-employee-write function, which validates the final
      // team + position combination before inserting or updating anything.
      return json(req, { error: '请刷新页面后使用员工档案的新增入口' }, 410)
    }

    return json(req, { error: 'Unknown action' }, 400)
  } catch (error) {
    console.error(error)
    return json(req, { error: error instanceof Error ? error.message : '服务器错误' }, 500)
  }
})
