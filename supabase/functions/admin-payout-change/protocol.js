const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const clean = value => String(value ?? '').trim()

export function expectedDeleteConfirmation(employeeNo) {
  return `DELETE ${clean(employeeNo)}`
}

export function normalizeDeleteRequest(body) {
  const action = clean(body?.action)
  const requestId = clean(body?.request_id).toLowerCase()
  const reason = clean(body?.reason)
  const confirmation = clean(body?.confirmation)

  if (action !== 'delete_request') {
    throw Object.assign(new Error('不支持的操作'), { code: 'unknown_action', status: 400 })
  }
  if (!UUID_RE.test(requestId)) {
    throw Object.assign(new Error('申请记录 ID 无效'), { code: 'invalid_request_id', status: 400 })
  }
  if (reason.length < 5 || reason.length > 500) {
    throw Object.assign(new Error('请填写 5–500 字的删除原因'), { code: 'invalid_delete_reason', status: 400 })
  }
  if (!confirmation || confirmation.length > 160) {
    throw Object.assign(new Error('请输入页面要求的完整删除确认文字'), { code: 'invalid_confirmation', status: 400 })
  }

  return { action, requestId, reason, confirmation }
}

export function isSafeRequestProofPath(requestId, value) {
  const path = clean(value)
  if (!UUID_RE.test(clean(requestId)) || !path || path.includes('\\')) return false

  const segments = path.split('/')
  if (segments.length !== 3) return false
  const [ownerId, pathRequestId, fileName] = segments
  return UUID_RE.test(ownerId) &&
    pathRequestId.toLowerCase() === clean(requestId).toLowerCase() &&
    Boolean(fileName) && fileName !== '.' && fileName !== '..'
}

export function normalizeProofPaths(requestId, values) {
  const paths = [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))]
  if (paths.length > 2 || paths.some(path => !isSafeRequestProofPath(requestId, path))) {
    throw Object.assign(new Error('证明文件路径异常，已停止删除'), {
      code: 'unsafe_proof_path',
      status: 409,
    })
  }
  return paths
}

export function errorResponse(error) {
  const rawCode = clean(error?.code)
  const rawMessage = clean(error?.message || error)
  if (rawMessage === 'payout_change_proof_cleanup_incomplete') {
    return {
      status: 409,
      code: 'proof_cleanup_incomplete',
      error: '证明文件尚未完全清理，请重试',
      retryable: true,
    }
  }
  const known = {
    invalid_payout_change_delete_identity: [400, 'invalid_request', '删除请求无效，请刷新后重试'],
    invalid_payout_change_delete_finalize: [400, 'invalid_request', '删除请求无效，请刷新后重试'],
    backend_access_denied: [403, 'permission_denied', '无后台访问权限'],
    payout_change_delete_permission_denied: [403, 'permission_denied', '无删除修改工资信息记录的权限'],
    payout_change_delete_scope_denied: [403, 'scope_denied', '该申请不在当前账号的管理范围内'],
    payout_change_request_not_found: [404, 'request_not_found', '申请记录不存在或已被删除'],
    payout_change_delete_confirmation_mismatch: [409, 'confirmation_mismatch', '删除确认文字与当前员工 ID 不一致，请刷新后重试'],
    payout_change_delete_operation_in_progress: [409, 'delete_in_progress', '该记录正在由另一位管理员删除，请稍后刷新'],
    payout_change_delete_operation_not_found: [409, 'delete_operation_not_found', '删除操作已失效，请刷新后重试'],
    payout_change_delete_record_changed: [409, 'record_changed', '申请记录已发生变化，请刷新后重试'],
    invalid_payout_change_delete_reason: [400, 'invalid_delete_reason', '请填写 5–500 字的删除原因'],
    payout_change_proof_path_invalid: [409, 'unsafe_proof_path', '证明文件路径异常，已停止删除'],
    payout_change_proof_path_shared: [409, 'shared_proof_path', '证明文件仍被其他申请引用，已停止删除'],
    session_not_current: [401, 'session_not_current', '当前浏览器会话已失效，请重新登录'],
  }
  const mapped = known[rawMessage]
  if (mapped) return { status: mapped[0], code: mapped[1], error: mapped[2], retryable: false }

  const local = {
    unknown_action: [400, 'unknown_action', '不支持的操作'],
    invalid_request_id: [400, 'invalid_request_id', '申请记录 ID 无效'],
    invalid_delete_reason: [400, 'invalid_delete_reason', '请填写 5–500 字的删除原因'],
    invalid_confirmation: [400, 'invalid_confirmation', '请输入页面要求的完整删除确认文字'],
    unsafe_proof_path: [409, 'unsafe_proof_path', '证明文件路径异常，已停止删除'],
  }
  const localMapped = local[rawCode]
  if (localMapped) {
    return {
      status: localMapped[0],
      code: localMapped[1],
      error: localMapped[2],
      retryable: false,
    }
  }

  const status = Number(error?.status || error?.statusCode || error?.context?.status || 0)
  if (status >= 500 || rawCode === '57014' || /timeout|timed out|fetch failed|network|gateway|connection/i.test(rawMessage)) {
    return { status: 503, code: 'service_temporarily_unavailable', error: '删除服务暂时繁忙，请稍后重试', retryable: true }
  }
  return {
    status: status >= 400 && status < 500 ? status : 400,
    code: 'delete_failed',
    error: '删除失败，请刷新后重试',
    retryable: false,
  }
}
