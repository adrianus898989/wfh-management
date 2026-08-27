import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'x-request-id, sb-error-code',
}

const text = (value: unknown) => String(value ?? '').trim()
const upper = (value: unknown) => text(value).toUpperCase()
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, ...headers, 'Content-Type': 'application/json; charset=utf-8' },
})

class ReportRequestError extends Error {
  status: number
  code: string
  stage: string

  constructor(status: number, code: string, stage: string, message: string) {
    super(message)
    this.name = 'ReportRequestError'
    this.status = status
    this.code = code
    this.stage = stage
  }
}

function normalizeDate(value: unknown) {
  const source = text(value).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(source) ? source : ''
}

function jwtSessionId(authorization: string) {
  const token = authorization.slice('Bearer '.length).trim()
  const payload = token.split('.')[1] || ''
  if (!payload) return ''
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const sessionId = text(JSON.parse(atob(padded))?.session_id)
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)
      ? sessionId
      : ''
  } catch {
    return ''
  }
}

async function assertCurrentAdminLease(userId: string, authorization: string) {
  const sessionId = jwtSessionId(authorization)
  if (!sessionId) {
    throw new ReportRequestError(401, 'SESSION_CLAIM_MISSING', 'session', '登录会话无效，请重新登录')
  }

  const service = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { data: lease, error } = await service.from('app_session_leases')
    .select('session_id,portal,lease_expires_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    throw new ReportRequestError(503, 'SESSION_LOOKUP_UNAVAILABLE', 'session', '会话服务暂时不可用，请稍后重试')
  }
  if (
    !lease ||
    lease.session_id !== sessionId ||
    lease.portal !== 'admin' ||
    !lease.lease_expires_at ||
    new Date(lease.lease_expires_at).getTime() <= Date.now()
  ) {
    throw new ReportRequestError(401, 'SESSION_NOT_CURRENT', 'session', '此账号已在其他设备登录或会话已过期，请重新登录')
  }
}

async function authorize(req: Request) {
  const auth = req.headers.get('Authorization') || ''
  if (!auth.startsWith('Bearer ')) {
    throw new ReportRequestError(401, 'AUTH_HEADER_MISSING', 'authorize', '登录凭证缺失，请重新登录')
  }
  const client = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_ANON_KEY') || '',
    { global: { headers: { Authorization: auth } } },
  )
  const { data: { user }, error: userError } = await client.auth.getUser()
  if (userError) {
    const status = Number((userError as any)?.status || 0)
    if (status === 401 || status === 403) {
      throw new ReportRequestError(401, 'AUTH_TOKEN_INVALID', 'authorize', '登录已失效，请重新登录')
    }
    throw new ReportRequestError(503, 'AUTH_SERVICE_UNAVAILABLE', 'authorize', '认证服务暂时不可用，请稍后重试')
  }
  if (!user) throw new ReportRequestError(401, 'AUTH_TOKEN_INVALID', 'authorize', '登录已失效，请重新登录')
  await assertCurrentAdminLease(user.id, auth)
  const service = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { data: access, error: accessError } = await service.from('user_access')
    .select('employee_id,role_id,data_scope,backend_enabled,active')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  if (accessError) {
    throw new ReportRequestError(503, 'ACCESS_LOOKUP_UNAVAILABLE', 'access', '后台权限服务暂时不可用，请稍后重试')
  }
  if (!access?.active || !access?.backend_enabled) {
    throw new ReportRequestError(403, 'BACKEND_ACCESS_DENIED', 'access', '当前账号没有后台访问权限')
  }
  const { data: role, error: roleError } = await service.from('roles')
    .select('code')
    .eq('id', access.role_id)
    .maybeSingle()
  if (roleError) {
    throw new ReportRequestError(503, 'ROLE_LOOKUP_UNAVAILABLE', 'access', '角色权限服务暂时不可用，请稍后重试')
  }
  if (role?.code !== 'founder' && !(await permissionAllowed(service, user.id, access.role_id, 'report.errors.view'))) {
    throw new ReportRequestError(403, 'REPORT_VIEW_DENIED', 'access', '当前账号没有统计报表查看权限')
  }
  const scope = await resolveReportScope(service, user.id, access, text(role?.code))
  return { service, scope }
}

type ReportScope = { mode: 'all' | 'limited', employeeNos: string[] }

