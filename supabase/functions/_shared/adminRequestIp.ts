import {
  jwtSessionId,
  trustedClientIp,
} from './adminIp.ts'

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const REQUEST_IP_DEPENDENCY_TIMEOUT_MS = 8_000

export class AdminRequestIpError extends Error {
  status: number
  code: string
  retryable: boolean

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message)
    this.name = 'AdminRequestIpError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

function unavailable(code = 'admin_ip_guard_unavailable') {
  return new AdminRequestIpError(
    503,
    code,
    '后台网络验证暂时不可用，请稍后重试。登录状态仍为你保留。',
    true,
  )
}

async function boundedRpc(service: any, name: string, args: Record<string, unknown>) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    let request = service.rpc(name, args)
    if (typeof request?.abortSignal === 'function') {
      request = request.abortSignal(controller.signal)
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('ADMIN_IP_REQUEST_TIMEOUT'))
      }, REQUEST_IP_DEPENDENCY_TIMEOUT_MS)
    })
    return await Promise.race([Promise.resolve(request), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Checks the gateway-observed IP on every service-role admin request.
 *
 * The normal success path deliberately performs only the read-only pre-login
 * CIDR lookup. It does not refresh the session attestation and does not update
 * the shared allowlist hit counter, so high-volume admin reads cannot turn one
 * allowlist entry into a database hot row. The periodic admin-ip-guard remains
 * responsible for the per-session attestation and lease.
 *
 * A live non-match is terminal. Reusing admin_ip_session_attest for that path
 * removes the matching lease/Auth session atomically. Missing trusted proxy
 * metadata, malformed dependency responses and database/network failures are
 * infrastructure failures: fail closed for this request without revoking the
 * browser session.
 */
export async function enforceAdminRequestIp(
  req: Request,
  service: any,
  userId: string,
  tokenOrAuthorization: string,
) {
  const sessionId = jwtSessionId(tokenOrAuthorization)
  if (!UUID_PATTERN.test(String(userId || '')) || !UUID_PATTERN.test(sessionId)) {
    throw new AdminRequestIpError(
      401,
      'auth_session_missing',
      '登录状态无效，请重新登录。',
    )
  }

  const clientIp = trustedClientIp(req)
  if (!clientIp) throw unavailable('client_ip_unavailable')

  let gateResult: any
  try {
    gateResult = await boundedRpc(service, 'admin_ip_prelogin_check', {
      p_client_ip: clientIp,
    })
  } catch {
    throw unavailable()
  }

  if (gateResult?.error) throw unavailable()
  const gate = gateResult?.data
  if (
    !gate
    || typeof gate.ok !== 'boolean'
    || typeof gate.enforced !== 'boolean'
    || typeof gate.effective !== 'boolean'
    || typeof gate.reason !== 'string'
  ) {
    throw unavailable()
  }

  const allowedDecision = gate.ok === true && (
    (gate.reason === 'matched' && gate.enforced === true && gate.effective === true)
    || (gate.reason === 'enforcement_disabled' && gate.enforced === false && gate.effective === false)
  )
  if (allowedDecision) {
    return {
      ok: true,
      enforced: gate.enforced,
      effective: gate.effective,
      reason: gate.reason,
    }
  }

  const explicitDenied = gate.reason === 'ip_not_allowed'
    && gate.ok === false
    && gate.enforced === true
    && gate.effective === true
  const legacyEmptyDenied = gate.reason === 'bootstrap_no_entries'
    && gate.ok === true
    && gate.enforced === true
    && gate.effective === false
  if (!explicitDenied && !legacyEmptyDenied) {
    throw unavailable(gate.reason === 'client_ip_unavailable'
      ? 'client_ip_unavailable'
      : 'admin_ip_guard_unavailable')
  }

  // Deny even if best-effort revocation encounters an infrastructure error.
  // The current request never reaches service-role data after this decision.
  try {
    await boundedRpc(service, 'admin_ip_session_attest', {
      p_user_id: userId,
      p_session_id: sessionId,
      p_client_ip: clientIp,
      p_source: 'management',
    })
  } catch {
    // The 403 remains authoritative for this request. The existing lease and
    // Auth session also expire server-side if the revocation dependency is down.
  }

  throw new AdminRequestIpError(
    403,
    'ip_not_allowed',
    '当前网络未获准访问后台。',
  )
}
