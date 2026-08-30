import { createClient } from 'npm:@supabase/supabase-js@2.112.3'
import {
  AdminRequestIpError,
  enforceAdminRequestIp,
} from '../_shared/adminRequestIp.ts'
import {
  buildRecoveryProvisioningFingerprint,
  recoveryIdentityDisposition,
} from '../_shared/recoveryProvisioningFingerprint.js'

const ALLOWED_ORIGIN = 'https://adrianus898989.github.io'
const DEPENDENCY_TIMEOUT_MS = 8_000
const PRESENCE_DETAIL_TIMEOUT_MS = 4_000
const AUTH_MUTATION_TIMEOUT_MS = 12_000
const DEFAULT_ACCOUNT_PAGE_SIZE = 20
const ACCOUNT_PAGE_SIZE_OPTIONS = new Set([20, 30, 50, 100, 200])
const ACCOUNT_EMPLOYEE_LOOKUP_LIMIT = 10
const RECOVERY_ROLE_LIMIT = 100
const RECOVERY_PERMISSION_LIMIT = 500
const RECOVERY_ROLE_PERMISSION_LIMIT = 5_000
const RECOVERY_ROLE_PERMISSION_WRITE_LIMIT = 500
const RECOVERY_AUTH_DOMAIN = 'admin.wfh.invalid'
const RECOVERY_PROVISIONING_MARKER = 'wfh_backend_recovery_v1'
const RECOVERY_PROVISIONING_FINGERPRINT_KEY = 'wfh_provisioning_fingerprint'
const RECOVERY_ACCOUNT_ACTIONS = [
  'toggle_active',
  'toggle_otp',
  'reset_password',
  'reset_mfa',
]
const RECOVERY_ACCOUNT_ACTION_PERMISSION: Record<string, string> = {
  toggle_active:'account.disable',
  toggle_otp:'account.otp_toggle',
  reset_password:'account.reset_password',
  reset_mfa:'backend_account.mfa_reset',
}

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function json(req: Request, body: unknown, status = 200, retryAfter = '') {
  const headers: Record<string, string> = {
    ...cors(req.headers.get('origin')),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (retryAfter) headers['Retry-After'] = retryAfter
  return new Response(JSON.stringify(body), { status, headers })
}

const clean = (value: unknown) => String(value ?? '').trim()
const uuidLike = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const passwordOk = (value: string) => value.length >= 10 &&
  /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value)

function backendStatus(value: any) {
  return Number(value?.status || value?.statusCode || value?.context?.status || 0)
}

