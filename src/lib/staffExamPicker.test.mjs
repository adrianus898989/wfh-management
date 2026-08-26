import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('员工考试的盘口与考试都默认等待员工选择', async () => {
  const source = await readFile(new URL('../pages/StaffExamPage.jsx', import.meta.url), 'utf8')
  assert.match(source, /selectPlatform: \['请选择'/)
  assert.match(source, /selectPosition: \['请选择'/)
  assert.match(source, /const \[selectedPlatform, setSelectedPlatform\] = useState\(''\)/)
  assert.match(source, /const \[selectedExamKey, setSelectedExamKey\] = useState\(''\)/)
  assert.match(source, /const choosePlatform = value => \{\s*setSelectedPlatform\(value\)\s*setSelectedExamKey\(''\)/)
  assert.doesNotMatch(source, /setSelectedExamKey\(first \? optionKey\(first\)/)
  assert.match(source, /<option value="">\{tr\('selectPlatform'\)\}<\/option>/)
  assert.match(source, /<option value="">\{tr\('selectPosition'\)\}<\/option>/)
})
