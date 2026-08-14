export function maskText(value, visibleStart = 4, visibleEnd = 4) {
  if (!value) return '-'
  const text = String(value)
  if (text.length <= visibleStart + visibleEnd) return '****'
  return `${text.slice(0, visibleStart)}****${text.slice(-visibleEnd)}`
}

export function maskPhone(value) {
  if (!value) return '-'
  const digits = String(value).replace(/\s+/g, '')
  if (digits.length < 7) return '****'
  return `${digits.slice(0, 4)}****${digits.slice(-3)}`
}

export function displayPayout(payout, canViewSensitive) {
  if (!payout) return '-'
  if (payout.method === 'USDT') {
    return canViewSensitive ? payout.address : maskText(payout.address, 5, 5)
  }
  return canViewSensitive
    ? payout.accountNumber
    : maskPhone(payout.accountNumber)
}
