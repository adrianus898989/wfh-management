export const ROLES = {
  FOUNDER: 'founder',
  SUPERVISOR: 'supervisor',
  SENIOR_TEAM_LEADER: 'senior_team_leader',
  TEAM_LEADER: 'team_leader',
  TRAINER: 'trainer',
  ASSISTANT: 'assistant',
  EMPLOYEE: 'employee'
}

export const ROLE_LABELS = {
  founder: 'Founder / 创办人',
  supervisor: '主管',
  senior_team_leader: '大组长',
  team_leader: '组长',
  trainer: '培训老师',
  assistant: '助理',
  employee: 'Employee / 员工'
}

export const DATA_SCOPES = {
  ALL: 'all',
  ASSIGNED_TEAMS: 'assigned_teams',
  OWN_TEAM: 'own_team',
  SELF: 'self'
}

export const DATA_SCOPE_LABELS = {
  all: '全部数据',
  assigned_teams: '指定团队',
  own_team: '自己团队',
  self: '仅本人'
}

export const PERMISSIONS = {
  // 员工资料
  EMPLOYEE_VIEW: 'employee.view',
  EMPLOYEE_CREATE: 'employee.create',
  EMPLOYEE_EDIT: 'employee.edit',
  EMPLOYEE_RESIGN: 'employee.resign',
  EMPLOYEE_REACTIVATE: 'employee.reactivate',
  EMPLOYEE_DELETE: 'employee.delete',
  EMPLOYEE_COMPENSATION_EDIT: 'employee.compensation.edit',
  CONNECTIVITY_VIEW: 'connectivity.view',
  CONNECTIVITY_CREATE: 'connectivity.create',
  CONNECTIVITY_EDIT: 'connectivity.edit',
  CONNECTIVITY_DELETE: 'connectivity.delete',

  // 团队
  TEAM_VIEW: 'team.view',
  TEAM_EDIT: 'team.edit',

  // 排班考勤
  SCHEDULE_VIEW: 'schedule.view',
  SCHEDULE_EDIT: 'schedule.edit',
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_EDIT: 'attendance.edit',
  LEAVE_APPROVE: 'leave.approve',

  // 每日工作
  REPORT_VIEW: 'report.view',
  REPORT_EDIT: 'report.edit',
  DAILY_WORK_SUBMIT: 'daily_work.submit',
  DAILY_WORK_MANAGE: 'daily_work.manage',
  ONLINE_TRAINING_VIEW: 'online_training.view',
  ONLINE_TRAINING_SUBMIT: 'online_training.submit',
  ONLINE_TRAINING_REVIEW: 'online_training.review',
  ONLINE_TRAINING_MANAGE: 'online_training.manage',
  ADJUSTMENT_VIEW: 'adjustment.view',
  ADJUSTMENT_CREATE: 'adjustment.create',
  ADJUSTMENT_APPROVE: 'adjustment.approve',

  // 考试
  EXAM_VIEW: 'exam.view',
  EXAM_MANAGE: 'exam.manage',
  EXAM_GRADE: 'exam.grade',
  EXAM_DELETE: 'exam.delete',

  // 工资
  PAYROLL_VIEW: 'payroll.view',
  PAYROLL_EDIT: 'payroll.edit',
  PAYROLL_APPROVE: 'payroll.approve',
  PAYROLL_PUBLISH: 'payroll.publish',
  PAYROLL_EXPORT: 'payroll.export',
  PAYROLL_RULE_EDIT: 'payroll.rule.edit',

  // 账号权限
  USER_VIEW: 'user.view',
  USER_MANAGE: 'user.manage',
  USER_DISABLE_EMPLOYEE: 'user.disable_employee',
  USER_ACTIVATION_GENERATE: 'user.activation.generate',
  USER_ACCOUNT_CREATE: 'user.account.create',
  USER_ACCOUNT_DISABLE: 'user.account.disable',
  USER_ACCOUNT_DELETE: 'user.account.delete',
  USER_EMAIL_CHANGE: 'user.email.change',
  USER_PASSWORD_RESET: 'user.password.reset',
  ACCOUNT_VIEW: 'account.view',
  ACCOUNT_CREATE: 'account.create',
  ACCOUNT_EDIT: 'account.edit',
  ACCOUNT_DISABLE: 'account.disable',
  ACCOUNT_DELETE: 'account.delete',
  ACCOUNT_RESET_PASSWORD: 'account.reset_password',
  ACCOUNT_OTP_TOGGLE: 'account.otp_toggle',
  ACCOUNT_MFA_RESET: 'account.mfa_reset',
  ROLE_MANAGE: 'role.manage',
  SCOPE_MANAGE: 'scope.manage',

  // 敏感资料
  SENSITIVE_EMPLOYEE_VIEW: 'sensitive.employee.view',
  SENSITIVE_EMPLOYEE_EDIT: 'sensitive.employee.edit',
  SENSITIVE_PAYMENT_VIEW: 'sensitive.payment.view',
  SENSITIVE_PAYMENT_EDIT: 'sensitive.payment.edit',
  SENSITIVE_PAYMENT_APPROVE: 'sensitive.payment.approve',
  SENSITIVE_PAYOUT_VIEW: 'sensitive.payout.view',
  SENSITIVE_PAYOUT_EDIT: 'sensitive.payout.edit',
  SENSITIVE_PAYOUT_APPROVE: 'sensitive.payout.approve',

  // 日志
  AUDIT_VIEW: 'audit.view',

  // 导出
  EXPORT_GENERAL: 'export.general'
}

