export const isCurrentLiveRequest=(alive,currentToken,requestToken)=>Boolean(
  alive&&currentToken===requestToken
)

export const staleSnapshotNotice=label=>`显示上次成功结果（对应筛选：${String(label||'上次成功查询')}）`
