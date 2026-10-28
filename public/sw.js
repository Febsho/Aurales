const CACHE = 'aurales-shell-v1'
const CACHE_PREFIX = 'aurales-shell-'
const STATIC_ASSET = /\.(?:js|css|svg|png|woff2?)$/i

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
  event.respondWith(caches.match(request).then(async (cached) => {
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok) {
      await caches.open(CACHE)
        .then((cache) => cache.put(request, response.clone()))
        .catch(() => undefined)
    }
    return response
  }))
})
