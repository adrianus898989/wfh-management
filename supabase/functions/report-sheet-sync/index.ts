import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ROSTER_URL = 'https://opensheet.elk.sh/1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA/填表'
const ACCOUNT_URL = 'https://opensheet.elk.sh/1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA/账号'
const MISTAKE_URL = 'https://opensheet.vercel.app/1TEp-YzwjFKjorR4Xpmrb6UiKq2maMmawIW6oYQI75qM/员工错误'
const EFF_ID = '1TEp-YzwjFKjorR4Xpmrb6UiKq2maMmawIW6oYQI75qM'
const FETCH_TIMEOUT_MS = 25_000

const text = (value: unknown) => String(value ?? '').trim()
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'connection': 'keep-alive',
  },
})

function pick(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = text(row?.[key])
    if (value) return value
  }
  return ''
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`fetch ${response.status}`)
  const parsed = JSON.parse(body)
  if (!Array.isArray(parsed)) throw new Error('source is not array')
  return parsed
}

function csvParse(input: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"'
        index += 1
        continue
      }
      if (char === '"') {
        quoted = false
        continue
      }
      cell += char
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ',') {
      row.push(cell)
      cell = ''
      continue
    }
    if (char === '\n') {
      row.push(cell.replace(/\r$/, ''))
      rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += char
  }

  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ''))
    rows.push(row)
  }
  return rows
}

