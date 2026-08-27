import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = async relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8')

const [
  employees,
  dashboard,
  companyAssets,
  reports,
  training,
  onlineTraining,
  alertCenter,
  stableErrorUi,
  main,
  reportStyles,
  stableStyles,
] = await Promise.all([
  source('../pages/AdminEmployeesPage.jsx'),
  source('../pages/PortalPage.jsx'),
  source('../pages/AdminCompanyAssetsPage.jsx'),
  source('../pages/AdminReportsPage.jsx'),
  source('../pages/AdminTrainingPage.jsx'),
  source('../pages/OnlineTrainingPage.jsx'),
  source('../components/AdminAlertCenter.jsx'),
  source('../stableErrorUiEnhancer.js'),
  source('../main.jsx'),
  source('../styles-reports.css'),
  source('../stable-layout-hotfix.css'),
])

test('employee initial loads and activation-code errors use the shared Edge response formatter', () => {
  assert.match(employees, /const invoke=async body=>[\s\S]*?edgeFunctionErrorMessage\(\{data,error,fallback:'操作失败'\}\)/)
  assert.match(employees, /action:'generate_activation_code'[\s\S]{0,300}edgeFunctionErrorMessage\(\{data,error,fallback:'激活码生成失败'\}\)/)
  assert.doesNotMatch(employees, /detail\|\|data\?\.error\|\|error\.message\|\|'激活码生成失败'/)
  assert.match(employees, /useEffect\(\(\)=>\{ setError\(''\) \},\[visibleTab\]\)/)
})

test('employee background metadata and analytics failures stay scoped to their own sub-pages', () => {
  const loadMetaBlock = employees.slice(employees.indexOf('const loadMeta='), employees.indexOf('const loadArchiveStats='))
  assert.match(employees, /const \[metaError,setMetaError\]=useState\(''\)/)
  assert.match(employees, /const loadMeta=async\(\)=>\{[\s\S]*?setMetaError\(employeeRequestError\(e,'筛选选项暂时不可用，当前页面仍可继续使用。'\)\)/)
  assert.doesNotMatch(loadMetaBlock, /setError\(/)
  assert.match(employees, /setPeopleAnalytics\(v=>\(\{\.\.\.v,loading:false,error:message\}\)\)/)
  assert.match(employees, /setResignationAnalytics\(v=>\(\{\.\.\.v,loading:false,error:employeeRequestError\(e,'离职分析读取失败，请重试。'\)\}\)\)/)
  assert.match(employees, /metaError&&\['员工档案','人员分析','离职记录','操作日志'\]\.includes\(visibleTab\)/)
  assert.match(employees, /error&&!\['停电 \/ 断网记录','预警记录'\]\.includes\(visibleTab\)/)
})

test('alert pages replace the generic Edge SDK wrapper with localized operation copy', () => {
  assert.match(alertCenter, /\^edge function returned a non-2xx status code\$\/i\.test\(raw\)\) return fallback/)
  assert.doesNotMatch(alertCenter, /messages\[raw\]\?\.\[locale\] \|\| raw \|\| fallback/)
})

test('admin page-level Edge loaders never pass the generic SDK message to their banners', () => {
  assert.match(dashboard, /edgeFunctionErrorMessage\(\{ data, error, fallback:'Dashboard 读取失败，请重试' \}\)/)
  assert.match(companyAssets, /edgeFunctionErrorMessage\(\{ data, error:requestError, fallback:'公司资产资料读取失败' \}\)/)
  assert.match(reports, /edgeFunctionErrorMessage\(\{data,error,fallback:'统计数据读取失败'\}\)/)
  assert.match(reports, /const payloadMessage=payload\?reportErrorMessage\(payload,''\):''/)
  assert.match(reports, /const message=reportErrorMessage\(data,'错误统计读取失败'\)/)
  assert.doesNotMatch(reports, /new Error\(`\$\{data\.error\}/)
  assert.match(reports, /edgeFunctionErrorMessage\(\{data:found\.data,error:found\.error,fallback:'员工读取失败'\}\)/)
  assert.match(training, /edgeFunctionErrorMessage\(\{data:detail,error:e,fallback:'员工档案读取失败'\}\)/)
  assert.match(onlineTraining, /edgeFunctionErrorMessage\(\{data,error:edgeError,fallback:'员工完整档案读取失败'\}\)/)
})

test('error statistics prioritizes the complete error type and compacts status and score columns', () => {
  assert.match(reportStyles, /nth-child\(8\)\{width:280px!important/)
  assert.match(reportStyles, /nth-child\(4\)\{width:58px!important/)
  assert.match(reportStyles, /nth-child\(9\)\{width:52px!important/)
  assert.match(reportStyles, /td:nth-child\(8\) \.rp-cell-clamp[\s\S]*white-space:normal!important/)
  assert.match(stableStyles, /\.wfh-error-type-cell \*[\s\S]*white-space:normal!important/)
})

test('the active legacy error-history enhancer formats Edge failures before writing text', () => {
  assert.match(main, /stableErrorUiEnhancer/)
  assert.match(stableErrorUi, /edgeFunctionErrorMessage\(\{data,error,fallback:'错误记录读取失败'\}\)/)
  assert.doesNotMatch(stableErrorUi, /data\?\.error\|\|error\?\.message\|\|'读取失败'/)
})
