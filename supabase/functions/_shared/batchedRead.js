const text = value => String(value ?? '').trim()

const errorStatus = value => {
  const status = Number(value?.status || value?.statusCode || value?.context?.status || 0)
  return Number.isFinite(status) ? status : 0
}

const errorCode = value => text(value?.code || value?.error_code || value?.name).toUpperCase()

const withResponseStatus = (failure, result) => {
  const status = errorStatus(result)
  if (!failure || status < 400 || errorStatus(failure)) return failure
  if (typeof failure === 'object') {
    try {
      failure.status = status
      if (!failure.statusText && result?.statusText) failure.statusText = result.statusText
      return failure
    } catch (_) {
      // Some SDK error objects may be frozen; preserve their public fields in
      // a small wrapper so the retry classifier still sees the HTTP status.
    }
  }
  return {
    status,
    statusText:text(result?.statusText),
    name:text(failure?.name),
    code:text(failure?.code),
    message:text(failure?.message || failure || result?.statusText || 'read request failed'),
    cause:failure,
  }
}

export function isRetryableReadFailure(value) {
  const status = errorStatus(value)
  const code = errorCode(value)
  const message = text(value?.message || value?.error || value).toLowerCase()

  // Authentication, authorization and conflict responses are deterministic.
  // Check them before message matching so words such as "network" or
  // "connection" in a policy/table name cannot turn them into retries.
  if ((status >= 400 && status < 500 && status !== 408 && status !== 429)
    || code === '42501'
    || code === '23505') return false

  return value instanceof TypeError
    || code === 'TYPEERROR'
    || status === 408
    || status === 429
    || status >= 500
    || code === '57014'
    || (code.startsWith('PGRST') && status >= 500)
    || /statement timeout|canceling statement|connection|connection reset|connection refused|error sending request|failed to send request|fetch failed|load failed|network|timed? ?out|timeout|upstream|gateway|socket|econn/.test(message)
}

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const defaultJitter = () => Math.floor(Math.random() * 70)

/**
 * Runs idempotent PostgREST reads in URL-safe batches. Successful data is only
 * returned after every batch completes; a permanent failure never returns a
 * misleading partial result.
 */
export async function readRowsInBatches({
  values,
  queryBatch,
  batchSize = 40,
  retryDelays = [140, 360],
  sleep = defaultSleep,
  jitter = defaultJitter,
  onRetry = () => {},
} = {}) {
  if (typeof queryBatch !== 'function') throw new TypeError('queryBatch must be a function')
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 40
  const uniqueValues = Array.from(new Set((values || []).map(text).filter(Boolean)))
  const rows = []

  for (let offset = 0; offset < uniqueValues.length; offset += size) {
    const batch = uniqueValues.slice(offset, offset + size)

    for (let attempt = 0; ; attempt += 1) {
      let result
      let failure
      try {
        // Rebuild the PostgREST query for each attempt; builders are thenables
        // and must not be reused after a failed request.
        result = await queryBatch(batch, { attempt:attempt + 1, offset })
        failure = result?.error || null
        failure = withResponseStatus(failure, result)
        if (!failure && !Array.isArray(result?.data)) {
          failure = Object.assign(new Error('read batch returned an invalid response'), {
            code:'READ_RESPONSE_INVALID',
            status:502,
          })
        }
      } catch (error) {
        failure = error
      }

      if (!failure) {
        rows.push(...result.data)
        break
      }

      if (!isRetryableReadFailure(failure) || attempt >= retryDelays.length) throw failure
      onRetry({ batch:[...batch], attempt:attempt + 1, error:failure })
      const delay = Math.max(0, Number(retryDelays[attempt]) || 0)
      const extra = Math.max(0, Number(jitter({ attempt:attempt + 1, batch })) || 0)
      await sleep(delay + extra)
    }
  }

  return rows
}
