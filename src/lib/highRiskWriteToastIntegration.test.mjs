import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8')
const section = (value, start, end) => {
  const from = value.indexOf(start)
  const to = value.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`)
  return value.slice(from, to)
}

const [payroll, paymentChange, users, alerts, staffExam] = await Promise.all([
  source('../pages/AdminPayrollPage.jsx'),
  source('../components/PaymentChangeWorkflow.jsx'),
  source('../pages/AdminUsersPage.jsx'),
  source('../components/AdminAlertCenter.jsx'),
  source('../pages/StaffExamPage.jsx'),
])

test('payroll and payment-change writes retain inline errors and only retry safe reads', () => {
  for (const value of [payroll, paymentChange]) {
    assert.match(value, /useAppToast/)
    assert.match(value, /writeFailureToast/)
    assert.match(value, /writeSuccessToast/)
  }

  assert.match(payroll, /operation:'导入工资'[^]*refresh:refreshImportHistory/)
  assert.match(payroll, /operation:'发布工资'[^]*refresh:\(\)=>load\(id,'待发布'\)/)
  assert.match(payroll, /operation:'移除工资草稿'[^]*refresh:\(\)=>load\(batch\.id,'待发布'\)/)
  assert.doesNotMatch(payroll, /refresh:\s*(?:importRows|publish|deleteBatch|runBatchAction)\b/)
  assert.match(payroll, /setMessage\(reason\)[^]*writeFailureToast/)

  assert.match(paymentChange, /operation:'提交修改申请'[^]*refresh:load/)
  assert.match(paymentChange, /operation[^]*payment-change:review:[^]*refresh:load/)
  assert.doesNotMatch(paymentChange, /refresh:\s*(?:submit|decide)\b/)
  assert.match(paymentChange, /setMessage\(reason\)[^]*writeFailureToast/)
})

test('account actions use one global surface and name partial batch outcomes', () => {
  assert.match(users, /const \{ notify \} = useAppToast\(\)/)
  assert.doesNotMatch(users, /accountToast|setAccountToast/)
  assert.match(users, /已成功创建 \$\{result\.created_count \|\| 0\} 个，\$\{failed\.length\} 个失败/)
  assert.match(users, /失败账号已保留在清单中/)

  for (const name of ['toggleOtp', 'toggleActive', 'resetPassword', 'resetMfa', 'deleteAccount', 'createRole', 'saveRole', 'deleteRole']) {
    const from = users.indexOf(`const ${name} = async`)
    assert.ok(from >= 0, `missing ${name}`)
    const next = users.indexOf('\n  const ', from + 10)
    const body = users.slice(from, next < 0 ? users.length : next)
    assert.match(body, /writeSuccessToast/, `${name} needs a success toast`)
    assert.match(body, /writeFailureToast/, `${name} needs a failure toast`)
  }
  assert.doesNotMatch(users, /refresh:\s*(?:saveAccount|saveStaffAccount|toggleOtp|toggleActive|resetPassword|resetMfa|deleteAccount|createRole|saveRole|deleteRole)\b/)
})

test('warning writes toast, while automatic reads and summary refreshes remain quiet', () => {
  assert.match(alerts, /function AlertFollowUpPanel[^]*writeSuccessToast[^]*writeFailureToast/)
  assert.match(alerts, /refresh:onRefresh/)
  assert.match(alerts, /alerts:bell:mark-all:success/)
  assert.match(alerts, /alerts:records:mark-all:success/)

  const backgroundLoad = section(alerts, "const load = ({ kind='details', quiet=false } = {}) =>", 'useEffect(() => {\n    if (!enabled)')
  assert.doesNotMatch(backgroundLoad, /notify\(/)
  const automaticOpen = section(alerts, 'const openAlert = async row =>', 'const markAll = async () =>')
  assert.doesNotMatch(automaticOpen, /notify\(/)
  const automaticMarkOne = section(alerts, 'const markOne = async row =>', 'const markAll = async () =>')
  assert.doesNotMatch(automaticMarkOne, /notify\(/)
})

test('staff exam keeps auto-save success quiet and de-duplicates its failure per session', () => {
  assert.match(staffExam, /const saveFailureNotified = useRef\(false\)/)
  assert.match(staffExam, /if \(!saveFailureNotified\.current\)[^]*dedupeKey:`staff-exam:save:\$\{session\.id\}:error`/)
  assert.match(staffExam, /if \(!automatic\) notify\(writeFailureToast/)
  assert.match(staffExam, /else notify\(writeSuccessToast/)
  assert.match(staffExam, /if \(automatic\) window\.alert\(tr\('autoSubmitted'\)\)/)

  const saveAnswer = section(staffExam, 'const save = async (targetQuestion', 'const go = async nextIndex')
  assert.doesNotMatch(saveAnswer, /writeSuccessToast/)
  assert.doesNotMatch(saveAnswer, /refresh:/)
  assert.doesNotMatch(staffExam, /refresh:\s*(?:save|submit|start)\b/)
})
