import React, { useEffect, useMemo, useState } from 'react'
import { Pagination } from '../components/DataPageControls'
import AdminModuleNav from '../components/AdminModuleNav'
import { supabase } from '../lib/supabase'
import { useAdminI18n } from '../lib/adminI18n'
import { edgeFunctionErrorMessage } from '../lib/edgeFunctionError'
import {
  COMPANY_ASSET_TABS,
  COMPANY_HARDWARE_TABS,
  companyAssetCountries,
  companyAssetPage,
  filterCompanyAssetEmployees,
  normalizeCompanyAssetEmployees,
} from '../lib/companyAssets'

const emptyAsset = <span className="company-asset-empty">—</span>

function AssetTableLoading({ columns }) {
  return <div className="company-asset-loading" aria-label="正在读取公司资产资料">
    {Array.from({ length:8 }, (_, rowIndex) => <div className={`company-asset-loading-row columns-${columns}`} key={rowIndex}>
      {Array.from({ length:columns }, (_, columnIndex) => <i key={columnIndex}/>) }
    </div>)}
  </div>
}

function HardwareTable({ rows, type }) {
  const typeLabel = type === COMPANY_HARDWARE_TABS.PHONE ? '手机' : '电脑'
  return <div className="table-scroll company-asset-table-scroll">
    <table className="data-table company-asset-table">
      <thead><tr>
        <th>入职日期</th><th>员工ID</th><th>姓名</th><th>员工国家</th><th>资产类型</th>
        <th>数量</th><th>品牌 / 型号</th><th>资产编号</th><th>使用状态</th><th>备注</th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.id || row.employee_no}>
        <td className="company-asset-date">{row.hire_date || '—'}</td>
        <td><strong>{row.employee_no || '—'}</strong></td>
        <td>{row.full_name || '—'}</td>
        <td>{row.country || '—'}</td>
        <td><span className={`company-asset-type ${type}`}>{typeLabel}</span></td>
        <td>{emptyAsset}</td><td>{emptyAsset}</td><td>{emptyAsset}</td><td>{emptyAsset}</td><td>{emptyAsset}</td>
      </tr>)}</tbody>
    </table>
  </div>
}

function SoftwareTable({ rows }) {
  return <div className="table-scroll company-asset-table-scroll">
    <table className="data-table company-asset-table company-software-table">
      <thead><tr>
        <th>入职日期</th><th>员工ID</th><th>姓名</th><th>员工国家</th>
        <th>工作 Telegram</th><th>微软账号</th><th>无影云</th><th>邮箱账号</th><th>其他软件</th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.id || row.employee_no}>
        <td className="company-asset-date">{row.hire_date || '—'}</td>
        <td><strong>{row.employee_no || '—'}</strong></td>
        <td>{row.full_name || '—'}</td>
        <td>{row.country || '—'}</td>
        <td>{row.work_tg ? <span className="company-asset-value">{row.work_tg}</span> : emptyAsset}</td>
        <td>{emptyAsset}</td><td>{emptyAsset}</td><td>{emptyAsset}</td><td>{emptyAsset}</td>
      </tr>)}</tbody>
    </table>
  </div>
}

