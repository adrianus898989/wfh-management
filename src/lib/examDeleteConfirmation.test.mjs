import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  examDeleteCanonicalConfirmation,
  examDeleteConfirmationMatches,
  examDeleteConfirmationToken,
  normalizeExamDeleteConfirmation,
} from './examDeleteConfirmation.js'

const session = {
  id:'c5a5f192-1234-4567-89ab-0123456789ab',
  employee_no:'CS000362',
}

test('exam deletion uses a language-neutral employee and session token', () => {
  assert.equal(examDeleteConfirmationToken(session), 'CS000362 c5a5f192')
  assert.equal(examDeleteCanonicalConfirmation(session), '删除 CS000362 c5a5f192')
})

test('visible token comparison tolerates surrounding whitespace, repeated spaces and letter case', () => {
  assert.equal(normalizeExamDeleteConfirmation('  cs000362   C5A5F192  '), 'CS000362 C5A5F192')
  assert.equal(examDeleteConfirmationMatches('  cs000362   C5A5F192  ', session), true)
  assert.equal(examDeleteConfirmationMatches('CS000362', session), false)
  assert.equal(examDeleteConfirmationMatches('CS000362 c5a5f193', session), false)
  assert.equal(examDeleteConfirmationMatches('', session), false)
})

test('missing identity never produces an actionable confirmation', () => {
  assert.equal(examDeleteConfirmationToken({ employee_no:'CS000362' }), '')
  assert.equal(examDeleteCanonicalConfirmation({ id:session.id }), '')
  assert.equal(examDeleteConfirmationMatches('', {}), false)
})

test('delete modal protects the token from translation and sends only the canonical server phrase', async () => {
  const [source,cleanup] = await Promise.all([
    readFile(new URL('../pages/AdminTrainingPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('./examSessionStorageCleanup.js', import.meta.url), 'utf8'),
  ])
  assert.match(source, /<code translate="no" data-admin-i18n-skip>/)
  assert.match(source, /confirmation:canonicalConfirmation/)
  assert.match(cleanup, /p_confirmation:confirmation/)
  assert.match(source, /disabled=\{busy\|\|!confirmationReady\}/)
  assert.doesNotMatch(source, /confirmation:confirmation\b/)
})
