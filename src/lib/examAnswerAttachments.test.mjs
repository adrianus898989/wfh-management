import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACCEPTED_EXAM_ANSWER_IMAGE_TYPES,
  EXAM_ANSWER_BUCKET,
  MAX_EXAM_ANSWER_ATTACHMENTS,
  MAX_EXAM_ANSWER_IMAGE_BYTES,
  answerIsComplete,
  hydrateExamAnswersAttachments,
  safeExamAttachmentFileName,
  signExamAttachmentMap,
  storedExamAttachments,
} from './examAnswerAttachments.js'

const attachment = (number, extra = {}) => ({
  path: `user/session/question/${number}.png`,
  name: `proof-${number}.png`,
  size: 1000 + number,
  type: 'image/png',
  ...extra,
})

function fakeClient({ omitLast = false } = {}) {
  const calls = []
  return {
    calls,
    storage: {
      from(bucket) {
        assert.equal(bucket, EXAM_ANSWER_BUCKET)
        return {
          async createSignedUrls(paths, expiresIn) {
            calls.push({ paths, expiresIn })
            return {
              data: (omitLast ? paths.slice(0, -1) : paths).map(path => ({ path, signedUrl: `https://signed.test/${path}` })),
              error: null,
            }
          },
        }
      },
    },
  }
}

test('stored attachments are validated, deduplicated, capped and never retain signed URLs', () => {
  const input = Array.from({ length: 8 }, (_, index) => attachment(index + 1, { url: 'https://stale.test/token' }))
  input.splice(2, 0, attachment(1), attachment(99, { type: 'application/pdf' }))
  const result = storedExamAttachments(input)
  assert.equal(result.length, MAX_EXAM_ANSWER_ATTACHMENTS)
  assert.deepEqual(result.map(item => item.path), [1, 2, 3, 4, 5, 6].map(number => attachment(number).path))
  assert.ok(result.every(item => !Object.hasOwn(item, 'url')))
  assert.deepEqual(ACCEPTED_EXAM_ANSWER_IMAGE_TYPES, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
})

test('attachment metadata stays inside the database filename and size limits', () => {
  assert.equal(safeExamAttachmentFileName('收据 / proof?.png'), 'proof-.png')
  assert.equal(safeExamAttachmentFileName('x'.repeat(400)).length, 240)
  assert.deepEqual(storedExamAttachments([
    attachment(1, { size: MAX_EXAM_ANSWER_IMAGE_BYTES + 1 }),
    attachment(2, { name: 'x'.repeat(256) }),
    attachment(3),
  ]), [attachment(3)])
})

test('an image-only response counts as answered', () => {
  assert.equal(answerIsComplete('', []), false)
  assert.equal(answerIsComplete('complete text', []), true)
  assert.equal(answerIsComplete('   ', [attachment(1)]), true)
})

test('attachment maps are signed in one private-storage request', async () => {
  const client = fakeClient()
  const result = await signExamAttachmentMap(client, {
    q1: [attachment(1), attachment(2)],
    q2: [attachment(2), attachment(3)],
  })
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].expiresIn, 300)
  assert.deepEqual(client.calls[0].paths, [attachment(1).path, attachment(2).path, attachment(3).path])
  assert.equal(result.q1[0].url, `https://signed.test/${attachment(1).path}`)
  assert.equal(result.q2[0].url, `https://signed.test/${attachment(2).path}`)
})

test('admin answer hydration preserves rows and adds short-lived URLs', async () => {
  const client = fakeClient()
  const answers = [{ question_id: 'q1', answer_text: 'answer', attachments: [attachment(1)] }]
  const result = await hydrateExamAnswersAttachments(client, answers, 120)
  assert.equal(result[0].answer_text, 'answer')
  assert.equal(result[0].attachments[0].url, `https://signed.test/${attachment(1).path}`)
  assert.equal(client.calls[0].expiresIn, 120)
})

test('one missing signed URL keeps valid previews and leaves the failed item private', async () => {
  const client = fakeClient({ omitLast: true })
  const result = await signExamAttachmentMap(client, { q1: [attachment(1), attachment(2)] })
  assert.equal(result.q1[0].url, `https://signed.test/${attachment(1).path}`)
  assert.equal(result.q1[1].url, '')
  assert.notEqual(result.q1[1].path, result.q1[1].url)
})
