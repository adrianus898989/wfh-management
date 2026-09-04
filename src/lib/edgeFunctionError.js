const text = value => String(value ?? '').trim()
const GENERIC_EDGE_FUNCTION_ERROR = /^edge function returned a non-2xx status code$/i
const OBJECT_STRING = /^\[object (?:Object|Array)\]$/i
const INTERNAL_TRANSPORT_ERROR = /(?:typeerror:\s*)?(?:error|failed) sending request(?:\s+from\s+[\d.:a-f]+)?\s+for\s+https?:\/\/[^\s]+|https?:\/\/[a-z0-9-]+\.supabase\.co\/(?:rest|auth|storage|functions)\/v1\/|\b(?:econnreset|econnrefused|und_err_[a-z_]+)\b/i
const AUTHENTICATION_ERROR = /(?:not_authenticated|session_not_current|invalid[_\s-]?jwt|jwt[_\s-]?(?:expired|invalid)|\b401\b)/i
const AUTHORIZATION_ERROR = /(?:permission_denied|not[_\s-]?authorized|access[_\s-]?denied|\b403\b)/i
const MACHINE_ERROR = /^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|PGRST\d+|[A-Z0-9]{5})(?::|$)/
const TRANSIENT_INFRASTRUCTURE_ERROR = /(?:temporar(?:y|ily)|database[_\s-]?(?:recovery|unavailable)|statement[_\s-]?timeout|timed?[_\s-]?out|network[_\s-]?(?:error|unavailable)|fetch[_\s-]?failed)/i

const publicErrorMessage = (message, fallback) => {
  const value = text(message)
  // Never expose internal Edge egress addresses, database URLs or long query
  // strings in a user-facing toast. The full failure remains in server logs.
  return value && !INTERNAL_TRANSPORT_ERROR.test(value) ? value : fallback
}

export function publicRequestErrorMessage(value, fallback = '服务暂时繁忙，请稍后重试。') {
  const message=readableErrorMessage(value)
  if(AUTHENTICATION_ERROR.test(message))return '登录状态已失效，请重新登录。'
  if(AUTHORIZATION_ERROR.test(message))return '当前账号没有执行此操作的权限。'
  if(MACHINE_ERROR.test(message)||TRANSIENT_INFRASTRUCTURE_ERROR.test(message))return fallback
  return publicErrorMessage(message, fallback)
}

export function readableErrorMessage(value, seen = new Set()) {
  if (typeof value === 'string' || typeof value === 'number') {
    const message = text(value)
    return OBJECT_STRING.test(message) ? '' : message
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return ''

  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = readableErrorMessage(item, seen)
      if (message) return message
    }
    return ''
  }

  for (const key of ['error','message','msg','details','detail','hint']) {
    const message = readableErrorMessage(value[key], seen)
    if (message) return message
  }
  return ''
}

function bodyMessage(body) {
  return readableErrorMessage(body)
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
  if (direct) return publicErrorMessage(direct, fallback)

  const contextual = bodyMessage(await responseBody(error?.context))
  if (contextual) return publicErrorMessage(contextual, fallback)

  const sdkMessage = readableErrorMessage(error?.message)
  return sdkMessage && !GENERIC_EDGE_FUNCTION_ERROR.test(sdkMessage)
    ? publicErrorMessage(sdkMessage, fallback)
    : fallback
}
