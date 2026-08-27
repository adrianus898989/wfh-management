const MAX_FORWARDED_IP_LENGTH = 64

/**
 * Supabase's hosted API gateway terminates requests at Cloudflare and supplies
 * CF-Connecting-IP as the requester address. We intentionally read no body
 * field, query parameter, X-Forwarded-For, X-Real-IP, or custom client header:
 * those values can contain a proxy chain or be supplied by a caller.
 *
 * A production canary against this project's hosted Functions endpoint verified
 * that CF-Connecting-IP equals the gateway's first forwarded hop, browser-sent
 * X-Forwarded-For is overwritten, and a browser attempt to set
 * CF-Connecting-IP is rejected before the function runs. Fail closed when the
 * trusted header is absent or is not a single host address.
 */
export function trustedClientIp(req: Request) {
  const clientIp = (req.headers.get('cf-connecting-ip') || '').trim()
  if (
    !clientIp ||
    clientIp.length > MAX_FORWARDED_IP_LENGTH ||
    clientIp.includes(',') ||
    clientIp.includes('/')
  ) return ''
  return clientIp
}

export function bearerToken(authorization: string) {
  return authorization.replace(/^Bearer\s+/i, '').trim()
}

export function jwtSessionId(tokenOrAuthorization: string) {
  const token = bearerToken(tokenOrAuthorization)
  const payloadPart = token.split('.')[1]
  if (!payloadPart) return ''

  try {
    const base64 = payloadPart.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    return String(JSON.parse(atob(padded))?.session_id || '').trim()
  } catch {
    return ''
  }
}

export function jwtUserId(tokenOrAuthorization: string) {
  const token = bearerToken(tokenOrAuthorization)
  const payloadPart = token.split('.')[1]
  if (!payloadPart) return ''

  try {
    const base64 = payloadPart.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    return String(JSON.parse(atob(padded))?.sub || '').trim()
  } catch {
    return ''
  }
}

export function hostCidr(clientIp: string) {
  const ip = String(clientIp || '').trim()
  if (!ip) return ''
  return `${ip}/${ip.includes(':') ? '128' : '32'}`
}
