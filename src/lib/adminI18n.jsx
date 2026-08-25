import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'wfh_admin_locale'

const english = {
  '首页': 'Dashboard',
  '员工管理': 'Employees',
  '员工档案': 'Employee records',
  '人员分析': 'People analytics',
  '停电 / 断网记录': 'Power / internet',
  '离职记录': 'Resignations',
  '操作日志': 'Audit log',
  '统计报表': 'Reports',
  '总汇': 'Overview',
  '人员': 'People',
  '排班表': 'Schedule',
  '盘口人数': 'Platform headcount',
  '统计': 'Statistics',
  '错误统计': 'Error statistics',
  '排班与考勤': 'Schedule & attendance',
  '出勤表': 'Attendance calendar',
  '今日考勤': 'Today',
  '考勤记录': 'Attendance records',
  '请假审批': 'Leave review',
  '奖金 / 扣款': 'Bonus / deduction',
  '每日工作': 'Daily work',
  '线上培训报告': 'Online training reports',
  '考试管理': 'Exams',
  '考试概览': 'Exam overview',
  '考试记录': 'Exam records',
  '题库': 'Question bank',
  '人工批改': 'Manual grading',
  '工资中心': 'Payroll',
  '工资导入': 'Payroll import',
  '待发布': 'Pending publication',
  '已发布': 'Published',
  '导入记录': 'Import history',
  '收款信息审核': 'Payment change review',
  '收款资料审核': 'Payment details review',
  '申请记录': 'Request history',
  '刷新资料': 'Refresh data',
  '正在读取页面权限…': 'Loading page access…',
  '当前账号没有工资中心页面权限。': 'This account does not have access to Payroll.',
  '收款资料申请记录': 'Payment details request history',
  '证明文件保存在私有空间；只有具备权限且在管理范围内的账号可以查看。': 'Proof files are private and visible only to authorized accounts within their management scope.',
  '员工 / 原因': 'Employee / reason',
  '员工ID、姓名或修改原因': 'Employee ID, name or reason',
  '全部状态': 'All statuses',
  '已通过': 'Approved',
  '已驳回': 'Rejected',
  '待审核': 'Pending',
  '已取消': 'Cancelled',
  '提交时间': 'Submitted',
  '员工': 'Employee',
  '员工类型 / 国家': 'Employee type / country',
  '团队 / 岗位': 'Team / position',
  '修改项目': 'Change item',
  '原因': 'Reason',
  '正在读取申请…': 'Loading requests…',
  '银行卡 / 钱包': 'Bank / wallet',
  'USDT 地址': 'USDT address',
  '详情': 'Details',
  '审核': 'Review',
  '暂无符合条件的申请。': 'No matching requests.',
  '每页': 'Per page',
  '上一页': 'Previous',
  '下一页': 'Next',
  '审核备注': 'Review note',
  '批准可选填；驳回时必须填写明确原因，员工会看到此内容。': 'Optional when approving. A clear reason is required when rejecting and will be shown to the employee.',
  '驳回': 'Reject',
  '处理中…': 'Processing…',
  '批准修改': 'Approve change',
  '申请已批准，员工收款资料已安全更新。': 'Approved. The employee payment details were updated securely.',
  '申请已驳回，员工可在前端查看原因。': 'Rejected. The employee can view the reason in the staff portal.',
  '该历史申请没有保存此证明文件。': 'No proof file was saved for this historical request.',
  '组织': 'Organization',
  '员工本人': 'Employee',
  '旧资料': 'Previous details',
  '新资料': 'New details',
  '修改原因': 'Reason for change',
  '身份证明': 'Identity proof',
  '新收款资料截图': 'New payment details screenshot',
  '查看身份证明': 'View identity proof',
  '查看收款截图': 'View payment screenshot',
  '正在安全读取文件…': 'Securely loading file…',
  '开始审核': 'Review request',
  '登录会话已失效，请重新登录。': 'Your session has expired. Sign in again.',
  '未找到关联的在职员工档案。': 'No linked active employee record was found.',
  '申请编号无效。': 'The request ID is invalid.',
  '修改原因需填写 5–1000 个字符。': 'The reason must contain 5–1000 characters.',
  '已有一笔申请等待审核，不能重复提交。': 'A request is already pending review.',
  '当前收款资料不完整，请联系管理员。': 'Current payment details are incomplete. Contact an administrator.',
  '旧收款资料与系统记录不一致。': 'The previous details do not match the system record.',
  '新收款资料不完整或格式无效。': 'The new payment details are incomplete or invalid.',
  '新旧收款资料相同，无需提交。': 'The new details are unchanged.',
  '身份证明和新收款资料截图均为必填。': 'Identity proof and a screenshot of the new payment details are required.',
  '证明文件未成功上传，请重新选择。': 'The proof file was not uploaded. Select it again.',
  '当前账号没有此操作权限。': 'This account is not authorized for this action.',
  '当前登录会话已失效。': 'The current session has expired.',
  '申请状态筛选无效。': 'The request status filter is invalid.',
  '审核操作无效。': 'The review action is invalid.',
  '驳回时必须填写原因。': 'A rejection reason is required.',
  '申请不存在或已删除。': 'The request does not exist or has been deleted.',
  '该员工不在当前账号的管理范围内。': 'This employee is outside the current account scope.',
  '该申请已经处理，不能重复审核。': 'This request has already been reviewed.',
  '员工已不在职，不能批准修改。': 'The employee is no longer active, so this change cannot be approved.',
  '员工类型或国籍已变化，请驳回后由员工重新提交。': 'The employee type or country has changed. Reject this request and ask the employee to submit again.',
  '当前收款资料已被其他操作修改，请重新核对。': 'The current payment details changed after submission. Review them again.',
  '操作失败，请稍后重试。': 'The operation failed. Try again later.',
  '用户与权限': 'Users & access',
  '后台账号': 'Admin accounts',
  '员工账号': 'Staff accounts',
  '角色与权限': 'Roles & permissions',
  '权限读取中…': 'Loading access…',
  '权限读取失败': 'Unable to load access',
  '重试': 'Retry',
  '正在打开可访问页面…': 'Opening an available page…',
  '当前账号尚未配置可访问页面': 'No page access has been assigned to this account.',
  '权限目录读取失败': 'Access directory unavailable',
  '退出登录': 'Sign out',
  '综合 Dashboard': 'Management dashboard',
  '全部员工': 'All employees',
  '在职员工': 'Active employees',
  '团队总数': 'Teams',
  '近 30 天入职': 'Hired in 30 days',
  '近 30 天离职': 'Resigned in 30 days',
  '资料完整率': 'Profile completeness',
  '员工账号覆盖': 'Staff account coverage',
  '岗位种类': 'Positions',
  '近 6 个月人员变化': 'Workforce change · 6 months',
  '员工类型构成': 'Employee types',
  '团队人数排名': 'Team headcount',
  '岗位分布': 'Position distribution',
  '最近入职': 'Recent hires',
  '账号开通情况': 'Account coverage',
  '国家 / 国籍分布': 'Country / nationality',
  '当前员工主档': 'Current employee records',
  '按当前管理范围统计': 'Within your assigned scope',
  '取员工主档入职日期': 'Based on employee hire dates',
  '取员工主档离职日期': 'Based on employee resignation dates',
  '日期、国家、类型、团队、岗位': 'Date, country, type, team and position',
  '当前员工主档岗位': 'Positions in employee records',
  '员工主档日期': 'Employee record dates',
  '最新 6 人': 'Latest 6',
  '权限范围内': 'Within access scope',
  '登录邮箱': 'Login email',
  '员工ID': 'Employee ID',
  '姓名': 'Name',
  '团队': 'Team',
  '岗位': 'Position',
  '角色': 'Role',
  '范围': 'Scope',
  '状态': 'Status',
  '操作': 'Actions',
  '用户名': 'Username',
  '关联员工ID': 'Linked employee ID',
  '查询': 'Search',
  '重置': 'Reset',
  '搜索用户名、员工ID、姓名、角色或管理范围': 'Search username, employee ID, name, role or scope',
  '搜索用户名、员工ID、姓名、团队或岗位': 'Search username, employee ID, name, team or position',
  '＋ 新增后台账号': '+ Add admin account',
  '＋ 新增员工账号': '+ Add staff account',
  '读取中...': 'Loading…',
  '正常': 'Active',
  '停用': 'Disabled',
  '开启': 'On',
  '关闭': 'Off',
  '未关联': 'Not linked',
  '暂无员工账号': 'No staff accounts',
  '编辑': 'Edit',
  '重置密码': 'Reset password',
  '重置OTP': 'Reset OTP',
  '启用': 'Enable',
  '删除账号': 'Delete account',
  '删除登录账号': 'Delete login account',
  '按模块、页面和具体操作配置权限': 'Configure access by module, page and action',
  '当前角色': 'Roles',
  '权限项目': 'Permissions',
  '敏感权限': 'Sensitive permissions',
  '搜索角色名称或角色代码': 'Search role name or code',
  '清除': 'Clear',
  '输入新角色名称': 'New role name',
  '＋ 新增角色': '+ Add role',
  '系统角色': 'System role',
  '自定义角色': 'Custom role',
  '锁定': 'Locked',
  '已授权项目': 'Granted permissions',
  '尚未配置任何页面权限': 'No page access configured',
  '查看固定权限': 'View fixed access',
  '配置权限': 'Configure access',
  '查看权限': 'View access',
  '删除角色': 'Delete role',
  '没有匹配的角色': 'No matching roles',
  '请调整搜索内容后再试。': 'Adjust your search and try again.',
  '员工登录账号': 'Staff login accounts',
  '员工激活码': 'Staff activation codes',
  '员工登录邮箱': 'Staff login email',
  '员工登录密码': 'Staff login password',
  '角色管理': 'Role management',
  '员工薪资资料': 'Employee compensation',
  '团队管理': 'Team management',
  '排班管理': 'Schedule management',
  '考勤管理': 'Attendance management',
  '请假与离岗': 'Leave & absence',
  '每日工作报告': 'Daily work reports',
  '出错 / 扣款 / 奖金': 'Errors / deductions / bonuses',
  '工资管理': 'Payroll management',
  '工资规则': 'Payroll rules',
  '敏感收款资料': 'Sensitive payment data',
  '数据导出': 'Data export',
  '员工敏感资料': 'Sensitive employee data',
  '敏感资料': 'Sensitive data',
  '系统与审计': 'System & audit',
  '其他功能': 'Other functions',
  '全部': 'All data',
  '指定范围': 'Assigned scope',
  '仅本人': 'Self only',
  '自己团队': 'Own team',
  '查看': 'View',
  '配置': 'Configure',
  '的权限': ' permissions',
  '当前账号仅可查看角色权限，修改操作仅限 Founder。': 'This account can view role access only. Only Founder can make changes.',
  '按业务模块与对应页面逐项授权；带“敏感”标记的权限请谨慎开放。': 'Grant access by module and page. Review sensitive permissions carefully.',
  '角色名称': 'Role name',
  '已选权限': 'Selected',
  '已开模块': 'Enabled modules',
  '搜索模块、页面、功能或权限代码': 'Search module, page, action or permission code',
  '清除搜索': 'Clear search',
  '全部勾选': 'Select all',
  '全部取消': 'Clear all',
  '全部展开': 'Expand all',
  'Founder 固定权限': 'Founder fixed access',
  '创办人角色始终拥有全部页面及操作权限，系统已锁定，不能取消勾选。': 'Founder always has every page and action. This access is locked.',
  '敏感': 'Sensitive',
  '没有匹配的权限': 'No matching permissions',
  '请更换关键词，或清除搜索查看全部模块。': 'Try another keyword or clear the search.',
  '只读查看，不会修改角色或权限。': 'Read only. No role or permission will be changed.',
  '权限保存后立即应用于使用该角色的后台账号。': 'Saved access applies immediately to admin accounts using this role.',
  '取消': 'Cancel',
  '完成': 'Done',
  '保存中…': 'Saving…',
  '保存权限': 'Save access',

  // Shared admin UI. These exact translations are also used by the admin-only
  // DOM fallback below for legacy pages that have not adopted useAdminI18n yet.
  '刷新': 'Refresh',
  '刷新数据': 'Refresh data',
  '刷新中…': 'Refreshing…',
  '查询中…': 'Searching…',
  '读取中…': 'Loading…',
  '正在读取…': 'Loading…',
  '正在读取数据…': 'Loading data…',
  '保存修改': 'Save changes',
  '确认删除': 'Confirm deletion',
  '删除': 'Delete',
  '无编辑权限': 'No edit access',
  '操作失败': 'Action failed',
  '已同步': 'Synced',
  '未同步': 'Not synced',
  '未填写': 'Not provided',
  '未匹配': 'Unmatched',
  '未分类': 'Uncategorized',
  '无数据': 'No data',
  '暂无数据': 'No data yet',
  '暂无记录': 'No records yet',
  '在职': 'Active',
  '试用': 'Probation',
  '离职': 'Resigned',
  '待批改': 'Pending grading',
  '已完成': 'Completed',
  '未通过': 'Not passed',
  '注意': 'Attention',
  '优秀': 'Excellent',
  '重点': 'Priority',
  '高频': 'High frequency',
  '递增': 'Increasing',
  '确定': 'Confirm',
  '返回': 'Back',
  '搜索': 'Search',
  '筛选': 'Filter',
  '收起筛选': 'Collapse filters',
  '展开筛选': 'Expand filters',
  '查看详情': 'View details',
  '查看全部': 'View all',
  '查看完整说明': 'View full details',
  '开始日期': 'Start date',
  '结束日期': 'End date',
  '日期起': 'Start date',
  '日期止': 'End date',
  '当日状态': 'Daily status',
  '最近7天': 'Last 7 days',
  '本月': 'This month',
  '本页': 'This page',
  '尾页': 'Last',

  '输入员工ID': 'Enter employee ID',
  '输入员工 ID': 'Enter employee ID',
  '输入姓名': 'Enter name',
  '输入员工姓名': 'Enter employee name',
  '员工姓名': 'Employee name',
  '员工国家': 'Country',
  '员工类型': 'Employee type',
  '员工状态': 'Employee status',
  '入职日期': 'Hire date',
  '入职日期起': 'Hire date from',
  '入职日期止': 'Hire date to',
  '入职时长': 'Tenure',
  '离职日期': 'Resignation date',
  '离职原因': 'Resignation reason',
  '负责人': 'Supervisor',
  '负责人 / 组长': 'Supervisor / team lead',
  '负责人 / 培训 / 组长': 'Supervisor / trainer / team lead',
  '组长': 'Team lead',
  '组别': 'Group',
  '班次': 'Shift',
  '盘口': 'Platform',
  '盘口 / 平台': 'Platform',
  '工作TG': 'Work Telegram',
  '基本资料': 'Basic information',
  '组织与排班': 'Organization & schedule',
  '联系方式': 'Contact details',
  '联系电话': 'Phone',
  '联系地址': 'Address',
  '收款资料': 'Payment details',
  '收款姓名': 'Account name',
  '收款方式': 'Payment method',
  '银行卡 / 钱包账号': 'Bank / wallet account',
  '培训老师': 'Trainer',
  '工作内容': 'Work responsibilities',
  '工资设置': 'Payroll settings',
  '底薪': 'Base salary',
  '日薪': 'Daily wage',
  '默认绩效': 'Default performance pay',
  '餐补': 'Meal allowance',
  '备注': 'Notes',
  '主档岗位': 'Record position',
  '排班岗位': 'Scheduled position',
  '未填写岗位': 'Position not provided',
  '未填写团队': 'Team not provided',
  '未填写组别': 'Group not provided',
  '未填写班次': 'Shift not provided',
  '未填写盘口': 'Platform not provided',
  '未填写平台': 'Platform not provided',
  '未匹配团队': 'Unmatched team',
  '未设置主档岗位': 'Record position not set',
  '未分团队': 'No team',
  '未分岗位': 'No position',
  '未分配团队': 'Unassigned team',

  '全部员工类型': 'All employee types',
  '全部员工状态': 'All employee statuses',
  '全部团队': 'All teams',
  '全部组别': 'All groups',
  '全部岗位': 'All positions',
  '全部班次': 'All shifts',
  '全部国家': 'All countries',
  '全部盘口': 'All platforms',
  '全部负责人': 'All supervisors',
  '全部错误类型': 'All error types',
  '全部质检人': 'All reviewers',
  '全部类别': 'All categories',
  '全部来源': 'All sources',
  '输入负责人': 'Enter supervisor',
  '记录总数': 'Total records',
  '涉及员工': 'Employees involved',
  '停电': 'Power outage',
  '断网': 'Internet outage',
  '问题类型': 'Issue type',
  '情况说明': 'Description',
  '证明': 'Proof',
  '新增记录': 'Add record',
  '编辑记录': 'Edit record',
  '开始 / 恢复': 'Start / restored',
  '持续': 'Duration',
  '录入人': 'Created by',
  '每日情况统计': 'Daily summary',

  '员工搜索': 'Employee search',
  '搜索员工': 'Search employees',
  '搜索员工ID或姓名': 'Search employee ID or name',
  '搜索员工 ID 或姓名': 'Search employee ID or name',
  '员工ID / 姓名': 'Employee ID / name',
  '员工ID / 姓名 / 原因 / 备注': 'Employee ID / name / reason / notes',
  '员工ID / 姓名 / 原因 / 备注 / 来源': 'Employee ID / name / reason / notes / source',
  '搜索团队': 'Search teams',
  '暂无团队': 'No teams',
  '指定员工': 'Select employee',
  '暂无员工': 'No employees',
  '输入员工ID或姓名；输入后显示匹配结果': 'Enter an employee ID or name to see matches',
  '输入员工 ID 或姓名搜索；也可不关联': 'Search by employee ID or name; linking is optional',
  '至少10位，含大小写、数字和符号': 'At least 10 characters with uppercase, lowercase, numbers and symbols',

  '早班 / 白班': 'Morning / day',
  '中班': 'Mid shift',
  '晚班 / 夜班': 'Evening / night',
  '其他 / 未设置': 'Other / not set',
  '团队 × 班次': 'Team × shift',
  '无人排班': 'No scheduled staff',
  '查看名单': 'View roster',
  '刷新排班': 'Refresh schedule',
  '刷新出勤': 'Refresh attendance',
  '查看月份': 'Month',
  '本月统计': 'Monthly summary',
  '当前筛选': 'Current filters',
  '月度统计': 'Monthly summary',
  '累计统计': 'Cumulative summary',
  '公休': 'Rest day',
  '回家': 'Home leave',
  '请假': 'Leave',
  '半天': 'Half day',
  '缺席': 'Absent',
  '奖金': 'Bonus',
  '扣款': 'Deduction',
  '金额 / 币种': 'Amount / currency',
  '奖金 / 扣款明细': 'Bonus / deduction details',

  '培训日报记录': 'Training report records',
  '人员详细记录': 'Employee detail records',
  '我负责的培训人员': 'My trainees',
  '历史培训日报': 'Training report history',
  '员工培训档案': 'Employee training records',
  '排班数据最近同步': 'Latest schedule sync',
  '提交线上培训日报': 'Submit training report',
  '报告内容': 'Report content',
  '提交人 / 线上培训': 'Submitter / online trainer',
  '仅查看': 'View only',
  '查看全部日报': 'View all reports',
  '最近日报': 'Latest report',
  '份日报': 'reports',
  '个记录日': 'record days',
  '名培训员工': 'trainees',

  '考试名称': 'Exam name',
  '记录来源': 'Source',
  '评分人': 'Grader',
  '完成日期起': 'Completed from',
  '完成日期止': 'Completed to',
  '员工考试记录与成绩': 'Employee exam records & scores',
  '考试': 'Exam',
  '次数': 'Attempt',
  '开始作答时间': 'Started',
  '完成作答时间': 'Completed',
  '评分完成时间': 'Graded',
  '得分': 'Score',
  '答题结果': 'Answer results',
  '查看答卷': 'View answers',
  '查看结果': 'View result',
  '编辑题目': 'Edit question',
  '删除题目': 'Delete question',
  '题目': 'Question',
  '分数': 'Score',
  '难度': 'Difficulty',
  '已答': 'Answered',
  '未答': 'Unanswered',
  '正确': 'Correct',
  '半对': 'Partially correct',
  '错误': 'Incorrect',
  '待评': 'Pending',
}

