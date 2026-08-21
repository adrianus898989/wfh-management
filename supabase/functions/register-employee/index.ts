import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

async function sha256(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function validPassword(password: string) {
  return password.length >= 10 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const body = await req.json()
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const activationCode = String(body.activation_code || '').trim().toUpperCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400)
    if (!validPassword(password)) return json({ error: '密码至少10位，并包含大写、小写、数字和特殊符号' }, 400)
    if (!activationCode) return json({ error: '请填写激活码' }, 400)

    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
    const secretKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    if (!supabaseUrl || !secretKey) return json({ error: '服务器配置缺失' }, 500)
    const admin = createClient(supabaseUrl, secretKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const { data: activation, error: activationError } = await admin.from('employee_activation_codes')
      .select('id,employee_id,expires_at,used_at,revoked_at,locked_until').eq('code_hash', await sha256(activationCode)).maybeSingle()
    if (activationError) return json({ error: '激活码验证失败' }, 500)
    if (!activation) return json({ error: '激活码错误' }, 400)
    if (activation.revoked_at) return json({ error: '此激活码已经失效' }, 400)
    if (activation.used_at) return json({ error: '此激活码已经使用过' }, 400)
    if (activation.locked_until && new Date(activation.locked_until) > new Date()) return json({ error: '此激活码暂时被锁定' }, 429)
    if (new Date(activation.expires_at) < new Date()) return json({ error: '激活码已经过期，请联系管理员重新生成' }, 400)

    const { data: employee } = await admin.from('employees').select('id,employee_no,full_name,status').eq('id', activation.employee_id).maybeSingle()
    if (!employee) return json({ error: '找不到对应员工资料' }, 400)
    if (employee.status !== 'active') return json({ error: '只有在职员工可以注册账号' }, 400)

    const [{ data: existingEmployee }, { data: existingEmail }, { data: employeeRole }] = await Promise.all([
      admin.from('user_access').select('auth_user_id').eq('employee_id', employee.id).eq('employee_portal_enabled', true).maybeSingle(),
      admin.from('user_access').select('auth_user_id').ilike('login_email', email).maybeSingle(),
      admin.from('roles').select('id').eq('code', 'employee').eq('active', true).maybeSingle(),
    ])
    if (existingEmployee) return json({ error: '此员工ID已经开通过前端账号' }, 409)
    if (existingEmail) return json({ error: '此邮箱已经注册过账号' }, 409)
    if (!employeeRole) return json({ error: '员工角色未配置' }, 500)

    // 后台直接确认邮箱，仅把邮箱作为登录账号，不发送验证邮件。
    const { data: newUser, error: createError } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { employee_id: employee.employee_no, full_name: employee.full_name },
    })
    if (createError || !newUser.user) return json({ error: createError?.message || '账号创建失败' }, 400)

    const authUserId = newUser.user.id
    const { error: accessError } = await admin.from('user_access').insert({
      auth_user_id: authUserId, employee_id: employee.id, role_id: employeeRole.id,
      login_username: email, login_email: email, backend_enabled: false, employee_portal_enabled: true,
      otp_required: false, data_scope: 'self', active: true, must_change_password: false,
    })
    if (accessError) {
      await admin.auth.admin.deleteUser(authUserId)
      return json({ error: '账号绑定失败，请重新注册' }, 500)
    }

    const { error: codeError } = await admin.from('employee_activation_codes').update({ used_at: new Date().toISOString() }).eq('id', activation.id)
    if (codeError) {
      await admin.from('user_access').delete().eq('auth_user_id', authUserId)
      await admin.auth.admin.deleteUser(authUserId)
      return json({ error: '激活码核销失败，请重新注册' }, 500)
    }
    await admin.from('audit_logs').insert({ actor_user_id: authUserId, employee_id: employee.id, module: 'user_account', action: 'employee_self_register', reason: '员工通过激活码完成前端账号注册', new_data: { email, employee_no: employee.employee_no } })
    return json({ ok: true, employee_id: employee.employee_no, employee_name: employee.full_name, email, message: '账号注册成功' })
  } catch (error) {
    console.error(error)
    return json({ error: '服务器处理失败' }, 500)
  }
})
