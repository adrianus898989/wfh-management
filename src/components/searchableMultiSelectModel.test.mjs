import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeStringSelection,
  sameStringSelection,
  setVisibleStringSelection,
  toggleStringSelection,
} from './searchableMultiSelectModel.js'

test('normalizes string selections without reordering the first occurrence',()=>{
  assert.deepEqual(normalizeStringSelection([' 夜班 ','AR印度','夜班','','AR印度']),['夜班','AR印度'])
  assert.deepEqual(normalizeStringSelection('客服'),['客服'])
})

test('does not prune a selected value merely because an option directory changed',()=>{
  const selected=normalizeStringSelection(['历史组别','当前组别'])
  const currentOptions=normalizeStringSelection(['当前组别','新组别'])
  assert.deepEqual(selected,['历史组别','当前组别'])
  assert.deepEqual(currentOptions,['当前组别','新组别'])
})

test('toggle preserves existing order and appends only new values',()=>{
  assert.deepEqual(toggleStringSelection(['B','A'],'C',true),['B','A','C'])
  assert.deepEqual(toggleStringSelection(['B','A'],'B',false),['A'])
  assert.deepEqual(toggleStringSelection(['B','A'],'A',true),['B','A'])
})

test('select-visible appends in visible order and deselects without disturbing the remainder',()=>{
  assert.deepEqual(setVisibleStringSelection(['B','A'],['C','A','D'],true),['B','A','C','D'])
  assert.deepEqual(setVisibleStringSelection(['B','A','C','D'],['C','A'],false),['B','D'])
})

test('selection equality is order-sensitive for a stable controlled value',()=>{
  assert.equal(sameStringSelection(['A','B'],[' A ','B']),true)
  assert.equal(sameStringSelection(['A','B'],['B','A']),false)
})