const AdminI18nContext = createContext(null)

function initialLocale() {
  if (typeof window === 'undefined') return 'zh'
  return window.localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh'
}

const ADMIN_PATH_RE = /\/admin(?:\/|$)/
const BLOCKED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE'])
const FALLBACK_ATTRIBUTES = ['placeholder', 'title', 'aria-label']
const DYNAMIC_CONTEXT_RE = /(?:employee|staff|person|trainer)[-_]?(?:name|identity)|(?:^|[-_\s])(?:identity|note|remark|memo|comment|reason-value|reason-text|report-content|work-content|answer|response|feedback|source-value|detail-value|rp-wrap|rp-cell-clamp|ot-meta)(?:$|[-_\s])/i
const STATUS_CONTEXT_SELECTOR = 'button, a, [role="button"], .status, .badge, .tag, .pill, [data-status], [data-tone]'

const prefixEnglish = {
  '负责人': 'Supervisor',
  '培训老师': 'Trainer',
  '提交人': 'Submitted by',
  '提交时间': 'Submitted',
  '最后更新': 'Last updated',
  '班次': 'Shift',
  '岗位': 'Position',
  '团队': 'Team',
  '组别': 'Group',
  '员工ID': 'Employee ID',
}

function isAdminPath() {
  return typeof window !== 'undefined' && ADMIN_PATH_RE.test(window.location.pathname)
}

