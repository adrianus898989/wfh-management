import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  loadEffectiveEmployeeScope,
} from '../_shared/employeeScope.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const text = (value: unknown) => String(value ?? '').trim()
const upper = (value: unknown) => text(value).toUpperCase()
function jwtSessionId(token: string) { try { const raw = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') || ''; const padded = raw + '='.repeat((4 - raw.length % 4) % 4); return text(JSON.parse(atob(padded))?.session_id) } catch { return '' } }
async function requireCurrentAdminSession(service: any, userId: string, token: string) { const sessionId = jwtSessionId(token); if (!sessionId) throw new Error('UNAUTHORIZED'); const { data, error } = await service.from('app_session_leases').select('user_id').eq('user_id', userId).eq('session_id', sessionId).eq('portal', 'admin').gt('lease_expires_at', new Date().toISOString()).maybeSingle(); if (error || !data?.user_id) throw new Error('SESSION_NOT_CURRENT') }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
})

// Shared archive/report grade thresholds: 优秀 0 / 正常 1–8 / 注意 9–15 / 重点 16–30 / 高频 31+
const riskKey = (value: unknown) => {
  const count = Number(value || 0)
  if (count >= 31) return 'high'
  if (count >= 16) return 'watch'
  if (count >= 9) return 'attention'
  if (count >= 1) return 'normal'
  return 'excellent'
}

