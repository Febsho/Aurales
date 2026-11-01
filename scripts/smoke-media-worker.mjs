const workerUrl = process.env.AURALES_MEDIA_WORKER_URL?.trim()
const apiKey = process.env.AURALES_MEDIA_API_KEY
const appOrigin = process.env.AURALES_MEDIA_SMOKE_ORIGIN?.trim()
const mediaUrl = process.env.AURALES_MEDIA_SMOKE_URL?.trim()

if (!workerUrl || !apiKey || !appOrigin) {
  throw new Error('Set AURALES_MEDIA_WORKER_URL, AURALES_MEDIA_API_KEY, and AURALES_MEDIA_SMOKE_ORIGIN.')
}
if (apiKey.length < 32) throw new Error('AURALES_MEDIA_API_KEY must contain at least 32 characters.')

const base = new URL(workerUrl)
if (base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
  (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
  throw new Error('AURALES_MEDIA_WORKER_URL must be an HTTPS origin (localhost is allowed for development).')
}
const origin = new URL(appOrigin)
if (origin.origin !== appOrigin || (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
  throw new Error('AURALES_MEDIA_SMOKE_ORIGIN must be an exact HTTPS origin (localhost is allowed for development).')
}

async function request(path, init = {}) {
  return fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(15_000) })
}

const healthResponse = await request('/health')
const health = await healthResponse.json()
if (!healthResponse.ok || health.status !== 'ok' || health.streamRanking !== true) {
  throw new Error(`Worker health check failed (${healthResponse.status}).`)
}

const unauthenticated = await request('/v1/capabilities')
if (unauthenticated.status !== 401) throw new Error('Worker capabilities endpoint did not reject a missing API key.')

const authorized = await request('/v1/capabilities', {
  headers: { Authorization: `Bearer ${apiKey}`, Origin: origin.origin },
})
const capabilities = await authorized.json()
if (!authorized.ok || capabilities.streamRanking !== true) {
  throw new Error(`Authenticated capabilities check failed (${authorized.status}).`)
}

const preflight = await request('/v1/capabilities', {
  method: 'OPTIONS',
  headers: {
    Origin: origin.origin,
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'authorization',
  },
})
if (!preflight.ok || preflight.headers.get('access-control-allow-origin') !== origin.origin) {
  throw new Error('Worker CORS does not allow the configured Aurales app origin.')
}

console.log('Worker health, API-key enforcement, capabilities, and configured-origin CORS passed.')

if (mediaUrl) {
  const source = new URL(mediaUrl)
  if (source.protocol !== 'https:') throw new Error('AURALES_MEDIA_SMOKE_URL must use HTTPS.')
  const sessionResponse = await request('/v1/media/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Origin: origin.origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: source.toString() }),
  })
  const session = await sessionResponse.json()
  if (!sessionResponse.ok || typeof session.url !== 'string' || typeof session.expiresAt !== 'number') {
    throw new Error(`Signed media session check failed (${sessionResponse.status}). Verify the media host allowlist.`)
  }
  const signedUrl = new URL(session.url, `${base.origin}/`)
  if (signedUrl.origin !== base.origin || !/^\/v1\/media\/[a-f\d]{32}$/i.test(signedUrl.pathname) ||
    !signedUrl.searchParams.has('signature') || !signedUrl.searchParams.has('expires')) {
    throw new Error('Worker returned an invalid signed media URL.')
  }

  const ranged = await fetch(signedUrl, {
    headers: { Origin: origin.origin, Range: 'bytes=0-15' },
    signal: AbortSignal.timeout(15_000),
  })
  const bytes = await ranged.arrayBuffer()
  if (ranged.status !== 206 || bytes.byteLength !== 16 ||
    !ranged.headers.get('content-range')?.startsWith('bytes 0-15/') ||
    ranged.headers.get('access-control-allow-origin') !== origin.origin) {
    throw new Error(`Signed media Range/CORS check failed (${ranged.status}).`)
  }

  signedUrl.searchParams.set('signature', '0'.repeat(64))
  const tampered = await fetch(signedUrl, { headers: { Range: 'bytes=0-15' }, signal: AbortSignal.timeout(15_000) })
  if (tampered.status !== 404) throw new Error('Worker did not reject a tampered media-session signature.')
  console.log('Allowlisted signed playback, byte ranges, media CORS, and signature rejection passed.')
}
