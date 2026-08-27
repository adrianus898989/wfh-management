import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const app = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8')
const supabaseClient = fs.readFileSync(path.join(root, 'src/lib/supabase.js'), 'utf8')
const adminLogin = fs.readFileSync(path.join(root, 'src/pages/AdminLoginPage.jsx'), 'utf8')
const adminReports = fs.readFileSync(path.join(root, 'src/pages/AdminReportsPage.jsx'), 'utf8')

test('a late protected request revalidates without forcing a token rotation', () => {
  assert.match(app, /const onAuthCheck = \(\) => \{/)
  assert.match(app, /const onAuthCheck = \(\) => \{[\s\S]{0,700}?AUTH_CHECK_DEBOUNCE_MS[\s\S]{0,160}?recover\(\)/)
  assert.doesNotMatch(app, /const onAuthCheck = event =>[\s\S]{0,180}?localSignOut/)
  assert.doesNotMatch(app, /supabase\.auth\.refreshSession/)
  assert.match(app, /browser client already serializes refresh-token rotation/)
  assert.doesNotMatch(adminReports, /supabase\.auth\.refreshSession/)
  assert.match(adminReports, /supabase\.auth\.getSession\(\)/)
})

test('transient revalidation failures keep an already verified page visible', () => {
  assert.match(app, /current\.session && current\.access[\s\S]{0,100}?error:''/)
  assert.match(app, /SESSION_VERIFICATION_RETRY_MAX_MS = 60 \* 1000/)
  assert.match(app, /2 \*\* Math\.max\(0, verificationFailures\.current - 1\)/)
  assert.match(app, /definitive server reason still reaches[\s\S]{0,100}?signs out immediately/)
  assert.match(app, /if \(verificationFailures\.current > 0\) return/)
  assert.match(app, /!navigator\.onLine[\s\S]{0,180}?current\.session && current\.access/)
})

test('parallel protected failures dispatch only one auth verification event', () => {
  assert.match(supabaseClient, /let authCheckQueued=false/)
  assert.match(supabaseClient, /AUTH_CHECK_DISPATCH_DEBOUNCE_MS=1000/)
  assert.match(supabaseClient, /requestAuthCheck\(\{terminal:failure\.terminal,reason:failure\.reason\}\)/)
  assert.match(supabaseClient, /candidateClient=createClient[\s\S]{0,320}?persistSession:false,autoRefreshToken:false,detectSessionInUrl:false/)
})

test('admin login synchronously rejects duplicate form submissions', () => {
  assert.match(adminLogin, /const submitInFlight = useRef\(false\)/)
  assert.match(adminLogin, /if \(submitInFlight\.current\) return/)
  assert.match(adminLogin, /finally \{\s*submitInFlight\.current = false/)
})