async function permissionAllowed(service: any, userId: string, roleId: string, code: string) {
  const { data: permission, error: permissionError } = await service.from('permissions')
    .select('id').eq('code', code).maybeSingle()
  if (permissionError) {
    throw new ReportRequestError(503, 'PERMISSION_LOOKUP_UNAVAILABLE', 'access', '权限服务暂时不可用，请稍后重试')
  }
  if (!permission?.id) return false
  const [{ data: override, error: overrideError }, { data: rolePermission, error: rolePermissionError }] = await Promise.all([
    service.from('user_permission_overrides').select('allowed')
      .eq('auth_user_id', userId).eq('permission_id', permission.id).maybeSingle(),
    service.from('role_permissions').select('role_id')
      .eq('role_id', roleId).eq('permission_id', permission.id).maybeSingle(),
  ])
  if (overrideError || rolePermissionError) {
    throw new ReportRequestError(503, 'PERMISSION_LOOKUP_UNAVAILABLE', 'access', '权限服务暂时不可用，请稍后重试')
  }
  if (override && typeof override.allowed === 'boolean') return override.allowed
  return Boolean(rolePermission)
}

async function employeeNosForIds(service: any, ids: string[]) {
  const rows: any[] = []
  for (let index = 0; index < ids.length; index += 300) {
    const { data, error } = await service.from('employees').select('employee_no')
      .in('id', ids.slice(index, index + 300))
    if (error) throw new ReportRequestError(503, 'SCOPE_LOOKUP_UNAVAILABLE', 'scope', '数据范围服务暂时不可用，请稍后重试')
    rows.push(...(data || []))
  }
  return rows.map((row: any) => upper(row.employee_no)).filter(Boolean)
}

async function employeeNosForTeams(service: any, teamIds: string[]) {
  const rows: any[] = []
  for (let index = 0; index < teamIds.length; index += 200) {
    let offset = 0
    while (offset < 50000) {
      const { data, error } = await service.from('employees').select('employee_no')
        .in('team_id', teamIds.slice(index, index + 200)).range(offset, offset + 999)
      if (error) throw new ReportRequestError(503, 'SCOPE_LOOKUP_UNAVAILABLE', 'scope', '数据范围服务暂时不可用，请稍后重试')
      rows.push(...(data || []))
      if ((data || []).length < 1000) break
      offset += 1000
    }
  }
  return rows.map((row: any) => upper(row.employee_no)).filter(Boolean)
}

async function resolveReportScope(service: any, userId: string, access: any, roleCode: string): Promise<ReportScope> {
  if (roleCode === 'founder' || access.data_scope === 'all') return { mode: 'all', employeeNos: [] }
  if (access.data_scope === 'self') {
    const employeeNos = access.employee_id ? await employeeNosForIds(service, [access.employee_id]) : []
    return { mode: 'limited', employeeNos: [...new Set(employeeNos)] }
  }
  if (access.data_scope === 'own_team') {
    if (!access.employee_id) return { mode: 'limited', employeeNos: [] }
    const { data: employee, error } = await service.from('employees').select('team_id')
      .eq('id', access.employee_id).maybeSingle()
    if (error) throw new ReportRequestError(503, 'SCOPE_LOOKUP_UNAVAILABLE', 'scope', '数据范围服务暂时不可用，请稍后重试')
    const employeeNos = employee?.team_id ? await employeeNosForTeams(service, [employee.team_id]) : []
    return { mode: 'limited', employeeNos: [...new Set(employeeNos)] }
  }
  if (access.data_scope === 'assigned_teams') {
    const [{ data: teams, error: teamError }, { data: employees, error: employeeError }] = await Promise.all([
      service.from('user_scope_teams').select('team_id').eq('auth_user_id', userId),
      service.from('user_scope_employees').select('employee_id').eq('auth_user_id', userId),
    ])
    if (teamError || employeeError) {
      throw new ReportRequestError(503, 'SCOPE_LOOKUP_UNAVAILABLE', 'scope', '数据范围服务暂时不可用，请稍后重试')
    }
    const [teamNos, directNos] = await Promise.all([
      employeeNosForTeams(service, (teams || []).map((row: any) => row.team_id).filter(Boolean)),
      employeeNosForIds(service, (employees || []).map((row: any) => row.employee_id).filter(Boolean)),
    ])
    return { mode: 'limited', employeeNos: [...new Set([...teamNos, ...directNos])] }
  }
  return { mode: 'limited', employeeNos: [] }
}

function applyReportScope(query: any, scope: ReportScope, column = 'employee_id') {
  if (scope.mode === 'all') return query
  return scope.employeeNos.length
    ? query.in(column, scope.employeeNos)
    : query.eq(column, '__NO_AUTHORIZED_EMPLOYEE__')
}

