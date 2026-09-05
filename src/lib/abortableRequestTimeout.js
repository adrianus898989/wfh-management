const requestTimeoutError = code => Object.assign(new Error(code), { code })

/**
 * Bound one browser request and abort the underlying fetch when its deadline
 * expires. Promise.race alone releases the caller but leaves the HTTP request
 * running, which can overlap a retry and multiply slow Edge invocations.
 */
export function withAbortableRequestTimeout(operation, timeoutMs, code = 'TIMEOUT') {
  if (typeof operation !== 'function') {
    return Promise.reject(new TypeError('request operation is required'))
  }

  const controller = new AbortController()
  let timer
  const request = Promise.resolve().then(() => operation(controller.signal))
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => {
      const error = requestTimeoutError(code)
      // Settle the public timeout first so an AbortError from fetch cannot hide
      // the stable application error code used by the login/retry UI.
      reject(error)
      controller.abort(error)
    }, timeoutMs)
  })

  return Promise.race([request, timeout])
    .finally(() => globalThis.clearTimeout(timer))
}
