import React from 'react'

export const PAGE_SIZE_OPTIONS = [20,30,50,100,500]

export function DataPageControls({
  keyword,
  onKeyword,
  placeholder='搜索',
  pageSize=20,
  onPageSize,
  right,
}) {
  return (
    <div className="data-page-controls">
      <div className="data-page-search">
        <span>⌕</span>
        <input value={keyword} onChange={e=>onKeyword(e.target.value)} placeholder={placeholder}/>
      </div>
      <div className="data-page-control-right">
        {onPageSize && (
          <label className="page-size-control">
            <span>每页</span>
            <select value={pageSize} onChange={e=>onPageSize(Number(e.target.value))}>
              {PAGE_SIZE_OPTIONS.map(n=><option key={n} value={n}>{n} 条</option>)}
            </select>
          </label>
        )}
        {right}
      </div>
    </div>
  )
}

export function Pagination({ page, pages, total, pageSize, loading, onPage }) {
  const from = total ? (page-1)*pageSize+1 : 0
  const to = Math.min(page*pageSize,total)
  return (
    <div className="table-pagination">
      <div className="pagination-meta">{from}–{to} / {total}</div>
      <div className="pagination-actions">
        <button disabled={page<=1||loading} onClick={()=>onPage(page-1)}>上一页</button>
        <span>第 {page} / {pages} 页</span>
        <button disabled={page>=pages||loading} onClick={()=>onPage(page+1)}>下一页</button>
      </div>
    </div>
  )
}
