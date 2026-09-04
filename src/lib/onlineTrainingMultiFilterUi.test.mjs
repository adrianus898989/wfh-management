import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const page=await readFile(new URL('../pages/OnlineTrainingPage.jsx',import.meta.url),'utf8')
const css=await readFile(new URL('../components/SearchableMultiSelect.css',import.meta.url),'utf8')
const pageCss=await readFile(new URL('../styles-online-training.css',import.meta.url),'utf8')
const adminI18n=await readFile(new URL('./adminI18n.jsx',import.meta.url),'utf8')

test('online-training organization filters are searchable multi-selects while attendance stays scalar',()=>{
  assert.match(page,/team:\[\],group:\[\],position:\[\],shift:\[\],platform:\[\]/)
  for(const [key,label] of [
    ['team','团队'],['group','组别'],['position','岗位'],['shift','班次'],['platform','盘口'],
  ]){
    assert.match(page,new RegExp(`<SearchableMultiSelect value=\\{draftFilters\\.${key}\\}[\\s\\S]*?setDraftFilter\\('${key}',value\\)[\\s\\S]*?ariaLabel="${label}筛选"`))
  }
  assert.match(page,/<span>当日状态<\/span><select value=\{draftFilters\.attendance\}/)
})

test('both directory and trainer-history RPCs receive the encoded multi-value payload',()=>{
  assert.match(page,/p_filters:encodeOnlineTrainingFilterPayload\(filters\),p_page:nextPage/)
  assert.match(page,/const trainerFilters=encodeOnlineTrainingFilterPayload\(\{\.\.\.filters,trainer:trainer\.trainer_name,trainer_names:\[\]\}\)/)
  assert.match(page,/const next=normalizeOnlineTrainingFilters\(draftFilters\)/)
  assert.match(page,/const activeFilterCount=countActiveOnlineTrainingFilters\(filters\)/)
})

test('trainer manual search and searchable multi-select share one compact filter cell',()=>{
  assert.match(page,/trainer:'',trainer_names:\[\]/)
  assert.match(page,/className="ot-filter-field ot-trainer-filter-field"[\s\S]*?aria-label="手动输入提交人或线上培训"[\s\S]*?<SearchableMultiSelect className="ot-trainer-picker" value=\{draftFilters\.trainer_names\} options=\{filterOptions\.trainer\}/)
  assert.match(page,/setDraftFilter\('trainer_names',value\)[\s\S]*?ariaLabel="培训人员筛选" compactSummary/)
  assert.match(pageCss,/\.ot-trainer-combined\{position:relative/)
  assert.match(pageCss,/\.ot-trainer-combined \.ot-trainer-picker\{position:absolute[^}]*right:4px[^}]*width:68px/)
  assert.match(pageCss,/@media\(max-width:650px\)\{\.ot-trainer-combined \.ot-trainer-picker \.sms-popover\{width:min\(320px,calc\(100vw - 42px\)\)/)
})

test('the compact control has a layered responsive menu and bilingual UI copy',()=>{
  assert.match(css,/\.searchable-multi-select\.is-open\{z-index:200\}/)
  assert.match(css,/\.sms-trigger\{[^}]*height:39px/)
  assert.match(css,/\.sms-popover\{[^}]*position:absolute[^}]*z-index:180/)
  assert.match(css,/@media\(max-width:650px\)/)
  for(const source of [
    '全部组别 / 输入搜索','全部盘口 / 输入搜索','全选当前结果','取消当前结果','没有匹配项',
    '手动输入提交人或线上培训','培训人员筛选','输入培训人员姓名搜索',
  ])assert.match(adminI18n,new RegExp(`'${source}':`))
})
