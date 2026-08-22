import {
  LayoutDashboard, Users, CalendarDays, ClipboardList,
  GraduationCap, WalletCards, BarChart3, Settings,
  UserRound, BookOpenCheck, FileText
} from 'lucide-react'
import { PERMISSIONS } from './permissions'

export const adminNavigation = [
  { label: '控制台', icon: LayoutDashboard, path: '/admin' },
  {
    label: '人员与团队', icon: Users,
    children: [
      { label: '在职员工', path: '/admin/employees', permission: PERMISSIONS.EMPLOYEE_VIEW },
      { label: '新增 / 异动', path: '/admin/employee-changes', permission: PERMISSIONS.EMPLOYEE_CREATE },
      { label: '团队管理', path: '/admin/teams', permission: PERMISSIONS.TEAM_VIEW },
      { label: '离职员工库', path: '/admin/resigned', permission: PERMISSIONS.EMPLOYEE_VIEW }
    ]
  },
  {
    label: '排班与考勤', icon: CalendarDays,
    children: [
      { label: '排班总览', path: '/admin/schedule', permission: PERMISSIONS.SCHEDULE_VIEW },
      { label: '考勤记录', path: '/admin/attendance', permission: PERMISSIONS.ATTENDANCE_VIEW },
      { label: '请假 / 公休 / 回家 / 换班', path: '/admin/leave', permission: PERMISSIONS.LEAVE_APPROVE },
      { label: '轮班规则', path: '/admin/rotation', permission: PERMISSIONS.SCHEDULE_EDIT }
    ]
  },
  {
    label: '每日工作', icon: ClipboardList,
    children: [
      { label: '组长日报', path: '/admin/leader-reports', permission: PERMISSIONS.REPORT_VIEW },
      { label: '培训日报', path: '/admin/trainer-reports', permission: PERMISSIONS.REPORT_VIEW },
      { label: '问题 / 交接', path: '/admin/issues', permission: PERMISSIONS.REPORT_VIEW },
      { label: '出错 / 扣款 / 奖金', path: '/admin/adjustments', permission: PERMISSIONS.ADJUSTMENT_CREATE }
    ]
  },
  {
    label: '考试管理', icon: GraduationCap,
    children: [
      { label: '考试总览', path: '/admin/exams', permission: PERMISSIONS.EXAM_VIEW },
      { label: '题库同步', path: '/admin/question-bank', permission: PERMISSIONS.EXAM_MANAGE },
      { label: '批改 / 成绩', path: '/admin/grading', permission: PERMISSIONS.EXAM_GRADE }
    ]
  },
  {
    label: '工资中心', icon: WalletCards,
    children: [
      { label: '工资规则 / 配置', path: '/admin/payroll-rules', permission: PERMISSIONS.PAYROLL_RULE_EDIT },
      { label: '月度工资', path: '/admin/payroll', permission: PERMISSIONS.PAYROLL_VIEW },
      { label: '审核 / 发布', path: '/admin/payroll-publish', permission: PERMISSIONS.PAYROLL_APPROVE },
      { label: '导出 / 修改记录', path: '/admin/payroll-history', permission: PERMISSIONS.PAYROLL_EXPORT }
    ]
  },
  {
    label: '统计报表', icon: BarChart3,
    children: [
      { label: '团队 / 人员统计', path: '/admin/reports/teams', permission: PERMISSIONS.TEAM_VIEW },
      { label: '离职率 / 人员异动', path: '/admin/reports/turnover', permission: PERMISSIONS.EMPLOYEE_VIEW },
      { label: '考勤 / 工作量 / 出错', path: '/admin/reports/operations', permission: PERMISSIONS.ATTENDANCE_VIEW },
      { label: '工资统计', path: '/admin/reports/payroll', permission: PERMISSIONS.PAYROLL_VIEW }
    ]
  },
  {
    label: '系统管理', icon: Settings,
    children: [
      { label: '用户与权限 / OTP', path: '/admin/users', permission: PERMISSIONS.USER_VIEW },
      { label: '收款资料修改审核', path: '/admin/payout-approvals', permission: PERMISSIONS.SENSITIVE_PAYOUT_APPROVE },
      { label: '操作日志', path: '/admin/audit', permission: PERMISSIONS.AUDIT_VIEW },
      { label: '帮助中心 / 教程', path: '/admin/help' },
      { label: '系统设置', path: '/admin/settings', permission: PERMISSIONS.USER_MANAGE }
    ]
  }
]

export const staffNavigation = [
  { label: '首页', icon: LayoutDashboard, path: '/staff' },
  { label: '我的排班 / 出勤', icon: CalendarDays, path: '/staff/schedule' },
  { label: '我的工资', icon: WalletCards, path: '/staff/payroll' },
  { label: '我的考试', icon: BookOpenCheck, path: '/staff/exams' },
  { label: '我的申请', icon: FileText, path: '/staff/requests' },
  { label: '我的资料', icon: UserRound, path: '/staff/profile' }
]
