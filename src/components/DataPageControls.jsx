import React, { useEffect, useMemo, useState } from 'react'

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

function pageWindow(page,pages){
  const count=Math.min(7,pages)
  let start=Math.max(1,page-Math.floor(count/2))
  let end=start+count-1
  if(end>pages){end=pages;start=Math.max(1,end-count+1)}
  return Array.from({length:end-start+1},(_,i)=>start+i)
}

export function Pagination({ page, pages, total, pageSize, loading, onPage, onPageSize }) {
  const [jump,setJump]=useState('')
  const pageList=useMemo(()=>pageWindow(page,pages),[page,pages])
  const from = total ? (page-1)*pageSize+1 : 0
  const to = Math.min(page*pageSize,total)
  useEffect(()=>setJump(''),[page,pages])

  const go=value=>{
    const n=Math.max(1,Math.min(pages,Number(value)||1))
    onPage(n)
  }

  return (
    <div className="table-pagination professional-pagination">
      <div className="pagination-summary">
        <strong>共 {total} 条</strong>
        <span>{from}–{to}</span>
      </div>
      <div className="pagination-main">
        {onPageSize&&<label className="pagination-size-control">
          <select value={pageSize} onChange={e=>onPageSize(Number(e.target.value))}>
            {PAGE_SIZE_OPTIONS.map(n=><option key={n} value={n}>{n} 条 / 页</option>)}
          </select>
        </label>}
        <button disabled={page<=1||loading} onClick={()=>go(1)}>首页</button>
        <button disabled={page<=1||loading} onClick={()=>go(page-1)}>上一页</button>
        <div className="pagination-number-list">
          {pageList.map(n=><button key={n} className={n===page?'active':''} disabled={loading} onClick={()=>go(n)}>{n}</button>)}
        </div>
        <button disabled={page>=pages||loading} onClick={()=>go(page+1)}>下一页</button>
        <button disabled={page>=pages||loading} onClick={()=>go(pages)}>尾页</button>
        <span className="pagination-page-count">共 {pages} 页</span>
        <label className="pagination-jump">前往
          <input value={jump} inputMode="numeric" onChange={e=>setJump(e.target.value.replace(/\D/g,''))} onKeyDown={e=>{if(e.key==='Enter'&&jump)go(jump)}}/>
          页
          <button type="button" disabled={!jump||loading} onClick={()=>go(jump)}>确定</button>
        </label>
      </div>
    </div>
  )
}
