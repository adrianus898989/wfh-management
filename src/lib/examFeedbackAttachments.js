import {
  ACCEPTED_EXAM_ANSWER_IMAGE_TYPES,
  MAX_EXAM_ANSWER_IMAGE_BYTES,
  cleanExamAttachment,
  optimiseExamAnswerImage,
  safeExamAttachmentFileName,
} from './examAnswerAttachments.js'

export const EXAM_FEEDBACK_BUCKET = 'exam-feedback-images'
export const MAX_EXAM_FEEDBACK_ATTACHMENTS = 3
export const MAX_EXAM_FEEDBACK_IMAGE_BYTES = MAX_EXAM_ANSWER_IMAGE_BYTES
export const ACCEPTED_EXAM_FEEDBACK_IMAGE_TYPES = [...ACCEPTED_EXAM_ANSWER_IMAGE_TYPES]

const text = value => String(value ?? '').trim()

export const safeFeedbackImageName = name => safeExamAttachmentFileName(name)

export const feedbackImageExtension = file => {
  const type = text(file?.type).toLowerCase()
  const byType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  }[type]
  if (byType) return byType
  return safeFeedbackImageName(file?.name).match(/\.(jpe?g|png|webp|gif)$/i)?.[1]?.toLowerCase() || ''
}

export function cleanExamFeedbackAttachment(item) {
  const clean = cleanExamAttachment(item)
  if (!clean
    || clean.size > MAX_EXAM_FEEDBACK_IMAGE_BYTES
    || !ACCEPTED_EXAM_FEEDBACK_IMAGE_TYPES.includes(clean.type)) return null
  return clean
}

export function storedExamFeedbackAttachments(value) {
  const unique = new Map()
  for (const candidate of Array.isArray(value) ? value : []) {
    const item = cleanExamFeedbackAttachment(candidate)
    if (!item || unique.has(item.path)) continue
    unique.set(item.path, {
      path:item.path,
      name:item.name,
      size:item.size,
      type:item.type,
    })
    if (unique.size >= MAX_EXAM_FEEDBACK_ATTACHMENTS) break
  }
  return [...unique.values()]
}

function signedUrlMap(rows) {
  const urls = new Map()
  for (const row of rows || []) {
    const path = text(row?.path)
    const url = text(row?.signedUrl || row?.signedURL)
    if (path && url) urls.set(path, url)
  }
  return urls
}

async function signUniqueFeedbackPaths(client, paths, expiresIn) {
  const unique = [...new Set(paths.map(text).filter(Boolean))]
  if (!unique.length) return new Map()
  const { data, error } = await client.storage
    .from(EXAM_FEEDBACK_BUCKET)
    .createSignedUrls(unique, expiresIn)
  if (error) throw error
  return signedUrlMap(data)
}

export async function signExamFeedbackAttachments(client, attachments, expiresIn = 300) {
  const stored = storedExamFeedbackAttachments(attachments)
  const urls = await signUniqueFeedbackPaths(client, stored.map(item => item.path), expiresIn)
  return stored.map(item => ({ ...item, url:urls.get(item.path) || '' }))
}

export async function hydrateExamFeedbackAttachments(client, attachments, expiresIn = 300) {
  return signExamFeedbackAttachments(client, attachments, expiresIn)
}

export async function hydrateExamFeedbackAnswers(client, answers, expiresIn = 300) {
  const rows = Array.isArray(answers) ? answers : []
  const normalized = rows.map(row => ({
    ...row,
    grader_feedback_attachments:storedExamFeedbackAttachments(row?.grader_feedback_attachments),
  }))
  const urls = await signUniqueFeedbackPaths(
    client,
    normalized.flatMap(row => row.grader_feedback_attachments.map(item => item.path)),
    expiresIn,
  )
  return normalized.map(row => ({
    ...row,
    grader_feedback_attachments:row.grader_feedback_attachments.map(item => ({
      ...item,
      url:urls.get(item.path) || '',
    })),
  }))
}

export const optimiseExamFeedbackImage = file => optimiseExamAnswerImage(file)
