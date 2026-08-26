import { PERMISSIONS } from './permissions.js'

const enc = value => encodeURIComponent(value)

// Keep UI labels in Chinese, but never use presentation text as a route key.
// The reverse lookup deliberately accepts the old Chinese values so bookmarks
// created before the slug migration continue to open the same page.
export const ADMIN_TAB_SLUGS = Object.freeze({
  '/admin/employees':Object.freeze({
    '员工档案':'employee-directory',
    '人员分析':'people-analysis',
    '团队管理':'team-management',
    '岗位管理':'position-management',
    '停电 / 断网记录':'connectivity-records',
    '预警记录':'alerts',
    '离职记录':'resignation-records',
    '入离职记录':'employment-history',
    '操作日志':'change-history',
  }),
  '/admin/reports':Object.freeze({
    '总汇':'overview',
    '人员':'people-distribution',
    '排班表':'legacy-schedule',
    '盘口人数':'platform-headcount',
    '统计':'statistics',
    '错误统计':'error-statistics',
  }),
  '/admin/schedule':Object.freeze({
    '排班表':'roster',
    '出勤表':'monthly-attendance',
    '今日考勤':'today-attendance',
    '考勤记录':'attendance-records',
    '请假审批':'leave-approvals',
    '奖金 / 扣款':'adjustments',
  }),
  '/admin/daily':Object.freeze({
    '每日工作报告':'daily-reports',
    '线上培训报告':'training-reports',
  }),
  '/admin/training':Object.freeze({
    '考试概览':'overview',
    '考试记录':'records',
    '题库':'question-bank',
    '人工批改':'manual-grading',
  }),
  '/admin/payroll':Object.freeze({
    '工资导入':'import',
    '待发布':'pending',
    '已发布':'published',
    '导入记录':'import-history',
    '收款资料审核':'payment-change-review',
    '申请记录':'payment-change-history',
  }),
  '/admin/users':Object.freeze({backend:'backend',staff:'staff',roles:'roles'}),
  '/admin/work-execution':Object.freeze({
    'daily-inspection':'daily-inspection',
    'quality-inspection':'quality-inspection',
  }),
})

const ADMIN_TAB_LABELS = Object.freeze(Object.fromEntries(Object.entries(ADMIN_TAB_SLUGS).map(([path, mapping]) => [
  path,
  Object.freeze(Object.fromEntries(Object.entries(mapping).map(([label, slug]) => [slug, label]))),
])))

export function adminTabSlug(pathname, canonicalTab = '') {
  const value = String(canonicalTab || '').trim()
  return ADMIN_TAB_SLUGS[pathname]?.[value] || value
}

export function canonicalAdminTab(pathname, routeValue = '') {
  const value = String(routeValue || '').trim()
  return ADMIN_TAB_LABELS[pathname]?.[value] || value
}

export function adminTabParams(pathname, canonicalTab = '') {
  const value = adminTabSlug(pathname, canonicalTab)
  return value ? { tab:value } : {}
}

const tab = (path, value) => `${path}?tab=${enc(adminTabSlug(path, value))}`
const item = (label, to, access = {}) => ({ label, to, ...access })

