export const ADMIN_DESIGN_PREVIEW_VALUE = 'v3'
export const ADMIN_DESIGN_PREVIEW_STORAGE_KEY = 'wfh.admin-design-preview'
export const ADMIN_DESIGN_PREVIEW_CLASS = 'wfh-admin-design-test'

const disabledValues = new Set(['0', 'false', 'off'])

export function resolveAdminDesignPreview({ search = '', stored = '' } = {}) {
  const requested = new URLSearchParams(String(search || '')).get('design')
  if (requested === ADMIN_DESIGN_PREVIEW_VALUE) {
    return { enabled: true, storageAction: 'set' }
  }
  if (disabledValues.has(String(requested || '').toLowerCase())) {
    return { enabled: false, storageAction: 'remove' }
  }
  return {
    enabled: stored === ADMIN_DESIGN_PREVIEW_VALUE,
    storageAction: 'none',
  }
}

export function applyAdminDesignPreviewMode({ search, storage, root, available = true } = {}) {
  const browserSearch = search ?? (typeof window === 'undefined' ? '' : window.location.search)
  const browserStorage = storage ?? (typeof window === 'undefined' ? null : window.sessionStorage)
  const documentRoot = root ?? (typeof document === 'undefined' ? null : document.documentElement)
  let stored = ''

  try {
    stored = browserStorage?.getItem(ADMIN_DESIGN_PREVIEW_STORAGE_KEY) || ''
  } catch {
    stored = ''
  }

  const state = available
    ? resolveAdminDesignPreview({ search: browserSearch, stored })
    : { enabled: false, storageAction: 'none' }

  try {
    if (state.storageAction === 'set') {
      browserStorage?.setItem(ADMIN_DESIGN_PREVIEW_STORAGE_KEY, ADMIN_DESIGN_PREVIEW_VALUE)
    } else if (state.storageAction === 'remove') {
      browserStorage?.removeItem(ADMIN_DESIGN_PREVIEW_STORAGE_KEY)
    }
  } catch {
    // The visual test still works for the current page when storage is unavailable.
  }

  documentRoot?.classList.toggle(ADMIN_DESIGN_PREVIEW_CLASS, state.enabled)
  if (state.enabled) documentRoot?.setAttribute('data-wfh-admin-design', ADMIN_DESIGN_PREVIEW_VALUE)
  else documentRoot?.removeAttribute('data-wfh-admin-design')
  return state.enabled
}
