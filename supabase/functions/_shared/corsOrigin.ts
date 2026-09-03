const LEGACY_GITHUB_PAGES_ORIGIN = 'https://adrianus898989.github.io'

const DEFAULT_ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type'

export type CorsOptions = {
  allowedHeaders?: string
  allowedMethods?: string
  exposedHeaders?: string
  maxAgeSeconds?: number
}

function runtimeConfiguredOrigins() {
  try {
    return Deno.env.get('APP_ALLOWED_ORIGINS') || ''
  } catch {
    return ''
  }
}

function isLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '127.0.0.1'
    || normalized === '::1'
}

function normalizeExactHttpsOrigin(value: string) {
  const candidate = value.trim()
  if (!candidate || candidate === 'null' || candidate.includes('*')) return ''

  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:') return ''
    if (url.username || url.password || url.search || url.hash) return ''
    if (url.pathname !== '/' && url.pathname !== '') return ''
    if (isLocalHostname(url.hostname)) return ''
    return url.origin
  } catch {
    return ''
  }
}

/**
 * Browser origins allowed to invoke the protected administrative Edge
 * Functions. The current GitHub Pages origin remains valid during migration.
 * Additional origins must be comma-separated, exact HTTPS origins in
 * APP_ALLOWED_ORIGINS. Wildcards, URL paths, credentials and local origins are
 * ignored so preview deployments cannot silently become trusted.
 */
export function allowedAppOrigins(raw = runtimeConfiguredOrigins()) {
  const origins = new Set<string>([LEGACY_GITHUB_PAGES_ORIGIN])
  for (const value of raw.split(',')) {
    const origin = normalizeExactHttpsOrigin(value)
    if (origin) origins.add(origin)
  }
  return origins
}

export function isRequestOriginAllowed(
  req: Request,
  raw = runtimeConfiguredOrigins(),
) {
  const origin = req.headers.get('origin')
  // Origin is a browser CORS signal, not authentication. Preserve authenticated
  // server-to-server and scheduled calls, which normally omit this header.
  return !origin || allowedAppOrigins(raw).has(origin)
}

export function corsHeaders(
  req: Request,
  options: CorsOptions = {},
  raw = runtimeConfiguredOrigins(),
) {
  const origin = req.headers.get('origin')
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': options.allowedHeaders || DEFAULT_ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': options.allowedMethods || 'POST, OPTIONS',
    'Vary': 'Origin',
  }

  if (origin && allowedAppOrigins(raw).has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  if (options.exposedHeaders) {
    headers['Access-Control-Expose-Headers'] = options.exposedHeaders
  }
  if (options.maxAgeSeconds !== undefined) {
    headers['Access-Control-Max-Age'] = String(options.maxAgeSeconds)
  }
  return headers
}

/**
 * Apply before method parsing, authentication and database work. A null result
 * means request processing may continue.
 */
export function corsGate(
  req: Request,
  options: CorsOptions = {},
  raw = runtimeConfiguredOrigins(),
): Response | null {
  if (!isRequestOriginAllowed(req, raw)) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'origin_not_allowed',
      code: 'origin_not_allowed',
      reason: 'origin_not_allowed',
    }), {
      status: 403,
      headers: {
        ...corsHeaders(req, options, raw),
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(req, options, raw),
        'Cache-Control': 'no-store',
      },
    })
  }

  return null
}
