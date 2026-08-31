import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const page=await readFile(new URL('../pages/OnlineTrainingPage.jsx',import.meta.url),'utf8')
const between=(start,end)=>page.slice(page.indexOf(start),page.indexOf(end))
const readCall=between('const readCall=async','const loadBootstrap=async')
const bootstrap=between('const loadBootstrap=async','const loadList=async')
const list=between('const loadList=async','useEffect(()=>{')

test('online-training hot RPC reads are bounded single attempts',()=>{
  assert.match(page,/const ONLINE_TRAINING_RPC_TIMEOUT_MS=12000/)
  assert.match(page,/isStatementTimeout=error=>text\(error\?\.code\)==='57014'/)
  assert.match(page,/statement timeout\|canceling statement due to statement timeout/)
  assert.match(readCall,/const query=supabase\.rpc\(name,args\)/)
  assert.match(readCall,/query\.abortSignal\(signal\)/)
  assert.doesNotMatch(readCall,/for\s*\(let attempt|await delay\(/)
})

test('bootstrap and list reads abort stale requests and only publish the latest result',()=>{
  assert.match(page,/const bootstrapRequestRef=useRef\(0\)[\s\S]*const bootstrapAbortRef=useRef\(null\)/)
  assert.match(page,/const listRequestRef=useRef\(0\)[\s\S]*const listAbortRef=useRef\(null\)/)

  assert.match(bootstrap,/const requestId=\+\+bootstrapRequestRef\.current/)
  assert.match(bootstrap,/bootstrapAbortRef\.current\?\.abort\(\)/)
  assert.match(bootstrap,/readCall\('online_training_context',\{\},controller\.signal\)/)
  assert.match(bootstrap,/requestId!==bootstrapRequestRef\.current\|\|controller\.signal\.aborted/)
  assert.match(bootstrap,/window\.setTimeout\(\(\)=>\{timedOut=true;controller\.abort\(\)\},ONLINE_TRAINING_RPC_TIMEOUT_MS\)/)
  assert.match(bootstrap,/if\(requestId===bootstrapRequestRef\.current\)setLoading\(false\)/)

  assert.match(list,/const requestId=\+\+listRequestRef\.current[\s\S]*listAbortRef\.current\?\.abort\(\)/)
  assert.match(list,/controller\.signal/)
  assert.match(list,/if\(requestId!==listRequestRef\.current\)return/)
  assert.match(list,/if\(requestId===listRequestRef\.current\)\{setLoading\(false\);setSearching\(false\)\}/)
})

test('canceled requests are cleaned up while explicit user retries remain available',()=>{
  assert.match(page,/return\(\)=>\{[\s\S]*bootstrapRequestRef\.current\+=1[\s\S]*bootstrapAbortRef\.current\?\.abort\(\)[\s\S]*listAbortRef\.current\?\.abort\(\)/)
  assert.match(page,/retry:\(\)=>\{listIntentRef\.current='刷新线上培训记录';return loadBootstrap\(\{announceFailure:true\}\)\}/)
  assert.match(page,/retry:\(\)=>loadList\(\{silent:true,announceFailure:true,operation:'刷新线上培训记录'\}\)/)
  assert.doesNotMatch(page,/for\(let attempt=0;attempt<3/)
})
