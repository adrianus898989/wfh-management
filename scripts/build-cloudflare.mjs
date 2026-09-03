import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'

const gitCommit = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (_) {
    return 'development'
  }
}

// Cloudflare Pages exposes CF_PAGES_COMMIT_SHA automatically. GitHub keeps
// its existing SHA + workflow-attempt generation; both releases therefore
// remain traceable to the same immutable commit without coupling two hosts'
// independent deployment jobs.
process.env.VITE_APP_BASE_PATH = '/'
process.env.VITE_APP_DEPLOY_TARGET = 'cloudflare-pages'
const portalMode = String(process.env.VITE_APP_PORTAL_MODE || '').trim().toLowerCase()
if (!['admin', 'staff'].includes(portalMode)) {
  throw new Error('Cloudflare builds require VITE_APP_PORTAL_MODE=admin or staff')
}
process.env.VITE_APP_PORTAL_MODE = portalMode
process.env.VITE_APP_RELEASE_ID = String(
  process.env.CF_PAGES_COMMIT_SHA
    || process.env.VITE_APP_RELEASE_ID
    || gitCommit(),
).trim()

await build()
await import('./write-release-manifest.mjs')

// Dashboard Direct Upload does not compile a /functions directory, but it does
// deploy a top-level _worker.js. Keep the edge gate source reviewed in-tree and
// stamp the immutable portal boundary into each build so a request can never
// select admin/staff scope through URL or body input.
const workerTemplate = await readFile(
  resolve(process.cwd(), 'cloudflare/edge-gate-worker.js'),
  'utf8',
)
await writeFile(
  resolve(process.cwd(), 'dist/_worker.js'),
  workerTemplate.replaceAll('__WFH_PORTAL_MODE__', portalMode),
  'utf8',
)