function translateAdminCore(source) {
  if (!source) return source
  if (english[source]) return english[source]

  let match = source.match(/^共\s*([\d,]+)\s*人$/)
  if (match) return `${match[1]} people`
  match = source.match(/^共\s*([\d,]+)\s*条$/)
  if (match) return `${match[1]} records`
  match = source.match(/^([\d,]+)\s*条\s*\/\s*本页$/)
  if (match) return `${match[1]} on this page`
  match = source.match(/^第\s*(\d+)\s*次$/)
  if (match) return `Attempt ${match[1]}`
  match = source.match(/^第\s*(\d+)\s*\/\s*(\d+)\s*页$/)
  if (match) return `Page ${match[1]} / ${match[2]}`
  match = source.match(/^([\d,]+)\s*人\s*·\s*([\d,]+)\s*个团队$/)
  if (match) return `${match[1]} people · ${match[2]} teams`
  match = source.match(/^已应用\s*([\d,]+)\s*项条件\s*·\s*共\s*([\d,]+)\s*条$/)
  if (match) return `${match[1]} filters applied · ${match[2]} records`
  match = source.match(/^近\s*(\d+)\s*天(入职|离职)$/)
  if (match) return `${match[2] === '入职' ? 'Hired' : 'Resigned'} in ${match[1]} days`
  match = source.match(/^已选\s*([\d,]+)$/)
  if (match) return `${match[1]} selected`

  // Translate only a known UI label before a delimiter. The value after it is
  // deliberately preserved so names, teams and other business data stay intact.
  match = source.match(/^([^:：]+)([:：])\s*(.+)$/)
  if (match && prefixEnglish[match[1].trim()]) {
    return `${prefixEnglish[match[1].trim()]}${match[2]} ${match[3]}`
  }
  return source
}

