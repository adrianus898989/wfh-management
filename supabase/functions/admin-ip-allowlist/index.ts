import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import {
  bearerToken,
  hostCidr,
  jwtSessionId,
  jwtUserId,
  trustedClientIp,
} from '../_shared/adminIp.ts'
import { corsGate, corsHeaders } from '../_shared/corsOrigin.ts'
const DEPENDENCY_TIMEOUT_MS = 8_000

function timedFetch(timeoutMs: number) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const controller = new AbortController()
    const upstreamSignal = init.signal
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason)
    if (upstreamSignal?.aborted) abortFromUpstream()
    else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetch(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
      upstreamSignal?.removeEventListener('abort', abortFromUpstream)
    }
  }
}

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

function text(value: unknown) {
  return String(value ?? '').trim()
}

function related(value: any) {
  return Array.isArray(value) ? value[0] : value
}

function safeMeta(error: any) {
  return {
    name: String(error?.name || 'Error').slice(0, 64),
    code: String(error?.code || '').slice(0, 64) || null,
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
  }
}

const databaseMessages: Record<string, string> = {
  permission_denied: '当前账号没有管理后台登录IP白名单的权限',
  session_not_current: '当前浏览器会话已失效，请重新登录',
  ip_session_not_verified: '当前会话的IP验证已失效，请重新验证',
  invalid_ip_network: 'IP/CIDR 格式不正确',
  ip_network_required: '请填写 IP 或 CIDR',
  invalid_label: '标签必填，最多 80 个字符',
  notes_too_long: '备注最多 500 个字符',
  invalid_entry_id: '白名单记录不存在',
  invalid_entry_update: '白名单状态不正确',
  invalid_enabled: '白名单状态不正确',
  entry_not_found: '白名单记录不存在',
  network_already_exists: '该 IP/CIDR 已经存在',
  cannot_enable_without_entries: '请先加入并启用当前IP，再开启白名单',
  current_ip_not_allowed: '当前IP尚未在启用的白名单中，不能开启',
  current_ip_would_be_denied: '此操作会把当前IP移出白名单；请先加入新的当前IP',
  last_enabled_entry: '白名单开启时不能停用或删除最后一条；请先关闭白名单',
  client_ip_unavailable: '服务端无法从可信代理读取当前IP，已拒绝操作',
  invalid_enforced: '白名单开关状态不正确',
  invalid_action: '不支持的操作',
  invalid_portal: '登录入口类型不正确',
  invalid_portal_scope: '适用范围不正确',
  cannot_enable_without_admin_entries: '请先添加至少一条“后台”或“两者”IP，再开启后台限制',
  cannot_enable_without_staff_entries: '请先添加至少一条“员工前端”或“两者”IP，再开启员工前端限制',
  last_enabled_admin_entry: '后台限制开启时，不能移除最后一条后台可用网络',
  last_enabled_staff_entry: '员工前端限制开启时，不能移除最后一条员工可用网络',
  configuration_busy: '另一项白名单配置正在保存，请稍后重试',
}

function databaseErrorReason(error: any) {
  const message = String(error?.message || '')
  return Object.keys(databaseMessages).find(code => message.includes(code)) || 'mutation_failed'
}

function databaseErrorMessage(error: any) {
  const reason = databaseErrorReason(error)
  return databaseMessages[reason] || '白名单保存失败；本次配置未生效，请刷新后重试'
}

async function effectivePermissions(admin: any, caller: any) {
  const role = related(caller.roles)
  if (role?.code === 'founder') return { founder: true, permissions: ['*'] }

  const [roleResult, overrideResult] = await Promise.all([
    admin.from('role_permissions')
      .select('permissions(code)')
      .eq('role_id', caller.role_id),
    admin.from('user_permission_overrides')
      .select('allowed,permissions(code)')
      .eq('auth_user_id', caller.auth_user_id),
  ])
  if (roleResult.error || overrideResult.error) throw roleResult.error || overrideResult.error

  const permissions = new Set<string>()
  for (const row of roleResult.data || []) {
    const permission = related(row.permissions)
    if (permission?.code) permissions.add(permission.code)
  }
  for (const row of overrideResult.data || []) {
    const permission = related(row.permissions)
    if (!permission?.code) continue
    if (row.allowed) permissions.add(permission.code)
    else permissions.delete(permission.code)
  }
  return { founder: false, permissions: [...permissions] }
}

