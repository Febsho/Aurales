import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const [sourcePath, outputPath] = process.argv.slice(2)
if (!sourcePath || !outputPath) throw new Error('Usage: node scripts/generate-netflix-avatar-catalog.mjs <source.js> <output.json>')
const source = readFileSync(sourcePath, 'utf8')
const catalogSource = source.slice(source.indexOf('const ICON_DATABASE = {'), source.indexOf('const AVATAR_IMAGE_URLS = {'))
const urlsSource = source.slice(source.indexOf('const AVATAR_IMAGE_URLS = {'))
const imageUrls = new Map([...urlsSource.matchAll(/"([0-9a-f-]{36})":\s*"(https:\/\/[^\"]+)"/gi)].map(([, id, url]) => [id, url]))
const entries = []
for (const category of catalogSource.matchAll(/^\s*"([^\"]+)":\s*\[([\s\S]*?)^\s*\],?$/gm)) {
  const [, show, body] = category
  for (const entry of body.matchAll(/\{\s*name:\s*"([^\"]+)",\s*key:\s*"AVATAR\|([0-9a-f-]{36})\|([^|]+)\|([^|]+)\|([^\"]+)"\s*\}/g)) {
    const [, name, id, locale, country, showId] = entry
    const imageUrl = imageUrls.get(id)
    if (imageUrl) entries.push({ id, name, category: show, show, showId, locale, country, imageUrl, source: 'netflix-retired' })
  }
}
const seen = new Set()
const normalized = entries.filter((entry) => !seen.has(entry.id) && seen.add(entry.id)).sort((a, b) => a.show.localeCompare(b.show) || a.name.localeCompare(b.name))
mkdirSync(outputPath.slice(0, outputPath.lastIndexOf('/')), { recursive: true })
writeFileSync(outputPath, JSON.stringify({ version: 1, source: 'https://github.com/Angel2mp3/Bring-Back-Netflix-Icons', avatars: normalized }, null, 2) + '\n')
console.log(`Generated ${normalized.length} avatars from ${entries.length} catalog entries.`)
