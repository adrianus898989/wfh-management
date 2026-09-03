const encoder = new TextEncoder()

export const PORTAL_IP_GATE_MAX_BODY_BYTES = 512
export const PORTAL_IP_GATE_MAX_CLOCK_SKEW_MS = 60_000

export type Portal = 'admin' | 'staff'

export type SignedPortalRequest = {
  portal: Portal
  clientIp: string
}

export type VerificationResult =
  | { ok: true; value: SignedPortalRequest }
  | { ok: false; reason: string }

function isValidIpv4(value: string) {
  const octets = value.split('.')
  if (octets.length !== 4) return false
  return octets.every(octet => {
    if (!/^(0|[1-9]\d{0,2})$/.test(octet)) return false
    const number = Number(octet)
    return number >= 0 && number <= 255
  })
}

function isValidIpv6(value: string) {
  if (!value.includes(':') || value.includes('%')) return false
  if (value.indexOf('::') !== value.lastIndexOf('::')) return false

  const compressed = value.includes('::')
  const [left = '', right = ''] = compressed ? value.split('::') : [value, '']
  const leftParts = left ? left.split(':') : []
  const rightParts = right ? right.split(':') : []
  const parts = [...leftParts, ...rightParts]

  if (parts.some(part => !part)) return false
  const ipv4Indexes = parts
    .map((part, index) => part.includes('.') ? index : -1)
    .filter(index => index >= 0)
  if (ipv4Indexes.length > 1) return false
  if (ipv4Indexes.length === 1 && ipv4Indexes[0] !== parts.length - 1) return false

  let units = 0
  for (const part of parts) {
    if (part.includes('.')) {
      if (!isValidIpv4(part)) return false
      units += 2
    } else {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return false
      units += 1
    }
  }

  return compressed ? units < 8 : units === 8
}

export function isValidHostIp(value: string) {
  if (
    !value
    || value !== value.trim()
    || value.length > 45
    || /[\s,/\[\]]/.test(value)
  ) return false
  return isValidIpv4(value) || isValidIpv6(value)
}

export function portalIpGateMessage(timestamp: string, portal: Portal, clientIp: string) {
  return `${timestamp}\n${portal}\n${clientIp}`
}

function bytesToHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function constantTimeHexEquals(left: string, right: string) {
  if (left.length !== 64 || right.length !== 64) return false
  let difference = 0
  for (let index = 0; index < 64; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

export async function createPortalIpGateSignature(
  secret: string,
  timestamp: string,
  portal: Portal,
  clientIp: string,
  cryptoImpl: Crypto = globalThis.crypto,
) {
  const key = await cryptoImpl.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytesToHex(await cryptoImpl.subtle.sign(
    'HMAC',
    key,
    encoder.encode(portalIpGateMessage(timestamp, portal, clientIp)),
  ))
}

export function parsePortalIpGateBody(bodyText: string): SignedPortalRequest | null {
  if (encoder.encode(bodyText).byteLength > PORTAL_IP_GATE_MAX_BODY_BYTES) return null

  let body: unknown
  try { body = JSON.parse(bodyText) } catch { return null }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null

  const record = body as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 2 || keys[0] !== 'client_ip' || keys[1] !== 'portal') return null
  if (record.portal !== 'admin' && record.portal !== 'staff') return null
  if (typeof record.client_ip !== 'string' || !isValidHostIp(record.client_ip)) return null

  return { portal: record.portal, clientIp: record.client_ip }
}

export async function verifyPortalIpGateRequest({
  bodyText,
  timestamp,
  signature,
  adminSecret,
  staffSecret,
  now = Date.now(),
  cryptoImpl = globalThis.crypto,
}: {
  bodyText: string
  timestamp: string
  signature: string
  adminSecret: string
  staffSecret: string
  now?: number
  cryptoImpl?: Crypto
}): Promise<VerificationResult> {
  const value = parsePortalIpGateBody(bodyText)
  if (!value) return { ok: false, reason: 'invalid_request' }
  if (!/^\d{13}$/.test(timestamp)) return { ok: false, reason: 'invalid_timestamp' }

  const requestedAt = Number(timestamp)
  if (!Number.isSafeInteger(requestedAt) || !Number.isSafeInteger(now)) {
    return { ok: false, reason: 'invalid_timestamp' }
  }
  if (Math.abs(now - requestedAt) > PORTAL_IP_GATE_MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'request_expired' }
  }

  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    return { ok: false, reason: 'invalid_signature' }
  }
  const secret = value.portal === 'admin' ? adminSecret : staffSecret
  const secretLength = encoder.encode(secret).byteLength
  if (secretLength < 32 || secretLength > 4096) {
    return { ok: false, reason: 'service_unavailable' }
  }

  let expected: string
  try {
    expected = await createPortalIpGateSignature(
      secret,
      timestamp,
      value.portal,
      value.clientIp,
      cryptoImpl,
    )
  } catch {
    return { ok: false, reason: 'service_unavailable' }
  }
  if (!constantTimeHexEquals(expected, signature.toLowerCase())) {
    return { ok: false, reason: 'invalid_signature' }
  }

  return { ok: true, value }
}
