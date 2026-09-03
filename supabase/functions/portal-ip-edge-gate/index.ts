import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import { createPortalIpEdgeGateHandler } from './handler.ts'
import type { Portal } from './protocol.ts'

// Deployment contract: deploy with verify_jwt=false. Authentication is the
// portal-specific, time-bounded HMAC verified by the handler before this
// service-role dependency is called.
const DEPENDENCY_TIMEOUT_MS = 5_000

function timedFetch(timeoutMs: number) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const controller = new AbortController()
    const upstreamSignal = init.signal
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason)
    if (upstreamSignal?.aborted) abortFromUpstream()
    else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetch(input, { ...init, cache: 'no-store', signal: controller.signal })
    } finally {
      clearTimeout(timer)
      upstreamSignal?.removeEventListener('abort', abortFromUpstream)
    }
  }
}

function serviceRoleKey() {
  try {
    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
    return secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  } catch {
    return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  }
}

let adminClient: ReturnType<typeof createClient> | null = null

function admin() {
  if (adminClient) return adminClient
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const secretKey = serviceRoleKey()
  if (!supabaseUrl || !secretKey) throw new Error('service_unavailable')
  adminClient = createClient(supabaseUrl, secretKey, {
    global: { fetch: timedFetch(DEPENDENCY_TIMEOUT_MS) },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return adminClient
}

async function lookup(portal: Portal, clientIp: string) {
  const { data, error } = await admin().rpc('portal_ip_prelogin_check', {
    p_portal: portal,
    p_client_ip: clientIp,
  })
  if (error) throw error
  return data
}

export const handleRequest = createPortalIpEdgeGateHandler({
  lookup,
  readSecret: name => Deno.env.get(name) || '',
})

if (import.meta.main) Deno.serve(handleRequest)
