const RECOVERY_FINGERPRINT_VERSION = 'wfh_backend_recovery_fingerprint_v1'

const clean = value => String(value ?? '').trim()

export function recoveryProvisioningMaterial(input) {
  // A JSON array is deliberately used instead of a delimiter-joined string so
  // attacker-controlled values cannot create ambiguous field boundaries.
  return JSON.stringify([
    RECOVERY_FINGERPRINT_VERSION,
    clean(input.actorUserId).toLowerCase(),
    clean(input.username).toLowerCase(),
    clean(input.roleId).toLowerCase(),
    clean(input.employeeId).toLowerCase(),
    clean(input.dataScope).toLowerCase(),
    input.otpRequired === true,
    String(input.password ?? ''),
  ])
}

export async function buildRecoveryProvisioningFingerprint(secretKey, input) {
  const encoder = new TextEncoder()
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey),
    { name:'HMAC', hash:'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    encoder.encode(recoveryProvisioningMaterial(input)),
  )
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function isConfirmedAuthIdentityDuplicate(error) {
  const value = error || {}
  const status = Number(value?.status || value?.statusCode || value?.context?.status || 0)
  const code = clean(value?.code || value?.error_code).toLowerCase()
  const message = clean(value?.message).toLowerCase()
  const duplicateCode = new Set([
    'email_exists',
    'user_already_exists',
    'user_already_registered',
  ]).has(code)
  const duplicateMessage = /(?:user|email).*(?:already (?:registered|exists)|has already been registered)/i.test(message)
  return (status === 400 || status === 409 || status === 422) && (duplicateCode || duplicateMessage)
}

export function recoveryIdentityDisposition(createError, recoveredAuthUserId) {
  if (clean(recoveredAuthUserId)) return 'reuse'
  if (isConfirmedAuthIdentityDuplicate(createError)) return 'conflict'
  return 'retry'
}
