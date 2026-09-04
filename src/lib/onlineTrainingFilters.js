import {normalizeStringSelection} from '../components/searchableMultiSelectModel.js'

export const ONLINE_TRAINING_MULTI_VALUE_SEPARATOR='\u001f'
export const ONLINE_TRAINING_MULTI_FILTER_KEYS=Object.freeze([
  'team','group','position','shift','platform',
])

const MULTI_FILTER_KEY_SET=new Set(ONLINE_TRAINING_MULTI_FILTER_KEYS)
const cleanScalar=value=>String(value??'').trim()

export function normalizeOnlineTrainingMultiValue(value){
  const source=Array.isArray(value)?value:[value]
  return normalizeStringSelection(source.flatMap(item=>
    String(item??'').split(ONLINE_TRAINING_MULTI_VALUE_SEPARATOR)
  ))
}

export function normalizeOnlineTrainingFilters(filters={}){
  const source=filters&&typeof filters==='object'&&!Array.isArray(filters)?filters:{}
  const normalized={}

  Object.entries(source).forEach(([key,value])=>{
    normalized[key]=MULTI_FILTER_KEY_SET.has(key)
      ?normalizeOnlineTrainingMultiValue(value)
      :cleanScalar(value)
  })
  ONLINE_TRAINING_MULTI_FILTER_KEYS.forEach(key=>{
    if(!(key in normalized))normalized[key]=[]
  })

  return normalized
}

export function encodeOnlineTrainingFilterPayload(filters={}){
  const normalized=normalizeOnlineTrainingFilters(filters)
  return Object.fromEntries(Object.entries(normalized).map(([key,value])=>[
    key,
    MULTI_FILTER_KEY_SET.has(key)
      ?value.join(ONLINE_TRAINING_MULTI_VALUE_SEPARATOR)
      :value,
  ]))
}

export function countActiveOnlineTrainingFilters(filters={}){
  const normalized=normalizeOnlineTrainingFilters(filters)
  return Object.values(normalized).reduce((count,value)=>
    count+(Array.isArray(value)?Number(value.length>0):Number(Boolean(value))),0
  )
}
