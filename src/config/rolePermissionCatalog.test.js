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
  assert.ok(codes('修改工资信息记录').has(PERMISSIONS.PAYROLL_PAYOUT_CHANGE_REVIEW))
})

test('every database permission remains visible and shared permissions deduplicate for counts', () => {
  const futurePermission = {
    id: 'future-permission',
    code: 'future_feature.archive',
    name: '归档未来功能',
    category: 'future',
    sensitive: false,
  }
  const sections = buildRolePermissionSections([...catalogPermissions, futurePermission])
  const visibleCodes = new Set(sections.flatMap(section => section.pages).flatMap(page => page.items).map(item => item.code))

  assert.deepEqual(visibleCodes, new Set([...Object.values(PERMISSIONS), futurePermission.code]))
  assert.ok(sections.find(section => section.key === 'system_supplement')?.pages[0].items.some(item => item.code === futurePermission.code))

  const alertSection = sections.find(section => section.key === 'alerts')
  const idsWithDuplicate = [...alertSection.pages[0].items, ...alertSection.pages[0].items]
  assert.equal(uniquePermissionIds(idsWithDuplicate).length, alertSection.pages[0].items.length)
})
