import { adminNavigation, adminTabSlug, canonicalAdminTab } from './navigation.js'
import { adminPagePermissionCodes } from './adminPagePermissions.js'

const unique = values => [...new Set(values.filter(Boolean))]

// These codes remain stored as private implementation dependencies while the
// corresponding RPCs are migrated. They are synchronized by admin-accounts
// and must not reappear as confusing global checkboxes in the page editor.
const LEGACY_IMPLEMENTATION_CODES = new Set([
  'employee.view','employee.resign','employee.reactivate','audit.view',
  'schedule.view','attendance.view','attendance.edit','leave.approve',
  'report.view','report.edit','export.general',
  'online_training.view','online_training.submit','online_training.review','online_training.manage',
  'exam.view','exam.manage','exam.grade','exam.delete',
  'adjustment.view','adjustment.create','adjustment.approve','adjustment.page.approve',
  'daily_work.submit','daily_work.manage',
  'payroll.view','payroll.edit','payroll.approve','payroll.publish','payroll.export','payroll.rule.edit','payroll.payout_change.view','payroll.payout_change.review',
  'employee.directory.payroll_history.view',
  'user.view','account.view','account.mfa_reset',
  // Global role mutation is Founder-only and must never appear as a
  // delegable checkbox in the supplemental bucket.
  'role.manage',
])

const targetKey = to => {
  const url = new URL(to, 'https://wfh.local')
  const routeTab = url.searchParams.get('tab')
  if (!routeTab) return url.pathname
  const canonicalTab = canonicalAdminTab(url.pathname, routeTab)
  return `${url.pathname}?tab=${adminTabSlug(url.pathname, canonicalTab)}`
}

const permissionCodesFromAccess = item => unique([
  ...(item.allPermissions || []),
  ...(item.permissions || []),
])

// Permission ids created before the current menu were commonly reused by
// several child pages.  Those ids are not independently enforceable: changing
// one would silently change every route that still checks the same id.  The
// catalog detects those shared ids from the current navigation and exposes
// them as disabled `pendingItems` on every affected page.  A real selectable
// checkbox is rendered only when its database id belongs to one current page.

const SECTION_DESCRIPTIONS = {
  home: '首页数据与概览入口',
  alerts: '预警消息、异常记录与对应业务资料',
  workforce: '员工档案、组织分析、排班与变更记录',
  attendance_exams: '考勤、请假、培训、考试及奖惩记录',
  work_execution: '事件跟踪、巡视日报与质检日报',
  payroll: '工资导入、审核、发布及收款资料修改记录',
  account_usage: '公司资产、员工账号、后台账号、登录IP白名单、角色权限、操作日志与功能手册',
}

const PAGE_DESCRIPTIONS = {
  '首页': '查看首页数据、人数与业务概览',
  '预警中心': '查看可授权业务范围内的异常预警与处理入口',
  '员工档案查询表': '员工资料的查看、新增、编辑、离职及删除操作',
  '人员分析表': '人员、团队、组织结构及管理风险分析',
  '离职记录表': '离职记录查看、办理离职与恢复在职',
  '档案变更记录': '查看在职、离职及资料变更操作日志',
  '人员对账表': '核对员工主档、当前排班、有效在职及现场人员差异',
  '汇总表': '查看汇总统计及导出数据',
  '人员分布总表': '查看人员分布及导出数据',
  '站点人数报表': '查看站点人数及导出数据',
  '排班表': '查看与编辑员工排班',
  '月考勤休假记录表': '查看、编辑及导出月度考勤休假记录',
  '停电/断网记录': '查看、新增、编辑及删除停电断网记录',
  '日考勤打卡记录表': '查看、编辑及导出每日打卡记录',
  '请假审批记录表': '查看考勤并审批、维护请假记录',
  '员工订单处理统计': '查看员工每日订单量、日均处理量与错误次数',
  '错误记录统计报表': '查看、维护及导出错误统计',
  '线上培训日报记录表': '查看、提交、复核及管理培训日报',
  '考试汇总表': '查看考试概览及汇总数据',
  '人工批改': '查看考试并进行人工批改',
  '考试记录表': '查看、删除及导出考试记录',
  '题库表': '查看、管理及删除题库内容',
  '奖惩表': '查看、新增、编辑及导出奖金扣款记录',
  '事件跟踪表': '查看、提交及管理事件跟踪记录',
  '每日巡视项目日报记录表': '查看、提交及管理巡视日报',
  '质检日报记录表': '查看、提交及管理质检日报',
  '待发布工资表': '查看、编辑、审批及发布工资批次',
  '已发布工资表': '查看与导出已发布工资记录',
  '导入记录': '查看工资导入批次并执行导入维护',
  '修改工资信息记录': '查看、审批及维护工资收款资料修改申请',
  '公司提供资产': '查看公司提供的硬件、软件与账号资产',
  '员工前端账号': '查看、创建、停用及维护员工前端账号',
  '后台账号': '查看、新增、编辑、停用、删除及设置数据范围',
  '后台登入IP白名单': '管理后台登录允许的 IPv4 / IPv6 网络及强制开关',
  '后台角色权限': '查看角色权限及权限变更日志；角色修改固定由 Founder 执行',
  '后台操作日志': '集中查看已记录的后台新增、编辑、删除及其他操作',
  '后台功能用途手册': '查看平台各模块、页面、操作与安全注意事项',
}

