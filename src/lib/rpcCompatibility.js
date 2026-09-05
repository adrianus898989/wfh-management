export const isMissingRpcSignature = (error, rpcName) => {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return ['PGRST202', '42883'].includes(code)
    && message.includes(rpcName)
    && /not found|does not exist|schema cache/i.test(message)
}
