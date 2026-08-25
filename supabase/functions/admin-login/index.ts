import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const allowedOrigin = 'https://adrianus898989.github.io'

// Founder 是系统锁定账号，不能在后台停用或删除。这里保留固定映射，
// 避免数据库连接繁忙时连 Founder 都无法登录；密码仍由 Supabase Auth 校验。
const founderAccess = {
  auth_user_id: '567e1c26-9ff7-4df2-a3bd-9b68e26d10c9',
  login_username: 'founder',
  login_email: 'adrianus898989@gmail.com',
  backend_enabled: true,
  active: true,
  otp_required: false,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const usernamePattern = /^[a-z0-9._-]{3,32}$/

const loginMessages: Record<string, string> = {
  INVALID_REQUEST: '请求格式不正确',
  INVALID_USERNAME: '账号格式不正确',
  INVALID_EMAIL: '邮箱格式不正确',
  PASSWORD_REQUIRED: '请输入密码',
  USERNAME_NOT_FOUND: '账号不存在',
  EMAIL_NOT_FOUND: '邮箱不存在',
  STAFF_ACCOUNT_NOT_FOUND: '账号不存在',
  PASSWORD_INCORRECT: '密码错误',
  ACCOUNT_UNAVAILABLE: '账号不可用，请联系管理员',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请稍后重试',
  LOGIN_SERVICE_UNAVAILABLE: '登录服务暂不可用，请稍后重试',
  SESSION_CHECK_UNAVAILABLE: '登录会话验证暂不可用，请稍后重试',
  ACTIVE_SESSION_EXISTS: '旧会话接管未完成，请重新登录',
  SESSION_REJECTED: '登录会话已失效，请重试',
}

function loginError(req: Request, code: string, status: number) {
  return json(req, {
    error: loginMessages[code] || '登录失败，请稍后重试',
    code,
  }, status, { 'X-Login-Error-Code': code })
}

function safeErrorMeta(error: any) {
  const status = Number(error?.status)
  return {
    name: String(error?.name || 'Error').slice(0, 64),
    code: String(error?.code || '').slice(0, 64) || null,
    status: Number.isFinite(status) ? status : null,
  }
}

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin === allowedOrigin ? origin : allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Login-Error-Code',
    'Vary': 'Origin',
  }
}

function json(req: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(req.headers.get('origin')),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

function timedFetch(timeoutMs: number) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetch(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

function isInvalidCredentials(error: any) {
  const code = String(error?.code || '').toLowerCase()
  return code === 'invalid_credentials'
}

function isRateLimited(error: any) {
  const code = String(error?.code || '').toLowerCase()
  return Number(error?.status) === 429 || code === 'over_request_rate_limit'
}

function isUnavailableAccount(error: any) {
  const code = String(error?.code || '').toLowerCase()
  return code === 'email_not_confirmed' || code === 'user_banned'
}

async function findAccess(admin: any, identifier: string, mode: string) {
  const isFounder = identifier === founderAccess.login_username && mode === 'admin'

  let lastError: any = null

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let query = admin
      .from('user_access')
      .select('auth_user_id,login_username,login_email,backend_enabled,employee_portal_enabled,active,otp_required')
    query = mode === 'staff'
      ? query.eq('login_email', identifier)
      : query.eq('login_username', identifier)
    const { data, error } = await query.maybeSingle()

    if (!error) {
      // Prefer the live row so later MFA/entry-setting changes also apply to
      // Founder. Keep the locked fallback only when that row is unavailable.
      return { access: data || (isFounder ? founderAccess : null), unavailable: false }
    }

    lastError = error
    console.error('ADMIN_LOGIN_ACCESS_RETRY', {
      attempt,
      ...safeErrorMeta(error),
    })

    if (attempt < 3) await sleep(attempt * 500)
  }

  if (isFounder) {
    console.error('ADMIN_LOGIN_FOUNDER_ACCESS_FALLBACK', safeErrorMeta(lastError))
    return { access: founderAccess, unavailable: false }
  }

  console.error('ADMIN_LOGIN_ACCESS_UNAVAILABLE', safeErrorMeta(lastError))
  return { access: null, unavailable: true }
}

async function authenticate(authClient: any, email: string, password: string) {
  let lastError: any = null

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await authClient.auth.signInWithPassword({ email, password })

    if (!result.error) return result
    if (
      isInvalidCredentials(result.error)
      || isRateLimited(result.error)
      || isUnavailableAccount(result.error)
    ) return result

    lastError = result.error
    console.error('ADMIN_LOGIN_AUTH_RETRY', {
      attempt,
      ...safeErrorMeta(result.error),
    })

    if (attempt < 3) await sleep(attempt * 750)
  }

  return {
    data: { user: null, session: null },
    error: lastError || new Error('AUTH_UNAVAILABLE'),
  }
}