async function latestCsv(sheet: string, column: string) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${EFF_ID}/gviz/tq`)
  url.searchParams.set('tqx', 'out:csv')
  url.searchParams.set('sheet', sheet)
  url.searchParams.set('tq', `select ${column} order by ${column} desc limit 1`)
  const response = await fetch(url.toString(), {
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const body = await response.text()
  if (!response.ok) return ''
  const rows = csvParse(body)
  return text(rows?.[1]?.[0] || rows?.[0]?.[0])
}

function normalizeDate(value: unknown) {
  let dateText = text(value)
  if (!dateText) return ''
  dateText = dateText.split(/[\r\n]+/)[0].trim()

  if (/^\d{5}(\.\d+)?$/.test(dateText)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(dateText)) * 86_400_000)
    return date.toISOString().slice(0, 10)
  }

  let match = dateText.match(/(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/)
  if (match) {
    return `${match[1]}-${String(+match[2]).padStart(2, '0')}-${String(+match[3]).padStart(2, '0')}`
  }

  match = dateText.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/)
  if (match) {
    const first = +match[1]
    const second = +match[2]
    const day = first > 12 ? first : second > 12 ? second : first
    const month = first > 12 ? second : first
    return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const date = new Date(dateText)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

function scoreNumber(value: unknown) {
  const match = text(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : 0
}

function riskLevel(monthErrorCount: number) {
  if (monthErrorCount >= 31) return 'high'
  if (monthErrorCount >= 16) return 'watch'
  if (monthErrorCount >= 9) return 'attention'
  if (monthErrorCount >= 1) return 'normal'
  return 'excellent'
}

function hash32(input: string) {
  let hash = 2_166_136_261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(36)
}

function payloadHash(payload: unknown) {
  return hash32(JSON.stringify(payload))
}

function noteHash(note: unknown) {
  return text(note).match(/(?:^|;)hash:([a-z0-9]+)(?:;|$)/i)?.[1] || ''
}

function normalizeErrors(rawErrors: Record<string, unknown>[]) {
  return rawErrors.map((row, index) => {
    const employeeId = pick(row, ['ID']).toUpperCase()
    const memberOrder = pick(row, ['会员/id /订单号', '會員/id /訂單號'])
    const errorNote = pick(row, ['错误备注', '錯誤備註'])
    const errorType = pick(row, ['错误类型', '錯誤類型'])
    const qcPerson = pick(row, ['质检人', '質檢人'])
    const qcDate = normalizeDate(pick(row, ['质检时间', '質檢時間']))
    const recordKey = `${employeeId}|${qcDate}|${hash32([memberOrder, errorType, qcPerson, errorNote].join('|'))}`

    return {
      record_key: recordKey,
      source_row: index + 2,
      employee_id: employeeId,
      member_order: memberOrder,
      amount: pick(row, ['金额', '金額']),
      error_note: errorNote,
      correct_action: pick(row, ['正确操作方式', '正確操作方式']),
      error_type: errorType,
      score: pick(row, ['扣分']),
      qc_person: qcPerson,
      qc_date: qcDate,
      leader_review: pick(row, ['小组长复审', '小組長複審']),
      qc_result: pick(row, ['质检人对错', '质检人对/错', '質檢人對錯']),
      review_date: normalizeDate(pick(row, ['复检时间', '複檢時間'])),
    }
  }).filter((row) => row.employee_id && (
    row.qc_date || row.review_date || row.error_type || row.error_note
  ))
}

function buildRiskSummaries(errors: ReturnType<typeof normalizeErrors>) {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const monthKey = today.slice(0, 7)
  const cut30 = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 29,
  )).toISOString().slice(0, 10)
  const summaries = new Map<string, any>()

  for (const errorRow of errors) {
    let summary = summaries.get(errorRow.employee_id)
    if (!summary) {
      summary = {
        employee_no: errorRow.employee_id,
        month_key: monthKey,
        month_error_count: 0,
        last_30d_error_count: 0,
        total_error_count: 0,
        total_deduct: 0,
        last_error_date: null,
        main_error_type: null,
        risk_level: 'excellent',
        types: new Map<string, number>(),
      }
      summaries.set(errorRow.employee_id, summary)
    }

    summary.total_error_count += 1
    summary.total_deduct += scoreNumber(errorRow.score)
    const errorDate = errorRow.qc_date || errorRow.review_date || ''
    if (errorDate && errorDate.slice(0, 7) === monthKey) summary.month_error_count += 1
    if (errorDate && errorDate >= cut30 && errorDate <= today) summary.last_30d_error_count += 1
    if (errorDate && (!summary.last_error_date || errorDate > summary.last_error_date)) {
      summary.last_error_date = errorDate
    }
    if (errorRow.error_type) {
      summary.types.set(errorRow.error_type, (summary.types.get(errorRow.error_type) || 0) + 1)
    }
  }

  return [...summaries.values()].map((summary) => {
    let topType = ''
    let topCount = -1
    for (const [type, count] of summary.types) {
      if (count > topCount) {
        topType = type
        topCount = count
      }
    }
    delete summary.types
    summary.main_error_type = topType || null
    summary.risk_level = riskLevel(summary.month_error_count)
    summary.total_deduct = Number(summary.total_deduct.toFixed(2))
    return summary
  })
}

async function loadSnapshotStates(service: any) {
  const { data, error } = await service
    .from('report_sheet_snapshots')
    .select('source,note,row_count,payload')
    .in('source', [
      '居家排班表/填表',
      '居家排班表/账号',
      '效率表/员工错误',
      '效率表/网站数据状态',
      '效率表/员工错误状态',
    ])
  if (error) throw new Error(`snapshot states: ${error.message}`)
  return new Map((data || []).map((row: any) => [row.source, row]))
}

async function writeSnapshot(
  service: any,
  states: Map<string, any>,
  source: string,
  payload: unknown[],
  note: string,
  rowCount = payload.length,
) {
  const hash = payloadHash(payload)
  const fullNote = `${note};hash:${hash}`
  const existing = states.get(source)
  const existingHash = noteHash(existing?.note) || (existing?.payload ? payloadHash(existing.payload) : '')
  const now = new Date().toISOString()

  if (existing && existingHash === hash) {
    const { error } = await service
      .from('report_sheet_snapshots')
      .update({ synced_at: now, note: fullNote, row_count: rowCount })
      .eq('source', source)
    if (error) throw new Error(`${source}: ${error.message}`)
    return { source, changed: false, rows: rowCount }
  }

  const { error } = await service.from('report_sheet_snapshots').upsert({
    source,
    payload,
    row_count: rowCount,
    synced_at: now,
    note: fullNote,
  }, { onConflict: 'source' })
  if (error) throw new Error(`${source}: ${error.message}`)
  return { source, changed: true, rows: rowCount }
}

async function loadAllSummaries(service: any) {
  const rows: any[] = []
  const pageSize = 1_000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await service
      .from('employee_error_summary')
      .select('employee_no,month_key,month_error_count,last_30d_error_count,total_error_count,total_deduct,last_error_date,main_error_type,risk_level')
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`read error summary: ${error.message}`)
    const page = data || []
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return rows
}

function summaryChanged(next: any, current: any) {
  if (!current) return true
  const numericFields = [
    'month_error_count',
    'last_30d_error_count',
    'total_error_count',
    'total_deduct',
  ]
  const textFields = [
    'month_key',
    'last_error_date',
    'main_error_type',
    'risk_level',
  ]
  return numericFields.some((field) => Number(next[field] || 0) !== Number(current[field] || 0)) ||
    textFields.some((field) => text(next[field]) !== text(current[field]))
}

async function syncChangedSummaries(service: any, summaries: any[]) {
  const currentRows = await loadAllSummaries(service)
  const currentByEmployee = new Map(currentRows.map((row) => [text(row.employee_no).toUpperCase(), row]))
  const updatedAt = new Date().toISOString()
  const changedRows = summaries
    .filter((summary) => summaryChanged(summary, currentByEmployee.get(summary.employee_no)))
    .map((summary) => ({ ...summary, updated_at: updatedAt }))

  for (let index = 0; index < changedRows.length; index += 250) {
    const { error } = await service
      .from('employee_error_summary')
      .upsert(changedRows.slice(index, index + 250), { onConflict: 'employee_no' })
    if (error) throw new Error(`error summary: ${error.message}`)
  }
  return changedRows.length
}

Deno.serve(async (request) => {
  const startedAt = Date.now()
  try {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return json({ error: 'method' }, 405)
    }

    const service = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    )

    const [rawRoster, rawAccounts, rawErrors, latestOrders] = await Promise.all([
      fetchJson(ROSTER_URL),
      fetchJson(ACCOUNT_URL),
      fetchJson(MISTAKE_URL),
      latestCsv('网站数据', 'A'),
    ])

    const roster = rawRoster.map((row: Record<string, unknown>, index: number) => ({
      source_row: index + 2,
      responsible: pick(row, ['负责人', '負責人']),
      onsite_trainer: pick(row, ['现场培训', '現場培訓']),
      online_leader: pick(row, ['线上组长', '線上組長', '组长', '組長']),
      online_trainer: pick(row, ['线上培训', '線上培訓']),
      group: pick(row, ['组别', '組別']),
      team: pick(row, ['团队', '團隊']),
      name: pick(row, ['姓名', '员工姓名', '員工姓名', 'Name']),
      employee_id: pick(row, ['ID', '员工ID', '員工ID']).toUpperCase(),
      shift: pick(row, ['班次', 'Shift']),
      country: pick(row, ['国家', '國家', 'Country']),
      position: pick(row, ['岗位', '崗位', 'Position']),
      platform: pick(row, ['盘口', '盤口', 'ID WORKFOLIO', 'Workfolio']),
      work_content: pick(row, ['工作内容', '工作內容', 'Work Content', 'Job Content']),
    })).filter((row: any) => row.name && !['null', 'undefined'].includes(row.name.toLowerCase()))

    const accounts = rawAccounts.map((row: Record<string, unknown>, index: number) => ({
      source_row: index + 2,
      employee_id: pick(row, ['ID', '员工ID', '員工ID']).toUpperCase(),
      backend_accounts: pick(row, ['后台账号', '後台賬號']),
      hire_date: normalizeDate(pick(row, ['入职时间', '入職時間', 'Join Date'])),
    })).filter((row: any) => row.employee_id && row.employee_id !== 'ID')

    const errors = normalizeErrors(rawErrors)
    const summaries = buildRiskSummaries(errors)
    const latestErrors = errors
      .map((row) => row.qc_date || row.review_date || '')
      .filter(Boolean)
      .sort()
      .at(-1) || ''

    const states = await loadSnapshotStates(service)
    const summaryChanges = await syncChangedSummaries(service, summaries)
    const snapshotPlans: Array<[string, unknown[], string, number?]> = [
      [
        '居家排班表/填表',
        roster,
        '按源表变化同步；姓名有效即纳入，不依赖居家员工名单',
      ],
      [
        '居家排班表/账号',
        accounts,
        '按源表变化同步；用于效率后台账号映射',
      ],
      [
        '效率表/网站数据状态',
        [{ latest_date: latestOrders }],
        '检查网站数据最新日期；完整统计按需读取原版数据源',
      ],
      [
        '效率表/员工错误状态',
        [{ latest_date: latestErrors, summary_employees: summaries.length }],
        '同步错误快照与风险汇总；不再重复写入未使用的完整审计表',
        rawErrors.length,
      ],
      [
        '效率表/员工错误',
        errors,
        '按源表变化同步完整员工错误明细；源表异常时保留最近一次完整数据',
        rawErrors.length,
      ],
    ]
    const snapshotResults = []
    for (const [source, payload, note, rowCount] of snapshotPlans) {
      snapshotResults.push(await writeSnapshot(service, states, source, payload, note, rowCount))
    }

    return json({
      ok: true,
      roster_raw: rawRoster.length,
      roster_rows: roster.length,
      account_rows: accounts.length,
      error_rows: rawErrors.length,
      error_summary: summaries.length,
      summary_changes: summaryChanges,
      snapshot_changes: snapshotResults.filter((result) => result.changed).map((result) => result.source),
      latest_orders: latestOrders,
      latest_errors: latestErrors,
      duration_ms: Date.now() - startedAt,
      at: new Date().toISOString(),
    })
  } catch (error) {
    console.error(error)
    return json({
      error: error instanceof Error ? error.message : JSON.stringify(error),
      duration_ms: Date.now() - startedAt,
    }, 500)
  }
})
