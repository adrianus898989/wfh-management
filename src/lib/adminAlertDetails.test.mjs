import assert from 'node:assert/strict'
import test from 'node:test'
import { adminAlertAttendanceDetails } from './adminAlertDetails.js'

test('monthly leave exposes the existing category totals and dated evidence', () => {
  const detail = adminAlertAttendanceDetails({
    alert_type:'monthly_leave',
    payload:{
      public_holiday:3,
      leave:1,
      absence:2,
      half_day:2,
      home_leave_excluded:true,
      events:[
        { date:'2026-08-08', event_kind:'half_day', reason:'Medical appointment', note:'Approved', weight:0.5 },
        { date:'2026-08-02', event_kind:'public_holiday', reason:'排班公休', weight:1 },
      ],
    },
  }, 'zh')

  assert.equal(detail.title, '本月计入休假的日期明细')
  assert.deepEqual(detail.breakdown.map(item => [item.kind, item.count]), [
    ['public_holiday', 3], ['leave', 1], ['absence', 2], ['half_day', 2],
  ])
  assert.equal(detail.events[0].date, '2026-08-02')
  assert.equal(detail.events[1].description, '原因：Medical appointment · 备注：Approved')
  assert.equal(detail.events[1].weight, 0.5)
  assert.equal(detail.homeLeaveExcluded, true)
})

test('weekly absence shows each date and makes a missing reason explicit', () => {
  const detail = adminAlertAttendanceDetails({
    alert_type:'weekly_absence',
    payload:{ events:[
      { date:'2026-08-20', event_kind:'absence', reason:'生病', note:'生病' },
      { date:'2026-08-24', event_kind:'absence' },
    ] },
  }, 'zh')

  assert.equal(detail.title, '缺席日期与原因')
  assert.equal(detail.events[0].description, '原因：生病')
  assert.equal(detail.events[1].description, '未填写原因或备注')
  assert.equal(detail.missingDetails, false)
})

test('legacy payloads remain renderable until the enriched refresh runs', () => {
  const detail = adminAlertAttendanceDetails({
    alert_type:'weekly_absence',
    payload:{ days:7, count:2 },
  }, 'en')

  assert.deepEqual(detail.events, [])
  assert.equal(detail.missingDetails, true)
  assert.equal(adminAlertAttendanceDetails({ alert_type:'exam_failed', payload:{} }), null)
})

