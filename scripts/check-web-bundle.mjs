import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadEnv } from 'vite'

const assetsDir = join(process.cwd(), 'dist-web', 'assets')
const privateBuildValues = Object.entries(loadEnv('production', process.cwd(), ''))
  .filter(([key, value]) => /^VITE_.*(?:SECRET|TOKEN|PASSWORD)$/i.test(key) && value.length >= 8)
  .map(([, value]) => value)
const forbidden = [
  ['Tauri package import', /@tauri-apps\/(?:api|plugin)/],
  ['embedded mpv launch command', /launch_embedded_mpv/],
  ['mpv command IPC', /mpv_command/],
  ['native addon catalog IPC', /load_addon_catalog/],
  ['native addon metadata IPC', /load_addon_meta/],
  ['native artwork cache IPC', /image_cache_(?:configure|stats|clear)/],
]

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? javascriptFiles(path) : entry.name.endsWith('.js') ? [path] : []
  }))
  return files.flat()
}

const files = await javascriptFiles(assetsDir)
if (files.length === 0) throw new Error('Browser build contains no JavaScript assets')

const violations = []
for (const file of files) {
  const contents = await readFile(file, 'utf8')
  for (const [label, pattern] of forbidden) {
    if (pattern.test(contents)) violations.push(`${label}: ${file}`)
  }
  if (privateBuildValues.some((value) => contents.includes(value))) {
    violations.push(`private VITE_* credential value: ${file}`)
  }
}

if (violations.length > 0) {
  throw new Error(`Browser bundle contains desktop-only code:\n${violations.join('\n')}`)
}

console.log(`Browser bundle platform check passed (${files.length} JavaScript assets).`)
