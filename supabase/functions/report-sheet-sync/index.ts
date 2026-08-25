import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Reuse the existing project cron secret. The raw value stays in Supabase
// Vault; only its SHA-256 digest is committed here.
const CRON_TOKEN_HASH = '988aa6dfb0151861cb16ed2e197ee137cff51cd2625e6c85c24cf04696f08a56'

// The private roster/account sheets are pushed by their source-bound Apps
// Script. This scheduled function must never fetch a public proxy or write
// those snapshots, otherwise an older cached response can replace fresh data.
const ERROR_SOURCES = [
  {
    name: '效率表/员工错误',
    url: 'https://opensheet.elk.sh/1TEp-YzwjFKjorR4Xpmrb6UiKq2maMmawIW6oYQI75qM/员工错误',
  },
  {
    name: '财务质检错误记录/财务质检错误记录',
    url: 'https://opensheet.elk.sh/125rN-PXjjWMe4SnYjruGlQ_NdZUb5hI7dXUUBjqe7bY/财务质检错误记录',
  },
] as const
const EFF_ID = '1TEp-YzwjFKjorR4Xpmrb6UiKq2maMmawIW6oYQI75qM'
const ORDER_SHEETS = ['工作表4', '填表']
const ORDER_CHUNK_SIZE = 5_000
const ERROR_CHUNK_SIZE = 500
const FETCH_TIMEOUT_MS = 25_000

const text = (value: unknown) => String(value ?? '').trim()
const MANILA_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'connection': 'keep-alive',
  },
})

function manilaDateKey(value = new Date()) {
  const parts: Record<string, string> = {}
  for (const part of MANILA_DATE_FORMATTER.formatToParts(value)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return `${parts.year}-${parts.month}-${parts.day}`
}

function addIsoDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function secureEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

function pick(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = text(row?.[key])
    if (value) return value
  }
  return ''
}

function normalizeEmployeeId(value: unknown) {
  return text(value)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[-–—]+$/, '')
}

async function fetchJson(url: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`fetch ${response.status} ${new URL(url).host}`)
  const parsed = JSON.parse(body)
  if (!Array.isArray(parsed)) throw new Error('source is not array')
  if (!parsed.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    throw new Error('source contains invalid rows')
  }
  return parsed as Record<string, unknown>[]
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

