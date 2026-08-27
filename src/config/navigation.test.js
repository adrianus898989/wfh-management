import test from 'node:test'
import assert from 'node:assert/strict'
import { ADMIN_TAB_SLUGS, adminLocalPageTabs, adminNavigation, adminPagePresentation, adminRouteAccess, adminSectionItems, adminTabSlug, canonicalAdminTab, adminTargetMatches, requestedAdminRoute, requestedStaffGroup, staffNavigation, staffTargetMatches } from './navigation.js'

const visibleItems = adminNavigation.flatMap(entry => entry.children || [entry])
const group = id => adminNavigation.find(entry => entry.id === id)

test('admin sidebar uses the requested top-level order and names', () => {
  assert.deepEqual(adminNavigation.map(entry => entry.label), [
    '首页',
    '预警中心',
    '员工排班管理统计',
    '考勤考试奖惩统计',
    '工作执行与负责人管理统计',
    '工资统计',
    '后台账号使用情况',
  ])
  assert.deepEqual(group('workforce').children.map(entry => entry.label), [
    '员工档案查询表', '人员分析表', '离职记录表', '档案变更记录',
    '汇总表', '人员分布总表', '站点人数报表', '排班表',
  ])
  assert.deepEqual(group('account_usage').children[0], {
    label:'公司提供资产', to:'/admin/account-usage', pagePermission:'assets', permissions:['asset.view'],
  })
  assert.deepEqual(group('payroll').children.map(entry => entry.label), [
    '待发布工资表', '已发布工资表', '导入记录', '修改工资信息记录',
  ])
  assert.equal(visibleItems.filter(entry => entry.label === '排班表').length, 1)
})

test('new menu names keep pointing at canonical existing tabs', () => {
  assert.equal(group('attendance_exams').children.find(entry => entry.label === '线上培训日报记录表').to, '/admin/daily?tab=training-reports')
  assert.equal(group('attendance_exams').children.find(entry => entry.label === '奖惩表').to, '/admin/schedule?tab=adjustments')
  assert.equal(group('account_usage').children.find(entry => entry.label === '员工前端账号').to, '/admin/users?tab=staff')
  assert.equal(group('payroll').children.find(entry => entry.label === '修改工资信息记录').to, '/admin/payroll?tab=payment-change-history')
  const accountItems = group('account_usage').children
  const accountIndex = accountItems.findIndex(entry => entry.label === '后台账号')
  assert.deepEqual(accountItems[accountIndex + 1], {
    label:'后台登入IP白名单',
    to:'/admin/ip-allowlist',
    pagePermission:'ip_allowlist',
    permissions:['account.ip_allowlist.view'],
  })
})

test('English slugs are stable while old Chinese bookmarks remain compatible', () => {
  assert.equal(adminTabSlug('/admin/schedule', '出勤表'), 'monthly-attendance')
  assert.equal(canonicalAdminTab('/admin/schedule', 'monthly-attendance'), '出勤表')
  assert.equal(canonicalAdminTab('/admin/schedule', '出勤表'), '出勤表')
  assert.ok(requestedAdminRoute('/admin/schedule', '?tab=monthly-attendance'))
  assert.ok(requestedAdminRoute('/admin/schedule', '?tab=%E5%87%BA%E5%8B%A4%E8%A1%A8'))
  assert.ok(requestedAdminRoute('/admin/daily', '?tab=training-reports'))
  assert.ok(requestedAdminRoute('/admin/daily', '?tab=%E7%BA%BF%E4%B8%8A%E5%9F%B9%E8%AE%AD%E6%8A%A5%E5%91%8A'))
  assert.equal(
    adminTargetMatches('/admin/schedule?tab=monthly-attendance', '/admin/schedule', '?tab=%E5%87%BA%E5%8B%A4%E8%A1%A8'),
    true,
  )
})

test('every generated admin tab is English while every legacy tab value remains canonical', () => {
  const generatedTargets = [
    ...adminNavigation.flatMap(entry => entry.children || [entry]),
    ...adminRouteAccess,
  ]
  for (const entry of generatedTargets) {
    const target = new URL(entry.to, 'https://wfh.local')
    const routeTab = target.searchParams.get('tab')
    if (routeTab) assert.match(routeTab, /^[a-z0-9-]+$/, entry.to)
  }

  for (const [pathname, tabs] of Object.entries(ADMIN_TAB_SLUGS)) {
    for (const [legacyTab, slug] of Object.entries(tabs)) {
      assert.equal(canonicalAdminTab(pathname, legacyTab), legacyTab)
      assert.equal(canonicalAdminTab(pathname, slug), legacyTab)
    }
  }
})

test('hidden legacy tabs remain authorized by their original route permissions', () => {
  const legacy = [
    ['/admin/reports', '?tab=%E6%8E%92%E7%8F%AD%E8%A1%A8'],
    ['/admin/schedule', '?tab=%E4%BB%8A%E6%97%A5%E8%80%83%E5%8B%A4'],
    ['/admin/payroll', '?tab=%E5%B7%A5%E8%B5%84%E5%AF%BC%E5%85%A5'],
    ['/admin/payroll', '?tab=%E6%94%B6%E6%AC%BE%E8%B5%84%E6%96%99%E5%AE%A1%E6%A0%B8'],
    ['/admin/daily', '?tab=%E6%AF%8F%E6%97%A5%E5%B7%A5%E4%BD%9C%E6%8A%A5%E5%91%8A'],
  ]
  legacy.forEach(([pathname, search]) => assert.ok(requestedAdminRoute(pathname, search), `${pathname}${search}`))
})

