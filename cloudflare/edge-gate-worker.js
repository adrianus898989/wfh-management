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

const accessDenied = () => new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>访问受限 | Access restricted</title>
  <style>
    :root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;color:#17243a;background:#eef3f9}
    *{box-sizing:border-box}body{margin:0;min-width:320px;min-height:100vh;background:radial-gradient(circle at 50% -10%,#dce8ff 0,transparent 40%),linear-gradient(145deg,#f7f9fc,#eaf0f8);display:grid;place-items:center;padding:24px}
    main{width:min(460px,100%);padding:42px 38px 36px;border:1px solid #d7e1ee;border-radius:22px;background:#ffffff;box-shadow:0 22px 60px rgba(31,58,94,.12);text-align:center}
    .brand{display:flex;align-items:center;justify-content:center;gap:11px;margin-bottom:30px;color:#233a5c;font-size:14px;font-weight:800;letter-spacing:.08em}.logo{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;color:#fff;font-size:16px;background:linear-gradient(135deg,#3474ec,#7159ed);box-shadow:0 9px 24px rgba(65,91,221,.28)}
    .shield{width:58px;height:58px;margin:0 auto 20px;display:grid;place-items:center;border-radius:18px;color:#316bdc;background:#edf4ff}.shield svg{width:29px;height:29px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    h1{margin:0 0 9px;font-size:26px;line-height:1.25;letter-spacing:-.02em}h2{margin:0 0 19px;color:#71829a;font-size:14px;font-weight:650;letter-spacing:.02em}
    p{margin:0 auto;color:#5e7089;font-size:14px;line-height:1.8;max-width:350px}.hint{margin-top:9px;color:#8997aa;font-size:12px}
    a{display:inline-flex;align-items:center;justify-content:center;min-width:150px;height:44px;margin-top:27px;border-radius:11px;color:#fff;background:linear-gradient(90deg,#2e6ee5,#5c61e8);box-shadow:0 9px 22px rgba(52,93,219,.22);font-size:14px;font-weight:750;text-decoration:none}a:focus-visible{outline:3px solid rgba(47,111,228,.28);outline-offset:3px}
    footer{margin-top:27px;color:#a0acbb;font-size:10px;letter-spacing:.16em;font-weight:750}@media(max-width:520px){main{padding:34px 24px 30px;border-radius:18px}h1{font-size:23px}}
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="logo">W</span><span>WFH MANAGEMENT</span></div>
    <div class="shield" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.7 2.8 8.2 7 10 4.2-1.8 7-5.3 7-10V6l-7-3Z"/><path d="M9.5 12.5 11 14l3.7-4"/></svg></div>
    <h1>当前网络未获授权</h1>
    <h2>Access restricted</h2>
    <p>请连接公司允许的网络，或联系管理员将当前网络加入访问名单。</p>
    <p class="hint">Connect from an approved network or contact your administrator.</p>
    <a href="">重新检测&nbsp; / &nbsp;Retry</a>
    <footer>SECURE ACCESS</footer>
  </main>
</body>
</html>`, {
  status: 403,
  headers: {
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Language': 'zh-CN',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Content-Type': 'text/html; charset=utf-8',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  },
})

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
      return accessDenied()
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