const ALL_PERMISSIONS = Object.values(PERMISSIONS)

export const ROLE_TEMPLATES = {
  founder: {
    backendEnabled: true,
    employeePortalEnabled: true,
    dataScope: DATA_SCOPES.ALL,
    permissions: ALL_PERMISSIONS
  },

  supervisor: {
    backendEnabled: true,
    employeePortalEnabled: true,
    dataScope: DATA_SCOPES.ASSIGNED_TEAMS,
    permissions: [
      PERMISSIONS.EMPLOYEE_VIEW,
      PERMISSIONS.EMPLOYEE_EDIT,
      PERMISSIONS.CONNECTIVITY_VIEW,
      PERMISSIONS.CONNECTIVITY_CREATE,
      PERMISSIONS.CONNECTIVITY_EDIT,
      PERMISSIONS.TEAM_VIEW,
      PERMISSIONS.SCHEDULE_VIEW,
      PERMISSIONS.SCHEDULE_EDIT,
      PERMISSIONS.ATTENDANCE_VIEW,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.REPORT_VIEW,
      PERMISSIONS.DAILY_WORK_SUBMIT,
      PERMISSIONS.ONLINE_TRAINING_VIEW,
      PERMISSIONS.ONLINE_TRAINING_SUBMIT,
      PERMISSIONS.ONLINE_TRAINING_REVIEW,
      PERMISSIONS.ADJUSTMENT_VIEW,
      PERMISSIONS.ADJUSTMENT_CREATE,
      PERMISSIONS.EXAM_VIEW,
      PERMISSIONS.PAYROLL_VIEW,
      PERMISSIONS.USER_VIEW,
      PERMISSIONS.USER_DISABLE_EMPLOYEE,
      PERMISSIONS.USER_ACTIVATION_GENERATE,
      PERMISSIONS.USER_ACCOUNT_DISABLE,
      PERMISSIONS.USER_PASSWORD_RESET,
      PERMISSIONS.EXPORT_GENERAL
    ]
  },

  team_leader: {
    backendEnabled: true,
    employeePortalEnabled: true,
    dataScope: DATA_SCOPES.OWN_TEAM,
    permissions: [
      PERMISSIONS.EMPLOYEE_VIEW,
      PERMISSIONS.CONNECTIVITY_VIEW,
      PERMISSIONS.TEAM_VIEW,
      PERMISSIONS.SCHEDULE_VIEW,
      PERMISSIONS.ATTENDANCE_VIEW,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.REPORT_VIEW,
      PERMISSIONS.REPORT_EDIT,
      PERMISSIONS.DAILY_WORK_SUBMIT,
      PERMISSIONS.ONLINE_TRAINING_VIEW,
      PERMISSIONS.ONLINE_TRAINING_SUBMIT,
      PERMISSIONS.ONLINE_TRAINING_REVIEW,
      PERMISSIONS.ADJUSTMENT_VIEW,
      PERMISSIONS.ADJUSTMENT_CREATE,
      PERMISSIONS.USER_DISABLE_EMPLOYEE,
      PERMISSIONS.USER_ACTIVATION_GENERATE,
      PERMISSIONS.USER_ACCOUNT_DISABLE
    ]
  },

  senior_team_leader: {
    backendEnabled: true,
    employeePortalEnabled: true,
    dataScope: DATA_SCOPES.ASSIGNED_TEAMS,
    permissions: [
      PERMISSIONS.EMPLOYEE_VIEW,
      PERMISSIONS.CONNECTIVITY_VIEW,
      PERMISSIONS.TEAM_VIEW,
      PERMISSIONS.SCHEDULE_VIEW,
      PERMISSIONS.ATTENDANCE_VIEW,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.REPORT_VIEW,
      PERMISSIONS.DAILY_WORK_SUBMIT,
      PERMISSIONS.ONLINE_TRAINING_VIEW,
      PERMISSIONS.ONLINE_TRAINING_SUBMIT,
      PERMISSIONS.ONLINE_TRAINING_REVIEW,
      PERMISSIONS.ADJUSTMENT_VIEW,
      PERMISSIONS.ADJUSTMENT_CREATE,
      PERMISSIONS.USER_DISABLE_EMPLOYEE
    ]
  },

  trainer: {
    backendEnabled: true,
    employeePortalEnabled: true,
    dataScope: DATA_SCOPES.ASSIGNED_TEAMS,
    permissions: [
      PERMISSIONS.EMPLOYEE_VIEW,
      PERMISSIONS.CONNECTIVITY_VIEW,
      PERMISSIONS.REPORT_VIEW,
      PERMISSIONS.REPORT_EDIT,
      PERMISSIONS.DAILY_WORK_SUBMIT,
      PERMISSIONS.ONLINE_TRAINING_VIEW,
      PERMISSIONS.ONLINE_TRAINING_SUBMIT,
      PERMISSIONS.EXAM_VIEW,
      PERMISSIONS.EXAM_MANAGE,
      PERMISSIONS.EXAM_GRADE
    ]
  },

  assistant: {
    backendEnabled: true,
    employeePortalEnabled: true,
    dataScope: DATA_SCOPES.ASSIGNED_TEAMS,
    permissions: [
      PERMISSIONS.EMPLOYEE_VIEW,
      PERMISSIONS.EMPLOYEE_CREATE,
      PERMISSIONS.EMPLOYEE_EDIT,
      PERMISSIONS.EMPLOYEE_RESIGN,
      PERMISSIONS.CONNECTIVITY_VIEW,
      PERMISSIONS.CONNECTIVITY_CREATE,
      PERMISSIONS.CONNECTIVITY_EDIT,
      PERMISSIONS.TEAM_VIEW,
      PERMISSIONS.SCHEDULE_VIEW,
      PERMISSIONS.ATTENDANCE_VIEW,
      PERMISSIONS.ATTENDANCE_EDIT,
      PERMISSIONS.ADJUSTMENT_VIEW,
      PERMISSIONS.ADJUSTMENT_CREATE,
      PERMISSIONS.PAYROLL_VIEW,
      PERMISSIONS.SENSITIVE_PAYOUT_APPROVE,
      PERMISSIONS.EXPORT_GENERAL
    ]
  },

  employee: {
    backendEnabled: false,
    employeePortalEnabled: true,
    dataScope: DATA_SCOPES.SELF,
    permissions: []
  }
}