test('same-path items activate only their own tab while default-tab aliases remain compatible', () => {
  const alertTarget = '/admin/employees?tab=%E9%A2%84%E8%AD%A6%E8%AE%B0%E5%BD%95'
  assert.equal(adminTargetMatches(alertTarget, '/admin/employees', '?tab=%E9%A2%84%E8%AD%A6%E8%AE%B0%E5%BD%95'), true)
  assert.equal(adminTargetMatches(alertTarget, '/admin/employees', '?tab=%E4%BA%BA%E5%91%98%E5%88%86%E6%9E%90'), false)
  assert.equal(adminTargetMatches('/admin/employees', '/admin/employees', '?tab=%E5%91%98%E5%B7%A5%E6%A1%A3%E6%A1%88'), true)
  assert.equal(adminTargetMatches('/admin/users', '/admin/users', '?tab=backend'), true)
  assert.equal(adminTargetMatches(alertTarget, '/admin/employees', ''), false)
  assert.equal(adminTargetMatches('/admin/employees', '/admin/employees', ''), true)
})

test('page-level module navigation includes every authorized child across page routes', () => {
  const workforce = adminSectionItems('/admin/reports', '?tab=%E4%BA%BA%E5%91%98')
  assert.equal(workforce.section?.id, 'workforce')
  assert.deepEqual(workforce.items.map(item => item.label), group('workforce').children.map(item => item.label))

  const attendance = adminSectionItems('/admin/training', '?tab=%E9%A2%98%E5%BA%93')
  assert.equal(attendance.section?.id, 'attendance_exams')
  assert.equal(attendance.items.length, 11)
})

test('staff navigation is organized into four modules with stable query-tab matching', () => {
  assert.deepEqual(staffNavigation.map(item => item.label), ['个人档案面板', '我的考试', '奖惩', '工资'])
  assert.deepEqual(staffNavigation.find(item => item.id === 'rewards').children.map(item => item.label), [
    '出错记录', '奖惩记录', '考试记录', '考勤请假记录', '停电 / 断网记录',
  ])
  assert.equal(staffTargetMatches('/staff/rewards', '/staff/rewards', ''), true)
  assert.equal(staffTargetMatches('/staff/rewards?tab=exams', '/staff/rewards', '?tab=attendance'), false)
  assert.equal(requestedStaffGroup('/staff/payroll', '?tab=payment-change')?.id, 'payroll')
})

test('planning routes use independent page permissions and are part of the guarded route registry', () => {
  const eventRoute = requestedAdminRoute('/admin/work-execution', '')
  const assetRoute = requestedAdminRoute('/admin/account-usage', '')
  assert.deepEqual(eventRoute?.permissions, ['work.event.view'])
  assert.equal(assetRoute?.groupId, 'account_usage')
  assert.deepEqual(assetRoute?.permissions, ['asset.view'])
})

test('backend IP allowlist has a dedicated guarded route and permission', () => {
  const route = requestedAdminRoute('/admin/ip-allowlist', '')
  assert.equal(route?.groupId, 'account_usage')
  assert.deepEqual(route?.permissions, ['account.ip_allowlist.view'])
  assert.equal(requestedAdminRoute('/admin/ip-allowlist', '?tab=anything'), null)
})

test('page chrome uses the new menu labels without changing canonical route tabs', () => {
  assert.deepEqual(
    adminPagePresentation('/admin/schedule', '出勤表'),
    { groupId:'attendance_exams', sectionLabel:'考勤考试奖惩统计', itemLabel:'月考勤休假记录表', listed:true },
  )
  assert.equal(adminPagePresentation('/admin/training', '题库').itemLabel, '题库表')
  assert.equal(adminPagePresentation('/admin/employees', '预警记录').sectionLabel, '预警中心')

  const attendance = adminLocalPageTabs(
    '/admin/schedule',
    ['排班表','出勤表','今日考勤','考勤记录','请假审批','奖金 / 扣款'],
    '出勤表',
  )
  assert.deepEqual(attendance.tabs.map(entry => entry.tabValue), ['出勤表','考勤记录','请假审批','奖金 / 扣款'])
  assert.deepEqual(attendance.tabs.map(entry => entry.itemLabel), ['月考勤休假记录表','日考勤打卡记录表','请假审批记录表','奖惩表'])

  const exams = adminLocalPageTabs('/admin/training', ['考试概览','考试记录','题库','人工批改'], '考试概览')
  assert.deepEqual(exams.tabs.map(entry => entry.itemLabel), ['考试汇总表','人工批改','考试记录表','题库表'])

  const accounts = adminLocalPageTabs('/admin/users', ['backend','staff','roles'], 'backend')
  assert.deepEqual(accounts.tabs.map(entry => entry.itemLabel), ['员工前端账号','后台账号','后台角色权限'])
})
