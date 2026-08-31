import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ADMIN_DESIGN_PREVIEW_CLASS,
  ADMIN_DESIGN_PREVIEW_STORAGE_KEY,
  resolveAdminDesignPreview,
  applyAdminDesignPreviewMode,
} from './adminDesignPreview.js'

test('design=v3 enables and persists the admin-only visual preview', () => {
  assert.deepEqual(resolveAdminDesignPreview({ search: '?tab=alerts&design=v3' }), {
    enabled: true,
    storageAction: 'set',
  })
})

test('design=off explicitly clears a persisted visual preview', () => {
  assert.deepEqual(resolveAdminDesignPreview({ search: '?design=off', stored: 'v3' }), {
    enabled: false,
    storageAction: 'remove',
  })
})

test('preview state survives normal route navigation within the browser session', () => {
  assert.deepEqual(resolveAdminDesignPreview({ search: '?tab=training-reports', stored: 'v3' }), {
    enabled: true,
    storageAction: 'none',
  })
})

test('applying preview mode changes only the document root marker', () => {
  const classes = new Set()
  const attributes = new Map()
  const writes = new Map()
  const root = {
    classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
  }
  const storage = {
    getItem: key => writes.get(key) || '',
    setItem: (key, value) => writes.set(key, value),
    removeItem: key => writes.delete(key),
  }

  assert.equal(applyAdminDesignPreviewMode({ search: '?design=v3', storage, root }), true)
  assert.equal(classes.has(ADMIN_DESIGN_PREVIEW_CLASS), true)
  assert.equal(writes.get(ADMIN_DESIGN_PREVIEW_STORAGE_KEY), 'v3')
  assert.equal(attributes.get('data-wfh-admin-design'), 'v3')

  assert.equal(applyAdminDesignPreviewMode({ search: '?design=off', storage, root }), false)
  assert.equal(classes.has(ADMIN_DESIGN_PREVIEW_CLASS), false)
  assert.equal(writes.has(ADMIN_DESIGN_PREVIEW_STORAGE_KEY), false)
  assert.equal(attributes.has('data-wfh-admin-design'), false)
})

test('the preview cannot activate outside the admin runtime', () => {
  const classes = new Set()
  const root = {
    classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    setAttribute: () => {},
    removeAttribute: () => {},
  }
  const storage = {
    getItem: () => 'v3',
    setItem: () => {},
    removeItem: () => {},
  }
  assert.equal(applyAdminDesignPreviewMode({ search: '?design=v3', storage, root, available: false }), false)
  assert.equal(classes.size, 0)
})
