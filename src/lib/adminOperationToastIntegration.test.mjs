import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8')

const [attendance, dailyRoute, onlineTraining, training] = await Promise.all([
  source('../pages/AdminAttendancePage.jsx'),
  source('../pages/AdminDailyWorkPage.jsx'),
  source('../pages/OnlineTrainingPage.jsx'),
  source('../pages/AdminTrainingPage.jsx'),
])

test('attendance toasts are gated by explicit read intent and preserve contextual errors', () => {
  assert.match(attendance, /import \{ useAppToast \} from '\.\.\/components\/AppToastProvider'/)
  assert.match(attendance, /const requestedOperation=mainReadIntentRef\.current[\s\S]*?if\(requestedOperation\)notify\(/)
  assert.match(attendance, /const query=\(\)=>\{mainReadIntentRef\.current='查询考勤数据'[\s\S]*?setRefreshKey/)
  assert.match(attendance, /const requestedOperation=readIntentRef\.current[\s\S]*?operation:requestedOperation/)
  assert.match(attendance, /考勤数据读取失败：\{state\.error\}/)
  assert.match(attendance, /adjustment-editor-error/)
  assert.match(attendance, /retry:onRefreshConfirm,retryLabel:'刷新确认'/)
  assert.doesNotMatch(attendance, /retry:\s*submit/)
  assert.match(attendance, /operation:'保存奖金 \/ 扣款'[\s\S]*?type:'success'|type:'success'[\s\S]*?operation:'保存奖金 \/ 扣款'/)
})

test('daily route integrates only the active online training page', () => {
  assert.match(dailyRoute, /export default function AdminDailyWorkPage\(\)[\s\S]*return <OnlineTrainingPage\/>/)
  assert.doesNotMatch(dailyRoute, /useAppToast/)
  assert.match(onlineTraining, /const \{notify\}=useAppToast\(\)/)
})

test('online training keeps initial and silent reads quiet while explicit failures can retry reads', () => {
  assert.match(onlineTraining, /useEffect\(\(\)=>\{loadBootstrap\(\)\},\[\]\)/)
  assert.match(onlineTraining, /setTimeout\(\(\)=>loadList\(\{silent:true\}\),0\)/)
  assert.match(onlineTraining, /const requestedOperation=operation\|\|\(announceFailure\?'查询线上培训记录':listIntentRef\.current\)/)
  assert.match(onlineTraining, /if\(requestedOperation\)notify\([\s\S]*?retry:\(\)=>loadList/)
  assert.match(onlineTraining, /rosterError:message/)
  assert.match(onlineTraining, /setDeleteError\(reason\)/)
  assert.match(onlineTraining, /validation:\{message:reason,issues:\[\]\}/)
})

test('online training mutations never replay writes and name partial failures by stage', () => {
  for (const operation of [
    '保存后刷新日报列表',
    '清理旧附件',
    '删除后刷新日报列表',
    '保存批注后刷新列表',
  ]) assert.ok(onlineTraining.includes(operation), `missing partial-success operation ${operation}`)

  assert.doesNotMatch(onlineTraining, /retry:\s*\(\)\s*=>\s*saveReport/)
  assert.doesNotMatch(onlineTraining, /retry:\s*\(\)\s*=>\s*archiveReport/)
  assert.doesNotMatch(onlineTraining, /retry:\s*\(\)\s*=>\s*reviewReport/)
  assert.match(onlineTraining, /retry:\(\)=>loadList\([\s\S]*?retryLabel:'刷新确认'/)
  assert.match(onlineTraining, /operation:saveOperation[\s\S]*?type:'success'|type:'success'[\s\S]*?operation:saveOperation/)
})

test('exam management gates page reads, leaves progressive partial analytics inline, and removes blocking save alerts', () => {
  assert.match(training, /const \{notify\}=useAppToast\(\)/)
  assert.match(training, /const requestedOperation=questionReadIntentRef\.current[\s\S]*?if\(requestedOperation\)notify\(/)
  assert.match(training, /const requestedOperation=sessionReadIntentRef\.current[\s\S]*?if\(requestedOperation\)notify\(/)
  assert.match(training, /setOverviewStaleNotice\(failedModuleLabels\.length\?`暂时无法更新：\$\{failedModuleLabels\.join\('、'\)\}/)
  assert.doesNotMatch(training, /alert\(message\(/)
  assert.match(training, /\{error&&<div className="exam-error">\{error\}<\/div>\}/)
  assert.match(training, /questionSearchVersion/)
  assert.match(training, /sessionSearchVersion/)
})

test('exam mutations expose only refresh-confirm callbacks after failure', () => {
  for (const key of [
    'training:question:delete:error',
    'training:session:delete:error',
    'training:question:${editing?',
    'training:answer:grade:error',
  ]) assert.ok(training.includes(key), `missing exam failure toast ${key}`)

  assert.match(training, /retry:onRefreshConfirm,retryLabel:'刷新确认'/)
  assert.doesNotMatch(training, /retry:\s*\(\)\s*=>\s*deleteQuestion/)
  assert.doesNotMatch(training, /retry:\s*\(\)\s*=>\s*remove/)
  assert.doesNotMatch(training, /retry:\s*\(\)\s*=>\s*save/)
  assert.doesNotMatch(training, /retry:\s*\(\)\s*=>\s*grade/)
})
