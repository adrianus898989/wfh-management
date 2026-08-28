export type AdminIpPreflightPayload = {
  allowed: boolean
  enforced: boolean
  reason: string
}

const ALLOW_REASONS = new Set([
  'matched',
  'enforcement_disabled',
  'bootstrap_no_entries',
])

const DENY_REASONS = new Set([
  'ip_not_allowed',
  'client_ip_unavailable',
])

export function unavailablePreflight(reason = 'service_unavailable'): AdminIpPreflightPayload {
  return {
    allowed: false,
    enforced: false,
    reason,
  }
}

/**
 * Deliberately projects the privileged RPC result onto the three public fields.
 * Never spread the RPC object here: it also contains the observed IP, matching
 * allowlist entry id and enabled-entry count.
 */
export function publicPreflightPayload(gate: unknown): AdminIpPreflightPayload {
  if (!gate || typeof gate !== 'object') return unavailablePreflight()

  const value = gate as Record<string, unknown>
  const reason = typeof value.reason === 'string' ? value.reason : ''
  if (!ALLOW_REASONS.has(reason) && !DENY_REASONS.has(reason)) {
    return unavailablePreflight()
  }

  const enforced = value.enforced === true
  const consistent = reason === 'enforcement_disabled'
    ? !enforced
    : enforced
  if (!consistent) return unavailablePreflight()

  const allowed = value.ok === true && ALLOW_REASONS.has(reason)
  return {
    allowed,
    enforced,
    reason,
  }
}
