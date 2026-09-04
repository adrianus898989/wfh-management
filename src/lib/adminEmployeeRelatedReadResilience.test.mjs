import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isRetryableReadFailure, readRowsInBatches } from '../../supabase/functions/_shared/batchedRead.js'

const edge = await readFile(new URL('../../supabase/functions/admin-employees/index.ts', import.meta.url), 'utf8')

const section = (start, end) => {
  const from = edge.indexOf(start)
  const to = edge.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`)
  return edge.slice(from, to)
}

test('employee directory wiring keeps every related read in a bounded helper', () => {
  const size = Number(edge.match(/const RELATED_READ_BATCH_SIZE=(\d+);/)?.[1])
  assert.ok(size > 0 && size <= 100, `unexpected related-read batch size: ${size}`)
  assert.match(edge, /const RELATED_READ_RETRY_DELAYS_MS=\[[^\]]+\]/)
  assert.match(edge, /readRowsInBatches\(\{[\s\S]{0,260}queryBatch:makeQuery/)
  assert.match(edge, /isRetryableReadFailure\(error\)[\s\S]{0,160}503,"related_read_temporarily_unavailable"/)
})

test('all required employee list enrichments use the bounded helper and stay fail closed', () => {
  const list = section('async function buildEmployeeList(', '\nDeno.serve(async (req) =>')
  for (const table of [
    'employee_payment_profiles',
    'employee_contact_profiles',
    'user_access',
    'employee_error_summary',
  ]) {
    assert.match(list, new RegExp(`readRelatedRowsInBatches\\([\\s\\S]{0,120}\\"${table}\\"`))
  }
  assert.doesNotMatch(list, /from\("employee_payment_profiles"\)\.select\("\*"\)\.in\("employee_id",ids\)/)
  assert.match(list, /employee_id,payment_mode,transfer_using,gcash_account,gcash_name,usdt_address/)
  assert.doesNotMatch(list, /catch\([^)]*\)[\s\S]{0,100}pays\s*=\s*\[\]/)
})

test('permission and organization constrained employee pages never emit one unbounded id filter', () => {
  const pagedReader = section('async function readPagedEmployeeRows(', 'function responseFailure(')
  const pageReader = section('async function fetchEmployeeListPage(', 'async function buildEmployeeList(')
  const list = section('async function buildEmployeeList(', '\nDeno.serve(async (req) =>')
  assert.match(pagedReader, /if\(!pageRows\.length\) break/)
  assert.match(pagedReader, /offset\+=pageRows\.length/)
  assert.doesNotMatch(pagedReader, /pageRows\.length<pageSize/)
  assert.match(pageReader, /scope\.mode==="all"\?null:scope\.employeeIds/)
  assert.match(pageReader, /select\("id,employee_no"\)/)
  assert.match(pageReader, /order\("employee_no",\{ascending:true,nullsFirst:false\}\)[\s\S]{0,80}order\("id",\{ascending:true\}\)/)
  assert.match(pageReader, /allowedIds\.has\(id\)/)
  assert.match(pageReader, /const pageIds=matchingIds\.slice\(from,to\+1\)/)
  assert.match(pageReader, /readEmployeeRowsInBatches\([\s\S]{0,80}pageIds,"employees"/)
  assert.match(pageReader, /\.in\("id",batch\)/)
  assert.doesNotMatch(pageReader, /localeCompare/)
  assert.doesNotMatch(list, /organizationEmployeeIds\?q\.in\("id",organizationEmployeeIds\):applyScope/)
})

test('operator enrichment also avoids 500-id URLs and transport errors are normalized', () => {
  const operators = section('async function loadEmployeeOperatorAccounts(', 'async function buildEmployeeList(')
  assert.match(operators, /readEmployeeRowsInBatches\(ids,"employee_lifecycle_events"/)
  assert.match(operators, /readEmployeeRowsInBatches\(ids,"employee_audit_logs"/)
  assert.match(operators, /readRelatedRowsInBatches\([\s\S]{0,160}"user_access"/)
  assert.doesNotMatch(operators, /creatorIds\.slice\(/)

  const retryClassifier = section('function isRetryableBackendFailure(', 'function responseFailure(')
  assert.match(retryClassifier, /error sending request/)
  assert.match(retryClassifier, /status===408/)
  assert.match(retryClassifier, /status===429/)
  assert.match(retryClassifier, /status>=400&&status<500&&status!==408&&status!==429/)
  assert.match(retryClassifier, /code==="42501"/)
  assert.doesNotMatch(retryClassifier, /status===409/)
})

test('500 values are deduplicated, split and returned without loss', async () => {
  const ids = Array.from({ length:500 }, (_, index) => `id-${index}`)
  const calls = []
  const rows = await readRowsInBatches({
    values:['', ...ids, ids[7], '   '],
    batchSize:40,
    retryDelays:[],
    queryBatch:async batch => {
      calls.push([...batch])
      return { data:batch.map(id => ({ id })), error:null }
    },
  })

  assert.equal(calls.length, 13)
  assert.ok(calls.every(batch => batch.length <= 40))
  assert.equal(new Set(calls.flat()).size, 500)
  assert.deepEqual(rows.map(row => row.id), ids)
})

test('only a transiently failed batch is retried and rows are not duplicated', async () => {
  const calls = []
  const sleeps = []
  const rows = await readRowsInBatches({
    values:['a','b','c','d','e'],
    batchSize:2,
    retryDelays:[10,20],
    sleep:async milliseconds => sleeps.push(milliseconds),
    jitter:() => 0,
    queryBatch:async (batch, meta) => {
      calls.push(`${batch.join('')}:${meta.attempt}`)
      if (batch[0] === 'c' && meta.attempt === 1) throw new TypeError('fetch failed')
      return { data:batch.map(id => ({ id })), error:null }
    },
  })

  assert.deepEqual(calls, ['ab:1','cd:1','cd:2','e:1'])
  assert.deepEqual(sleeps, [10])
  assert.deepEqual(rows.map(row => row.id), ['a','b','c','d','e'])
})

test('resolved transport errors retry, permanent failures stop exactly at the limit', async () => {
  let resolvedAttempts = 0
  const resolved = await readRowsInBatches({
    values:['a'],
    retryDelays:[0],
    sleep:async () => {},
    jitter:() => 0,
    queryBatch:async batch => {
      resolvedAttempts += 1
      return resolvedAttempts === 1
        ? { data:null, error:{ name:'TypeError', message:'error sending request' } }
        : { data:batch.map(id => ({ id })), error:null }
    },
  })
  assert.equal(resolvedAttempts, 2)
  assert.deepEqual(resolved, [{ id:'a' }])

  let permanentAttempts = 0
  await assert.rejects(readRowsInBatches({
    values:['a'],
    retryDelays:[0,0],
    sleep:async () => {},
    jitter:() => 0,
    queryBatch:async () => {
      permanentAttempts += 1
      throw new TypeError('fetch failed')
    },
  }), /fetch failed/)
  assert.equal(permanentAttempts, 3)
})

test('HTTP response status participates in retry classification', async () => {
  for (const status of [429,500]) {
    let attempts = 0
    const rows = await readRowsInBatches({
      values:['a'],
      retryDelays:[0],
      sleep:async () => {},
      jitter:() => 0,
      queryBatch:async batch => {
        attempts += 1
        return attempts === 1
          ? { data:null, error:{ message:'request rejected' }, status }
          : { data:batch.map(id => ({ id })), error:null, status:200 }
      },
    })
    assert.equal(attempts, 2)
    assert.deepEqual(rows, [{ id:'a' }])
  }

  let forbiddenAttempts = 0
  await assert.rejects(readRowsInBatches({
    values:['a'],
    retryDelays:[0,0],
    sleep:async () => {},
    jitter:() => 0,
    queryBatch:async () => {
      forbiddenAttempts += 1
      return { data:null, error:{ message:'network policy denied' }, status:403 }
    },
  }))
  assert.equal(forbiddenAttempts, 1)
})

test('authorization and conflict errors are never retried, and empty input does no I/O', async () => {
  for (const failure of [
    { status:403, code:'42501', message:'permission denied for network_settings' },
    { status:409, code:'23505', message:'connection conflict' },
  ]) {
    let attempts = 0
    await assert.rejects(readRowsInBatches({
      values:['a'],
      retryDelays:[0,0],
      sleep:async () => {},
      jitter:() => 0,
      queryBatch:async () => {
        attempts += 1
        return { data:null, error:failure }
      },
    }))
    assert.equal(attempts, 1)
  }

  let emptyCalls = 0
  assert.deepEqual(await readRowsInBatches({
    values:['',null,undefined,'   '],
    queryBatch:async () => {
      emptyCalls += 1
      return { data:[], error:null }
    },
  }), [])
  assert.equal(emptyCalls, 0)
  assert.equal(isRetryableReadFailure(new TypeError()), true)
})

test('malformed successful responses never become partial employee data', async () => {
  let attempts = 0
  await assert.rejects(readRowsInBatches({
    values:['a'],
    retryDelays:[0],
    sleep:async () => {},
    jitter:() => 0,
    queryBatch:async () => {
      attempts += 1
      return { data:null, error:null }
    },
  }), /invalid response/)
  assert.equal(attempts, 2)
})
