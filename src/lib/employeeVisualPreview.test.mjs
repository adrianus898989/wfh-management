import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  employeeFilterPreviewEnabled,
} from './employeeVisualPreview.js'

test('ordinary employee URL keeps the production design unchanged', () => {
  assert.equal(employeeFilterPreviewEnabled({ pathname: '/admin/employees' }), false)
})

test('the exact employee filter preview query enables only the isolated class', () => {
  assert.equal(employeeFilterPreviewEnabled({
    pathname: '/admin/employees',
    search: '?tab=directory&preview=employees-filter-v1',
  }), true)
  assert.equal(employeeFilterPreviewEnabled({
    pathname: '/admin/employees/',
    search: '?preview=employees-filter-v1',
  }), true)
})

test('preview query cannot affect other admin or staff routes', () => {
  for (const pathname of ['/admin/login', '/admin/payroll', '/staff', '/staff/exams']) {
    assert.equal(employeeFilterPreviewEnabled({
      pathname,
      search: '?preview=employees-filter-v1',
    }), false)
  }
})

test('removing the query removes the preview on the next route render', () => {
  assert.equal(employeeFilterPreviewEnabled({
    pathname: '/admin/employees',
    search: '?preview=employees-filter-v1',
  }), true)
  assert.equal(employeeFilterPreviewEnabled({
    pathname: '/admin/employees',
    search: '',
  }), false)
})

test('similar paths and duplicate preview values fail closed', () => {
  assert.equal(employeeFilterPreviewEnabled({
    pathname: '/admin/employees-old',
    search: '?preview=employees-filter-v1',
  }), false)
  assert.equal(employeeFilterPreviewEnabled({
    pathname: '/admin/employees',
    search: '?preview=employees-filter-v1&preview=employees-filter-v1',
  }), false)
})

test('the preview gate has no browser persistence mechanism', () => {
  const source = fs.readFileSync(new URL('./employeeVisualPreview.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /sessionStorage|localStorage|STORAGE_KEY|storageAction/)
})

test('preview CSS is page-scoped and cannot restyle the application shell', () => {
  const source = fs.readFileSync(new URL('../styles-employee-v27.css', import.meta.url), 'utf8')
  const start = source.indexOf('/* Employee filter preview V1')
  const end = source.indexOf('/* Employee filter preview V1 end */', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const previewCss = source.slice(start, end)
  assert.match(previewCss, /data-employee-design-preview="employees-filter-v1"/)
  assert.doesNotMatch(previewCss, /\.sidebar|\.admin-global-topbar|\.admin-shell|\bhtml\b/)
})