async function loadScopedRows(service: any, table: string, columns: string, scope: ReportScope, scopeColumn: string) {
  const rows: any[] = []
  for (let offset = 0; offset < 50000; offset += 1000) {
    let query = service.from(table).select(columns)
    query = applyReportScope(query, scope, scopeColumn).range(offset, offset + 999)
    const { data, error } = await query
    if (error) throw new ReportRequestError(500, 'ERROR_SCOPE_STATS_FAILED', 'stats', `错误统计范围汇总失败：${error.message}`)
    rows.push(...(data || []))
    if ((data || []).length < 1000) break
  }
  return rows
}

const sortedValues = (values: unknown[]) => [...new Set(values.map(text).filter(value => value && value !== '-'))]
  .sort((a, b) => a.localeCompare(b, 'zh-CN'))

async function scopedStats(service: any, scope: ReportScope, filters: Record<string, string>, from: string, to: string, basisColumn: string) {
  const count = async (qcFrom = '', qcTo = '') => {
    let query = service.from('report_employee_error_admin_v').select('record_key', { count: 'exact', head: true })
    query = applyReportScope(applyFilters(query, filters, from, to, basisColumn), scope)
    if (qcFrom) query = query.gte('qc_date', qcFrom)
    if (qcTo) query = query.lte('qc_date', qcTo)
    const { count, error } = await query
    if (error) throw new ReportRequestError(500, 'ERROR_STATS_QUERY_FAILED', 'stats', `错误统计汇总失败：${error.message}`)
    return Number(count || 0)
  }
  const today = new Date().toISOString().slice(0, 10)
  const day = new Date(`${today}T12:00:00Z`)
  const isoDaysAgo = (days: number) => {
    const value = new Date(day)
    value.setUTCDate(value.getUTCDate() - days)
    return value.toISOString().slice(0, 10)
  }
  const monthStart = `${today.slice(0, 7)}-01`
  const [total, month, last3d, last7d, last30d, rawRows, optionRows] = await Promise.all([
    count(), count(monthStart, today), count(isoDaysAgo(2), today), count(isoDaysAgo(6), today), count(isoDaysAgo(29), today),
    loadScopedRows(service, 'report_employee_error_rows', 'record_key,synced_at,qc_date,error_type,qc_person', scope, 'employee_no'),
    loadScopedRows(service, 'report_employee_error_admin_v', 'shift,team,group_name,position,country,manager_search,platform', scope, 'employee_id'),
  ])
  const qcDates = rawRows.map((row: any) => text(row.qc_date).slice(0, 10)).filter(Boolean).sort()
  const synced = rawRows.map((row: any) => text(row.synced_at)).filter(Boolean).sort()
  return {
    total,
    period_counts: { month, last_3d: last3d, last_7d: last7d, last_30d: last30d, total, as_of: today },
    source_raw_count: rawRows.length,
    source_normalized_count: new Set(rawRows.map((row: any) => text(row.record_key)).filter(Boolean)).size,
    source_synced_at: synced.at(-1) || null,
    available_from: qcDates[0] || '',
    available_to: qcDates.at(-1) || '',
    options: {
      error_types: sortedValues(rawRows.map((row: any) => row.error_type)),
      qc_people: sortedValues(rawRows.map((row: any) => row.qc_person)),
      shifts: sortedValues(optionRows.map((row: any) => row.shift)),
      teams: sortedValues(optionRows.map((row: any) => row.team)),
      groups: sortedValues(optionRows.map((row: any) => row.group_name)),
      positions: sortedValues(optionRows.map((row: any) => row.position)),
      countries: sortedValues(optionRows.map((row: any) => row.country)),
      managers: sortedValues(optionRows.flatMap((row: any) => text(row.manager_search).split('|'))),
      platforms: sortedValues(optionRows.map((row: any) => row.platform)),
    },
  }
}

