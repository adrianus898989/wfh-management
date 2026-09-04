import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ONLINE_TRAINING_MULTI_VALUE_SEPARATOR,
  countActiveOnlineTrainingFilters,
  encodeOnlineTrainingFilterPayload,
  normalizeOnlineTrainingFilters,
  normalizeOnlineTrainingMultiValue,
} from './onlineTrainingFilters.js'

test('normalizes online-training multi filters as stable trimmed arrays',()=>{
  const input={team:[' AR印度 ','AR巴西','AR印度'],group:' 客服组 ',employee_no:' CS001 '}
  const normalized=normalizeOnlineTrainingFilters(input)

  assert.deepEqual(normalized.team,['AR印度','AR巴西'])
  assert.deepEqual(normalized.group,['客服组'])
  assert.deepEqual(normalized.position,[])
  assert.equal(normalized.employee_no,'CS001')
  assert.deepEqual(input.team,[' AR印度 ','AR巴西','AR印度'])
})

test('encodes multiple values with the ASCII unit separator while keeping scalar RPC fields',()=>{
  const encoded=encodeOnlineTrainingFilterPayload({
    team:['AR印度','AR巴西'],shift:['白班'],from:' 2026-09-01 ',keyword:' 质检 ',
  })

  assert.equal(encoded.team,`AR印度${ONLINE_TRAINING_MULTI_VALUE_SEPARATOR}AR巴西`)
  assert.equal(encoded.shift,'白班')
  assert.equal(encoded.position,'')
  assert.equal(encoded.from,'2026-09-01')
  assert.equal(encoded.keyword,'质检')
  assert.equal(Array.isArray(encoded.team),false)
})

test('accepts an encoded value when rebuilding UI filter state',()=>{
  const encoded=`客服${ONLINE_TRAINING_MULTI_VALUE_SEPARATOR}出款${ONLINE_TRAINING_MULTI_VALUE_SEPARATOR}客服`
  assert.deepEqual(normalizeOnlineTrainingMultiValue(encoded),['客服','出款'])
})

test('counts active dimensions, not the number of selected options',()=>{
  assert.equal(countActiveOnlineTrainingFilters({
    team:['AR印度','AR巴西'],group:[],position:[],shift:['夜班'],platform:[],
    employee_no:'',employee_name:' Alice ',trainer:'',keyword:'',attendance:'',from:'2026-09-01',to:'',
  }),4)
  assert.equal(countActiveOnlineTrainingFilters({team:[],group:[],position:[],shift:[],platform:[]}),0)
})
