import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const text = (value: unknown) => String(value ?? '').trim()
const upper = (value: unknown) => text(value).toUpperCase()
const lower = (value: unknown) => text(value).toLocaleLowerCase('zh-CN')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
})
const riskKey = (value: unknown) => {
  const count = Number(value || 0)
  if (count >= 31) return 'high'
  if (count >= 16) return 'watch'
  if (count >= 9) return 'attention'
  if (count >= 1) return 'normal'
  return 'excellent'
}

function normalizeDate(value: unknown) {
  const source = text(value).split(/[\r\n]+/)[0].trim()
  if (!source) return ''
  const matched = source.match(/(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/)
  if (matched) return `${matched[1]}-${String(Number(matched[2])).padStart(2, '0')}-${String(Number(matched[3])).padStart(2, '0')}`
  const dayFirst = source.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/)
  if (dayFirst) {
    let day = Number(dayFirst[1])
    let month = Number(dayFirst[2])
    if (month > 12 && day <= 12) [day, month] = [month, day]
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${dayFirst[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  const parsed = new Date(source)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
}

function pick(source: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = text(source?.[key])
    if (value) return value
  }
  return ''
}

function between(date: string, from: string, to: string) {
  if (!date) return false
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}

function isoDayOffset(date: string, offset: number) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

function periodCounts(rows: any[]) {
  const today = new Date().toISOString().slice(0, 10)
  const month = today.slice(0, 7)
  const from3 = isoDayOffset(today, -2)
  const from7 = isoDayOffset(today, -6)
  const from30 = isoDayOffset(today, -29)
  const dates = rows.map(row => normalizeDate(row.qc_date)).filter(Boolean)
  return {
    month: dates.filter(date => date.startsWith(month) && date <= today).length,
    last_3d: dates.filter(date => date >= from3 && date <= today).length,
    last_7d: dates.filter(date => date >= from7 && date <= today).length,
    last_30d: dates.filter(date => date >= from30 && date <= today).length,
    total: rows.length,
    as_of: today,
  }
}

function unique(values: unknown[]) {
  return [...new Set((values || []).map(text).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
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

async function loadHistoricalDirectory(service: any, employeeIds: string[]) {
  const directory = new Map<string, any>()
  const ids = unique(employeeIds.map(upper))

  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100)
    const { data, error } = await service
      .from('employee_lifecycle_events')
      .select('employee_no,full_name,event_type,effective_date,created_at,snapshot')
      .in('employee_no', batch)
      .in('event_type', ['resign', 'reactivate', 'join'])
      .order('effective_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw new Error(`历史员工资料读取失败：${error.message}`)

    for (const row of data || []) {
      const employeeId = upper(row.employee_no)
      if (!employeeId || directory.has(employeeId)) continue
      const snapshot = row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {}
      directory.set(employeeId, {
        employee_id: employeeId,
        name: text(row.full_name) || pick(snapshot, ['名字 Name', '姓名', '员工姓名', 'Name']),
        team: pick(snapshot, ['盘口国家', '团队', '團隊', 'team']),
        group: pick(snapshot, ['组别', '組別', 'group']),
        position: pick(snapshot, ['岗位', '崗位', 'Position']),
        country: pick(snapshot, ['国家 country', '国家', '國家', 'Country']),
        shift: pick(snapshot, ['班次', 'Shift']),
        platform: pick(snapshot, ['盘口岗位 Platform position', '盘口', '盤口', 'Platform']),
        status: text(row.event_type) === 'resign' ? 'resigned' : text(row.event_type),
      })
    }
  }

  return directory
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
    const [
      { data: snapshot, error: snapshotError },
      { data: errorChunks, error: chunkError },
      { data: rosterSnapshot },
      { data: employees, error: employeeError },
      { data: teams },
      { data: positions },
      { data: summaries, error: summaryError },
    ] = await Promise.all([
      service.from('report_sheet_snapshots').select('payload,row_count,synced_at,note').eq('source', '效率表/员工错误').maybeSingle(),
      service.from('report_sheet_snapshot_chunks').select('payload,row_count,synced_at,chunk_index').eq('source', '效率表/员工错误').order('chunk_index'),
      service.from('report_sheet_snapshots').select('payload,synced_at').eq('source', '居家排班表/填表').maybeSingle(),
      service.from('employees').select('employee_no,full_name,country,nationality,status,team_id,position_id,shift_name,platform_scope').limit(5000),
      service.from('teams').select('id,name'),
      service.from('positions').select('id,name'),
      service.from('employee_error_summary').select('employee_no,month_error_count,total_error_count,risk_level').limit(5000),
    ])
    if (snapshotError) throw snapshotError
    if (chunkError) throw chunkError
    if (employeeError) throw employeeError
    if (summaryError) throw summaryError

    const chunkRows = Array.isArray(errorChunks) ? errorChunks : []
    const raw = chunkRows.length
      ? chunkRows.flatMap((row: any) => Array.isArray(row.payload) ? row.payload : [])
      : (Array.isArray(snapshot?.payload) ? snapshot.payload : [])
    const sourceRowCount = chunkRows.length
      ? chunkRows.reduce((sum: number, row: any) => sum + Number(row.row_count || 0), 0)
      : Number(snapshot?.row_count || 0)
    const sourceSyncedAt = chunkRows.length
      ? chunkRows.map((row: any) => row.synced_at).filter(Boolean).sort().at(-1) || null
      : snapshot?.synced_at || null
    const roster = Array.isArray(rosterSnapshot?.payload) ? rosterSnapshot.payload : []
    const rosterMap = new Map(roster.map((row: any) => [upper(row.employee_id), row]).filter((entry: any) => entry[0]))
    const employeeMap = new Map((employees || []).map((row: any) => [upper(row.employee_no), row]).filter((entry: any) => entry[0]))
    const teamMap = new Map((teams || []).map((row: any) => [text(row.id), text(row.name)]))
    const positionMap = new Map((positions || []).map((row: any) => [text(row.id), text(row.name)]))
    const summaryMap = new Map((summaries || []).map((row: any) => [upper(row.employee_no), row]))
    const historicalMap = await loadHistoricalDirectory(
      service,
      raw
        .map((row: any) => upper(row.employee_id || row.ID))
        .filter((employeeId: string) => employeeId && !rosterMap.has(employeeId) && !employeeMap.has(employeeId)),
    )
    const historicalRows = [...historicalMap.values()]

    let from = normalizeDate(body.date_from)
    let to = normalizeDate(body.date_to)
    if (from && to && from > to) [from, to] = [to, from]

    const filters = {
      employeeId: upper(body.employee_id),
      employeeName: lower(body.employee_name),
      risk: text(body.risk_level),
      errorType: text(body.error_type),
      qcPerson: text(body.qc_person),
      shift: text(body.shift),
      team: text(body.team),
      group: text(body.group),
      position: text(body.position),
      country: text(body.country),
      manager: lower(body.manager),
      platform: text(body.platform),
    }
    const basis = text(body.date_basis) === 'review' ? 'review' : 'qc'
    const allRows: any[] = []

    for (let index = 0; index < raw.length; index += 1) {
      const source: any = raw[index]
      const employeeId = upper(source.employee_id || source.ID)
      if (!employeeId) continue

      const rosterRow: any = rosterMap.get(employeeId) || null
      const employee: any = employeeMap.get(employeeId) || null
      const historical: any = historicalMap.get(employeeId) || null
      const summary: any = summaryMap.get(employeeId) || null
      const qcDate = normalizeDate(source.qc_date)
      const reviewDate = normalizeDate(source.review_date)
      const basisDate = basis === 'review' ? (reviewDate || qcDate) : qcDate
      const name = text(rosterRow?.name || employee?.full_name || historical?.name) || '-'
      const team = text(rosterRow?.team || teamMap.get(text(employee?.team_id)) || historical?.team) || '-'
      const position = text(rosterRow?.position || positionMap.get(text(employee?.position_id)) || historical?.position) || '-'
      const country = text(rosterRow?.country || employee?.country || employee?.nationality || historical?.country) || '-'
      const shift = text(rosterRow?.shift || employee?.shift_name || historical?.shift) || '-'
      const platform = text(rosterRow?.platform || employee?.platform_scope || historical?.platform) || '-'
      const group = text(rosterRow?.group || historical?.group) || '-'
      const managers = [rosterRow?.responsible, rosterRow?.onsite_trainer, rosterRow?.online_leader, rosterRow?.online_trainer].map(text).filter(Boolean)

      const row = {
        ...source,
        key: text(source.key) || `error-${text(source.source_row) || index + 1}`,
        employee_id: employeeId,
        qc_date: qcDate,
        review_date: reviewDate,
        name,
        team,
        position,
        country,
        shift,
        group,
        platform,
        managers,
        risk_level: riskKey(summary?.total_error_count || 0),
        month_error_count: Number(summary?.month_error_count || 0),
        total_error_count: Number(summary?.total_error_count || 0),
        employee_status: text(employee?.status || historical?.status),
        roster_match: Boolean(rosterRow),
        employee_match: Boolean(employee),
        historical_match: Boolean(historical),
      }

      if ((from || to) && !between(basisDate, from, to)) continue
      if (filters.employeeId && !employeeId.includes(filters.employeeId)) continue
      if (filters.employeeName && !lower(name).includes(filters.employeeName)) continue
      if (filters.risk && row.risk_level !== filters.risk) continue
      if (filters.errorType && text(row.error_type) !== filters.errorType) continue
      if (filters.qcPerson && text(row.qc_person) !== filters.qcPerson) continue
      if (filters.shift && shift !== filters.shift) continue
      if (filters.team && team !== filters.team) continue
      if (filters.group && group !== filters.group) continue
      if (filters.position && position !== filters.position) continue
      if (filters.country && country !== filters.country) continue
      if (filters.platform && platform !== filters.platform) continue
      if (filters.manager && !managers.some(value => lower(value).includes(filters.manager))) continue
      allRows.push(row)
    }

    const sortKey = [
      'employee_id', 'name', 'team', 'position', 'platform', 'error_type', 'score',
      'qc_person', 'qc_date', 'leader_review', 'qc_result', 'review_date',
    ].includes(text(body.sort_key)) ? text(body.sort_key) : 'qc_date'
    const ascending = text(body.sort_dir) === 'asc'
    allRows.sort((a, b) => {
      let compared = 0
      if (sortKey === 'score') compared = Number(a.score || 0) - Number(b.score || 0)
      else compared = text(a[sortKey]).localeCompare(text(b[sortKey]), 'zh-CN', { numeric: true })
      if (compared === 0) compared = Number(a.source_row || 0) - Number(b.source_row || 0)
      return ascending ? compared : -compared
    })

    const pageSizeOptions = [20, 30, 50, 100, 500]
    const requestedSize = Number(body.page_size || 30)
    const pageSize = pageSizeOptions.includes(requestedSize) ? requestedSize : 30
    const total = allRows.length
    const counts = periodCounts(allRows)
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.min(Math.max(1, Number(body.page || 1)), pages)
    const start = (page - 1) * pageSize
    const pageRows = allRows.slice(start, start + pageSize)
    const availableDates = raw.map((row: any) => normalizeDate(row.qc_date)).filter(Boolean).sort()

    return json({
      updated_at: new Date().toISOString(),
      source: chunkRows.length ? 'supabase_error_chunks_server_paged' : 'supabase_error_snapshot_server_paged',
      source_raw_count: sourceRowCount,
      source_normalized_count: raw.length,
      source_synced_at: sourceSyncedAt,
      rows: pageRows,
      total,
      period_counts: counts,
      page,
      page_size: pageSize,
      pages,
      from: from || '',
      to: to || '',
      available_from: availableDates[0] || '',
      available_to: availableDates[availableDates.length - 1] || '',
      options: {
        error_types: unique(raw.map((row: any) => row.error_type)),
        qc_people: unique(raw.map((row: any) => row.qc_person)),
        shifts: unique([...roster.map((row: any) => row.shift), ...historicalRows.map((row: any) => row.shift)]),
        teams: unique([...roster.map((row: any) => row.team), ...historicalRows.map((row: any) => row.team)]),
        groups: unique([...roster.map((row: any) => row.group), ...historicalRows.map((row: any) => row.group)]),
        positions: unique([...roster.map((row: any) => row.position), ...historicalRows.map((row: any) => row.position)]),
        countries: unique([...roster.map((row: any) => row.country), ...historicalRows.map((row: any) => row.country)]),
        managers: unique(roster.flatMap((row: any) => [row.responsible, row.onsite_trainer, row.online_leader, row.online_trainer])),
        platforms: unique([...roster.map((row: any) => row.platform), ...historicalRows.map((row: any) => row.platform)]),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'UNAUTHORIZED') return json({ error: '登录已失效，请重新登录' }, 401)
    if (message === 'FORBIDDEN') return json({ error: '当前账号没有后台访问权限' }, 403)
    console.error(error)
    return json({ error: message || '错误统计读取失败' }, 500)
  }
})
