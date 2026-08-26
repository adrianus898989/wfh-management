export const PAYROLL_CURRENCY_OPTIONS=Object.freeze([
  Object.freeze({code:'PHP',label:'菲律宾披索'}),
  Object.freeze({code:'USD',label:'美金'}),
  Object.freeze({code:'CNY',label:'人民币'}),
  Object.freeze({code:'VND',label:'越南盾'}),
  Object.freeze({code:'IDR',label:'印尼盾'}),
])

const LABEL_BY_CODE=new Map(PAYROLL_CURRENCY_OPTIONS.map(option=>[option.code,option.label]))

export function payrollCurrencyLabel(value){
  const code=String(value||'').trim().toUpperCase()
  return LABEL_BY_CODE.get(code)||code||'—'
}