function orderCsvUrl(sheet: string) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${EFF_ID}/gviz/tq`)
  url.searchParams.set('tqx', 'out:csv')
  url.searchParams.set('sheet', sheet)
  url.searchParams.set('range', 'A:D')
  return url.toString()
}

async function fetchOrderCsv(sheet: string) {
  const response = await fetch(orderCsvUrl(sheet), {
    cache: 'no-store',
    signal: AbortSignal.timeout(70_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`效率表「${sheet}」读取失败 ${response.status}`)
  if (!body || /^\s*</.test(body)) throw new Error(`效率表「${sheet}」返回格式异常`)
  return body
}

function eachCsvRow(raw: string, visit: (row: string[], rowNumber: number) => void) {
  let row: string[] = []
  let cell = ''
  let quoted = false
  let rowNumber = 1
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quoted) {
      if (char === '"') {
        if (raw[index + 1] === '"') {
          cell += '"'
          index += 1
        } else quoted = false
      } else cell += char
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
      visit(row, rowNumber)
      rowNumber += 1
      row = []
      cell = ''
      continue
    }
    cell += char
  }
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ''))
    visit(row, rowNumber)
  }
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
    let day = +match[1]
    let month = +match[2]
    if (month > 12 && day <= 12) [day, month] = [month, day]
    if (day < 1 || day > 31 || month < 1 || month > 12) return ''
    return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const date = new Date(dateText)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

function scoreNumber(value: unknown) {
  const match = text(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : 0
}

function riskLevel(totalErrorCount: number) {
  if (totalErrorCount >= 31) return 'high'
  if (totalErrorCount >= 16) return 'watch'
  if (totalErrorCount >= 9) return 'attention'
  if (totalErrorCount >= 1) return 'normal'
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

function noteValue(note: unknown, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text(note).match(new RegExp(`(?:^|;)${escapedKey}:([^;]+)(?:;|$)`, 'i'))?.[1] || ''
}

function normalizeErrors(rawErrors: Record<string, unknown>[], sourceName: string) {
  return rawErrors.map((row, index) => {
    const employeeId = normalizeEmployeeId(pick(row, ['员工ID', '員工ID', 'ID']))
    const memberOrder = pick(row, ['会员/id /订单号', '會員/id /訂單號'])
    const errorNote = pick(row, ['错误备注', '錯誤備註'])
    const errorType = pick(row, ['错误类型', '錯誤類型'])
    const qcPerson = pick(row, ['质检人', '質檢人'])
    const qcDate = normalizeDate(pick(row, ['质检时间', '質檢時間']))
    const recordKey = `${employeeId}|${qcDate}|${hash32([memberOrder, errorType, qcPerson, errorNote].join('|'))}`

    return {
      source_name: sourceName,
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

function buildRiskSummaries(
  errors: ReturnType<typeof normalizeErrors>,
  now = new Date(),
) {
  const today = manilaDateKey(now)
  const monthKey = today.slice(0, 7)
  const cut30 = addIsoDays(today, -29)
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
    summary.risk_level = riskLevel(summary.total_error_count)
    summary.total_deduct = Number(summary.total_deduct.toFixed(2))
    return summary
  })
}

type SnapshotState = {
  source: string
  note: string | null
  row_count: number | null
}

async function loadSnapshotStates(service: any): Promise<Map<string, SnapshotState>> {
  const { data, error } = await service
    .from('report_sheet_snapshots')
    .select('source,note,row_count')
    .in('source', [
      '居家排班表/填表',
      '居家排班表/账号',
      '效率表/网站数据状态',
      '效率表/订单处理',
      '效率表/员工错误状态',
    ])
  if (error) throw new Error(`snapshot states: ${error.message}`)
  return new Map<string, SnapshotState>((data || []).map(
    (row: any): [string, SnapshotState] => [row.source, row],
  ))
}

async function loadErrorStatusPayload(service: any) {
  const { data, error } = await service
    .from('report_sheet_snapshots')
    .select('payload')
    .eq('source', '效率表/员工错误状态')
    .maybeSingle()
  if (error) throw new Error(`error status payload: ${error.message}`)
  return Array.isArray(data?.payload) && data.payload[0] && typeof data.payload[0] === 'object'
    ? data.payload[0]
    : {}
}

async function loadErrorDetailGeneration(service: any) {
  const chunks: Array<{ source_name: string, chunk_index: number, content_hash: string }> = []
  const pageSize = 1_000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await service
      .from('report_error_sync_chunks')
      .select('source_name,chunk_index,content_hash')
      .order('source_name')
      .order('chunk_index')
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`错误明细版本读取失败: ${error.message}`)
    const page = data || []
    chunks.push(...page.map((row: any) => ({
      source_name: text(row.source_name),
      chunk_index: Number(row.chunk_index),
      content_hash: text(row.content_hash),
    })))
    if (page.length < pageSize) break
  }
  // This generation is derived from durable database state after all detail
  // writes/finalization. If a request dies before the summary marker is saved,
  // the next run still sees a generation mismatch and repairs the summary.
  return sha256(JSON.stringify(chunks))
}

async function writeChunkedSnapshot(
  service: any,
  source: string,
  payload: unknown[],
  chunkSize = 500,
) {
  const { data: currentRows, error: stateError } = await service
    .from('report_sheet_snapshot_chunks')
    .select('chunk_index,content_hash')
    .eq('source', source)
  if (stateError) throw new Error(`chunk states: ${stateError.message}`)

  const current = new Map<number, string>((currentRows || []).map(
    (row: any): [number, string] => [Number(row.chunk_index), text(row.content_hash)],
  ))
  const chunks: unknown[][] = []
  for (let index = 0; index < payload.length; index += chunkSize) {
    chunks.push(payload.slice(index, index + chunkSize))
  }

  let changedChunks = 0
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex]
    const contentHash = payloadHash(chunk)
    if (current.get(chunkIndex) === contentHash) continue
    const { error } = await service.from('report_sheet_snapshot_chunks').upsert({
      source,
      chunk_index: chunkIndex,
      payload: chunk,
      row_count: chunk.length,
      content_hash: contentHash,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'source,chunk_index' })
    if (error) throw new Error(`error chunk ${chunkIndex}: ${error.message}`)
    changedChunks += 1
  }

  if ([...current.keys()].some((chunkIndex) => chunkIndex >= chunks.length)) {
    const { error } = await service
      .from('report_sheet_snapshot_chunks')
      .delete()
      .eq('source', source)
      .gte('chunk_index', chunks.length)
    if (error) throw new Error(`delete stale chunks: ${error.message}`)
  }

  return {
    chunks: chunks.length,
    changed_chunks: changedChunks,
    rows: payload.length,
  }
}

async function writeSnapshot(
  service: any,
  states: ReadonlyMap<string, SnapshotState>,
  source: string,
  payload: unknown[],
  note: string,
  rowCount = payload.length,
) {
  const hash = payloadHash(payload)
  const fullNote = `${note};hash:${hash}`
  const existing = states.get(source)
  const existingHash = noteHash(existing?.note)
  const now = new Date().toISOString()

  if (existing && existingHash === hash) {
    const { error } = await service
      .from('report_sheet_snapshots')
      .update({ synced_at: now })
      .eq('source', source)
    if (error) throw new Error(`${source} heartbeat: ${error.message}`)
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

async function syncErrorRows(service: any, sourceName: string, payload: any[]) {
  const { data: currentRows, error: stateError } = await service
    .from('report_error_sync_chunks')
    .select('chunk_index,content_hash')
    .eq('source_name', sourceName)
  if (stateError) throw new Error(`错误明细同步状态读取失败: ${stateError.message}`)

  const current = new Map((currentRows || []).map((row: any) => [
    Number(row.chunk_index),
    text(row.content_hash),
  ]))
  const chunks: any[][] = []
  for (let index = 0; index < payload.length; index += ERROR_CHUNK_SIZE) {
    chunks.push(payload.slice(index, index + ERROR_CHUNK_SIZE))
  }

  const changes = chunks
    .map((rows, chunkIndex) => ({ rows, chunkIndex, hash: payloadHash(rows) }))
    .filter(change => current.get(change.chunkIndex) !== change.hash)

  for (let index = 0; index < changes.length; index += 4) {
    await Promise.all(changes.slice(index, index + 4).map(async change => {
      const { error } = await service.rpc('sync_report_employee_error_chunk', {
        p_source_name: sourceName,
        p_chunk_index: change.chunkIndex,
        p_chunk_size: ERROR_CHUNK_SIZE,
        p_content_hash: change.hash,
        p_rows: change.rows,
      })
      if (error) throw new Error(`错误明细同步 #${change.chunkIndex}: ${error.message}`)
    }))
  }

  const { data: finalized, error: finalizeError } = await service
    .rpc('finalize_report_employee_error_sync', {
      p_source_name: sourceName,
      p_chunk_count: chunks.length,
    })
  if (finalizeError) throw new Error(`错误明细同步收尾失败: ${finalizeError.message}`)

  return {
    source: sourceName,
    rows: payload.length,
    chunks: chunks.length,
    changed_chunks: changes.length,
    deleted_rows: Number(finalized?.deleted_rows || 0),
  }
}

