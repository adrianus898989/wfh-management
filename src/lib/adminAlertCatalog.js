export const ADMIN_ALERT_PERMISSIONS = [
  'alert.view',
]

export const ADMIN_ALERT_GROUPS = {
  all: { zh:'全部预警', en:'All warnings' },
  account: { zh:'账号与合规', en:'Accounts & compliance' },
  attendance: { zh:'考勤与日报', en:'Attendance & reports' },
  quality: { zh:'质量与绩效', en:'Quality & performance' },
}

export const ADMIN_ALERT_TYPES = {
  payout_change: {
    zh:'收款资料修改', en:'Payment change', icon:'款', tone:'blue', group:'account',
    permissions:['alert.payout_change.view'], ready:true,
  },
  resigned_account_active: {
    zh:'离职账号未回收', en:'Unrecovered resigned account', icon:'账', tone:'red', group:'account',
    permissions:['alert.resigned_account_active.view'], ready:true,
  },
  today_missing_clock_in: {
    zh:'今日未打卡', en:'No clock-in today', icon:'卡', tone:'slate', group:'attendance',
    permissions:['alert.today_missing_clock_in.view'], ready:false,
    pendingZh:'当前 Supabase 只有考勤异常记录，没有员工打卡流水。',
    pendingEn:'Supabase has attendance exceptions, but no employee clock-in stream.',
  },
  today_missing_daily_report: {
    zh:'今日无日报', en:'No daily report today', icon:'日', tone:'slate', group:'attendance',
    permissions:['alert.today_missing_daily_report.view'], ready:false,
    pendingZh:'尚未定义每天必须提交日报的人员范围，且现有日报分属两套表。',
    pendingEn:'Expected daily submitters are undefined and reports currently use two sources.',
  },
  leave_activity: {
    zh:'休假人员操作', en:'Activity while on leave', icon:'假', tone:'slate', group:'attendance',
    permissions:['alert.leave_activity.view'], ready:false,
    pendingZh:'缺少可核验的员工级操作流水与后台账号归属映射。',
    pendingEn:'There is no verified employee-level activity stream and account ownership map.',
  },
  late_timeout_frequency: {
    zh:'迟到 / 超时', en:'Late / timeout', icon:'迟', tone:'orange', group:'attendance',
    permissions:['alert.late_timeout_frequency.view'], ready:true,
  },
  consecutive_rest: {
    zh:'连续公休', en:'Consecutive rest', icon:'休', tone:'violet', group:'attendance',
    permissions:['alert.consecutive_rest.view'], ready:true,
  },
  weekly_absence: {
    zh:'一周缺席', en:'Weekly absence', icon:'缺', tone:'red', group:'attendance',
    permissions:['alert.weekly_absence.view'], ready:true,
  },
  monthly_leave: {
    zh:'月休假超限', en:'Monthly leave limit', icon:'假', tone:'violet', group:'attendance',
    permissions:['alert.monthly_leave.view'], ready:true,
  },
  error_spike: {
    zh:'错误频率', en:'Error frequency', icon:'错', tone:'red', group:'quality',
    permissions:['alert.error_spike.view'], ready:true,
  },
  repeated_error: {
    zh:'重复错误', en:'Repeated errors', icon:'重', tone:'slate', group:'quality',
    permissions:['alert.repeated_error.view'], ready:false,
    pendingZh:'尚未确认“重复”的归一键、统计周期和触发次数。',
    pendingEn:'The repeat identity, time window, and trigger count are not yet defined.',
  },
  deduction_frequency: {
    zh:'扣款频率', en:'Deduction frequency', icon:'扣', tone:'orange', group:'quality',
    permissions:['alert.deduction_frequency.view'], ready:true,
  },
  exam_failed: {
    zh:'考试不及格', en:'Failed exam', icon:'考', tone:'red', group:'quality',
    permissions:['alert.exam_failed.view'], ready:true,
  },
  low_workload_streak: {
    zh:'连续工作量低', en:'Sustained low workload', icon:'量', tone:'slate', group:'quality',
    permissions:['alert.low_workload_streak.view'], ready:false,
    pendingZh:'尚未确认连续天数、最低工作量阈值和账号到员工的权威映射。',
    pendingEn:'The streak length, workload floor, and authoritative account ownership are undefined.',
  },
}

export function adminAlertHasPermission(access, code) {
  if (!access || access.loading || access.error) return false
  if (access.founder || access.permissions?.includes('*')) return true
  if (typeof access.hasPermission === 'function') return Boolean(access.hasPermission(code))
  return Boolean(access.permissions?.includes(code))
}

export function canViewAdminAlertType(access, type) {
  const meta = ADMIN_ALERT_TYPES[type]
  return Boolean(meta && adminAlertHasPermission(access, 'alert.view') && meta.permissions.some(code => adminAlertHasPermission(access, code)))
}

export function visibleAdminAlertTypes(access, { readyOnly=false, group='all' } = {}) {
  return Object.entries(ADMIN_ALERT_TYPES).filter(([type, meta]) => (
    canViewAdminAlertType(access, type)
    && (!readyOnly || meta.ready)
    && (group === 'all' || meta.group === group)
  ))
}

export function adminAlertPendingReason(meta, locale) {
  return locale === 'en' ? meta?.pendingEn : meta?.pendingZh
}
