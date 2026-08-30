const clean=value=>String(value??'').trim()

export const PAYROLL_POPULATION_OPTIONS=Object.freeze([
  Object.freeze({code:'pure_remote',label:'纯居家'}),
  Object.freeze({code:'onsite_to_home',label:'现场转居家'}),
])

export const PAYROLL_PAY_CYCLE_OPTIONS=Object.freeze([
  Object.freeze({code:'monthly',label:'整月'}),
  Object.freeze({code:'first_half',label:'上半月（1–15日）'}),
  Object.freeze({code:'second_half',label:'下半月（16日–月底）'}),
])

const POPULATION_CODES=new Set(PAYROLL_POPULATION_OPTIONS.map(option=>option.code))
const PAY_CYCLE_CODES=new Set(PAYROLL_PAY_CYCLE_OPTIONS.map(option=>option.code))
const POPULATION_LABELS=new Map(PAYROLL_POPULATION_OPTIONS.map(option=>[option.code,option.label]))
const PAY_CYCLE_LABELS=new Map(PAYROLL_PAY_CYCLE_OPTIONS.map(option=>[option.code,option.label]))

export function normalizePayrollPopulationKey(value){
  const normalized=clean(value).toLowerCase()
  return POPULATION_CODES.has(normalized)?normalized:''
}

export function normalizePayrollPayCycleKey(value){
  const normalized=clean(value).toLowerCase()
  return PAY_CYCLE_CODES.has(normalized)?normalized:''
}

export function payrollPopulationLabel(value){
  const normalized=normalizePayrollPopulationKey(value)
  return POPULATION_LABELS.get(normalized)||clean(value)||'—'
}

export function payrollPayCycleLabel(value){
  const normalized=normalizePayrollPayCycleKey(value)
  return PAY_CYCLE_LABELS.get(normalized)||clean(value)||'—'
}

export function payrollStreamIdentity(batch){
  return [
    clean(batch?.period_start).slice(0,10),
    normalizePayrollPopulationKey(batch?.population_key),
    normalizePayrollPayCycleKey(batch?.pay_cycle_key),
    clean(batch?.currency).toUpperCase(),
  ].join('|')
}
