import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import { trustedClientIp } from '../_shared/adminIp.ts'
import { corsGate, corsHeaders } from '../_shared/corsOrigin.ts'
import {
  publicPreflightPayload,
  unavailablePreflight,
} from './protocol.ts'

// Deployment contract: this pre-authentication endpoint must use
// verify_jwt=false. It authenticates its database dependency with the Edge-only
// service role and accepts no client-supplied IP value.
const DEPENDENCY_TIMEOUT_MS = 8_000
const corsOptions = { maxAgeSeconds: 600 }

function timedFetch(timeoutMs: number) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const controller = new AbortController()
    const upstreamSignal = init.signal
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason)
    if (upstreamSignal?.aborted) abortFromUpstream()
    else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetch(input, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
      upstreamSignal?.removeEventListener('abort', abortFromUpstream)
    }
  }
}

function responseHeaders(req: Request) {
  return {
    ...corsHeaders(req, corsOptions),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private, max-age=0',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  }
}

function json(req: Request, body: ReturnType<typeof unavailablePreflight>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(req),
  })
}

function safeMeta(error: any) {
  const status = Number(error?.status)
  return {
    name: String(error?.name || 'Error').slice(0, 64),
    code: String(error?.code || '').slice(0, 64) || null,
    status: Number.isFinite(status) ? status : null,
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

export async function handleRequest(req: Request) {
  const corsResponse = corsGate(req, corsOptions)
  if (corsResponse) return corsResponse
  if (req.method !== 'POST') {
    return json(req, unavailablePreflight('method_not_allowed'), 405)
  }

  let requestBody: Record<string, unknown> = {}
  try { requestBody = await req.json() } catch {}
  const portal = String(requestBody?.portal || 'admin').trim().toLowerCase()
  if (portal !== 'admin' && portal !== 'staff') {
    return json(req, unavailablePreflight('invalid_portal'), 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const secretKey = serviceRoleKey()
  if (!supabaseUrl || !secretKey) {
    return json(req, unavailablePreflight(), 503)
  }

  try {
    const admin = createClient(supabaseUrl, secretKey, {
      global: { fetch: timedFetch(DEPENDENCY_TIMEOUT_MS) },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const clientIp = trustedClientIp(req)
    const { data: gate, error } = await admin.rpc('portal_ip_prelogin_check', {
      p_portal: portal,
      p_client_ip: clientIp || null,
    })

    if (error) {
      console.error('ADMIN_IP_PREFLIGHT_DEPENDENCY_ERROR', safeMeta(error))
      return json(req, unavailablePreflight(), 503)
    }

    const payload = publicPreflightPayload(gate)
    const status = payload.reason === 'service_unavailable' ? 503 : 200
    return json(req, payload, status)
  } catch (error) {
    console.error('ADMIN_IP_PREFLIGHT_ERROR', safeMeta(error))
    return json(req, unavailablePreflight(), 503)
  }
}

if (import.meta.main) Deno.serve(handleRequest)
