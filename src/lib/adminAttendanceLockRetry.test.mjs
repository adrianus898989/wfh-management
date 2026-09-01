import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

import {
  isMonthlyAttendanceLockTimeout,
  MONTHLY_ATTENDANCE_LOCK_RETRY_DELAY_MS,
  withMonthlyAttendanceLockRetry,
} from './adminAttendanceLockRetry.js'

test('monthly attendance lock timeout detection stays limited to database lock waits',()=>{
  assert.equal(isMonthlyAttendanceLockTimeout({code:'55P03',message:'lock not available'}),true)
  assert.equal(isMonthlyAttendanceLockTimeout({message:'canceling statement due to lock timeout'}),true)
  assert.equal(isMonthlyAttendanceLockTimeout({details:'Lock timeout while reading attendance'}),true)
  assert.equal(isMonthlyAttendanceLockTimeout({code:'57014',message:'canceling statement due to statement timeout'}),false)
  assert.equal(isMonthlyAttendanceLockTimeout({code:'42501',message:'permission denied'}),false)
  assert.equal(isMonthlyAttendanceLockTimeout({code:'PGRST003',message:'timed out waiting for a connection'}),false)
})

test('monthly attendance retries one coded or message-only lock timeout after the bounded delay',async()=>{
  for(const firstError of [
    {code:'55P03',message:'lock not available'},
    {message:'canceling statement due to lock timeout'},
  ]){
    let attempts=0
    const waits=[]
    const result=await withMonthlyAttendanceLockRetry(async()=>{
      attempts+=1
      if(attempts===1)throw firstError
      return {month:'2026-08'}
    },{
      wait:async delayMs=>{waits.push(delayMs)},
    })

    assert.deepEqual(result,{month:'2026-08'})
    assert.equal(attempts,2)
    assert.deepEqual(waits,[MONTHLY_ATTENDANCE_LOCK_RETRY_DELAY_MS])
  }
})

test('monthly attendance does not retry other failures and never retries more than once',async()=>{
  let permissionAttempts=0
  let permissionWaits=0
  await assert.rejects(
    withMonthlyAttendanceLockRetry(async()=>{
      permissionAttempts+=1
      throw {code:'42501',message:'permission denied'}
    },{wait:async()=>{permissionWaits+=1}}),
    error=>error.code==='42501',
  )
  assert.equal(permissionAttempts,1)
  assert.equal(permissionWaits,0)

  let lockAttempts=0
  let lockWaits=0
  await assert.rejects(
    withMonthlyAttendanceLockRetry(async()=>{
      lockAttempts+=1
      throw {code:'55P03',message:'canceling statement due to lock timeout'}
    },{wait:async()=>{lockWaits+=1}}),
    error=>error.code==='55P03',
  )
  assert.equal(lockAttempts,2)
  assert.equal(lockWaits,1)
})

test('monthly attendance page scopes the retry helper to its read-only monthly RPC',async()=>{
  const page=await readFile(new URL('../pages/AdminAttendancePage.jsx',import.meta.url),'utf8')
  assert.match(page,/import \{ withMonthlyAttendanceLockRetry \} from '\.\.\/lib\/adminAttendanceLockRetry'/)
  assert.match(page,/async function fetchAttendanceMonth\(month,filters=\{\}\)\{\s*return withMonthlyAttendanceLockRetry\(async\(\)=>\{[\s\S]*?supabase\.rpc\('admin_attendance_monthly_page'/)
  assert.equal((page.match(/withMonthlyAttendanceLockRetry\(/g)||[]).length,1)
})
