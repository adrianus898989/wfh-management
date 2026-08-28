import { readFunctionResponsePayload } from './functionErrors.js'

export const ADMIN_IP_PREFLIGHT_TIMEOUT_MS = 10 * 1000

const ALLOWED_RESULTS = new Set([
  'matched',
  'enforcement_disabled',
  'bootstrap_no_entries',
])

function unavailableResult(reason = 'service_unavailable') {
  return {
    status: 'unavailable',
    allowed: false,
    enforced: false,
    reason,
  }
}

export function classifyAdminIpPreflight(payload) {
  if (!payload || typeof payload !== 'object') return unavailableResult()
  if (
    typeof payload.allowed !== 'boolean'
    || typeof payload.enforced !== 'boolean'
    || typeof payload.reason !== 'string'
  ) return unavailableResult()

  const enforcementConsistent = payload.reason === 'enforcement_disabled'
    ? payload.enforced === false
    : payload.enforced === true
  if (!enforcementConsistent) return unavailableResult()

  if (payload.allowed === true && ALLOWED_RESULTS.has(payload.reason)) {
    return {
      status: 'allowed',
      allowed: true,
      enforced: payload.enforced,
      reason: payload.reason,
    }
  }
  if (payload.allowed === false && payload.reason === 'ip_not_allowed') {
    return {
      status: 'blocked',
      allowed: false,
      enforced: payload.enforced,
      reason: payload.reason,
    }
  }
  return unavailableResult(payload.reason === 'client_ip_unavailable'
    ? 'client_ip_unavailable'
    : 'service_unavailable')
}

export async function requestAdminIpPreflight(client, {
  signal,
  timeoutMs = ADMIN_IP_PREFLIGHT_TIMEOUT_MS,
} = {}) {
  if (!client?.functions?.invoke) return unavailableResult()

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = globalThis.setTimeout(() => controller.abort('timeout'), timeoutMs)

  try {
    const result = await client.functions.invoke('admin-ip-preflight', {
      body: {},
      signal: controller.signal,
    })
    const payload = await readFunctionResponsePayload(result)
    if (result?.error) return unavailableResult()
    return classifyAdminIpPreflight(payload)
  } catch (_) {
    return unavailableResult()
  } finally {
    globalThis.clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}
