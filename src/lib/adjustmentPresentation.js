const text = value => String(value ?? '').trim()

// Google 表格的「类型」进入 reason/category，「备注」才是业务原因。
// 旧记录没有独立类型时，仍按奖金 / 扣款给出可理解的回退值。
export const adjustmentCategory = row =>
  text(row?.category) || text(row?.raw_values?.category) || text(row?.reason) ||
  ({ bonus:'奖金', deduction:'扣款' }[text(row?.event_kind).toLowerCase()] || '未分类')

export const adjustmentReason = row => text(row?.note) || text(row?.reason) || '—'

export const adjustmentTitle = row =>
  text(row?.title) || text(row?.subject) || text(row?.raw_values?.category) || text(row?.reason) ||
  ({ bonus:'奖金记录', deduction:'扣款记录' }[text(row?.event_kind).toLowerCase()] || '奖惩记录')
