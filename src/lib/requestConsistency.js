export const isCurrentLiveRequest=(alive,currentToken,requestToken)=>Boolean(
  alive&&currentToken===requestToken
)

export const isSnapshotForRequest=(snapshot,scopeKey,requestKey)=>Boolean(
  snapshot?.hasData&&snapshot.scopeKey===scopeKey&&snapshot.key===requestKey
)

export const staleSnapshotNotice=label=>`当前保留最近一次成功结果${label?`：${String(label)}`:''}。`