async function caller(req: Request, service: any) {
  const auth = req.headers.get('Authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new Error('UNAUTHORIZED')

  const { data: userData, error: userError } = await service.auth.getUser(token)
  if (userError || !userData?.user) throw new Error('UNAUTHORIZED')

  const userId = userData.user.id
  await requireCurrentAdminSession(service, userId, token)
  const { data: access, error } = await service.from('user_access')
    .select('auth_user_id,employee_id,role_id,data_scope,active,backend_enabled')
    .eq('auth_user_id', userId)
    .maybeSingle()
  if (error || !access?.active || !access?.backend_enabled) throw new Error('FORBIDDEN')

  const { data: role } = await service.from('roles').select('code').eq('id', access.role_id).maybeSingle()
  return { userId, access, roleCode: role?.code || '' }
}

async function permissionAllowed(service: any, current: any, code: string) {
  if (current.roleCode === 'founder') return true
  const { data: permission } = await service.from('permissions').select('id').eq('code', code).maybeSingle()
  if (!permission?.id) return false
  const { data: override } = await service.from('user_permission_overrides').select('allowed')
    .eq('auth_user_id', current.userId).eq('permission_id', permission.id).maybeSingle()
  if (override && typeof override.allowed === 'boolean') return override.allowed
  const { data: rolePermission } = await service.from('role_permissions').select('role_id')
    .eq('role_id', current.access.role_id).eq('permission_id', permission.id).maybeSingle()
  return Boolean(rolePermission)
}

async function scopeInfo(service: any, current: any) {
  return await loadEffectiveEmployeeScope(
    service,
    current.userId,
    current.access,
    current.roleCode,
  )
}

function basicMissing(employee: any) {
  const missing: string[] = []
  if (!text(employee.full_name)) missing.push('姓名')
  if (!text(employee.country || employee.nationality)) missing.push('国家 / 国籍')
  if (!text(employee.employment_type)) missing.push('员工类型')
  if (!employee.team_id) missing.push('团队')
  if (!employee.position_id) missing.push('岗位')
  if (!text(employee.shift_name)) missing.push('班次')
  if (!text(employee.hire_date)) missing.push('入职日期')
  return missing
}

const normalizedName = (value: unknown) => text(value).replace(/\s+/g, ' ').toLowerCase()

function groupsOf<T>(items: T[], size = 150) {
  const groups: T[][] = []
  for (let offset = 0; offset < items.length; offset += size) groups.push(items.slice(offset, offset + size))
  return groups
}

async function loadReferenceRows(service: any, table: string, selection: string, ids: string[]) {
  const rows: any[] = []
  for (const group of groupsOf([...new Set(ids.filter(Boolean))])) {
    const { data, error } = await service.from(table).select(selection).in('id', group)
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows
}

/**
 * Load the service-only current roster directory, then intersect it with the
 * central effective employee allow-list before any employee data is queried.
 * Historical employees.team_id / position_id never participate in this
 * boundary. Missing employee/team/position mappings fail closed.
 */
async function loadCurrentRosterOrganization(service: any, scope: any) {
  const { data, error } = await service.rpc('admin_scope_current_employee_directory')
  if (error) throw new Error('SCOPE_SERVICE_UNAVAILABLE')

  const payload = Array.isArray(data) && data.length === 1 && !data[0]?.employee_id
    ? data[0]
    : data
  const effectiveEmployeeIds = scope.mode === 'all' ? null : new Set(scope.employeeIds || [])
  const byEmployeeId = new Map<string, { employeeId: string, teamId: string, positionId: string }>()

  for (const item of Array.isArray(payload?.employees) ? payload.employees : []) {
    const employeeId = text(item?.employee_id)
    const teamId = text(item?.team_id)
    const positionId = text(item?.position_id)
    if (!employeeId || !teamId || !positionId || item?.position_unmatched === true) continue
    if (effectiveEmployeeIds && !effectiveEmployeeIds.has(employeeId)) continue
    byEmployeeId.set(employeeId, { employeeId, teamId, positionId })
  }

  const directory = [...byEmployeeId.values()]
  const [teamRows, positionRows] = await Promise.all([
    loadReferenceRows(service, 'teams', 'id,name,country,status', directory.map(row => row.teamId)),
    loadReferenceRows(service, 'positions', 'id,name,code,status', directory.map(row => row.positionId)),
  ])
  const teamById = new Map(teamRows
    .filter((row: any) => text(row.status) === 'active')
    .map((row: any) => [text(row.id), row]))
  const positionById = new Map(positionRows
    .filter((row: any) => text(row.status) === 'active')
    .map((row: any) => [text(row.id), row]))

  // A dimension may be deleted between the directory RPC and this lookup.
  // Excluding the affected employee is safer than falling back to stale archive fields.
  const resolvedDirectory = directory.filter(row => teamById.has(row.teamId) && positionById.has(row.positionId))
  return {
    directory: resolvedDirectory,
    byEmployeeId: new Map(resolvedDirectory.map(row => [row.employeeId, row])),
    teamById,
    positionById,
  }
}

function currentOrganizationEmployeeIds(organization: any, teamFilter: unknown, positionFilter: unknown) {
  const requestedTeam = normalizedName(teamFilter)
  const requestedPosition = normalizedName(positionFilter)
  return organization.directory
    .filter((row: any) => {
      const team = organization.teamById.get(row.teamId)
      const position = organization.positionById.get(row.positionId)
      if (requestedTeam && text(team?.id) !== text(teamFilter) && normalizedName(team?.name) !== requestedTeam) return false
      if (requestedPosition && text(position?.id) !== text(positionFilter) && normalizedName(position?.name) !== requestedPosition) return false
      return true
    })
    .map((row: any) => row.employeeId)
}

async function loadEmployeesByCurrentIds(currentEmployeeIds: string[], makeQuery: (ids: string[]) => any) {
  const rows: any[] = []
  for (const group of groupsOf(currentEmployeeIds)) {
    const { data, error } = await makeQuery(group)
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows.sort((a: any, b: any) => text(a.employee_no).localeCompare(text(b.employee_no)))
}

async function loadRowsByValues(
  values: string[],
  makeQuery: (group: string[]) => any,
) {
  const rows: any[] = []
  for (const group of groupsOf([...new Set(values.filter(Boolean))])) {
    const { data, error } = await makeQuery(group)
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const service = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      { auth: { persistSession: false } },
    )
    const current = await caller(req, service)
    const body = await req.json().catch(() => ({}))
    if (!(await permissionAllowed(service, current, 'employee.directory.view'))) throw new Error('没有查看员工资料的权限')
    if (body.export === true && !(await permissionAllowed(service, current, 'employee.directory.export'))) throw new Error('没有导出员工资料的权限')
    const canViewEmployeeSensitive = await permissionAllowed(service, current, 'sensitive.employee.view')
    const scope = await scopeInfo(service, current)
    const organization = await loadCurrentRosterOrganization(service, scope)
    const filters = body.filters || {}
    const risk = text(filters.risk_level || body.risk_level)
    const accountStatus = text(filters.account_status)
    const page = Math.max(1, Number(body.page || 1))
    const allowedSizes = [20, 30, 50, 100, 500]
    const requestedSize = Number(body.page_size || 20)
    const pageSize = allowedSizes.includes(requestedSize) ? requestedSize : 20

    const currentEmployeeIds = currentOrganizationEmployeeIds(organization, filters.team, filters.position)
    if (!currentEmployeeIds.length) return json({ rows: [], total: 0, page, page_size: pageSize, pages: 1 })

    const buildEmployeeQuery = (ids: string[]) => {
      let query = service.from('employees').select(`
        id,employee_no,full_name,country,nationality,employment_type,status,
        shift_name,group_name,platform_scope,work_content,work_tg,backend_accounts,hire_date,
        resign_date,leader_name,trainer_name,profile_status,official_id_pending,source_type,
        source_sheet,created_at
      `).in('id', ids)
      if (text(filters.employee_no)) query = query.ilike('employee_no', `%${text(filters.employee_no)}%`)
      if (text(filters.full_name)) query = query.ilike('full_name', `%${text(filters.full_name)}%`)
      // Sensitive filters must follow the same authorization rule as the
      // regular employee-list endpoint. Ignoring an unauthorized filter also
      // prevents it from becoming a blind value-existence probe.
      if (canViewEmployeeSensitive && text(filters.work_tg)) query = query.ilike('work_tg', `%${text(filters.work_tg)}%`)
      if (canViewEmployeeSensitive && text(filters.backend_account)) query = query.ilike('backend_accounts', `%${text(filters.backend_account)}%`)
      if (text(filters.country)) query = query.ilike('country', `%${text(filters.country)}%`)
      if (text(filters.status)) query = query.eq('status', filters.status)
      if (text(filters.employment_type)) query = query.ilike('employment_type', `%${text(filters.employment_type)}%`)
      if (text(filters.shift_name)) query = query.ilike('shift_name', `%${text(filters.shift_name)}%`)
      if (text(filters.leader)) {
        const manager = text(filters.leader).replace(/[%_,()]/g, ' ').trim()
        if (manager) query = query.or([
          `leader_name.ilike.%${manager}%`,
          `person_in_charge.ilike.%${manager}%`,
          `online_leader.ilike.%${manager}%`,
        ].join(','))
      }
      if (text(filters.hire_from)) query = query.gte('hire_date', filters.hire_from)
      if (text(filters.hire_to)) query = query.lte('hire_date', filters.hire_to)
      return query.order('employee_no', { ascending: true })
    }

    const currentEmployees = await loadEmployeesByCurrentIds(currentEmployeeIds, buildEmployeeQuery)
    const allEmployees = currentEmployees.map((employee: any) => {
      const current = organization.byEmployeeId.get(text(employee.id))
      const team = current ? organization.teamById.get(current.teamId) : null
      const position = current ? organization.positionById.get(current.positionId) : null
      return {
        ...employee,
        team_id: current?.teamId || null,
        position_id: current?.positionId || null,
        teams: team || null,
        positions: position || null,
      }
    }).filter((employee: any) => employee.team_id && employee.position_id)

    const employeeNos = allEmployees.map((employee: any) => upper(employee.employee_no)).filter(Boolean)
    const employeeIds = allEmployees.map((employee: any) => text(employee.id)).filter(Boolean)
    const [summaryRows, allAccountRows] = await Promise.all([
      loadRowsByValues(employeeNos, group => service.from('employee_error_summary')
        .select('employee_no,month_error_count,total_error_count,risk_level')
        .in('employee_no', group)),
      loadRowsByValues(employeeIds, group => service.from('user_access')
        .select('employee_id,employee_portal_enabled,active')
        .eq('employee_portal_enabled', true)
        .in('employee_id', group)),
    ])

    const summaryMap = new Map((summaryRows || []).map((row: any) => [upper(row.employee_no), row]))
    const accountSet = new Set((allAccountRows || []).map((row: any) => row.employee_id))
    const activeAccountSet = new Set(
      (allAccountRows || []).filter((row: any) => row.active === true).map((row: any) => row.employee_id)
    )
    const matched = (allEmployees || []).filter((employee: any) => {
      const summary: any = summaryMap.get(upper(employee.employee_no))
      const currentRisk = riskKey(summary?.total_error_count || 0)
      if (risk && currentRisk !== risk) return false
      if (accountStatus === 'activated' && !accountSet.has(employee.id)) return false
      if (accountStatus === 'unactivated' && accountSet.has(employee.id)) return false
      return true
    })

    const total = matched.length
    const start = (page - 1) * pageSize
    const rows = matched.slice(start, start + pageSize)
    const ids = rows.map((row: any) => row.id)
    const { data: operatorRows } = ids.length
      ? await service.from('employee_audit_logs').select('employee_id,actor_username,created_at').in('employee_id', ids).order('created_at', { ascending: false }).limit(500)
      : { data: [] }
    const operatorMap = new Map<string, string>()
    for (const row of operatorRows || []) {
      if (!operatorMap.has(row.employee_id)) operatorMap.set(row.employee_id, text(row.actor_username))
    }

    return json({
      rows: rows.map((employee: any) => {
        const missing = basicMissing(employee)
        const summary: any = summaryMap.get(upper(employee.employee_no))
        const totalErrorCount = Number(summary?.total_error_count || 0)
        return {
          ...employee,
          work_tg: canViewEmployeeSensitive ? employee.work_tg : (employee.work_tg ? '****' : null),
          backend_accounts: canViewEmployeeSensitive ? employee.backend_accounts : (employee.backend_accounts ? '****' : null),
          month_error_count: Number(summary?.month_error_count || 0),
          total_error_count: totalErrorCount,
          // Always derive the list grade from the same thresholds used by filtering.
          // This prevents a filtered “重点” row from falling back to “优秀” in the table.
          risk_level: riskKey(totalErrorCount),
          missing_fields: missing,
          missing_count: missing.length,
          account_opened: accountSet.has(employee.id),
          account_active: activeAccountSet.has(employee.id),
          operator_account: operatorMap.get(employee.id) || '',
        }
      }),
      total,
      page,
      page_size: pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      risk_level: risk,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'UNAUTHORIZED') return json({ error: '登录已失效，请重新登录' }, 401)
    if (message === 'FORBIDDEN') return json({ error: '当前账号没有后台访问权限' }, 403)
    console.error(error)
    return json({ error: message || '等级筛选读取失败' }, 500)
  }
})
