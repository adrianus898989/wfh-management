import React, { createContext, useCallback, useContext, useMemo } from 'react'

const emptyAccess = {
  loading: true,
  founder: false,
  permissions: [],
  permissionKey: '',
  error: '',
  roleCode: '',
  authUserId: '',
  employeeId: '',
  dataScope: '',
  teamId: '',
  positionId: '',
  loginUsername: '',
  loginEmail: '',
  employeeNo: '',
  fullName: '',
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
    roleCode: access?.roleCode || '',
    authUserId: access?.authUserId || '',
    employeeId: access?.employeeId || '',
    dataScope: access?.dataScope || '',
    teamId: access?.teamId || '',
    positionId: access?.positionId || '',
    loginUsername: access?.loginUsername || '',
    loginEmail: access?.loginEmail || '',
    employeeNo: access?.employeeNo || '',
    fullName: access?.fullName || '',
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
  }), [access?.loading, access?.error, access?.roleCode, access?.authUserId, access?.employeeId, access?.dataScope, access?.teamId, access?.positionId, access?.loginUsername, access?.loginEmail, access?.employeeNo, access?.fullName, founder, permissions, permissionKey, hasPermission, hasAnyPermission, hasAllPermissions])

  return <AdminAccessContext.Provider value={value}>{children}</AdminAccessContext.Provider>
}

export function useAdminAccess() {
  return useContext(AdminAccessContext)
}
