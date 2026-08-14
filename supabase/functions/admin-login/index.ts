import { createClient } from 'npm:@supabase/supabase-js@2'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: cors(req.headers.get('origin')),
    })
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

    const secretKeys = JSON.parse(
      Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'
    )

    const publishableKeys = JSON.parse(
      Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}'
    )

    const secretKey =
      secretKeys.default ||
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    const publishableKey =
      publishableKeys.default ||
      Deno.env.get('SUPABASE_ANON_KEY')

    if (!supabaseUrl || !secretKey || !publishableKey) {
      console.error('Missing Supabase environment configuration')
      return json(req, { error: '登录服务暂不可用' }, 500)
    }

    const admin = createClient(
      supabaseUrl,
      secretKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    )

    // 使用 service/secret key 只做“用户名 → 内部登录邮箱”的安全映射。
    // 内部邮箱不会返回给浏览器。
    const { data: access, error: accessError } = await admin
      .from('user_access')
      .select(`
        auth_user_id,
        login_email,
        backend_enabled,
        active
      `)
      .ilike('login_username', username)
      .maybeSingle()

    // 不区分“用户名不存在 / 被停用 / 无后台权限”，避免泄露账号状态。
    if (
      accessError ||
      !access ||
      !access.active ||
      !access.backend_enabled ||
      !access.login_email
    ) {
      return json(req, { error: '用户名或密码错误' }, 401)
    }

    // 真正密码校验仍交给 Supabase Auth。
    const authClient = createClient(
      supabaseUrl,
      publishableKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      }
    )

    const { data: authData, error: authError } =
      await authClient.auth.signInWithPassword({
        email: access.login_email,
        password,
      })

    if (
      authError ||
      !authData.user ||
      !authData.session ||
      authData.user.id !== access.auth_user_id
    ) {
      return json(req, { error: '用户名或密码错误' }, 401)
    }

    await admin
      .from('audit_logs')
      .insert({
        actor_user_id: authData.user.id,
        employee_id: null,
        module: 'auth',
        action: 'admin_login',
        reason: '后台用户名登录成功',
      })

    return json(req, {
      ok: true,
      access_token: authData.session.access_token,
      refresh_token: authData.session.refresh_token,
    })

  } catch (error) {
    console.error(error)
    return json(req, { error: '登录服务暂不可用' }, 500)
  }
})
