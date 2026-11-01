import { expect, test } from '@playwright/test'

test('production PWA caches the shell and leaves API and media responses uncached', async ({ page, context }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  // The first visit installs the worker after its page resources have loaded;
  // reload once so the controlled navigation populates the runtime asset cache.
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await page.evaluate(() => fetch('/aurales-pwa.svg?runtime-cache-check'))
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
