import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  deleteExamSessionWithStorageCleanup,
  drainPendingDeletedExamSessionStorageCleanup,
  examSessionStorageCleanupPlan,
  retryDeletedExamSessionStorageCleanup,
} from './examSessionStorageCleanup.js'

const sessionId = 'c5a5f192-1234-4567-89ab-0123456789ab'
const ownerId = '11111111-1111-4111-8111-111111111111'
const answerId = '22222222-2222-4222-8222-222222222222'
const answerImageA = `${ownerId}/${sessionId}/${answerId}/33333333-3333-4333-8333-333333333333.png`
const answerImageB = `${ownerId}/${sessionId}/${answerId}/44444444-4444-4444-8444-444444444444.webp`
const feedbackImage = `${ownerId}/${sessionId}/${answerId}/55555555-5555-4555-8555-555555555555.jpg`
const cleanupPayload = {
  ok:true,
  deleted_session_id:sessionId,
  storage_cleanup:{
    'exam-answer-images':[answerImageA,answerImageB],
    'exam-feedback-images':[feedbackImage],
  },
}
const emptyPayload = {
  ok:true,
  deleted_session_id:sessionId,
  storage_cleanup:{
    'exam-answer-images':[],
    'exam-feedback-images':[],
  },
}

function clientWith({
  deleteResult={data:cleanupPayload,error:null},
  deletedRecoveryResults=[{data:cleanupPayload,error:null}],
  statusResults=[{data:emptyPayload,error:null}],
  pendingResult={data:{ok:true,items:[cleanupPayload],has_more:false},error:null},
  pruneResult={data:{ok:true,pruned:0},error:null},
  removeErrors={},
}={}) {
  const calls=[]
  let deletedRecoveryIndex=0
  let statusIndex=0
  return {
    calls,
    rpc:async(name,args)=>{
      calls.push(['rpc',name,args])
      if(name==='admin_exam_delete_current_session')return deleteResult
      if(name==='admin_exam_pending_storage_cleanup')return pendingResult
      if(name==='admin_exam_prune_storage_cleanup')return pruneResult
      if(name==='admin_exam_storage_cleanup_status'){
        const result=statusResults[Math.min(statusIndex,statusResults.length-1)]
        statusIndex+=1
        return result
      }
      const result=deletedRecoveryResults[Math.min(deletedRecoveryIndex,deletedRecoveryResults.length-1)]
      deletedRecoveryIndex+=1
      return result
    },
    storage:{from:bucket=>({remove:async paths=>{
      calls.push(['remove',bucket,paths])
      return {error:removeErrors[bucket]||null}
    }})},
  }
}

