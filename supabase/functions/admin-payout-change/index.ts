import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import {
  errorResponse,
  normalizeDeleteRequest,
  normalizeProofPaths,
} from './protocol.js'

const allowedOrigin = 'https://adrianus898989.github.io'
const PROOF_BUCKET = 'payment-change-proof'

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin === allowedOrigin ? origin : allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(req.headers.get('origin')),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function tokenFrom(req: Request) {
  return (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
}

function jwtSessionId(token: string) {
  try {
    const raw = token.split('.')[1]?.replaceAll('-', '+').replaceAll('_', '/') || ''
    const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=')
    return String(JSON.parse(atob(padded))?.session_id || '').trim()
  } catch {
    return ''
  }
}

function envJson(name: string) {
  try {
    return JSON.parse(Deno.env.get(name) || '{}')
  } catch {
    return {}
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req.headers.get('origin')) })
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed', code: 'method_not_allowed', retryable: false }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const secretKeys = envJson('SUPABASE_SECRET_KEYS')
    const publishableKeys = envJson('SUPABASE_PUBLISHABLE_KEYS')
    const serviceKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const publishableKey = publishableKeys.default || Deno.env.get('SUPABASE_ANON_KEY') || ''
    if (!supabaseUrl || !serviceKey || !publishableKey) {
      return json(req, { error: '删除服务配置缺失', code: 'service_not_configured', retryable: false }, 500)
    }

    const token = tokenFrom(req)
    const sessionId = jwtSessionId(token)
    if (!token || !sessionId) {
      return json(req, { error: '登录已失效', code: 'not_authenticated', retryable: false }, 401)
    }

    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) {
      return json(req, { error: '登录已失效', code: 'not_authenticated', retryable: false }, 401)
    }

    const input = normalizeDeleteRequest(await req.json())
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: prepared, error: prepareError } = await userClient.rpc(
      'admin_prepare_payout_change_request_delete_v1',
      {
        p_request_id: input.requestId,
        p_reason: input.reason,
        p_confirmation: input.confirmation,
      },
    )
    if (prepareError) throw prepareError
    if (prepared?.already_deleted) {
      return json(req, {
        ok: true,
        request_id: prepared.request_id,
        employee_id: prepared.employee_id,
        employee_no: prepared.employee_no,
        employee_name: prepared.employee_name,
        proof_files_deleted: Number(prepared.proof_file_count || 0),
        already_deleted: true,
      })
    }

    const paths = normalizeProofPaths(input.requestId, prepared?.proof_paths)
    if (paths.length) {
      const { error: storageError } = await admin.storage.from(PROOF_BUCKET).remove(paths)
      if (storageError) {
        console.error('payout change proof delete failed', {
          requestId: input.requestId,
          operationId: prepared?.operation_id,
          status: storageError.status,
          code: storageError.name,
        })
        const mapped = errorResponse(storageError)
        return json(req, {
          error: mapped.error,
          code: 'proof_delete_failed',
          retryable: mapped.status >= 500 || mapped.retryable,
        }, mapped.status >= 500 ? mapped.status : 409)
      }
    }

    const { data: finalized, error: finalizeError } = await userClient.rpc(
      'admin_finalize_payout_change_request_delete_v1',
      {
        p_operation_id: prepared.operation_id,
        p_request_id: input.requestId,
      },
    )
    if (finalizeError) {
      console.error('payout change delete finalize failed after storage cleanup', {
        requestId: input.requestId,
        operationId: prepared?.operation_id,
        code: finalizeError.code,
      })
      const mapped = errorResponse(finalizeError)
      if (!['delete_failed', 'service_temporarily_unavailable'].includes(mapped.code)) {
        return json(req, {
          error: mapped.error,
          code: mapped.code,
          retryable: mapped.retryable,
        }, mapped.status)
      }
      return json(req, {
        error: '证明文件已安全清理，记录删除正在完成；请使用相同内容重试',
        code: mapped.code === 'delete_failed' ? 'finalize_retry_required' : mapped.code,
        retryable: true,
        operation_id: prepared.operation_id,
      }, mapped.status >= 500 ? mapped.status : 409)
    }

    return json(req, {
      ok: true,
      request_id: finalized.request_id,
      employee_id: finalized.employee_id,
      employee_no: finalized.employee_no,
      employee_name: finalized.employee_name,
      proof_files_deleted: Number(finalized.proof_file_count || paths.length),
      already_deleted: Boolean(finalized.already_deleted),
    })
  } catch (error) {
    console.error('admin-payout-change failed', {
      code: (error as any)?.code,
      status: (error as any)?.status,
    })
    const mapped = errorResponse(error)
    return json(req, {
      error: mapped.error,
      code: mapped.code,
      retryable: mapped.retryable,
    }, mapped.status)
  }
})
