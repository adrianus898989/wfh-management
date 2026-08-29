const text = value => String(value ?? '').trim()

const statusFrom = value => {
  const direct = Number(value?.status || value?.statusCode || value?.context?.status || value?.response?.status || 0)
  return Number.isFinite(direct) ? direct : 0
}

const errorText = error => [
  error?.code,
  error?.message,
  error?.details,
  error?.hint,
  typeof error === 'string' ? error : '',
].map(text).filter(Boolean).join(' ')

export function mutationAuthFailure(error) {
  const status = statusFrom(error)
  if (status === 401 || status === 403) return status

  const message = errorText(error)
  if (/(?:^|\W)(?:401)(?:\W|$)|not_authenticated|session_not_current|jwt\s*(?:expired|invalid)|unauthori[sz]ed/i.test(message)) return 401
  if (/(?:^|\W)(?:403)(?:\W|$)|permission_denied|forbidden|not_permitted/i.test(message)) return 403
  return 0
}

export function mutationErrorReason(error, fallback = '操作未完成，请稍后重试。') {
  const reason = error?.message || error?.details || error?.hint || (typeof error === 'string' ? error : '')
  return text(reason) || fallback
}

export function writeSuccessToast({ module, operation, reason, dedupeKey } = {}) {
  return {
    type:'success',
    module,
    operation,
    reason,
    dedupeKey,
  }
}

export function writeFailureToast({ module, operation, error, reason, fallback, dedupeKey, refresh } = {}) {
  const authFailure = mutationAuthFailure(error)
  return {
    type:'error',
    module,
    operation,
    reason:text(reason) || mutationErrorReason(error, fallback),
    dedupeKey,
    retry:!authFailure && typeof refresh === 'function' ? refresh : undefined,
    retryLabel:'刷新确认',
  }
}