export const PERMISSION_GROUPS = [
  {
    title: '员工与团队',
    items: [
      [PERMISSIONS.EMPLOYEE_VIEW, '查看员工'],
      [PERMISSIONS.EMPLOYEE_CREATE, '新增员工'],
      [PERMISSIONS.EMPLOYEE_EDIT, '编辑员工'],
      [PERMISSIONS.EMPLOYEE_RESIGN, '办理离职'],
      [PERMISSIONS.EMPLOYEE_REACTIVATE, '重新启用员工'],
      [PERMISSIONS.EMPLOYEE_DELETE, '撤销新增员工档案'],
      [PERMISSIONS.EMPLOYEE_COMPENSATION_EDIT, '编辑员工工资设置'],
      [PERMISSIONS.CONNECTIVITY_VIEW, '查看范围内停电 / 断网记录'],
      [PERMISSIONS.CONNECTIVITY_CREATE, '录入范围内停电 / 断网记录'],
      [PERMISSIONS.CONNECTIVITY_EDIT, '编辑范围内停电 / 断网记录'],
      [PERMISSIONS.CONNECTIVITY_DELETE, '删除范围内停电 / 断网记录'],
      [PERMISSIONS.TEAM_VIEW, '查看团队'],
      [PERMISSIONS.TEAM_EDIT, '编辑团队']
    ]
  },
  {
    title: '排班与考勤',
    items: [
      [PERMISSIONS.SCHEDULE_VIEW, '查看排班'],
      [PERMISSIONS.SCHEDULE_EDIT, '编辑排班'],
      [PERMISSIONS.ATTENDANCE_VIEW, '查看考勤'],
      [PERMISSIONS.ATTENDANCE_EDIT, '编辑考勤'],
      [PERMISSIONS.LEAVE_APPROVE, '审批请假/回家/换班']
    ]
  },
  {
    title: '每日工作 / 出错 / 奖金',
    items: [
      [PERMISSIONS.REPORT_VIEW, '查看日报'],
      [PERMISSIONS.REPORT_EDIT, '填写/编辑日报'],
      [PERMISSIONS.DAILY_WORK_SUBMIT, '提交每日工作'],
      [PERMISSIONS.DAILY_WORK_MANAGE, '管理全部每日工作'],
      [PERMISSIONS.ONLINE_TRAINING_VIEW, '查看范围内线上培训日报'],
      [PERMISSIONS.ONLINE_TRAINING_SUBMIT, '提交线上培训日报'],
      [PERMISSIONS.ONLINE_TRAINING_REVIEW, '批注线上培训日报'],
      [PERMISSIONS.ONLINE_TRAINING_MANAGE, '管理全部线上培训日报'],
      [PERMISSIONS.ADJUSTMENT_VIEW, '查看出错 / 扣款 / 奖金'],
      [PERMISSIONS.ADJUSTMENT_CREATE, '录入出错/扣款/奖金'],
      [PERMISSIONS.ADJUSTMENT_APPROVE, '审核出错/扣款/奖金']
    ]
  },
  {
    title: '考试管理',
    items: [
      [PERMISSIONS.EXAM_VIEW, '查看考试'],
      [PERMISSIONS.EXAM_MANAGE, '创建/分配考试'],
      [PERMISSIONS.EXAM_GRADE, '人工批改'],
      [PERMISSIONS.EXAM_DELETE, '删除本系统考试记录']
    ]
  },
  {
    title: '工资中心',
    items: [
      [PERMISSIONS.PAYROLL_VIEW, '查看工资'],
      [PERMISSIONS.PAYROLL_EDIT, '修改工资'],
      [PERMISSIONS.PAYROLL_APPROVE, '审核工资'],
      [PERMISSIONS.PAYROLL_PUBLISH, '发布工资'],
      [PERMISSIONS.PAYROLL_EXPORT, '导出工资'],
      [PERMISSIONS.PAYROLL_RULE_EDIT, '修改工资规则/阈值']
    ]
  },
  {
    title: '账号与敏感资料',
    items: [
      [PERMISSIONS.USER_VIEW, '查看账号'],
      [PERMISSIONS.USER_MANAGE, '创建/修改后台账号'],
      [PERMISSIONS.USER_DISABLE_EMPLOYEE, '停用员工前端账号'],
      [PERMISSIONS.USER_ACTIVATION_GENERATE, '生成 / 重置员工激活码'],
      [PERMISSIONS.USER_ACCOUNT_CREATE, '创建员工前端账号'],
      [PERMISSIONS.USER_ACCOUNT_DISABLE, '停用 / 启用员工账号'],
      [PERMISSIONS.USER_ACCOUNT_DELETE, '删除员工登录账号'],
      [PERMISSIONS.USER_EMAIL_CHANGE, '修改员工登录邮箱'],
      [PERMISSIONS.USER_PASSWORD_RESET, '重置员工登录密码'],
      [PERMISSIONS.ACCOUNT_VIEW, '查看后台账号'],
      [PERMISSIONS.ACCOUNT_CREATE, '创建后台账号'],
      [PERMISSIONS.ACCOUNT_EDIT, '编辑后台账号'],
      [PERMISSIONS.ACCOUNT_DISABLE, '停用 / 启用后台账号'],
      [PERMISSIONS.ACCOUNT_DELETE, '删除后台登录账号'],
      [PERMISSIONS.ACCOUNT_RESET_PASSWORD, '重置后台账号密码'],
      [PERMISSIONS.ACCOUNT_OTP_TOGGLE, '开启 / 关闭登录 OTP'],
      [PERMISSIONS.ACCOUNT_MFA_RESET, '重置 Google OTP'],
      [PERMISSIONS.ROLE_MANAGE, '管理角色与权限'],
      [PERMISSIONS.SCOPE_MANAGE, '管理账号数据范围'],
      [PERMISSIONS.SENSITIVE_EMPLOYEE_VIEW, '查看员工敏感资料'],
      [PERMISSIONS.SENSITIVE_EMPLOYEE_EDIT, '编辑员工敏感资料'],
      [PERMISSIONS.SENSITIVE_PAYMENT_VIEW, '查看完整收款敏感资料'],
      [PERMISSIONS.SENSITIVE_PAYMENT_EDIT, '修改收款敏感资料'],
      [PERMISSIONS.SENSITIVE_PAYMENT_APPROVE, '审批收款敏感资料修改'],
      [PERMISSIONS.SENSITIVE_PAYOUT_VIEW, '查看完整收款资料'],
      [PERMISSIONS.SENSITIVE_PAYOUT_EDIT, '修改收款资料'],
      [PERMISSIONS.SENSITIVE_PAYOUT_APPROVE, '审核收款资料修改'],
      [PERMISSIONS.AUDIT_VIEW, '查看操作日志']
    ]
  }
]

export function hasPermission(user, permission) {
  if (!user) return false
  if (user.role === ROLES.FOUNDER) return true
  return Boolean(user.permissions?.includes(permission))
}

export function canAccessBackend(user) {
  if (!user) return false
  return user.backendEnabled === true && user.role !== ROLES.EMPLOYEE
}

export function canAccessEmployeePortal(user) {
  return Boolean(user?.employeePortalEnabled)
}
