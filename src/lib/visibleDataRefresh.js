import { useEffect, useRef } from 'react'

export const VISIBLE_DATA_REFRESH_MS = 2 * 60 * 1000
export const VISIBLE_DATA_REFRESH_JITTER_MS = 30 * 1000

export const visibleDataRefreshDelay = (
  intervalMs = VISIBLE_DATA_REFRESH_MS,
  random = Math.random,
) => {
  const base = Math.max(1, Number(intervalMs) || VISIBLE_DATA_REFRESH_MS)
  const sampled = typeof random === 'function' ? Number(random()) : 0
  const fraction = Number.isFinite(sampled) ? Math.max(0, Math.min(1, sampled)) : 0
  return base + Math.floor(fraction * VISIBLE_DATA_REFRESH_JITTER_MS)
}

const valueOf = value => {
  if (typeof value === 'function') return value()
  if (value && typeof value === 'object' && 'current' in value) return value.current
  return value
}

export const visibleDataRefreshDue = ({
  enabled = true,
  visibilityState = 'visible',
  online = true,
  pending = false,
  lastRefreshAt = 0,
  now = Date.now(),
  intervalMs = VISIBLE_DATA_REFRESH_MS,
} = {}) => Boolean(enabled)
  && visibilityState === 'visible'
  && online !== false
  && !pending
  && Number(now) - Number(lastRefreshAt || 0) >= Math.max(1, Number(intervalMs) || VISIBLE_DATA_REFRESH_MS)

// One active route owns one bounded refresh loop. The hook also coalesces the
// focus + visibility events browsers commonly emit together and waits for the
// current request to finish before another background read may start.
export const useVisibleDataRefresh = ({
  refresh,
  enabled = true,
  pending = false,
  lastCompletedAt = 0,
  intervalMs = VISIBLE_DATA_REFRESH_MS,
} = {}) => {
  const configRef = useRef(null)
  const lastAttemptAtRef = useRef(Date.now())
  configRef.current = { refresh, enabled, pending, lastCompletedAt, intervalMs }

  useEffect(() => {
    let active = true
    let ownedFlight = null
    let timer = 0

    const attempt = reason => {
      const config = configRef.current || {}
      const now = Date.now()
      const lastCompleted = Number(valueOf(config.lastCompletedAt) || 0)
      const lastRefreshAt = Math.max(lastAttemptAtRef.current, lastCompleted)
      if (!visibleDataRefreshDue({
        enabled:valueOf(config.enabled),
        visibilityState:document.visibilityState,
        online:navigator.onLine,
        pending:Boolean(valueOf(config.pending)) || Boolean(ownedFlight),
        lastRefreshAt,
        now,
        intervalMs:config.intervalMs,
      })) return undefined

      lastAttemptAtRef.current = now
      let result
      try {
        result = config.refresh?.({ reason, requestedAt:now })
      } catch (_) {
        return undefined
      }
      const flight = Promise.resolve(result).catch(() => undefined).finally(() => {
        if (active && ownedFlight === flight) ownedFlight = null
      })
      ownedFlight = flight
      return flight
    }

    const clearTimer = () => {
      window.clearTimeout(timer)
      timer = 0
    }
    const schedule = () => {
      clearTimer()
      if (!active || document.visibilityState !== 'visible' || navigator.onLine === false) return
      const config = configRef.current || {}
      timer = window.setTimeout(() => {
        timer = 0
        // Schedule from dispatch time, not completion time. A slow request can
        // never shift every following refresh into the same completion wave.
        schedule()
        attempt('interval')
      }, visibleDataRefreshDelay(config.intervalMs))
    }
    const onVisibilityChanged = () => {
      if (document.visibilityState !== 'visible') {
        clearTimer()
        return
      }
      attempt('visible')
      schedule()
    }
    const onFocus = () => {
      const flight = attempt('focus')
      if (flight || !timer) schedule()
    }
    const onOnline = () => {
      const flight = attempt('online')
      if (flight || !timer) schedule()
    }
    const onOffline = () => clearTimer()
    schedule()
    document.addEventListener('visibilitychange', onVisibilityChanged)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      active = false
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibilityChanged)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [intervalMs])
}