async function snapshot(admin: any, clientIp: string) {
  const [settingsResult, entriesResult, adminCoverageResult, staffCoverageResult] = await Promise.all([
    admin.from('admin_ip_allowlist_settings')
      .select('enforced,updated_at,updated_by,staff_enforced,staff_updated_at,staff_updated_by')
      .eq('id', 1)
      .single(),
    admin.from('admin_ip_allowlist_entries')
      .select('id,ip_network,label,notes,enabled,portal_scope,created_by,created_at,updated_by,updated_at,last_hit_at,last_hit_ip,last_hit_user_id,hit_count')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }),
    admin.rpc('portal_ip_prelogin_check', { p_portal: 'admin', p_client_ip: clientIp || null }),
    admin.rpc('portal_ip_prelogin_check', { p_portal: 'staff', p_client_ip: clientIp || null }),
  ])
  if (settingsResult.error || entriesResult.error || adminCoverageResult.error || staffCoverageResult.error) {
    throw settingsResult.error || entriesResult.error || adminCoverageResult.error || staffCoverageResult.error
  }

  const entries = entriesResult.data || []
  const actorIds = [...new Set([
    settingsResult.data?.updated_by,
    settingsResult.data?.staff_updated_by,
    ...entries.flatMap((entry: any) => [entry.created_by, entry.updated_by, entry.last_hit_user_id]),
  ].filter(Boolean))]
  const actorMap = new Map<string, string>()
  if (actorIds.length) {
    const { data: actors, error } = await admin.from('user_access')
      .select('auth_user_id,login_username,login_email')
      .in('auth_user_id', actorIds)
    if (error) throw error
    for (const actor of actors || []) {
      actorMap.set(actor.auth_user_id, actor.login_username || actor.login_email || actor.auth_user_id)
    }
  }

  const adminEnabledCount = entries.filter((entry: any) => entry.enabled
    && ['admin', 'both'].includes(entry.portal_scope)).length
  const staffEnabledCount = entries.filter((entry: any) => entry.enabled
    && ['staff', 'both'].includes(entry.portal_scope)).length
  const setting = settingsResult.data
  return {
    ok: true,
    current_ip: clientIp || null,
    current_ip_covered: Boolean(adminCoverageResult.data?.matched_entry_id),
    current_ip_coverage: {
      admin: Boolean(adminCoverageResult.data?.matched_entry_id),
      staff: Boolean(staffCoverageResult.data?.matched_entry_id),
    },
    settings: {
      ...setting,
      // `enforced` is the server-side switch. `effective` is deliberately a
      // UI health signal so an enforced-but-empty scope is shown as deny-all
      // instead of looking like a normally configured allowlist.
      effective: Boolean(setting.enforced && adminEnabledCount > 0),
      enabled_count: adminEnabledCount,
      total_count: entries.length,
      updated_by_label: setting.updated_by ? actorMap.get(setting.updated_by) || '已删除账号' : '系统',
      staff_effective: Boolean(setting.staff_enforced && staffEnabledCount > 0),
      staff_enabled_count: staffEnabledCount,
      staff_updated_by_label: setting.staff_updated_by
        ? actorMap.get(setting.staff_updated_by) || '已删除账号'
        : '系统',
    },
    entries: entries.map((entry: any) => ({
      ...entry,
      created_by_label: entry.created_by ? actorMap.get(entry.created_by) || '已删除账号' : '系统',
      updated_by_label: entry.updated_by ? actorMap.get(entry.updated_by) || '已删除账号' : '系统',
      last_hit_user_label: entry.last_hit_user_id
        ? actorMap.get(entry.last_hit_user_id) || '已删除账号'
        : null,
    })),
  }
}

