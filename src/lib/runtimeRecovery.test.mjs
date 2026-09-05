import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = path => readFile(new URL(path, import.meta.url), 'utf8')

test('employee archive imports every permission constant used at render time', async () => {
  const page = await source('../pages/AdminEmployeesPage.jsx')
  assert.match(page, /import\s*\{\s*PERMISSIONS\s*\}\s*from\s*['"]\.\.\/config\/permissions['"]/) 
  assert.match(page, /PERMISSIONS\.SENSITIVE_EMPLOYEE_VIEW/)
})

test('root mount and static entry both recover instead of leaving a white page', async () => {
  const [main, boundary, index, notFound] = await Promise.all([
    source('../main.jsx'),
    source('../components/AppCrashBoundary.jsx'),
    source('../../index.html'),
    source('../../404.html'),
  ])
  assert.match(main, /<AppCrashBoundary>/)
  assert.match(main, /vite:preloadError/)
  assert.match(boundary, /页面加载失败，但登录资料仍然保留/)
  assert.match(index, /__wfhRecoverAsset/)
  assert.match(index, /页面资源加载失败/)
  assert.match(notFound, /__spa_reload=/)
})

test('browser translation cannot rewrite React-owned nodes during live mutations', async () => {
  const index = await source('../../index.html')
  assert.match(index, /<meta name="google" content="notranslate">/)
  assert.match(index, /<html[^>]*translate="no"[^>]*class="notranslate"/)
  assert.match(index, /<body[^>]*translate="no"[^>]*class="notranslate"/)
  assert.match(index, /<div id="root"[^>]*translate="no"[^>]*class="notranslate"/)
})

test('admin sidebar switches route groups before the next route is painted', async () => {
  const layout = await source('../components/AppLayout.jsx')
  assert.match(layout, /useLayoutEffect\(\(\)=>\{\s*setOpenGroup\(pathGroup\)/)
  assert.match(layout, /\[location\.key,pathGroup\]/)
})
