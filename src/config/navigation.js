import { PERMISSIONS } from './permissions'

const enc = value => encodeURIComponent(value)

export const adminNavigation = [
  { to: '/admin', label: '首页', icon: '⌂', permissions: [PERMISSIONS.DASHBOARD_VIEW] },
  {
    to: '/admin/employees', label: '员工管理', icon: '人', children: [
      { label: '员工档案', to: `/admin/employees?tab=${enc('员工档案')}`, permissions: [PERMISSIONS.EMPLOYEE_VIEW] },
      { label: '人员分析', to: `/admin/employees?tab=${enc('人员分析')}`, permissions: [PERMISSIONS.EMPLOYEE_ANALYTICS_VIEW] },
      { label: '停电 / 断网记录', to: `/admin/employees?tab=${enc('停电 / 断网记录')}`, permissions: [PERMISSIONS.CONNECTIVITY_VIEW] },
      { label: '离职记录', to: `/admin/employees?tab=${enc('离职记录')}`, permissions: [PERMISSIONS.EMPLOYEE_VIEW] },
      { label: '操作日志', to: `/admin/employees?tab=${enc('操作日志')}`, permissions: [PERMISSIONS.AUDIT_VIEW] },
    ],
  },
  {
    to: '/admin/reports', label: '统计报表', icon: '报', children: [
      { label: '总汇', to: `/admin/reports?tab=${enc('总汇')}`, permissions: [PERMISSIONS.REPORT_VIEW] },
      { label: '人员', to: `/admin/reports?tab=${enc('人员')}`, permissions: [PERMISSIONS.REPORT_VIEW] },
      { label: '排班表', to: `/admin/reports?tab=${enc('排班表')}`, permissions: [PERMISSIONS.REPORT_VIEW] },
      { label: '盘口人数', to: `/admin/reports?tab=${enc('盘口人数')}`, permissions: [PERMISSIONS.REPORT_VIEW] },
      { label: '统计', to: `/admin/reports?tab=${enc('统计')}`, permissions: [PERMISSIONS.REPORT_VIEW] },
      { label: '错误统计', to: `/admin/reports?tab=${enc('错误统计')}`, permissions: [PERMISSIONS.REPORT_VIEW] },
    ],
  },
  {
    to: '/admin/schedule', label: '排班与考勤', icon: '班', children: [
      { label: '排班表', to: `/admin/schedule?tab=${enc('排班表')}`, permissions: [PERMISSIONS.SCHEDULE_VIEW] },
      { label: '出勤表', to: `/admin/schedule?tab=${enc('出勤表')}`, permissions: [PERMISSIONS.ATTENDANCE_VIEW] },
      { label: '今日考勤', to: `/admin/schedule?tab=${enc('今日考勤')}`, permissions: [PERMISSIONS.ATTENDANCE_VIEW] },
      { label: '考勤记录', to: `/admin/schedule?tab=${enc('考勤记录')}`, permissions: [PERMISSIONS.ATTENDANCE_VIEW] },
      { label: '请假审批', to: `/admin/schedule?tab=${enc('请假审批')}`, allPermissions: [PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.LEAVE_APPROVE] },
      { label: '奖金 / 扣款', to: `/admin/schedule?tab=${enc('奖金 / 扣款')}`, permissions: [PERMISSIONS.ADJUSTMENT_VIEW] },
    ],
  },
  {
    to: '/admin/daily', label: '每日工作', icon: '日', children: [
      { label: '线上培训报告', to: '/admin/daily', permissions: [PERMISSIONS.ONLINE_TRAINING_VIEW, PERMISSIONS.ONLINE_TRAINING_SUBMIT, PERMISSIONS.ONLINE_TRAINING_REVIEW, PERMISSIONS.ONLINE_TRAINING_MANAGE] },
    ],
  },
  {
    to: '/admin/training', label: '考试管理', icon: '考', children: [
      { label: '考试概览', to: `/admin/training?tab=${enc('考试概览')}`, permissions: [PERMISSIONS.EXAM_VIEW] },
      { label: '考试记录', to: `/admin/training?tab=${enc('考试记录')}`, permissions: [PERMISSIONS.EXAM_VIEW] },
      { label: '题库', to: `/admin/training?tab=${enc('题库')}`, allPermissions: [PERMISSIONS.EXAM_VIEW, PERMISSIONS.EXAM_MANAGE] },
      { label: '人工批改', to: `/admin/training?tab=${enc('人工批改')}`, allPermissions: [PERMISSIONS.EXAM_VIEW, PERMISSIONS.EXAM_GRADE] },
    ],
  },
  {
    to: '/admin/payroll', label: '工资中心', icon: '薪', children: [
      { label: '工资导入', to: `/admin/payroll?tab=${enc('工资导入')}`, allPermissions: [PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.PAYROLL_EDIT] },
      { label: '待发布', to: `/admin/payroll?tab=${enc('待发布')}`, allPermissions: [PERMISSIONS.PAYROLL_VIEW], permissions: [PERMISSIONS.PAYROLL_APPROVE, PERMISSIONS.PAYROLL_PUBLISH] },
      { label: '已发布', to: `/admin/payroll?tab=${enc('已发布')}`, permissions: [PERMISSIONS.PAYROLL_VIEW] },
      { label: '导入记录', to: `/admin/payroll?tab=${enc('导入记录')}`, permissions: [PERMISSIONS.PAYROLL_VIEW] },
    ],
  },
  {
    to: '/admin/users', label: '用户与权限', icon: '权', children: [
      { label: '后台账号', to: '/admin/users?tab=backend', permissions: [PERMISSIONS.USER_VIEW, PERMISSIONS.ACCOUNT_VIEW, PERMISSIONS.ACCOUNT_CREATE, PERMISSIONS.ACCOUNT_EDIT, PERMISSIONS.ACCOUNT_DISABLE, PERMISSIONS.ACCOUNT_DELETE, PERMISSIONS.ACCOUNT_RESET_PASSWORD, PERMISSIONS.ACCOUNT_OTP_TOGGLE, PERMISSIONS.ACCOUNT_MFA_RESET] },
      { label: '员工账号', to: '/admin/users?tab=staff', permissions: [PERMISSIONS.USER_VIEW, PERMISSIONS.USER_ACCOUNT_CREATE, PERMISSIONS.USER_ACCOUNT_DISABLE, PERMISSIONS.USER_ACCOUNT_DELETE, PERMISSIONS.USER_PASSWORD_RESET, PERMISSIONS.ACCOUNT_MFA_RESET] },
      { label: '角色与权限', to: '/admin/users?tab=roles', permissions: [PERMISSIONS.ROLE_MANAGE] },
    ],
  },
]

export const staffNavigation = [
  { to: '/staff', key: 'nav.home', label: '首页' },
  { to: '/staff/exams', key: 'nav.exams', label: '我的考试' },
]
