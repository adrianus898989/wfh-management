const PORTAL_MODE = '__WFH_PORTAL_MODE__'
const GATE_URL = 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/portal-ip-edge-gate'
const REQUEST_TIMEOUT_MS = 8_000
const MAX_IP_LENGTH = 64
const DECISION_CACHE_SECONDS = 45
const FAILURE_CIRCUIT_SECONDS = 5

const textEncoder = new TextEncoder()
const gateFlights = new Map()
const decisionMemory = new Map()
let failureCircuitUntil = 0

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

const sign = async (secret, message) => {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return hex(new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(message),
  )))
}

const cacheApi = () => globalThis.caches?.default || null

const cacheKey = async (secret, kind, clientIp = '') => {
  const digest = await sign(secret, `cache\n${kind}\n${PORTAL_MODE}\n${clientIp}`)
  return new Request(`https://wfh-ip-gate-cache.invalid/${kind}/${digest}`)
}

const readCachedJson = async (cache, key) => {
  if (!cache) return null
  try {
    const response = await cache.match(key)
    if (!response) return null
    const value = await response.json().catch(() => null)
    return Number(value?.expires_at || 0) > Date.now() ? value : null
  } catch {
    return null
  }
}

const readMemoryDecision = key => {
  const value = decisionMemory.get(key)
  if (!value || value.expiresAt <= Date.now()) {
    decisionMemory.delete(key)
    return null
  }
  return value.allowed
}

const rememberDecision = (key, allowed) => {
  if (decisionMemory.size >= 512) {
    decisionMemory.delete(decisionMemory.keys().next().value)
  }
  decisionMemory.set(key, {
    allowed,
    expiresAt: Date.now() + (DECISION_CACHE_SECONDS * 1000),
  })
}

const openFailureCircuit = () => {
  failureCircuitUntil = Date.now() + (FAILURE_CIRCUIT_SECONDS * 1000)
}

const writeCachedJson = (cache, key, value, seconds, context) => {
  if (!cache) return
  const task = cache.put(key, new Response(JSON.stringify({
    ...value,
    expires_at: Date.now() + (seconds * 1000),
  }), {
    headers: {
      'Cache-Control': `public, max-age=${seconds}`,
      'Content-Type': 'application/json',
    },
  })).catch(() => {})
  if (typeof context?.waitUntil === 'function') context.waitUntil(task)
}

const blocked = (status, message, retryAfter = '') => {
  const headers = {
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Type': 'text/plain; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  }
  if (retryAfter) headers['Retry-After'] = retryAfter
  return new Response(message, { status, headers })
}

const validClientIp = value => {
  const ip = String(value || '').trim()
  return Boolean(
    ip
    && ip.length <= MAX_IP_LENGTH
    && !ip.includes(',')
    && !ip.includes('/')
    && /^[0-9a-f:.]+$/i.test(ip),
  ) ? ip : ''
}

async function gateRequest(request, env, context) {
  const clientIp = validClientIp(request.headers.get('CF-Connecting-IP'))
  const secret = String(env.IP_GATE_HMAC_SECRET || '')
  if (!clientIp || secret.length < 32) {
    console.error('ip_gate_configuration_unavailable', {
      hasClientIp: Boolean(clientIp),
      secretLength: secret.length,
    })
    return { kind: 'unavailable' }
  }

  const cache = cacheApi()
  const decisionKey = await cacheKey(secret, 'decision', clientIp)
  const memoryDecision = readMemoryDecision(decisionKey.url)
  if (memoryDecision === true) return { kind: 'allow' }
  if (memoryDecision === false) return { kind: 'deny' }
  const cachedDecision = await readCachedJson(cache, decisionKey)
  if (cachedDecision?.allowed === true) {
    rememberDecision(decisionKey.url, true)
    return { kind: 'allow' }
  }
  if (cachedDecision?.allowed === false) {
    rememberDecision(decisionKey.url, false)
    return { kind: 'deny' }
  }

  const failureKey = await cacheKey(secret, 'failure')
  if (failureCircuitUntil > Date.now()) return { kind: 'unavailable' }
  if (await readCachedJson(cache, failureKey)) return { kind: 'unavailable' }

  const existingFlight = gateFlights.get(decisionKey.url)
  if (existingFlight) return existingFlight

  const flight = (async () => {
    const timestamp = String(Date.now())
    const message = `${timestamp}\n${PORTAL_MODE}\n${clientIp}`
    const signature = await sign(secret, message)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(GATE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Pages-IP-Gate-Timestamp': timestamp,
          'X-Pages-IP-Gate-Signature': signature,
        },
        body: JSON.stringify({ portal: PORTAL_MODE, client_ip: clientIp }),
        // Cloudflare Workers intentionally supports only follow/manual here.
        // Keep redirects visible so any unexpected 3xx fails closed below.
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        console.error('ip_gate_upstream_rejected', { status: response.status })
        openFailureCircuit()
        writeCachedJson(
          cache,
          failureKey,
          { unavailable: true },
          FAILURE_CIRCUIT_SECONDS,
          context,
        )
        return { kind: 'unavailable' }
      }

      const payload = await response.json().catch(() => null)
      if (payload?.allowed === true) {
        rememberDecision(decisionKey.url, true)
        writeCachedJson(
          cache,
          decisionKey,
          { allowed: true },
          DECISION_CACHE_SECONDS,
          context,
        )
        return { kind: 'allow' }
      }
      if (payload?.allowed === false && payload?.reason === 'ip_not_allowed') {
        rememberDecision(decisionKey.url, false)
        writeCachedJson(
          cache,
          decisionKey,
          { allowed: false },
          DECISION_CACHE_SECONDS,
          context,
        )
        return { kind: 'deny' }
      }
      openFailureCircuit()
      writeCachedJson(
        cache,
        failureKey,
        { unavailable: true },
        FAILURE_CIRCUIT_SECONDS,
        context,
      )
      return { kind: 'unavailable' }
    } catch (error) {
      console.error('ip_gate_upstream_failed', {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      })
      openFailureCircuit()
      writeCachedJson(
        cache,
        failureKey,
        { unavailable: true },
        FAILURE_CIRCUIT_SECONDS,
        context,
      )
      return { kind: 'unavailable' }
    } finally {
      clearTimeout(timer)
    }
  })().finally(() => {
    if (gateFlights.get(decisionKey.url) === flight) {
      gateFlights.delete(decisionKey.url)
    }
  })
  gateFlights.set(decisionKey.url, flight)
  return flight
}

export default {
  async fetch(request, env, context) {
    if (PORTAL_MODE !== 'admin' && PORTAL_MODE !== 'staff') {
      return blocked(503, 'Service temporarily unavailable', '10')
    }

    const decision = await gateRequest(request, env, context)
    if (decision.kind === 'deny') return blocked(403, 'Access denied')
    if (decision.kind !== 'allow') {
      return blocked(503, 'Service temporarily unavailable', '10')
    }

    const response = await env.ASSETS.fetch(request)
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'private, no-store, max-age=0')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
}
