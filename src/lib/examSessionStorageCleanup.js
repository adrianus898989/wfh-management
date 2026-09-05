import { EXAM_ANSWER_BUCKET } from './examAnswerAttachments.js'
import { EXAM_FEEDBACK_BUCKET } from './examFeedbackAttachments.js'

export const EXAM_DELETED_SESSION_CLEANUP_RPC = 'admin_exam_deleted_session_storage_cleanup'
export const EXAM_PENDING_STORAGE_CLEANUP_RPC = 'admin_exam_pending_storage_cleanup'
export const EXAM_STORAGE_CLEANUP_STATUS_RPC = 'admin_exam_storage_cleanup_status'
export const EXAM_STORAGE_CLEANUP_PRUNE_RPC = 'admin_exam_prune_storage_cleanup'
export const EXAM_PENDING_STORAGE_CLEANUP_LIMIT = 20

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const IMAGE_OBJECT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|jpeg|png|webp|gif)$/
const bucketSpecs = [
  { bucket:EXAM_ANSWER_BUCKET, maxPaths:112 },
  { bucket:EXAM_FEEDBACK_BUCKET, maxPaths:70 },
]
const text = value => String(value ?? '').trim()
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function canonicalSessionId(value) {
  const sessionId = text(value).toLowerCase()
  if (!UUID_PATTERN.test(sessionId)) throw new Error('deleted_exam_cleanup_session_invalid')
  return sessionId
}

function validatedPaths(value, { maxPaths }, sessionId) {
  if (!Array.isArray(value) || value.length > maxPaths) {
    throw new Error('deleted_exam_cleanup_plan_invalid')
  }
  const seen = new Set()
  return value.map(path => {
    if (typeof path !== 'string' || path !== path.trim() || seen.has(path)) {
      throw new Error('deleted_exam_cleanup_path_invalid')
    }
    const parts = path.split('/')
    if (parts.length !== 4
      || !UUID_PATTERN.test(parts[0])
      || parts[1] !== sessionId
      || !UUID_PATTERN.test(parts[2])
      || !IMAGE_OBJECT_PATTERN.test(parts[3])) {
      throw new Error('deleted_exam_cleanup_path_invalid')
    }
    seen.add(path)
    return path
  })
}

function pendingCleanupResult(attempted = 0, failedBuckets = [], remaining = attempted) {
  return {
    ok:false,
    attempted,
    remaining,
    failedBuckets:[...new Set(failedBuckets)],
  }
}

export function examSessionStorageCleanupPlan(payload, expectedSessionId = payload?.deleted_session_id) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('deleted_exam_cleanup_plan_invalid')
  }
  const sessionId = canonicalSessionId(expectedSessionId)
  if (canonicalSessionId(payload.deleted_session_id) !== sessionId) {
    throw new Error('deleted_exam_cleanup_session_mismatch')
  }
  const cleanup = payload.storage_cleanup
  if (!cleanup || typeof cleanup !== 'object' || Array.isArray(cleanup)) {
    throw new Error('deleted_exam_cleanup_plan_invalid')
  }
  return bucketSpecs.map(spec => {
    if (!Object.prototype.hasOwnProperty.call(cleanup, spec.bucket)) {
      throw new Error('deleted_exam_cleanup_plan_invalid')
    }
    return {
      bucket:spec.bucket,
      paths:validatedPaths(cleanup[spec.bucket], spec, sessionId),
    }
  })
}

export async function recoverDeletedExamSessionStorageCleanup(client, sessionId) {
  const expectedSessionId = canonicalSessionId(sessionId)
  const { data, error } = await client.rpc(EXAM_DELETED_SESSION_CLEANUP_RPC, {
    p_session_id:expectedSessionId,
  })
  if (error) throw error
  if (!data?.ok) throw new Error('deleted_exam_cleanup_recovery_invalid')
  examSessionStorageCleanupPlan(data, expectedSessionId)
  return data
}

export async function recoverQueuedExamSessionStorageCleanup(client, sessionId) {
  const expectedSessionId = canonicalSessionId(sessionId)
  const { data, error } = await client.rpc(EXAM_STORAGE_CLEANUP_STATUS_RPC, {
    p_session_id:expectedSessionId,
  })
  if (error) throw error
  if (!data?.ok) throw new Error('exam_cleanup_status_invalid')
  examSessionStorageCleanupPlan(data, expectedSessionId)
  return data
}

async function pruneRemovedExamSessionStorageCleanup(client) {
  try {
    const { data, error } = await client.rpc(EXAM_STORAGE_CLEANUP_PRUNE_RPC, { p_limit:200 })
    return !error && data?.ok === true
  } catch {
    return false
  }
}

