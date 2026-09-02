import React from 'react'
import { ADMIN_NAV_ICONS } from '../config/adminNavIcons.js'

export default function AdminNavIcon({ name }) {
  const drawing = ADMIN_NAV_ICONS[name]
  if (!drawing) return null

  return (
    <svg
      className="admin-nav-icon-svg"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {drawing.map(({ element, ...attributes }, index) => React.createElement(element, {
        ...attributes,
        key:`${name}-${index}`,
      }))}
    </svg>
  )
}

