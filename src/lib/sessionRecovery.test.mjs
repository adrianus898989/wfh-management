import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const app = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8')
const supabaseClient = fs.readFileSync(path.join(root, 'src/lib/supabase.js'), 'utf8')
const adminLogin = fs.readFileSync(path.join(root, 'src/pages/AdminLoginPage.jsx'), 'utf8')

test('a late protected request revalidates without forcing a token rotation', () => {
  assert.match(app, /const onAuthCheck = \(\) => \{[\s\S]{0,240}?AUTH_CHECK_DEBOUNCE_MS[\s\S]{0,120}?recover\(\)/)
  assert.doesNotMatch(app, /const onAuthCheck = event =>[\s\S]{0,180}?localSignOut/)
  assert.doesNotMatch(app, /force\s*\|\|\s*Number\(session\.expires_at/)
  assert.match(app, /Number\(session\.expires_at \|\| 0\)[\s\S]{0,80}?10 \* 60 \* 1000/)
})

test('parallel protected failures dispatch only one auth verification event', () => {
  assert.match(supabaseClient, /let authCheckQueued=false/)
  assert.match(supabaseClient, /AUTH_CHECK_DISPATCH_DEBOUNCE_MS=1000/)
  assert.match(supabaseClient, /requestAuthCheck\(\{terminal:failure\.terminal,reason:failure\.reason\}\)/)
})

test('admin login synchronously rejects duplicate form submissions', () => {
  assert.match(adminLogin, /const submitInFlight = useRef\(false\)/)
  assert.match(adminLogin, /if \(submitInFlight\.current\) return/)
  assert.match(adminLogin, /finally \{\s*submitInFlight\.current = false/)
})
