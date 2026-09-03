import { execFileSync } from 'node:child_process'
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
process.env.VITE_APP_RELEASE_ID = String(
  process.env.CF_PAGES_COMMIT_SHA
    || process.env.VITE_APP_RELEASE_ID
    || gitCommit(),
).trim()

await build()
await import('./write-release-manifest.mjs')
