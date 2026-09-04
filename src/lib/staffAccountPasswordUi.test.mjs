import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../pages/AdminUsersPage.jsx', import.meta.url), 'utf8')

const sourceSection = (start, end) => {
  const from = page.indexOf(start)
  const to = page.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`)
  return page.slice(from, to)
}

test('staff password reset and delete are exposed only through advertised recovery actions', () => {
  assert.match(page, /const recoveryStaffCan = action => Boolean\(recoveryStaffAccountMode && recoveryStaffAccountActions\.has\(action\)\)/)
  assert.match(page, /const canResetStaffPassword = recoveryStaffCan\('reset_staff_password'\)/)
  assert.match(page, /const canDeleteStaff = recoveryStaffCan\('delete_staff_account'\)/)
  assert.doesNotMatch(page, /const canResetStaffPassword = \(!recoveryStaffAccountMode/)
  assert.doesNotMatch(page, /const canDeleteStaff = \(!recoveryStaffAccountMode/)
  assert.match(page, /canResetStaffPassword && <button[^>]+onClick=\{\(\) => openPasswordReset\(a, 'staff'\)\}/)
  assert.match(page, /canDeleteStaff && <button[^>]+onClick=\{\(\) => deleteAccount\(a, 'staff'\)\}/)
  assert.match(page, /openPasswordReset\(a, 'backend'\)/)
})

test('recovery staff reset sends the exact identity confirmation fields', () => {
  const reset = sourceSection('const resetPassword = async', 'const unlockLogin = async')
  assert.match(sourceSection('const openPasswordReset =', 'const closePasswordReset ='), /accountKind === 'staff' && !recoveryStaffCan\('reset_staff_password'\)/)
  assert.match(reset, /if \(staffAccount && !recoveryStaffCan\('reset_staff_password'\)\)/)
  assert.match(reset, /const recoveryStaffReset = staffAccount/)
  assert.match(reset, /action:'reset_staff_password',[\s\S]*auth_user_id:account\.auth_user_id,[\s\S]*password,[\s\S]*expected_login_email:expectedLoginEmail,[\s\S]*expected_employee_no:expectedEmployeeNo/)
  assert.match(reset, /action:'reset_password',[\s\S]*auth_user_id:account\.auth_user_id,[\s\S]*password/)
  assert.match(reset, /account\.employee\?\.employee_no/)
  assert.match(reset, /module:staffAccount\?'员工账号':'后台账号'/)
  assert.doesNotMatch(reset, /window\.prompt/)
})

test('compact reset dialog validates and confirms the password without a browser prompt', () => {
  assert.match(page, /const passwordRuleState = password => \(\{[\s\S]*length:[\s\S]*uppercase:[\s\S]*lowercase:[\s\S]*number:[\s\S]*symbol:/)
  assert.match(page, /className="modal-card password-reset-modal" role="dialog" aria-modal="true"/)
  assert.match(page, /id="password-reset-new"[\s\S]*autoComplete="new-password"/)
  assert.match(page, /id="password-reset-confirm"[\s\S]*autoComplete="new-password"/)
  assert.match(page, /passwordVisible:\!current\.passwordVisible/)
  assert.match(page, /password !== passwordConfirmation/)
  assert.match(page, /\.password-reset-modal>\.modal-actions button:disabled/)
  assert.match(page, /@media\(max-width:700px\)[\s\S]*password-reset-account,\.password-rule-list\{grid-template-columns:1fr\}/)
})

test('staff reset copy explains session revocation and optional self-service password change', () => {
  assert.match(page, /只重置员工登录账号；旧会话会立即撤销。员工可使用新密码登录，之后也可在员工门户自行修改密码；员工档案不受影响。/)
  assert.match(page, /登录密码已重置，旧会话已撤销。员工可使用新密码登录，并可在员工门户自行修改密码。/)
  assert.match(page, /重置只影响员工登录账号并立即撤销旧会话；员工可用新密码登录，之后也可在员工门户自行修改。/)
  assert.doesNotMatch(sourceSection('const openPasswordReset =', 'const unlockLogin = async'), /强制|下次登录.*改密/)
  assert.doesNotMatch(sourceSection('const openPasswordReset =', 'const unlockLogin = async'), /新的临时密码|输入新的临时密码/)
})

test('recovery staff deletion keeps typed confirmation and explains retained history', () => {
  const deletion = sourceSection('const deleteAccount = async', 'const createRole = async')
  assert.match(deletion, /if \(staffAccount && !recoveryStaffCan\('delete_staff_account'\)\) return/)
  assert.match(deletion, /const recoveryStaffDelete = staffAccount/)
  assert.match(deletion, /const typed = window\.prompt/)
  assert.match(deletion, /请输入员工ID \$\{employeeNo\} 以确认删除/)
  assert.match(deletion, /结束该账号的当前登录会话/)
  assert.match(deletion, /员工档案、考试成绩与答案（含上传图片）、考勤记录及日报历史都会保留/)
  assert.match(deletion, /生成新的激活码并由员工重新注册/)
  assert.match(deletion, /员工登录账号已删除并已退出登录/)
})