const ACCESS = {
  dashboard: { permissions:[PERMISSIONS.DASHBOARD_VIEW] },
  employee: { permissions:[PERMISSIONS.EMPLOYEE_VIEW] },
  employeeAnalytics: { permissions:[PERMISSIONS.EMPLOYEE_ANALYTICS_VIEW] },
  connectivity: { permissions:[PERMISSIONS.CONNECTIVITY_VIEW] },
  alerts: { permissions:[
    PERMISSIONS.PAYROLL_PAYOUT_CHANGE_REVIEW,
    PERMISSIONS.REPORT_VIEW,
    PERMISSIONS.ADJUSTMENT_VIEW,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.DAILY_WORK_MANAGE,
    PERMISSIONS.EXAM_VIEW,
    PERMISSIONS.ACCOUNT_VIEW,
    PERMISSIONS.USER_VIEW,
  ] },
  audit: { permissions:[PERMISSIONS.AUDIT_VIEW] },
  report: { permissions:[PERMISSIONS.REPORT_VIEW] },
  schedule: { permissions:[PERMISSIONS.SCHEDULE_VIEW] },
  attendance: { permissions:[PERMISSIONS.ATTENDANCE_VIEW] },
  leave: { allPermissions:[PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.LEAVE_APPROVE] },
  adjustment: { permissions:[PERMISSIONS.ADJUSTMENT_VIEW] },
  dailyWork: { permissions:[PERMISSIONS.REPORT_VIEW, PERMISSIONS.DAILY_WORK_SUBMIT, PERMISSIONS.DAILY_WORK_MANAGE] },
  onlineTraining: { permissions:[PERMISSIONS.ONLINE_TRAINING_VIEW, PERMISSIONS.ONLINE_TRAINING_SUBMIT, PERMISSIONS.ONLINE_TRAINING_REVIEW, PERMISSIONS.ONLINE_TRAINING_MANAGE] },
  exam: { permissions:[PERMISSIONS.EXAM_VIEW] },
  examManage: { allPermissions:[PERMISSIONS.EXAM_VIEW, PERMISSIONS.EXAM_MANAGE] },
  examGrade: { allPermissions:[PERMISSIONS.EXAM_VIEW, PERMISSIONS.EXAM_GRADE] },
  payrollImport: { allPermissions:[PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.PAYROLL_EDIT] },
  payrollPending: { allPermissions:[PERMISSIONS.PAYROLL_VIEW], permissions:[PERMISSIONS.PAYROLL_APPROVE, PERMISSIONS.PAYROLL_PUBLISH] },
  payroll: { permissions:[PERMISSIONS.PAYROLL_VIEW] },
  payoutReview: { permissions:[PERMISSIONS.PAYROLL_PAYOUT_CHANGE_REVIEW] },
  payoutHistory: { permissions:[PERMISSIONS.PAYROLL_PAYOUT_CHANGE_VIEW, PERMISSIONS.PAYROLL_PAYOUT_CHANGE_REVIEW] },
  backendAccounts: { permissions:[PERMISSIONS.USER_VIEW, PERMISSIONS.ACCOUNT_VIEW, PERMISSIONS.ACCOUNT_CREATE, PERMISSIONS.ACCOUNT_EDIT, PERMISSIONS.ACCOUNT_DISABLE, PERMISSIONS.ACCOUNT_DELETE, PERMISSIONS.ACCOUNT_RESET_PASSWORD, PERMISSIONS.ACCOUNT_OTP_TOGGLE, PERMISSIONS.ACCOUNT_MFA_RESET] },
  staffAccounts: { permissions:[PERMISSIONS.USER_VIEW, PERMISSIONS.USER_ACCOUNT_CREATE, PERMISSIONS.USER_ACCOUNT_DISABLE, PERMISSIONS.USER_ACCOUNT_DELETE, PERMISSIONS.USER_PASSWORD_RESET, PERMISSIONS.ACCOUNT_MFA_RESET] },
  roles: { permissions:[PERMISSIONS.ROLE_MANAGE] },
  accountUsage: { permissions:[PERMISSIONS.USER_VIEW] },
}

