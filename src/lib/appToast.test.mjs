import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  APP_TOAST_ERROR_DURATION_MS,
  APP_TOAST_LIMIT,
  APP_TOAST_SUCCESS_DURATION_MS,
  appToastDuration,
  createAppToast,
  enqueueAppToast,
} from './appToast.js'

const source = path => readFile(new URL(path, import.meta.url), 'utf8')

test('toast model applies the required durations and normalized fallback copy', () => {
  assert.equal(APP_TOAST_LIMIT, 3)
  assert.equal(APP_TOAST_SUCCESS_DURATION_MS, 4500)
  assert.equal(APP_TOAST_ERROR_DURATION_MS, 9000)
  assert.equal(appToastDuration('success'), 4500)
  assert.equal(appToastDuration('error'), 9000)

  const retry = () => {}
  const toast = createAppToast({ type: 'error', module: '  登录IP白名单  ', operation: ' ', retry }, 100)
  assert.equal(toast.type, 'error')
  assert.equal(toast.module, '登录IP白名单')
  assert.equal(toast.operation, '操作')
  assert.equal(toast.reason, '操作未完成，请稍后重试。')
  assert.equal(toast.durationMs, 9000)
  assert.equal(toast.createdAt, 100)
  assert.equal(toast.retry, retry)
  assert.equal(toast.retryLabel, '重试')
})

test('toast queue keeps only the latest three notifications', () => {
  let queue = []
  for (let index = 1; index <= 4; index += 1) {
    queue = enqueueAppToast(queue, createAppToast({
      operation: `操作${index}`,
      dedupeKey: `toast-${index}`,
    }, index))
  }

  assert.equal(queue.length, 3)
  assert.deepEqual(queue.map(item => item.operation), ['操作2', '操作3', '操作4'])
  assert.deepEqual(enqueueAppToast(queue, null, 0), [])
})

test('toast queue deduplicates by key and restarts the newest display interval', () => {
  const original = createAppToast({
    type: 'error',
    operation: '读取白名单',
    reason: '第一次失败',
    dedupeKey: 'ip-list-error',
  }, 100)
  const replacement = createAppToast({
    type: 'error',
    operation: '读取白名单',
    reason: '第二次失败',
    dedupeKey: 'ip-list-error',
  }, 200)

  const queue = enqueueAppToast([original], replacement)
  assert.equal(queue.length, 1)
  assert.equal(queue[0].id, original.id)
  assert.equal(queue[0].reason, '第二次失败')
  assert.equal(queue[0].createdAt, 200)
})

test('provider is mounted globally with accessible status, alert, close and safe retry controls', async () => {
  const [app, provider, styles] = await Promise.all([
    source('../App.jsx'),
    source('../components/AppToastProvider.jsx'),
    source('../styles-app-toast.css'),
  ])

  assert.match(app, /<AppToastProvider><ReleaseSessionBoundary><AppRoutes \/><\/ReleaseSessionBoundary><\/AppToastProvider>/)
  assert.match(provider, /role=\{isError \? 'alert' : 'status'\}/)
  assert.match(provider, /aria-live=\{isError \? 'assertive' : 'polite'\}/)
  assert.match(provider, /window\.setTimeout\(\(\) => onDismiss\(toast\.id\), toast\.durationMs\)/)
  assert.match(provider, /aria-label="关闭提示"/)
  assert.match(provider, /toast\.retry && <button[\s\S]*toast\.retryLabel/)
  assert.match(styles, /\.app-toast-viewport\{position:fixed;[\s\S]*top:72px;right:24px;/)
  assert.match(styles, /@media\(max-width:760px\)\{\.app-toast-viewport\{top:72px;/)
})

test('IP allowlist publishes read and mutation outcomes while preserving detailed page and modal errors', async () => {
  const page = await source('../pages/AdminIpAllowlistPage.jsx')

  assert.match(page, /const \{ notify \} = useAppToast\(\)/)
  assert.match(page, /operation:'读取白名单',[\s\S]*retry:\(\) => load\(\{ announceSuccess:true \}\)/)
  assert.match(page, /operation:'刷新白名单',[\s\S]*type:'success'/)
  assert.match(page, /const publishMutationSuccess[\s\S]*type:'success'/)
  assert.match(page, /const publishMutationFailure[\s\S]*type:'error'/)
  assert.match(page, /retry:refreshSafe \? \(\) => load\(\{ announceSuccess:true \}\) : undefined/)
  assert.doesNotMatch(page, /retry:\s*\(\)\s*=>\s*mutate/)
  assert.match(page, /\{error && <div className="page-error" role="alert">\{error\}<\/div>\}/)
  assert.match(page, /error: outcome\.error/)
  assert.match(page, /\{modal\.error && <div className="page-error">\{modal\.error\}<\/div>\}/)
})
