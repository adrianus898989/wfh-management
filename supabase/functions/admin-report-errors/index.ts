import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const text = (value: unknown) => String(value ?? '').trim()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
})

function normalizeDate(value: unknown) {
  const source = text(value).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(source) ? source : ''
}

async function authorize(req: Request) {
  const auth = req.headers.get('Authorization') || ''
  if (!auth.startsWith('Bearer ')) throw new Error('UNAUTHORIZED')
  const client = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_ANON_KEY') || '',
    { global: { headers: { Authorization: auth } } },
  )
  const { data: { user }, error } = await client.auth.getUser()
  if (error || !user) throw new Error('UNAUTHORIZED')
  const { data: access } = await client.from('user_access')
    .select('backend_enabled,active')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  if (!access?.active || !access?.backend_enabled) throw new Error('FORBIDDEN')
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

  try {
    await authorize(req)
    const service = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      { auth: { persistSession: false } },
    )
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

    const { data: stats, error: statsError } = await service.rpc('report_error_query_stats', {
      p_filters: {
        date_from: from,
        date_to: to,
        date_basis: basis,
        ...filters,
      },
    })
    if (statsError) throw new Error(`错误统计汇总失败：${statsError.message}`)

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
    pageQuery = applyFilters(pageQuery, filters, from, to, basisColumn)
      .order(sortColumn, { ascending, nullsFirst: false })
      .order('source_row', { ascending: false })
      .order('record_key', { ascending: false })
      .range(start, start + pageSize - 1)

    const { data: pageRows, error: pageError } = await pageQuery
    if (pageError) throw new Error(`错误统计明细失败：${pageError.message}`)

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
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'UNAUTHORIZED') return json({ error: '登录已失效，请重新登录' }, 401)
    if (message === 'FORBIDDEN') return json({ error: '当前账号没有后台访问权限' }, 403)
    console.error(error)
    return json({ error: message || '错误统计读取失败' }, 500)
  }
})
