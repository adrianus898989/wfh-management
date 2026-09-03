import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [staff, training, employees, gallery, styles] = await Promise.all([
  readFile(new URL('../pages/StaffExamPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../pages/AdminTrainingPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/ExamImageGallery.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../styles-exams.css', import.meta.url), 'utf8'),
])

const between = (source, start, end) => {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `missing ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.notEqual(to, -1, `missing ${end}`)
  return source.slice(from, to)
}

test('staff resume restores private attachment metadata and signs it briefly', () => {
  const startFlow = between(staff, 'const start = async exam =>', 'const viewResult = async item =>')
  assert.match(startFlow, /staff_exam_start_open/)
  assert.match(startFlow, /staff_exam_answer_attachments/)
  assert.match(startFlow, /signExamAttachmentMap\(supabase, attachmentMap\)/)
  assert.match(startFlow, /setAnswerAttachments\(signedAttachments\)/)
  assert.match(startFlow, /catch \(previewError\)[\s\S]+setSession\(data\)/)
  assert.doesNotMatch(startFlow, /if \(attachmentError\) throw attachmentError/)
  assert.match(startFlow, /attachmentsReady = false[\s\S]+setSession\(data\)/)
})

test('staff uploads bounded images without overwrite and persists the complete answer', () => {
  const upload = between(staff, 'const uploadAnswerImages = async', 'const chooseAnswerImages = event =>')
  assert.match(upload, /MAX_EXAM_ANSWER_ATTACHMENTS/)
  assert.match(upload, /ACCEPTED_EXAM_ANSWER_IMAGE_TYPES/)
  assert.match(upload, /optimiseExamAnswerImage/)
  assert.match(upload, /MAX_EXAM_ANSWER_IMAGE_BYTES/)
  assert.match(upload, /session\.auth_user_id.*session\.id.*targetQuestion\.id.*crypto\.randomUUID\(\)/s)
  assert.match(upload, /upsert:false/)
  assert.match(upload, /for \(const item of prepared\)[\s\S]+const saved = await save\(targetQuestion[\s\S]+staged\)/)
  assert.match(upload, /if \(!saved\)[\s\S]+removeStoredPaths\(\[pendingPath\]\)/)
  assert.ok(upload.indexOf('await save(targetQuestion') < upload.indexOf('replaceQuestionAttachments(targetQuestion.id, next)'), 'each uploaded object must be persisted before it is shown')

  const save = between(staff, 'const save = async (targetQuestion', 'const reportAttachmentFailure')
  assert.match(save, /p_attachments: attachmentsReady \? attachmentValue : null/)
  assert.doesNotMatch(save, /p_attachments:\s*\[\]/)
  assert.match(save, /storedExamAttachments/)
})

test('navigation and submission wait for uploads, while image-only answers count as complete', () => {
  const runner = between(staff, 'function ExamRunner(', 'function AnswerAttachmentMedia(')
  assert.match(runner, /await attachmentJob\.current/)
  assert.match(runner, /if \(saved\) setIndex\(nextIndex\)/)
  assert.match(runner, /answerIsComplete\(answers\[item\.id\], attachments\[item\.id\]\)/)
  assert.match(runner, /disabled=\{attachmentBusy \|\| submittingNow\}/)
  assert.match(runner, /<AnswerAttachmentMedia attachments=\{questionAttachments\}/)
  assert.match(runner, /staff_exam_submit_with_answer/)
  assert.doesNotMatch(runner, /staff_exam_submit',/)
  assert.match(runner, /p_attachments:attachmentsReady \? storedExamAttachments/)

  const remove = between(runner, 'const removeAnswerImage =', 'const go = async')
  assert.ok(remove.indexOf('await save(') < remove.indexOf('await removeStoredPaths('), 'detach must precede object deletion')
})

test('staff and both authorized admin detail views render answer images separately from question images', () => {
  assert.match(staff, /staff-result-answer-attachments exam-answer-attachment-block/)
  assert.match(staff, /className="exam-answer-media-grid"/)
  assert.match(training, /hydrateExamAnswersAttachments\(supabase,rawAnswers,300\)/)
  assert.match(training, /<ExamImageGallery urls=\{a\.image_urls\}/)
  assert.match(training, /<ExamAnswerImageGallery attachments=\{a\.attachments\}/)
  assert.match(employees, /hydrateExamAnswersAttachments\(supabase,rawAnswers,300\)/)
  assert.match(employees, /<EmployeeExamAnswerImageGallery attachments=\{a\.attachments\}/)
  assert.match(training, /员工答题图片 · \{rows\.length\} 张/)
  assert.match(training, /仅提交图片/)
  assert.match(employees, /仅提交图片/)
  assert.match(training, /图片暂时无法预览/)
  assert.match(employees, /图片暂时无法预览/)
})

test('the shared gallery supports removal and answer thumbnails stay compact at mobile widths', () => {
  assert.match(gallery, /onRemove=null/)
  assert.match(gallery, /className="exam-media-remove"/)
  assert.match(styles, /\.exam-media-grid\.exam-answer-media-grid\{display:flex!important/)
  assert.match(styles, /\.exam-answer-media-grid \.exam-media-card\{[^}]*108px/)
  assert.match(styles, /@media\(max-width:620px\)[\s\S]+\.exam-media-grid\.exam-answer-media-grid\{display:flex!important/)
})
