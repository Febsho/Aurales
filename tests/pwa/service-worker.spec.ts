import { expect, test } from '@playwright/test'

test('production PWA caches the shell and leaves API and media responses uncached', async ({ page, context }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  // The first visit installs the worker after its page resources have loaded;
  // reload once so the controlled navigation populates the runtime asset cache.
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await page.evaluate(() => fetch('/aurales-pwa.svg?runtime-cache-check'))
  const missingChunk = await page.evaluate(async () => {
    const response = await fetch('/assets/aurales-obsolete-chunk.js')
    return { status: response.status, type: response.headers.get('content-type') || '' }
  })
  expect(missingChunk.status).toBe(200) // SPA history fallback
  expect(missingChunk.type).toContain('text/html')
  await expect.poll(() => page.evaluate(async () => {
    const name = (await caches.keys()).find((key) => key.startsWith('aurales-shell-'))
    if (!name) return false
    const cache = await caches.open(name)
    return (await cache.keys()).some((request) => new URL(request.url).search.includes('runtime-cache-check'))
  })).toBe(true)

  const initialCache = await page.evaluate(async () => {
    const names = await caches.keys()
    const shellName = names.find((name) => name.startsWith('aurales-shell-'))
    if (!shellName) throw new Error('Aurales shell cache was not installed')
    const urls = (await (await caches.open(shellName)).keys()).map((request) => {
      const url = new URL(request.url)
      return `${url.pathname}${url.search}`
    })
    return { shellName, urls }
  })
  expect(initialCache.urls).toContain('/')
  expect(initialCache.urls).toContain('/manifest.webmanifest')
  expect(initialCache.urls.some((path) => path.endsWith('runtime-cache-check'))).toBe(true)
  expect(initialCache.urls.some((path) => path.includes('aurales-obsolete-chunk.js'))).toBe(false)

  await page.evaluate(async () => {
    await fetch('/api/private.json')
    await fetch('/media/sample.mp4')
  })
  const cachedPaths = await page.evaluate(async ({ shellName }) => {
    const cache = await caches.open(shellName)
    return (await cache.keys()).map((request) => new URL(request.url).pathname)
  }, { shellName: initialCache.shellName })
  expect(cachedPaths.some((path) => path.startsWith('/api/'))).toBe(false)
  expect(cachedPaths.some((path) => path.startsWith('/media/'))).toBe(false)

  await context.setOffline(true)
  await page.goto('/settings')
  await expect(page.locator('#root')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toBeVisible()
})

test('a stale lazy page chunk refreshes the deployed app route once', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('aurales_profiles_v1', JSON.stringify([{
      id: 'pwa-stale-chunk', name: 'PWA Test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isDefault: true,
    }]))
    localStorage.setItem('aurales_active_profile_v1', 'pwa-stale-chunk')
    localStorage.setItem('aurales_app_managed_metadata', 'false')
  })
  let documentLoads = 0
  page.on('load', () => { documentLoads += 1 })

  await page.goto('/series/pwa-stale-chunk')
  await page.getByRole('button', { name: /select profile/i }).click()
  await page.evaluate(() => {
    const staleChunk = new Event('vite:preloadError', { cancelable: true })
    Object.assign(staleChunk, { payload: new Error('simulated stale lazy chunk') })
    window.dispatchEvent(staleChunk)
  })
  await expect.poll(() => documentLoads, { message: 'the stale route should trigger one full-document refresh' }).toBeGreaterThanOrEqual(2)
  await page.getByRole('button', { name: /select profile/i }).click()
  await expect(page.locator('.detail-page--series')).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('aurales:web-preload-recovery'))).not.toBeNull()
})
