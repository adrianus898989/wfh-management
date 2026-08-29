export const APP_HEARTBEAT_CROSS_TAB_WINDOW_MS = 45 * 1000

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

/**
 * Coalesce the same portal heartbeat across tabs on one browser/origin.
 *
 * A successful claim is still performed by every newly authenticated app
 * shell. Only the recurring heartbeat is shared. The server lease lasts five
 * minutes, so a 45-second browser-local window removes duplicate tab traffic
 * without weakening live revocation or changing the one-minute server cadence.
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