export default function AdminCompanyAssetsPage() {
  const { t } = useAdminI18n()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [assetTab, setAssetTab] = useState(COMPANY_ASSET_TABS.HARDWARE)
  const [hardwareTab, setHardwareTab] = useState(COMPANY_HARDWARE_TABS.PHONE)
  const [keyword, setKeyword] = useState('')
  const [country, setCountry] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(30)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const { data, error: requestError } = await supabase.functions.invoke('admin-accounts', {
        body:{ action:'company_assets' },
      })
      if (requestError || data?.error) throw new Error(await edgeFunctionErrorMessage({ data, error:requestError, fallback:'公司资产资料读取失败' }))
      setRows(normalizeCompanyAssetEmployees(data?.employees || []))
    } catch (requestError) {
      setError(requestError?.message || '公司资产资料读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const countries = useMemo(() => companyAssetCountries(rows), [rows])
  const filteredRows = useMemo(
    () => filterCompanyAssetEmployees(rows, { keyword, country }),
    [rows, keyword, country],
  )
  const pageResult = useMemo(
    () => companyAssetPage(filteredRows, page, pageSize),
    [filteredRows, page, pageSize],
  )
  useEffect(() => {
    if (page !== pageResult.page) setPage(pageResult.page)
  }, [page, pageResult.page])

  const selectAssetTab = next => {
    setAssetTab(next)
    setPage(1)
  }
  const selectHardwareTab = next => {
    setHardwareTab(next)
    setPage(1)
  }
  const resetFilters = () => {
    setKeyword('')
    setCountry('')
    setPage(1)
  }

  return <div className="content-page company-assets-page">
    <div className="module-title-row">
      <div>
        <div className="module-kicker">ACCOUNT & ASSET MANAGEMENT</div>
        <h1>{t('后台账号使用情况')}</h1>
      </div>
      <button className="secondary-action" onClick={load} disabled={loading}>{loading ? t('刷新中…') : <><span aria-hidden="true">↻</span> {t('刷新资料')}</>}</button>
    </div>

    <AdminModuleNav />

    <section className="company-asset-overview">
      <article><span>{t('当前在职员工')}</span><strong>{loading && !rows.length ? '—' : rows.length}</strong><small>{t('按当前账号管理范围读取')}</small></article>
      <article><span>{t('员工基础资料')}</span><strong className="company-asset-status ready">{t('已同步')}</strong><small>Supabase</small></article>
      <article><span>{t('资产明细')}</span><strong className="company-asset-status pending">{t('待接入表格')}</strong><small>{t('收到 Google 表格后接入实时同步')}</small></article>
    </section>

    <section className="data-card company-assets-card">
      <header className="company-assets-card-head">
        <div><h2>{t('公司提供资产')}</h2><p>{t('员工资料来自 Supabase；硬件和软件账号等待资产表接入。')}</p></div>
        <span>{t('显示')} {filteredRows.length} / {rows.length}</span>
      </header>

      <div className="company-asset-primary-tabs" role="tablist" aria-label={t('资产分类')}>
        <button type="button" className={assetTab === COMPANY_ASSET_TABS.HARDWARE ? 'active' : ''} onClick={() => selectAssetTab(COMPANY_ASSET_TABS.HARDWARE)}>{t('硬件资产')}</button>
        <button type="button" className={assetTab === COMPANY_ASSET_TABS.SOFTWARE ? 'active' : ''} onClick={() => selectAssetTab(COMPANY_ASSET_TABS.SOFTWARE)}>{t('软件账号')}</button>
      </div>

      {assetTab === COMPANY_ASSET_TABS.HARDWARE && <div className="company-asset-subtitle-row">
        <strong>{t('硬件类型')}</strong>
        <div className="company-asset-subtabs" role="tablist" aria-label={t('硬件类型')}>
          <button type="button" className={hardwareTab === COMPANY_HARDWARE_TABS.PHONE ? 'active' : ''} onClick={() => selectHardwareTab(COMPANY_HARDWARE_TABS.PHONE)}>{t('手机')}</button>
          <button type="button" className={hardwareTab === COMPANY_HARDWARE_TABS.COMPUTER ? 'active' : ''} onClick={() => selectHardwareTab(COMPANY_HARDWARE_TABS.COMPUTER)}>{t('电脑')}</button>
        </div>
      </div>}

      <div className="company-asset-filters">
        <label><span>{t('搜索员工')}</span><input value={keyword} onChange={event => { setKeyword(event.target.value); setPage(1) }} placeholder={t('输入入职日期、员工ID、姓名、国家或工作 Telegram')}/></label>
        <label><span>{t('员工国家')}</span><select value={country} onChange={event => { setCountry(event.target.value); setPage(1) }}><option value="">{t('全部员工国家')}</option>{countries.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <button className="secondary-action" type="button" onClick={resetFilters} disabled={!keyword && !country}>{t('重置')}</button>
      </div>

      {error && <div className="page-error company-assets-error">{error}<button type="button" onClick={load}>{t('重新读取')}</button></div>}
      {loading && !rows.length
        ? <AssetTableLoading columns={assetTab === COMPANY_ASSET_TABS.HARDWARE ? 10 : 9}/>
        : !pageResult.rows.length
          ? <div className="empty-state">{t('没有符合条件的在职员工')}</div>
          : assetTab === COMPANY_ASSET_TABS.HARDWARE
            ? <HardwareTable rows={pageResult.rows} type={hardwareTab}/>
            : <SoftwareTable rows={pageResult.rows}/>
      }

      {!loading && !error && filteredRows.length > 0 && <Pagination
        page={pageResult.page}
        pages={pageResult.pages}
        total={filteredRows.length}
        pageSize={pageSize}
        loading={loading}
        onPage={setPage}
        onPageSize={next => { setPageSize(next); setPage(1) }}
      />}
    </section>
  </div>
}
