export const LEGACY_ERROR_TABLE_SELECTOR = '.rp-errors-table'

export const legacyErrorTables = root => Array.from(root?.querySelectorAll?.(LEGACY_ERROR_TABLE_SELECTOR) || [])
