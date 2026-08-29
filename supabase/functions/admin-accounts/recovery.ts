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
const ACCOUNT_PAGE_SIZE = 20
const ACCOUNT_EMPLOYEE_LOOKUP_LIMIT = 10
const RECOVERY_ROLE_LIMIT = 100
const RECOVERY_PERMISSION_LIMIT = 500
const RECOVERY_ROLE_PERMISSION_LIMIT = 5_000
const RECOVERY_AUTH_DOMAIN = 'admin.wfh.invalid'
const RECOVERY_PROVISIONING_MARKER = 'wfh_backend_recovery_v1'
const RECOVERY_PROVISIONING_FINGERPRINT_KEY = 'wfh_provisioning_fingerprint'

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

async function bounded<T>(operation: PromiseLike<T>, label: string): Promise<T> {
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
        }, DEPENDENCY_TIMEOUT_MS)
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
    if (!['access', 'bootstrap', 'dashboard', 'online_presence', 'role_list', 'account_list', 'create_backend'].includes(action)) {
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
      if (!can('account.online_presence.view')) {
        return json(req, {
          ok:false,
          error:'无在线账号查看权限',
          code:'permission_denied',
          retryable:false,
          preserve_session:true,
        }, 403)
      }
      const { data:presenceAllowed, error:presenceAllowedError } = await bounded(
        userClient.rpc('admin_online_presence_allowed'),
        'PRESENCE_PERMISSION_GUARD',
      )
      if (presenceAllowedError) return retryable(req, '在线人数权限暂时验证失败，请重试')
      if (presenceAllowed !== true) {
        return json(req, {
          ok:false,
          error:'无在线账号查看权限',
          code:'permission_denied',
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
      const employeeQuery = clean(body?.employee_query)
      const employeeLookupOnly = body?.employee_lookup_only === true
      if (employeeQuery.length > 64) {
        return json(req, { ok:false, error:'员工搜索内容过长', code:'search_query_too_long' }, 400)
      }

      let pageData:any = { page, page_size:ACCOUNT_PAGE_SIZE, total:0, rows:[] }
      if (!employeeLookupOnly) {
        const { data, error } = await bounded(
          userClient.rpc('admin_backend_accounts_page', {
            p_username_query:search.username,
            p_employee_query:search.employee,
            p_context_query:search.context,
            p_page:page,
          }),
          'BACKEND_ACCOUNT_PAGE',
        )
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
        caller:{
          auth_user_id:userData.user.id,
          role_code:callerRole?.code || null,
          is_founder:isFounder,
          permissions:isFounder ? ['*'] : [...permissions],
        },
        backend_accounts:Array.isArray(pageData.rows) ? pageData.rows.slice(0, ACCOUNT_PAGE_SIZE) : [],
        account_pagination:{
          page:Number(pageData.page || page),
          page_size:ACCOUNT_PAGE_SIZE,
          total:Number(pageData.total || 0),
        },
        employees,
        roles,
        assignable_role_ids:roles.map((role:any) => role.id),
        supported_data_scopes:supportedDataScopes,
      })
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
