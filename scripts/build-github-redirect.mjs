import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const outputDirectory = resolve(process.cwd(), 'dist')
const releaseId = String(process.env.LEGACY_REDIRECT_RELEASE_ID || '').trim()
if (!releaseId || releaseId.length > 200) {
  throw new Error('LEGACY_REDIRECT_RELEASE_ID must contain 1-200 characters')
}

// GitHub Pages is now only a legacy address. Never publish the application,
// source maps, release manifest, or API configuration there: every usable
// route must cross the Cloudflare IP gate first.
const redirectDocument = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>正在进入 WFH 系统</title>
  <script>
  (function () {
    var prefix = '/wfh-management';
    var path = location.pathname;
    if (path === prefix || path.indexOf(prefix + '/') === 0) {
      path = path.slice(prefix.length) || '/';
    }

    var admin = /^\\/(?:workspace|admin)(?:\\/|$)/.test(path);
    var host = admin
      ? 'https://wfh-workspaceexpert.pages.dev'
      : 'https://wfh-teamportal.pages.dev';

    path = path
      .replace(/^\\/admin(?=\\/|$)/, '/workspace')
      .replace(/^\\/staff(?=\\/|$)/, '/portal');
    if (!admin && (path === '/' || path === '/login')) path = '/portal/login';

    location.replace(host + path + location.search + location.hash);
  }());
  </script>
</head>
<body>
  <p>正在进入受保护的 WFH 系统……</p>
  <noscript>请启用 JavaScript 后重新打开此地址。</noscript>
</body>
</html>
`

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })
await Promise.all([
  writeFile(resolve(outputDirectory, 'index.html'), redirectDocument, 'utf8'),
  writeFile(resolve(outputDirectory, '404.html'), redirectDocument, 'utf8'),
  // Existing GitHub-hosted tabs poll this file. A new redirect-only release
  // signs them out locally before their next navigation reaches Cloudflare;
  // it deliberately does not rotate the shared database release epoch.
  writeFile(
    resolve(outputDirectory, 'release.json'),
    `${JSON.stringify({ releaseId })}\n`,
    'utf8',
  ),
])
