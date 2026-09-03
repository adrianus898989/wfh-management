import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  APP_RELEASE_ID,
  APP_RELEASE_POLL_JITTER_MS,
  APP_RELEASE_POLL_MS,
  appReleasePollDelay,
  clearRegisteredAppRelease,
  currentAppReleaseIsRegistered,
  fetchPublishedAppReleaseId,
  registerCurrentAppRelease,
} from './releaseSession.js'

const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

const migration = await read('supabase/migrations/20260827111900_release_session_epoch.sql')
const app = await read('src/App.jsx')
const adminLogin = await read('src/pages/AdminLoginPage.jsx')
const staffLogin = await read('src/pages/StaffLoginPage.jsx')
const workflow = await read('.github/workflows/deploy-pages.yml')
const packageJson = await read('package.json')
const manifestWriter = await read('scripts/write-release-manifest.mjs')
const githubRedirectBuilder = await read('scripts/build-github-redirect.mjs')

const functionBody = signature => {
  const start = migration.indexOf(signature)
  assert.notEqual(start, -1, `missing ${signature}`)
  const end = migration.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `missing terminator for ${signature}`)
  return migration.slice(start, end)
}

test('release generation is server-owned and bound to both Auth sessions and app leases', () => {
  assert.match(migration, /create table if not exists session_private\.app_release_state/)
  assert.match(migration, /add column if not exists release_epoch bigint not null/)
  assert.match(migration, /auth_session\.created_at>=state\.activated_at/)
  assert.match(migration, /lease\.release_epoch=state\.current_epoch/)
  assert.match(migration, /revoke all on table session_private\.app_release_state[\s\S]+service_role/)
})

test('claim, bootstrap and heartbeat reject pre-release sessions with a terminal reason', () => {
  for (const signature of [
    'create or replace function session_private.app_session_claim(',
    'create or replace function session_private.app_session_heartbeat()',
    'create or replace function session_private.app_session_bootstrap_access()',
  ]) {
    const body = functionBody(signature)
    assert.match(body, /auth_session_matches_current_release/)
    assert.match(body, /'reason','release_updated'/)
  }
  assert.match(functionBody('create or replace function session_private.app_session_claim('), /set release_epoch=v_epoch/)
})

test('migration replay retains delegates and does not repeat the bootstrap logout', () => {
  assert.match(migration, /to_regprocedure\('session_private\.app_session_claim_release_inner_v1\(text\)'\) is null/)
  assert.match(migration, /create or replace function session_private\.app_session_claim/)
  const bootstrap = migration.slice(
    migration.indexOf('do $release_epoch_bootstrap$'),
    migration.indexOf('$release_epoch_bootstrap$;', migration.indexOf('do $release_epoch_bootstrap$')),
  )
  assert.match(bootstrap, /on conflict\(singleton\) do nothing/)
  assert.match(bootstrap, /if found then[\s\S]+delete from public\.app_session_leases/)
})

test('the ubiquitous validity helper is replaced in-place so stored RPC and RLS dependencies cannot bypass the epoch', () => {
  assert.doesNotMatch(migration, /alter function session_private\.current_app_session_is_valid\(text\)[\s\S]{0,80}rename/)
  const body = functionBody('create or replace function session_private.current_app_session_is_valid(')
  assert.match(body, /lease\.release_epoch=state\.current_epoch/)
  assert.match(body, /auth_session\.created_at>=state\.activated_at/)
  assert.match(body, /staff_portal_account_exists/)
  assert.match(body, /current_admin_ip_attestation_is_valid/)
  assert.match(body, /v_aal='aal2'/)
})

test('deployment advance is idempotent, service-role-only and immediately removes every Edge-visible lease', () => {
  const body = functionBody('create or replace function public.app_release_advance(')
  assert.match(body, /if v_state\.release_id=v_release_id/)
  assert.match(body, /current_epoch=state\.current_epoch\+1/)
  assert.match(body, /delete from public\.app_session_leases/)
  assert.match(migration, /revoke all on function public\.app_release_advance\(text\)[\s\S]{0,100}from public,anon,authenticated,service_role/)
  assert.match(migration, /grant execute on function public\.app_release_advance\(text\)[\s\S]{0,50}to service_role/)
})