async function loadAllSummaries(service: any) {
  const rows: any[] = []
  const pageSize = 1_000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await service
      .from('employee_error_summary')
      .select('employee_no,month_key,month_error_count,last_30d_error_count,total_error_count,total_deduct,last_error_date,main_error_type,risk_level')
      .order('employee_no')
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`read error summary: ${error.message}`)
    const page = data || []
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return rows
}

async function loadAllSyncedErrors(service: any) {
  const rows: any[] = []
  const pageSize = 1_000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await service
      .from('report_employee_errors_v')
      .select('record_key,employee_no,error_type,score,qc_date,review_date')
      .order('record_key')
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`read synced errors: ${error.message}`)
    const page = data || []
    rows.push(...page.map((row: any) => ({
      ...row,
      employee_id: normalizeEmployeeId(row.employee_no),
      qc_date: text(row.qc_date),
      review_date: text(row.review_date),
    })))
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
  const nextEmployees = new Set(summaries.map((summary) => text(summary.employee_no).toUpperCase()))
  const updatedAt = new Date().toISOString()
  const changedRows = summaries
    .filter((summary) => summaryChanged(
      summary,
      currentByEmployee.get(text(summary.employee_no).toUpperCase()),
    ))
    .map((summary) => ({ ...summary, updated_at: updatedAt }))
  const monthKey = manilaDateKey(new Date(updatedAt)).slice(0, 7)
  const clearedRows = currentRows
    .filter((row) => {
      const employeeNo = text(row.employee_no).toUpperCase()
      if (!employeeNo || nextEmployees.has(employeeNo)) return false
      return summaryChanged({
        employee_no: employeeNo,
        month_key: monthKey,
        month_error_count: 0,
        last_30d_error_count: 0,
        total_error_count: 0,
        total_deduct: 0,
        last_error_date: null,
        main_error_type: null,
        risk_level: 'excellent',
      }, row)
    })
    .map((row) => ({
      employee_no: text(row.employee_no).toUpperCase(),
      month_key: monthKey,
      month_error_count: 0,
      last_30d_error_count: 0,
      total_error_count: 0,
      total_deduct: 0,
      last_error_date: null,
      main_error_type: null,
      risk_level: 'excellent',
      updated_at: updatedAt,
    }))
  const rowsToUpsert = [...changedRows, ...clearedRows]

  for (let index = 0; index < rowsToUpsert.length; index += 250) {
    const { error } = await service
      .from('employee_error_summary')
      .upsert(rowsToUpsert.slice(index, index + 250), { onConflict: 'employee_no' })
    if (error) throw new Error(`error summary: ${error.message}`)
  }
  return rowsToUpsert.length
}

