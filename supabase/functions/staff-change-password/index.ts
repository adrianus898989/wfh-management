import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import {
  bearerToken,
  jwtSessionId,
  jwtUserId,
  trustedClientIp,
} from '../_shared/adminIp.ts'
import { corsGate, corsHeaders } from '../_shared/corsOrigin.ts'

const DEPENDENCY_TIMEOUT_MS = 12_000
const MAX_BODY_BYTES = 4_096
const MAX_CURRENT_PASSWORD_LENGTH = 256
const MAX_NEW_PASSWORD_LENGTH = 128
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function failure(req: Request, code: string, status: number, details: Record<string, unknown> = {}) {
  const messages: Record<string, string> = {
    INVALID_REQUEST: '请求格式不正确',
    CURRENT_PASSWORD_REQUIRED: '请输入当前密码',
    NEW_PASSWORD_INVALID: '新密码不符合安全要求',
    PASSWORD_REUSE: '新密码不能与当前密码相同',
    PASSWORD_INCORRECT: '当前密码不正确',
    ACCOUNT_LOCKED: '账号已锁定，请联系管理员',
    ACCOUNT_UNAVAILABLE: '账号不可用，请联系管理员',
    SESSION_ENDED: '登录会话已失效，请重新登录',
    SESSION_CHECK_UNAVAILABLE: '暂时无法验证登录会话，请稍后重试',
    STAFF_IP_NOT_ALLOWED: '当前网络不允许访问员工前端',
    CLIENT_IP_UNAVAILABLE: '暂时无法验证当前网络',
    TOO_MANY_ATTEMPTS: '尝试次数过多，请稍后重试',
    PASSWORD_CHANGE_UNAVAILABLE: '暂时无法修改密码，请稍后重试',
    PASSWORD_CHANGED_ACCOUNT_LOCKED: '密码已修改，但账号已锁定，请联系管理员',
    PASSWORD_CHANGED_FINALIZE_PENDING: '密码已修改，但会话清理暂未完成，请重新登录',
    PASSWORD_CHANGE_OUTCOME_UNKNOWN: '无法确认密码是否已修改，请使用新密码重新登录',
  }
  return json(req, {
    ok: false,
    error: messages[code] || messages.PASSWORD_CHANGE_UNAVAILABLE,
    code,
    ...details,
  }, status)
}

function safeMeta(error: any) {
  const status = Number(error?.status)
  return {
    name: String(error?.name || 'Error').slice(0, 64),
    code: String(error?.code || '').slice(0, 64) || null,
    status: Number.isFinite(status) ? status : null,
  }
}

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

function configuredKey(raw: string | undefined, fallback: string | undefined) {
  try {
    const values = JSON.parse(raw || '{}')
    return String(values?.default || fallback || '').trim()
  } catch {
    return String(fallback || '').trim()
  }
}

function validNewPassword(password: string) {
  return password.length >= 10
    && password.length <= MAX_NEW_PASSWORD_LENGTH
    && /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /[0-9]/.test(password)
    && /[^A-Za-z0-9]/.test(password)
}

async function authResponse(response: Response) {
  let body: Record<string, any> = {}
  try {
    const parsed = await response.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed
  } catch {}
  return { response, body }
}

function authCode(body: Record<string, any>) {
  return String(body?.code || body?.error_code || body?.error || '').trim().toLowerCase()
}

function invalidCredentials(result: { response: Response, body: Record<string, any> }) {
  const code = authCode(result.body)
  const message = String(result.body?.msg || result.body?.message || result.body?.error_description || '').toLowerCase()
  return result.response.status === 400 && (
    code === 'invalid_credentials'
    || code === 'invalid_grant'
    || message.includes('invalid login credentials')
  )
}

async function revokeWithToken(admin: any, accessToken: string, scope: 'local' | 'global') {
  if (!accessToken) return
  try {
    const { error } = await admin.auth.admin.signOut(accessToken, scope)
    if (error) console.error('STAFF_PASSWORD_AUTH_REVOKE_ERROR', safeMeta(error))
  } catch (error) {
    console.error('STAFF_PASSWORD_AUTH_REVOKE_ERROR', safeMeta(error))
  }
}

