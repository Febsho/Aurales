import { expect, test } from '@playwright/test'

test('decode failures offer worker conversion and load a signed seekable result', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('webkit'), 'WebKit does not reliably expose a synthetic decoder failure or allow its recovery overlay to be clicked.')
  const jobId = '0123456789abcdef0123456789abcdef'
  const mediaId = 'abcdef0123456789abcdef0123456789'
  const sessionUrl = `/v1/media/${mediaId}?expires=1893456000&signature=test-signature`
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mediaRemux: true, audioTranscode: true, videoTranscode: true }),
  }))
  let requestedMode = ''
  await page.route('**/v1/media/conversions', async (route) => {
    requestedMode = JSON.parse(route.request().postData() || '{}').mode
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'ready', mode: 'remux', bytes: 1024, url: sessionUrl }),
  }))
  await page.route(`**/v1/media/${mediaId}?*`, (route) => route.fulfill({ status: 503, body: 'test fixture ends after the signed URL is attached' }))

  await page.goto('/tests/browser/player-harness.html?source=' + encodeURIComponent('/tests/browser/fixtures/vp8-opus.webm'))
  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc.endsWith('/vp8-opus.webm'))).toBe(true)
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  const remuxButton = page.getByRole('button', { name: 'Try stream-copy remux' })
  await expect(remuxButton).toBeVisible()
  // Player state updates while the mocked conversion capabilities and signed
  // job status arrive; use the already-visible action without waiting for a
  // stability window on a button that is intentionally re-rendered.
  await remuxButton.click({ force: true })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => new URL(element.querySelector('source')?.src || element.currentSrc).pathname)).toBe(`/v1/media/${mediaId}`)
  expect(requestedMode).toBe('remux')
})

test('expired media-worker sessions renew while preserving playback position', async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  const firstUrl = '/v1/media/11111111111111111111111111111111?expires=1&signature=first'
  const renewedUrl = '/v1/media/22222222222222222222222222222222?expires=1893456000&signature=second'
  const firstExpiresAt = Math.floor(Date.now() / 1000) + 60
  let sessionRequests = 0
  let resolveRenewedMedia!: () => void
  const renewedMediaServed = new Promise<void>((resolve) => { resolveRenewedMedia = resolve })
  await page.route('**/v1/media/sessions', (route) => {
    sessionRequests += 1
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(sessionRequests === 1
        ? { url: firstUrl.replace('expires=1&', `expires=${firstExpiresAt}&`), expiresAt: firstExpiresAt }
        : { url: renewedUrl, expiresAt: 1_893_456_000 }),
    })
  })
  await page.route('**/v1/media/11111111111111111111111111111111?*', (route) => route.fulfill({ status: 404, body: 'expired session' }))
  await page.route('**/v1/media/22222222222222222222222222222222?*', async (route) => {
    const fixtureResponse = await route.fetch({ url: new URL('/tests/browser/fixtures/h264-aac.mp4', route.request().url()).toString() })
    await route.fulfill({ response: fixtureResponse })
    resolveRenewedMedia()
  })
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  const video = page.locator('video')
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 1.25
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 2 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc.includes('11111111111111111111111111111111'))).toBe(true)
  await expect.poll(() => sessionRequests).toBe(1)
  await page.clock.fastForward(61_000)
  await video.evaluate((element: HTMLVideoElement) => element.dispatchEvent(new Event('error')))
  await expect.poll(() => sessionRequests).toBe(2)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc.includes('22222222222222222222222222222222'))).toBe(true)
  await renewedMediaServed
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(1.2)
})
