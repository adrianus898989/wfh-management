import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import {
  bearerToken,
  hostCidr,
  jwtSessionId,
  trustedClientIp,
} from '../_shared/adminIp.ts'

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

function text(value: unknown) {
  return String(value ?? '').trim()
}

function related(value: any) {
  return Array.isArray(value) ? value[0] : value
}

function databaseErrorMessage(error: any) {
  const message = String(error?.message || '')
  const messages: Record<string, string> = {
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
  }
  const key = Object.keys(messages).find(code => message.includes(code))
  return key ? messages[key] : '白名单保存失败'
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
  const [settingsResult, entriesResult, coverageResult] = await Promise.all([
    admin.from('admin_ip_allowlist_settings')
      .select('enforced,updated_at,updated_by')
      .eq('id', 1)
      .single(),
    admin.from('admin_ip_allowlist_entries')
      .select('id,ip_network,label,notes,enabled,created_by,created_at,updated_by,updated_at,last_hit_at,last_hit_ip,last_hit_user_id,hit_count')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }),
    admin.rpc('admin_ip_prelogin_check', { p_client_ip: clientIp || null }),
  ])
  if (settingsResult.error || entriesResult.error || coverageResult.error) {
    throw settingsResult.error || entriesResult.error || coverageResult.error
  }

  const entries = entriesResult.data || []
  const actorIds = [...new Set([
    settingsResult.data?.updated_by,
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

  const enabledCount = entries.filter((entry: any) => entry.enabled).length
  const setting = settingsResult.data
  return {
    ok: true,
    current_ip: clientIp || null,
    current_ip_covered: Boolean(coverageResult.data?.matched_entry_id),
    settings: {
      ...setting,
      effective: Boolean(setting.enforced && enabledCount > 0),
      enabled_count: enabledCount,
      total_count: entries.length,
      updated_by_label: setting.updated_by ? actorMap.get(setting.updated_by) || '已删除账号' : '系统',
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
      return json(req, { error: '白名单服务配置缺失' }, 503)
    }

    const authorization = req.headers.get('Authorization') || ''
    const token = bearerToken(authorization)
    const sessionId = jwtSessionId(token)
    if (!token || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return json(req, { error: '登录已失效', reason: 'auth_session_missing' }, 401)
    }

    const admin = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: userData, error: userError } = await admin.auth.getUser(token)
    if (userError || !userData.user) {
      return json(req, { error: '登录已失效', reason: 'auth_session_missing' }, 401)
    }

    const observedClientIp = trustedClientIp(req)
    const { data: guard, error: guardError } = await admin.rpc('admin_ip_session_attest', {
      p_user_id: userData.user.id,
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
    if (heartbeatError || !heartbeat?.ok) {
      return json(req, { error: '当前浏览器会话已失效', reason: heartbeat?.reason || 'session_not_current' }, 401)
    }

    const { data: caller, error: callerError } = await admin.from('user_access')
      .select('auth_user_id,employee_id,role_id,active,backend_enabled,roles(code)')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle()
    if (callerError || !caller?.active || !caller?.backend_enabled) {
      return json(req, { error: '当前账号没有后台权限' }, 403)
    }

    const access = await effectivePermissions(admin, caller)
    if (!access.founder && !access.permissions.includes('account.ip_allowlist.manage')) {
      return json(req, { error: '当前账号没有管理后台登录IP白名单的权限' }, 403)
    }

    let body: Record<string, any>
    try { body = await req.json() } catch { body = {} }
    const action = text(body.action || 'list').toLowerCase()

    if (action === 'list') return json(req, await snapshot(admin, clientIp))

    let mutationAction = action
    let payload: Record<string, unknown> = body

    if (action === 'add_current_ip') {
      if (!clientIp) return json(req, { error: '服务端无法从可信代理读取当前IP' }, 400)
      const currentNetwork = hostCidr(clientIp)
      const { data: existing, error } = await admin.from('admin_ip_allowlist_entries')
        .select('id,enabled')
        .eq('ip_network', currentNetwork)
        .maybeSingle()
      if (error) throw error

      if (existing?.enabled) return json(req, await snapshot(admin, clientIp))
      if (existing) {
        mutationAction = 'set_enabled'
        payload = { id: existing.id, enabled: true }
      } else {
        mutationAction = 'create'
        payload = {
          ip_network: currentNetwork,
          label: text(body.label) || `当前IP ${clientIp}`,
          notes: text(body.notes) || '由后台“一键加入当前IP”添加',
          enabled: true,
        }
      }
    } else if (action === 'set_enforced') {
      if (typeof body.enforced !== 'boolean') {
        return json(req, { error: '白名单开关状态不正确' }, 400)
      }
      payload = { enforced: body.enforced }
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
      }
    } else {
      return json(req, { error: '不支持的操作' }, 400)
    }

    const { error: mutationError } = await admin.rpc('admin_ip_allowlist_mutate', {
      p_actor_id: userData.user.id,
      p_session_id: sessionId,
      p_client_ip: clientIp || null,
      p_action: mutationAction,
      p_payload: payload,
    })
    if (mutationError) {
      return json(req, { error: databaseErrorMessage(mutationError) },
        String(mutationError.code || '') === '42501' ? 403 : 400)
    }

    return json(req, await snapshot(admin, clientIp))
  } catch (error) {
    console.error('ADMIN_IP_ALLOWLIST_ERROR', {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
    })
    return json(req, { error: '后台登录IP白名单服务暂时不可用' }, 503)
  }
}

if (import.meta.main) Deno.serve(handleRequest)
