import React, { useEffect, useMemo, useState } from 'react'

const safeHttpUrl=value=>{
  const raw=String(value||'').trim()
  if(!raw)return ''
  const candidate=raw.startsWith('//')?`https:${raw}`:/^www\./i.test(raw)?`https://${raw}`:raw
  try{
    const parsed=new URL(candidate)
    return ['http:','https:'].includes(parsed.protocol)?parsed.href:''
  }catch{return ''}
}

const driveId=url=>{
  const safe=safeHttpUrl(url)
  if(!safe)return ''
  try{
    const parsed=new URL(safe)
    return parsed.pathname.match(/\/d\/([^/]+)/)?.[1]||parsed.searchParams.get('id')||''
  }catch{return ''}
}

const imageSources=url=>{
  const original=safeHttpUrl(url)
  if(!original)return []
  const id=driveId(original)
  return [...new Set((id?[
    `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w2000`,
    `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=view`,
    `https://lh3.googleusercontent.com/d/${encodeURIComponent(id)}=w2000`,
    original,
  ]:[original]).map(safeHttpUrl).filter(Boolean))]
}

const normalizedImageUrls=value=>{
  let rows=Array.isArray(value)?value.flat(Infinity):[value]
  if(rows.length===1&&typeof rows[0]==='string'&&rows[0].trim().startsWith('[')){
    try{
      const parsed=JSON.parse(rows[0])
      if(Array.isArray(parsed))rows=parsed.flat(Infinity)
    }catch{/* Keep the original value when it is not JSON. */}
  }
  return [...new Set(rows.flatMap(item=>typeof item==='string'?item.split(/[\n;]+/):[]).map(safeHttpUrl).filter(Boolean))]
}

const defaultLabels={
  imageAlt:'考试题目图片',
  imageOpen:'点击放大',
  imageClose:'关闭图片',
  imageFallback:'图片暂时无法预览',
  imageRetry:'重试预览',
  imageNumber:count=>`图片 ${count}`,
}

export function ExamImageGallery({urls=[],labels={},className=''}){
  const copy={...defaultLabels,...labels}
  const [preview,setPreview]=useState(null)
  const media=useMemo(()=>normalizedImageUrls(urls),[urls])
  if(!media.length)return null
  return <>
    <div className={`exam-media-grid ${className}`.trim()}>{media.map((url,index)=><ProgressiveExamImage key={url} url={url} number={index+1} labels={copy} onOpen={setPreview}/>)}</div>
    {preview&&<ExamImageLightbox media={preview} labels={copy} onClose={()=>setPreview(null)}/>}
  </>
}

function ProgressiveExamImage({url,number,labels,onOpen}){
  const sources=useMemo(()=>imageSources(url),[url])
  const [sourceIndex,setSourceIndex]=useState(0)
  const src=sources[sourceIndex]||''
  useEffect(()=>setSourceIndex(0),[url])
  const title=typeof labels.imageNumber==='function'?labels.imageNumber(number):`${labels.imageNumber||'图片'} ${number}`
  const open=()=>onOpen({sources,number,title})
  return <article className="exam-media-card">
    {src?<button type="button" className="exam-media-thumb" onClick={open} aria-label={`${title} · ${labels.imageOpen}`}><img src={src} alt={`${labels.imageAlt} ${number}`} referrerPolicy="no-referrer" onError={()=>setSourceIndex(value=>value+1)}/><span>{labels.imageOpen}</span></button>:<button type="button" className="exam-media-fallback" onClick={open}><span>{labels.imageFallback}</span><b>{labels.imageRetry}</b></button>}
    <span className="exam-media-caption">{title}</span>
  </article>
}

function ExamImageLightbox({media,labels,onClose}){
  const [sourceIndex,setSourceIndex]=useState(0)
  const sources=media.sources||[]
  const src=sources[sourceIndex]||''
  useEffect(()=>{
    setSourceIndex(0)
    const closeOnEscape=event=>{if(event.key==='Escape')onClose()}
    window.addEventListener('keydown',closeOnEscape)
    return()=>window.removeEventListener('keydown',closeOnEscape)
  },[media,onClose])
  return <div className="exam-image-lightbox" role="dialog" aria-modal="true" aria-label={media.title} onMouseDown={event=>{if(event.currentTarget===event.target)onClose()}}>
    <div className="exam-lightbox-toolbar"><strong>{media.title}</strong><button type="button" className="exam-lightbox-close" onClick={onClose} aria-label={labels.imageClose}>×</button></div>
    {src?<img src={src} alt={`${labels.imageAlt} ${media.number}`} referrerPolicy="no-referrer" onError={()=>setSourceIndex(value=>value+1)} onClick={event=>event.stopPropagation()}/>:<div className="exam-lightbox-fallback" role="alert" onClick={event=>event.stopPropagation()}><strong>{labels.imageFallback}</strong><button type="button" onClick={()=>setSourceIndex(0)}>{labels.imageRetry}</button></div>}
  </div>
}