async function bounded<T>(
  operation: PromiseLike<T>,
  label: string,
  timeoutMs = DEPENDENCY_TIMEOUT_MS,
): Promise<T> {
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
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function boundedAuthMutation<T>(operation: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_OUTCOME_UNKNOWN`)), AUTH_MUTATION_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function retryable(req: Request, message: string, code = 'service_temporarily_unavailable') {
  return json(req, {
    ok: false,
    error: message,
    code,
    retryable: true,
    preserve_session: true,
  }, 503, '30')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req.headers.get('origin')) })
  if (req.method !== 'POST') return json(req, { ok:false, error:'Method not allowed' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const action = clean(body?.action || 'access')
    // Older production bundles used `bootstrap` for the shell permission read.
    // During recovery it is a read-only alias of `access`; it must never fall
    // through to the former full-directory bootstrap implementation.
    if (![
      'access', 'bootstrap', 'dashboard', 'online_presence', 'role_list', 'save_role_permissions',
      'account_list', 'create_backend', ...RECOVERY_ACCOUNT_ACTIONS,
    ].includes(action)) {
      return json(req, {
        ok: false,
        error: 'temporarily_paused_for_database_recovery',
        code: 'temporarily_paused_for_database_recovery',
        retryable: true,
        preserve_session: true,
      }, 503, '120')
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
    const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
    const secretKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const publishableKey = publishableKeys.default || Deno.env.get('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !secretKey || !publishableKey) {
      return retryable(req, '服务配置暂时不可用')
    }

    const authorization = req.headers.get('Authorization') || ''
    if (!authorization) {
      return json(req, {
        ok:false,
        error:'登录已失效',
        code:'not_authenticated',
        retryable:false,
        preserve_session:false,
      }, 401)
    }

    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession:false, autoRefreshToken:false },
    })
    const admin = createClient(supabaseUrl, secretKey, {
      auth: { persistSession:false, autoRefreshToken:false },
    })

    const { data:userData, error:userError } = await bounded(userClient.auth.getUser(), 'AUTH_USER')
    if (userError) {
      const status = backendStatus(userError)
      if (status === 401 || status === 403) {
        return json(req, {
          ok:false,
          error:'登录已失效',
          code:'not_authenticated',
          retryable:false,
          preserve_session:false,
        }, 401)
      }
      return retryable(req, '登录服务暂时繁忙，请稍后重试')
    }
    if (!userData?.user) {
      return json(req, {
        ok:false,
        error:'登录已失效',
        code:'not_authenticated',
        retryable:false,
        preserve_session:false,
      }, 401)
    }

    await enforceAdminRequestIp(req, admin, userData.user.id, authorization)

    const { data:sessionCurrent, error:sessionError } = await bounded(
      userClient.rpc('admin_access_session_allowed'),
      'CURRENT_SESSION',
    )
    if (sessionError) {
      const message = clean(sessionError.message)
      const code = clean(sessionError.code).toUpperCase()
      if (/not_authenticated|session_not_current/i.test(message) || code === '42501') {
        return json(req, {
          ok:false,
          error:'当前浏览器会话已失效或账号已在其他设备登录',
          code:'session_not_current',
          retryable:false,
          preserve_session:false,
        }, 401)
      }
      return retryable(req, '权限验证暂时繁忙，请稍后重试')
    }
    if (sessionCurrent !== true) {
      return json(req, {
        ok:false,
        error:'当前浏览器会话已失效或账号已在其他设备登录',
        code:'session_not_current',
        retryable:false,
        preserve_session:false,
      }, 401)
    }

    const { data:caller, error:callerError } = await bounded(
      admin.from('user_access')
        .select('auth_user_id,employee_id,role_id,data_scope,backend_enabled,active,login_username,login_email,roles(id,code,name,active)')
        .eq('auth_user_id', userData.user.id)
        .maybeSingle(),
      'CALLER_ACCESS',
    )
    const callerRole = Array.isArray(caller?.roles) ? caller.roles[0] : caller?.roles
    if (callerError) return retryable(req, '后台账号权限暂时读取失败，请重试')
    if (!caller || !caller.active || !caller.backend_enabled || callerRole?.active !== true) {
      return json(req, {
        ok:false,
        error:'无后台权限',
        code:'backend_access_denied',
        retryable:false,
        preserve_session:false,
      }, 403)
    }

    const [{ data:roleRows, error:roleError }, { data:overrideRows, error:overrideError }] = await Promise.all([
      bounded(
        admin.from('role_permissions').select('permission_id,permissions(code)').eq('role_id', caller.role_id),
        'ROLE_PERMISSIONS',
      ),
      bounded(
        admin.from('user_permission_overrides').select('allowed,permission_id,permissions(code)').eq('auth_user_id', userData.user.id),
        'PERMISSION_OVERRIDES',
      ),
    ])
    if (roleError || overrideError) return retryable(req, '后台账号权限暂时读取失败，请重试')

    const permissions = new Set<string>()
    const permissionIds = new Set<string>()
    for (const row of roleRows || []) {
      const permission = Array.isArray(row.permissions) ? row.permissions[0] : row.permissions
      if (permission?.code) permissions.add(permission.code)
      if (row.permission_id) permissionIds.add(row.permission_id)
    }
    for (const row of overrideRows || []) {
      const permission = Array.isArray(row.permissions) ? row.permissions[0] : row.permissions
      if (!permission?.code) continue
      if (row.allowed) {
        permissions.add(permission.code)
        if (row.permission_id) permissionIds.add(row.permission_id)
      } else {
        permissions.delete(permission.code)
        if (row.permission_id) permissionIds.delete(row.permission_id)
      }
    }
    const isFounder = callerRole?.code === 'founder'
    const can = (code: string) => isFounder || permissions.has('*') || permissions.has(code)
    const delegatedRecoveryAccounts = isFounder || caller.data_scope === 'all'
    const supportedRecoveryAccountActions = delegatedRecoveryAccounts
      ? RECOVERY_ACCOUNT_ACTIONS.filter(accountAction => can(RECOVERY_ACCOUNT_ACTION_PERMISSION[accountAction]))
      : []

    const recheckRecoveryMutationGate = async () => {
      await enforceAdminRequestIp(req, admin, userData.user.id, authorization)
      const { data:stillCurrent, error:currentError } = await bounded(
        userClient.rpc('admin_access_session_allowed'),
        'RECOVERY_MUTATION_CURRENT_SESSION',
      )
      if (currentError) throw currentError
      if (stillCurrent !== true) {
        const error:any = new Error('session_not_current')
        error.code = 'session_not_current'
        throw error
      }
    }

    const loadRecoveryBackendTarget = async (targetAuthUserId: string) => {
      const { data:target, error:targetError } = await bounded(
        admin.from('user_access')
          .select('auth_user_id,backend_enabled,active,otp_required,roles(code,active)')
          .eq('auth_user_id', targetAuthUserId)
          .eq('backend_enabled', true)
          .maybeSingle(),
        'RECOVERY_BACKEND_TARGET',
      )
      if (targetError) throw targetError
      const targetRole = Array.isArray(target?.roles) ? target.roles[0] : target?.roles
      if (!target || targetRole?.active !== true) return null
      return { ...target, role_code:targetRole?.code || null }
    }

    const recoveryBackendActionAllowed = async (targetAuthUserId: string, requiredPermission: string) => {
      const { data:allowed, error } = await bounded(
        admin.rpc('admin_recovery_backend_action_allowed', {
          p_actor_user_id:userData.user.id,
          p_target_user_id:targetAuthUserId,
          p_required_permission:requiredPermission,
        }),
        'RECOVERY_BACKEND_ACTION_PREFLIGHT',
      )
      if (error) throw error
      return allowed === true
    }

    let assignableRolesPromise: Promise<any[]> | null = null
    const loadAssignableRoles = () => {
      if (assignableRolesPromise) return assignableRolesPromise
      assignableRolesPromise = (async () => {
        const { data:roleOptions, error:roleOptionsError } = await bounded(
          admin.from('roles')
            .select('id,code,name,system_locked,active')
            .eq('active', true)
            .not('code', 'in', '(founder,employee)')
            .order('name'),
          'ASSIGNABLE_ROLES',
        )
        if (roleOptionsError) throw roleOptionsError
        if (isFounder) return roleOptions || []
        if (!roleOptions?.length) return []

        const roleIds = roleOptions.map((role:any) => role.id)
        const [{ data:targetPermissionRows, error:targetPermissionError }, { data:delegationRows, error:delegationError }] = await Promise.all([
          bounded(
            admin.from('role_permissions').select('role_id,permission_id').in('role_id', roleIds),
            'TARGET_ROLE_PERMISSIONS',
          ),
          bounded(
            admin.from('backend_role_assignment_rules')
              .select('target_role_id')
              .eq('grantor_role_id', caller.role_id)
              .eq('active', true),
            'ROLE_DELEGATION_RULES',
          ),
        ])
        if (targetPermissionError || delegationError) {
          throw targetPermissionError || delegationError
        }
        const permissionIdsByRole = new Map<string, Set<string>>()
        for (const row of targetPermissionRows || []) {
          if (!permissionIdsByRole.has(row.role_id)) permissionIdsByRole.set(row.role_id, new Set())
          permissionIdsByRole.get(row.role_id)!.add(row.permission_id)
        }
        const explicitlyDelegable = new Set((delegationRows || []).map((row:any) => row.target_role_id))
        return roleOptions.filter((role:any) => {
          if (explicitlyDelegable.has(role.id)) return true
          const targetPermissionIds = permissionIdsByRole.get(role.id) || new Set<string>()
          if (permissions.has('*')) return true
          const subset = [...targetPermissionIds].every(permissionId => permissionIds.has(permissionId))
          const strictlyLower = [...permissionIds].some(permissionId => !targetPermissionIds.has(permissionId))
          return subset && strictlyLower
        })
      })()
      return assignableRolesPromise
    }

    if (action === 'online_presence') {
      const includeRows = body?.include_rows === true
      const allowedFields = includeRows
        ? new Set(['action', 'include_rows', 'portal', 'page', 'page_size'])
        : new Set(['action', 'include_rows'])
      if (Object.keys(body || {}).some(key => !allowedFields.has(key))) {
        return json(req, {
          ok:false,
          error:'在线人员请求包含不受支持的字段',
          code:'invalid_input_field',
          retryable:false,
          preserve_session:true,
        }, 400)
      }

      if (includeRows) {
        if (!can('account.online_presence.view')) {
          return json(req, {
            ok:false,
            error:'无在线账号名单查看权限',
            code:'permission_denied',
            retryable:false,
            preserve_session:true,
          }, 403)
        }
        const portal = clean(body?.portal).toLowerCase()
        const page = Number(body?.page ?? 1)
        const pageSize = Number(body?.page_size ?? 20)
        if (!['admin', 'staff'].includes(portal) ||
            !Number.isInteger(page) || page < 1 || page > 500 ||
            !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
          return json(req, {
            ok:false,
            error:'在线人员分页参数不正确',
            code:'invalid_presence_page',
            retryable:false,
            preserve_session:true,
          }, 400)
        }

        const { data:presencePage, error:presencePageError } = await bounded(
          userClient.rpc('admin_online_presence_page_v1', {
            p_portal:portal,
            p_page:page,
            p_page_size:pageSize,
          }),
          'PRESENCE_DETAIL_PAGE',
          PRESENCE_DETAIL_TIMEOUT_MS,
        )
        if (presencePageError) {
          const errorCode = clean(presencePageError.code).toUpperCase()
          const errorMessage = clean(presencePageError.message)
          if (errorCode === '42501' || /permission|session|access_denied/i.test(errorMessage)) {
            return json(req, {
              ok:false,
              error:'无在线账号查看权限',
              code:'permission_denied',
              retryable:false,
              preserve_session:true,
            }, 403)
          }
          if (errorCode === '22023' || /invalid_presence/i.test(errorMessage)) {
            return json(req, {
              ok:false,
              error:'在线人员分页参数不正确',
              code:'invalid_presence_page',
              retryable:false,
              preserve_session:true,
            }, 400)
          }
          return retryable(req, '在线人员名单暂时读取失败，请重试')
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
      }

      const { data:presenceAllowed, error:presenceAllowedError } = await bounded(
        userClient.rpc('admin_online_presence_counts_allowed'),
        'PRESENCE_COUNT_SESSION_GUARD',
      )
      if (presenceAllowedError) return retryable(req, '在线人数会话暂时验证失败，请重试')
      if (presenceAllowed !== true) {
        return json(req, {
          ok:false,
          error:'无后台权限',
          code:'backend_access_denied',
          retryable:false,
          preserve_session:true,
        }, 403)
      }
      const nowIso = new Date().toISOString()
      const [adminCountResult, staffCountResult] = await Promise.all([
        bounded(
          admin.from('app_session_leases').select('user_id', { count:'exact', head:true }).eq('portal','admin').gt('lease_expires_at',nowIso),
          'ADMIN_PRESENCE_COUNT',
        ),
        bounded(
          admin.from('app_session_leases').select('user_id', { count:'exact', head:true }).eq('portal','staff').gt('lease_expires_at',nowIso),
          'STAFF_PRESENCE_COUNT',
        ),
      ])
      if (adminCountResult.error || staffCountResult.error) {
        return retryable(req, '在线人数暂时读取失败，请重试')
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
    }

    if (action === 'role_list') {
      if (!can('role.view')) {
        return json(req, {
          ok:false,
          error:'无后台角色权限查看权限',
          code:'permission_denied',
          retryable:false,
          preserve_session:true,
        }, 403)
      }
      const [roleResult, permissionResult, rolePermissionResult] = await Promise.all([
        bounded(
          admin.from('roles')
            .select('id,code,name,system_locked,active', { count:'exact' })
            .order('name')
            .limit(RECOVERY_ROLE_LIMIT),
          'RECOVERY_ROLE_LIST',
        ),
        bounded(
          admin.from('permissions')
            .select('id,code,name,category,sensitive', { count:'exact' })
            .order('category')
            .order('name')
            .limit(RECOVERY_PERMISSION_LIMIT),
          'RECOVERY_PERMISSION_LIST',
        ),
        bounded(
          admin.from('role_permissions')
            .select('role_id,permission_id', { count:'exact' })
            .limit(RECOVERY_ROLE_PERMISSION_LIMIT),
          'RECOVERY_ROLE_PERMISSION_LIST',
        ),
      ])
      if (roleResult.error || permissionResult.error || rolePermissionResult.error) {
        return retryable(req, '后台角色与权限暂时读取失败，请重试')
      }
      if (
        Number(roleResult.count || 0) > RECOVERY_ROLE_LIMIT ||
        Number(permissionResult.count || 0) > RECOVERY_PERMISSION_LIMIT ||
        Number(rolePermissionResult.count || 0) > RECOVERY_ROLE_PERMISSION_LIMIT
      ) {
        return retryable(req, '后台角色与权限规模超过稳定恢复读取上限，请联系 Founder 处理')
      }
      return json(req, {
        ok:true,
        degraded:true,
        recovery_role_mode:true,
        role_permissions_writable:isFounder,
        caller:{
          auth_user_id:userData.user.id,
          role_code:callerRole?.code || null,
          is_founder:isFounder,
          permissions:isFounder ? ['*'] : [...permissions],
        },
        roles:roleResult.data || [],
        permissions:permissionResult.data || [],
        role_permissions:rolePermissionResult.data || [],
      })
    }

    if (action === 'save_role_permissions') {
      if (!isFounder) {
        return json(req, {
          ok:false,
          error:'只有 Founder 可以修改全局角色权限',
          code:'permission_denied',
          retryable:false,
          preserve_session:true,
        }, 403)
      }

      const allowedInputFields = new Set(['action', 'role_id', 'permission_ids'])
      if (Object.keys(body).some(key => !allowedInputFields.has(key))) {
        return json(req, { ok:false, error:'包含不受支持的角色权限字段', code:'invalid_input_field' }, 400)
      }
      const roleId = clean(body?.role_id)
      const rawPermissionIds = body?.permission_ids
      if (!uuidLike(roleId) || !Array.isArray(rawPermissionIds)) {
        return json(req, { ok:false, error:'角色或权限项目格式不正确', code:'invalid_role_permissions' }, 400)
      }
      if (rawPermissionIds.length > RECOVERY_ROLE_PERMISSION_WRITE_LIMIT) {
        return json(req, { ok:false, error:'单个角色的权限项目超过稳定恢复上限', code:'role_permission_limit_exceeded' }, 400)
      }
      const permissionIds = rawPermissionIds.map(clean)
      if (
        permissionIds.some(permissionId => !uuidLike(permissionId)) ||
        new Set(permissionIds).size !== permissionIds.length
      ) {
        return json(req, { ok:false, error:'权限项目包含无效或重复标识', code:'invalid_permission_id' }, 400)
      }

      // One service-only RPC rechecks the canonical Founder role, locks only
      // the target role row, applies the bounded diff and inserts its audit row
      // in the same short transaction.  No employee/team directory is read.
      const { data:saved, error:saveError } = await bounded(
        admin.rpc('admin_recovery_save_role_permissions', {
          p_actor_user_id:userData.user.id,
          p_role_id:roleId,
          p_permission_ids:permissionIds,
        }),
        'RECOVERY_ROLE_PERMISSION_SAVE',
      )
      if (saveError) {
        const message = clean(saveError.message)
        const code = clean(saveError.code).toUpperCase()
        if (code === '42501' || /founder_required|permission_denied/i.test(message)) {
          return json(req, {
            ok:false,
            error:'只有 Founder 可以修改全局角色权限',
            code:'permission_denied',
            retryable:false,
            preserve_session:true,
          }, 403)
        }
        if (code === 'P0002' || /target_role_missing/i.test(message)) {
          return json(req, { ok:false, error:'角色不存在', code:'role_not_found' }, 404)
        }
        if (code === '22023' || /invalid|unknown|duplicate|limit|fixed/i.test(message)) {
          return json(req, { ok:false, error:'角色或权限项目不正确', code:'invalid_role_permissions' }, 400)
        }
        return retryable(req, '角色权限暂时保存失败，请稍后重试')
      }
      return json(req, { ok:true, saved })
    }

    if (action === 'account_list') {
      if (!can('backend_account.view')) {
        return json(req, {
          ok:false,
          error:'无后台账号查看权限',
          code:'permission_denied',
          retryable:false,
          preserve_session:true,
        }, 403)
      }
      const rawSearch = body?.search == null ? {} : body.search
      if (!rawSearch || typeof rawSearch !== 'object' || Array.isArray(rawSearch)) {
        return json(req, { ok:false, error:'搜索条件格式不正确', code:'invalid_search' }, 400)
      }
      const allowedSearchFields = new Set(['username', 'employee', 'context'])
      if (Object.keys(rawSearch).some(key => !allowedSearchFields.has(key))) {
        return json(req, { ok:false, error:'搜索字段不受支持', code:'invalid_search_field' }, 400)
      }
      const search = {
        username:clean(rawSearch.username).slice(0, 65),
        employee:clean(rawSearch.employee).slice(0, 65),
        context:clean(rawSearch.context).slice(0, 65),
      }
      if (Object.values(search).some(value => value.length > 64)) {
        return json(req, { ok:false, error:'搜索内容过长', code:'search_query_too_long' }, 400)
      }
      const requestedPage = Number(body?.page || 1)
      const page = Number.isInteger(requestedPage) ? Math.min(Math.max(requestedPage, 1), 100000) : 1
      const requestedPageSize = Number(body?.page_size ?? DEFAULT_ACCOUNT_PAGE_SIZE)
      if (!Number.isInteger(requestedPageSize) || !ACCOUNT_PAGE_SIZE_OPTIONS.has(requestedPageSize)) {
        return json(req, { ok:false, error:'每页条数不受支持', code:'invalid_account_page_size' }, 400)
      }
      const pageSize = delegatedRecoveryAccounts ? requestedPageSize : DEFAULT_ACCOUNT_PAGE_SIZE
      const status = clean(body?.status || 'all').toLowerCase()
      if (!['all', 'active', 'inactive'].includes(status)) {
        return json(req, { ok:false, error:'账号状态筛选不正确', code:'invalid_account_status' }, 400)
      }
      if (!delegatedRecoveryAccounts && status !== 'all') {
        return json(req, { ok:false, error:'当前账号的数据范围暂不支持按账号状态筛选', code:'permission_denied' }, 403)
      }
      const employeeQuery = clean(body?.employee_query)
      const employeeLookupOnly = body?.employee_lookup_only === true
      if (employeeQuery.length > 64) {
        return json(req, { ok:false, error:'员工搜索内容过长', code:'search_query_too_long' }, 400)
      }

      let pageData:any = { page, page_size:pageSize, total:0, rows:[] }
      if (!employeeLookupOnly) {
        const pageRequest = delegatedRecoveryAccounts
          ? admin.rpc('admin_recovery_backend_accounts_page_v2', {
              p_actor_user_id:userData.user.id,
              p_username_query:search.username,
              p_employee_query:search.employee,
              p_context_query:search.context,
              p_status:status,
              p_page:page,
              p_page_size:pageSize,
            })
          : userClient.rpc('admin_backend_accounts_page', {
              p_username_query:search.username,
              p_employee_query:search.employee,
              p_context_query:search.context,
              p_page:page,
            })
        const { data, error } = await bounded(pageRequest, 'BACKEND_ACCOUNT_PAGE')
        if (error || !data) return retryable(req, '后台账号列表暂时读取失败，请重试')
        pageData = data
      }

      let employees:any[] = []
      if (employeeQuery.length >= 2 && can('account.create')) {
        const { data, error } = await bounded(
          userClient.rpc('admin_backend_account_employee_lookup', { p_query:employeeQuery }),
          'ACCOUNT_EMPLOYEE_LOOKUP',
        )
        if (error) return retryable(req, '员工账号关联搜索暂时失败，请重试')
        employees = Array.isArray(data) ? data.slice(0, ACCOUNT_EMPLOYEE_LOOKUP_LIMIT) : []
      }

      const roles = !employeeLookupOnly && can('account.create') ? await loadAssignableRoles() : []
      const supportedDataScopes = isFounder
        ? ['all', 'self', 'own_team']
        : caller.data_scope === 'all'
          ? ['self', 'own_team']
          : ['self']
      return json(req, {
        ok:true,
        degraded:true,
        recovery_account_mode:true,
        supported_account_actions:supportedRecoveryAccountActions,
        supported_account_filters:delegatedRecoveryAccounts ? ['status'] : [],
        supported_account_page_sizes:delegatedRecoveryAccounts
          ? [...ACCOUNT_PAGE_SIZE_OPTIONS]
          : [DEFAULT_ACCOUNT_PAGE_SIZE],
        caller:{
          auth_user_id:userData.user.id,
          role_code:callerRole?.code || null,
          is_founder:isFounder,
          permissions:isFounder ? ['*'] : [...permissions],
        },
        backend_accounts:Array.isArray(pageData.rows) ? pageData.rows.slice(0, pageSize) : [],
        account_pagination:{
          page:Number(pageData.page || page),
          page_size:Number(pageData.page_size || pageSize),
          total:Number(pageData.total || 0),
          status:clean(pageData.status || status || 'all'),
        },
        employees,
        roles,
        assignable_role_ids:roles.map((role:any) => role.id),
        supported_data_scopes:supportedDataScopes,
      })
    }

    if (RECOVERY_ACCOUNT_ACTIONS.includes(action)) {
      const requiredPermission = RECOVERY_ACCOUNT_ACTION_PERMISSION[action]
      if (!requiredPermission || !can(requiredPermission)) {
        return json(req, {
          ok:false,
          error:'当前账号没有此项账号操作权限',
          code:'permission_denied',
          retryable:false,
          preserve_session:true,
        }, 403)
      }
      if (!delegatedRecoveryAccounts) {
        return json(req, {
          ok:false,
          error:'当前账号的数据范围暂不支持此项账号恢复操作',
          code:'scope_not_supported',
          retryable:false,
          preserve_session:true,
        }, 403)
      }

      const allowedFields = action === 'toggle_active'
        ? new Set(['action', 'auth_user_id', 'active'])
        : action === 'toggle_otp'
          ? new Set(['action', 'auth_user_id', 'otp_required'])
          : action === 'reset_password'
            ? new Set(['action', 'auth_user_id', 'password'])
            : new Set(['action', 'auth_user_id'])
      if (Object.keys(body || {}).some(key => !allowedFields.has(key))) {
        return json(req, { ok:false, error:'账号恢复请求包含不受支持的字段', code:'invalid_input_field' }, 400)
      }

      const targetAuthUserId = clean(body?.auth_user_id)
      if (!uuidLike(targetAuthUserId)) {
        return json(req, { ok:false, error:'账号标识不正确', code:'invalid_account_id' }, 400)
      }
      if (targetAuthUserId === userData.user.id) {
        return json(req, { ok:false, error:'当前登录账号不能在这里修改自身状态或凭据', code:'current_account_protected' }, 400)
      }

      try {
        await recheckRecoveryMutationGate()
      } catch (gateError) {
        if (/session_not_current/i.test(clean((gateError as any)?.message || (gateError as any)?.code))) {
          return json(req, {
            ok:false,
            error:'当前浏览器会话已失效或账号已在其他设备登录',
            code:'session_not_current',
            retryable:false,
            preserve_session:false,
          }, 401)
        }
        return retryable(req, '账号恢复前置验证暂时繁忙，请稍后重试')
      }

      let actionAllowed = false
      try {
        actionAllowed = await recoveryBackendActionAllowed(targetAuthUserId, requiredPermission)
      } catch {
        return retryable(req, '账号操作授权暂时无法确认，请稍后重试')
      }
      if (actionAllowed !== true) {
        return json(req, {
          ok:false,
          error:'该账号不在你可操作的角色或数据范围内',
          code:'permission_or_scope_denied',
          retryable:false,
          preserve_session:true,
        }, 403)
      }

      if (action === 'toggle_active' || action === 'toggle_otp') {
        const inputValue = action === 'toggle_active' ? body?.active : body?.otp_required
        if (typeof inputValue !== 'boolean') {
          return json(req, { ok:false, error:'账号恢复状态必须是布尔值', code:'invalid_account_control' }, 400)
        }
        const { data:saved, error:saveError } = await bounded(
          admin.rpc('admin_recovery_set_backend_account_control', {
            p_actor_user_id:userData.user.id,
            p_target_user_id:targetAuthUserId,
            p_control:action === 'toggle_active' ? 'active' : 'otp_required',
            p_value:inputValue,
          }),
          'RECOVERY_BACKEND_CONTROL',
        )
        if (saveError) {
          const message = clean(saveError.message)
          const code = clean(saveError.code).toUpperCase()
          if (code === 'P0002' || /not_found/i.test(message)) {
            return json(req, { ok:false, error:'后台账号不存在', code:'account_not_found' }, 404)
          }
          if (code === '42501' || /permission_or_scope_denied|founder.*protected|founder_required/i.test(message)) {
            return json(req, { ok:false, error:'该账号不在你可操作的角色或数据范围内', code:'permission_or_scope_denied' }, 403)
          }
          if (code === '22023' || /invalid|unsupported|cannot_disable/i.test(message)) {
            return json(req, { ok:false, error:'账号恢复参数不正确', code:'invalid_account_control' }, 400)
          }
          return retryable(req, '账号状态暂时保存失败，请稍后重试')
        }
        return json(req, { ok:true, saved })
      }

      const target = await loadRecoveryBackendTarget(targetAuthUserId)
      if (!target) return json(req, { ok:false, error:'后台账号不存在', code:'account_not_found' }, 404)
      if (target.role_code === 'founder') {
        return json(req, { ok:false, error:'Founder 账号受保护，不能在普通账号恢复中修改', code:'founder_protected' }, 403)
      }

      if (action === 'reset_password') {
        const password = String(body?.password || '')
        if (!passwordOk(password)) {
          return json(req, { ok:false, error:'新密码至少10位，并包含大小写字母、数字和特殊符号', code:'weak_password' }, 400)
        }
        try {
          if (!await recoveryBackendActionAllowed(targetAuthUserId, requiredPermission)) {
            return json(req, { ok:false, error:'该账号已不在你可操作的角色或数据范围内', code:'permission_or_scope_denied' }, 403)
          }
        } catch {
          return retryable(req, '密码修改前无法再次确认授权，请稍后重试')
        }
        let passwordResult:any
        try {
          passwordResult = await boundedAuthMutation(
            admin.auth.admin.updateUserById(targetAuthUserId, { password }),
            'RECOVERY_PASSWORD_RESET',
          )
        } catch (mutationError) {
          if (/OUTCOME_UNKNOWN/i.test(clean((mutationError as any)?.message))) {
            return json(req, {
              ok:false,
              error:'密码重置结果暂未确认；请使用同一个新密码重试一次，不要换密码',
              code:'password_reset_outcome_unknown',
              outcome_unknown:true,
              retryable:true,
              preserve_session:true,
            }, 503, '15')
          }
          return retryable(req, '密码服务暂时繁忙，请稍后重试')
        }
        if (passwordResult?.error) {
          const status = backendStatus(passwordResult.error)
          return json(req, {
            ok:false,
            error:status === 404 ? '后台账号登录身份不存在' : clean(passwordResult.error.message || '密码重置失败'),
            code:status === 404 ? 'auth_identity_not_found' : 'password_reset_failed',
            retryable:false,
            preserve_session:true,
          }, status === 404 ? 404 : 400)
        }
      } else {
        const { data:factors, error:listError } = await bounded(
          admin.auth.admin.mfa.listFactors({ userId:targetAuthUserId }),
          'RECOVERY_MFA_LIST',
        )
        if (listError) return retryable(req, 'OTP/MFA 状态暂时读取失败，请稍后重试')
        const items = [
          ...(((factors as any)?.factors || []) as any[]),
          ...(((factors as any)?.totp || []) as any[]),
          ...(((factors as any)?.phone || []) as any[]),
        ]
        const factorIds = [...new Set(items.map(item => clean(item?.id)).filter(Boolean))]
        if (factorIds.length > 10) {
          return json(req, { ok:false, error:'该账号的 OTP/MFA 因子异常过多，请联系 Founder 专项处理', code:'mfa_factor_limit_exceeded' }, 409)
        }
        try {
          if (!await recoveryBackendActionAllowed(targetAuthUserId, requiredPermission)) {
            return json(req, { ok:false, error:'该账号已不在你可操作的角色或数据范围内', code:'permission_or_scope_denied' }, 403)
          }
        } catch {
          return retryable(req, 'OTP/MFA 修改前无法再次确认授权，请稍后重试')
        }
        for (const factorId of factorIds) {
          try {
            const { error:deleteError } = await boundedAuthMutation(
              admin.auth.admin.mfa.deleteFactor({ userId:targetAuthUserId, id:factorId }),
              'RECOVERY_MFA_DELETE',
            )
            if (deleteError && backendStatus(deleteError) !== 404) {
              return json(req, { ok:false, error:'OTP/MFA 重置未完成，请重试', code:'mfa_reset_incomplete', retryable:true, preserve_session:true }, 503, '15')
            }
          } catch (mutationError) {
            return json(req, {
              ok:false,
              error:'OTP/MFA 重置结果暂未确认；该操作可以安全重试',
              code:'mfa_reset_outcome_unknown',
              outcome_unknown:true,
              retryable:true,
              preserve_session:true,
            }, 503, '15')
          }
        }
      }

      const finalAction = action === 'reset_password' ? 'password_reset' : 'mfa_reset'
      const { data:finalized, error:finalizeError } = await bounded(
        admin.rpc('admin_recovery_finalize_backend_auth_control', {
          p_actor_user_id:userData.user.id,
          p_target_user_id:targetAuthUserId,
          p_action:finalAction,
        }),
        'RECOVERY_AUTH_CONTROL_FINALIZE',
      )
      if (finalizeError) {
        return json(req, {
          ok:false,
          error:action === 'reset_password'
            ? '密码已经重置，但审计/强制改密标记暂未确认；请勿更换新密码，联系 Founder 核对'
            : 'OTP/MFA 已重置，但审计记录暂未确认，请联系 Founder 核对',
          code:'auth_control_finalize_pending',
          outcome_unknown:false,
          retryable:false,
          preserve_session:true,
        }, 500)
      }
      return json(req, { ok:true, finalized })
    }

    if (action === 'create_backend') {
      if (!can('account.create')) {
        return json(req, { ok:false, error:'无创建账号权限', code:'permission_denied' }, 403)
      }
      const allowedInputFields = new Set([
        'action', 'username', 'password', 'role_id', 'employee_id', 'data_scope', 'otp_required',
      ])
      if (Object.keys(body || {}).some(key => !allowedInputFields.has(key))) {
        return json(req, { ok:false, error:'恢复期间仅支持单个账号与受控范围创建', code:'unsupported_create_field' }, 400)
      }
      const username = clean(body?.username).toLowerCase()
      const password = String(body?.password || '')
      const roleId = clean(body?.role_id)
      const employeeId = clean(body?.employee_id)
      const dataScope = clean(body?.data_scope)
      const otpRequired = body?.otp_required === true
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return json(req, { ok:false, error:'用户名只允许3-32位字母、数字、._-', code:'invalid_username' }, 400)
      }
      if (!passwordOk(password)) {
        return json(req, { ok:false, error:'密码至少10位，并包含大小写字母、数字和特殊符号', code:'weak_password' }, 400)
      }
      if (!uuidLike(roleId) || (employeeId && !uuidLike(employeeId))) {
        return json(req, { ok:false, error:'角色或员工标识不正确', code:'invalid_identifier' }, 400)
      }

      const assignableRoles = await loadAssignableRoles()
      const role = assignableRoles.find((candidate:any) => candidate.id === roleId)
      if (!role) {
        return json(req, { ok:false, error:'当前角色未获授权创建所选角色的后台账号', code:'role_not_assignable' }, 403)
      }
      const supportedDataScopes = isFounder
        ? new Set(['all', 'self', 'own_team'])
        : caller.data_scope === 'all'
          ? new Set(['self', 'own_team'])
          : new Set(['self'])
      if (!supportedDataScopes.has(dataScope)) {
        return json(req, {
          ok:false,
          error:'恢复期间该管理范围暂不可安全授权，请选择当前允许的范围',
          code:'data_scope_not_delegable',
        }, 403)
      }
      if (dataScope !== 'all' && !employeeId) {
        return json(req, { ok:false, error:'该管理范围必须关联员工档案', code:'employee_required' }, 400)
      }
      if (!isFounder && !employeeId) {
        return json(req, { ok:false, error:'非 Founder 创建账号必须关联范围内员工档案', code:'employee_required' }, 403)
      }
      if (employeeId) {
        const [{ data:employeeInScope, error:scopeError }, { data:employee, error:employeeError }] = await Promise.all([
          bounded(
            userClient.rpc('backend_employee_in_scope', { p_employee_id:employeeId }),
            'CREATE_EMPLOYEE_SCOPE',
          ),
          bounded(
            admin.from('employees').select('id,status').eq('id', employeeId).maybeSingle(),
            'CREATE_EMPLOYEE',
          ),
        ])
        if (scopeError || employeeError) return retryable(req, '员工范围暂时验证失败，请重试')
        if (employeeInScope !== true || !employee || employee.status !== 'active') {
          return json(req, { ok:false, error:'找不到在职员工或员工超出当前账号范围', code:'employee_out_of_scope' }, 403)
        }
      }

      const internalEmail = `${username}@${RECOVERY_AUTH_DOMAIN}`
      let provisioningFingerprint = ''
      try {
        provisioningFingerprint = await buildRecoveryProvisioningFingerprint(secretKey, {
          actorUserId:userData.user.id,
          username,
          roleId,
          employeeId,
          dataScope,
          otpRequired,
          password,
        })
      } catch (fingerprintError) {
        console.error('recovery account fingerprint failed', {
          error:clean((fingerprintError as any)?.message),
        })
        return retryable(req, '账号创建安全指纹暂时无法生成，请重试')
      }
      const findProvisionedAuthId = async () => {
        const { data, error } = await bounded(
          admin.rpc('admin_recovery_find_backend_auth_identity', {
            p_email:internalEmail,
            p_username:username,
            p_fingerprint:provisioningFingerprint,
          }),
          'RECOVERY_AUTH_IDENTITY_LOOKUP',
        )
        return {
          authUserId:uuidLike(clean(data)) ? clean(data) : '',
          error,
        }
      }
      const readCommittedAccounts = async (authUserId = '') => {
        let query = admin.from('user_access').select(
          'auth_user_id,employee_id,role_id,login_username,login_email,backend_enabled,otp_required,data_scope,active,account_created_by,created_at',
        )
        query = authUserId
          ? query.or(`auth_user_id.eq.${authUserId},login_username.eq.${username}`)
          : query.eq('login_username', username)
        return bounded(query.limit(2), 'RECOVERY_COMMITTED_ACCOUNT_LOOKUP')
      }
      const matchesCommittedAccount = (row:any, authUserId:string) =>
        clean(row?.auth_user_id) === authUserId &&
        clean(row?.login_username).toLowerCase() === username &&
        clean(row?.login_email).toLowerCase() === internalEmail &&
        clean(row?.role_id) === roleId &&
        clean(row?.employee_id) === employeeId &&
        clean(row?.data_scope) === dataScope &&
        clean(row?.account_created_by) === userData.user.id &&
        row?.backend_enabled === true &&
        row?.active === true &&
        row?.otp_required === otpRequired
      const committedSuccess = (row:any, authUserId:string, recovered:boolean) => json(req, {
        ok:true,
        created:{
          auth_user_id:authUserId,
          username,
          role_code:role.code,
          data_scope:dataScope,
          idempotent_recovery:recovered,
          created_at:row?.created_at || null,
        },
      })

      const initialIdentity = await findProvisionedAuthId()
      if (initialIdentity.error) return retryable(req, '账号登录身份暂时核对失败，请使用相同用户名重试')
      let authUserId = initialIdentity.authUserId
      let newlyCreatedAuthIdentity = false

      const { data:initialAccessRows, error:initialAccessError } = await readCommittedAccounts(authUserId)
      if (initialAccessError) return retryable(req, '账号唯一性暂时验证失败，请重试')
      const initialRows = Array.isArray(initialAccessRows) ? initialAccessRows : []
      const initialCommitted = authUserId
        ? initialRows.find((row:any) => matchesCommittedAccount(row, authUserId))
        : null
      if (initialCommitted) return committedSuccess(initialCommitted, authUserId, true)
      if (initialRows.length > 0) {
        return json(req, {
          ok:false,
          error:'用户名或登录身份已被其他后台账号占用',
          code:'username_exists',
        }, 409)
      }

      // Creation is rare and irreversible across two services.  Re-check both
      // gates after every role/scope/identity read, immediately before the
      // first Auth or database mutation, so a mid-validation revoke cannot
      // provision an account.
      await enforceAdminRequestIp(req, admin, userData.user.id, authorization)
      const { data:provisionSessionCurrent, error:provisionSessionError } = await bounded(
        userClient.rpc('admin_access_session_allowed'),
        'PROVISION_CURRENT_SESSION',
      )
      if (provisionSessionError) {
        return retryable(req, '创建前会话状态暂时无法确认，请使用相同用户名重试')
      }
      if (provisionSessionCurrent !== true) {
        return json(req, {
          ok:false,
          error:'当前浏览器会话已失效或账号已在其他设备登录',
          code:'session_not_current',
          retryable:false,
          preserve_session:false,
        }, 401)
      }

      if (!authUserId) {
        let createError:any = null
        try {
          const created = await admin.auth.admin.createUser({
            email:internalEmail,
            password,
            email_confirm:true,
            app_metadata:{
              wfh_provisioning:RECOVERY_PROVISIONING_MARKER,
              wfh_login_username:username,
              [RECOVERY_PROVISIONING_FINGERPRINT_KEY]:provisioningFingerprint,
            },
          })
          createError = created.error
          if (created.data?.user?.id) {
            authUserId = clean(created.data.user.id)
            newlyCreatedAuthIdentity = true
          }
        } catch (error) {
          createError = error
        }

        if (createError || !authUserId) {
          // A transport failure can arrive after GoTrue accepted the create.
          // Re-read only the deterministic, provisioning-marked identity.
          const recoveredIdentity = await findProvisionedAuthId()
          if (recoveredIdentity.error) {
            return retryable(req, '登录账号创建状态暂未确认，请使用相同用户名重试')
          }
          const disposition = recoveryIdentityDisposition(createError, recoveredIdentity.authUserId)
          if (disposition === 'conflict') {
            return json(req, {
              ok:false,
              error:'该用户名已有另一笔不同内容的创建正在处理，未修改登录密码或账号资料',
              code:'provisioning_fingerprint_conflict',
            }, 409)
          }
          if (disposition !== 'reuse') {
            return retryable(req, '登录账号创建状态暂未确认，请使用相同用户名重试')
          }
          authUserId = recoveredIdentity.authUserId
          newlyCreatedAuthIdentity = false
        }
      }

      if (!newlyCreatedAuthIdentity) {
        const { data:reusedAccessRows, error:reusedAccessError } = await readCommittedAccounts(authUserId)
        if (reusedAccessError) return retryable(req, '复用账号身份时暂时无法核对资料，请使用相同用户名重试')
        const reusedRows = Array.isArray(reusedAccessRows) ? reusedAccessRows : []
        const reusedCommitted = reusedRows.find((row:any) => matchesCommittedAccount(row, authUserId))
        if (reusedCommitted) return committedSuccess(reusedCommitted, authUserId, true)
        if (reusedRows.length > 0) {
          return json(req, {
            ok:false,
            error:'该登录身份已关联其他后台账号，未进行任何修改',
            code:'provisioning_identity_conflict',
          }, 409)
        }

        // The helper returns only an identity carrying the exact server-HMACed
        // request fingerprint.  A different actor, role, scope, OTP choice or
        // password therefore cannot reach this password repair/finalize path.
        try {
          const { error:updateError } = await admin.auth.admin.updateUserById(authUserId, { password })
          if (updateError) throw updateError
        } catch (updateError) {
          console.error('recovery account Auth reuse update failed', {
            auth_user_id:authUserId,
            error:clean((updateError as any)?.message),
          })
          return retryable(req, '复用账号登录身份暂时失败，请使用相同用户名重试')
        }
      }

      let finalized:any = null
      let finalizeError:any = null
      try {
        const result = await admin.rpc('admin_recovery_finalize_backend_account', {
          p_auth_user_id:authUserId,
          p_employee_id:employeeId || null,
          p_role_id:roleId,
          p_login_username:username,
          p_login_email:internalEmail,
          p_otp_required:otpRequired,
          p_data_scope:dataScope,
          p_actor_user_id:userData.user.id,
        })
        finalized = result.data
        finalizeError = result.error
      } catch (error) {
        finalizeError = error
      }

      if (finalizeError || !finalized) {
        // Never infer rollback from a transport failure.  First reconcile by
        // both deterministic username and Auth id; a committed exact row is a
        // successful create even when the RPC response was lost.
        const { data:committedRows, error:committedReadError } = await readCommittedAccounts(authUserId)
        if (committedReadError) {
          return retryable(req, '账号保存状态暂未确认，请勿更换用户名，稍后使用相同用户名重试')
        }
        const rows = Array.isArray(committedRows) ? committedRows : []
        const committed = rows.find((row:any) => matchesCommittedAccount(row, authUserId))
        if (committed) return committedSuccess(committed, authUserId, true)
        if (rows.length > 0) {
          return json(req, {
            ok:false,
            error:'账号名称或登录身份已由另一笔创建占用，未执行清理',
            code:'provisioning_conflict',
          }, 409)
        }

        const finalizerCode = clean(finalizeError?.code).toUpperCase()
        const databaseDefinitelyRolledBack = /^(?=[0-9A-Z]{5}$)(?=.*[0-9])[0-9A-Z]+$/.test(finalizerCode)
        if (newlyCreatedAuthIdentity && databaseDefinitelyRolledBack) {
          // This branch is forbidden for a reused identity.  A successful,
          // empty reconciliation read plus a SQLSTATE proves no access/scope/
          // audit transaction committed for this newly-created Auth id.
          try {
            const { error:authRollbackError } = await admin.auth.admin.deleteUser(authUserId)
            if (authRollbackError) throw authRollbackError
          } catch (authRollbackError) {
            console.error('recovery account Auth rollback failed', {
              auth_user_id:authUserId,
              error:clean((authRollbackError as any)?.message),
            })
            return retryable(req, '账号资料未建立；登录身份保留为可重试状态，请使用相同用户名重试')
          }
          return retryable(req, '账号资料、范围或审计保存失败，已撤销本次新建身份；可使用相同用户名重试')
        }
        return retryable(req, '账号保存状态暂未确认；登录身份未删除，请使用相同用户名重试')
      }

      return json(req, {
        ok:true,
        created:{ ...finalized, idempotent_recovery:false },
      })
    }

    if (action === 'dashboard') {
      if (!can('dashboard.view')) {
        return json(req, {
          ok:false,
          error:'无后台首页权限',
          code:'permission_denied',
          retryable:false,
          preserve_session:true,
        }, 403)
      }
      // This RPC is intentionally bounded in Postgres (5s statement timeout)
      // and returns aggregates only; it never serializes the employee directory.
      const { data:dashboard, error:dashboardError } = await bounded(
        userClient.rpc('admin_home_dashboard'),
        'ADMIN_HOME_DASHBOARD',
      )
      if (dashboardError || !dashboard) {
        return retryable(req, '首页数据读取失败，请稍后重试')
      }
      return json(req, {
        ...dashboard,
        degraded:true,
        caller:{
          auth_user_id:userData.user.id,
          role_code:callerRole?.code || null,
          is_founder:isFounder,
          permissions:isFounder ? ['*'] : [...permissions],
        },
      })
    }

    let employeeContext: Record<string, unknown> | null = null
    if (caller.employee_id) {
      const { data:employee, error:employeeError } = await bounded(
        admin.from('employees')
          .select('id,employee_no,full_name,team_id,position_id')
          .eq('id', caller.employee_id)
          .maybeSingle(),
        'CALLER_EMPLOYEE',
      )
      if (employeeError) return retryable(req, '当前账号员工范围暂时读取失败，请重试')
      employeeContext = employee
    }

    return json(req, {
      ok:true,
      degraded:true,
      caller:{
        auth_user_id:userData.user.id,
        role_code:callerRole?.code || null,
        is_founder:isFounder,
        permissions:isFounder ? ['*'] : [...permissions],
        employee_id:caller.employee_id || null,
        data_scope:caller.data_scope || null,
        team_id:employeeContext?.team_id || null,
        position_id:employeeContext?.position_id || null,
        login_username:caller.login_username || null,
        login_email:caller.login_email || userData.user.email || null,
        employee_no:employeeContext?.employee_no || null,
        full_name:employeeContext?.full_name || null,
      },
    })
  } catch (error) {
    if (error instanceof AdminRequestIpError) {
      return json(req, {
        ok:false,
        error:error.message,
        code:error.code,
        retryable:error.retryable,
        preserve_session:error.status >= 500,
      }, error.status, error.retryable ? '30' : '')
    }
    console.error('admin account recovery access failed', error)
    return retryable(req, '后台权限服务暂时繁忙，请稍后重试')
  }
})
