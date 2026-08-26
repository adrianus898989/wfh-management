import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { adjustmentReason } from './adjustmentPresentation.js'

test('奖金 / 扣款原因优先读取 Google 备注，旧 reason 仅作回退', () => {
  assert.equal(adjustmentReason({ note: '上班迟到 22 分钟', reason: 'Google/后台录入奖金/扣款' }), '上班迟到 22 分钟')
  assert.equal(adjustmentReason({ note: '  ', reason: '旧记录原因' }), '旧记录原因')
  assert.equal(adjustmentReason({ note: null, reason: null }), '—')
})

test('后台编辑仍把用户填写的原因写入 note payload', async () => {
  const source = await readFile(new URL('../pages/AdminAttendancePage.jsx', import.meta.url), 'utf8')
  assert.match(source, /note:text\(draft\.note\)/)
  assert.doesNotMatch(source, /reason:text\(draft\.note\)/)
})
