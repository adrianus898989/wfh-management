import test from 'node:test'
import assert from 'node:assert/strict'
import { attendanceHistoryRemark } from './attendancePresentation.js'

test('attendance history prefers the specific note as the compact remark', () => {
  assert.equal(attendanceHistoryRemark({ reason: '公休', note: 'BIRTHDAY CELEBRATION' }), 'BIRTHDAY CELEBRATION')
})

test('attendance history falls back to reason when no note exists', () => {
  assert.equal(attendanceHistoryRemark({ reason: '请假', note: '  ' }), '请假')
  assert.equal(attendanceHistoryRemark({}), '—')
})
