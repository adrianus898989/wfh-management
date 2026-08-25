export async function readFunctionResponsePayload({ data, error, response }) {
  if (data && typeof data === 'object') return data

  const errorResponse = response || error?.context
  let payload = null

  if (errorResponse && typeof errorResponse.clone === 'function') {
    try {
      payload = await errorResponse.clone().json()
    } catch (_) {
      try {
        const text = await errorResponse.clone().text()
        payload = text ? JSON.parse(text) : null
      } catch (_) {}
    }
  } else if (errorResponse && typeof errorResponse === 'object') {
    payload = errorResponse
  }

  const headerCode = errorResponse?.headers?.get?.('x-login-error-code') || ''
  if (!payload && !headerCode) return null

  return {
    ...(payload && typeof payload === 'object' ? payload : {}),
    code: payload?.code || headerCode || undefined,
  }
}
