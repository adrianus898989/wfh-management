import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { adjustmentCategory, adjustmentReason, adjustmentTitle } from './adjustmentPresentation.js'

test('奖金 / 扣款原因优先读取 Google 备注，旧 reason 仅作回退', () => {
  assert.equal(adjustmentReason({ note: '上班迟到 22 分钟', reason: 'Google/后台录入奖金/扣款' }), '上班迟到 22 分钟')
  assert.equal(adjustmentReason({ note: '  ', reason: '旧记录原因' }), '旧记录原因')
  assert.equal(adjustmentReason({ note: null, reason: null }), '—')
})

test('奖惩类型优先读取同步协议 category，并兼容 reason 和旧奖金扣款记录', () => {
  assert.equal(adjustmentCategory({ raw_values:{ category:'迟到 / 超时' }, reason:'旧值' }), '迟到 / 超时')
  assert.equal(adjustmentCategory({ reason:'服务质量' }), '服务质量')
  assert.equal(adjustmentCategory({ event_kind:'deduction' }), '扣款')
})

test('员工端奖惩标题优先用明确标题，再兼容同步类型和旧记录', () => {
  assert.equal(adjustmentTitle({ title:'月度服务之星', reason:'服务质量' }), '月度服务之星')
  assert.equal(adjustmentTitle({ raw_values:{ category:'迟到 / 超时' }, reason:'旧值' }), '迟到 / 超时')
  assert.equal(adjustmentTitle({ reason:'服务质量', note:'客户表扬' }), '服务质量')
  assert.equal(adjustmentTitle({ event_kind:'deduction' }), '扣款记录')
})

test('后台编辑仍把用户填写的原因写入 note payload', async () => {
  const source = await readFile(new URL('../pages/AdminAttendancePage.jsx', import.meta.url), 'utf8')
  assert.match(source, /note:text\(draft\.note\)/)
  assert.match(source, /category:text\(draft\.category\)/)
  assert.doesNotMatch(source, /reason:text\(draft\.note\)/)
  assert.match(source, /<th>类型<\/th><th>奖惩金额<\/th>/)
  assert.match(source, /adjustment-adjustment-category-cell|attendance-adjustment-category-cell/)
})

test('日考勤明细将员工与组织字段独立分列且不显示负责人', async () => {
  const source = await readFile(new URL('../pages/AdminAttendancePage.jsx', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../styles-attendance.css', import.meta.url), 'utf8')
  assert.match(source, /<th>日期<\/th><th>入职日期<\/th><th>员工 ID<\/th><th>姓名<\/th><th>员工类型<\/th><th>国家<\/th><th>状态<\/th><th>团队<\/th><th>岗位<\/th><th>原因<\/th><th>备注<\/th>/)
  assert.doesNotMatch(source, /<th>负责人<\/th>/)
  assert.match(source, /attendance-employee-id-cell/)
  assert.match(styles, /attendance-detail-table:not\(\.adjustment\) th\{font-size:11px\}/)
  assert.match(styles, /attendance-detail-table:not\(\.adjustment\) td\{font-size:12px/)
})

test('员工档案与员工端同时展示独立类型和备注原因', async () => {
  const [archiveSource, staffSource] = await Promise.all([
    readFile(new URL('../components/AttendanceRecords.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../pages/PortalPage.jsx', import.meta.url), 'utf8'),
  ])
  assert.match(archiveSource, /<small>类型<\/small><strong>\{adjustmentCategory\(row\)\}<\/strong>/)
  assert.match(archiveSource, /row=>adjustmentCategory\(row\)/)
  assert.match(staffSource, /adjustments\.recordTitle[\s\S]*adjustmentTitle\(row\)/)
  assert.match(staffSource, /adjustments\.date[\s\S]*adjustments\.type[\s\S]*adjustments\.amount[\s\S]*adjustments\.reason/)
  assert.match(staffSource, /adjustmentReason\(row\)/)
})

test('员工端刷新错误格式化对象信息并保留已经显示的数据', async () => {
  const source = await readFile(new URL('../pages/PortalPage.jsx', import.meta.url), 'utf8')
  assert.match(source, /const portalErrorMessage = \(error, fallback\)[\s\S]*readableErrorMessage\(error\)/)
  assert.match(source, /setActivity\(current => activityError[\s\S]*\{ \.\.\.current, loading: false, error:/)
  assert.match(source, /setSelfAttendance\(current => attendanceError[\s\S]*\{ \.\.\.current, loading: false, error:/)
  assert.match(source, /setAdjustmentHistory\(current => loadError[\s\S]*\{ \.\.\.current, loading:false, error:/)
  assert.match(source, /if \(loading && !data\)/)
  assert.doesNotMatch(source, /activityError\.message \|\|/)
  assert.doesNotMatch(source, /attendanceError\.message \|\|/)
})

test('forward SQL correction preserves revision checks and requires category for the PH nine-column layout', async () => {
  const [appliedSource, correctionSource] = await Promise.all([
    readFile(new URL('../../supabase/migrations/20260826154000_adjustment_category_protocol.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/20260826164000_restore_philippines_adjustment_nine_columns.sql', import.meta.url), 'utf8'),
  ])
  assert.match(appliedSource, /if v_workbook='home_ph' then v_category:=''; end if/)
  assert.match(correctionSource, /r\.sync_revision=\(v_row->>'revision'\)::bigint/)
  assert.match(correctionSource, /'raw_values'.*'category'/s)
  assert.match(correctionSource, /v_workbook in \('onsite','home_vim','home_ph'\) and v_category=''/)
  assert.match(correctionSource, /'layout','philippines'/)
  assert.match(correctionSource, /'sheet_schema','philippines_9_columns_with_type'/)
  assert.doesNotMatch(correctionSource, /if v_workbook='home_ph' then v_category:=''; end if/)
})
