import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const edgePath = fileURLToPath(new URL('./index.ts', import.meta.url))
const migrationPath = fileURLToPath(new URL(
  '../../migrations/20260830124500_report_order_sync_resumable_cache.sql',
  import.meta.url,
))
const edge = readFileSync(edgePath, 'utf8')
const migration = readFileSync(migrationPath, 'utf8')

function between(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('chunk replacement queues old and new accounts without rebuilding cache', () => {
  const chunk = between(
    migration,
    'create or replace function public.sync_report_order_chunk(',
    'create or replace function public.refresh_dirty_report_order_account_cache(',
  )
  const queueIndex = chunk.indexOf('insert into attendance_private.report_order_cache_dirty_accounts')
  const rawDeleteIndex = chunk.indexOf('delete from public.report_order_rows')

  assert.ok(queueIndex >= 0 && queueIndex < rawDeleteIndex, 'dirty accounts must be durable before raw replacement')
  assert.match(chunk, /select lower\(btrim\(r\.account\)\) as account[\s\S]*from public\.report_order_rows r[\s\S]*nullif\(btrim\(r\.account\), ''\) is not null[\s\S]*union[\s\S]*jsonb_array_elements\(p_rows\)/)
  assert.match(chunk, /pg_try_advisory_xact_lock/)
  assert.doesNotMatch(chunk, /\bpg_advisory_xact_lock\s*\(/)
  assert.doesNotMatch(chunk, /delete from public\.report_order_account_cache/)
  assert.doesNotMatch(chunk, /insert into public\.report_order_account_cache/)
  assert.match(chunk, /set search_path = ''/)
})

test('migration DDL fails fast instead of queuing behind production traffic', () => {
  assert.match(migration, /begin;[\s\S]*set local lock_timeout = '2s';[\s\S]*set local statement_timeout = '30s';/)
  assert.ok(
    migration.indexOf("set local lock_timeout = '2s'") < migration.indexOf('alter table attendance_private.sheet_sync_runtime_leases'),
  )
})

test('bounded cache finalizer is crash-recoverable and service-role only', () => {
  const refresh = between(
    migration,
    'create or replace function public.refresh_dirty_report_order_account_cache(',
    'revoke all on function public.sync_report_order_chunk',
  )
  const cacheWriteIndex = refresh.indexOf('insert into public.report_order_account_cache')
  const queueAckIndex = refresh.indexOf('delete from attendance_private.report_order_cache_dirty_accounts')

  assert.match(refresh, /least\(greatest\(coalesce\(p_limit, 250\), 1\), 500\)/)
  assert.match(refresh, /for update skip locked/)
  assert.match(refresh, /pg_try_advisory_xact_lock/)
  assert.ok(cacheWriteIndex >= 0 && cacheWriteIndex < queueAckIndex, 'queue must be acknowledged after cache write')
  assert.match(refresh, /set search_path = ''/)
  assert.match(migration, /alter table attendance_private\.report_order_cache_dirty_accounts enable row level security/)
  assert.match(migration, /revoke all on table attendance_private\.report_order_cache_dirty_accounts[\s\S]*service_role/)
  assert.match(migration, /grant execute on function public\.sync_report_order_chunk[\s\S]*to service_role/)
  assert.match(migration, /grant execute on function public\.refresh_dirty_report_order_account_cache[\s\S]*to service_role/)
  assert.match(migration, /refresh_dirty_report_order_account_cache\(integer\)[\s\S]*set statement_timeout = '5s'/)
})

test('Edge invocation owns and renews one cross-isolate lease before fetching', () => {
  const serve = edge.slice(edge.indexOf('Deno.serve('))
  const claimIndex = serve.indexOf('claimSheetSyncLease(service, REPORT_SYNC_JOB')
  const fetchIndex = serve.indexOf('Promise.allSettled(')

  assert.ok(claimIndex >= 0 && claimIndex < fetchIndex, 'lease must be claimed before any source work')
  assert.match(serve, /error: 'sync_busy'[\s\S]*503/)
  assert.match(serve, /finally \{[\s\S]*releaseSheetSyncLease\(service, lease\)/)
  assert.match(serve, /error instanceof SheetSyncDeadlineError[\s\S]*preserveLeaseUntilExpiry = true/)
  assert.match(edge, /renewReportSyncLease\(service, lease!\)/)
  assert.match(migration, /'report-sheet-sync'/)
  assert.match(migration, /grant execute on function public\.claim_sheet_sync_runtime_lease[\s\S]*to service_role/)
})

test('order writes and cache drain are sequential, bounded, and resumable', () => {
  const sync = between(edge, 'async function syncOrderSheets(', 'Deno.serve(')
  const drain = between(edge, 'async function drainReportOrderCache(', 'async function syncOrderSheets(')

  assert.match(sync, /for \(const change of changes\)[\s\S]*await renewLease\(\)[\s\S]*sheetSyncRpcWithDeadline/)
  assert.doesNotMatch(sync, /Promise\.all\(changes/)
  assert.match(sync, /const cacheRefresh = await drainReportOrderCache\(service, renewLease\)/)
  assert.match(drain, /CACHE_MAX_BATCHES/)
  assert.match(drain, /CACHE_DRAIN_BUDGET_MS/)
  assert.match(drain, /p_limit: CACHE_BATCH_SIZE/)
  assert.match(drain, /sheetSyncDatabaseErrorIsRetryable\(error\)[\s\S]*deferred = true/)
})
