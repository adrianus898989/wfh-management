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

Deno.serve(async (req) => {
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
      return json(req, { error: '服务配置缺失' }, 500)
    }

    const authorization = req.headers.get('Authorization') || ''

    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return json(req, { error: '登录已失效' }, 401)

    const admin = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: caller, error: callerError } = await admin
      .from('user_access')
      .select('auth_user_id,employee_id,role_id,data_scope,backend_enabled,active,roles(id,code,name)')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle()

    if (callerError || !caller || !caller.active || !caller.backend_enabled) {
      return json(req, { error: '无后台权限' }, 403)
    }

    const callerRole = Array.isArray(caller.roles) ? caller.roles[0] : caller.roles
    const isFounder = callerRole?.code === 'founder'

    const { data: callerRp } = await admin
      .from('role_permissions')
      .select('permission_id,permissions(code)')
      .eq('role_id', caller.role_id)

    const { data: callerOverrides } = await admin
      .from('user_permission_overrides')
      .select('allowed,permission_id,permissions(code)')
      .eq('auth_user_id', userData.user.id)

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

    const can = (code: string) => {
      if (isFounder) return true
      if (overrideMap.has(code)) return overrideMap.get(code) === true
      return rolePerms.has(code)
    }

    const audit = async (action: string, reason: string) => {
      await admin.from('audit_logs').insert({
        actor_user_id: userData.user.id,
        employee_id: caller.employee_id || null,
        module: 'access_control',
        action,
        reason,
      })
    }

    const body = await req.json()
    const action = cleanString(body.action || 'bootstrap')

    async function getScopedEmployees() {
      const { data: allEmployees, error } = await admin
        .from('employees')
        .select('id,employee_no,full_name,status,team_id,position_id,teams(id,name),positions(id,name)')
        .eq('status', 'active')
        .order('employee_no')
        .limit(5000)

      if (error) throw error
      if (isFounder || caller.data_scope === 'all') return allEmployees || []

      if (caller.data_scope === 'own_team') {
        if (!caller.employee_id) return []
        const me = (allEmployees || []).find((e: any) => e.id === caller.employee_id)
        if (!me?.team_id) return []
        return (allEmployees || []).filter((e: any) => e.team_id === me.team_id)
      }

      if (caller.data_scope === 'assigned') {
        const [{ data: st }, { data: se }] = await Promise.all([
          admin.from('user_scope_teams').select('team_id').eq('auth_user_id', userData.user.id),
          admin.from('user_scope_employees').select('employee_id').eq('auth_user_id', userData.user.id),
        ])
        const teams = new Set((st || []).map((x: any) => x.team_id))
        const people = new Set((se || []).map((x: any) => x.employee_id))
        return (allEmployees || []).filter((e: any) => teams.has(e.team_id) || people.has(e.id))
      }

      return []
    }

    async function saveScope(targetAuthUserId: string, teamIds: string[], employeeIds: string[]) {
      await admin.from('user_scope_teams').delete().eq('auth_user_id', targetAuthUserId)
      await admin.from('user_scope_employees').delete().eq('auth_user_id', targetAuthUserId)

      if (teamIds.length) {
        const { error } = await admin.from('user_scope_teams').insert(
          [...new Set(teamIds)].map(team_id => ({ auth_user_id: targetAuthUserId, team_id }))
        )
        if (error) throw error
      }

      if (employeeIds.length) {
        const { error } = await admin.from('user_scope_employees').insert(
          [...new Set(employeeIds)].map(employee_id => ({ auth_user_id: targetAuthUserId, employee_id }))
        )
        if (error) throw error
      }
    }

    if (action === 'bootstrap') {
      if (!can('user.view') && !can('account.create') && !can('role.manage')) {
        return json(req, { error: '无账号与权限查看权限' }, 403)
      }
      const employees = await getScopedEmployees()

      const [
        accessRes,
        roleRes,
        permissionRes,
        rpRes,
        teamRes,
        positionRes,
        scopeTeamRes,
        scopeEmployeeRes,
      ] = await Promise.all([
        admin.from('user_access')
          .select('auth_user_id,employee_id,role_id,login_username,login_email,backend_enabled,employee_portal_enabled,otp_required,data_scope,active,must_change_password,roles(id,code,name,system_locked,active)')
          .order('created_at', { ascending: true }),
        admin.from('roles').select('id,code,name,system_locked,active').order('name'),
        admin.from('permissions').select('id,code,name,category,sensitive').order('category').order('name'),
        admin.from('role_permissions').select('role_id,permission_id'),
        admin.from('teams').select('id,name').order('name'),
        admin.from('positions').select('id,name').order('name'),
        admin.from('user_scope_teams').select('auth_user_id,team_id'),
        admin.from('user_scope_employees').select('auth_user_id,employee_id'),
      ])

      if (accessRes.error) return json(req, { error: accessRes.error.message }, 500)
      if (roleRes.error) return json(req, { error: roleRes.error.message }, 500)

      const employeeMap = new Map(employees.map((e: any) => [e.id, e]))
      const decorate = (x: any) => ({
        ...x,
        employee: x.employee_id ? employeeMap.get(x.employee_id) || null : null,
      })

      const backendAccounts = (accessRes.data || [])
        .filter((x: any) => x.backend_enabled)
        .map(decorate)

      const employeeAccounts = (accessRes.data || [])
        .filter((x: any) => x.employee_portal_enabled)
        .map(decorate)

      return json(req, {
        ok: true,
        caller: {
          auth_user_id: userData.user.id,
          role_code: callerRole?.code || null,
          is_founder: isFounder,
          permissions: isFounder ? ['*'] : [...rolePerms],
        },
        employees,
        backend_accounts: backendAccounts,
        employee_accounts: employeeAccounts,
        roles: roleRes.data || [],
        permissions: permissionRes.data || [],
        role_permissions: rpRes.data || [],
        teams: teamRes.data || [],
        positions: positionRes.data || [],
        scope_teams: scopeTeamRes.data || [],
        scope_employees: scopeEmployeeRes.data || [],
      })
    }

    if (action === 'create_role') {
      if (!can('role.manage')) return json(req, { error: '无角色管理权限' }, 403)
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
      if (!can('role.manage')) return json(req, { error: '无角色管理权限' }, 403)
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
      if (!can('role.manage')) return json(req, { error: '无角色管理权限' }, 403)
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

      await admin.from('role_permissions').delete().eq('role_id', roleId)
      const { error } = await admin.from('roles').delete().eq('id', roleId)
      if (error) return json(req, { error: error.message }, 400)
      await audit('role_delete', `删除角色 ${role.name}`)
      return json(req, { ok: true })
    }

    if (action === 'save_role_permissions') {
      if (!can('role.manage')) return json(req, { error: '无角色管理权限' }, 403)
      const roleId = cleanString(body.role_id)
      const permissionIds = Array.isArray(body.permission_ids) ? body.permission_ids.map(cleanString) : []

      const { data: role } = await admin.from('roles')
        .select('id,code,system_locked')
        .eq('id', roleId).maybeSingle()

      if (!role) return json(req, { error: '角色不存在' }, 404)
      if (role.code === 'founder') return json(req, { error: 'Founder 固定拥有全部权限' }, 400)

      await admin.from('role_permissions').delete().eq('role_id', roleId)

      if (permissionIds.length) {
        const { error } = await admin.from('role_permissions').insert(
          [...new Set(permissionIds)].map(permission_id => ({ role_id: roleId, permission_id }))
        )
        if (error) return json(req, { error: error.message }, 400)
      }

      await audit('role_permissions_update', `更新角色权限 ${roleId}`)
      return json(req, { ok: true })
    }

    if (action === 'create_backend') {
      if (!can('account.create')) return json(req, { error: '无创建账号权限' }, 403)

      const username = cleanString(body.username).toLowerCase()
      const password = String(body.password || '')
      const roleId = cleanString(body.role_id)
      const employeeId = cleanString(body.employee_id) || null
      const dataScope = cleanString(body.data_scope || 'own_team')
      const otpRequired = Boolean(body.otp_required)
      const teamIds = Array.isArray(body.team_ids) ? body.team_ids.map(cleanString) : []
      const employeeIds = Array.isArray(body.employee_ids) ? body.employee_ids.map(cleanString) : []

      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return json(req, { error: '用户名只允许3-32位字母、数字、._-' }, 400)
      }
      if (!passwordOk(password)) {
        return json(req, { error: '密码至少10位，并包含大小写字母、数字和特殊符号' }, 400)
      }

      const { data: role } = await admin.from('roles').select('id,code,active').eq('id', roleId).maybeSingle()
      if (!role || !role.active) return json(req, { error: '角色不可用' }, 400)
      if (role.code === 'founder' || role.code === 'employee') {
        return json(req, { error: '该角色不能用于新增后台账号' }, 400)
      }

      const { data: exists } = await admin.from('user_access')
        .select('auth_user_id').ilike('login_username', username).maybeSingle()
      if (exists) return json(req, { error: '用户名已存在' }, 409)

      const internalEmail = `${username}.${crypto.randomUUID().slice(0, 8)}@admin.wfh.invalid`

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: internalEmail,
        password,
        email_confirm: true,
      })
      if (createError || !created.user) {
        return json(req, { error: createError?.message || '创建登录账号失败' }, 400)
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
        return json(req, { error: insertError.message }, 400)
      }

      if (dataScope === 'assigned') {
        try {
          await saveScope(created.user.id, teamIds, employeeIds)
        } catch (e) {
          await admin.from('user_access').delete().eq('auth_user_id', created.user.id)
          await admin.auth.admin.deleteUser(created.user.id)
          throw e
        }
      }

      await audit('backend_account_create', `创建后台账号 ${username}`)
      return json(req, { ok: true })
    }

    if (action === 'update_backend') {
      if (!can('account.create')) return json(req, { error: '无编辑账号权限' }, 403)

      const target = cleanString(body.auth_user_id)
      const roleId = cleanString(body.role_id)
      const employeeId = cleanString(body.employee_id) || null
      const dataScope = cleanString(body.data_scope || 'own_team')
      const teamIds = Array.isArray(body.team_ids) ? body.team_ids.map(cleanString) : []
      const employeeIds = Array.isArray(body.employee_ids) ? body.employee_ids.map(cleanString) : []

      const { data: current } = await admin.from('user_access')
        .select('auth_user_id,role_id,roles(code)')
        .eq('auth_user_id', target).maybeSingle()

      if (!current) return json(req, { error: '账号不存在' }, 404)
      const cr = Array.isArray(current.roles) ? current.roles[0] : current.roles
      if (cr?.code === 'founder') return json(req, { error: 'Founder 角色不能修改' }, 400)

      const { data: role } = await admin.from('roles').select('id,code,active').eq('id', roleId).maybeSingle()
      if (!role || !role.active || ['founder','employee'].includes(role.code)) {
        return json(req, { error: '角色不可用' }, 400)
      }

      const { error } = await admin.from('user_access')
        .update({ employee_id: employeeId, role_id: roleId, data_scope: dataScope })
        .eq('auth_user_id', target)

      if (error) return json(req, { error: error.message }, 400)

      if (dataScope === 'assigned') await saveScope(target, teamIds, employeeIds)
      else await saveScope(target, [], [])

      await audit('backend_account_update', `编辑后台账号 ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'create_staff') {
      if (!can('account.create')) return json(req, { error: '无创建账号权限' }, 403)

      const employeeId = cleanString(body.employee_id)
      const username = cleanString(body.username).toLowerCase()
      const password = String(body.password || '')

      if (!employeeId) return json(req, { error: '员工前端账号必须关联员工档案' }, 400)
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return json(req, { error: '用户名只允许3-32位字母、数字、._-' }, 400)
      }
      if (!passwordOk(password)) {
        return json(req, { error: '密码至少10位，并包含大小写字母、数字和特殊符号' }, 400)
      }

      const [{ data: employee }, { data: usernameExists }, { data: linkedExists }, { data: employeeRole }] = await Promise.all([
        admin.from('employees').select('id,employee_no,full_name,status').eq('id', employeeId).maybeSingle(),
        admin.from('user_access').select('auth_user_id').ilike('login_username', username).maybeSingle(),
        admin.from('user_access').select('auth_user_id').eq('employee_id', employeeId).eq('employee_portal_enabled', true).maybeSingle(),
        admin.from('roles').select('id').eq('code', 'employee').eq('active', true).maybeSingle(),
      ])

      if (!employee) return json(req, { error: '关联的员工档案不存在' }, 404)
      if (usernameExists) return json(req, { error: '用户名已存在' }, 409)
      if (linkedExists) return json(req, { error: '该员工已开通过前端账号' }, 409)
      if (!employeeRole) return json(req, { error: '员工角色未配置' }, 500)

      const internalEmail = `${username}.${crypto.randomUUID().slice(0, 8)}@staff.wfh.invalid`
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: internalEmail,
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
        login_username: username,
        login_email: internalEmail,
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

      await audit('staff_account_create', `创建员工前端账号 ${employee.employee_no} / ${username}`)
      return json(req, { ok: true })
    }

    if (action === 'toggle_otp') {
      if (!can('account.otp_toggle')) return json(req, { error: '无OTP设置权限' }, 403)
      const target = cleanString(body.auth_user_id)
      const required = Boolean(body.otp_required)
      const { error } = await admin.from('user_access')
        .update({ otp_required: required })
        .eq('auth_user_id', target)
      if (error) return json(req, { error: error.message }, 400)
      await audit('otp_toggle', `OTP=${required} ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'toggle_active') {
      if (!can('account.disable')) return json(req, { error: '无停用账号权限' }, 403)
      const target = cleanString(body.auth_user_id)
      const active = Boolean(body.active)

      if (target === userData.user.id && !active) {
        return json(req, { error: '不能停用当前登录账号' }, 400)
      }

      const { data: targetAccess } = await admin.from('user_access')
        .select('roles(code)')
        .eq('auth_user_id', target).maybeSingle()
      const tr = Array.isArray(targetAccess?.roles) ? targetAccess.roles[0] : targetAccess?.roles
      if (tr?.code === 'founder' && !active) return json(req, { error: 'Founder 不能停用' }, 400)

      const { error } = await admin.from('user_access').update({ active }).eq('auth_user_id', target)
      if (error) return json(req, { error: error.message }, 400)

      await audit('account_active_toggle', `active=${active} ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'reset_password') {
      if (!can('account.reset_password')) return json(req, { error: '无重置密码权限' }, 403)
      const target = cleanString(body.auth_user_id)
      const password = String(body.password || '')
      if (!passwordOk(password)) {
        return json(req, { error: '新密码至少10位，并包含大小写字母、数字和特殊符号' }, 400)
      }

      const { error } = await admin.auth.admin.updateUserById(target, { password })
      if (error) return json(req, { error: error.message }, 400)

      await admin.from('user_access')
        .update({ must_change_password: true, password_reset_at: new Date().toISOString() })
        .eq('auth_user_id', target)

      await audit('password_reset', `重置密码 ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'reset_mfa') {
      if (!can('account.mfa_reset')) return json(req, { error: '无重置OTP权限' }, 403)
      const target = cleanString(body.auth_user_id)

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
      if (!can('account.delete')) return json(req, { error: '无删除账号权限' }, 403)
      const target = cleanString(body.auth_user_id)
      if (target === userData.user.id) return json(req, { error: '不能删除当前登录账号' }, 400)

      const { data: targetAccess } = await admin.from('user_access')
        .select('roles(code)')
        .eq('auth_user_id', target).maybeSingle()
      const tr = Array.isArray(targetAccess?.roles) ? targetAccess.roles[0] : targetAccess?.roles
      if (tr?.code === 'founder') return json(req, { error: 'Founder 不能删除' }, 400)

      await admin.from('user_permission_overrides').delete().eq('auth_user_id', target)
      await admin.from('user_scope_teams').delete().eq('auth_user_id', target)
      await admin.from('user_scope_employees').delete().eq('auth_user_id', target)
      await admin.from('user_access').delete().eq('auth_user_id', target)

      const { error } = await admin.auth.admin.deleteUser(target)
      if (error) return json(req, { error: error.message }, 400)

      await audit('account_delete', `删除登录账号 ${target}`)
      return json(req, { ok: true })
    }

    if (action === 'create_employee') {
      if (!can('employee.create')) return json(req, { error: '无新增员工权限' }, 403)

      const employeeNo = cleanString(body.employee_no).toUpperCase()
      const fullName = cleanString(body.full_name)
      if (!employeeNo || !fullName) return json(req, { error: '员工ID和姓名必填' }, 400)

      const { data: exists } = await admin.from('employees')
        .select('id').eq('employee_no', employeeNo).maybeSingle()
      if (exists) return json(req, { error: '员工ID已存在' }, 409)

      const row: any = {
        employee_no: employeeNo,
        full_name: fullName,
        country: cleanString(body.country),
        nationality: cleanString(body.nationality),
        employment_type: cleanString(body.employment_type),
        status: cleanString(body.status || 'active'),
        team_id: cleanString(body.team_id) || null,
        position_id: cleanString(body.position_id) || null,
      }

      const { data: employee, error } = await admin.from('employees')
        .insert(row)
        .select('id,employee_no,full_name')
        .single()

      if (error) return json(req, { error: error.message }, 400)
      await audit('employee_create', `新增员工 ${employeeNo}`)
      return json(req, { ok: true, employee })
    }

    return json(req, { error: 'Unknown action' }, 400)
  } catch (error) {
    console.error(error)
    return json(req, { error: error instanceof Error ? error.message : '服务器错误' }, 500)
  }
})