const PERMISSION_ACTION_ORDER = [
  'view', 'create', 'generate', 'submit', 'edit', 'change', 'review',
  'manage', 'approve', 'grade', 'publish', 'export', 'delete', 'disable',
  'disable_employee', 'reactivate', 'resign', 'reset_password',
  'otp_toggle', 'mfa_reset', 'general',
]

const actionKey = code => String(code || '').split('.').at(-1) || 'other'

const sortPermissionItems = items => [...items].sort((left, right) => {
  const leftIndex = PERMISSION_ACTION_ORDER.indexOf(left.actionKey)
  const rightIndex = PERMISSION_ACTION_ORDER.indexOf(right.actionKey)
  const actionDifference = (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex)
  return actionDifference || String(left.code || '').localeCompare(String(right.code || ''))
})

export const uniquePermissionIds = permissions => unique(permissions.map(permission => permission.id))

const navigationPermissionPages = () => adminNavigation.flatMap(section => {
  const pageEntries = section.children || [section]
  return pageEntries.map(page => {
    const key = targetKey(page.to)
    return {
      section,
      page,
      key,
      codes: unique(adminPagePermissionCodes(page.pagePermission).length
        ? adminPagePermissionCodes(page.pagePermission)
        : permissionCodesFromAccess(page)),
    }
  })
})

/** Build the editor without presenting a shared legacy id as page-specific. */
export function buildRolePermissionSections(permissions = []) {
  const byCode = new Map(permissions.map(permission => [permission.code, permission]))
  const navigationPages = navigationPermissionPages()
  const pageKeysByCode = new Map()
  for (const entry of navigationPages) {
    for (const code of entry.codes) {
      if (!pageKeysByCode.has(code)) pageKeysByCode.set(code, new Set())
      pageKeysByCode.get(code).add(entry.key)
    }
  }
  const sharedCodes = new Set(
    [...pageKeysByCode.entries()]
      .filter(([, pageKeys]) => pageKeys.size > 1)
      .map(([code]) => code),
  )
  const assignedCodes = new Set()

  const sections = adminNavigation.map(section => {
    const sectionPages = navigationPages.filter(entry => entry.section.id === section.id)
    const pages = sectionPages.map(({ page, key, codes }) => {
      const pendingItems = sortPermissionItems(codes
        .filter(code => sharedCodes.has(code))
        .map(code => byCode.get(code))
        .filter(Boolean)
        .map(permission => ({ ...permission, actionKey: actionKey(permission.code) })))
      const items = sortPermissionItems(codes
        .filter(code => !sharedCodes.has(code) && !assignedCodes.has(code))
        .map(code => byCode.get(code))
        .filter(Boolean)
        .map(permission => {
          assignedCodes.add(permission.code)
          return { ...permission, actionKey: actionKey(permission.code) }
        }))

      return {
        key: `${section.id}:${key}`,
        label: page.label,
        description: PAGE_DESCRIPTIONS[page.label] || '按页面实际功能授权',
        items,
        pendingItems,
        pendingCodes: pendingItems.map(permission => permission.code),
      }
    })

    return {
      key: section.id,
      label: section.label,
      description: SECTION_DESCRIPTIONS[section.id] || '按最新菜单页面配置权限',
      pages,
    }
  })

  const unassigned = sortPermissionItems(permissions
    .filter(permission => !assignedCodes.has(permission.code) && !sharedCodes.has(permission.code) && !LEGACY_IMPLEMENTATION_CODES.has(permission.code))
    .map(permission => ({ ...permission, actionKey: actionKey(permission.code) })))

  if (unassigned.length) {
    sections.push({
      key: 'system_supplement',
      label: '系统补充权限',
      description: '尚未归属到可见菜单页面的底层或扩展权限',
      pages: [{
        key: 'system_supplement:unassigned',
        label: '其他系统功能',
        description: '保留新旧功能权限，避免权限项目遗漏',
        items: unassigned,
        pendingItems: [],
        pendingCodes: [],
      }],
    })
  }

  return sections
}
