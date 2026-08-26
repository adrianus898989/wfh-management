const text = value => String(value ?? '').trim()
const GENERIC_EDGE_FUNCTION_ERROR = /^edge function returned a non-2xx status code$/i

function bodyMessage(body) {
  if (!body || typeof body !== 'object') return ''
  return text(body.error || body.message || body.msg || body.details)
}

async function responseBody(response) {
  if (!response) return null
  const readable = typeof response.clone === 'function' ? response.clone() : response

  try {
    if (typeof readable.json === 'function') return await readable.json()
  } catch {
    // Some Edge Functions return plain text or an intermediary HTML error.
  }

  try {
    const fallback = typeof response.clone === 'function' ? response.clone() : response
    if (typeof fallback.text === 'function') return { message:await fallback.text() }
  } catch {
    // Fall through to the SDK message below.
  }

  return null
}

/**
 * supabase-js keeps a non-2xx Edge Function response body on
 * FunctionsHttpError.context. Reading that body preserves the actionable
 * server error instead of showing only "Edge Function returned a non-2xx".
 */
export async function edgeFunctionErrorMessage({ data, error, fallback = '请求失败' } = {}) {
  const direct = bodyMessage(data)
  if (direct) return direct

  const contextual = bodyMessage(await responseBody(error?.context))
  if (contextual) return contextual

  const sdkMessage = text(error?.message)
  return sdkMessage && !GENERIC_EDGE_FUNCTION_ERROR.test(sdkMessage) ? sdkMessage : fallback
}