// Labels and ordering below are presentation-only. Every item still points to
// the existing page and its canonical tab so moving the menu cannot change the
// page's data, actions, or permission checks.
export const adminNavigation = [
  { id:'home', to:'/admin', label:'首页', icon:'⌂', ...ACCESS.dashboard },
  { id:'alerts', to:tab('/admin/employees', '预警记录'), label:'预警中心', icon:'警', ...ACCESS.alerts },
  {
    id:'workforce', label:'员工排班管理统计', icon:'员', children:[
      item('员工档案查询表', '/admin/employees', ACCESS.employee),
      item('人员分析表', tab('/admin/employees', '人员分析'), ACCESS.employeeAnalytics),
      item('离职记录表', tab('/admin/employees', '离职记录'), ACCESS.employee),
      item('档案变更记录', tab('/admin/employees', '操作日志'), ACCESS.audit),
      item('汇总表', '/admin/reports', ACCESS.report),
      item('人员分布总表', tab('/admin/reports', '人员'), ACCESS.report),
      item('站点人数报表', tab('/admin/reports', '盘口人数'), ACCESS.report),
      item('排班表', '/admin/schedule', ACCESS.schedule),
    ],
  },
  {
    id:'attendance_exams', label:'考勤考试奖惩统计', icon:'考', children:[
      item('月考勤休假记录表', tab('/admin/schedule', '出勤表'), ACCESS.attendance),
      item('停电/断网记录', tab('/admin/employees', '停电 / 断网记录'), ACCESS.connectivity),
      item('日考勤打卡记录表', tab('/admin/schedule', '考勤记录'), ACCESS.attendance),
      item('请假审批记录表', tab('/admin/schedule', '请假审批'), ACCESS.leave),
      item('错误记录统计报表', tab('/admin/reports', '错误统计'), ACCESS.report),
      item('线上培训日报记录表', tab('/admin/daily', '线上培训报告'), ACCESS.onlineTraining),
      item('考试汇总表', '/admin/training', ACCESS.exam),
      item('人工批改', tab('/admin/training', '人工批改'), ACCESS.examGrade),
      item('考试记录表', tab('/admin/training', '考试记录'), ACCESS.exam),
      item('题库表', tab('/admin/training', '题库'), ACCESS.examManage),
      item('奖惩表', tab('/admin/schedule', '奖金 / 扣款'), ACCESS.adjustment),
    ],
  },
  {
    id:'work_execution', label:'工作执行与负责人管理统计', icon:'执', children:[
      item('事件跟踪表', '/admin/work-execution', ACCESS.dailyWork),
      item('每日巡视项目日报记录表', tab('/admin/work-execution', 'daily-inspection'), ACCESS.dailyWork),
      item('质检日报记录表', tab('/admin/work-execution', 'quality-inspection'), ACCESS.dailyWork),
    ],
  },
  {
    id:'payroll', label:'工资统计', icon:'薪', children:[
      item('待发布工资表', tab('/admin/payroll', '待发布'), ACCESS.payrollPending),
      item('已发布工资表', tab('/admin/payroll', '已发布'), ACCESS.payroll),
      item('导入记录', tab('/admin/payroll', '导入记录'), ACCESS.payroll),
      item('修改工资信息记录', tab('/admin/payroll', '申请记录'), ACCESS.payoutHistory),
    ],
  },
  {
    id:'account_usage', label:'后台账号使用情况', icon:'权', children:[
      item('公司提供资产', '/admin/account-usage', ACCESS.accountUsage),
      item('员工前端账号', tab('/admin/users', 'staff'), ACCESS.staffAccounts),
      item('后台账号', '/admin/users', ACCESS.backendAccounts),
      item('后台角色权限', tab('/admin/users', 'roles'), ACCESS.roles),
    ],
  },
]

const route = (to, access, groupId = '') => ({ to, groupId, ...access })

