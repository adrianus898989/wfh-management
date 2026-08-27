const timeoutError = code => Object.assign(new Error(code), { code })

// Abort the underlying fetch before releasing the caller. A plain
// Promise.race only stops the UI from waiting and leaves the request running.
export function withAbortTimeout(operation, ms, code = 'TIMEOUT') {
  const controller = new AbortController()
  let timer
  const request = Promise.resolve().then(() => operation(controller.signal))
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => {
      const error = timeoutError(code)
      reject(error)
      controller.abort(error)
    }, ms)
  })

  return Promise.race([request, timeout])
    .finally(() => globalThis.clearTimeout(timer))
}
