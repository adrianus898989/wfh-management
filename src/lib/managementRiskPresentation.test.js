import test from 'node:test'
import assert from 'node:assert/strict'
import {
  managementRiskBand,
  managementRiskDatePreset,
  managementRiskIncidentTotal,
  managementRiskOptions,
  managementRiskOrganizationRows,
  managementRiskRowName,
  managementRiskTrendRows,
} from './managementRiskPresentation.js'

test('management risk presets use inclusive local calendar ranges', () => {
  const now = new Date(2026, 7, 27, 18, 30)
  assert.deepEqual(managementRiskDatePreset('30d', now), {date_from:'2026-07-29', date_to:'2026-08-27'})
  assert.deepEqual(managementRiskDatePreset('90d', now), {date_from:'2026-05-30', date_to:'2026-08-27'})
  assert.deepEqual(managementRiskDatePreset('month', now), {date_from:'2026-08-01', date_to:'2026-08-27'})
})

test('small samples never render as a management verdict', () => {
  assert.equal(managementRiskBand({risk_score:99,sample_flags:['少于 5 人']}).label, '样本不足')
  assert.equal(managementRiskBand({risk_score:72}).label, '重点复核')
  assert.equal(managementRiskBand({risk_score:12}).label, '相对稳定')
})

test('presentation helpers accept the RPC organization contract', () => {
  const data={
    options:{
      teams:[{team_name:'熊猫PH'},{team_name:'AR印度'},{team_name:'熊猫PH'}],
      groups:[{group_name:'客服组30'}],
      managers:[{manager_name:'小猪'}],
    },
    organization:{groups:[{group_name:'客服组30'}]},
  }
  assert.deepEqual(managementRiskOptions(data,'teams'),['熊猫PH','AR印度'])
  assert.deepEqual(managementRiskOptions(data,'groups'),['客服组30'])
  assert.deepEqual(managementRiskOptions(data,'managers'),['小猪'])
  assert.equal(managementRiskOrganizationRows(data,'groups').length,1)
  assert.equal(managementRiskRowName(data.organization.groups[0],'groups'),'客服组30')
  assert.equal(managementRiskIncidentTotal({error_events:2,exam_failures:1,attendance_issues:3,deductions:4}),10)
})

test('management risk options preserve team, group and manager relationships', () => {
  const data={options:{
    teams:[{team_name:'熊猫PH'},{team_name:'AR印度'}],
    groups:[
      {team_name:'熊猫PH',group_name:'客服组'},
      {team_name:'AR印度',group_name:'客服组'},
      {team_name:'熊猫PH',group_name:'审单组'},
    ],
    managers:[
      {team_name:'熊猫PH',group_name:'客服组',manager_role:'online_leader',manager_name:'甲'},
      {team_name:'熊猫PH',group_name:'审单组',manager_role:'online_trainer',manager_name:'乙'},
      {team_name:'AR印度',group_name:'客服组',manager_role:'online_leader',manager_name:'丙'},
    ],
  }}
  assert.deepEqual(managementRiskOptions(data,'groups',{team:'熊猫PH'}),['客服组','审单组'])
  assert.deepEqual(managementRiskOptions(data,'managers',{
    team:'熊猫PH',group:'客服组',manager_role:'online_leader',
  }),['甲'])
})

test('trend helper uses daily detail for short periods and weekly buckets for long periods', () => {
  const trend={daily:[{date:'2026-08-27'}],weekly:[{week_start:'2026-08-24'}]}
  assert.deepEqual(managementRiskTrendRows({period:{days:30},trend}),trend.daily)
  assert.deepEqual(managementRiskTrendRows({period:{days:90},trend}),trend.weekly)
  assert.deepEqual(managementRiskTrendRows({trend:[{date:'legacy'}]}),[{date:'legacy'}])
})

test('server risk-band aliases retain their intended display severity', () => {
  assert.equal(managementRiskBand({risk_band:'high_signal'}).className,'critical')
  assert.equal(managementRiskBand({risk_band:'elevated_signal'}).className,'high')
  assert.equal(managementRiskBand({risk_band:'baseline_signal'}).className,'stable')
})
