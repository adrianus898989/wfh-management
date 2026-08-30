export const APP_HEARTBEAT_CROSS_TAB_WINDOW_MS = 100 * 1000
export const APP_SESSION_WAKE_FRESHNESS_MS = 90 * 1000

const memoryHeartbeatAt = new Map()

const coalescedHeartbeatResult = () => ({
  data:{ ok:true, coalesced:true },
  error:null,
})

const readLastDispatch = (storage, key) => {
  try {
    return Number(storage?.getItem(key) || 0)
  } catch (_) {
    return Number(memoryHeartbeatAt.get(key) || 0)
  }
}

const writeLastDispatch = (storage, key, value) => {
  memoryHeartbeatAt.set(key, value)
  try { storage?.setItem(key, String(value)) } catch (_) { /* memory fallback */ }
}

const verificationStampKey = portal =>
  `wfh_${portal === 'admin' ? 'admin' : 'staff'}_session_verified_at`

/** Record only a completed server verification, never a request dispatch. */
export const markAppSessionVerified = ({
  portal,
  at = Date.now(),
  storage = typeof window === 'undefined' ? null : window.localStorage,
} = {}) => {
  const key = verificationStampKey(portal)
  const stamp = Number(at)
  if (!Number.isFinite(stamp) || stamp <= 0) return
  writeLastDispatch(storage, key, stamp)
}

/**
 * Focus and visibility can fire together, and every open tab receives them.
 * A recent completed claim/heartbeat is enough to keep the current verified
 * view; the next normal heartbeat still renews the five-minute server lease.
 */
export const appSessionVerificationIsFresh = ({
  portal,
  at = Date.now(),
  maxAge = APP_SESSION_WAKE_FRESHNESS_MS,
  storage = typeof window === 'undefined' ? null : window.localStorage,
} = {}) => {
  const current = Number(at)
  const last = readLastDispatch(storage, verificationStampKey(portal))
  const age = current - last
  return last > 0 && Number.isFinite(age) && age >= 0 && age < maxAge
}

/** Serialize slow focus/visibility revalidation across same-portal tabs. */
export const runCoalescedAppSessionWake = ({
  portal,
  isFresh,
  run,
  locks = typeof navigator === 'undefined' ? null : navigator.locks,
} = {}) => {
  if (typeof isFresh !== 'function' || typeof run !== 'function') {
    throw new TypeError('wake freshness and runner are required')
  }
  const safePortal = portal === 'admin' ? 'admin' : 'staff'
  const verify = () => isFresh() ? coalescedHeartbeatResult() : run()
  if (locks?.request) {
    return locks.request(`wfh:${safePortal}:app-session-wake`, { mode:'exclusive' }, verify)
  }
  return verify()
}

/**
 * Coalesce the same portal heartbeat across tabs on one browser/origin.
 *
 * A successful claim is still performed by every newly authenticated app
 * shell. Only the recurring heartbeat is shared. The server lease lasts five
 * minutes, so a 100-second browser-local window removes duplicate tab traffic
 * while the active-tab heartbeat still runs every two minutes.
 */
export const runCoalescedAppHeartbeat = async ({
  portal,
  run,
  now = () => Date.now(),
  storage = typeof window === 'undefined' ? null : window.localStorage,
  locks = typeof navigator === 'undefined' ? null : navigator.locks,
} = {}) => {
  if (typeof run !== 'function') throw new TypeError('heartbeat runner is required')
  const safePortal = portal === 'admin' ? 'admin' : 'staff'
  const stampKey = `wfh_${safePortal}_heartbeat_dispatch_at`
  const dispatch = async () => {
    const current = now()
    const last = readLastDispatch(storage, stampKey)
    if (last > 0 && current - last < APP_HEARTBEAT_CROSS_TAB_WINDOW_MS) {
      return coalescedHeartbeatResult()
    }
    // Write before the request starts. If Supabase is temporarily unhealthy,
    // sibling tabs wait for the normal short window instead of retry-storming.
    writeLastDispatch(storage, stampKey, current)
    return run()
  }

  if (locks?.request) {
    return locks.request(`wfh:${safePortal}:app-session-heartbeat`, { mode:'exclusive' }, dispatch)
  }
  return dispatch()
}
