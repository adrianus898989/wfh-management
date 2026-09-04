import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const source=await readFile(new URL('./SearchableMultiSelect.jsx',import.meta.url),'utf8')

test('searchable multi-select exposes its controlled string-array API and accessible listbox',()=>{
  assert.match(source,/value=\[\]/)
  assert.match(source,/onChange\?\.\(normalized\)/)
  assert.match(source,/type="search"/)
  assert.match(source,/event\.key!=='Enter'[\s\S]+event\.preventDefault\(\)/)
  assert.match(source,/role="listbox"/)
  assert.match(source,/aria-multiselectable="true"/)
  assert.match(source,/role="option"/)
  assert.match(source,/aria-selected=\{checked\}/)
})

test('searchable multi-select includes bulk, clear, done and dismiss interactions',()=>{
  assert.match(source,/setVisibleStringSelection\(selected,visibleChoices,!allVisibleSelected\)/)
  assert.match(source,/className="sms-clear"/)
  assert.match(source,/className="sms-done"/)
  assert.match(source,/document\.addEventListener\('mousedown',onPointerDown\)/)
  assert.match(source,/event\.key!=='Escape'/)
})

test('searchable multi-select supports a compact count summary for embedded triggers',()=>{
  assert.match(source,/compactSummary=false/)
  assert.match(source,/compactSummary[\s\S]*?`\$\{copy\.selectedLabel\} \$\{selected\.length\}`/)
  assert.match(source,/title=\{selected\.join\('、'\)\|\|placeholder\}/)
})
