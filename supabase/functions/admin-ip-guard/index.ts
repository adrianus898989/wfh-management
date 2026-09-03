import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import {
  bearerToken,
  jwtSessionId,
  jwtUserId,
  trustedClientIp,
} from '../_shared/adminIp.ts'
import { corsGate, corsHeaders } from '../_shared/corsOrigin.ts'
const DEPENDENCY_TIMEOUT_MS = 8_000

function timedFetch(timeoutMs: number) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const controller = new AbortController()
    const upstreamSignal = init.signal
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason)
    if (upstreamSignal?.aborted) abortFromUpstream()
    else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetch(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
      upstreamSignal?.removeEventListener('abort', abortFromUpstream)
    }
  }
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

function safeMeta(error: any) {
  return {
    name: String(error?.name || 'Error').slice(0, 64),
    code: String(error?.code || '').slice(0, 64) || null,
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
  }
}

export async function handleRequest(req: Request) {
  const corsResponse = corsGate(req)
  if (corsResponse) return corsResponse
  if (req.method !== 'POST') return json(req, { ok: false, reason: 'method_not_allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
  const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
  const secretKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const publishableKey = publishableKeys.default || Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !secretKey || !publishableKey) {
    return json(req, { ok: false, reason: 'guard_unavailable' }, 503)
  }

  const authorization = req.headers.get('Authorization') || ''
  const token = bearerToken(authorization)
  const sessionId = jwtSessionId(token)
  const userId = jwtUserId(token)
  if (
    !token ||
    !/^[0-9a-f-]{36}$/i.test(sessionId) ||
    !/^[0-9a-f-]{36}$/i.test(userId)
  ) {
    return json(req, { ok: false, reason: 'auth_session_missing' }, 401)
  }

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch {}
  const action = String(body?.action || 'heartbeat').trim().toLowerCase()
  const portal = String(body?.portal || 'admin').trim().toLowerCase()
  if (!['claim', 'heartbeat'].includes(action)) {
    return json(req, { ok: false, reason: 'invalid_action' }, 400)
  }
  if (portal !== 'admin' && portal !== 'staff') {
    return json(req, { ok: false, reason: 'invalid_portal' }, 400)
  }

  const boundedFetch = timedFetch(DEPENDENCY_TIMEOUT_MS)
  const admin = createClient(supabaseUrl, secretKey, {
    global: { fetch: boundedFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const clientIp = trustedClientIp(req)
  const attestationRpc = portal === 'staff'
    ? 'staff_ip_session_attest'
    : 'admin_ip_session_attest'
  const { data: guard, error: guardError } = await admin.rpc(attestationRpc, {
    // The hosted Functions gateway verifies this JWT before invocation. The
    // RPC independently requires this exact user/session pair in auth.sessions,
    // so a separate Auth /user round-trip only amplifies heartbeat incidents.
    p_user_id: userId,
    p_session_id: sessionId,
    p_client_ip: clientIp || null,
    p_source: action,
  })
  if (guardError) {
    console.error('PORTAL_IP_GUARD_ATTEST_ERROR', { portal, ...safeMeta(guardError) })
    return json(req, { ok: false, reason: 'guard_unavailable' }, 503)
  }
  if (!guard?.ok) {
    return json(req, {
      ok: false,
      reason: guard?.reason || 'ip_not_allowed',
      // Do not forward the privileged RPC payload. It also contains matching
      // metadata (for example the observed IP and entry id) that the browser
      // does not need in order to handle an access denial.
      ip_guard: {
        enforced: Boolean(guard?.enforced),
        effective: Boolean(guard?.effective),
        reason: guard?.reason || 'ip_not_allowed',
      },
    }, 403)
  }

  const userClient = createClient(supabaseUrl, publishableKey, {
    global: {
      fetch: boundedFetch,
      headers: { Authorization: authorization },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const leaseResult = action === 'claim'
    ? await userClient.rpc('app_session_claim', { p_portal: portal })
    : await userClient.rpc('app_session_heartbeat')

  if (leaseResult.error) {
    console.error('PORTAL_IP_GUARD_LEASE_ERROR', { portal, ...safeMeta(leaseResult.error) })
    return json(req, { ok: false, reason: 'session_check_unavailable' }, 503)
  }

  const lease = leaseResult.data || { ok: false, reason: 'session_rejected' }
  return json(req, {
    ...lease,
    ip_guard: {
      enforced: Boolean(guard.enforced),
      effective: Boolean(guard.effective),
      reason: guard.reason,
    },
  }, lease.ok ? 200 : 403)
}

if (import.meta.main) Deno.serve(handleRequest)
