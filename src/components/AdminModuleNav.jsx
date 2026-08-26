import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { adminSectionItems, adminTargetMatches } from '../config/navigation'
import { useAdminAccess } from '../lib/adminAccess'
import { useAdminI18n } from '../lib/adminI18n'

export default function AdminModuleNav({ className = '' }) {
  const location = useLocation()
  const access = useAdminAccess()
  const { t } = useAdminI18n()
  const { section, items: sectionItems } = adminSectionItems(location.pathname, location.search)

  if (!section?.children?.length) return null

  const allowed = item => {
    if (item.allPermissions?.length && !access.hasAllPermissions(item.allPermissions)) return false
    return !item.permissions?.length || access.hasAnyPermission(item.permissions)
  }
  const items = sectionItems.filter(allowed)
  if (!items.length) return null

  return <nav className={`admin-module-nav ${className}`.trim()} aria-label={t(`${section.label}子页`)}>
    {items.map(item => {
      const active = adminTargetMatches(item.to, location.pathname, location.search)
      return <Link
        key={`${item.label}-${item.to}`}
        to={item.to}
        className={active ? 'active' : ''}
        aria-current={active ? 'page' : undefined}
      >{t(item.label)}</Link>
    })}
  </nav>
}
