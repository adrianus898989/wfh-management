const injectedReleaseId = typeof import.meta.env?.VITE_APP_RELEASE_ID === 'string'
  ? import.meta.env.VITE_APP_RELEASE_ID.trim()
  : ''

export const APP_RELEASE_ID = injectedReleaseId || 'development'
export const APP_RELEASE_POLL_MS = 45 * 1000

const normalizedPortal = portal => portal === 'admin' ? 'admin' : 'staff'
const storageKey = portal => `wfh_${normalizedPortal(portal)}_app_release_id`
const browserStores = () => {
  if (typeof window === 'undefined') return []
  const stores = []
  try { stores.push(window.localStorage) } catch (_) {}
  try { stores.push(window.sessionStorage) } catch (_) {}
  return stores
}

export const registeredAppReleaseId = portal => {
  let firstValue = ''
  for (const store of browserStores()) {
    try {
      const value = store.getItem(storageKey(portal)) || ''
      if (value === APP_RELEASE_ID) return value
      if (value && !firstValue) firstValue = value
    } catch (_) {}
  }
  return firstValue
}

export const currentAppReleaseIsRegistered = portal => (
  registeredAppReleaseId(portal) === APP_RELEASE_ID
)

export const registerCurrentAppRelease = portal => {
  if (typeof window === 'undefined') return
  for (const store of browserStores()) {
    try { store.setItem(storageKey(portal), APP_RELEASE_ID) } catch (_) {}
  }
  try {
    window.dispatchEvent(new CustomEvent('wfh:app-release-registered', {
      detail: { portal: normalizedPortal(portal), releaseId: APP_RELEASE_ID },
    }))
  } catch (_) {}
}

export const clearRegisteredAppRelease = portal => {
  for (const store of browserStores()) {
    try { store.removeItem(storageKey(portal)) } catch (_) {}
  }
}

const releaseManifestUrl = (baseUrl, now) => {
  const url = new URL('release.json', baseUrl)
  url.searchParams.set('release_check', String(now))
  return url.href
}

export const fetchPublishedAppReleaseId = async ({
  fetchImpl = globalThis.fetch,
  baseUrl = typeof window === 'undefined'
    ? 'http://localhost/'
    : new URL(import.meta.env.BASE_URL || '/', window.location.origin).href,
  now = Date.now(),
} = {}) => {
  if (typeof fetchImpl !== 'function') return ''
  try {
    const response = await fetchImpl(releaseManifestUrl(baseUrl, now), {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    if (!response?.ok) return ''
    const payload = await response.json()
    const releaseId = typeof payload?.releaseId === 'string' ? payload.releaseId.trim() : ''
    return releaseId.length > 0 && releaseId.length <= 200 ? releaseId : ''
  } catch (_) {
    // A transient manifest/CDN failure must never destroy a valid login. The
    // next visibility, focus or interval check will retry without using cache.
    return ''
  }
}
