import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = path => readFile(new URL(path, import.meta.url), 'utf8')

test('standalone admin pages use the shared aligned content container', async () => {
  const [allowlist, training, styles] = await Promise.all([
    source('../pages/AdminIpAllowlistPage.jsx'),
    source('../pages/AdminTrainingPage.jsx'),
    source('../styles-admin-root-layout.css'),
  ])
  assert.match(allowlist, /className="content-page ip-allowlist-page"/)
  assert.match(training, /className="content-page exam-page"/)
  assert.match(styles, /\.content-page\.exam-page\s*\{[\s\S]{0,160}?max-width:\s*1760px;[\s\S]{0,120}?padding:\s*28px 30px 38px;/)
})

test('IP allowlist enabled control cannot inherit full-width modal input styles', async () => {
  const styles = await source('../styles-admin-root-layout.css')
  assert.match(styles, /\.ip-entry-modal \.ip-entry-enabled input\[type='checkbox'\]/)
  assert.match(styles, /width:\s*18px !important;[\s\S]{0,40}?height:\s*18px !important;/)
  assert.match(styles, /input\[type='checkbox'\]:checked\s*\{[\s\S]{0,120}?background:\s*#2f6fe4 !important;/)
})
