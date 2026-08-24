import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const text = (value: unknown) => String(value ?? '').trim()
const upper = (value: unknown) => text(value).toUpperCase()
function jwtSessionId(token: string) { try { const raw = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') || ''; const padded = raw + '='.repeat((4 - raw.length % 4) % 4); return text(JSON.parse(atob(padded))?.session_id) } catch { return '' } }
async function requireCurrentAdminSession(service: any, userId: string, token: string) {
  const sessionId = jwtSessionId(token)
  if (!sessionId) throw new Error('UNAUTHORIZED')
  const { data, error } = await service.from('app_session_leases').select('user_id')
    .eq('user_id', userId).eq('session_id', sessionId).eq('portal', 'admin')
    .gt('lease_expires_at', new Date().toISOString()).maybeSingle()
  if (error || !data?.user_id) throw new Error('SESSION_NOT_CURRENT')
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
})

async function permissionAllowed(service: any, access: any, userId: string, code: string) {
  const { data: role } = await service.from('roles').select('id,code').eq('id', access.role_id).maybeSingle()
  if (role?.code === 'founder') return true

  const { data: permission } = await service.from('permissions').select('id').eq('code', code).maybeSingle()
  if (!permission?.id) return false

  const { data: override } = await service
    .from('user_permission_overrides')
    .select('allowed')
    .eq('auth_user_id', userId)
    .eq('permission_id', permission.id)
    .maybeSingle()
  if (override && typeof override.allowed === 'boolean') return override.allowed

  const { data: rolePermission } = await service
    .from('role_permissions')
    .select('role_id')
    .eq('role_id', access.role_id)
    .eq('permission_id', permission.id)
    .maybeSingle()
  return Boolean(rolePermission)
}

async function authorize(req: Request) {
  const auth = req.headers.get('Authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new Error('UNAUTHORIZED')

  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
  const { data: userData, error: userError } = await service.auth.getUser(token)
  if (userError || !userData?.user) throw new Error('UNAUTHORIZED')

  const userId = userData.user.id
  await requireCurrentAdminSession(service, userId, token)
  const { data: access, error: accessError } = await service
    .from('user_access')
    .select('auth_user_id,employee_id,role_id,data_scope,active,backend_enabled')
    .eq('auth_user_id', userId)
    .maybeSingle()
  if (accessError || !access?.active || !access?.backend_enabled) throw new Error('FORBIDDEN')
  if (!(await permissionAllowed(service, access, userId, 'employee.view'))) throw new Error('FORBIDDEN')

  const { data: role } = await service.from('roles').select('code').eq('id', access.role_id).maybeSingle()
  return { service, userId, access, roleCode: role?.code || '' }
}

async function loadScope(service: any, caller: any) {
  if (caller.roleCode === 'founder' || caller.access.data_scope === 'all') {
    return { mode: 'all', teamIds: new Set<string>(), employeeIds: new Set<string>() }
  }

  if (caller.access.data_scope === 'assigned_teams') {
    const [{ data: teams }, { data: employees }] = await Promise.all([
      service.from('user_scope_teams').select('team_id').eq('auth_user_id', caller.userId),
      service.from('user_scope_employees').select('employee_id').eq('auth_user_id', caller.userId),
    ])
    return {
      mode: 'assigned_teams',
      teamIds: new Set((teams || []).map((row: any) => row.team_id)),
      employeeIds: new Set((employees || []).map((row: any) => row.employee_id)),
    }
  }

  if (caller.access.data_scope === 'self') {
    return {
      mode: 'self',
      teamIds: new Set<string>(),
      employeeIds: new Set(caller.access.employee_id ? [caller.access.employee_id] : []),
    }
  }

  if (caller.access.data_scope === 'own_team' && caller.access.employee_id) {
    const { data: employee } = await service
      .from('employees')
      .select('team_id')
      .eq('id', caller.access.employee_id)
      .maybeSingle()
    return {
      mode: 'own_team',
      teamIds: new Set(employee?.team_id ? [employee.team_id] : []),
      employeeIds: new Set<string>(),
    }
  }

  return { mode: 'none', teamIds: new Set<string>(), employeeIds: new Set<string>() }
}

function employeeInScope(employee: any, scope: any) {
  if (scope.mode === 'all') return true
  if (scope.mode === 'self') return scope.employeeIds.has(employee.id)
  if (scope.mode === 'own_team') return Boolean(employee.team_id && scope.teamIds.has(employee.team_id))
  if (scope.mode === 'assigned_teams') {
    return scope.employeeIds.has(employee.id) || Boolean(employee.team_id && scope.teamIds.has(employee.team_id))
  }
  return false
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: '仅支持 POST 请求' }, 405)

  try {
    const caller = await authorize(req)
    const body = await req.json().catch(() => ({}))
    const employeeNos = Array.from(new Set(
      (Array.isArray(body.employee_nos) ? body.employee_nos : []).map(upper).filter(Boolean),
    )).slice(0, 2000)
    if (!employeeNos.length) return json({ rows: [] })

    const scope = await loadScope(caller.service, caller)
    const employees: any[] = []
    for (let index = 0; index < employeeNos.length; index += 300) {
      const { data, error } = await caller.service
        .from('employees')
        .select('id,team_id,employee_no,hire_date,resign_date')
        .in('employee_no', employeeNos.slice(index, index + 300))
      if (error) throw error
      employees.push(...(data || []))
    }

    return json({
      rows: employees
        .filter(employee => employeeInScope(employee, scope))
        .map(({ employee_no, hire_date, resign_date }) => ({ employee_no, hire_date, resign_date })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'UNAUTHORIZED') return json({ error: '登录已失效，请重新登录' }, 401)
    if (message === 'FORBIDDEN') return json({ error: '当前账号没有员工档案查看权限' }, 403)
    return json({ error: message || '员工日期读取失败' }, 500)
  }
})
