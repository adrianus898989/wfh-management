import { createClient } from 'npm:@supabase/supabase-js@2'

const allowedOrigin = 'https://adrianus898989.github.io'

// Founder 是系统锁定账号，不能在后台停用或删除。这里保留固定映射，
// 避免数据库连接繁忙时连 Founder 都无法登录；密码仍由 Supabase Auth 校验。
const founderAccess = {
  auth_user_id: '567e1c26-9ff7-4df2-a3bd-9b68e26d10c9',
  login_email: 'adrianus898989@gmail.com',
  backend_enabled: true,
  active: true,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
  const message = String(error?.message || '').toLowerCase()
  return code === 'invalid_credentials' || message.includes('invalid login credentials')
}

async function findAccess(admin: any, username: string) {
  if (username === 'founder') {
    return { access: founderAccess, unavailable: false }
  }

  let lastError: any = null

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { data, error } = await admin
      .from('user_access')
      .select('auth_user_id,login_email,backend_enabled,active')
      .ilike('login_username', username)
      .maybeSingle()

    if (!error) return { access: data, unavailable: false }

    lastError = error
    console.error('ADMIN_LOGIN_ACCESS_RETRY', {
      attempt,
      code: error.code || null,
      message: error.message || null,
    })

    if (attempt < 3) await sleep(attempt * 500)
  }

  console.error('ADMIN_LOGIN_ACCESS_UNAVAILABLE', lastError?.message || 'unknown')
  return { access: null, unavailable: true }
}

async function authenticate(authClient: any, email: string, password: string) {
  let lastError: any = null

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await authClient.auth.signInWithPassword({ email, password })

    if (!result.error) return result
    if (isInvalidCredentials(result.error)) return result

    lastError = result.error
    console.error('ADMIN_LOGIN_AUTH_RETRY', {
      attempt,
      status: result.error.status || null,
      code: result.error.code || null,
      message: result.error.message || null,
    })

    if (attempt < 3) await sleep(attempt * 750)
  }

  return {
    data: { user: null, session: null },
    error: lastError || new Error('AUTH_UNAVAILABLE'),
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors(req.headers.get('origin')) })
  }

  if (req.method !== 'POST') {
    return json(req, { error: '登录失败' }, 405)
  }

  try {
    const body = await req.json()
    const username = String(body.username || '').trim().toLowerCase()
    const password = String(body.password || '')

    if (!/^[a-z0-9._-]{3,32}$/.test(username) || !password) {
      return json(req, { error: '用户名或密码错误' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
    const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
    const secretKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const publishableKey = publishableKeys.default || Deno.env.get('SUPABASE_ANON_KEY')

    if (!supabaseUrl || !secretKey || !publishableKey) {
      console.error('ADMIN_LOGIN_CONFIG_MISSING')
      return json(req, { error: '登录服务暂不可用，请稍后重试' }, 503)
    }

    const admin = createClient(supabaseUrl, secretKey, {
      global: { fetch: timedFetch(12000) },
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { access, unavailable } = await findAccess(admin, username)

    if (unavailable) {
      return json(req, { error: '登录服务繁忙，请稍后重试' }, 503)
    }

    if (!access || !access.active || !access.backend_enabled || !access.login_email) {
      return json(req, { error: '用户名或密码错误' }, 401)
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
        return json(req, { error: '用户名或密码错误' }, 401)
      }

      console.error('ADMIN_LOGIN_AUTH_UNAVAILABLE', authError.message || authError)
      return json(req, { error: '登录服务繁忙，请稍后重试' }, 503)
    }

    if (
      !authData?.user ||
      !authData?.session ||
      authData.user.id !== access.auth_user_id
    ) {
      console.error('ADMIN_LOGIN_ID_MISMATCH')
      return json(req, { error: '用户名或密码错误' }, 401)
    }

    // 审计写入不能阻塞已通过的登录，数据库恢复后仍会正常记录。
    const auditPromise = Promise.resolve(
      admin.from('audit_logs').insert({
        actor_user_id: authData.user.id,
        employee_id: null,
        module: 'auth',
        action: 'admin_login',
        reason: '后台用户名登录成功',
      }),
    ).then(({ error }: any) => {
      if (error) console.error('ADMIN_LOGIN_AUDIT_ERROR', error.message)
    }).catch((error: any) => {
      console.error('ADMIN_LOGIN_AUDIT_ERROR', error?.message || error)
    })

    const edgeRuntime = (globalThis as any).EdgeRuntime
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(auditPromise)

    return json(req, {
      ok: true,
      access_token: authData.session.access_token,
      refresh_token: authData.session.refresh_token,
    })
  } catch (error) {
    console.error('ADMIN_LOGIN_UNEXPECTED_ERROR', error)
    return json(req, { error: '登录服务暂不可用，请稍后重试' }, 503)
  }
})
