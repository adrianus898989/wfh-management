export const normalizeAppBaseUrl = value => {
  const raw = String(value || '/').trim()
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`
  const normalized = prefixed.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return normalized ? `${normalized}/` : '/'
}

const injectedBaseUrl = typeof import.meta.env?.BASE_URL === 'string'
  ? import.meta.env.BASE_URL
  : '/'

const injectedPortalMode = typeof import.meta.env?.VITE_APP_PORTAL_MODE === 'string'
  ? import.meta.env.VITE_APP_PORTAL_MODE
  : 'both'

export const normalizeAppPortalMode = value => {
  const mode = String(value || '').trim().toLowerCase()
  return mode === 'admin' || mode === 'staff' ? mode : 'both'
}

export const APP_PORTAL_MODE = normalizeAppPortalMode(injectedPortalMode)
export const defaultAppPortalMode = (buildMode = APP_PORTAL_MODE) => (
  normalizeAppPortalMode(buildMode) === 'admin' ? 'admin' : 'staff'
)
export const appPortalModeAllowed = (mode, buildMode = APP_PORTAL_MODE) => {
  const requestedMode = mode === 'admin' || mode === 'staff' ? mode : null
  const normalizedBuildMode = normalizeAppPortalMode(buildMode)
  return Boolean(requestedMode) && (
    normalizedBuildMode === 'both' || normalizedBuildMode === requestedMode
  )
}

/**
 * Resolve the only portal namespace this browser runtime may use. A split-host
 * build must never let a pasted URL from the other portal select its auth
 * storage before React redirects back to the local login page.
 */
export const effectiveAppPortalMode = (requestedMode, buildMode = APP_PORTAL_MODE) => (
  requestedMode && appPortalModeAllowed(requestedMode, buildMode)
    ? requestedMode
    : defaultAppPortalMode(buildMode)
)

export const APP_BASE_URL = normalizeAppBaseUrl(injectedBaseUrl)
export const APP_ROUTER_BASENAME = APP_BASE_URL === '/'
  ? '/'
  : APP_BASE_URL.slice(0, -1)

export const appPathnameForBase = (relativePath, baseUrl = APP_BASE_URL) => {
  const relative = String(relativePath || '').replace(/^\/+/, '')
  return `${normalizeAppBaseUrl(baseUrl)}${relative}`
}

export const appPathname = relativePath => appPathnameForBase(relativePath)

export const PUBLIC_PORTAL_PREFIX = Object.freeze({
  admin:'/workspace',
  staff:'/portal',
})

export const INTERNAL_PORTAL_PREFIX = Object.freeze({
  admin:'/admin',
  staff:'/staff',
})

const PORTAL_PREFIXES = Object.freeze([
  ['admin', PUBLIC_PORTAL_PREFIX.admin],
  ['staff', PUBLIC_PORTAL_PREFIX.staff],
  ['admin', INTERNAL_PORTAL_PREFIX.admin],
  ['staff', INTERNAL_PORTAL_PREFIX.staff],
])

const prefixMatches = (value, prefix) => value === prefix
  || value.startsWith(`${prefix}/`)
  || value.startsWith(`${prefix}?`)
  || value.startsWith(`${prefix}#`)

/** Return the security portal mode without weakening exact path boundaries. */
export const portalModeFromAppPath = value => {
  const path = String(value || '')
  return PORTAL_PREFIXES.find(([, prefix]) => prefixMatches(path, prefix))?.[0] || null
}

/** Remove the host-specific Vite base before classifying an application path. */
export const appPathFromBrowserPath = (pathname, baseUrl = APP_BASE_URL) => {
  const path = String(pathname || '') || '/'
  const base = normalizeAppBaseUrl(baseUrl).replace(/\/$/, '')
  if (!base) return path
  return path === base || path.startsWith(`${base}/`)
    ? path.slice(base.length) || '/'
    : path
}

export const portalModeFromBrowserPath = (pathname, baseUrl = APP_BASE_URL) =>
  portalModeFromAppPath(appPathFromBrowserPath(pathname, baseUrl))

export const effectivePortalModeFromAppPath = (value, buildMode = APP_PORTAL_MODE) =>
  effectiveAppPortalMode(portalModeFromAppPath(value), buildMode)

export const effectivePortalModeFromBrowserPath = (
  pathname,
  baseUrl = APP_BASE_URL,
  buildMode = APP_PORTAL_MODE,
) => effectiveAppPortalMode(portalModeFromBrowserPath(pathname, baseUrl), buildMode)

export const shouldLoadAdminEnhancers = (
  pathname,
  baseUrl = APP_BASE_URL,
  buildMode = APP_PORTAL_MODE,
) => effectivePortalModeFromBrowserPath(pathname, baseUrl, buildMode) === 'admin'

const replacePortalPrefix = (value, prefixes) => {
  const path = String(value || '')
  const match = PORTAL_PREFIXES.find(([, prefix]) => prefixMatches(path, prefix))
  return match ? `${prefixes[match[0]]}${path.slice(match[1].length)}` : path
}

/** Bridge public route aliases back to the legacy permission-route namespace. */
export const internalPortalPath = value => replacePortalPrefix(value, INTERNAL_PORTAL_PREFIX)

/** Build a user-facing URL while retaining suffix, query and hash verbatim. */
export const publicPortalTarget = (portalOrPath, suffix = '') => {
  if (portalOrPath === 'admin' || portalOrPath === 'staff') {
    const tail = String(suffix || '')
    return `${PUBLIC_PORTAL_PREFIX[portalOrPath]}${tail && !/^[/?#]/.test(tail) ? '/' : ''}${tail}`
  }
  return replacePortalPrefix(portalOrPath, PUBLIC_PORTAL_PREFIX)
}

export const portalAuthStorageKey = mode =>
  `wfh-${mode === 'admin' ? 'admin' : 'staff'}-auth-token`