function translateAdminText(source) {
  if (typeof source !== 'string' || !source) return source
  const leading = source.match(/^\s*/)?.[0] || ''
  const trailing = source.match(/\s*$/)?.[0] || ''
  if (leading.length + trailing.length >= source.length) return source
  const core = source.slice(leading.length, source.length - trailing.length)
  const translated = translateAdminCore(core)
  return translated === core ? source : `${leading}${translated}${trailing}`
}

function elementTokenText(element) {
  if (!(element instanceof Element)) return ''
  const className = typeof element.className === 'string' ? element.className : ''
  return `${element.id || ''} ${className}`
}

function hasExplicitSkip(element) {
  return Boolean(element?.closest?.('[data-admin-i18n-skip], .admin-i18n-skip, [contenteditable="true"]'))
}

function isDynamicTextContext(element) {
  let current = element
  while (current && current !== document.documentElement) {
    if (DYNAMIC_CONTEXT_RE.test(elementTokenText(current))) return true
    current = current.parentElement
  }
  return false
}

function shouldSkipTextNode(node) {
  const parent = node?.parentElement
  if (!parent || BLOCKED_TAGS.has(parent.tagName) || hasExplicitSkip(parent)) return true
  if (isDynamicTextContext(parent)) return true
  const tableCell = parent.closest('tbody td')
  if (tableCell && !parent.closest(STATUS_CONTEXT_SELECTOR)) return true
  return false
}