export async function removeExamSessionStorageCleanup(client, payload, expectedSessionId = payload?.deleted_session_id) {
  const sessionId = canonicalSessionId(expectedSessionId)
  const plan = examSessionStorageCleanupPlan(payload, sessionId)
  const actionable = plan.filter(item => item.paths.length)
  const results = await Promise.all(actionable.map(async item => {
    try {
      const { error } = await client.storage.from(item.bucket).remove(item.paths)
      return { ...item, error:error || null }
    } catch (error) {
      return { ...item, error }
    }
  }))
  const removeFailures = results.filter(item => item.error).map(item => item.bucket)
  const attempted = actionable.reduce((count, item) => count + item.paths.length, 0)

  try {
    const verification = await recoverQueuedExamSessionStorageCleanup(client, sessionId)
    const remainingPlan = examSessionStorageCleanupPlan(verification, sessionId)
    const remainingBuckets = remainingPlan.filter(item => item.paths.length).map(item => item.bucket)
    const remaining = remainingPlan.reduce((count, item) => count + item.paths.length, 0)
    return remaining === 0
      ? { ok:true, attempted, remaining:0, failedBuckets:[] }
      : pendingCleanupResult(attempted, [...removeFailures, ...remainingBuckets], remaining)
  } catch {
    return pendingCleanupResult(attempted, removeFailures.length ? removeFailures : plan.map(item => item.bucket), attempted)
  }
}

export async function retryDeletedExamSessionStorageCleanup(client, sessionId) {
  const data = await recoverDeletedExamSessionStorageCleanup(client, sessionId)
  const cleanup = await removeExamSessionStorageCleanup(client, data, sessionId)
  return { data, cleanup }
}

async function recoverAfterUncertainDelete(client, sessionId, retryDelayMs) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0 && retryDelayMs > 0) await delay(retryDelayMs)
    try {
      return await recoverDeletedExamSessionStorageCleanup(client, sessionId)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export async function deleteExamSessionWithStorageCleanup(client, {
  sessionId,
  confirmation,
  recoveryRetryDelayMs = 250,
}) {
  const expectedSessionId = canonicalSessionId(sessionId)
  let data
  let recovered = false
  let deleteError = null
  let databaseDeleteConfirmed = false

  try {
    const result = await client.rpc('admin_exam_delete_current_session', {
      p_session_id:expectedSessionId,
      p_confirmation:confirmation,
    })
    if (result.error) throw result.error
    data = result.data
    if (!data?.ok || canonicalSessionId(data?.deleted_session_id) !== expectedSessionId) {
      throw new Error('exam_delete_result_invalid')
    }
    databaseDeleteConfirmed = true
  } catch (error) {
    deleteError = error
  }

  if (!databaseDeleteConfirmed) {
    try {
      data = await recoverAfterUncertainDelete(client, expectedSessionId, recoveryRetryDelayMs)
      recovered = true
      databaseDeleteConfirmed = true
    } catch {
      throw deleteError
    }
  }

  try {
    examSessionStorageCleanupPlan(data, expectedSessionId)
  } catch {
    try {
      data = await recoverDeletedExamSessionStorageCleanup(client, expectedSessionId)
      recovered = true
    } catch {
      return {
        data,
        recovered,
        cleanup:pendingCleanupResult(0, bucketSpecs.map(item => item.bucket), 0),
      }
    }
  }

  const cleanup = await removeExamSessionStorageCleanup(client, data, expectedSessionId)
  return { data, recovered, cleanup }
}

export async function drainPendingDeletedExamSessionStorageCleanup(client, limit = EXAM_PENDING_STORAGE_CLEANUP_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > EXAM_PENDING_STORAGE_CLEANUP_LIMIT) {
    throw new Error('deleted_exam_pending_cleanup_limit_invalid')
  }
  await pruneRemovedExamSessionStorageCleanup(client)
  const { data, error } = await client.rpc(EXAM_PENDING_STORAGE_CLEANUP_RPC, { p_limit:limit })
  if (error) throw error
  if (!data?.ok || !Array.isArray(data.items) || data.items.length > limit) {
    throw new Error('deleted_exam_pending_cleanup_invalid')
  }

  const results = []
  for (const item of data.items) {
    const sessionId = canonicalSessionId(item?.deleted_session_id)
    examSessionStorageCleanupPlan(item, sessionId)
    const cleanup = await removeExamSessionStorageCleanup(client, item, sessionId)
    results.push({ sessionId, cleanup })
  }
  await pruneRemovedExamSessionStorageCleanup(client)
  return {
    attemptedSessions:results.length,
    cleanedSessions:results.filter(item => item.cleanup.ok).length,
    pendingSessions:results.filter(item => !item.cleanup.ok).length,
    hasMore:Boolean(data.has_more),
    results,
  }
}
