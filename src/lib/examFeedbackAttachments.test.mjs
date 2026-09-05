import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  ACCEPTED_EXAM_FEEDBACK_IMAGE_TYPES,
  EXAM_FEEDBACK_BUCKET,
  MAX_EXAM_FEEDBACK_ATTACHMENTS,
  MAX_EXAM_FEEDBACK_IMAGE_BYTES,
  cleanExamFeedbackAttachment,
  feedbackImageExtension,
  hydrateExamFeedbackAnswers,
  hydrateExamFeedbackAttachments,
  optimiseExamFeedbackImage,
  safeFeedbackImageName,
  signExamFeedbackAttachments,
  storedExamFeedbackAttachments,
} from './examFeedbackAttachments.js'

const attachment = (number, extra = {}) => ({
  path:`grader/session/answer/${number}.png`,
  name:`feedback-${number}.png`,
  size:1000 + number,
  type:'image/png',
  ...extra,
})

function fakeClient({ omitLast = false, error = null } = {}) {
  const calls = []
  return {
    calls,
    storage:{
      from(bucket) {
        assert.equal(bucket, EXAM_FEEDBACK_BUCKET)
        return {
          async createSignedUrls(paths, expiresIn) {
            calls.push({ paths, expiresIn })
            return {
              data:(omitLast ? paths.slice(0, -1) : paths).map(path => ({
                path,
                signedUrl:`https://signed.test/${path}`,
              })),
              error,
            }
          },
        }
      },
    },
  }
}

test('feedback image policy stays separate, bounded and aligned with answer image safety rules', async () => {
  assert.equal(EXAM_FEEDBACK_BUCKET, 'exam-feedback-images')
  assert.equal(MAX_EXAM_FEEDBACK_ATTACHMENTS, 3)
  assert.equal(MAX_EXAM_FEEDBACK_IMAGE_BYTES, 4 * 1024 * 1024)
  assert.deepEqual(ACCEPTED_EXAM_FEEDBACK_IMAGE_TYPES, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

  const source = await readFile(new URL('./examFeedbackAttachments.js', import.meta.url), 'utf8')
  for (const reused of [
    'MAX_EXAM_ANSWER_IMAGE_BYTES',
    'ACCEPTED_EXAM_ANSWER_IMAGE_TYPES',
    'cleanExamAttachment',
    'optimiseExamAnswerImage',
    'safeExamAttachmentFileName',
  ]) assert.ok(source.includes(reused), `feedback helper should reuse ${reused}`)
})

test('feedback metadata is cleaned, deduplicated, capped and stripped of signed URLs before storage', () => {
  const input = [
    attachment(1, { url:'https://stale.test/token' }),
    attachment(1),
    attachment(2),
    attachment(3),
    attachment(4),
    attachment(9, { type:'image/svg+xml' }),
  ]
  assert.deepEqual(storedExamFeedbackAttachments(input), [attachment(1), attachment(2), attachment(3)])
  assert.equal(cleanExamFeedbackAttachment(attachment(1, { size:MAX_EXAM_FEEDBACK_IMAGE_BYTES + 1 })), null)
  assert.equal(cleanExamFeedbackAttachment(attachment(1, { name:'x'.repeat(256) })), null)
  assert.equal(cleanExamFeedbackAttachment(null), null)
})

test('feedback filenames, extensions and optimization reuse the safe answer-image behavior', async () => {
  assert.equal(safeFeedbackImageName('批改 / proof?.PNG'), 'proof-.PNG')
  assert.equal(safeFeedbackImageName('x'.repeat(400)).length, 240)
  assert.equal(feedbackImageExtension({ type:'image/jpeg', name:'scan.jpeg' }), 'jpg')
  assert.equal(feedbackImageExtension({ type:'IMAGE/WEBP', name:'scan.bin' }), 'webp')
  assert.equal(feedbackImageExtension({ type:'', name:'safe.GIF' }), 'gif')
  assert.equal(feedbackImageExtension({ type:'image/svg+xml', name:'unsafe.svg' }), '')

  const gif = { type:'image/gif', name:'proof.gif', size:50 }
  assert.equal(await optimiseExamFeedbackImage(gif), gif)
})

test('one feedback list is signed through the private feedback bucket', async () => {
  const client = fakeClient()
  const result = await hydrateExamFeedbackAttachments(client, [attachment(1), attachment(2)], 120)
  assert.equal(client.calls.length, 1)
  assert.deepEqual(client.calls[0], {
    paths:[attachment(1).path, attachment(2).path],
    expiresIn:120,
  })
  assert.equal(result[0].url, `https://signed.test/${attachment(1).path}`)
  assert.equal(result[1].url, `https://signed.test/${attachment(2).path}`)
})

test('answer hydration signs all unique feedback images in one request and preserves answer fields', async () => {
  const client = fakeClient()
  const rows = [
    { answer_id:'a1', grader_feedback:'See image', grader_feedback_attachments:[attachment(1), attachment(2)] },
    { answer_id:'a2', grader_feedback:'Also see image', grader_feedback_attachments:[attachment(2), attachment(3)] },
  ]
  const result = await hydrateExamFeedbackAnswers(client, rows)
  assert.equal(client.calls.length, 1)
  assert.deepEqual(client.calls[0].paths, [attachment(1).path, attachment(2).path, attachment(3).path])
  assert.equal(result[0].grader_feedback, 'See image')
  assert.equal(result[0].grader_feedback_attachments[0].url, `https://signed.test/${attachment(1).path}`)
  assert.equal(result[1].grader_feedback_attachments[0].url, `https://signed.test/${attachment(2).path}`)
})

test('missing signed URLs never expose a private path as an image URL', async () => {
  const client = fakeClient({ omitLast:true })
  const result = await signExamFeedbackAttachments(client, [attachment(1), attachment(2)])
  assert.equal(result[0].url, `https://signed.test/${attachment(1).path}`)
  assert.equal(result[1].url, '')
  assert.notEqual(result[1].url, result[1].path)
})

test('empty feedback does not call Storage and signing failures remain observable', async () => {
  const emptyClient = fakeClient()
  assert.deepEqual(await hydrateExamFeedbackAnswers(emptyClient, [{ answer_id:'a1' }]), [
    { answer_id:'a1', grader_feedback_attachments:[] },
  ])
  assert.equal(emptyClient.calls.length, 0)

  const failure = new Error('signing unavailable')
  const failingClient = fakeClient({ error:failure })
  await assert.rejects(
    () => hydrateExamFeedbackAttachments(failingClient, [attachment(1)]),
    failure,
  )
})