// Route authorization is deliberately independent from the visible sidebar.
// Hidden legacy tabs remain reachable (and keep their original permissions),
// including links/bookmarks created before this menu reorganization.
export const adminRouteAccess = [
  route('/admin', ACCESS.dashboard, 'home'),
  route('/admin/employees', ACCESS.employee, 'workforce'),
  route(tab('/admin/employees', '员工档案'), ACCESS.employee, 'workforce'),
  route(tab('/admin/employees', '人员分析'), ACCESS.employeeAnalytics, 'workforce'),
  route(tab('/admin/employees', '团队管理'), ACCESS.employeeAnalytics, 'workforce'),
  route(tab('/admin/employees', '岗位管理'), ACCESS.employeeAnalytics, 'workforce'),
  route(tab('/admin/employees', '停电 / 断网记录'), ACCESS.connectivity, 'attendance_exams'),
  route(tab('/admin/employees', '预警记录'), ACCESS.alerts, 'alerts'),
  route(tab('/admin/employees', '离职记录'), ACCESS.employee, 'workforce'),
  route(tab('/admin/employees', '入离职记录'), ACCESS.employee, 'workforce'),
  route(tab('/admin/employees', '操作日志'), ACCESS.audit, 'workforce'),

  route('/admin/reports', ACCESS.report, 'workforce'),
  route(tab('/admin/reports', '总汇'), ACCESS.report, 'workforce'),
  route(tab('/admin/reports', '人员'), ACCESS.report, 'workforce'),
  route(tab('/admin/reports', '排班表'), ACCESS.report, 'workforce'),
  route(tab('/admin/reports', '盘口人数'), ACCESS.report, 'workforce'),
  route(tab('/admin/reports', '统计'), ACCESS.report, 'workforce'),
  route(tab('/admin/reports', '错误统计'), ACCESS.report, 'attendance_exams'),

  route('/admin/schedule', ACCESS.schedule, 'workforce'),
  route(tab('/admin/schedule', '排班表'), ACCESS.schedule, 'workforce'),
  route(tab('/admin/schedule', '出勤表'), ACCESS.attendance, 'attendance_exams'),
  route(tab('/admin/schedule', '今日考勤'), ACCESS.attendance, 'attendance_exams'),
  route(tab('/admin/schedule', '考勤记录'), ACCESS.attendance, 'attendance_exams'),
  route(tab('/admin/schedule', '请假审批'), ACCESS.leave, 'attendance_exams'),
  route(tab('/admin/schedule', '奖金 / 扣款'), ACCESS.adjustment, 'attendance_exams'),

  route('/admin/daily', { permissions:[...ACCESS.dailyWork.permissions, ...ACCESS.onlineTraining.permissions] }, 'work_execution'),
  route(tab('/admin/daily', '每日工作报告'), ACCESS.dailyWork, 'work_execution'),
  route(tab('/admin/daily', '线上培训报告'), ACCESS.onlineTraining, 'attendance_exams'),

  route('/admin/training', ACCESS.exam, 'attendance_exams'),
  route(tab('/admin/training', '考试概览'), ACCESS.exam, 'attendance_exams'),
  route(tab('/admin/training', '考试记录'), ACCESS.exam, 'attendance_exams'),
  route(tab('/admin/training', '题库'), ACCESS.examManage, 'attendance_exams'),
  route(tab('/admin/training', '人工批改'), ACCESS.examGrade, 'attendance_exams'),

  route('/admin/payroll', ACCESS.payrollImport, 'payroll'),
  route(tab('/admin/payroll', '工资导入'), ACCESS.payrollImport, 'payroll'),
  route(tab('/admin/payroll', '待发布'), ACCESS.payrollPending, 'payroll'),
  route(tab('/admin/payroll', '已发布'), ACCESS.payroll, 'payroll'),
  route(tab('/admin/payroll', '导入记录'), ACCESS.payroll, 'payroll'),
  route(tab('/admin/payroll', '收款资料审核'), ACCESS.payoutReview, 'payroll'),
  route(tab('/admin/payroll', '申请记录'), ACCESS.payoutHistory, 'payroll'),

  route('/admin/users', ACCESS.backendAccounts, 'account_usage'),
  route(tab('/admin/users', 'backend'), ACCESS.backendAccounts, 'account_usage'),
  route(tab('/admin/users', 'staff'), ACCESS.staffAccounts, 'account_usage'),
  route(tab('/admin/users', 'roles'), ACCESS.roles, 'account_usage'),

  route('/admin/work-execution', ACCESS.dailyWork, 'work_execution'),
  route(tab('/admin/work-execution', 'daily-inspection'), ACCESS.dailyWork, 'work_execution'),
  route(tab('/admin/work-execution', 'quality-inspection'), ACCESS.dailyWork, 'work_execution'),
  route('/admin/account-usage', ACCESS.accountUsage, 'account_usage'),
]

const targetUrl = to => new URL(to, 'https://wfh.local')
const DEFAULT_TABS = {
  '/admin/employees':'员工档案',
  '/admin/reports':'总汇',
  '/admin/schedule':'排班表',
  '/admin/daily':'每日工作报告',
  '/admin/training':'考试概览',
  '/admin/payroll':'工资导入',
  '/admin/users':'backend',
}

export function adminTargetMatches(to, pathname, search = '') {
  const target = targetUrl(to)
  if (target.pathname !== pathname) return false
  const requestedValue = new URLSearchParams(search).get('tab')
  const targetValue = target.searchParams.get('tab')
  const requestedTab = requestedValue === null
    ? DEFAULT_TABS[pathname] ?? null
    : canonicalAdminTab(pathname, requestedValue)
  const targetTab = targetValue === null
    ? DEFAULT_TABS[target.pathname] ?? null
    : canonicalAdminTab(target.pathname, targetValue)
  return targetTab === requestedTab
}

