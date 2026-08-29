const CACHE_PREFIX = 'wfh-admin-alert-badge-v1'

export const ADMIN_ALERT_BADGE_REFRESH_MS = 5 * 60 * 1000
export const ADMIN_ALERT_BADGE_CACHE_FRESH_MS = ADMIN_ALERT_BADGE_REFRESH_MS
export const ADMIN_ALERT_BADGE_CACHE_STALE_MS = 30 * 60 * 1000
export const ADMIN_ALERT_BADGE_PRELOAD_JITTER_MS = 2500
export const ADMIN_ALERT_BADGE_REFRESH_JITTER_MS = 30 * 1000
export const ADMIN_ALERT_BADGE_MAX_BACKOFF_MS = 15 * 60 * 1000
export const ADMIN_ALERT_BADGE_PRELOAD_LEASE_MS = 12 * 1000
export const ADMIN_ALERT_BADGE_REQUEST_TIMEOUT_MS = 7000

const finiteCount = value => Number.isFinite(Number(value))
  ? Math.max(0, Number(value))
  : 0

const hash = value => {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

export function adminAlertBadgeRefreshDelay(failures = 0, random = Math.random) {
  const failureCount = Math.min(2, Math.max(0, Number(failures) || 0))
  const base = Math.min(
    ADMIN_ALERT_BADGE_MAX_BACKOFF_MS,
    ADMIN_ALERT_BADGE_REFRESH_MS * (2 ** failureCount),
  )
  return Math.min(
    ADMIN_ALERT_BADGE_MAX_BACKOFF_MS,
    base + Math.floor(random() * ADMIN_ALERT_BADGE_REFRESH_JITTER_MS),
  )
}

export function adminAlertBadgeStorageKey(access) {
  const authUserId = String(access?.authUserId || '').trim()
  if (!authUserId) return ''
  const signature = JSON.stringify([
    authUserId,
    Boolean(access?.founder),
    String(access?.dataScope || ''),
    String(access?.employeeId || ''),
    String(access?.teamId || ''),
    String(access?.positionId || ''),
    [...(Array.isArray(access?.permissions) ? access.permissions : [])].sort(),
  ])
  return `${CACHE_PREFIX}:${authUserId}:${hash(signature)}`
}

export function readAdminAlertBadgeCache(storage, key, now = Date.now()) {
  if (!storage || !key) return null
  try {
    const parsed = JSON.parse(storage.getItem(key) || 'null')
    const updatedAt = Number(parsed?.updatedAt)
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null
    const age = Math.max(0, Number(now) - updatedAt)
    if (age > ADMIN_ALERT_BADGE_CACHE_STALE_MS) return null
    return {
      unread:finiteCount(parsed.unread),
      active:finiteCount(parsed.active),
      updatedAt,
      fresh:age <= ADMIN_ALERT_BADGE_CACHE_FRESH_MS,
    }
  } catch {
    return null
  }
}

export function writeAdminAlertBadgeCache(storage, key, summary, now = Date.now()) {
  if (!storage || !key) return false
  try {
    storage.setItem(key, JSON.stringify({
      unread:finiteCount(summary?.unread),
      active:finiteCount(summary?.active),
      updatedAt:Number(now),
    }))
    return true
  } catch {
    return false
  }
}

const leaseKey = key => `${key}:preload-lease`

export function acquireAdminAlertBadgePreloadLease(storage, key, {
  now = Date.now(),
  random = Math.random,
} = {}) {
  if (!storage || !key) return ''
  try {
    const current = JSON.parse(storage.getItem(leaseKey(key)) || 'null')
    if (Number(current?.expiresAt) > Number(now)) return ''
    const token = `${Number(now).toString(36)}-${Math.floor(random() * 0x100000000).toString(36)}`
    storage.setItem(leaseKey(key), JSON.stringify({
      token,
      expiresAt:Number(now) + ADMIN_ALERT_BADGE_PRELOAD_LEASE_MS,
    }))
    const confirmed = JSON.parse(storage.getItem(leaseKey(key)) || 'null')
    return confirmed?.token === token ? token : ''
  } catch {
    return ''
  }
}

export function releaseAdminAlertBadgePreloadLease(storage, key, token) {
  if (!storage || !key || !token) return false
  try {
    const current = JSON.parse(storage.getItem(leaseKey(key)) || 'null')
    if (current?.token !== token) return false
    storage.removeItem(leaseKey(key))
    return true
  } catch {
    return false
  }
}

const statusFrom = error => {
  const candidates = [error?.status, error?.context?.status, error?.cause?.status]
  const status = candidates.map(Number).find(value => Number.isInteger(value) && value >= 100 && value <= 599)
  return status || 0
}

export function classifyAdminAlertBadgeFailure(error) {
  const status = statusFrom(error)
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  const timedOut = code === 'ADMIN_ALERT_BADGE_TIMEOUT' || /(?:timed?\s*out|timeout)/i.test(`${code} ${message}`)
  return {
    status,
    auth:status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : '',
    timedOut,
    transient:timedOut || status === 408 || status === 429 || status >= 500,
  }
}
