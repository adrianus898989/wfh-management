import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const app = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8')

test('a late protected request revalidates instead of immediately signing out', () => {
  assert.match(app, /const onAuthCheck = \(\) => recover\(true\)/)
  assert.doesNotMatch(app, /const onAuthCheck = event =>[\s\S]{0,180}?localSignOut/)
})