function applyFilters(query: any, filters: Record<string, string>, from: string, to: string, basisColumn: string) {
  let next = query
  if (from) next = next.gte(basisColumn, from)
  if (to) next = next.lte(basisColumn, to)
  if (filters.employee_id) next = next.ilike('employee_id', `%${filters.employee_id}%`)
  if (filters.employee_name) next = next.ilike('name', `%${filters.employee_name}%`)
  if (filters.employee_status) next = next.eq('employee_status', filters.employee_status)
  if (filters.risk_level) next = next.eq('risk_level', filters.risk_level)
  if (filters.error_type) next = next.eq('error_type', filters.error_type)
  if (filters.qc_person) next = next.eq('qc_person', filters.qc_person)
  if (filters.shift) next = next.eq('shift', filters.shift)
  if (filters.team) next = next.eq('team', filters.team)
  if (filters.group) next = next.eq('group_name', filters.group)
  if (filters.position) next = next.eq('position', filters.position)
  if (filters.country) next = next.eq('country', filters.country)
  if (filters.manager) next = next.ilike('manager_search', `%${filters.manager}%`)
  if (filters.platform) next = next.eq('platform', filters.platform)
  return next
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: '仅支持 POST 请求' }, 405)

  const requestId = crypto.randomUUID()

  try {
    const { service, scope } = await authorize(req)
    const body = await req.json().catch(() => ({}))
    let from = normalizeDate(body.date_from)
    let to = normalizeDate(body.date_to)
    if (from && to && from > to) [from, to] = [to, from]

    const filters = {
      employee_id: text(body.employee_id).toUpperCase(),
      employee_name: text(body.employee_name),
      employee_status: text(body.employee_status),
      risk_level: text(body.risk_level),
      error_type: text(body.error_type),
      qc_person: text(body.qc_person),
      shift: text(body.shift),
      team: text(body.team),
      group: text(body.group),
      position: text(body.position),
      country: text(body.country),
      manager: text(body.manager),
      platform: text(body.platform),
    }
    const basis = text(body.date_basis) === 'review' ? 'review' : 'qc'
    const basisColumn = basis === 'review' ? 'review_basis_date' : 'qc_date'

    let stats: any
    if (scope.mode === 'all') {
      const { data, error } = await service.rpc('report_error_query_stats', {
        p_filters: {
          date_from: from,
          date_to: to,
          date_basis: basis,
          ...filters,
        },
      })
      if (error) {
        throw new ReportRequestError(500, 'ERROR_STATS_QUERY_FAILED', 'stats', `错误统计汇总失败：${error.message}`)
      }
      stats = data || {}
    } else {
      stats = await scopedStats(service, scope, filters, from, to, basisColumn)
    }

    const pageSizeOptions = [20, 30, 50, 100, 500]
    const requestedSize = Number(body.page_size || 30)
    const pageSize = pageSizeOptions.includes(requestedSize) ? requestedSize : 30
    const total = Number(stats?.total || 0)
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.min(Math.max(1, Number(body.page || 1)), pages)

    const sortMap: Record<string, string> = {
      employee_id: 'employee_id',
      name: 'name',
      employee_status: 'employee_status',
      team: 'team',
      position: 'position',
      platform: 'platform',
      error_type: 'error_type',
      score: 'score_value',
      qc_person: 'qc_person',
      qc_date: 'qc_date',
      leader_review: 'leader_review',
      qc_result: 'qc_result',
      review_date: 'review_date',
    }
    const sortColumn = sortMap[text(body.sort_key)] || 'qc_date'
    const ascending = text(body.sort_dir) === 'asc'
    const start = (page - 1) * pageSize

    let pageQuery = service.from('report_employee_error_admin_v').select('*')
    pageQuery = applyReportScope(applyFilters(pageQuery, filters, from, to, basisColumn), scope)
      .order(sortColumn, { ascending, nullsFirst: false })
      .order('source_row', { ascending: false })
      .order('record_key', { ascending: false })
      .range(start, start + pageSize - 1)

    const { data: pageRows, error: pageError } = await pageQuery
    if (pageError) {
      throw new ReportRequestError(500, 'ERROR_ROWS_QUERY_FAILED', 'rows', `错误统计明细失败：${pageError.message}`)
    }

    const rows = (pageRows || []).map((row: any) => ({
      ...row,
      key: `error-${row.record_key || row.source_row}`,
      group: row.group_name,
    }))

    return json({
      updated_at: new Date().toISOString(),
      source: 'supabase_error_rows_database_paged',
      source_raw_count: Number(stats?.source_raw_count || 0),
      source_normalized_count: Number(stats?.source_normalized_count || 0),
      source_synced_at: stats?.source_synced_at || null,
      rows,
      total,
      period_counts: stats?.period_counts || {},
      page,
      page_size: pageSize,
      pages,
      from,
      to,
      available_from: stats?.available_from || '',
      available_to: stats?.available_to || '',
      options: stats?.options || {},
      request_id: requestId,
    })
  } catch (error) {
    const known = error instanceof ReportRequestError
    const status = known ? error.status : 500
    const code = known ? error.code : 'ERROR_REPORT_UNEXPECTED'
    const stage = known ? error.stage : 'unexpected'
    const message = error instanceof Error ? error.message : String(error)
    console.error(JSON.stringify({ request_id: requestId, status, code, stage, message }))
    return json(
      { error: message || '错误统计读取失败', code, stage, request_id: requestId },
      status,
      { 'x-request-id': requestId, 'sb-error-code': code },
    )
  }
})
