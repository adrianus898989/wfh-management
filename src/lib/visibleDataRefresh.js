import { useEffect, useRef } from 'react'

export const VISIBLE_DATA_REFRESH_MS = 2 * 60 * 1000

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

    const onVisible = () => { if (document.visibilityState === 'visible') attempt('visible') }
    const onFocus = () => { attempt('focus') }
    const onOnline = () => { attempt('online') }
    const timer = window.setInterval(() => attempt('interval'), Math.max(1, Number(intervalMs) || VISIBLE_DATA_REFRESH_MS))
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)

    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [intervalMs])
}