function shouldSkipAttribute(element, attributeName) {
  if (!(element instanceof Element) || BLOCKED_TAGS.has(element.tagName) || hasExplicitSkip(element)) return true
  // Placeholders are authored UI copy even when the field is a name/reason
  // search. Titles and aria labels can contain row data, so keep the stricter
  // dynamic-data guard for those attributes.
  if (attributeName !== 'placeholder' && isDynamicTextContext(element)) return true
  const tableCell = element.closest('tbody td')
  if (tableCell && !element.closest(STATUS_CONTEXT_SELECTOR) && attributeName !== 'placeholder') return true
  return false
}

function AdminDomI18nFallback({ locale }) {
  const textRecordsRef = useRef(new Map())
  const attributeRecordsRef = useRef(new Map())

  useEffect(() => {
    const textRecords = textRecordsRef.current
    const attributeRecords = attributeRecordsRef.current

    const restoreAll = () => {
      textRecords.forEach((record, node) => {
        if (node.nodeValue === record.applied) node.nodeValue = record.source
      })
      attributeRecords.forEach((records, element) => {
        records.forEach((record, attributeName) => {
          if (element.getAttribute(attributeName) === record.applied) {
            if (record.hadAttribute) element.setAttribute(attributeName, record.source)
            else element.removeAttribute(attributeName)
          }
        })
      })
      textRecords.clear()
      attributeRecords.clear()
    }

    const translateTextNode = node => {
      if (!(node instanceof Text) || shouldSkipTextNode(node)) return
      const current = node.nodeValue || ''
      const previous = textRecords.get(node)
      if (previous && current === previous.applied) return
      const translated = translateAdminText(current)
      if (translated === current) {
        if (previous) textRecords.delete(node)
        return
      }
      textRecords.set(node, { source: current, applied: translated })
      node.nodeValue = translated
    }

    const translateAttribute = (element, attributeName) => {
      if (!FALLBACK_ATTRIBUTES.includes(attributeName) || shouldSkipAttribute(element, attributeName)) return
      const current = element.getAttribute(attributeName)
      if (current == null) return
      let records = attributeRecords.get(element)
      const previous = records?.get(attributeName)
      if (previous && current === previous.applied) return
      const translated = translateAdminText(current)
      if (translated === current) {
        if (previous) records.delete(attributeName)
        if (records?.size === 0) attributeRecords.delete(element)
        return
      }
      if (!records) {
        records = new Map()
        attributeRecords.set(element, records)
      }
      records.set(attributeName, { source: current, applied: translated, hadAttribute: true })
      element.setAttribute(attributeName, translated)
    }

    const translateTree = root => {
      if (!root || !isAdminPath()) return
      if (root instanceof Text) {
        translateTextNode(root)
        return
      }
      if (!(root instanceof Element) && !(root instanceof Document)) return
      if (root instanceof Element) {
        FALLBACK_ATTRIBUTES.forEach(attributeName => translateAttribute(root, attributeName))
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        translateTextNode(node)
        node = walker.nextNode()
      }
      root.querySelectorAll?.('[placeholder], [title], [aria-label]').forEach(element => {
        FALLBACK_ATTRIBUTES.forEach(attributeName => translateAttribute(element, attributeName))
      })
    }

    if (locale !== 'en' || !isAdminPath()) {
      restoreAll()
      return undefined
    }

    translateTree(document.documentElement)
    const observer = new MutationObserver(mutations => {
      if (!isAdminPath()) {
        restoreAll()
        return
      }
      mutations.forEach(mutation => {
        if (mutation.type === 'characterData') translateTextNode(mutation.target)
        if (mutation.type === 'attributes') translateAttribute(mutation.target, mutation.attributeName)
        mutation.addedNodes?.forEach(translateTree)
      })
      // Avoid retaining detached page nodes while English remains enabled.
      textRecords.forEach((_record, node) => {
        if (!node.isConnected) textRecords.delete(node)
      })
      attributeRecords.forEach((_records, element) => {
        if (!element.isConnected) attributeRecords.delete(element)
      })
    })
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: FALLBACK_ATTRIBUTES,
    })
    return () => observer.disconnect()
  }, [locale])

  return null
}

export function AdminI18nProvider({ children }) {
  const [locale, setLocaleState] = useState(initialLocale)
  const value = useMemo(() => ({
    locale,
    setLocale(next) {
      const normalized = next === 'en' ? 'en' : 'zh'
      setLocaleState(normalized)
      if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, normalized)
    },
    t(source, fallback) {
      const text = String(source ?? '')
      return locale === 'en' ? (english[text] || fallback || text) : text
    },
  }), [locale])
  return <AdminI18nContext.Provider value={value}>
    <AdminDomI18nFallback locale={locale} />
    {children}
  </AdminI18nContext.Provider>
}

export function useAdminI18n() {
  return useContext(AdminI18nContext) || { locale:'zh', setLocale:()=>{}, t:source=>source }
}

export function AdminLanguageSwitcher({ className = '' }) {
  const { locale, setLocale } = useAdminI18n()
  return <label className={className}>
    <span>{locale === 'en' ? 'Language' : '语言'}</span>
    <select aria-label={locale === 'en' ? 'Language' : '语言'} value={locale} onChange={event => setLocale(event.target.value)}>
      <option value="zh">中文</option>
      <option value="en">English</option>
    </select>
  </label>
}
