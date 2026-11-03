import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('decode failures automatically try worker conversion and load a signed seekable result', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('webkit'), 'WebKit does not reliably expose a synthetic decoder failure.')
  const jobId = '0123456789abcdef0123456789abcdef'
  const mediaId = 'abcdef0123456789abcdef0123456789'
  const sessionUrl = `/v1/media/${mediaId}?expires=1893456000&signature=test-signature&format=hls`
  const hlsSegment = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/hls-segment-000.m2ts'))
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mediaRemux: true, mediaMp4: true, mediaHls: true, audioTranscode: true, videoTranscode: true }),
  }))
  let requestedMode = ''
  let requestedOutputFormat = ''
  let workerManifestRequested = ''
  await page.route('**/v1/media/conversions', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    requestedMode = body.mode
    requestedOutputFormat = body.outputFormat
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'ready', mode: 'remux', bytes: 1024, url: requestedOutputFormat === 'mp4'
      ? '/v1/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?expires=1893456000&signature=mp4-test'
      : sessionUrl }),
  }))
  await page.route(`**/v1/media/${mediaId}?*`, (route) => {
    workerManifestRequested = route.request().url()
    const segmentUrl = `/v1/media/${mediaId}/segment.ts?expires=1893456000&signature=test-signature`
    const manifest = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:12.000000,\n${segmentUrl}\n#EXT-X-ENDLIST\n`
    return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: manifest })
  })
  await page.route(`**/v1/media/${mediaId}/segment.ts?*`, (route) => route.fulfill({ status: 200, contentType: 'video/mp2t', body: hlsSegment }))
  await page.route('**/v1/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?*', async (route) => {
    const fixtureUrl = new URL('/tests/browser/fixtures/mobile-h264-compat.mp4', route.request().url()).toString()
    const fixture = await route.fetch({ url: fixtureUrl })
    await route.fulfill({ response: fixture })
  })

  await page.goto('/tests/browser/player-harness.html?source=' + encodeURIComponent('/tests/browser/fixtures/vp8-opus.webm'))
  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc.endsWith('/vp8-opus.webm'))).toBe(true)
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect.poll(() => requestedMode).toBe('auto')
  const isAndroidBrowser = testInfo.project.name === 'android-chromium'
  expect(requestedOutputFormat).toBe(isAndroidBrowser ? 'mp4' : 'hls')
  if (isAndroidBrowser) {
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain('/v1/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?')
  } else {
    await expect.poll(() => workerManifestRequested).toContain(`/v1/media/${mediaId}?`)
    expect(workerManifestRequested).toContain('format=hls')
  }
  expect(requestedMode).toBe('auto')
})

test('mobile HLS decoder failures are converted to a native MP4 by the worker', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-chromium', 'This verifies the mobile MP4 handoff in Chromium Android.')
  const sourcePath = '/mobile-conversion-source.m3u8'
  const sourceUrl = new URL(sourcePath, String(testInfo.project.use.baseURL)).toString()
  const sourceMediaId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const outputMediaId = 'cccccccccccccccccccccccccccccccc'
  const jobId = '22222222222222222222222222222222'
  const hlsSegment = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/hls-segment-000.m2ts'))
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mediaRemux: true, mediaMp4: true, mediaHls: false, audioTranscode: true, videoTranscode: true }),
  }))
  let sourceManifestRequested = false
  await page.route(`**${sourcePath}`, (route) => {
    sourceManifestRequested = true
    return route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n/mobile-source.ts\n#EXT-X-ENDLIST\n',
    })
  })
  await page.route('**/mobile-source.ts', (route) => route.fulfill({ status: 200, contentType: 'video/mp2t', body: hlsSegment }))
  let conversionRequest: Record<string, unknown> | null = null
  await page.route('**/v1/media/conversions', async (route) => {
    conversionRequest = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'ready', mode: 'h264Aac', bytes: 1024, url: `/v1/media/${outputMediaId}?expires=1893456000&signature=mobile-mp4` }),
  }))
  await page.route(`**/v1/media/${outputMediaId}?*`, async (route) => {
    const fixture = await route.fetch({ url: new URL('/tests/browser/fixtures/mobile-h264-compat.mp4', route.request().url()).toString() })
    await route.fulfill({ response: fixture })
  })

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent(sourceUrl)}`)
  const video = page.locator('video')
  await expect.poll(() => sourceManifestRequested).toBe(true)
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect.poll(() => conversionRequest).not.toBeNull()
  expect(conversionRequest).toMatchObject({ url: sourceUrl, mode: 'auto', outputFormat: 'mp4' })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputMediaId}?`)
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration), { timeout: 15_000 }).toBeGreaterThan(2.9)
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 1.5 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 10_000 }).toBeGreaterThan(1.4)
})

