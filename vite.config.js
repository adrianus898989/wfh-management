import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const normalizeBasePath = value => {
  const raw = String(value || '/wfh-management/').trim()
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`
  const normalized = prefixed.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return normalized ? `${normalized}/` : '/'
}

export const createViteConfig = (environment = process.env) => {
  const target = String(environment.VITE_APP_DEPLOY_TARGET || 'github-pages').trim()
  const cloudflarePages = target === 'cloudflare-pages'
  const base = normalizeBasePath(environment.VITE_APP_BASE_PATH)
  if (cloudflarePages && base !== '/') {
    throw new Error('Cloudflare Pages builds require VITE_APP_BASE_PATH=/')
  }

  const input = { main: resolve(process.cwd(), 'index.html') }
  // Cloudflare Pages provides its native SPA fallback only when there is no
  // top-level 404.html. GitHub Pages still needs the generated redirect entry.
  if (!cloudflarePages) input.notFound = resolve(process.cwd(), '404.html')

  return {
    plugins: [react()],
    base,
    build: { rollupOptions: { input } },
  }
}

export default defineConfig(() => createViteConfig(process.env))
