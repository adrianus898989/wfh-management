import React,{useEffect,useId,useMemo,useRef,useState} from 'react'
import {
  normalizeStringSelection,
  sameStringSelection,
  setVisibleStringSelection,
  toggleStringSelection,
} from './searchableMultiSelectModel'
import './SearchableMultiSelect.css'

const DEFAULT_COPY={
  searchPlaceholder:'输入关键字搜索',
  emptyText:'没有匹配项',
  selectedLabel:'已选',
  selectVisible:'全选当前结果',
  clearVisible:'取消当前结果',
  clear:'清空',
  done:'完成',
}

export default function SearchableMultiSelect({
  value=[],
  options=[],
  onChange,
  placeholder='全部',
  ariaLabel='多选筛选',
  disabled=false,
  maxVisible=100,
  className='',
  compactSummary=false,
  copy:copyOverrides={},
}){
  const copy={...DEFAULT_COPY,...copyOverrides}
  const reactId=useId()
  const rootRef=useRef(null)
  const triggerRef=useRef(null)
  const searchRef=useRef(null)
  const [open,setOpen]=useState(false)
  const [query,setQuery]=useState('')
  const selected=useMemo(()=>normalizeStringSelection(value),[value])
  const choices=useMemo(()=>normalizeStringSelection(options),[options])
  const selectedSet=useMemo(()=>new Set(selected),[selected])
  const listboxId=`searchable-multi-select-${reactId}`
  const normalizedQuery=query.trim().toLocaleLowerCase()
  const matchingChoices=useMemo(()=>choices.filter(choice=>
    !normalizedQuery||choice.toLocaleLowerCase().includes(normalizedQuery)
  ),[choices,normalizedQuery])
  const visibleChoices=matchingChoices.slice(0,Math.max(1,Number(maxVisible)||100))
  const allVisibleSelected=visibleChoices.length>0&&visibleChoices.every(choice=>selectedSet.has(choice))

  const commit=next=>{
    const normalized=normalizeStringSelection(next)
    if(!sameStringSelection(selected,normalized))onChange?.(normalized)
  }
  const close=({restoreFocus=false}={})=>{
    setOpen(false)
    setQuery('')
    if(restoreFocus)window.requestAnimationFrame(()=>triggerRef.current?.focus())
  }
  const show=()=>{
    if(disabled)return
    setOpen(true)
  }

  useEffect(()=>{
    if(!open)return undefined
    const frame=window.requestAnimationFrame(()=>searchRef.current?.focus())
    const onPointerDown=event=>{
      if(rootRef.current&&!rootRef.current.contains(event.target))close()
    }
    const onKeyDown=event=>{
      if(event.key!=='Escape')return
      event.preventDefault()
      close({restoreFocus:true})
    }
    document.addEventListener('mousedown',onPointerDown)
    document.addEventListener('keydown',onKeyDown)
    return()=>{
      window.cancelAnimationFrame(frame)
      document.removeEventListener('mousedown',onPointerDown)
      document.removeEventListener('keydown',onKeyDown)
    }
  },[open])

  useEffect(()=>{
    if(!disabled)return
    setOpen(false)
    setQuery('')
  },[disabled])

  const summary=!selected.length
    ?placeholder
    :compactSummary
      ?`${copy.selectedLabel} ${selected.length}`
      :selected.length===1
      ?selected[0]
      :`${copy.selectedLabel} ${selected.length} 项`

  return <div className={`searchable-multi-select ${open?'is-open':''} ${disabled?'is-disabled':''} ${className}`.trim()} ref={rootRef}>
    <button
      ref={triggerRef}
      type="button"
      className="sms-trigger"
      aria-label={`${ariaLabel}：${summary}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      disabled={disabled}
      onClick={()=>open?close():show()}
      onKeyDown={event=>{
        if(event.key!=='ArrowDown')return
        event.preventDefault()
        show()
      }}
    >
      <span className={!selected.length?'sms-placeholder':''} title={selected.join('、')||placeholder}>{summary}</span>
      <em aria-hidden="true">⌄</em>
    </button>

    {open&&<div className="sms-popover">
      <div className="sms-search-row">
        <span aria-hidden="true">⌕</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={event=>setQuery(event.target.value)}
          onKeyDown={event=>{
            if(event.key!=='Enter')return
            event.preventDefault()
            if(visibleChoices.length===1){
              const choice=visibleChoices[0]
              commit(toggleStringSelection(selected,choice,!selectedSet.has(choice)))
            }
          }}
          placeholder={copy.searchPlaceholder}
          aria-label={`${ariaLabel}搜索`}
          aria-controls={listboxId}
          autoComplete="off"
        />
      </div>

      {selected.length>0&&<div className="sms-selected" aria-label={`${ariaLabel}已选项`}>
        {selected.map(item=><span key={item}><b title={item}>{item}</b><button type="button" aria-label={`移除 ${item}`} onClick={()=>commit(toggleStringSelection(selected,item,false))}>×</button></span>)}
      </div>}

      <div className="sms-bulk-actions">
        <button
          type="button"
          disabled={!visibleChoices.length}
          onClick={()=>commit(setVisibleStringSelection(selected,visibleChoices,!allVisibleSelected))}
        >{allVisibleSelected?copy.clearVisible:copy.selectVisible}</button>
        <small aria-live="polite">{matchingChoices.length} 项{matchingChoices.length>visibleChoices.length?` · 显示前 ${visibleChoices.length} 项`:''}</small>
      </div>

      <div id={listboxId} className="sms-options" role="listbox" aria-label={ariaLabel} aria-multiselectable="true">
        {visibleChoices.map(choice=>{
          const checked=selectedSet.has(choice)
          return <button
            type="button"
            role="option"
            aria-selected={checked}
            className={checked?'is-selected':''}
            key={choice}
            onClick={()=>commit(toggleStringSelection(selected,choice,!checked))}
          ><i className="sms-checkbox" aria-hidden="true">{checked?'✓':''}</i><span title={choice}>{choice}</span></button>
        })}
        {!visibleChoices.length&&<div className="sms-empty">{copy.emptyText}</div>}
      </div>

      <div className="sms-footer">
        <button type="button" className="sms-clear" disabled={!selected.length} onClick={()=>commit([])}>{copy.clear}</button>
        <button type="button" className="sms-done" onClick={()=>close({restoreFocus:true})}>{copy.done}</button>
      </div>
    </div>}
  </div>
}
