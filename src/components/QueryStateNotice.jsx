import React from 'react'

const DEFAULT_TITLES={
  loading:'正在更新',
  warning:'暂时无法更新',
  error:'读取失败',
}

export default function QueryStateNotice({
  tone='loading',
  title='',
  detail='',
  onRetry,
  retryLabel='重新查询',
  className='',
}){
  const isLoading=tone==='loading'
  const role=tone==='error'?'alert':'status'
  return <div className={`query-state-notice ${tone} ${className}`.trim()} role={role} aria-live={tone==='error'?'assertive':'polite'}>
    <span className="query-state-notice-mark" aria-hidden="true">{isLoading?<i/>:tone==='warning'?'!':'×'}</span>
    <span className="query-state-notice-copy">
      <strong>{title||DEFAULT_TITLES[tone]||DEFAULT_TITLES.loading}</strong>
      {detail&&<small>{detail}</small>}
    </span>
    {onRetry&&<button type="button" onClick={onRetry}>{retryLabel}</button>}
  </div>
}