function orderRowsFromCsv(raw: string) {
  const chunks = new Map<number, any[]>()
  let sourceRows = 0
  let validRows = 0
  let latestDate = ''
  eachCsvRow(raw, (cells, rowNumber) => {
    if (rowNumber === 1) return
    sourceRows = Math.max(sourceRows, rowNumber - 1)
    const workDate = normalizeDate(cells[0])
    const account = text(cells[1]).toLowerCase()
    if (!workDate || !account) return
    const processed = Math.max(0, Math.trunc(scoreNumber(cells[2])))
    const rejected = Math.max(0, Math.trunc(scoreNumber(cells[3])))
    const chunkIndex = Math.floor((rowNumber - 2) / ORDER_CHUNK_SIZE)
    if (!chunks.has(chunkIndex)) chunks.set(chunkIndex, [])
    chunks.get(chunkIndex)!.push({
      source_row: rowNumber,
      work_date: workDate,
      account,
      processed,
      rejected,
      content_hash: hash32(`${workDate}|${account}|${processed}|${rejected}`),
    })
    validRows += 1
    if (!latestDate || workDate > latestDate) latestDate = workDate
  })
  return { chunks, sourceRows, validRows, latestDate }
}

async function syncOrderSheets(service: any) {
  const { data: existingRows, error: existingError } = await service
    .from('report_order_sync_chunks')
    .select('source_sheet,chunk_index,content_hash')
  if (existingError) throw new Error(`订单同步状态读取失败: ${existingError.message}`)
  const existing = new Map((existingRows || []).map((row: any) => [
    `${text(row.source_sheet)}|${Number(row.chunk_index)}`,
    text(row.content_hash),
  ]))
  const results: any[] = []
  let latestDate = ''
  let totalRows = 0
  let changedChunks = 0

  for (const sourceSheet of ORDER_SHEETS) {
    const parsed = orderRowsFromCsv(await fetchOrderCsv(sourceSheet))
    latestDate = parsed.latestDate > latestDate ? parsed.latestDate : latestDate
    totalRows += parsed.validRows
    const chunkCount = Math.ceil(parsed.sourceRows / ORDER_CHUNK_SIZE)
    const changes: Array<{ chunkIndex: number, hash: string, rows: any[] }> = []
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const rows = parsed.chunks.get(chunkIndex) || []
      const hash = payloadHash(rows)
      if (existing.get(`${sourceSheet}|${chunkIndex}`) !== hash) {
        changes.push({ chunkIndex, hash, rows })
      }
    }
    // If Google physically shrinks, chunks above the new end no longer appear
    // in the CSV. Explicitly send an empty replacement once, otherwise their
    // old report_order_rows (and account totals) would remain indefinitely.
    for (const row of existingRows || []) {
      if (text(row.source_sheet) !== sourceSheet) continue
      const chunkIndex = Number(row.chunk_index)
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < chunkCount) continue
      const rows: any[] = []
      const hash = payloadHash(rows)
      if (existing.get(`${sourceSheet}|${chunkIndex}`) !== hash) {
        changes.push({ chunkIndex, hash, rows })
      }
    }
    changes.sort((left, right) => left.chunkIndex - right.chunkIndex)

    // A single account can occur in several chunks. Process chunks in order so
    // their cache refreshes cannot race each other (the RPC also takes a DB lock
    // as a second line of defence against overlapping function invocations).
    for (const change of changes) {
      const { error } = await service.rpc('sync_report_order_chunk', {
        p_source_sheet: sourceSheet,
        p_chunk_index: change.chunkIndex,
        p_chunk_size: ORDER_CHUNK_SIZE,
        p_content_hash: change.hash,
        p_rows: change.rows,
      })
      if (error) throw new Error(`订单同步 ${sourceSheet} #${change.chunkIndex}: ${error.message}`)
    }
    changedChunks += changes.length
    results.push({
      source_sheet: sourceSheet,
      source_rows: parsed.sourceRows,
      valid_rows: parsed.validRows,
      chunks: chunkCount,
      changed_chunks: changes.length,
      latest_date: parsed.latestDate,
    })
  }

  return { sources: results, rows: totalRows, changed_chunks: changedChunks, latest_date: latestDate }
}

