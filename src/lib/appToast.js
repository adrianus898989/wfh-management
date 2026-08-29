const text = value => String(value ?? '').trim()

export const APP_TOAST_LIMIT = 3
export const APP_TOAST_SUCCESS_DURATION_MS = 4500
export const APP_TOAST_ERROR_DURATION_MS = 9000

let toastSequence = 0

export function appToastDuration(type) {
  return type === 'error'
    ? APP_TOAST_ERROR_DURATION_MS
    : APP_TOAST_SUCCESS_DURATION_MS
}

export function createAppToast(input = {}, now = Date.now()) {
  const type = input.type === 'error' ? 'error' : 'success'
  const module = text(input.module) || '系统'
  const operation = text(input.operation) || '操作'
  const reason = text(input.reason) || (type === 'error' ? '操作未完成，请稍后重试。' : '操作已完成。')
  const dedupeKey = text(input.dedupeKey) || [type, module, operation, reason].join('|')

  toastSequence += 1
  return {
    id: `${now}-${toastSequence}`,
    type,
    module,
    operation,
    reason,
    dedupeKey,
    durationMs:appToastDuration(type),
    createdAt:now,
    retry:typeof input.retry === 'function' ? input.retry : null,
    retryLabel:text(input.retryLabel) || '重试',
  }
}

export function enqueueAppToast(queue, nextToast, limit = APP_TOAST_LIMIT) {
  const current = Array.isArray(queue) ? queue : []
  const normalizedLimit = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : APP_TOAST_LIMIT)
  if (!normalizedLimit) return []
  if (!nextToast) return current.slice(-normalizedLimit)

  const previous = current.find(item => item.dedupeKey === nextToast.dedupeKey)
  const deduped = current.filter(item => item.dedupeKey !== nextToast.dedupeKey)
  const next = previous ? { ...nextToast, id:previous.id } : nextToast
  return [...deduped, next].slice(-normalizedLimit)
}
