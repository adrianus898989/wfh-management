import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import { createViteConfig } from '../../vite.config.js'

const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('all entry, router and recovery paths share the Vite base URL', async () => {
  const [vite, main, boundary, index, fallback, adminUi] = await Promise.all([
    read('vite.config.js'),
    read('src/main.jsx'),
    read('src/components/AppCrashBoundary.jsx'),
    read('index.html'),
    read('404.html'),
    read('src/adminUiV2717Fix.js'),
  ])

  assert.match(vite, /environment\.VITE_APP_BASE_PATH/)
  assert.match(vite, /'\/wfh-management\/'/)
  assert.match(vite, /if \(!cloudflarePages\) input\.notFound = resolve\(process\.cwd\(\), '404\.html'\)/)
  assert.match(main, /BrowserRouter basename=\{APP_ROUTER_BASENAME\}/)
  assert.match(boundary, /location\.replace\(`\$\{APP_BASE_URL\}\?__recover=/)
  assert.match(index, /var appBase='%BASE_URL%'/)
  assert.match(fallback, /var base='%BASE_URL%'/)
  assert.match(adminUi, /appPathname\(publicPortalTarget\('admin','employees'\)\)/)

  for (const source of [main, boundary, index, fallback, adminUi]) {
    assert.doesNotMatch(source, /['"`]\/wfh-management\//)
  }
})

test('host configs keep GitHub fallback but let Cloudflare use native SPA routing', async () => {
  const githubConfig = createViteConfig({
    VITE_APP_DEPLOY_TARGET: 'github-pages',
    VITE_APP_BASE_PATH: '/wfh-management/',
  })
  const cloudflareConfig = createViteConfig({
    VITE_APP_DEPLOY_TARGET: 'cloudflare-pages',
    VITE_APP_BASE_PATH: '/',
  })

  assert.equal(githubConfig.base, '/wfh-management/')
  assert.match(githubConfig.build.rollupOptions.input.notFound, /\/404\.html$/)
  assert.equal(cloudflareConfig.base, '/')
  assert.deepEqual(Object.keys(cloudflareConfig.build.rollupOptions.input), ['main'])
  assert.throws(
    () => createViteConfig({
      VITE_APP_DEPLOY_TARGET: 'cloudflare-pages',
      VITE_APP_BASE_PATH: '/wfh-management/',
    }),
    /require VITE_APP_BASE_PATH=\//,
  )

  await assert.rejects(
    access(new URL('public/_redirects', root)),
    error => error?.code === 'ENOENT',
  )
})

test('GitHub and Cloudflare builds preserve release traceability and real static assets', async () => {
  const [workflow, packageJson, cloudflareBuild, headers] = await Promise.all([
    read('.github/workflows/deploy-pages.yml'),
    read('package.json'),
    read('scripts/build-cloudflare.mjs'),
    read('public/_headers'),
  ])

  // GitHub retains the current deployment-generation rule; Cloudflare uses
  // the same immutable commit SHA supplied by its Git integration.
  assert.match(workflow, /VITE_APP_DEPLOY_TARGET: github-pages/)
  assert.match(workflow, /VITE_APP_BASE_PATH: \/wfh-management\//)
  assert.match(workflow, /VITE_APP_RELEASE_ID: \$\{\{ github\.sha \}\}:\$\{\{ github\.run_id \}\}:\$\{\{ github\.run_attempt \}\}/)
  assert.match(workflow, /APP_RELEASE_ID: \$\{\{ github\.sha \}\}:\$\{\{ github\.run_id \}\}:\$\{\{ github\.run_attempt \}\}/)
  assert.doesNotMatch(workflow, /cp 404\.html dist\/404\.html/)
  assert.match(packageJson, /"build:cloudflare": "node scripts\/build-cloudflare\.mjs"/)
  assert.match(cloudflareBuild, /process\.env\.CF_PAGES_COMMIT_SHA/)
  assert.match(cloudflareBuild, /process\.env\.VITE_APP_DEPLOY_TARGET = 'cloudflare-pages'/)
  assert.match(cloudflareBuild, /process\.env\.VITE_APP_BASE_PATH = '\/'/)
  assert.match(cloudflareBuild, /\['admin', 'staff'\]\.includes\(portalMode\)/)
  assert.match(cloudflareBuild, /Cloudflare builds require VITE_APP_PORTAL_MODE=admin or staff/)
  assert.doesNotMatch(cloudflareBuild, /VITE_APP_PORTAL_MODE \|\| 'both'/)
  for (const route of ['/', '/workspace', '/workspace/*', '/portal', '/portal/*', '/admin', '/admin/*', '/staff', '/staff/*']) {
    assert.match(headers, new RegExp(`(?:^|\\n)${route.replaceAll('*', '\\*')}\\n\\s+Cache-Control: no-cache, no-store, must-revalidate`))
  }
  assert.match(headers, /\/release\.json[\s\S]*Cache-Control: no-cache, no-store, must-revalidate/)
  assert.match(headers, /\/assets\/\*[\s\S]*Cache-Control: public, max-age=31536000, immutable/)
  assert.doesNotMatch(headers, /\/404\.html/)
})
