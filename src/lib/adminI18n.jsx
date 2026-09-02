import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'wfh_admin_locale'

const english = {
  'WFH 登录': 'WFH Sign in',
  '账号': 'Username',
  '密码': 'Password',
  '显示': 'Show',
  '隐藏': 'Hide',
  '显示密码': 'Show password',
  '隐藏密码': 'Hide password',
  '登录': 'Sign in',
  '登录中...': 'Signing in...',
  '请求格式不正确': 'Invalid request format.',
  '账号格式不正确': 'Invalid username format.',
  '请输入密码': 'Enter your password.',
  '账号不存在': 'Account not found.',
  '密码错误': 'Incorrect password.',
  '账号不可用，请联系管理员': 'This account is unavailable. Contact an administrator.',
  '尝试次数过多，请稍后重试': 'Too many attempts. Try again later.',
  '登录服务暂不可用，请稍后重试': 'Sign-in is temporarily unavailable. Try again later.',
  '登录会话验证暂不可用，请稍后重试': 'Unable to verify this browser session. Try again later.',
  '旧会话接管未完成，请重新登录': 'Unable to replace the previous session. Sign in again.',
  '登录会话已失效，请重试': 'Your session has expired. Try again.',
  '登录失败，请稍后重试': 'Sign-in failed. Try again later.',
  '当前会话已结束：该账号正在另一浏览器使用': 'This session ended because the account is active in another browser.',
  '登录会话已失效，请重新登录': 'Your session has expired. Sign in again.',
  '暂时无法登录': 'Sign-in is temporarily unavailable.',
  '登录状态设置超时，请重试': 'Setting up the session timed out. Try again.',
  '登录失败，请重试': 'Sign-in failed. Try again.',
  '登录服务响应超时，请稍后重试': 'The sign-in service timed out. Try again later.',
  '首页': 'Dashboard',
  '预警中心': 'Warning center',
  '员工排班管理统计': 'Workforce, scheduling & reports',
  '员工档案查询表': 'Employee records',
  '人员分析表': 'People analytics',
  '离职记录表': 'Resignation records',
  '档案变更记录': 'Record change log',
  '在职离职操作日志': 'Employment status operation log',
  '奖金扣款录入日志': 'Bonus / deduction entry log',
  '出勤录入日志': 'Attendance entry log',
  '汇总表': 'Summary report',
  '人员分布总表': 'Workforce distribution',
  '站点人数报表': 'Site headcount report',
  '考勤考试奖惩统计': 'Attendance, exams & rewards',
  '月考勤休假记录表': 'Monthly attendance & leave',
  '停电/断网记录': 'Power / internet records',
  '日考勤打卡记录表': 'Daily attendance records',
  '请假审批记录表': 'Leave approval records',
  '错误记录统计报表': 'Error statistics report',
  '线上培训日报记录表': 'Online training daily reports',
  '考试汇总表': 'Exam summary',
  '考试记录表': 'Exam records',
  '题库表': 'Question bank',
  '奖惩表': 'Rewards & deductions',
  '工作执行与负责人管理统计': 'Work execution & ownership',
  '事件跟踪表': 'Event tracking',
  '每日巡视项目日报记录表': 'Daily inspection reports',
  '质检日报记录表': 'Quality inspection reports',
  '工资统计': 'Payroll reports',
  '待发布工资表': 'Pending payroll',
  '已发布工资表': 'Published payroll',
  '后台账号使用情况': 'Account usage & access',
  '员工使用聊天工具': 'Staff chat tool usage',
  '公司提供资产': 'Company-provided assets',
  '按当前账号管理范围读取': 'Within the current account scope',
  '员工基础资料': 'Employee profile data',
  '资产明细': 'Asset details',
  '待接入表格': 'Awaiting spreadsheet',
  '收到 Google 表格后接入实时同步': 'Realtime sync will be connected after the Google Sheet is provided',
  '员工资料来自 Supabase；硬件和软件账号等待资产表接入。': 'Employee profiles come from Supabase. Hardware and software accounts are awaiting the asset sheet.',
  '资产分类': 'Asset category',
  '硬件资产': 'Hardware assets',
  '软件账号': 'Software accounts',
  '硬件类型': 'Hardware type',
  '手机': 'Phones',
  '电脑': 'Computers',
  '输入入职日期、员工ID、姓名、国家或工作 Telegram': 'Enter hire date, employee ID, name, country, or work Telegram',
  '全部员工国家': 'All employee countries',
  '没有符合条件的在职员工': 'No matching active employees',
  '公司资产资料读取失败': 'Unable to load company assets',
  '正在读取公司资产资料': 'Loading company assets',
  '资产类型': 'Asset type',
  '数量': 'Quantity',
  '品牌 / 型号': 'Brand / model',
  '资产编号': 'Asset ID',
  '使用状态': 'Usage status',
  '微软账号': 'Microsoft account',
  '无影云': 'Wuying Cloud',
  '邮箱账号': 'Email account',
  '其他软件': 'Other software',
  '员工前端账号': 'Staff portal accounts',
  '激活时间': 'Activated at',
  '后台角色权限': 'Admin roles & permissions',
  '规划中': 'Planned',
  '等待需求确认': 'Awaiting requirements',
  '菜单入口已建立，现有功能和数据不会受到影响。': 'The menu entry is ready. Existing features and data are unchanged.',
  '模块入口已经建立；事件字段、负责人流程和状态规则确认后再接入真实数据。': 'The module entry is ready. Live data will be connected after the event fields, ownership workflow, and status rules are confirmed.',
  '模块入口已经建立；巡视项目、提交人和日报格式确认后再接入真实数据。': 'The module entry is ready. Live data will be connected after the inspection items, submitters, and report format are confirmed.',
  '模块入口已经建立；后续可按出款抽查、彩金抽查和客服抽查区分记录。': 'The module entry is ready. Records can later be separated into payout, bonus, and customer-service inspections.',
  '模块入口已经建立；聊天工具范围、使用状态及统计字段确认后再接入真实数据。': 'The module entry is ready. Live data will be connected after the chat tools, usage statuses, and reporting fields are confirmed.',
  '员工管理': 'Employees',
  '员工档案': 'Employee records',
  '人员分析': 'People analytics',
  '停电 / 断网记录': 'Power / internet',
  '预警记录': 'Warning records',
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
  '收款资料待审核': 'Payment details pending review',
  '申请记录': 'Request history',
  '修改工资信息记录': 'Payment details change records',
  '刷新资料': 'Refresh data',
  '正在读取页面权限…': 'Loading page access…',
  '当前账号没有工资中心页面权限。': 'This account does not have access to Payroll.',
  '收款资料申请记录': 'Payment details request history',
  '证明文件保存在私有空间；只有具备权限且在管理范围内的账号可以查看。': 'Proof files are private and visible only to authorized accounts within their management scope.',
  '员工 / 原因': 'Employee / reason',
  '员工ID、姓名或修改原因': 'Employee ID, name or reason',
  '输入团队': 'Enter team',
  '输入岗位': 'Enter position',
  '输入修改原因': 'Enter reason',
  '全部状态': 'All statuses',
  '已通过': 'Approved',
  '已驳回': 'Rejected',
  '待审核': 'Pending',
  '已取消': 'Cancelled',
  '提交时间': 'Submitted',
  '申请人 / 时间': 'Applicant / submitted at',
  '员工': 'Employee',
  '员工类型 / 国家': 'Employee type / country',
  '团队 / 岗位': 'Team / position',
  '组织 / 类型': 'Organization / type',
  '申请内容': 'Request',
  '资料处理': 'Details update',
  '修改项目': 'Change item',
  '原因': 'Reason',
  '审核结果': 'Review result',
  '实际资料处理': 'Actual details status',
  '正在读取申请…': 'Loading requests…',
  '银行卡 / 钱包': 'Bank / wallet',
  'USDT 地址': 'USDT address',
  '详情': 'Details',
  '审核': 'Review',
  '审核通过': 'Approve review',
  '尚未审核': 'Not reviewed',
  '系统 / 外部同步': 'System / external sync',
  '自动修改已关闭': 'Automatic updates are off',
  '自动修改：关闭': 'Automatic update: off',
  '自动修改：关闭。批准只记录审核结果，由助理人工修改实际资料。': 'Automatic updates are off. Approval records the decision only; an assistant must update the actual details manually.',
  '自动修改已启用；批准后系统会写入实际收款资料。': 'Automatic updates are enabled. Approval will write the actual payment details.',
  '批准只记录审核通过，不会自动修改银行卡、钱包账号或 USDT 地址。': 'Approval records the decision only. It will not change the bank account, wallet account, or USDT address automatically.',
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
  '申请已审核通过；自动修改已关闭，请助理人工核对并修改实际收款资料。': 'The request was approved. Automatic updates are off; an assistant must verify and update the actual payment details manually.',
  '申请已驳回，员工可在前端查看原因。': 'Rejected. The employee can view the reason in the staff portal.',
  '该历史申请没有保存此证明文件。': 'No proof file was saved for this historical request.',
  '组织': 'Organization',
  '员工本人': 'Employee',
  '审核人 / 时间': 'Reviewer / reviewed at',
  '拒绝时间': 'Rejected at',
  '通过时间': 'Approved at',
  '等待审核': 'Awaiting review',
  '审核通过，等待助理人工修改': 'Approved; awaiting manual update by an assistant',
  '资料已更新并匹配': 'Details updated and matched',
  '资料已变化，但与申请不一致': 'Details changed but do not match the request',
  '无需处理': 'No action required',
  '旧资料': 'Previous details',
  '新资料': 'New details',
  '修改原因': 'Reason for change',
  '员工 / 录入账号 / 原因': 'Employee / entry account / reason',
  '输入员工ID、姓名、录入账号或原因': 'Enter employee ID, name, entry account, or reason',
  '仅显示后台账号录入或修改的出勤记录；Google 表格同步记录不冒充人工录入。': 'Shows attendance records entered or changed by admin accounts only. Google Sheet syncs are not presented as manual entries.',
  '显示后台新增或修改的奖金、扣款记录，以及系统保存的录入账号。': 'Shows bonus and deduction records added or changed in the admin app, including the recorded entry account.',
  '当前账号没有查看此日志的权限。': 'This account is not authorized to view this log.',
  '录入日志读取失败，请稍后重试。': 'Unable to load the entry log. Try again later.',
  '录入 / 更新时间': 'Entered / updated at',
  '录入账号': 'Entry account',
  '记录日期': 'Record date',
  '记录类型': 'Record type',
  '原因 / 备注': 'Reason / note',
  '数据来源 / 同步': 'Source / sync',
  '正在读取录入日志…': 'Loading entry logs…',
  '暂无符合条件的录入日志。': 'No matching entry logs.',
  '修改': 'Update',
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
  '永久删除申请记录': 'Permanently delete request',
  '此操作不可恢复': 'This action cannot be undone',
  '申请记录及关联的身份证明、收款资料截图会永久删除；审计记录会保留，员工档案、排班和工资资料不会受到影响。': 'The request and its identity and payment proof files will be permanently deleted. Audit records remain, and the employee profile, schedule, and payroll are unchanged.',
  '删除原因': 'Deletion reason',
  '请填写删除原因（5–500 字）': 'Enter a deletion reason (5–500 characters)',
  '请输入下方确认文字': 'Enter the confirmation text below',
  '永久删除': 'Delete permanently',
  '申请记录删除失败，请稍后重试。': 'Unable to delete the request. Try again later.',
  '该申请记录已删除，列表已刷新。': 'This request was already deleted. The list has been refreshed.',
  '申请记录已永久删除': 'Request permanently deleted',
  '个证明文件已清除': 'proof files removed',
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
  '生命周期账本（已去重）': 'Deduplicated lifecycle ledger',
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
  '新增中…': 'Creating…',
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

  // Common actions, states and legacy-page copy.
  '新增': 'Add',
  '提交': 'Submit',
  '审批': 'Approve',
  '批注 / 复核': 'Comment / review',
  '批改': 'Grade',
  '导出': 'Export',
  '发布': 'Publish',
  '管理': 'Manage',
  '生成': 'Generate',
  '开': 'On',
  '关': 'Off',
  '选择': 'Select',
  '请选择': 'Select',
  '重新选择': 'Choose again',
  '移除': 'Remove',
  '删除中…': 'Deleting…',
  '导入中…': 'Importing…',
  '发布中…': 'Publishing…',
  '打开中…': 'Opening…',
  '读取中': 'Loading',
  '获取中…': 'Getting code…',
  '已提交': 'Submitted',
  '已编辑': 'Edited',
  '提交于': 'Submitted',
  '已记录': 'Recorded',
  '已核实': 'Verified',
  '已恢复': 'Restored',
  '不成立': 'Invalid',
  '尚未设置': 'Not set',
  '尚无日报': 'No reports yet',
  '后台用户': 'Admin user',
  '管理账号': 'Admin account',
  '系统数据': 'System data',
  '完整': 'Complete',
  '已开通': 'Enabled',
  '已停用': 'Disabled',
  '未开通': 'Not enabled',
  '已激活': 'Activated',
  '未激活': 'Not activated',
  '全部账号': 'All accounts',
  '账号激活状态': 'Account activation',
  '激活码': 'Activation code',
  '输入工作TG': 'Enter work Telegram',
  '输入后台账号': 'Enter admin account',
  '更多筛选': 'More filters',
  '全部团队 / 输入搜索': 'All teams / type to search',
  '全部岗位 / 输入搜索': 'All positions / type to search',
  '全部员工国家 / 输入搜索': 'All countries / type to search',
  '全部班次 / 输入搜索': 'All shifts / type to search',
  '全部负责人 / 输入搜索': 'All supervisors / type to search',
  '综合搜索': 'Search',
  '搜索标题、提交人、盘口、员工或工作内容': 'Search title, submitter, platform, employee or work content',
  '全部提交人': 'All submitters',
  '操作类型': 'Action type',
  '输入操作内容关键字': 'Enter action keywords',

  // Employee records and workforce analytics.
  '新增员工': 'Add employee',
  '编辑员工': 'Edit employee',
  '办理离职': 'Process resignation',
  '编辑离职': 'Edit resignation',
  '恢复在职': 'Restore active status',
  '撤销入职': 'Cancel hire',
  '确认恢复': 'Confirm restoration',
  '确认撤销入职': 'Confirm hire cancellation',
  '岗位管理': 'Position management',
  '入离职记录': 'Hire / resignation history',
  '总览': 'Overview',
  '团队分析': 'Team analysis',
  '岗位分析': 'Position analysis',
  '班次分析': 'Shift analysis',
  '国家分析': 'Country analysis',
  '员工国家分析': 'Employee country analysis',
  '离职分析': 'Resignation analysis',
  '分析日期区间': 'Analysis date range',
  '离职日期区间': 'Resignation date range',
  '离职日期起': 'Resignation date from',
  '离职日期止': 'Resignation date to',
  '输入离职原因': 'Enter resignation reason',
  '输入离职原因关键字': 'Enter resignation reason keywords',
  '全部等级': 'All levels',
  '优秀（0错误）': 'Excellent (0 errors)',
  '正常（1–8）': 'Normal (1–8)',
  '注意（9–15）': 'Attention (9–15)',
  '重点（16–30）': 'Priority (16–30)',
  '高频（31+）': 'High frequency (31+)',
  '累计错误': 'Total errors',
  '待完善': 'Incomplete',
  '团队结构分析': 'Team structure analysis',
  '岗位结构分析': 'Position structure analysis',
  '员工结构统计': 'Employee structure statistics',
  '员工国家概览': 'Employee country overview',
  '员工国家入职阶段': 'Hire stage by employee country',
  '各员工国家人员流动': 'Workforce movement by employee country',
  '团队人数占比': 'Team headcount share',
  '岗位人数占比': 'Position headcount share',
  '班次人数占比': 'Shift headcount share',
  '当前在职': 'Currently active',
  '累计离职': 'Total resignations',
  '综合离职率': 'Overall resignation rate',
  '所选区间': 'Selected period',
  '区间离职': 'Resigned in period',
  '区间入职': 'Hired in period',
  '区间净增': 'Net change in period',
  '区间离职率': 'Resignation rate in period',
  '今日离职': 'Resigned today',
  '昨日离职': 'Resigned yesterday',
  '近7天离职': 'Resigned in 7 days',
  '近30天离职': 'Resigned in 30 days',
  '近30天离职率': '30-day resignation rate',
  '本月离职': 'Resigned this month',
  '各团队离职明细': 'Resignations by team',
  '岗位离职排行': 'Resignations by position',
  '员工国家离职排行': 'Resignations by employee country',
  '班次离职排行': 'Resignations by shift',
  '7天入职': 'Hired in 7 days',
  '7天离职': 'Resigned in 7 days',
  '30天入职': 'Hired in 30 days',
  '30天离职': 'Resigned in 30 days',
  '30天净增': '30-day net change',
  '入职': 'Hired',
  '查看当前人员 →': 'View current staff →',
  '查看人员': 'View staff',
  '占当前在职': 'Share of active staff',

  // Reports and attendance.
  '统计总览': 'Statistics overview',
  '员工订单处理统计': 'Employee order processing',
  '排班明细': 'Schedule details',
  '员工名单': 'Employee roster',
  '点击条目查看人员': 'Select an item to view employees',
  '现场培训': 'Onsite training',
  '线上组长': 'Online team lead',
  '线上培训': 'Online training',
  '错误类型': 'Error type',
  '质检人': 'Reviewer',
  '质检时间': 'Review time',
  '复检时间': 'Recheck time',
  '源表行号': 'Source row',
  '错误备注': 'Error notes',
  '正确操作方式': 'Correct procedure',
  '集中查看员工考勤、请假与离职记录。': 'Review employee attendance, leave and resignation records in one place.',
  '考勤记录明细': 'Attendance record details',
  '记录类别': 'Record category',
  '页面数据来自 Supabase；这里显示最近一次 Google 表格同步结果。': 'Page data comes from Supabase. The latest Google Sheets sync result is shown here.',
  '正在生成月度出勤表…': 'Generating monthly attendance…',
  '完整备注': 'Full notes',
  '点击查看完整备注': 'View full notes',
  '每日状态人数': 'Daily status headcount',
  '每日暂无异常': 'No daily exceptions',
  '岗位 / 团队': 'Position / team',
  '盘口 / 国家': 'Platform / country',

  // Power / internet records.
  '发生日期': 'Date occurred',
  '自动时长': 'Automatic duration',
  '开始时间': 'Start time',
  '恢复时间': 'Restored time',
  '记录状态': 'Record status',
  '情况说明（可选）': 'Description (optional)',
  '图片 / 视频证明（可选，最多 3 个）': 'Image / video proof (optional, up to 3 files)',
  '支持图片、MP4、MOV、WebM；每个文件不超过 50MB。': 'Images, MP4, MOV and WebM are supported; each file must be 50 MB or smaller.',
  '待上传': 'Pending upload',
  '正在上传并保存…': 'Uploading and saving…',
  '保存记录': 'Save record',
  '删除停电 / 断网记录': 'Delete power / internet record',
  '确认删除这条记录吗？': 'Delete this record?',
  '全部类型': 'All types',
  '暂无每日统计': 'No daily summary yet',
  '正在读取记录…': 'Loading records…',
  '暂无符合条件的记录': 'No matching records',
  '类型': 'Type',
  '视频': 'Video',
  '图片': 'Image',
  '旧证明': 'Existing proof',
  '下载文件': 'Download file',
  '重试预览': 'Retry preview',

  // Daily work and online training.
  '负责人和组长在系统提交每日工作情况；线上培训使用独立的排班关联日报。': 'Supervisors and team leads submit daily work here. Online training uses its own schedule-linked report.',
  '可提交报告': 'Can submit reports',
  '＋ 提交报告': '+ Submit report',
  '今日提交': 'Submitted today',
  '工作报告': 'Work reports',
  '累计记录': 'Total records',
  '所有后台成员均可查看；提交人管理自己的记录，获授权人员可管理全部记录。': 'All admin users can view these records. Submitters manage their own records; authorized users can manage all records.',
  '正在读取每日工作记录…': 'Loading daily work records…',
  '提交第一份报告': 'Submit the first report',
  '人员名单': 'Staff list',
  '今日工作情况': 'Today\'s work',
  '员工工作 / 培训情况': 'Employee work / training',
  '响应时间 / 数据': 'Response time / metrics',
  '交接内容': 'Handover details',
  '交接概况': 'Handover summary',
  '问题与风险': 'Issues and risks',
  '后续计划': 'Next steps',
  '报告截图': 'Report screenshots',
  '编辑报告': 'Edit report',
  '新建记录': 'New record',
  '提交每日工作': 'Submit daily work',
  '报告标题 *': 'Report title *',
  '日期起 *': 'Start date *',
  '课程类型': 'Course type',
  '团队负责人': 'Team supervisor',
  '交接状态': 'Handover status',
  '交接概况 *': 'Handover summary *',
  '今日工作情况 *': 'Today\'s work *',
  '＋ 选择截图': '+ Select screenshots',
  '提交报告': 'Submit report',
  '确定删除这份记录？': 'Delete this record?',
  '待跟进': 'Pending follow-up',
  '跟进中': 'In progress',
  '报告截图·': 'Report screenshots ·',

  '线上培训日报': 'Online training reports',
  '＋ 提交线上培训日报': '+ Submit training report',
  '已关联': 'Linked',
  '管理员代填': 'Admin entry',
  '重新读取': 'Reload',
  '培训人员日报': 'Trainee reports',
  '排班培训员工（含零日报）': 'Scheduled trainees (including those with no reports)',
  '系统每 5 分钟检查变更': 'The system checks for changes every 5 minutes',
  '输入提交人或培训': 'Enter submitter or trainer',
  '搜索平台、报告、评语或问题': 'Search platform, report, feedback or issues',
  '查询新条件': 'Search with new filters',
  '首次进入显示本月至今；修改任何条件后点击“查询”': 'The initial view shows this month to date. Select Search after changing any filter.',
  '没有匹配的培训人员': 'No matching trainers',
  '可以调整员工、组织或日期条件后重新查询。': 'Adjust the employee, organization or date filters and search again.',
  '没有找到员工培训记录': 'No employee training records found',
  '可以输入员工ID或姓名搜索。': 'Search by employee ID or name.',
  '所选日期': 'Selected dates',
  '最近记录': 'Latest record',
  '查看该员工每天记录': 'View daily employee records',
  '编辑线上培训日报': 'Edit training report',
  '定位第一处': 'Go to first issue',
  '1. 账号与居家排班已自动关联': '1. Account and remote schedule linked automatically',
  '人员以「居家排班表 · 填表」的线上培训字段为准，不需要自行筛选': 'Trainees come from the Online Training field in the remote schedule; no manual filtering is needed.',
  '报告日期 *': 'Report date *',
  '当前提交人 / 线上培训': 'Current submitter / online trainer',
  '排班更新': 'Schedule updated',
  '正在编辑原日报': 'Editing the original report',
  '名单沿用提交当天保存的排班快照，不会被当前排班覆盖。': 'The roster uses the schedule snapshot saved on the report date and is not overwritten by the current schedule.',
  '管理员测试 / 代填线上培训': 'Admin test / report on behalf of a trainer',
  '正在读取负责人员…': 'Loading assigned staff…',
  '请选择一名线上培训人员': 'Select an online trainer',
  '人员读取失败': 'Unable to load trainees',
  '居家排班表暂时没有匹配到你的组员': 'No trainees in the remote schedule currently match your account',
  '2. 填写组员当天工作情况': '2. Enter each trainee\'s work for the day',
  '名单已经带入；未到入职日期可选“未入”，公休、未入无需原因，请假、缺席、回家必须填写原因': 'The roster is prefilled. Use “Not started” before the hire date. Rest days and not-started records need no reason; leave, absence and home leave require one.',
  '未入': 'Not started',
  '正在从居家排班表读取该培训负责的人员…': 'Loading this trainer\'s roster from the remote schedule…',
  '请选择一名线上培训人员，组员会立即自动出现。': 'Select an online trainer to load their trainees automatically.',
  '当前没有可填写的线上培训人员。': 'There are no trainees available for this report.',
  '3. 上传关键图片': '3. Upload key images',
  '工作截图 / 培训截图': 'Work / training screenshots',
  '选择图片': 'Select images',
  '点击查看大图': 'View full-size image',
  '可选：补充团队整体总结、共同问题或下一步安排': 'Optional: add a team summary, common issues or next steps',
  '整体培训总结': 'Overall training summary',
  '共同问题': 'Common issues',
  '下一步安排': 'Next steps',
  '提交日报': 'Submit report',
  '排班自动带入': 'Prefilled from schedule',
  '当天工作情况 / 培训评语 *': 'Work details / training feedback *',
  '岗位数据 / 首次响应（选填）': 'Position metrics / first response (optional)',
  '可选：分别补充工作表现、发现问题、后续安排': 'Optional: add performance, issues and follow-up separately',
  '工作表现': 'Performance',
  '发现问题': 'Issues found',
  '后续安排': 'Follow-up',
  '待查看': 'Pending review',
  '已阅': 'Read',
  '需补充': 'Needs changes',
  '排班记录': 'Schedule record',
  '组长 / 主管批注': 'Team lead / supervisor note',
  '标记已阅': 'Mark as read',
  '需要补充': 'Needs changes',
  '复制 Telegram 格式': 'Copy Telegram format',
  '只看某一天': 'View one day',
  '清除日期': 'Clear date',
  '该日没有日报': 'No reports on this date',
  '当前培训人员尚无日报': 'This trainer has no reports yet',
  '零日报培训人员会保留在列表中。': 'Trainers with no reports remain in the list.',
  '已保存当天培训记录': 'Daily training record saved',
  '查看某一天': 'View one day',
  '只看该日': 'View this day only',
  '返回筛选区间': 'Return to filter range',
  '区间天数': 'Days in range',
  '有记录': 'Recorded',
  '未记录': 'Not recorded',
  '正在读取该员工每天记录…': 'Loading daily employee records…',
  '所选日期内暂无该员工记录': 'No employee records in the selected dates',
  '仅该员工': 'This employee only',
  '当天工作 / 培训评语': 'Work details / training feedback',
  '岗位数据 / 首次响应': 'Position metrics / first response',
  '状态说明': 'Status details',
  '当天记录': 'Daily record',
  '确定删除这份日报？': 'Delete this report?',

  // Account administration.
  '新增后台账号': 'Add admin account',
  '编辑后台账号': 'Edit admin account',
  '搜索并关联员工档案（可选）': 'Find and link an employee record (optional)',
  '没有匹配的员工档案，请检查员工 ID 或姓名。': 'No matching employee record. Check the employee ID or name.',
  '临时密码': 'Temporary password',
  '管理范围': 'Management scope',
  '仅关联员工本人': 'Linked employee only',
  '关联员工所在团队': 'Linked employee\'s team',
  '指定团队 / 指定员工': 'Selected teams / employees',
  '全部数据': 'All data',
  '当前账号没有“管理账号数据范围”权限。': 'This account cannot manage account data scopes.',
  '登录 OTP': 'Login OTP',
  '批量创建清单': 'Bulk creation list',
  '逐个填写上方资料并加入清单，一次最多创建 20 个账号。': 'Complete each account above and add it to the list. Up to 20 accounts can be created at once.',
  '＋ 加入清单': '+ Add to list',
  '未关联员工': 'No linked employee',
  '未选角色': 'No role selected',
  '尚未加入清单；也可以直接点击下方“创建当前账号”创建一名账号。': 'No accounts in the list. You can also select Create current account below.',
  '创建当前账号': 'Create current account',
  '保存': 'Save',
  '新增员工前端账号': 'Add staff portal account',
  '员工账号必须关联唯一员工档案，登录后自动读取本人团队、岗位及考试。': 'A staff account must link to one employee record. Team, position and exams load automatically after sign-in.',
  '搜索并关联在职员工（必选）': 'Find and link an active employee (required)',
  '已开账号及离职人员不会出现在结果中，同一员工ID不能重复开户。': 'Employees with an account and resigned employees are excluded. An employee ID cannot have duplicate accounts.',
  '没有可开户的在职员工；可能已开户、已离职或ID不存在。': 'No eligible active employee found. The account may already exist, the employee may have resigned, or the ID may not exist.',
  '创建中…': 'Creating…',
  '创建账号': 'Create account',

  // Payroll import, review and record details.
  '上传工资表': 'Upload payroll file',
  '支持 XLSX、CSV、TSV；自动识别中文、英文、越南文和印尼文常用表头。': 'Supports XLSX, CSV and TSV, with common Chinese, English, Vietnamese and Indonesian headers detected automatically.',
  '工资月份': 'Payroll month',
  '批次名称': 'Batch name',
  '正在读取表格…': 'Reading spreadsheet…',
  '选择工资表文件': 'Select payroll file',
  '文件只用于导入工资数据，不会向员工公开整张表。': 'The file is used only to import payroll data. The full spreadsheet is not shared with employees.',
  '导入预览': 'Import preview',
  '确认导入': 'Confirm import',
  '暂无对应工资批次': 'No payroll batches in this view',
  '已发布给员工': 'Published to employees',
  '仍在后台复核，员工暂时看不到': 'Under admin review; employees cannot see it yet',
  '发布给员工': 'Publish to employees',
  '删除批次': 'Delete batch',
  '在职 / 试用': 'Active / probation',
  '在职与试用': 'Active and probation',
  '停用员工': 'Disabled employees',
  '停用 / inactive': 'Disabled / inactive',
  '离职员工': 'Resigned employees',
  '历史记录保留': 'History retained',
  '需要核对': 'Needs review',
  '没有数据': 'No data',
  '合计实发': 'Total net pay',
  '员工ID / 姓名 / 盘口 / 卡号 / 收款姓名 / 备注': 'Employee ID / name / platform / card number / account name / notes',
  '清除筛选': 'Clear filters',
  '导入批次': 'Import batches',
  '默认只显示文档摘要；点击任一批次查看该文档的全部员工明细。': 'Document summaries are shown by default. Select a batch to view all employee details.',
  '导入文档': 'Imported document',
  '导入时间': 'Imported',
  '人数': 'Headcount',
  '总金额': 'Total amount',
  '未命名工资文档': 'Untitled payroll document',
  '文件上传': 'File upload',
  '系统导入': 'System import',
  '查看记录': 'View records',
  '暂无工资导入记录': 'No payroll import history',
  '工资导入记录': 'Payroll import record',
  '关闭批次记录': 'Close batch record',
  '工资单': 'Payslips',
  '币种 / 状态': 'Currency / status',
  '正在读取该文档的员工工资记录…': 'Loading employee payroll records…',
  '组织 / 岗位': 'Organization / position',
  '任职日期': 'Employment dates',
  '基础工资': 'Base salary',
  '出勤工资': 'Attendance pay',
  '加扣明细': 'Adjustments',
  '实发工资': 'Net pay',
  '匹配': 'Match',
  '银行 / GCASH': 'Bank / GCASH',
  '卡号': 'Card number',
  '完整姓名': 'Full name',
  '打开完整员工档案': 'Open full employee record',
  '完整盘口 / 平台': 'Full platform',
  '完整收款资料': 'Full payment details',
  '点击查看': 'View details',
  '完整工资构成': 'Full payroll breakdown',
  '无调整': 'No adjustments',
  '查看全部明细': 'View all details',
  '导入后匹配': 'Matched after import',
  '暂无符合条件的工资记录': 'No matching payroll records',
  '休假扣款': 'Leave deduction',
  '迟到扣款': 'Late deduction',
  '缺勤扣款': 'Absence deduction',
  '满勤': 'Full attendance',
  '绩效': 'Performance',
  '押金': 'Deposit',
  '额外加班': 'Extra overtime',
  '额外加扣': 'Extra adjustment',
  '下次要扣除': 'Next deduction',
  '多转扣除': 'Overpayment deduction',
  '其他调整': 'Other adjustment',
  '关闭员工档案': 'Close employee record',
  '正在读取员工档案…': 'Loading employee record…',
  '组织与岗位': 'Organization & position',

  // Remaining high-frequency labels in employee, report and attendance views.
  '纯居家': 'Fully remote',
  '纯居家（越南/缅甸/印尼等）': 'Fully remote (Vietnam / Myanmar / Indonesia, etc.)',
  '纯居家菲律宾': 'Fully remote Philippines',
  '纯居家越南': 'Fully remote Vietnam',
  '纯居家印尼': 'Fully remote Indonesia',
  '纯居家缅甸': 'Fully remote Myanmar',
  '无收款资料编辑权限': 'No permission to edit payment details',
  '无敏感资料编辑权限': 'No permission to edit sensitive data',
  '较昨日': 'vs yesterday',
  '较前7天': 'vs previous 7 days',
  '较前日': 'vs previous day',
  '较上月同期': 'vs same period last month',
  '当前在职员工': 'Current active employees',
  '今日入职': 'Hired today',
  '今日入职人员': 'Employees hired today',
  '今日离职人员': 'Employees resigned today',
  '昨日离职人员': 'Employees resigned yesterday',
  '近7天入职人员': 'Employees hired in 7 days',
  '近7天离职人员': 'Employees resigned in 7 days',
  '近30天净增': 'Net change in 30 days',
  '近30天人员流动': 'Workforce movement in 30 days',
  '30天离职最多': 'Most resignations in 30 days',
  '来源': 'Source',
  '等级': 'Level',
  '操作账号': 'Operator account',
  '工资方式': 'Pay method',
  '员工地址': 'Employee address',
  '国家': 'Country',
  '点击姓名再看下属': 'Select a name to view direct reports',
  '弹窗全屏查看': 'Open full-screen view',
  '总 ⇅': 'Total ⇅',
  '平均每天处理 ⇅': 'Daily average ⇅',
  '错误次数 ⇅': 'Error count ⇅',
  '成功/驳回': 'Approved / rejected',
  '扣分': 'Points deducted',
  '统计数据读取失败': 'Unable to load statistics',
  '错误统计读取失败': 'Unable to load error statistics',
  '统计读取失败': 'Unable to load statistics',
  '错误记录读取失败': 'Unable to load error records',
  '员工档案读取失败': 'Unable to load employee record',
  '员工错误统计': 'Employee error statistics',
  '查看错误': 'View errors',
  '小组长复审': 'Team lead review',
  '质检人对/错': 'Reviewer decision',
  '等待同步状态': 'Waiting for sync status',
  '等待后端返回同步时间': 'Waiting for the server sync time',
  '同步异常': 'Sync error',
  '同步中': 'Syncing',
  '未分组': 'No group',
  '记录总数 / Records': 'Total records',
  '公休 / Rest day': 'Rest day',
  '回家 / Home leave': 'Home leave',
  '请假 / Leave': 'Leave',
  '半天 / Half day': 'Half day',
  '缺席 / Absent': 'Absent',
  '离职 / Resigned': 'Resigned',
  '公 公休 / Rest day': 'R  Rest day',
  '回 回家 / Home leave': 'H  Home leave',
  '请 请假 / Leave': 'L  Leave',
  '半 半天 / Half day': '½  Half day',
  '缺 缺席 / Absent': 'A  Absent',
  '离 离职 / Resigned': 'R  Resigned',

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
  '老师': 'Trainer',
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
  '日期': 'Date',
  '币种': 'Currency',
  '金额': 'Amount',
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
  '＋ 新增奖金 / 扣款': '+ Add bonus / deduction',
  '新增奖金 / 扣款': 'Add bonus / deduction',
  '编辑奖金 / 扣款': 'Edit bonus / deduction',
  '历史记录 · 只读': 'Historical record · Read only',
  'Google 已同步': 'Google synced',
  'Google 同步失败': 'Google sync failed',
  'Google 待同步': 'Google sync pending',
  'Supabase 已保存': 'Saved in Supabase',
  'Google 待同步；脚本写入并回执后，刷新即可看到“已同步”。': 'Google sync is pending. Refresh after the script writes and acknowledges the record.',
  '关闭提示': 'Dismiss notice',
  '同步 / 操作': 'Sync / actions',
  'Supabase 保存与 Google 写入状态分开显示；仅协议内新增记录可以编辑。': 'Supabase save and Google delivery are shown separately. Only records created under the sync protocol can be edited.',
  '先保存 Supabase，再由每分钟同步任务写入指定 Google 月份区块。': 'Save to Supabase first; the scheduled sync then writes the record to the selected Google monthly block.',
  '金额正负规则': 'Amount sign rule',
  '正数 = 奖金，负数 = 扣除；币种由所选工作簿固定，不能手动混用。': 'Positive = bonus; negative = deduction. Currency is fixed by the selected workbook.',
  '来源工作簿 / 范围': 'Source workbook / scope',
  '必填': 'Required',
  '固定': 'Fixed',
  '编辑时不可移动到另一份表': 'The source workbook cannot be changed while editing',
  '编辑时不可移动月份': 'The month cannot be changed while editing',
  '员工 ID': 'Employee ID',
  '输入或选择员工 ID': 'Enter or select an employee ID',
  '例如 50 或 -20': 'For example, 50 or -20',
  '说明奖金或扣除原因': 'Describe the reason for the bonus or deduction',
  '保存结果会明确分两步显示': 'The two save stages are shown separately',
  'Supabase 已保存 → Google 待同步 / 已同步': 'Saved in Supabase → Google pending / synced',
  '正在保存 Supabase…': 'Saving to Supabase…',
  '保存并进入同步队列': 'Save and queue for sync',
  '现场转居家': 'Onsite to remote',
  '居家越南 / 印尼 / 缅甸': 'Remote Vietnam / Indonesia / Myanmar',
  '居家菲律宾': 'Remote Philippines',
  '将记录为奖金': 'Will be recorded as a bonus',
  '将记录为扣除': 'Will be recorded as a deduction',
  '不能填写 0': 'Amount cannot be zero',
  '保存时会再次核对员工与管理范围': 'Employee identity and access scope are checked again when saving',

  '团队统计表': 'Team statistics',
  '普通岗位显示人数；出款 / 彩金 / 客服 / 查单显示人数 + 截至今天最近 7 天的实际工作日均处理。': 'Regular positions show headcount. Payout, bonus, customer service and order lookup also show the average handled per active day over the last 7 days through today.',
  '最近7天员工处理明细 · 红 / 橙 / 黄 = 当天倒数前三个正数': 'Last 7 days by employee · red / orange / yellow = the three lowest positive values that day',

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
  '效率数据暂时不可用': 'Efficiency data is temporarily unavailable',
  '保存失败': 'Save failed',
  '删除失败': 'Delete failed',
  '导入失败': 'Import failed',
  '发布失败': 'Publish failed',
  '读取失败': 'Load failed',
  '上传失败': 'Upload failed',
  '培训': 'Trainer',
  '课程': 'Course',
  '人员': 'People',
  '平台': 'Platform',
  '状态': 'Status',
  '原因': 'Reason',
  '今日工作': 'Today\'s work',
  '工作表现': 'Performance',
  '发现问题': 'Issues found',
  '后续安排': 'Follow-up',
  '数据': 'Metrics',
  '提交于': 'Submitted',
  '当前累计范围': 'Current cumulative range',
  'Supabase 最近同步': 'Latest Supabase sync',
  '编辑选项读取失败': 'Unable to load editor options',
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
  match = source.match(/^([\d,]+)\s*(人|名员工|名组员|名培训员工|份日报|份报告|个记录日|条记录|条|张|行|个批次|个团队|个岗位|天|笔|次|分)$/)
  if (match) {
    const units = {
      '人':'people','名员工':'employees','名组员':'trainees','名培训员工':'trainees',
      '份日报':'reports','份报告':'reports','个记录日':'recorded days','条记录':'records',
      '条':'records','张':'images','行':'rows','个批次':'batches','个团队':'teams','个岗位':'positions',
      '天':'days','笔':'records','次':'times','分':'points',
    }
    return `${match[1]} ${units[match[2]]}`
  }
  match = source.match(/^筛选后\s*([\d,]+)\s*人$/)
  if (match) return `${match[1]} people after filtering`
  match = source.match(/^当前仅显示在职员工\s*·\s*共\s*([\d,]+)\s*人$/)
  if (match) return `Active employees only · ${match[1]} people`
  match = source.match(/^累计错误\s*([\d,]+)\s*笔$/)
  if (match) return `${match[1]} total errors`
  match = source.match(/^资料(?:待完善|待补充)\s*([\d,]+)\s*项$/)
  if (match) return `${match[1]} profile items incomplete`
  match = source.match(/^已关联\s*([\d,]+)\s*名组员$/)
  if (match) return `Linked to ${match[1]} trainees`
  match = source.match(/^共\s*([\d,]+)\s*份日报（含零日报人员）$/)
  if (match) return `${match[1]} reports (including people with no reports)`
  match = source.match(/^([\d,]+)\s*名培训人员\s*·\s*共\s*([\d,]+)\s*份日报$/)
  if (match) return `${match[1]} trainers · ${match[2]} reports`
  match = source.match(/^日报\s*([\d,]+)\s*·\s*有记录\s*([\d,]+)\s*·\s*未记录\s*([\d,]+)$/)
  if (match) return `Reports ${match[1]} · recorded ${match[2]} · missing ${match[3]}`
  match = source.match(/^(正常|公休|请假|缺席|回家)\s*([\d,]+)$/)
  if (match) return `${english[match[1]] || match[1]} ${match[2]}`
  match = source.match(/^筛选结果\s*([\d,]+)\s*\/\s*([\d,]+)\s*条\s*·\s*第\s*([\d,]+)\s*\/\s*([\d,]+)\s*页$/)
  if (match) return `${match[1]} / ${match[2]} records · page ${match[3]} / ${match[4]}`
  match = source.match(/^([\d,]+)\s*人\s*·\s*在职\/试用\s*([\d,]+)\s*·\s*停用\s*([\d,]+)\s*·\s*离职\s*([\d,]+)\s*·\s*未匹配\s*([\d,]+)$/)
  if (match) return `${match[1]} people · active/probation ${match[2]} · disabled ${match[3]} · resigned ${match[4]} · unmatched ${match[5]}`
  match = source.match(/^共\s*([\d,]+)\s*行；发布前先写入“待发布”批次。$/)
  if (match) return `${match[1]} rows. They are saved to a Pending publication batch before publishing.`
  match = source.match(/^(当前累计范围)：(.+)$/)
  if (match) return `Current cumulative range: ${match[2]}`
  match = source.match(/^最近读取\s*(.+)\s*·\s*切回页面按需刷新$/)
  if (match) return `Last loaded ${match[1]} · refreshes when returning to the page if needed`
  match = source.match(/^(.+)\s*员工名单$/)
  if (match) return `${match[1]} employee roster`
  match = source.match(/^(.+)\s*·\s*(当前在职员工|近30天离职人员)$/)
  if (match) return `${match[1]} · ${match[2] === '当前在职员工' ? 'current active employees' : 'employees resigned in 30 days'}`
  match = source.match(/^下属\s*([\d,]+)\s*人$/)
  if (match) return `${match[1]} direct reports`
  match = source.match(/^平均\s*([\d,.]+)\s*单\/天$/)
  if (match) return `${match[1]} orders/day on average`
  match = source.match(/^([\d,]+)年\s*([\d,]+)个月\s*([\d,]+)天\s*·\s*共\s*([\d,]+)\s*天$/)
  if (match) return `${match[1]}y ${match[2]}m ${match[3]}d · ${match[4]} days total`
  match = source.match(/^([\d,]+)小时(?:\s*([\d,]+)分钟)?$/)
  if (match) return `${match[1]}h${match[2] ? ` ${match[2]}m` : ''}`
  match = source.match(/^([\d,]+)分钟$/)
  if (match) return `${match[1]}m`
  match = source.match(/^([\d]{4})年([\d]{2})月出勤表$/)
  if (match) return `Attendance · ${match[1]}-${match[2]}`
  match = source.match(/^([\d,]+)日状态人数$/)
  if (match) return `Status headcount · day ${match[1]}`
  match = source.match(/^(状态|本月合计)\s*([\d,]+)\s*天$/)
  if (match) return `${match[1] === '状态' ? 'Status' : 'Monthly total'} ${match[2]} days`

  // Translate only a known UI label before a delimiter. The value after it is
  // deliberately preserved so names, teams and other business data stay intact.
  match = source.match(/^([^:：]+)([:：])\s*(.+)$/)
  if (match && prefixEnglish[match[1].trim()]) {
    return `${prefixEnglish[match[1].trim()]}${match[2]} ${match[3]}`
  }
  return source
}

function translateAdminText(source, element) {
  if (typeof source !== 'string' || !source) return source
  const leading = source.match(/^\s*/)?.[0] || ''
  const trailing = source.match(/\s*$/)?.[0] || ''
  if (leading.length + trailing.length >= source.length) return source
  const core = source.slice(leading.length, source.length - trailing.length)
  // “关闭” means Off in status fields, but Close on dialog/action buttons.
  const translated = core === '关闭' && element?.matches?.('button, [role="button"]')
    ? 'Close'
    : translateAdminCore(core)
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
      const translated = translateAdminText(current, node.parentElement)
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
      const translated = translateAdminText(current, element)
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
