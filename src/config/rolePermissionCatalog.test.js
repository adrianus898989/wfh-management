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
  assert.ok(codes('停电/断网记录').has(PERMISSIONS.CONNECTIVITY_CREATE))
  assert.ok(codes('停电/断网记录').has(PERMISSIONS.CONNECTIVITY_DELETE))
  assert.ok(codes('后台账号').has(PERMISSIONS.ACCOUNT_CREATE))
  assert.ok(codes('后台账号').has(PERMISSIONS.ACCOUNT_EDIT))
  assert.ok(codes('后台账号').has(PERMISSIONS.ACCOUNT_DELETE))
  assert.ok(codes('修改工资信息记录').has(PERMISSIONS.PAYROLL_PAYOUT_CHANGE_VIEW))
  assert.ok(page('修改工资信息记录').pendingCodes.includes(PERMISSIONS.PAYROLL_PAYOUT_CHANGE_REVIEW))
})

test('English sidebar tabs keep the same granular action permissions', () => {
  const sections = buildRolePermissionSections(catalogPermissions)
  const page = label => sections.flatMap(section => section.pages).find(item => item.label === label)
  const codes = label => new Set(page(label).items.map(permission => permission.code))

  assert.ok(codes('人员分析表').has(PERMISSIONS.TEAM_EDIT))
  assert.ok(page('月考勤休假记录表').pendingCodes.includes(PERMISSIONS.ATTENDANCE_EDIT))
  assert.ok(codes('奖惩表').has(PERMISSIONS.ADJUSTMENT_CREATE))
  assert.ok(codes('题库表').has(PERMISSIONS.EXAM_MANAGE))
  assert.ok(page('考试记录表').pendingCodes.includes(PERMISSIONS.EXAM_DELETE))
  assert.ok(codes('待发布工资表').has(PERMISSIONS.PAYROLL_PUBLISH))
  assert.ok(page('导入记录').pendingCodes.includes(PERMISSIONS.PAYROLL_EDIT))
  assert.ok(codes('员工前端账号').has(PERMISSIONS.USER_MANAGE))
  assert.ok(codes('后台角色权限').has(PERMISSIONS.SCOPE_MANAGE))
})

test('every database permission is rendered at most once and no checkbox can link child pages', () => {
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

  assert.deepEqual(new Set([...visibleCodes, ...pendingCodes]), new Set([...Object.values(PERMISSIONS), futurePermission.code]))
  assert.equal(visibleIds.length, new Set(visibleIds).size)
  assert.equal([...pendingCodes].some(code => visibleCodes.has(code)), false)
  assert.ok(sections.find(section => section.key === 'system_supplement')?.pages[0].items.some(item => item.code === futurePermission.code))

  const page = label => sections.flatMap(section => section.pages).find(item => item.label === label)
  assert.ok(!page('汇总表').items.some(item => item.code === PERMISSIONS.REPORT_VIEW))
  assert.ok(page('汇总表').pendingCodes.includes(PERMISSIONS.REPORT_VIEW))
  assert.ok(!page('人员分布总表').items.some(item => item.code === PERMISSIONS.REPORT_VIEW))
  assert.ok(page('人员分布总表').pendingCodes.includes(PERMISSIONS.REPORT_VIEW))
  assert.ok(page('日考勤打卡记录表').pendingCodes.includes(PERMISSIONS.ATTENDANCE_VIEW))
  assert.equal(uniquePermissionIds(visibleItems).length, visibleItems.length)
})

test('every latest sidebar child page remains visible even when a legacy shared permission is pending split', () => {
  const sections = buildRolePermissionSections(catalogPermissions)

  for (const navigationSection of adminNavigation) {
    const permissionSection = sections.find(section => section.key === navigationSection.id)
    assert.ok(permissionSection, `missing section ${navigationSection.id}`)
    assert.deepEqual(
      permissionSection.pages.map(page => page.label),
      (navigationSection.children || [navigationSection]).map(page => page.label),
    )
    for (const page of permissionSection.pages) {
      assert.ok(page.items.length > 0 || page.pendingCodes.length > 0, `${page.label} must expose a real permission or an explicit pending legacy dependency`)
    }
  }
})
