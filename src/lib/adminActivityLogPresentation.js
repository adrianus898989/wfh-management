const clean=value=>String(value??'').trim()

export const ACTIVITY_LOG_MODULE_OPTIONS=Object.freeze([
  ['', '全部模块'],
  ['access_control','账号与权限'],
  ['auth','登录认证'],
  ['employee','员工档案'],
  ['payroll','工资'],
  ['adjustment','奖金 / 扣款'],
  ['attendance','考勤'],
  ['online_training','线上培训'],
  ['exam','考试'],
  ['alerts','预警中心'],
  ['connectivity','停电 / 断网'],
  ['user_account','员工账号'],
])

export const ACTIVITY_LOG_ACTION_OPTIONS=Object.freeze([
  ['', '全部动作'],
  ['create','新增 / 导入 / 提交'],
  ['update','编辑 / 审批 / 发布'],
  ['delete','删除 / 归档 / 撤销'],
  ['auth','登录认证'],
  ['other','其他动作'],
])

const MODULE_LABELS=Object.freeze(Object.fromEntries(ACTIVITY_LOG_MODULE_OPTIONS.filter(([value])=>value)))
const CATEGORY_LABELS=Object.freeze(Object.fromEntries(ACTIVITY_LOG_ACTION_OPTIONS.filter(([value])=>value)))
const SOURCE_LABELS=Object.freeze({
  audit_logs:'通用业务审计',
  employee_audit_logs:'员工档案审计',
  payroll_audit_log:'工资审计',
  employee_attendance_records:'考勤 / 奖惩记录补位',
})
const ACTION_LABELS=Object.freeze({
  account_delete:'删除后台登录账号',activation_code_generate:'生成激活码',
  admin_ip_allowlist_create:'新增 IP 白名单',admin_ip_allowlist_update:'编辑 IP 白名单',
  admin_ip_allowlist_set_enforced:'切换 IP 白名单',backend_account_create:'新增后台账号',
  backend_account_update:'编辑后台账号',backend_account_scope_correction:'修正账号范围',
  password_reset:'重置密码',role_permissions_update:'编辑角色权限',staff_account_create:'新增员工账号',
  admin_login:'后台登录',staff_login:'员工端登录',delete_incident:'删除停电 / 断网记录',
  delete_current_session:'删除考试记录',archive:'归档删除',create:'新增',review:'复核',
  reject_payout_change:'驳回收款资料修改',submit_payout_change:'提交收款资料修改',
  employee_self_register:'员工自助注册',cancel_hire:'撤销新增员工',reactivate:'恢复在职',
  resign:'办理离职',edit_resignation:'编辑离职资料',google_employee_create:'Google 表新增员工',
  google_employee_id_edit:'Google 表修改员工 ID',google_profile_sync:'Google 表同步档案',
  attendance_resignation_identity_repair:'修复考勤离职身份',import:'导入工资',publish:'发布工资',
  delete:'删除工资批次',manual_create:'人工录入',manual_update:'人工修改',
})

export const activityModuleLabel=value=>MODULE_LABELS[clean(value)]||clean(value)||'未分类模块'
export const activityCategoryLabel=value=>CATEGORY_LABELS[clean(value)]||clean(value)||'其他动作'
export const activitySourceLabel=value=>SOURCE_LABELS[clean(value)]||clean(value)||'未知来源'
export const activityActionLabel=(action,category)=>ACTION_LABELS[clean(action)]||activityCategoryLabel(category)

export function buildActivityLogRpcParams(filters={},page=1,pageSize=20){
  const nullable=value=>clean(value)||null
  return {
    p_date_from:nullable(filters.dateFrom),
    p_date_to:nullable(filters.dateTo),
    p_actor:nullable(filters.actor),
    p_module:nullable(filters.module),
    p_action:nullable(filters.action),
    p_object:nullable(filters.object),
    p_page:Math.max(1,Number(page)||1),
    p_page_size:[20,50,100].includes(Number(pageSize))?Number(pageSize):20,
  }
}

export function formatActivityTime(value){
  const date=new Date(value)
  if(Number.isNaN(date.getTime()))return '—'
  return new Intl.DateTimeFormat('zh-CN',{
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,
  }).format(date)
}