test('unsupported media tries remux, AAC audio copy, then H.264/AAC automatically', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('webkit'), 'WebKit does not reliably expose a synthetic unsupported-format error.')
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mediaRemux: true, audioTranscode: true, videoTranscode: true }),
  }))
  const modes: string[] = []
  const workerManifests: string[] = []
  const jobId = '11111111111111111111111111111111'
  const workerMediaId = 'abcdef0123456789abcdef0123456789'
  const hlsSegment = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/hls-segment-000.m2ts'))
  await page.route('**/v1/media/conversions', async (route) => {
    const mode = JSON.parse(route.request().postData() || '{}').mode as string
    modes.push(mode)
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route('**/v1/media/conversions/*', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId, status: 'ready', mode: 'h264Aac', bytes: 1024, url: new URL('/v1/media/abcdef0123456789abcdef0123456789?expires=1893456000&signature=test&format=hls', route.request().url()).toString() }),
    })
  })
  await page.route('**/v1/media/abcdef0123456789abcdef0123456789?*', (route) => {
    workerManifests.push(route.request().url())
    const segmentUrl = `/v1/media/${workerMediaId}/segment.ts?expires=1893456000&signature=test`
    const manifest = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:12.000000,\n${segmentUrl}\n#EXT-X-ENDLIST\n`
    return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: manifest })
  })
  await page.route(`**/v1/media/${workerMediaId}/segment.ts?*`, (route) => route.fulfill({ status: 200, contentType: 'video/mp2t', body: hlsSegment }))
  await page.goto('/tests/browser/player-harness.html?source=' + encodeURIComponent('/tests/browser/fixtures/vp8-opus.webm'))
  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc.endsWith('/vp8-opus.webm'))).toBe(true)
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 4 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect.poll(() => modes.length).toBe(1)
  expect(modes).toEqual(['auto'])
  await expect.poll(() => workerManifests.length).toBeGreaterThan(0)
  expect(workerManifests[0]).toContain('format=hls')
})

test('mobile decoder failures escalate through lower H.264 profiles', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-chromium', 'This verifies the mobile H.264 fallback ladder in Chromium Android.')
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mediaRemux: true, mediaMp4: true, mediaHls: false, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  const modes: string[] = []
  const jobIds: Record<string, string> = {
    auto: '33333333333333333333333333333333',
    h264AacLow: '44444444444444444444444444444444',
    h264AacCompat: '55555555555555555555555555555555',
  }
  const outputIds: Record<string, string> = {
    auto: '66666666666666666666666666666666',
    h264AacLow: '77777777777777777777777777777777',
    h264AacCompat: '88888888888888888888888888888888',
  }
  await page.route('**/v1/media/conversions', async (route) => {
    const mode = JSON.parse(route.request().postData() || '{}').mode as string
    modes.push(mode)
    const jobId = jobIds[mode]
    if (!jobId) return route.fulfill({ status: 400, body: 'unexpected conversion mode' })
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  for (const [mode, jobId] of Object.entries(jobIds)) {
    await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId, status: 'ready', mode: mode === 'auto' ? 'h264Aac' : mode, bytes: 1024, url: `/v1/media/${outputIds[mode]}?expires=1893456000&signature=${mode}` }),
    }))
    await page.route(`**/v1/media/${outputIds[mode]}?*`, async (route) => {
      const fixture = await route.fetch({ url: new URL('/tests/browser/fixtures/mobile-h264-compat.mp4', route.request().url()).toString() })
      await route.fulfill({ response: fixture })
    })
  }

  await page.goto('/tests/browser/player-harness.html?source=' + encodeURIComponent('/tests/browser/fixtures/vp8-opus.webm'))
  const video = page.locator('video')
  const triggerDecoderFailure = () => video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc.endsWith('/vp8-opus.webm'))).toBe(true)
  await triggerDecoderFailure()
  await expect.poll(() => modes.length).toBe(1)
  expect(modes).toEqual(['auto'])
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputIds.auto}?`)
  await triggerDecoderFailure()
  await expect.poll(() => modes.length).toBe(2)
  expect(modes).toEqual(['auto', 'h264AacLow'])
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputIds.h264AacLow}?`)
  await triggerDecoderFailure()
  await expect.poll(() => modes.length).toBe(3)
  expect(modes).toEqual(['auto', 'h264AacLow', 'h264AacCompat'])
})

test('mobile DASH sources go straight to a worker MP4 and play', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'DASH-to-MP4 handoff is checked in mobile browser projects.')
  const sourceUrl = new URL('/mobile-dash-source.mpd', String(testInfo.project.use.baseURL)).toString()
  const jobId = '99999999999999999999999999999999'
  const mediaId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  await page.route('**/v1/capabilities', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mediaRemux: true, mediaMp4: true, mediaHls: false, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
    })
  })
  let conversionRequest: Record<string, unknown> | null = null
  await page.route('**/v1/media/conversions', async (route) => {
    conversionRequest = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'ready', mode: 'h264AacCompat', bytes: 1024, url: `/v1/media/${mediaId}?expires=1893456000&signature=mobile-dash` }),
  }))
  await page.route(`**/v1/media/${mediaId}?*`, async (route) => {
    const fixture = await route.fetch({ url: new URL('/tests/browser/fixtures/mobile-h264-compat.mp4', route.request().url()).toString() })
    await route.fulfill({ response: fixture })
  })

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent(sourceUrl)}`)
  const video = page.locator('video')
  await expect.poll(() => conversionRequest).not.toBeNull()
  expect(conversionRequest).toMatchObject({ url: sourceUrl, mode: 'auto', outputFormat: 'mp4', mobileCompatibility: true })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${mediaId}?`)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration), { timeout: 15_000 }).toBeGreaterThan(2.9)
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 1.5 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 10_000 }).toBeGreaterThan(1.4)
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
