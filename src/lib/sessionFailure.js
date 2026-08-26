const checkedStatuses = new Set([400, 401, 403])

const recoverableLeaseFailure = /(?:app[_\s-]*)?session[_\s-]*not[_\s-]*current|not[_\s-]*owner/i
const terminalAuthFailure = /auth[_\s-]*session[_\s-]*missing|active[_\s-]*elsewhere|staff[_\s-]*account[_\s-]*(?:not[_\s-]*found|missing)|invalid[_\s-]*(?:jwt|token)|jwt[_\s-]*(?:expired|malformed)|refresh[_\s-]*token|(?:auth[_\s-]*)?session[_\s-]*expired|not[_\s-]*authenticated|no[_\s-]*authorization/i

/**
 * A five-minute application lease may expire while a valid browser is asleep
 * or in the background. That state needs a bootstrap/claim retry, not an
 * immediate local sign-out. Definitive Auth revocation remains terminal.
 */
export function classifySessionFailure(status, body = '') {
  const responseStatus = Number(status)
  if (!checkedStatuses.has(responseStatus)) {
    return { shouldCheck: false, terminal: false, reason: 'unrelated_status' }
  }

  const message = String(body || '')
  if (terminalAuthFailure.test(message)) {
    return { shouldCheck: true, terminal: true, reason: 'auth_ended' }
  }
  if (recoverableLeaseFailure.test(message)) {
    return { shouldCheck: true, terminal: false, reason: 'lease_recovery' }
  }
  if (responseStatus === 401) {
    return { shouldCheck: true, terminal: false, reason: 'verify_unauthorized' }
  }
  return { shouldCheck: false, terminal: false, reason: 'unrelated_response' }
}