export async function handleRequest(req: Request) {
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
      return json(req, { error: '白名单服务配置缺失' }, 503)
    }

    const authorization = req.headers.get('Authorization') || ''
    const token = bearerToken(authorization)
    const sessionId = jwtSessionId(token)
    const userId = jwtUserId(token)
    if (!token || !/^[0-9a-f-]{36}$/i.test(sessionId) || !/^[0-9a-f-]{36}$/i.test(userId)) {
      return json(req, { error: '登录已失效', reason: 'auth_session_missing' }, 401)
    }

    const boundedFetch = timedFetch(DEPENDENCY_TIMEOUT_MS)
    const admin = createClient(supabaseUrl, secretKey, {
      global: { fetch: boundedFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const userClient = createClient(supabaseUrl, publishableKey, {
      global: {
        fetch: boundedFetch,
        headers: { Authorization: authorization },
      },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const observedClientIp = trustedClientIp(req)
    const { data: guard, error: guardError } = await admin.rpc('admin_ip_session_attest', {
      p_user_id: userId,
      p_session_id: sessionId,
      p_client_ip: observedClientIp || null,
      p_source: 'management',
    })
    if (guardError) return json(req, { error: 'IP验证服务暂时不可用' }, 503)
    if (!guard?.ok) {
      return json(req, {
        error: guard?.reason === 'client_ip_unavailable'
          ? '服务端无法从可信代理读取当前IP'
          : '当前IP不在后台登录白名单中，会话已结束',
        reason: guard?.reason || 'ip_not_allowed',
      }, 403)
    }
    // Use PostgreSQL's canonical inet value returned by the service-only gate,
    // never the raw header text, for CRUD safety checks and one-click CIDRs.
    const clientIp = text(guard.client_ip)

    const { data: heartbeat, error: heartbeatError } = await userClient.rpc('app_session_heartbeat')
    if (heartbeatError) {
      console.error('ADMIN_IP_ALLOWLIST_HEARTBEAT_ERROR', safeMeta(heartbeatError))
      return json(req, { error: '会话验证服务暂时不可用，请稍后重试', reason: 'service_unavailable' }, 503)
    }
    if (!heartbeat?.ok) {
      return json(req, { error: '当前浏览器会话已失效', reason: heartbeat?.reason || 'session_not_current' }, 401)
    }

    const { data: caller, error: callerError } = await admin.from('user_access')
      .select('auth_user_id,employee_id,role_id,active,backend_enabled,roles(code)')
      .eq('auth_user_id', userId)
      .maybeSingle()
    if (callerError) {
      console.error('ADMIN_IP_ALLOWLIST_CALLER_ERROR', safeMeta(callerError))
      return json(req, { error: '权限验证服务暂时不可用，请稍后重试', reason: 'service_unavailable' }, 503)
    }
    if (!caller?.active || !caller?.backend_enabled) {
      return json(req, { error: '当前账号没有后台权限' }, 403)
    }

    let body: Record<string, any>
    try { body = await req.json() } catch { body = {} }
    const action = text(body.action || 'list').toLowerCase()
    const access = await effectivePermissions(admin, caller)
    const requiredPermission = action === 'list'
      ? 'account.ip_allowlist.view'
      : 'account.ip_allowlist.manage'
    if (!access.founder && !access.permissions.includes(requiredPermission)) {
      return json(req, { error: action === 'list'
        ? '当前账号没有查看后台登录IP白名单的权限'
        : '当前账号没有管理后台登录IP白名单的权限' }, 403)
    }

    if (action === 'list') return json(req, await snapshot(admin, clientIp))

    let mutationAction = action
    let payload: Record<string, unknown> = body

    if (action === 'add_current_ip') {
      if (!clientIp) return json(req, { error: '服务端无法从可信代理读取当前IP' }, 400)
      const currentNetwork = hostCidr(clientIp)
      const requestedScope = ['admin', 'staff', 'both'].includes(text(body.portal_scope).toLowerCase())
        ? text(body.portal_scope).toLowerCase()
        : 'admin'
      const { data: existing, error } = await admin.from('admin_ip_allowlist_entries')
        .select('id,ip_network,label,notes,enabled,portal_scope')
        .eq('ip_network', currentNetwork)
        .maybeSingle()
      if (error) throw error

      const nextScope = existing?.portal_scope === requestedScope || existing?.portal_scope === 'both'
        ? existing?.portal_scope
        : existing?.portal_scope ? 'both' : requestedScope
      if (existing?.enabled && nextScope === existing.portal_scope) {
        return json(req, {
          ok: true,
          mutation: { action: 'add_current_ip', id: existing.id, unchanged: true },
          refresh_required: true,
        })
      }
      if (existing) {
        mutationAction = 'update'
        payload = {
          id: existing.id,
          ip_network: existing.ip_network,
          label: existing.label,
          notes: existing.notes,
          enabled: true,
          portal_scope: nextScope,
        }
      } else {
        mutationAction = 'create'
        payload = {
          ip_network: currentNetwork,
          label: text(body.label) || `当前IP ${clientIp}`,
          notes: text(body.notes) || '由后台“一键加入当前IP”添加',
          enabled: true,
          portal_scope: requestedScope,
        }
      }
    } else if (action === 'set_enforced') {
      if (typeof body.enforced !== 'boolean') {
        return json(req, { error: '白名单开关状态不正确' }, 400)
      }
      const requestedPortal = text(body.portal).toLowerCase()
      if (requestedPortal !== 'admin' && requestedPortal !== 'staff') {
        return json(req, { error: '登录入口类型不正确' }, 400)
      }
      payload = { enforced: body.enforced, portal: requestedPortal }
    } else if (action === 'set_enabled') {
      if (typeof body.enabled !== 'boolean') {
        return json(req, { error: '白名单状态不正确' }, 400)
      }
      payload = { id: body.id, enabled: body.enabled }
    } else if (action === 'delete') {
      payload = { id: body.id }
    } else if (action === 'create' || action === 'update') {
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        return json(req, { error: '白名单状态不正确' }, 400)
      }
      payload = {
        id: body.id,
        ip_network: text(body.ip_network),
        label: text(body.label),
        notes: text(body.notes),
        enabled: body.enabled ?? true,
        portal_scope: text(body.portal_scope).toLowerCase() || 'admin',
      }
    } else {
      return json(req, { error: '不支持的操作' }, 400)
    }

    const { data: mutation, error: mutationError } = await admin.rpc('portal_ip_allowlist_mutate', {
      p_actor_id: userId,
      p_session_id: sessionId,
      p_client_ip: clientIp || null,
      p_action: mutationAction,
      p_payload: payload,
    })
    if (mutationError) {
      const reason = databaseErrorReason(mutationError)
      const requestId = crypto.randomUUID()
      console.error('ADMIN_IP_ALLOWLIST_MUTATION_ERROR', {
        request_id: requestId,
        action: mutationAction,
        reason,
        retryable: reason === 'configuration_busy',
        ...safeMeta(mutationError),
        database_message: String(mutationError?.message || '').slice(0, 160),
      })
      return json(req, {
        error: databaseErrorMessage(mutationError),
        reason,
        request_id: requestId,
        retryable: reason === 'configuration_busy',
      }, String(mutationError.code || '') === '42501'
        ? 403
        : String(mutationError.code || '') === '23505' ? 409 : 400)
    }

    // Do not keep a successful save waiting on the full list snapshot. The
    // browser releases its saving state, then performs a separately authorized
    // list refresh to obtain canonical labels, counters and coverage data.
    return json(req, { ok: true, mutation, refresh_required: true })
  } catch (error) {
    console.error('ADMIN_IP_ALLOWLIST_ERROR', {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
    })
    return json(req, { error: '后台登录IP白名单服务暂时不可用' }, 503)
  }
}

if (import.meta.main) Deno.serve(handleRequest)
