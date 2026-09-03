const PORTAL_MODE = '__WFH_PORTAL_MODE__'
const GATE_URL = 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/portal-ip-edge-gate'
const REQUEST_TIMEOUT_MS = 8_000
const MAX_IP_LENGTH = 64

const textEncoder = new TextEncoder()

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

async function gateRequest(request, env) {
  const clientIp = validClientIp(request.headers.get('CF-Connecting-IP'))
  const secret = String(env.IP_GATE_HMAC_SECRET || '')
  if (!clientIp || secret.length < 32) {
    console.error('ip_gate_configuration_unavailable', {
      hasClientIp: Boolean(clientIp),
      secretLength: secret.length,
    })
    return blocked(503, 'Service temporarily unavailable', '10')
  }

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
      return blocked(503, 'Service temporarily unavailable', '10')
    }

    const payload = await response.json().catch(() => null)
    if (payload?.allowed === true) return null
    if (payload?.allowed === false && payload?.reason === 'ip_not_allowed') {
      return blocked(403, 'Access denied')
    }
    return blocked(503, 'Service temporarily unavailable', '10')
  } catch (error) {
    console.error('ip_gate_upstream_failed', {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    })
    return blocked(503, 'Service temporarily unavailable', '10')
  } finally {
    clearTimeout(timer)
  }
}

export default {
  async fetch(request, env) {
    if (PORTAL_MODE !== 'admin' && PORTAL_MODE !== 'staff') {
      return blocked(503, 'Service temporarily unavailable', '10')
    }

    const decision = await gateRequest(request, env)
    if (decision) return decision

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
