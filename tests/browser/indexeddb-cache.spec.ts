import { expect, test } from '@playwright/test'

test('browser IndexedDB cache survives a page reload', async ({ page }) => {
  const key = `browser-cache-e2e:${crypto.randomUUID()}`
  const value = JSON.stringify({ title: 'Aurales browser cache', itemCount: 3 })
  await page.goto('/tests/browser/cache-harness.html')
  await page.evaluate(async ({ key: cacheKey, value: cacheValue }) => {
    await (window as Window & { __cacheHarness?: { set: (key: string, value: string) => Promise<boolean> } }).__cacheHarness?.set(cacheKey, cacheValue)
  }, { key, value })

  await page.reload()
  const cached = await page.evaluate((cacheKey) => (
    window as Window & { __cacheHarness?: { get: (key: string) => Promise<{ value: string } | null> } }
  ).__cacheHarness?.get(cacheKey), key)
  expect(cached?.value).toBe(value)
})
