import React, { createContext, useCallback, useContext, useMemo } from 'react'

const emptyAccess = {
  loading: true,
  founder: false,
  permissions: [],
  permissionKey: '',
  error: '',
  hasPermission: () => false,
  hasAnyPermission: () => false,
  hasAllPermissions: () => false,
}

const AdminAccessContext = createContext(emptyAccess)

export function AdminAccessProvider({ access, children }) {
  const permissions = useMemo(
    () => Array.isArray(access?.permissions) ? access.permissions : [],
    [access?.permissions],
  )
  const permissionKey = useMemo(() => permissions.slice().sort().join('|'), [permissions])
  const permissionSet = useMemo(() => new Set(permissions), [permissions])
  const founder = Boolean(access?.founder)
  const hasPermission = useCallback(code => Boolean(
    code && (founder || permissionSet.has('*') || permissionSet.has(code))
  ), [founder, permissionSet])
  const hasAnyPermission = useCallback(codes => {
    const required = Array.isArray(codes) ? codes.filter(Boolean) : []
    return required.length === 0 || required.some(hasPermission)
  }, [hasPermission])
  const hasAllPermissions = useCallback(codes => {
    const required = Array.isArray(codes) ? codes.filter(Boolean) : []
    return required.length === 0 || required.every(hasPermission)
  }, [hasPermission])
  const value = useMemo(() => ({
    loading: Boolean(access?.loading),
    founder,
    permissions,
    permissionKey,
    error: access?.error || '',
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
  }), [access?.loading, access?.error, founder, permissions, permissionKey, hasPermission, hasAnyPermission, hasAllPermissions])

  return <AdminAccessContext.Provider value={value}>{children}</AdminAccessContext.Provider>
}

export function useAdminAccess() {
  return useContext(AdminAccessContext)
}
