import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
const edgeFunction = await readFile(new URL('../../supabase/functions/admin-employees/index.ts', import.meta.url), 'utf8')
const riskEdgeFunction = await readFile(new URL('../../supabase/functions/admin-employee-risk-list/index.ts', import.meta.url), 'utf8')

test('employee archive refresh always uses the unified directory reader', () => {
  const refreshStart = page.indexOf('const refreshEmployeeData=async')
  const refreshEnd = page.indexOf('refreshEmployeeDataRef.current=refreshEmployeeData', refreshStart)
  assert.ok(refreshStart > 0 && refreshEnd > refreshStart)
  const refreshSource = page.slice(refreshStart, refreshEnd)

  assert.match(refreshSource, /tab==='员工档案'[\s\S]*loadEmployeeDirectory\(page,pageSize,\{silent,nextFilters:appliedFilters\}\)/)
  assert.doesNotMatch(refreshSource, /tab==='员工档案'[\s\S]{0,180}loadBootstrap|tab==='员工档案'[\s\S]{0,180}loadList/)
  assert.doesNotMatch(refreshSource, /loadAnalytics\(/)
  assert.match(refreshSource, /tab==='人员分析'[\s\S]+loadPeopleAnalytics/)
})

test('the first unfiltered analytics result is reused instead of requested twice', () => {
  const peopleStart = page.indexOf('const loadPeopleAnalytics=async')
  const peopleEnd = page.indexOf('const loadResignationAnalytics=async', peopleStart)
  assert.ok(peopleStart > 0 && peopleEnd > peopleStart)
  const peopleSource = page.slice(peopleStart, peopleEnd)

  assert.match(peopleSource, /if\(!hasFilterValues\(nextFilters\)\)/)
  assert.match(peopleSource, /setAnalytics\(\{\.\.\.data,loading:false,error:''\}\)/)
  assert.match(peopleSource, /setResignationAnalytics\(\{\.\.\.data,loading:false,error:''\}\)/)
})

test('archive filters use lightweight metadata and expose the Edge response body', () => {
  assert.match(page, /employee-team-filter[\s\S]*?meta\.teams|meta\.teams[\s\S]*?employee-team-filter/)
  assert.match(page, /employee-position-filter[\s\S]*?meta\.positions|meta\.positions[\s\S]*?employee-position-filter/)
  assert.match(page, /edgeFunctionErrorMessage\(\{data,error,fallback:'操作失败'\}\)/)
  assert.doesNotMatch(page, /data\?\.error\|\|error\?\.message\|\|'操作失败'/)
})

test('employee archive starts at 20 rows and keeps loaded rows visible during a failed refresh', () => {
  assert.match(page, /const \[pageSize,setPageSizeState\]=useState\(20\)/)
  assert.doesNotMatch(page, /wfh_employee_page_size/)

  const requestStart = page.indexOf('const executeEmployeeDirectoryRequest=async')
  const requestEnd = page.indexOf('const loadHistory=async', requestStart)
  const requestSource = page.slice(requestStart, requestEnd)
  assert.match(requestSource, /setError\(employeeRequestError\(e,rows\.length\?'员工档案刷新失败，已保留当前列表，请稍后重试。':'员工档案读取失败，请稍后重试。'\)\)/)
  assert.doesNotMatch(requestSource, /setRows\(\[\]\)/)
  assert.match(page, /loading&&rows\.length===0\?<div className="empty-state">读取中\.\.\.<\/div>/)
})

test('employee bootstrap authorizes before calculating one scope result', () => {
  const serveStart=edgeFunction.indexOf('Deno.serve(async (req) =>')
  const handler=edgeFunction.slice(serveStart)
  assert.ok(handler.indexOf('body=await req.json()')<handler.indexOf('const caller = await getCaller'))
  assert.ok(handler.indexOf('const requestedAction=text(body?.action||"list")')<handler.indexOf('const scope = await scopeInfo'))
  assert.ok(handler.indexOf('finishStage("authorize")')<handler.indexOf('const scope = await scopeInfo'))
  assert.match(handler,/action === "resign_employee"[\s\S]{0,120}?"employee\.directory\.resign"/)
  assert.match(handler,/action === "update_resignation"[\s\S]{0,120}?"employee\.resignations\.resign"/)
  assert.match(handler,/action === "cancel_new_hire"[\s\S]{0,120}?"employee\.delete"/)
  assert.ok(handler.indexOf('legacy_write_disabled')<handler.indexOf('const scope = await scopeInfo'))
  assert.equal((handler.match(/scopeInfo\(service, caller\)/g)||[]).length,1)
  assert.match(handler, /if\(action==="bootstrap"\)[\s\S]*buildEmployeeMeta\(service,caller,scope\)[\s\S]*buildEmployeeList\(service,caller,scope,body\)[\s\S]*return respond\(\{meta,list\}\)/)
  assert.match(page, /action:'bootstrap',page:request\.page,page_size:request\.pageSize/)

  const initialBootstrap=page.slice(page.indexOf("if(adminAccess.loading||tab!=='员工档案'"),page.indexOf("if(adminAccess.loading||!['人员分析','操作日志']"))
  assert.match(initialBootstrap,/loadEmployeeDirectory\(1,pageSize/)
  assert.match(initialBootstrap,/if\(success\)[\s\S]*loadArchiveStats\(\)/)
  assert.doesNotMatch(initialBootstrap,/loadBootstrap\(|loadMeta\(|loadList\(/)
})

test('employee directory reads are serialized, latest-wins, and never call the second operator Edge', () => {
  assert.match(page,/employeeDirectoryRequestRef=useRef\(\{inFlight:null,activeKey:'',pending:null\}\)/)
  assert.match(page,/state\.pending=queued/)
  assert.match(page,/current=state\.pending/)
  assert.match(page,/const isCurrent=\(\)=>sameIdentity\(\)&&!state\.pending/)
  const unifiedStart=page.indexOf('const loadEmployeeDirectory=async')
  const unifiedEnd=page.indexOf('const loadHistory=async',unifiedStart)
  const unifiedSource=page.slice(unifiedStart,unifiedEnd)
  assert.match(unifiedSource,/usesSpecialReader/)
  assert.match(unifiedSource,/if\(!usesSpecialReader\) return loadBootstrap/)
  assert.match(unifiedSource,/kind:'meta'[\s\S]*kind:'list'/)
  assert.equal(unifiedSource.match(/loadBootstrap\(/g)?.length,1)
  assert.doesNotMatch(page,/functions\.invoke\('admin-employee-operators'/)
  assert.match(edgeFunction,/loadEmployeeOperatorAccounts\(service,rows\)/)
  assert.match(edgeFunction,/operator_account:operatorMap\.get\(text\(row\.id\)\)\|\|""/)
})

test('employee identity and scope changes invalidate every directory response and sensitive drawer', () => {
  assert.match(page,/employeeAccessKey=useMemo\(\(\)=>JSON\.stringify\(\[/)
  assert.match(page,/adminAccess\.authUserId[\s\S]*adminAccess\.dataScope[\s\S]*adminAccess\.teamId[\s\S]*adminAccess\.positionId[\s\S]*adminAccess\.permissionKey/)
  const invalidationStart=page.indexOf('if(state.accessKey!==employeeAccessKey)')
  const guard=page.indexOf("if(adminAccess.loading||tab!=='员工档案'||!canViewEmployees)return",invalidationStart)
  assert.ok(invalidationStart>0&&guard>invalidationStart)
  const invalidation=page.slice(invalidationStart,guard)
  assert.match(invalidation,/state\.epoch\+=1/)
  assert.match(invalidation,/employeeDirectoryRequestRef\.current\.pending=null/)
  assert.match(invalidation,/setRows\(\[\]\);setTotal\(0\);setMeta\(emptyEmployeeMeta\(\)\)/)
  assert.match(invalidation,/setSelected\(null\)[\s\S]*setEmployeeModal\(null\)/)
})

test('operator enrichment is fail-open and bounded for 500-row exports', () => {
  assert.match(edgeFunction,/joinLimit=Math\.min\(Math\.max\(ids\.length\*4,20\),2000\)/)
  assert.match(edgeFunction,/auditLimit=Math\.min\(Math\.max\(ids\.length\*10,50\),5000\)/)
  assert.match(edgeFunction,/operator_enrichment_skipped[\s\S]*return fallback/)
})

test('risk reader preserves 401/403/503/400 semantics without treating timeouts as logout', () => {
  assert.match(riskEdgeFunction,/new HttpError\(401, 'session_not_current'/)
  assert.match(riskEdgeFunction,/new HttpError\(403, 'permission_denied'/)
  assert.match(riskEdgeFunction,/status:503, code:'service_temporarily_unavailable', retryable:true/)
  assert.match(riskEdgeFunction,/new HttpError\(400, 'invalid_json'/)
  assert.match(riskEdgeFunction,/error:failure\.message, code:failure\.code, retryable:failure\.retryable/)
  assert.doesNotMatch(riskEdgeFunction,/message === 'SESSION_NOT_CURRENT'.*500/)
})

test('employee Edge failures preserve auth semantics and expose retryable 503s', () => {
  assert.match(edgeFunction, /let requestAction = "unknown"/)
  assert.match(edgeFunction, /new HttpError\(401,"not_authenticated"/)
  assert.match(edgeFunction, /new HttpError\(403,"permission_denied"/)
  assert.match(edgeFunction, /code==="57014"/)
  assert.match(edgeFunction, /status:503,code:"service_temporarily_unavailable",retryable:true/)
  assert.match(edgeFunction, /event:"request_complete"[\s\S]*stages_ms:stageMs/)
  const logSource=edgeFunction.slice(edgeFunction.indexOf('const log={'),edgeFunction.indexOf('(status>=400?console.error'))
  assert.doesNotMatch(logSource,/message|body|userId|loginUsername/)
  assert.match(edgeFunction, /\{error:failure\.message,code:failure\.code,retryable:failure\.retryable,action:requestAction\}/)
})

test('write-only position options are lazy and cannot delay archive bootstrap', () => {
  const bootstrapStart=page.indexOf('const loadBootstrap=async')
  const bootstrapEnd=page.indexOf('const loadList=async',bootstrapStart)
  const bootstrapSource=page.slice(bootstrapStart,bootstrapEnd)
  assert.doesNotMatch(bootstrapSource,/admin-employee-write|loadMasterPositionOptions|ensureMasterPositionOptions/)
  assert.match(page,/const ensureMasterPositionOptions=async/)
  assert.match(page,/const openCreate=\(\)=>\{[\s\S]*void ensureMasterPositionOptions\(\)/)
  assert.match(page,/const openEdit=async\(\)=>\{[\s\S]*void ensureMasterPositionOptions\(\)/)
})
