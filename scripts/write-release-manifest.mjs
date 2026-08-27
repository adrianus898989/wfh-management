import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const releaseId = String(process.env.VITE_APP_RELEASE_ID || 'development').trim()
if (!releaseId || releaseId.length > 200) {
  throw new Error('VITE_APP_RELEASE_ID must contain 1-200 characters')
}

const outputDirectory = resolve(process.cwd(), 'dist')
await mkdir(outputDirectory, { recursive: true })
await writeFile(
  resolve(outputDirectory, 'release.json'),
  `${JSON.stringify({ releaseId })}\n`,
  'utf8',
)
