import test from 'node:test'
import assert from 'node:assert/strict'
import { adminNavigation } from './navigation.js'
import { PERMISSIONS } from './permissions.js'
import { buildRolePermissionSections, uniquePermissionIds } from './rolePermissionCatalog.js'

const catalogPermissions = Object.values(PERMISSIONS).map((code, index) => ({
  id: `permission-${index}`,
  code,
  name: code,
  category: code.split('.')[0],
  sensitive: code.startsWith('sensitive.'),
}))

test('role permission editor follows the current sidebar module and page order', () => {
  const sections = buildRolePermissionSections(catalogPermissions)
  const visibleSections = sections.filter(section => section.key !== 'system_supplement')

  assert.deepEqual(
    visibleSections.map(section => section.label),
    adminNavigation.map(section => section.label),
  )

  for (const navigationSection of adminNavigation.filter(section => section.children)) {
    const permissionSection = visibleSections.find(section => section.key === navigationSection.id)
    assert.deepEqual(
      permissionSection.pages.map(page => page.label),
      navigationSection.children.map(page => page.label),
    )
  }
})

test('latest menu pages expose their supported granular operations', () => {
  const sections = buildRolePermissionSections(catalogPermissions)
  const page = label => sections.flatMap(section => section.pages).find(item => item.label === label)
  const codes = label => new Set(page(label).items.map(permission => permission.code))

  assert.ok(codes('员工档案查询表').has(PERMISSIONS.EMPLOYEE_CREATE))
  assert.ok(codes('员工档案查询表').has(PERMISSIONS.EMPLOYEE_EDIT))
  assert.ok(codes('员工档案查询表').has(PERMISSIONS.EMPLOYEE_DELETE))
  assert.deepEqual([...codes('人员对账表')],[PERMISSIONS.EMPLOYEE_RECONCILIATION_VIEW])
  assert.ok(codes('停电/断网记录').has(PERMISSIONS.CONNECTIVITY_CREATE))
  assert.ok(codes('停电/断网记录').has(PERMISSIONS.CONNECTIVITY_DELETE))
  assert.ok(codes('后台账号').has(PERMISSIONS.ACCOUNT_CREATE))
  assert.ok(codes('后台账号').has(PERMISSIONS.ACCOUNT_EDIT))
  assert.ok(codes('后台账号').has(PERMISSIONS.ACCOUNT_DELETE))
  assert.ok(codes('后台账号').has(PERMISSIONS.SCOPE_MANAGE))
  assert.ok(codes('奖惩表').has(PERMISSIONS.ADJUSTMENT_PAGE_EDIT))
  assert.ok(codes('奖惩表').has(PERMISSIONS.ADJUSTMENT_BONUS_VIEW))
  assert.ok(codes('奖惩表').has(PERMISSIONS.ADJUSTMENT_DEDUCTION_VIEW))
  assert.ok(!codes('后台角色权限').has(PERMISSIONS.ROLE_MANAGE))
  const allVisibleCodes = new Set(sections.flatMap(section => section.pages).flatMap(item => item.items).map(permission => permission.code))
  assert.ok(!allVisibleCodes.has(PERMISSIONS.ROLE_MANAGE))
  assert.ok(!allVisibleCodes.has(PERMISSIONS.ADJUSTMENT_PAGE_APPROVE))
  assert.deepEqual(
    [...codes('后台登入IP白名单')],
    [PERMISSIONS.ACCOUNT_IP_ALLOWLIST_VIEW, PERMISSIONS.ACCOUNT_IP_ALLOWLIST_MANAGE],
  )
  assert.ok(codes('修改工资信息记录').has(PERMISSIONS.PAYROLL_CHANGE_HISTORY_VIEW))
  assert.ok(codes('修改工资信息记录').has(PERMISSIONS.PAYROLL_CHANGE_HISTORY_REVIEW))
  assert.ok(codes('修改工资信息记录').has(PERMISSIONS.PAYROLL_CHANGE_HISTORY_DELETE))
  assert.deepEqual([...codes('后台操作日志')],[PERMISSIONS.ACCOUNT_ACTIVITY_LOG_VIEW])
})