async function claimCandidateSession(authClient: any, mode: 'admin' | 'staff') {
  let lastResult: any = { data: null, error: new Error('SESSION_CLAIM_UNAVAILABLE') }

  // Claim is idempotent for the same JWT session_id. Retrying is therefore
  // safe even when PostgREST lost only the first response after commit.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = await authClient.rpc('app_session_claim', { p_portal: mode })
    if (!lastResult.error) return lastResult

    console.error('ADMIN_LOGIN_SESSION_CLAIM_RETRY', {
      attempt,
      ...safeErrorMeta(lastResult.error),
    })
    if (attempt < 3) await sleep(attempt * 350)
  }

  return lastResult
}

async function discardCandidateSession(authClient: any) {
  try {
    const { error } = await authClient.auth.signOut({ scope: 'local' })
    if (error) console.error('ADMIN_LOGIN_CANDIDATE_SIGNOUT_ERROR', safeErrorMeta(error))
  } catch (error: any) {
    console.error('ADMIN_LOGIN_CANDIDATE_SIGNOUT_ERROR', safeErrorMeta(error))
  }
}

async function releaseCandidateLease(authClient: any) {
  try {
    const { error } = await authClient.rpc('app_session_release')
    if (error) console.error('ADMIN_LOGIN_CANDIDATE_RELEASE_ERROR', safeErrorMeta(error))
  } catch (error: any) {
    console.error('ADMIN_LOGIN_CANDIDATE_RELEASE_ERROR', safeErrorMeta(error))
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors(req.headers.get('origin')) })
  }

  if (req.method !== 'POST') {
    return json(req, { error: '请求方式不支持', code: 'METHOD_NOT_ALLOWED' }, 405)
  }

  try {
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return loginError(req, 'INVALID_REQUEST', 400)
    }

    if (!body || Array.isArray(body) || typeof body !== 'object') {
      return loginError(req, 'INVALID_REQUEST', 400)
    }

    const mode = String(body.mode || 'admin').trim().toLowerCase()
    const username = String(body.username || '').trim().toLowerCase()
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')

    if (mode !== 'admin' && mode !== 'staff') return loginError(req, 'INVALID_REQUEST', 400)
    if (mode === 'admin' && !usernamePattern.test(username)) {
      return loginError(req, 'INVALID_USERNAME', 400)
    }
    if (mode === 'staff' && !emailPattern.test(email)) {
      return loginError(req, 'INVALID_EMAIL', 400)
    }
    if (!password) return loginError(req, 'PASSWORD_REQUIRED', 400)

    const identifier = mode === 'staff' ? email : username

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
    const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
    const secretKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const publishableKey = publishableKeys.default || Deno.env.get('SUPABASE_ANON_KEY')

    if (!supabaseUrl || !secretKey || !publishableKey) {
      console.error('ADMIN_LOGIN_CONFIG_MISSING')
      return loginError(req, 'LOGIN_SERVICE_UNAVAILABLE', 503)
    }

    const admin = createClient(supabaseUrl, secretKey, {
      global: { fetch: timedFetch(12000) },
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { access, unavailable } = await findAccess(admin, identifier, mode)

    if (unavailable) {
      return loginError(req, 'LOGIN_SERVICE_UNAVAILABLE', 503)
    }

    if (!access) {
      return loginError(req, mode === 'staff' ? 'EMAIL_NOT_FOUND' : 'USERNAME_NOT_FOUND', 401)
    }

    const entryEnabled = mode === 'staff' ? access?.employee_portal_enabled : access?.backend_enabled
    if (!access.active || !entryEnabled || !access.login_email) {
      return loginError(req, mode === 'staff' ? 'STAFF_ACCOUNT_NOT_FOUND' : 'ACCOUNT_UNAVAILABLE', 403)
    }

    const authClient = createClient(supabaseUrl, publishableKey, {
      global: { fetch: timedFetch(40000) },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    })

    const { data: authData, error: authError } = await authenticate(
      authClient,
      access.login_email,
      password,
    )

    if (authError) {
      if (isInvalidCredentials(authError)) {
        // Supabase deliberately returns the same invalid_credentials code for
        // an unknown Auth email and a wrong password. At this point the email
        // has already matched our controlled access directory, so expose only
        // the intended PASSWORD_INCORRECT business result.
        return loginError(req, 'PASSWORD_INCORRECT', 401)
      }

      if (isRateLimited(authError)) return loginError(req, 'TOO_MANY_ATTEMPTS', 429)
      if (isUnavailableAccount(authError)) {
        return loginError(req, mode === 'staff' ? 'STAFF_ACCOUNT_NOT_FOUND' : 'ACCOUNT_UNAVAILABLE', 403)
      }

      console.error('ADMIN_LOGIN_AUTH_UNAVAILABLE', safeErrorMeta(authError))
      return loginError(req, 'LOGIN_SERVICE_UNAVAILABLE', 503)
    }

    if (
      !authData?.user ||
      !authData?.session ||
      authData.user.id !== access.auth_user_id
    ) {
      console.error('ADMIN_LOGIN_ID_MISMATCH')
      await discardCandidateSession(authClient)
      return loginError(req, mode === 'staff' ? 'STAFF_ACCOUNT_NOT_FOUND' : 'ACCOUNT_UNAVAILABLE', 403)
    }

    const mfaRequired = mode === 'admin' && Boolean(access.otp_required)

    if (!mfaRequired) {
      // Password verification creates a new Supabase Auth session. Before any
      // token leaves this trusted boundary, atomically make it the current app
      // session. The database revokes the previous browser's auth session and
      // lease; MFA admins defer takeover until their JWT is promoted to AAL2.
      const { data: lease, error: leaseError } = await claimCandidateSession(authClient, mode)

      if (leaseError) {
        console.error('ADMIN_LOGIN_SESSION_CLAIM_ERROR', {
          ...safeErrorMeta(leaseError),
        })
        // The claim may have committed even if its response was interrupted.
        // Release only this candidate's session_id, then revoke that session.
        await releaseCandidateLease(authClient)
        await discardCandidateSession(authClient)
        return loginError(req, 'SESSION_CHECK_UNAVAILABLE', 503)
      }

      if (!lease?.ok) {
        // A rejected candidate never owns the lease. Local sign-out revokes
        // only the candidate session and cannot disturb the current browser.
        await discardCandidateSession(authClient)
        if (lease?.reason === 'active_elsewhere') {
          return loginError(req, 'ACTIVE_SESSION_EXISTS', 409)
        }
        if (mode === 'staff' && lease?.reason === 'staff_account_not_found') {
          return loginError(req, 'STAFF_ACCOUNT_NOT_FOUND', 403)
        }
        console.error('ADMIN_LOGIN_SESSION_REJECTED', lease?.reason || 'unknown')
        return loginError(req, 'SESSION_REJECTED', 401)
      }
    }

    // 审计写入不能阻塞已通过的登录，数据库恢复后仍会正常记录。
    const auditPromise = Promise.resolve(
      admin.from('audit_logs').insert({
        actor_user_id: authData.user.id,
        employee_id: null,
        module: 'auth',
        action: mode === 'staff' ? 'staff_login' : 'admin_login',
        reason: mode === 'staff' ? '员工前端邮箱登录成功' : '后台账号登录成功',
      }),
    ).then(({ error }: any) => {
      if (error) console.error('ADMIN_LOGIN_AUDIT_ERROR', safeErrorMeta(error))
    }).catch((error: any) => {
      console.error('ADMIN_LOGIN_AUDIT_ERROR', safeErrorMeta(error))
    })

    const edgeRuntime = (globalThis as any).EdgeRuntime
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(auditPromise)

    return json(req, {
      ok: true,
      mfa_required: mfaRequired,
      session_claimed: !mfaRequired,
      access_token: authData.session.access_token,
      refresh_token: authData.session.refresh_token,
    })
  } catch (error) {
    console.error('ADMIN_LOGIN_UNEXPECTED_ERROR', safeErrorMeta(error))
    return loginError(req, 'LOGIN_SERVICE_UNAVAILABLE', 503)
  }
})
