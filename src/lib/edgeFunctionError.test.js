import test from 'node:test'
import assert from 'node:assert/strict'
import { edgeFunctionErrorMessage } from './edgeFunctionError.js'

test('uses an Edge Function response body instead of the generic SDK message', async () => {
  const context = new Response(JSON.stringify({ error:'分析查询暂时超时，请重试' }), {
    status:400,
    headers:{ 'content-type':'application/json' },
  })

  const message = await edgeFunctionErrorMessage({
    error:{ message:'Edge Function returned a non-2xx status code', context },
    fallback:'人员数据读取失败',
  })

  assert.equal(message, '分析查询暂时超时，请重试')
  assert.deepEqual(await context.json(), { error:'分析查询暂时超时，请重试' })
})

test('prefers an invoke data error and supports plain-text response bodies', async () => {
  assert.equal(await edgeFunctionErrorMessage({
    data:{ error:'服务端校验失败' },
    error:{ message:'generic' },
  }), '服务端校验失败')

  assert.equal(await edgeFunctionErrorMessage({
    error:{ context:new Response('upstream timeout', { status:504 }) },
  }), 'upstream timeout')
})

test('falls back to a useful SDK message and hides the generic non-2xx placeholder', async () => {
  assert.equal(await edgeFunctionErrorMessage({ error:{ message:'network unavailable' } }), 'network unavailable')
  assert.equal(await edgeFunctionErrorMessage({
    error:{ message:'Edge Function returned a non-2xx status code' },
    fallback:'人员数据读取失败',
  }), '人员数据读取失败')
  assert.equal(await edgeFunctionErrorMessage({ fallback:'人员数据读取失败' }), '人员数据读取失败')
})
