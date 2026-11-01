const CACHE = 'aurales-shell-v2'
const CACHE_PREFIX = 'aurales-shell-'
const STATIC_ASSET = /\.(?:js|css|svg|png|woff2?)$/i

function hasExpectedStaticMime(path, response) {
  if (!response || !response.ok) return false
  const mime = (response.headers.get('content-type') || '').toLowerCase()
  if (/\.m?js$/i.test(path)) return /(?:javascript|ecmascript)/.test(mime)
  if (/\.css$/i.test(path)) return mime.includes('text/css')
  if (/\.svg$/i.test(path)) return mime.includes('image/svg+xml')
  if (/\.png$/i.test(path)) return mime.includes('image/png')
  if (/\.woff2?$/i.test(path)) return /(?:font\/|application\/font|application\/octet-stream)/.test(mime)
  return false
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([
    '/', '/manifest.webmanifest', '/aurales-pwa.svg', '/aurales-pwa-192.png', '/aurales-pwa-512.png', '/apple-touch-icon.png',
  ])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Other app features may own Cache Storage entries (for example anime data).
  // Only remove prior versions of this worker's shell cache.
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)),
  )))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')))
    return
  }
  if (!STATIC_ASSET.test(url.pathname)) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const cached = await cache.match(request)
    if (hasExpectedStaticMime(url.pathname, cached)) return cached
    if (cached) await cache.delete(request)

    try {
      const response = await fetch(request)
      // SPA fallbacks return index.html with status 200 for missing chunk URLs.
      // Never poison the static cache by storing that HTML under a .js/.css URL.
      if (hasExpectedStaticMime(url.pathname, response)) {
        await cache.put(request, response.clone()).catch(() => undefined)
      }
      return response
    } catch (error) {
      const fallback = await cache.match(request)
      if (hasExpectedStaticMime(url.pathname, fallback)) return fallback
      throw error
    }
  })())
})