export function requestedAdminRoute(pathname, search = '') {
  const rawRequestedTab = new URLSearchParams(search).get('tab')
  const requestedTab = rawRequestedTab === null ? null : canonicalAdminTab(pathname, rawRequestedTab)
  return adminRouteAccess.find(entry => {
    const target = targetUrl(entry.to)
    const rawTargetTab = target.searchParams.get('tab')
    const targetTab = rawTargetTab === null ? null : canonicalAdminTab(target.pathname, rawTargetTab)
    return target.pathname === pathname && targetTab === requestedTab
  }) || null
}

export function adminSectionItems(pathname, search = '') {
  const routeEntry = requestedAdminRoute(pathname, search)
  const section = adminNavigation.find(entry => entry.id === routeEntry?.groupId)
  return {
    section: section || null,
    items: section?.children || [],
  }
}

// Page components keep using their original tab values because those values are
// also used by data branches, permissions and old bookmarks.  This helper is the
// presentation bridge: it resolves a canonical page/tab to the new sidebar name
// without changing the underlying URL or feature key.
export function adminPagePresentation(pathname, canonicalTab = '') {
  const search = canonicalTab ? `?tab=${enc(adminTabSlug(pathname, canonicalTab))}` : ''
  const routeEntry = requestedAdminRoute(pathname, search)
  const section = adminNavigation.find(entry => entry.id === routeEntry?.groupId)
  const candidates = section?.children || (section ? [section] : [])
  const item = candidates.find(entry => adminTargetMatches(entry.to, pathname, search))
  return {
    groupId: routeEntry?.groupId || '',
    sectionLabel: section?.label || '',
    itemLabel: item?.label || canonicalTab || section?.label || '',
    listed: Boolean(item),
  }
}

export function adminLocalPageTabs(pathname, canonicalTabs = [], activeTab = '') {
  const active = adminPagePresentation(pathname, activeTab)
  const section = adminNavigation.find(entry => entry.id === active.groupId)
  const menuOrder = new Map((section?.children || (section ? [section] : [])).map((entry, index) => [entry.label, index]))
  const tabs = canonicalTabs
    .map(tabValue => ({ tabValue, ...adminPagePresentation(pathname, tabValue) }))
    .filter(entry => entry.listed && entry.groupId === active.groupId)
    .sort((left, right) => (menuOrder.get(left.itemLabel) ?? Number.MAX_SAFE_INTEGER) - (menuOrder.get(right.itemLabel) ?? Number.MAX_SAFE_INTEGER))
  return { active, tabs }
}

export const staffNavigation = [
  { id:'profile', to:'/staff', key:'nav.profilePanel', label:'个人档案面板' },
  { id:'exams', to:'/staff/exams', key:'nav.exams', label:'我的考试' },
  {
    id:'rewards', key:'nav.rewards', label:'奖惩', children:[
      { to:'/staff/rewards', key:'nav.errorRecords', label:'出错记录' },
      { to:'/staff/rewards?tab=adjustments', key:'nav.adjustmentRecords', label:'奖惩记录' },
      { to:'/staff/rewards?tab=exams', key:'nav.examRecords', label:'考试记录' },
      { to:'/staff/rewards?tab=attendance', key:'nav.attendanceLeave', label:'考勤请假记录' },
      { to:'/staff/rewards?tab=connectivity', key:'nav.connectivityRecords', label:'停电 / 断网记录' },
    ],
  },
  {
    id:'payroll', key:'nav.payroll', label:'工资', children:[
      { to:'/staff/payroll', key:'nav.payrollRecords', label:'工资记录' },
      { to:'/staff/payroll?tab=payment-change', key:'nav.paymentChange', label:'工资卡修改申请' },
    ],
  },
]

const STAFF_DEFAULT_TABS = {
  '/staff/rewards':'errors',
  '/staff/payroll':'records',
}

export function staffTargetMatches(to, pathname, search = '') {
  const target = targetUrl(to)
  if (target.pathname !== pathname) return false
  const requestedTab = new URLSearchParams(search).get('tab') ?? STAFF_DEFAULT_TABS[pathname] ?? null
  const targetTab = target.searchParams.get('tab') ?? STAFF_DEFAULT_TABS[target.pathname] ?? null
  return targetTab === requestedTab
}

export function requestedStaffGroup(pathname, search = '') {
  return staffNavigation.find(entry => {
    const candidates = entry.children || [entry]
    return candidates.some(candidate => staffTargetMatches(candidate.to, pathname, search))
  }) || null
}