test('English sidebar tabs keep the same granular action permissions', () => {
  const sections = buildRolePermissionSections(catalogPermissions)
  const page = label => sections.flatMap(section => section.pages).find(item => item.label === label)
  const codes = label => new Set(page(label).items.map(permission => permission.code))

  assert.ok(codes('人员分析表').has(PERMISSIONS.TEAM_EDIT))
  assert.ok(codes('月考勤休假记录表').has(PERMISSIONS.ATTENDANCE_MONTHLY_EDIT))
  assert.ok(codes('奖惩表').has(PERMISSIONS.ADJUSTMENT_PAGE_CREATE))
  assert.ok(codes('奖惩表').has(PERMISSIONS.ADJUSTMENT_PAGE_EDIT))
  assert.ok(codes('奖惩表').has(PERMISSIONS.ADJUSTMENT_BONUS_VIEW))
  assert.ok(codes('奖惩表').has(PERMISSIONS.ADJUSTMENT_DEDUCTION_VIEW))
  assert.ok(codes('题库表').has(PERMISSIONS.EXAM_QUESTION_BANK_MANAGE))
  assert.ok(codes('考试记录表').has(PERMISSIONS.EXAM_RECORDS_DELETE))
  assert.ok(codes('待发布工资表').has(PERMISSIONS.PAYROLL_PENDING_PUBLISH))
  assert.ok(codes('导入记录').has(PERMISSIONS.PAYROLL_IMPORT_HISTORY_EDIT))
  assert.ok(codes('导入记录').has(PERMISSIONS.PAYROLL_IMPORT_HISTORY_DELETE))
  assert.ok(codes('员工前端账号').has(PERMISSIONS.USER_MANAGE))
  assert.ok(codes('后台账号').has(PERMISSIONS.SCOPE_MANAGE))
  assert.ok(!codes('后台角色权限').has(PERMISSIONS.ROLE_MANAGE))
})

test('all configurable pages, including the backend manual, have a unique view code', () => {
  const futurePermission = {
    id: 'future-permission',
    code: 'future_feature.archive',
    name: '归档未来功能',
    category: 'future',
    sensitive: false,
  }
  const sections = buildRolePermissionSections([...catalogPermissions, futurePermission])
  const visibleItems = sections.flatMap(section => section.pages).flatMap(page => page.items)
  const visibleCodes = new Set(visibleItems.map(item => item.code))
  const visibleIds = visibleItems.map(item => item.id)
  const pendingCodes = new Set(sections.flatMap(section => section.pages).flatMap(page => page.pendingCodes || []))

  assert.equal(visibleIds.length, new Set(visibleIds).size)
  assert.equal(pendingCodes.size, 0)
  assert.ok(sections.find(section => section.key === 'system_supplement')?.pages[0].items.some(item => item.code === futurePermission.code))
  const currentPages=sections.filter(section=>section.key!=='system_supplement').flatMap(section=>section.pages)
  const manual=currentPages.find(page=>page.label==='后台功能用途手册')
  const viewCodes=currentPages.map(page=>page.items.find(item=>item.actionKey==='view')?.code)
  assert.equal(currentPages.length,37)
  assert.deepEqual(manual?.items.map(item=>item.code),[PERMISSIONS.ACCOUNT_MANUAL_VIEW])
  assert.match(manual?.description||'',/查看平台各模块/)
  assert.ok(viewCodes.every(Boolean))
  assert.equal(new Set(viewCodes).size,37)
  assert.equal(uniquePermissionIds(visibleItems).length, visibleItems.length)
})

test('every latest sidebar child page remains visible with selectable permissions', () => {
  const sections = buildRolePermissionSections(catalogPermissions)

  for (const navigationSection of adminNavigation) {
    const permissionSection = sections.find(section => section.key === navigationSection.id)
    assert.ok(permissionSection, `missing section ${navigationSection.id}`)
    assert.deepEqual(
      permissionSection.pages.map(page => page.label),
      (navigationSection.children || [navigationSection]).map(page => page.label),
    )
    for (const page of permissionSection.pages) {
      assert.ok(page.items.length > 0, `${page.label} must expose a real permission`)
      assert.equal(page.pendingCodes.length,0)
    }
  }
})
