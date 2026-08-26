const text = value => String(value ?? '').trim()

// Google 表格的「备注」列就是奖金 / 扣款的业务原因；reason 仅兼容旧记录。
export const adjustmentReason = row => text(row?.note) || text(row?.reason) || '—'
