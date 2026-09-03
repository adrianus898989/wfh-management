import { publicPreflightPayload } from '../admin-ip-preflight/protocol.ts'
import {
  PORTAL_IP_GATE_MAX_BODY_BYTES,
  verifyPortalIpGateRequest,
  type Portal,
} from './protocol.ts'

type Lookup = (portal: Portal, clientIp: string) => Promise<unknown>
type ReadSecret = (name: string) => string

const responseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private, max-age=0',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
}

function unavailable(reason: string) {
  return { allowed: false, enforced: false, reason }
}

function json(body: ReturnType<typeof unavailable>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

export function createPortalIpEdgeGateHandler({
  lookup,
  readSecret,
  now = Date.now,
}: {
  lookup: Lookup
  readSecret: ReadSecret
  now?: () => number
}) {
  return async function handleRequest(req: Request) {
    // This endpoint is exclusively server-to-server. Browser requests must not
    // gain CORS access even if they can discover the public function URL.
    if (req.headers.has('origin')) return json(unavailable('browser_not_allowed'), 403)
    if (req.method !== 'POST') return json(unavailable('method_not_allowed'), 405)

    const contentType = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') return json(unavailable('invalid_request'), 400)

    const declaredLength = Number(req.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > PORTAL_IP_GATE_MAX_BODY_BYTES) {
      return json(unavailable('invalid_request'), 400)
    }

    let bodyText = ''
    try { bodyText = await req.text() } catch { return json(unavailable('invalid_request'), 400) }

    const verification = await verifyPortalIpGateRequest({
      bodyText,
      timestamp: req.headers.get('x-pages-ip-gate-timestamp') || '',
      signature: req.headers.get('x-pages-ip-gate-signature') || '',
      adminSecret: readSecret('PAGES_ADMIN_IP_GATE_SECRET'),
      staffSecret: readSecret('PAGES_STAFF_IP_GATE_SECRET'),
      now: now(),
    })
    if (!verification.ok) {
      const status = verification.reason === 'service_unavailable'
        ? 503
        : verification.reason === 'invalid_request' || verification.reason === 'invalid_timestamp'
          ? 400
          : 401
      return json(unavailable(verification.reason), status)
    }

    try {
      const gate = await lookup(verification.value.portal, verification.value.clientIp)
      const payload = publicPreflightPayload(gate)
      const status = payload.reason === 'service_unavailable' ? 503 : 200
      return json(payload, status)
    } catch {
      return json(unavailable('service_unavailable'), 503)
    }
  }
}
