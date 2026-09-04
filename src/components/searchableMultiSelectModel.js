const cleanString = value => String(value ?? '').trim()

export function normalizeStringSelection(values) {
  const source = Array.isArray(values) ? values : [values]
  const seen = new Set()
  const result = []

  source.forEach(value => {
    const cleaned = cleanString(value)
    if (!cleaned || seen.has(cleaned)) return
    seen.add(cleaned)
    result.push(cleaned)
  })

  return result
}

export function toggleStringSelection(values, value, selected) {
  const current = normalizeStringSelection(values)
  const item = cleanString(value)
  if (!item) return current

  const contains = current.includes(item)
  const shouldSelect = typeof selected === 'boolean' ? selected : !contains
  if (shouldSelect === contains) return current
  return shouldSelect ? [...current, item] : current.filter(entry => entry !== item)
}

export function setVisibleStringSelection(values, visibleValues, selected = true) {
  const current = normalizeStringSelection(values)
  const visible = normalizeStringSelection(visibleValues)
  if (!visible.length) return current

  if (!selected) {
    const visibleSet = new Set(visible)
    return current.filter(value => !visibleSet.has(value))
  }

  const result = [...current]
  const selectedSet = new Set(current)
  visible.forEach(value => {
    if (selectedSet.has(value)) return
    selectedSet.add(value)
    result.push(value)
  })
  return result
}

export function sameStringSelection(left, right) {
  const a = normalizeStringSelection(left)
  const b = normalizeStringSelection(right)
  return a.length === b.length && a.every((value, index) => value === b[index])
}
