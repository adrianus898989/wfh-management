import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PAYROLL_CURRENCY_OPTIONS, payrollCurrencyLabel } from './payrollCurrency.js'

test('payroll upload exposes every supported currency with its correct label',()=>{
  assert.deepEqual(PAYROLL_CURRENCY_OPTIONS.map(option=>option.code),['PHP','USD','CNY','VND','IDR'])
  assert.equal(payrollCurrencyLabel('PHP'),'菲律宾披索')
  assert.equal(payrollCurrencyLabel('USD'),'美金')
  assert.equal(payrollCurrencyLabel('CNY'),'人民币')
  assert.equal(payrollCurrencyLabel('VND'),'越南盾')
  assert.equal(payrollCurrencyLabel('IDR'),'印尼盾')
  assert.equal(payrollCurrencyLabel(' eur '),'EUR')
})

test('payroll schema and import RPC accept a normalized currency code without a PHP/USD check',()=>{
  const migration=readFileSync(new URL('../../supabase/migrations/20260823052319_payroll_center.sql',import.meta.url),'utf8')
  assert.match(migration,/currency text not null default 'USD'/)
  assert.match(migration,/currency=upper\(coalesce\(nullif\(trim\(p_batch->>'currency'\)/)
  assert.doesNotMatch(migration,/payroll_batches_currency_check|currency\s+in\s*\(\s*'PHP'\s*,\s*'USD'/i)
})

test('payslip printing is isolated and waits for the print lifecycle to finish',()=>{
  const component=readFileSync(new URL('../pages/StaffPayrollPage.jsx',import.meta.url),'utf8')
  const styles=readFileSync(new URL('../styles-payroll.css',import.meta.url),'utf8')
  assert.match(component,/createPortal\(<div className="payslip-print-sheet"/)
  assert.match(component,/addEventListener\('afterprint',clear,\{once:true\}\)/)
  assert.doesNotMatch(component,/setTimeout\(clear,\s*1500\)/)
  assert.match(styles,/@page payslip\{size:A4 portrait;margin:0\}/)
  assert.match(styles,/body\.payslip-print-active>\.payslip-print-sheet\{display:block!important/)
})