test('cleanup plan accepts only the two complete canonical bucket arrays', () => {
  assert.deepEqual(examSessionStorageCleanupPlan(cleanupPayload),[
    {bucket:'exam-answer-images',paths:[answerImageA,answerImageB]},
    {bucket:'exam-feedback-images',paths:[feedbackImage]},
  ])
  for(const invalid of [
    null,
    {...cleanupPayload,storage_cleanup:null},
    {...cleanupPayload,storage_cleanup:{'exam-answer-images':[]}},
    {...cleanupPayload,storage_cleanup:{...cleanupPayload.storage_cleanup,'exam-answer-images':[answerImageA,answerImageA]}},
    {...cleanupPayload,storage_cleanup:{...cleanupPayload.storage_cleanup,'exam-answer-images':[` ${answerImageA}`]}},
    {...cleanupPayload,storage_cleanup:{...cleanupPayload.storage_cleanup,'exam-answer-images':[answerImageA.replace(sessionId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]}},
  ]) assert.throws(()=>examSessionStorageCleanupPlan(invalid))
})

test('cleanup plan rejects server payloads above the per-bucket limits', () => {
  const paths=Array.from({length:113},(_,index)=>`${ownerId}/${sessionId}/${answerId}/${String(index).padStart(8,'0')}-3333-4333-8333-333333333333.png`)
  assert.throws(()=>examSessionStorageCleanupPlan({
    ...cleanupPayload,
    storage_cleanup:{...cleanupPayload.storage_cleanup,'exam-answer-images':paths},
  }),/deleted_exam_cleanup_plan_invalid/)
})

test('database delete removes both buckets and verifies no queued object remains', async () => {
  const client=clientWith()
  const result=await deleteExamSessionWithStorageCleanup(client,{sessionId,confirmation:'删除 CS000362 c5a5f192'})
  assert.equal(result.recovered,false)
  assert.deepEqual(result.cleanup,{ok:true,attempted:3,remaining:0,failedBuckets:[]})
  assert.deepEqual(client.calls.filter(call=>call[0]==='rpc').map(call=>call[1]),[
    'admin_exam_delete_current_session','admin_exam_storage_cleanup_status',
  ])
  assert.deepEqual(client.calls.filter(call=>call[0]==='remove').map(call=>call[1]),[
    'exam-answer-images','exam-feedback-images',
  ])
})

test('a successful Storage response stays pending when the audit-backed rescan finds an object', async () => {
  const client=clientWith({statusResults:[{data:{
    ...emptyPayload,
    storage_cleanup:{...emptyPayload.storage_cleanup,'exam-feedback-images':[feedbackImage]},
  },error:null}]})
  const result=await deleteExamSessionWithStorageCleanup(client,{sessionId,confirmation:'删除 CS000362 c5a5f192'})
  assert.equal(result.cleanup.ok,false)
  assert.equal(result.cleanup.remaining,1)
  assert.deepEqual(result.cleanup.failedBuckets,['exam-feedback-images'])
})

test('Storage errors do not turn a committed database delete into a failed delete', async () => {
  const client=clientWith({
    removeErrors:{'exam-feedback-images':new Error('storage unavailable')},
    statusResults:[{data:{
      ...emptyPayload,
      storage_cleanup:{...emptyPayload.storage_cleanup,'exam-feedback-images':[feedbackImage]},
    },error:null}],
  })
  const result=await deleteExamSessionWithStorageCleanup(client,{sessionId,confirmation:'删除 CS000362 c5a5f192'})
  assert.equal(result.cleanup.ok,false)
  assert.deepEqual(result.cleanup.failedBuckets,['exam-feedback-images'])
})

test('lost delete response retries audit recovery briefly without repeating deletion', async () => {
  const deleteError=new Error('network response lost')
  const client=clientWith({
    deleteResult:{data:null,error:deleteError},
    deletedRecoveryResults:[
      {data:null,error:new Error('audit not visible yet')},
      {data:cleanupPayload,error:null},
    ],
    statusResults:[
      {data:emptyPayload,error:null},
    ],
  })
  const result=await deleteExamSessionWithStorageCleanup(client,{sessionId,confirmation:'删除 CS000362 c5a5f192',recoveryRetryDelayMs:0})
  assert.equal(result.recovered,true)
  assert.equal(result.cleanup.ok,true)
  assert.equal(client.calls.filter(call=>call[1]==='admin_exam_delete_current_session').length,1)
  assert.equal(client.calls.filter(call=>call[1]==='admin_exam_deleted_session_storage_cleanup').length,2)
})

test('known database success with an old response shape becomes cleanup-pending, not delete-failed', async () => {
  const client=clientWith({
    deleteResult:{data:{ok:true,deleted_session_id:sessionId},error:null},
    deletedRecoveryResults:[{data:null,error:new Error('temporary recovery failure')}],
  })
  const result=await deleteExamSessionWithStorageCleanup(client,{sessionId,confirmation:'删除 CS000362 c5a5f192'})
  assert.equal(result.cleanup.ok,false)
  assert.equal(result.data.ok,true)
})

test('retry reads a queued batch, removes it, then verifies the queue is empty', async () => {
  const client=clientWith({
    deletedRecoveryResults:[{data:cleanupPayload,error:null}],
    statusResults:[{data:emptyPayload,error:null}],
  })
  const result=await retryDeletedExamSessionStorageCleanup(client,sessionId)
  assert.equal(result.cleanup.ok,true)
  assert.equal(client.calls.filter(call=>call[1]==='admin_exam_deleted_session_storage_cleanup').length,1)
  assert.equal(client.calls.filter(call=>call[1]==='admin_exam_storage_cleanup_status').length,1)
})

test('an unverified delete keeps the original failure', async () => {
  const deleteError=new Error('permission_denied')
  const client=clientWith({
    deleteResult:{data:null,error:deleteError},
    deletedRecoveryResults:[{data:null,error:new Error('deleted_exam_audit_not_found')}],
  })
  await assert.rejects(
    deleteExamSessionWithStorageCleanup(client,{sessionId,confirmation:'bad',recoveryRetryDelayMs:0}),
    error=>error===deleteError,
  )
})

test('durable drain consumes bounded pending sessions and verifies each removal', async () => {
  const client=clientWith({statusResults:[{data:emptyPayload,error:null}]})
  const result=await drainPendingDeletedExamSessionStorageCleanup(client,20)
  assert.equal(result.attemptedSessions,1)
  assert.equal(result.cleanedSessions,1)
  assert.equal(result.pendingSessions,0)
  assert.deepEqual(client.calls.filter(call=>call[0]==='rpc').map(call=>call[1]),[
    'admin_exam_prune_storage_cleanup',
    'admin_exam_pending_storage_cleanup',
    'admin_exam_storage_cleanup_status',
    'admin_exam_prune_storage_cleanup',
  ])
  await assert.rejects(()=>drainPendingDeletedExamSessionStorageCleanup(client,21),/limit_invalid/)
})

test('corrective migration queues exact paths and exposes delete-operation-only cleanup', async () => {
  const migration=await readFile(new URL('../../supabase/migrations/20260905051127_restore_exam_session_detail_granular_permissions.sql',import.meta.url),'utf8')
  assert.match(migration,/create table if not exists session_private\.exam_storage_cleanup_queue/)
  assert.match(migration,/unique \(bucket_id, object_name\)/)
  assert.match(migration,/source_action in \('delete_current_session', 'grade_feedback_replaced'\)/)
  assert.match(migration,/insert into session_private\.exam_storage_cleanup_queue[\s\S]+admin_exam_delete_current_session_page_v1/)
  assert.match(migration,/v_old_feedback_attachments[\s\S]+v_new_feedback_attachments[\s\S]+grade_feedback_replaced/)
  assert.match(migration,/delete from session_private\.exam_storage_cleanup_queue cleanup[\s\S]+cleanup\.source_action = 'grade_feedback_replaced'[\s\S]+cleanup\.source_record_id = p_answer_id::text[\s\S]+cleanup\.object_name = new_attachment\.item->>'path'/)
  assert.match(migration,/object_owner_id = coalesce\(p_owner_id, ''\)/)
  assert.match(migration,/cleanup\.object_name = p_name/)
  assert.match(migration,/cleanup\.source_record_id = split_part\(p_name, '\/', 3\)/)
  assert.match(migration,/storage\.allow_any_operation\([\s\S]+storage\.object\.delete[\s\S]+storage\.object\.delete_many/)
  assert.match(migration,/create policy exam_deleted_session_storage_cleanup_read[\s\S]+for select/)
  assert.match(migration,/create policy exam_deleted_session_storage_cleanup_delete[\s\S]+for delete/)
  assert.doesNotMatch(migration,/create policy exam_deleted_session_storage_cleanup_[\s\S]{0,120}for (?:insert|update)/)
  assert.match(migration,/limit 113[\s\S]+limit 71[\s\S]+exam_storage_cleanup_limit_exceeded/)
  assert.match(migration,/limit 112[\s\S]+limit 70/)
  assert.match(migration,/create or replace function public\.admin_exam_pending_storage_cleanup\([\s\S]+stable[\s\S]+v_limit < 1 or v_limit > 20/)
  assert.match(migration,/create or replace function public\.admin_exam_storage_cleanup_status\([\s\S]+exam_queued_storage_cleanup_paths/)
  assert.match(migration,/create or replace function public\.admin_exam_prune_storage_cleanup\([\s\S]+not exists \([\s\S]+from storage\.objects[\s\S]+delete from session_private\.exam_storage_cleanup_queue/)
  assert.match(migration,/audit\.record_id = v_session_id::text[\s\S]+audit\.employee_id = cleanup\.employee_id[\s\S]+audit\.old_data->>'source_system' = 'current'/)
})

test('upload/delete concurrency uses canonical UUIDs and one namespace lock', async () => {
  const migration=await readFile(new URL('../../supabase/migrations/20260905051127_restore_exam_session_detail_granular_permissions.sql',import.meta.url),'utf8')
  for(const equality of [
    'v_parts[2] <> v_session_id::text',
    'v_parts[3] <> v_question_id::text',
    'v_parts[3] <> v_answer_id::text',
  ]) assert.ok(migration.includes(equality),`missing canonical guard ${equality}`)
  const deleteStart=migration.indexOf('create or replace function public.admin_exam_delete_current_session(')
  const deleteBody=migration.slice(deleteStart,migration.indexOf('revoke all on function public.admin_exam_delete_current_session',deleteStart))
  assert.ok(deleteBody.indexOf('for update') < deleteBody.indexOf("exam-answer-images/%s"))
  assert.ok(deleteBody.indexOf("exam-answer-images/%s") < deleteBody.indexOf("exam-feedback-images/%s"))
  const gradeStart=migration.indexOf('create function public.admin_exam_grade_answer_audit_inner_v1(')
  const gradeBody=migration.slice(gradeStart,migration.indexOf('revoke all on function public.admin_exam_grade_answer_audit_inner_v1',gradeStart))
  assert.ok(gradeBody.indexOf('from public.exam_sessions session_row') < gradeBody.indexOf('from public.exam_answers answer\n  where answer.id = p_answer_id\n  for update'))
  const feedbackGradeStart=migration.indexOf('create function public.admin_exam_grade_answer_with_feedback_images(')
  const feedbackGradeBody=migration.slice(feedbackGradeStart,migration.indexOf('revoke all on function public.admin_exam_grade_answer_with_feedback_images',feedbackGradeStart))
  assert.ok(feedbackGradeBody.indexOf('from public.exam_sessions session_row') < feedbackGradeBody.indexOf("exam-feedback-images/%s"))
  assert.ok(feedbackGradeBody.indexOf("exam-feedback-images/%s") < feedbackGradeBody.indexOf('from public.exam_answers answer\n  where answer.id = p_answer_id\n    and answer.session_id = v_session_id\n  for update'))

  for(const [name,endMarker] of [
    ['session_private.exam_feedback_storage_can_delete(', 'revoke all on function session_private.exam_feedback_storage_can_delete'],
    ['session_private.exam_storage_queue_can_cleanup(', 'revoke all on function session_private.exam_storage_queue_can_cleanup'],
  ]){
    const start=migration.indexOf(`create or replace function ${name}`)
    const body=migration.slice(start,migration.indexOf(endMarker,start))
    assert.match(body,/language plpgsql\s+volatile[\s\S]+set lock_timeout = '1500ms'/)
    assert.ok(body.indexOf("exam-feedback-images/%s") < body.indexOf('from public.exam_answers answer'))
  }
  const pendingStart=migration.indexOf('create or replace function public.admin_exam_pending_storage_cleanup(')
  const pendingBody=migration.slice(pendingStart,migration.indexOf('revoke all on function public.admin_exam_pending_storage_cleanup',pendingStart))
  assert.match(pendingBody,/language plpgsql\s+stable/)
  assert.doesNotMatch(pendingBody,/exam_storage_queue_can_cleanup/)
  assert.match(pendingBody,/exam_storage_cleanup_path_is_valid[\s\S]+delete_current_session[\s\S]+grade_feedback_replaced/)
})

test('delete modal keeps cleanup as a retryable partial outcome and the page drains durably', async () => {
  const source=await readFile(new URL('../pages/AdminTrainingPage.jsx',import.meta.url),'utf8')
  assert.match(source,/deleteExamSessionWithStorageCleanup\(supabase/)
  assert.match(source,/retryDeletedExamSessionStorageCleanup\(supabase,session\.id\)/)
  assert.match(source,/记录已删、附件清理待重试。/)
  assert.match(source,/drainPendingDeletedExamSessionStorageCleanup\(supabase\)/)
  assert.match(source,/window\.setInterval\(\(\)=>\{void drain\(\)\},120000\)/)
})