async function releaseCurrentLease(userClient: any) {
  try {
    const { error } = await userClient.rpc('app_session_release')
    if (error) console.error('STAFF_PASSWORD_LEASE_RELEASE_ERROR', safeMeta(error))
  } catch (error) {
    console.error('STAFF_PASSWORD_LEASE_RELEASE_ERROR', safeMeta(error))
  }
}

async function processRequest(req: Request) {
  const corsResponse = corsGate(req)
  if (corsResponse) return corsResponse
  if (req.method !== 'POST') return failure(req, 'INVALID_REQUEST', 405)

  const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '')
  const secretKey = configuredKey(
    Deno.env.get('SUPABASE_SECRET_KEYS'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  )
  const publishableKey = configuredKey(
    Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'),
    Deno.env.get('SUPABASE_ANON_KEY'),
  )
  if (!supabaseUrl || !secretKey || !publishableKey) {
    return failure(req, 'PASSWORD_CHANGE_UNAVAILABLE', 503)
  }

  const authorization = req.headers.get('Authorization') || ''
  const token = bearerToken(authorization)
  const userId = jwtUserId(token)
  const appSessionId = jwtSessionId(token)
  if (!token || !UUID_PATTERN.test(userId) || !UUID_PATTERN.test(appSessionId)) {
    return failure(req, 'SESSION_ENDED', 401)
  }

  let rawBody = ''
  let body: Record<string, unknown>
  try {
    const declaredLength = Number(req.headers.get('content-length') || 0)
    if (declaredLength > MAX_BODY_BYTES) return failure(req, 'INVALID_REQUEST', 413)
    rawBody = await req.text()
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return failure(req, 'INVALID_REQUEST', 413)
    }
    const parsed = JSON.parse(rawBody)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_body')
    body = parsed as Record<string, unknown>
  } catch {
    return failure(req, 'INVALID_REQUEST', 400)
  }

  const bodyKeys = Object.keys(body).sort()
  if (bodyKeys.join(',') !== 'current_password,new_password') {
    return failure(req, 'INVALID_REQUEST', 400)
  }
  const currentPassword = typeof body.current_password === 'string' ? body.current_password : ''
  const newPassword = typeof body.new_password === 'string' ? body.new_password : ''
  rawBody = ''
  body = {}
  if (!currentPassword || currentPassword.length > MAX_CURRENT_PASSWORD_LENGTH) {
    return failure(req, 'CURRENT_PASSWORD_REQUIRED', 400)
  }
  if (!validNewPassword(newPassword)) {
    return failure(req, 'NEW_PASSWORD_INVALID', 400)
  }
  if (newPassword === currentPassword) return failure(req, 'PASSWORD_REUSE', 400)

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

  const { data: currentAuth, error: currentAuthError } = await admin.auth.getUser(token)
  const email = String(currentAuth?.user?.email || '').trim().toLowerCase()
  if (currentAuthError || currentAuth?.user?.id !== userId || !email) {
    return failure(req, 'SESSION_ENDED', 401)
  }

  const clientIp = trustedClientIp(req)
  const { data: attestation, error: attestationError } = await admin.rpc('staff_ip_session_attest', {
    p_user_id: userId,
    p_session_id: appSessionId,
    p_client_ip: clientIp || null,
    p_source: 'heartbeat',
  })
  if (attestationError) {
    console.error('STAFF_PASSWORD_IP_ATTEST_ERROR', safeMeta(attestationError))
    return failure(req, 'SESSION_CHECK_UNAVAILABLE', 503)
  }
  if (!attestation?.ok) {
    const code = attestation?.reason === 'client_ip_unavailable'
      ? 'CLIENT_IP_UNAVAILABLE'
      : attestation?.reason === 'ip_not_allowed'
        ? 'STAFF_IP_NOT_ALLOWED'
        : attestation?.reason === 'staff_account_not_found'
          ? 'ACCOUNT_UNAVAILABLE'
          : 'SESSION_ENDED'
    return failure(req, code, code === 'CLIENT_IP_UNAVAILABLE' ? 503 : code === 'SESSION_ENDED' ? 401 : 403)
  }

  const { data: preflight, error: preflightError } = await admin.rpc(
    'staff_password_change_preflight_v1',
    { p_user_id: userId, p_session_id: appSessionId },
  )
  if (preflightError) {
    console.error('STAFF_PASSWORD_PREFLIGHT_ERROR', safeMeta(preflightError))
    return failure(req, 'SESSION_CHECK_UNAVAILABLE', 503)
  }
  if (!preflight?.ok) {
    if (preflight?.reason === 'account_locked') {
      await releaseCurrentLease(userClient)
      await revokeWithToken(admin, token, 'global')
      return failure(req, 'ACCOUNT_LOCKED', 423, {
        lock_threshold: Number(preflight?.lock_threshold || 5),
      })
    }
    const code = preflight?.reason === 'staff_account_not_found'
      ? 'ACCOUNT_UNAVAILABLE'
      : 'SESSION_ENDED'
    return failure(req, code, code === 'SESSION_ENDED' ? 401 : 403)
  }

  let verified: { response: Response, body: Record<string, any> }
  try {
    verified = await authResponse(await boundedFetch(
      `${supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {
          apikey: publishableKey,
          'Content-Type': 'application/json',
          'X-Client-Info': 'wfh-staff-change-password',
        },
        body: JSON.stringify({ email, password: currentPassword }),
      },
    ))
  } catch (error) {
    console.error('STAFF_PASSWORD_VERIFY_UNAVAILABLE', safeMeta(error))
    return failure(req, 'PASSWORD_CHANGE_UNAVAILABLE', 503)
  }

  if (!verified.response.ok) {
    if (invalidCredentials(verified)) {
      const { data: lockState, error: lockError } = await admin.rpc(
        'login_password_failure_register',
        { p_user_id: userId, p_portal: 'staff' },
      )
      if (lockError) {
        console.error('STAFF_PASSWORD_LOCK_FAILURE_ERROR', safeMeta(lockError))
        return failure(req, 'PASSWORD_CHANGE_UNAVAILABLE', 503)
      }
      if (lockState?.login_locked) {
        await releaseCurrentLease(userClient)
        await revokeWithToken(admin, token, 'global')
        return failure(req, 'ACCOUNT_LOCKED', 423, {
          lock_threshold: Number(lockState?.lock_threshold || 5),
        })
      }
      return failure(req, 'PASSWORD_INCORRECT', 401, {
        attempts_remaining: Number(lockState?.attempts_remaining || 0),
      })
    }
    if (verified.response.status === 429) return failure(req, 'TOO_MANY_ATTEMPTS', 429)
    console.error('STAFF_PASSWORD_VERIFY_REJECTED', {
      code: authCode(verified.body) || null,
      status: verified.response.status,
    })
    return failure(req, 'PASSWORD_CHANGE_UNAVAILABLE', 503)
  }

  const verifiedToken = String(verified.body?.access_token || '')
  const verifiedUserId = String(verified.body?.user?.id || jwtUserId(verifiedToken))
  const verifiedSessionId = jwtSessionId(verifiedToken)
  if (
    !verifiedToken
    || verifiedUserId !== userId
    || !UUID_PATTERN.test(verifiedSessionId)
  ) {
    await revokeWithToken(admin, verifiedToken, 'local')
    console.error('STAFF_PASSWORD_VERIFIED_IDENTITY_MISMATCH')
    return failure(req, 'PASSWORD_CHANGE_UNAVAILABLE', 503)
  }

  const { data: clearedLock, error: clearLockError } = await admin.rpc(
    'login_password_success_clear',
    { p_user_id: userId },
  )
  if (clearLockError) {
    console.error('STAFF_PASSWORD_LOCK_SUCCESS_ERROR', safeMeta(clearLockError))
    await revokeWithToken(admin, verifiedToken, 'local')
    return failure(req, 'PASSWORD_CHANGE_UNAVAILABLE', 503)
  }
  if (clearedLock?.login_locked) {
    await releaseCurrentLease(userClient)
    await revokeWithToken(admin, verifiedToken, 'global')
    return failure(req, 'ACCOUNT_LOCKED', 423, {
      lock_threshold: Number(clearedLock?.lock_threshold || 5),
    })
  }

  let changed: { response: Response, body: Record<string, any> }
  try {
    changed = await authResponse(await boundedFetch(`${supabaseUrl}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${verifiedToken}`,
        'Content-Type': 'application/json',
        'X-Client-Info': 'wfh-staff-change-password',
      },
      body: JSON.stringify({ password: newPassword }),
    }))
  } catch (error) {
    console.error('STAFF_PASSWORD_UPDATE_OUTCOME_UNKNOWN', safeMeta(error))
    await releaseCurrentLease(userClient)
    await revokeWithToken(admin, verifiedToken, 'global')
    return failure(req, 'PASSWORD_CHANGE_OUTCOME_UNKNOWN', 503, {
      password_change_outcome_unknown: true,
    })
  }

  if (!changed.response.ok) {
    const code = authCode(changed.body)
    await revokeWithToken(admin, verifiedToken, 'local')
    if (code === 'same_password') return failure(req, 'PASSWORD_REUSE', 400)
    if (code === 'weak_password') return failure(req, 'NEW_PASSWORD_INVALID', 400)
    if (changed.response.status === 429) return failure(req, 'TOO_MANY_ATTEMPTS', 429)
    console.error('STAFF_PASSWORD_UPDATE_REJECTED', {
      code: code || null,
      status: changed.response.status,
    })
    return failure(req, 'PASSWORD_CHANGE_UNAVAILABLE', 503)
  }

  if (String(changed.body?.id || changed.body?.user?.id || userId) !== userId) {
    await releaseCurrentLease(userClient)
    await revokeWithToken(admin, verifiedToken, 'global')
    console.error('STAFF_PASSWORD_CHANGED_IDENTITY_MISMATCH')
    return failure(req, 'PASSWORD_CHANGED_FINALIZE_PENDING', 503, {
      password_changed: true,
    })
  }

  const { data: finalized, error: finalizeError } = await admin.rpc(
    'staff_password_change_finalize_v1',
    {
      p_user_id: userId,
      p_app_session_id: appSessionId,
      p_verified_session_id: verifiedSessionId,
    },
  )
  if (finalizeError || !finalized?.ok) {
    console.error('STAFF_PASSWORD_FINALIZE_ERROR', finalizeError
      ? safeMeta(finalizeError)
      : { name: 'FinalizeRejected', code: String(finalized?.reason || '').slice(0, 64), status: null })
    await releaseCurrentLease(userClient)
    await revokeWithToken(admin, verifiedToken, 'global')
    return failure(req, 'PASSWORD_CHANGED_FINALIZE_PENDING', 503, {
      password_changed: true,
    })
  }

  if (finalized?.login_locked) {
    return failure(req, 'PASSWORD_CHANGED_ACCOUNT_LOCKED', 423, {
      password_changed: true,
      lock_threshold: Number(finalized?.lock_threshold || 5),
    })
  }

  return json(req, {
    ok: true,
    code: 'PASSWORD_CHANGED',
    password_changed: true,
    session_revoked: true,
  })
}

export async function handleRequest(req: Request) {
  try {
    return await processRequest(req)
  } catch (error) {
    console.error('STAFF_PASSWORD_UNEXPECTED_ERROR', safeMeta(error))
    return failure(req, 'PASSWORD_CHANGE_UNAVAILABLE', 503)
  }
}

if (import.meta.main) Deno.serve(handleRequest)
