import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationPath = fileURLToPath(new URL(
  '../../migrations/20260905201500_report_order_rolling_month_partitions.sql',
  import.meta.url,
))
const migration = readFileSync(migrationPath, 'utf8')

function between(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('legacy Fill history is deduplicated and converted to month sources safely', () => {
  const canonicalize = between(
    migration,
    'do $canonicalize_report_order_rolling_months$',
    '-- Only finalized Work Sheet 4 and month-qualified rolling Fill sources',
  )
  const queueIndex = canonicalize.indexOf(
    'insert into attendance_private.report_order_cache_dirty_accounts',
  )
  const archiveIndex = canonicalize.indexOf(
    'insert into attendance_private.report_order_legacy_fill_archive',
  )
  const deleteIndex = canonicalize.indexOf('delete from public.report_order_rows rows')
  const partitionIndex = canonicalize.indexOf('update public.report_order_rows rows')

  assert.match(migration, /set local lock_timeout = '2s';[\s\S]*set local statement_timeout = '30s';/)
  assert.match(migration, /create table attendance_private\.report_order_legacy_fill_archive \([\s\S]*source_sheet text not null,[\s\S]*source_row integer not null,[\s\S]*work_date date not null,[\s\S]*account text not null,[\s\S]*processed integer not null,[\s\S]*rejected integer not null,[\s\S]*content_hash text not null,[\s\S]*synced_at timestamptz not null,[\s\S]*archived_at timestamptz not null,[\s\S]*archive_reason text not null,[\s\S]*finalized_through date not null/)
  assert.match(migration, /alter table attendance_private\.report_order_legacy_fill_archive[\s\S]*enable row level security;[\s\S]*revoke all on table attendance_private\.report_order_legacy_fill_archive[\s\S]*from public, anon, authenticated, service_role;/)
  assert.match(canonicalize, /max\(rows\.work_date\)[\s\S]*rows\.source_sheet = '工作表4'/)
  assert.match(canonicalize, /insert into attendance_private\.sheet_sync_runtime_leases as lease[\s\S]*on conflict \(job_name\) do update[\s\S]*where lease\.expires_at <= clock_timestamp\(\)[\s\S]*report_order_month_sync_is_active/)
  assert.match(canonicalize, /delete from attendance_private\.sheet_sync_runtime_leases lease[\s\S]*lease\.holder = v_migration_holder/)
  assert.match(canonicalize, /get diagnostics v_report_lease_released = row_count;[\s\S]*v_report_lease_released <> 1[\s\S]*report_order_migration_lease_release_failed/)
  assert.match(canonicalize, /pg_try_advisory_xact_lock/)
  assert.match(canonicalize, /lock table public\.report_order_rows in share row exclusive mode;/)
  assert.ok(archiveIndex >= 0 && archiveIndex < deleteIndex, 'legacy rows must be archived before cleanup')
  assert.ok(queueIndex >= 0 && queueIndex < deleteIndex, 'dirty accounts must be queued before cleanup')
  assert.ok(deleteIndex < partitionIndex, 'finalized duplicate rows must be removed before partitioning')
  assert.match(canonicalize, /insert into attendance_private\.report_order_legacy_fill_archive \([\s\S]*rows\.source_sheet,[\s\S]*rows\.source_row,[\s\S]*rows\.work_date,[\s\S]*rows\.account,[\s\S]*rows\.processed,[\s\S]*rows\.rejected,[\s\S]*rows\.content_hash,[\s\S]*rows\.synced_at,[\s\S]*v_archive_at,[\s\S]*v_archive_reason,[\s\S]*v_finalized_through/)
  assert.match(canonicalize, /get diagnostics v_archived = row_count;[\s\S]*v_archived <> v_delete_expected[\s\S]*report_order_legacy_archive_count_mismatch/)
  assert.match(canonicalize, /v_archived <> v_delete_expected[\s\S]*v_deleted <> v_delete_expected[\s\S]*report_order_rolling_canonicalization_count_mismatch/)
  assert.doesNotMatch(
    canonicalize,
    /from attendance_private\.report_order_legacy_fill_archive archive/,
    'archive proof must remain set-level instead of probing every copied row',
  )
  assert.match(canonicalize, /rows\.work_date <= v_finalized_through/)
  assert.match(canonicalize, /set source_sheet = '填表\/' \|\| pg_catalog\.to_char\(rows\.work_date, 'YYYY-MM'\)/)
  assert.match(canonicalize, /delete from public\.report_order_sync_chunks[\s\S]*source_sheet = '填表'/)
  assert.match(canonicalize, /v_work4_rows_after is distinct from v_work4_rows_before/)
  assert.match(canonicalize, /report_order_rolling_canonicalization_count_mismatch/)
  assert.match(canonicalize, /report_order_dirty_account_coverage_failed/)
  assert.ok(
    migration.includes("source_sheet ~ '^填表/[0-9]{4}-(0[1-9]|1[0-2])$'"),
    'canonical source constraint must accept only month-qualified Fill sources',
  )
})

test('rolling-month RPC is bounded, guarded, atomic, and service-role only', () => {
  const rpc = between(
    migration,
    'create or replace function public.sync_report_order_rolling_month(',
    'revoke all on function public.sync_report_order_rolling_month',
  )
  const queueIndex = rpc.indexOf(
    'insert into attendance_private.report_order_cache_dirty_accounts',
  )
  const deleteIndex = rpc.indexOf('delete from public.report_order_rows rows')
  const insertIndex = rpc.indexOf('insert into public.report_order_rows')
  const markerIndex = rpc.indexOf(
    'insert into attendance_private.report_order_rolling_month_markers',
  )

  assert.match(rpc, /p_month text,[\s\S]*p_content_hash text,[\s\S]*p_rows jsonb/)
  assert.match(rpc, /security definer[\s\S]*set search_path = ''/)
  assert.match(rpc, /v_month !~ '\^\[0-9\]\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$'/)
  assert.match(rpc, /v_hash !~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(rpc, /v_input_rows > 100000/)
  assert.match(rpc, /duplicate_report_order_month_source_row/)
  assert.match(rpc, /report_order_row_outside_month/)
  assert.match(rpc, /report_order_row_already_finalized/)
  assert.match(rpc, /pg_try_advisory_xact_lock/)
  assert.match(rpc, /v_baseline_rows::numeric \* 0\.80/)
  assert.match(rpc, /report_order_month_below_baseline/)
  assert.match(rpc, /v_input_rows = 0 and v_month_end > v_finalized_through/)
  assert.ok(queueIndex >= 0 && queueIndex < deleteIndex, 'old and new accounts must be queued first')
  assert.ok(deleteIndex < insertIndex && insertIndex < markerIndex, 'row swap must precede marker commit')
  assert.match(rpc, /where rows\.source_sheet = v_source_sheet;/)
  assert.match(rpc, /'changed', false/)
  assert.match(rpc, /'deleted_rows', v_deleted/)
  assert.match(migration, /revoke all on function public\.sync_report_order_rolling_month\(text, text, jsonb\)[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute[\s\S]*to service_role;/)
  assert.match(migration, /sync_report_order_rolling_month\(text, text, jsonb\)[\s\S]*set statement_timeout = '8s';[\s\S]*set lock_timeout = '1s';/)
})

test('marker preflight is small, stable, and service-role only', () => {
  const markers = between(
    migration,
    'create or replace function public.report_order_rolling_month_markers()',
    'revoke all on function public.report_order_rolling_month_markers()',
  )

  assert.match(markers, /returns table \([\s\S]*month_key text,[\s\S]*content_hash text,[\s\S]*row_count integer,[\s\S]*finalized_through date/)
  assert.match(markers, /language sql[\s\S]*stable[\s\S]*security definer[\s\S]*set search_path = ''/)
  assert.match(markers, /from attendance_private\.report_order_rolling_month_markers marker[\s\S]*limit 120;/)
  assert.match(migration, /report_order_rolling_month_markers_hash_check check \([\s\S]*content_hash ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(migration, /pg_catalog\.repeat\('0', 64\)/)
  assert.match(migration, /revoke all on function public\.report_order_rolling_month_markers\(\)[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute[\s\S]*to service_role;/)
  assert.match(migration, /report_order_rolling_month_markers\(\)[\s\S]*set statement_timeout = '2s';[\s\S]*set lock_timeout = '500ms';/)
})

test('summary and dirty cache prefer finalized Work Sheet 4 without losing same-family rows', () => {
  const summary = between(
    migration,
    'create or replace function public.report_order_account_summary_v2(',
    'revoke all on function public.report_order_account_summary_v2',
  )
  const refresh = between(
    migration,
    'create or replace function public.refresh_dirty_report_order_account_cache(',
    'revoke all on function public.refresh_dirty_report_order_account_cache',
  )

  for (const definition of [summary, refresh]) {
    assert.match(definition, /source_family_days as materialized/)
    assert.match(definition, /sum\(rows\.processed\)::bigint processed/)
    assert.match(definition, /sum\(rows\.rejected\)::bigint rejected/)
    assert.match(definition, /canonical_days as materialized/)
    assert.match(definition, /select distinct on \(family\.account, family\.work_date\)/)
    assert.match(definition, /case when family\.source_family = 'finalized' then 0 else 1 end/)
    assert.match(definition, /rows\.source_sheet = '工作表4'[\s\S]*rows\.source_sheet like '填表\/%'/)
    assert.match(definition, /security definer[\s\S]*set search_path = ''/)
  }

  assert.match(migration, /grant execute on function public\.report_order_account_summary_v2\([\s\S]*\) to service_role;/)
  assert.match(migration, /refresh_dirty_report_order_account_cache\(integer\)[\s\S]*set statement_timeout = '5s';[\s\S]*set lock_timeout = '1s';/)
  assert.match(refresh, /for update skip locked/)
})