Deno.serve(async (request) => {
  const startedAt = Date.now()
  try {
    if (request.method !== 'POST') {
      return json({ error: 'method' }, 405)
    }
    const cronToken = request.headers.get('x-report-cron-token') || ''
    if (!cronToken || !secureEqual(await sha256(cronToken), CRON_TOKEN_HASH)) {
      return json({ error: 'unauthorized' }, 401)
    }

    const service = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    )

    const rawErrorResults = await Promise.allSettled(
      ERROR_SOURCES.map((source) => fetchJson(source.url)),
    )

    // Treat a successful-but-empty response as unavailable. A private sheet,
    // upstream proxy issue, or malformed publication can otherwise look like
    // an intentional clear and erase the last known-good Supabase mirror.
    const errorSources = ERROR_SOURCES.flatMap((source, index) => {
      const result = rawErrorResults[index]
      if (result.status !== 'fulfilled' || result.value.length === 0) return []
      const rows = normalizeErrors(result.value, source.name)
      if (rows.length === 0) return []
      return [{
        name: source.name,
        rawRows: result.value,
        rows,
      }]
    })
    const availableErrorSourceNames = new Set(errorSources.map((source) => source.name))
    const errorSourceFailures = ERROR_SOURCES.flatMap((source, index) => {
      const result = rawErrorResults[index]
      if (availableErrorSourceNames.has(source.name)) return []
      return [{
        source: source.name,
        error: result.status === 'rejected'
          ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
          : result.value.length === 0
            ? 'empty source response; retained last known-good Supabase rows'
            : 'source rows could not be normalized; retained last known-good Supabase rows',
      }]
    })

    const errorSyncResults = await Promise.all(errorSources.map(async (source) => {
      const [snapshot, rows] = await Promise.all([
        writeChunkedSnapshot(service, source.name, source.rows),
        syncErrorRows(service, source.name, source.rows),
      ])
      return { source: source.name, snapshot, rows }
    }))
    const rawErrorCount = errorSources.reduce((total, source) => total + source.rawRows.length, 0)
    const [states, cachedErrorStatus, detailGeneration] = await Promise.all([
      loadSnapshotStates(service),
      loadErrorStatusPayload(service),
      loadErrorDetailGeneration(service),
    ])
    const errorStatusState = states.get('效率表/员工错误状态')
    const summaryAt = new Date()
    const summaryDay = manilaDateKey(summaryAt)
    const cachedSummaryHash = noteValue(errorStatusState?.note, 'summary-hash') ||
      text(cachedErrorStatus.summary_hash)
    const cachedSummaryDay = noteValue(errorStatusState?.note, 'summary-day') ||
      text(cachedErrorStatus.summary_day)
    const cachedSummaryGeneration = noteValue(errorStatusState?.note, 'summary-generation') ||
      text(cachedErrorStatus.summary_generation)
    const errorRowsChanged = errorSyncResults.some((result) =>
      Number(result.rows.changed_chunks || 0) > 0 || Number(result.rows.deleted_rows || 0) > 0
    )
    const shouldRebuildSummaries = !cachedSummaryHash ||
      !cachedSummaryGeneration || cachedSummaryGeneration !== detailGeneration ||
      cachedSummaryDay !== summaryDay || errorRowsChanged ||
      (cachedErrorStatus.summary_deferred === true && errorSourceFailures.length === 0)

    let errorRowsUnique = Number(cachedErrorStatus.unique_rows || errorStatusState?.row_count || 0)
    let summaryEmployees = Number(cachedErrorStatus.summary_employees || 0)
    let summaryHash = cachedSummaryHash
    let summaryChanges = 0
    let summaryRebuilt = false
    let summaryDeferred = cachedErrorStatus.summary_deferred === true
    let summaryGeneration = cachedSummaryGeneration
    let latestErrors = text(cachedErrorStatus.latest_date)

    if (shouldRebuildSummaries) {
      const errors = await loadAllSyncedErrors(service)
      // If an upstream source is unavailable and the persisted detail view is
      // unexpectedly empty, keep the last known-good summary instead of
      // interpreting the outage as a legitimate full clear.
      const unsafeEmptyDuringSourceFailure = errorSourceFailures.length > 0 &&
        errors.length === 0
      summaryDeferred = unsafeEmptyDuringSourceFailure
      if (summaryDeferred && !summaryHash) summaryHash = 'deferred'
      if (!summaryDeferred) {
        const summaries = buildRiskSummaries(errors, summaryAt)
        errorRowsUnique = errors.length
        summaryEmployees = summaries.length
        summaryHash = payloadHash(summaries)
        latestErrors = errors
          .map((row) => row.qc_date || row.review_date || '')
          .filter(Boolean)
          .sort()
          .at(-1) || ''
        summaryChanges = await syncChangedSummaries(service, summaries)
        summaryGeneration = detailGeneration
        summaryRebuilt = true
      }
    }

    const orderSyncResult = await syncOrderSheets(service)
    const snapshotPlans: Array<[string, unknown[], string, number?]> = [
      [
        '效率表/网站数据状态',
        [{ latest_date: orderSyncResult.latest_date, rows: orderSyncResult.rows }],
        '工作表4 + 填表已完整同步到 Supabase 订单明细',
      ],
      [
        '效率表/订单处理',
        orderSyncResult.sources,
        `两张效率工作表分块增量同步；changed:${orderSyncResult.changed_chunks}`,
        orderSyncResult.rows,
      ],
    ]
    const snapshotResults = []
    for (const [source, payload, note, rowCount] of snapshotPlans) {
      const result = await writeSnapshot(service, states, source, payload, note, rowCount)
      snapshotResults.push(result)
    }

    snapshotResults.push(await writeSnapshot(
      service,
      states,
      '效率表/员工错误状态',
      [{
        latest_date: latestErrors,
        raw_rows: rawErrorCount,
        unique_rows: errorRowsUnique,
        summary_employees: summaryEmployees,
        summary_hash: summaryHash,
        detail_generation: detailGeneration,
        summary_generation: summaryGeneration,
        summary_day: summaryDay,
        summary_deferred: summaryDeferred,
        sources: errorSources.map((source) => ({
          source: source.name,
          raw_rows: source.rawRows.length,
          normalized_rows: source.rows.length,
        })),
        unavailable_sources: errorSourceFailures,
      }],
      `多来源错误明细独立同步；按记录指纹去重；summary-hash:${summaryHash};detail-generation:${detailGeneration};summary-generation:${summaryGeneration};summary-day:${summaryDay}`,
      errorRowsUnique,
    ))

    return json({
      ok: true,
      roster_raw: Number(states.get('居家排班表/填表')?.row_count || 0),
      roster_rows: Number(states.get('居家排班表/填表')?.row_count || 0),
      account_rows: Number(states.get('居家排班表/账号')?.row_count || 0),
      roster_source: 'supabase_snapshot',
      error_rows_raw: rawErrorCount,
      error_rows_unique: errorRowsUnique,
      error_sources: errorSources.map((source) => ({
        source: source.name,
        raw_rows: source.rawRows.length,
        normalized_rows: source.rows.length,
      })),
      error_source_failures: errorSourceFailures,
      error_summary: summaryEmployees,
      summary_changes: summaryChanges,
      summary_rebuilt: summaryRebuilt,
      summary_deferred: summaryDeferred,
      error_sync: errorSyncResults,
      snapshot_changes: snapshotResults.filter((result) => result.changed).map((result) => result.source),
      latest_orders: orderSyncResult.latest_date,
      order_sync: orderSyncResult,
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