test('legacy GitHub Pages publishes only a Cloudflare redirect and cannot rotate live app sessions', () => {
  assert.match(workflow, /uses: actions\/deploy-pages@v4/)
  assert.match(workflow, /npm run build:github-redirect/)
  assert.doesNotMatch(workflow, /npm run build(?:\s|$)/)
  assert.doesNotMatch(workflow, /VITE_SUPABASE|SUPABASE_SERVICE_ROLE_KEY|app_release_advance|APP_RELEASE_ID/)
  assert.match(packageJson, /"build:github-redirect": "node scripts\/build-github-redirect\.mjs"/)
  assert.match(githubRedirectBuilder, /await rm\(outputDirectory, \{ recursive: true, force: true \}\)/)
  assert.match(githubRedirectBuilder, /wfh-workspaceexpert\.pages\.dev/)
  assert.match(githubRedirectBuilder, /wfh-teamportal\.pages\.dev/)
  assert.doesNotMatch(githubRedirectBuilder, /release\.json|VITE_SUPABASE|src\/main/)
  assert.match(packageJson, /vite build && node scripts\/write-release-manifest\.mjs/)
  assert.match(manifestWriter, /resolve\(outputDirectory, 'release\.json'\)/)
  assert.match(manifestWriter, /JSON\.stringify\(\{ releaseId \}\)/)
})

test('both portals clear the local session and explain that the system was updated', () => {
  assert.match(app, /'release_updated'/)
  assert.match(app, /reason==='release_updated'[\s\S]{0,80}'system_updated'/)
  assert.match(adminLogin, /notice === 'system_updated'[\s\S]{0,80}系统已更新，请重新登录/)
  assert.match(staffLogin, /sessionNotice === 'system_updated'[\s\S]{0,100}auth\.systemUpdated/)
})

test('new pages reject an authenticated browser without the current local release registration', () => {
  assert.match(app, /data\?\.session && !currentAppReleaseIsRegistered\(portal\)/)
  assert.match(app, /clearRegisteredAppRelease\(portal\)[\s\S]{0,100}discardLocalAppSession/)
  assert.match(adminLogin, /registerCurrentAppRelease\('admin'\)/)
  assert.match(staffLogin, /registerCurrentAppRelease\('staff'\)/)
})

test('open pages poll an uncached release manifest on a jittered two-minute cadence', async () => {
  assert.equal(APP_RELEASE_POLL_MS, 120_000)
  assert.equal(APP_RELEASE_POLL_JITTER_MS, 30_000)
  assert.equal(appReleasePollDelay(() => 0), 120_000)
  assert.equal(appReleasePollDelay(() => 0.5), 135_000)
  assert.equal(appReleasePollDelay(() => 1), 150_000)
  assert.match(app, /window\.setTimeout\(async \(\) => \{[\s\S]{0,180}appReleasePollDelay\(\)/)
  assert.match(app, /visibilitychange[\s\S]{0,180}focus[\s\S]{0,180}online/)
  let request
  const published = await fetchPublishedAppReleaseId({
    baseUrl: 'https://example.test/wfh-management/',
    now: 1234,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, json: async () => ({ releaseId: 'published-2' }) }
    },
  })
  assert.equal(published, 'published-2')
  assert.equal(request.url, 'https://example.test/wfh-management/release.json?release_check=1234')
  assert.equal(request.options.cache, 'no-store')
})

test('successful login registration is portal-scoped and removable', () => {
  const values = new Map()
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  const previousWindow = globalThis.window
  const previousCustomEvent = globalThis.CustomEvent
  globalThis.window = { localStorage: storage, sessionStorage: storage, dispatchEvent: () => {} }
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail } }
  try {
    assert.equal(currentAppReleaseIsRegistered('admin'), false)
    registerCurrentAppRelease('admin')
    assert.equal(currentAppReleaseIsRegistered('admin'), true)
    assert.equal(currentAppReleaseIsRegistered('staff'), false)
    assert.ok(APP_RELEASE_ID)
    clearRegisteredAppRelease('admin')
    assert.equal(currentAppReleaseIsRegistered('admin'), false)
  } finally {
    globalThis.window = previousWindow
    globalThis.CustomEvent = previousCustomEvent
  }
})
