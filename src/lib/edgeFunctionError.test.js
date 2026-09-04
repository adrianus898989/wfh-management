import test from 'node:test'
import assert from 'node:assert/strict'
import { edgeFunctionErrorMessage, publicRequestErrorMessage, readableErrorMessage } from './edgeFunctionError.js'

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

test('extracts nested object errors without ever exposing [object Object]', async () => {
  assert.equal(readableErrorMessage({ error:{ code:'EMPLOYEE_LIST_FAILED', message:'员工档案暂时不可用' } }), '员工档案暂时不可用')
  assert.equal(readableErrorMessage({ message:{ details:'请稍后重新查询' } }), '请稍后重新查询')
  assert.equal(readableErrorMessage({ error:{ code:'EMPLOYEE_LIST_FAILED' } }), '')
  assert.equal(readableErrorMessage('[object Object]'), '')

  assert.equal(await edgeFunctionErrorMessage({
    data:{ error:{ code:'EMPLOYEE_LIST_FAILED' } },
    error:{ message:{ code:'FUNCTION_ERROR' } },
    fallback:'员工档案读取失败，请稍后重试。',
  }), '员工档案读取失败，请稍后重试。')
})

test('hides internal Supabase transport addresses and long query URLs', async () => {
  const raw = 'TypeError: error sending request from 10.32.5.131:54130 for https://project-ref.supabase.co/rest/v1/employee_payment_profiles?select=*&employee_id=in.%28many-identifiers%29'

  assert.equal(await edgeFunctionErrorMessage({
    data:{ error:raw },
    fallback:'员工资料服务暂时繁忙，请稍后重试。',
  }), '员工资料服务暂时繁忙，请稍后重试。')

  assert.equal(await edgeFunctionErrorMessage({
    error:{ message:`request failed: ${raw}` },
    fallback:'查询失败，请稍后重试。',
  }), '查询失败，请稍后重试。')

  assert.equal(publicRequestErrorMessage({ message:raw }, '考试记录读取失败，请重试。'), '考试记录读取失败，请重试。')
  assert.equal(publicRequestErrorMessage({ message:'permission_denied' }, '考试记录读取失败，请重试。'), '当前账号没有执行此操作的权限。')
  assert.equal(publicRequestErrorMessage({ message:'temporarily_paused_for_database_recovery' }, '考试记录读取失败，请重试。'), '考试记录读取失败，请重试。')
  assert.equal(publicRequestErrorMessage({ message:'PGRST002: schema cache unavailable' }, '考试记录读取失败，请重试。'), '考试记录读取失败，请重试。')
})
