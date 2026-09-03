export const EXAM_ANSWER_BUCKET = 'exam-answer-images'
export const MAX_EXAM_ANSWER_ATTACHMENTS = 6
export const MAX_EXAM_ANSWER_IMAGE_BYTES = 4 * 1024 * 1024
export const ACCEPTED_EXAM_ANSWER_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

const MAX_IMAGE_EDGE = 1600
const text = value => String(value ?? '').trim()

export const safeExamAttachmentFileName = name => (
  text(name)
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'answer-image'
).slice(0, 240)

export function cleanExamAttachment(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const path = text(item.path)
  const name = text(item.name)
  const size = Number(item.size || 0)
  const type = text(item.type).toLowerCase()
  if (!path || !name || name.length > 255 || !Number.isFinite(size) || size <= 0 || size > MAX_EXAM_ANSWER_IMAGE_BYTES || !ACCEPTED_EXAM_ANSWER_IMAGE_TYPES.includes(type)) return null
  const clean = { path, name, size: Math.round(size), type }
  const url = text(item.url)
  return url ? { ...clean, url } : clean
}

export function storedExamAttachments(value) {
  const unique = new Map()
  for (const candidate of Array.isArray(value) ? value : []) {
    const item = cleanExamAttachment(candidate)
    if (!item || unique.has(item.path)) continue
    unique.set(item.path, { path: item.path, name: item.name, size: item.size, type: item.type })
    if (unique.size >= MAX_EXAM_ANSWER_ATTACHMENTS) break
  }
  return [...unique.values()]
}

export const answerIsComplete = (answer, attachments) => Boolean(
  text(answer) || storedExamAttachments(attachments).length,
)

function signedUrlMap(rows) {
  const urls = new Map()
  for (const row of rows || []) {
    const path = text(row?.path)
    const url = text(row?.signedUrl || row?.signedURL)
    if (path && url) urls.set(path, url)
  }
  return urls
}

async function signUniquePaths(client, paths, expiresIn) {
  const unique = [...new Set(paths.map(text).filter(Boolean))]
  if (!unique.length) return new Map()
  const { data, error } = await client.storage
    .from(EXAM_ANSWER_BUCKET)
    .createSignedUrls(unique, expiresIn)
  if (error) throw error
  const urls = signedUrlMap(data)
  return urls
}

export async function signExamAttachments(client, attachments, expiresIn = 300) {
  const stored = storedExamAttachments(attachments)
  const urls = await signUniquePaths(client, stored.map(item => item.path), expiresIn)
  return stored.map(item => ({ ...item, url: urls.get(item.path) || '' }))
}

export async function signExamAttachmentMap(client, value, expiresIn = 300) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const normalized = Object.fromEntries(
    Object.entries(input).map(([questionId, attachments]) => [questionId, storedExamAttachments(attachments)]),
  )
  const urls = await signUniquePaths(
    client,
    Object.values(normalized).flatMap(attachments => attachments.map(item => item.path)),
    expiresIn,
  )
  return Object.fromEntries(Object.entries(normalized).map(([questionId, attachments]) => [
    questionId,
    attachments.map(item => ({ ...item, url: urls.get(item.path) || '' })),
  ]))
}

export async function hydrateExamAnswersAttachments(client, answers, expiresIn = 300) {
  const rows = Array.isArray(answers) ? answers : []
  const normalized = rows.map(row => ({ ...row, attachments: storedExamAttachments(row?.attachments) }))
  const urls = await signUniquePaths(
    client,
    normalized.flatMap(row => row.attachments.map(item => item.path)),
    expiresIn,
  )
  return normalized.map(row => ({
    ...row,
    attachments: row.attachments.map(item => ({ ...item, url: urls.get(item.path) || '' })),
  }))
}

export async function optimiseExamAnswerImage(file) {
  if (!file || file.type === 'image/gif' || typeof createImageBitmap !== 'function') return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size <= MAX_EXAM_ANSWER_IMAGE_BYTES) {
      bitmap.close()
      return file
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.82))
    if (!blob || blob.size >= file.size) return file
    const base = safeExamAttachmentFileName(file.name).replace(/\.[^.]+$/, '') || 'answer-image'
    return new File([blob], `${base}.webp`, { type: 'image/webp', lastModified: file.lastModified })
  } catch {
    return file
  }
}
