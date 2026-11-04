import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('mobile converts a signed HEVC Main 10 source as soon as the browser rejects its codec profile', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Codec-profile auto conversion is checked on mobile browser projects.')
  const jobId = 'abababababababababababababababab'
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', {
      configurable: true,
      value: (type: string) => type.includes('hvc1.2.4.L120.B0') ? '' : 'maybe',
    })
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mediaRemux: true, mediaMp4: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  let conversionRequest: Record<string, unknown> | null = null
  await page.route('**/v1/media/conversions', async (route) => {
    conversionRequest = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ jobId, status: 'processing' }),
    })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'failed', error: 'source_unavailable', sourceHost: 'cdn-redirect.example' }),
  }))

  const source = '/tests/browser/fixtures/signed-stream?token=redacted'
    + '&container=mp4&videoCodec=' + encodeURIComponent('HEVC (Main 10)')
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent(source)}`)
  const appReferer = await page.evaluate(() => `${location.origin}/`)
  await expect.poll(() => conversionRequest).not.toBeNull()
  expect(conversionRequest).toMatchObject({ mode: 'h264Aac', outputFormat: 'mp4', mobileCompatibility: true })
  expect(conversionRequest).toMatchObject({ headers: { referer: appReferer } })
  await expect(page.getByRole('alert')).toContainText('Source host: cdn-redirect.example.')
  await expect(page.getByRole('alert')).not.toContainText('redacted')
})

test('mobile converts when Media Capabilities predicts a known profile will not play smoothly', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Media Capabilities fallback is checked on mobile browsers.')
  const jobId = 'acacacacacacacacacacacacacacacac'
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', {
      configurable: true,
      value: () => 'maybe',
    })
    Object.defineProperty(navigator, 'mediaCapabilities', {
      configurable: true,
      value: {
        decodingInfo: async () => ({ supported: true, smooth: false, powerEfficient: false }),
      },
    })
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mediaRemux: true, mediaMp4: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  let conversionRequest: Record<string, unknown> | null = null
  await page.route('**/v1/media/conversions', (route) => {
    conversionRequest = JSON.parse(route.request().postData() || '{}')
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'failed', error: 'source_forbidden' }),
  }))

  const query = new URLSearchParams({
    source: '/tests/browser/fixtures/signed-stream?token=redacted',
    container: 'mp4',
    videoCodec: 'HEVC (Main 10)',
    audioCodec: 'AAC',
    resolution: '1920x1080',
  })
  await page.goto(`/tests/browser/player-harness.html?${query}`)
  await expect.poll(() => conversionRequest).toMatchObject({ mode: 'h264AacLow', outputFormat: 'mp4', mobileCompatibility: true })
})

test('mobile explains when the worker blocks a source host before conversion starts', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Worker source-host diagnostics are checked on mobile browsers.')
  await page.setViewportSize({ width: 393, height: 852 })
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', {
      configurable: true,
      value: (type: string) => type.includes('hvc1.2.4.L120.B0') ? '' : 'maybe',
    })
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mediaRemux: true, mediaMp4: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  const conversionModes: string[] = []
  await page.route('**/v1/media/conversions', (route) => {
    conversionModes.push(String(JSON.parse(route.request().postData() || '{}').mode))
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'media_host_not_allowed' }),
    })
  })

  const query = new URLSearchParams({
    source: 'https://signed.cdn.example/stream?token=redacted',
    container: 'mp4',
    videoCodec: 'HEVC (Main 10)',
  })
  await page.goto(`/tests/browser/player-harness.html?${query}`)
  await expect(page.getByRole('alert')).toContainText('AURALES_MEDIA_ALLOWED_HOSTS')
  await expect(page.getByRole('alert')).toContainText('signed.cdn.example')
  await expect(page.locator('.inapp-player-error-message')).toHaveCount(1)
  await expect(page.locator('.inapp-player-controls')).toBeVisible()
  const [errorPanel, playerControls] = await Promise.all([
    page.getByRole('alert').boundingBox(),
    page.locator('.inapp-player-controls').boundingBox(),
  ])
  expect(errorPanel).not.toBeNull()
  expect(playerControls).not.toBeNull()
  expect(errorPanel!.y + errorPanel!.height).toBeLessThan(playerControls!.y)
  await expect(page.getByRole('button', { name: 'Convert for this device' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Convert audio to AAC' })).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('Changing the conversion profile will not fix access')
  await expect.poll(() => conversionModes).toEqual(['h264Aac'])
})

test('mobile startup silence starts worker conversion without waiting for a media error', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Silent startup recovery is checked on mobile browsers.')
  await page.clock.install()
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    HTMLMediaElement.prototype.play = () => Promise.resolve()
  })
  await page.route('**/startup-stall.mp4', () => new Promise<void>(() => {}))
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mediaRemux: true, mediaMp4: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  let conversionRequest: Record<string, unknown> | null = null
  await page.route('**/v1/media/conversions', (route) => {
    conversionRequest = JSON.parse(route.request().postData() || '{}')
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 'abababababababababababababababab', status: 'processing' }) })
  })
  await page.route('**/v1/media/conversions/abababababababababababababababab', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId: 'abababababababababababababababab', status: 'failed', error: 'source_forbidden' }),
  }))

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/startup-stall.mp4')}`)
  await expect(page.locator('video')).toBeAttached()
  await page.clock.fastForward(5_001)
  await expect.poll(() => conversionRequest).toMatchObject({ mode: 'auto', outputFormat: 'mp4', mobileCompatibility: true })
})

test('mobile decode failures automatically convert to a signed, seekable MP4', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'The MP4 output assertion is specific to mobile browser compatibility mode.')
  const jobId = '0123456789abcdef0123456789abcdef'
  const mediaId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const mobileFixture = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/mobile-h264-compat.mp4'))
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
  await page.route('**/v1/media/conversions', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    requestedMode = body.mode
    requestedOutputFormat = body.outputFormat
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'ready', mode: 'h264AacCompat', bytes: mobileFixture.length, url: `/v1/media/${mediaId}?expires=1893456000&signature=mp4-test` }),
  }))
  await page.route(`**/v1/media/${mediaId}?*`, (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: mobileFixture }))
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
  await expect.poll(() => requestedMode).toBe('h264Aac')
  expect(requestedOutputFormat).toBe('mp4')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${mediaId}?`)
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  expect(requestedMode).toBe('h264Aac')
})

test('mobile worker conversion can be retried from the failure panel', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'The mobile failure-panel retry is checked on mobile browsers.')
  const firstJobId = '10101010101010101010101010101010'
  const secondJobId = '20202020202020202020202020202020'
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mediaDirectProxy: true, mediaRemux: true, mediaMp4: true, audioTranscode: true, videoTranscode: true }),
  }))
  let conversionStarts = 0
  await page.route('**/v1/media/conversions', async (route) => {
    conversionStarts += 1
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: conversionStarts === 1 ? firstJobId : secondJobId, status: 'processing' }),
    })
  })
  await page.route('**/v1/media/conversions/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId: route.request().url().split('/').at(-1), status: 'failed', error: 'source_forbidden' }),
  }))

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/vp8-opus.webm')}`)
  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc.endsWith('/vp8-opus.webm'))).toBe(true)
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect.poll(() => conversionStarts).toBe(1)
  const retry = page.getByRole('button', { name: 'Convert for this device' })
  await expect(retry).toBeVisible()
  await retry.click()
  await expect.poll(() => conversionStarts).toBe(2)
  await expect(retry).toBeVisible()
})

test('mobile failure panel can reconnect and convert after the worker capability check fails', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'This recovery action is verified in mobile browsers.')
  const jobId = '21212121212121212121212121212121'
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  let capabilityChecks = 0
  await page.route('**/v1/capabilities', (route) => {
    capabilityChecks += 1
    if (capabilityChecks <= 3) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'worker_unavailable' }) })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mediaDirectProxy: true, mediaRemux: true, mediaMp4: true, audioTranscode: true, videoTranscode: true }),
    })
  })
  let conversionStarts = 0
  await page.route('**/v1/media/conversions', async (route) => {
    conversionStarts += 1
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'failed', error: 'source_forbidden' }),
  }))

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/vp8-opus.webm')}`)
  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc.endsWith('/vp8-opus.webm'))).toBe(true)
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  const retry = page.getByRole('button', { name: 'Convert for this device' })
  await expect(retry).toBeVisible()
  await expect(page.getByText('Aurales could not check the media worker yet.')).toBeVisible()
  await retry.click()
  await expect.poll(() => capabilityChecks).toBe(4)
  await expect.poll(() => conversionStarts).toBe(1)
})

test('mobile retry action remains tappable in the landscape error panel after conversion fails', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Landscape error-panel interaction is checked on iOS and Android.')
  const jobIds = [
    '31313131313131313131313131313131',
    '32323232323232323232323232323232',
  ]
  await page.setViewportSize({ width: 852, height: 393 })
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', {
      configurable: true,
      value: (type: string) => type.includes('vp8.0') ? '' : 'maybe',
    })
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mediaDirectProxy: true, mediaRemux: true, mediaMp4: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  let conversionStarts = 0
  const requestedModes: string[] = []
  await page.route('**/v1/media/conversions', async (route) => {
    conversionStarts += 1
    requestedModes.push(String(JSON.parse(route.request().postData() || '{}').mode))
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: jobIds[Math.min(conversionStarts - 1, jobIds.length - 1)], status: 'processing' }),
    })
  })
  await page.route('**/v1/media/conversions/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId: route.request().url().split('/').at(-1), status: 'failed', error: 'source_forbidden' }),
  }))

  await page.route('https://cdn.example/vp8-opus.webm', (route) => route.fulfill({ status: 403, body: 'source denied' }))
  const sourceUrl = 'https://cdn.example/vp8-opus.webm'
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent(sourceUrl)}`)
  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement, source) => element.currentSrc === source, sourceUrl)).toBe(true)
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect.poll(() => conversionStarts).toBe(1)
  const panel = page.getByRole('alert')
  const retry = page.getByRole('button', { name: 'Convert for this device' })
  await expect(panel).toBeVisible()
  await expect(retry).toBeVisible()
  const panelBox = await panel.boundingBox()
  const retryBox = await retry.boundingBox()
  expect(panelBox).not.toBeNull()
  expect(retryBox).not.toBeNull()
  expect(retryBox!.x).toBeGreaterThanOrEqual(panelBox!.x)
  expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width)
  await retry.tap()
  await expect.poll(() => conversionStarts).toBe(2)
  expect(requestedModes).toHaveLength(2)
  expect(['h264Aac', 'auto']).toContain(requestedModes[0])
  expect(requestedModes[1]).toBe('auto')
})

test('mobile retry action remains tappable in the portrait error panel after conversion fails', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Portrait error-panel interaction is checked on iOS and Android.')
  await page.setViewportSize({ width: 393, height: 852 })
  const jobIds = [
    '41414141414141414141414141414141',
    '42424242424242424242424242424242',
  ]
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mediaDirectProxy: true, mediaRemux: true, mediaMp4: true, audioTranscode: true, videoTranscode: true }),
  }))
  let conversionStarts = 0
  await page.route('**/v1/media/conversions', (route) => {
    const jobId = jobIds[Math.min(conversionStarts++, jobIds.length - 1)]
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route('**/v1/media/conversions/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId: route.request().url().split('/').at(-1), status: 'failed', error: 'source_forbidden' }),
  }))

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/vp8-opus.webm')}`)
  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc.endsWith('/vp8-opus.webm'))).toBe(true)
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect.poll(() => conversionStarts).toBe(1)
  const panel = page.getByRole('alert')
  const retry = page.getByRole('button', { name: 'Convert for this device' })
  await expect(panel).toBeVisible()
  const panelBox = await panel.boundingBox()
  const retryBox = await retry.boundingBox()
  const viewport = page.viewportSize()!
  expect(panelBox).not.toBeNull()
  expect(retryBox).not.toBeNull()
  expect(panelBox!.x).toBeGreaterThanOrEqual(0)
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport.width)
  expect(panelBox!.y).toBeGreaterThanOrEqual(0)
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(viewport.height)
  expect(retryBox!.x).toBeGreaterThanOrEqual(panelBox!.x)
  expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width)
  await retry.tap()
  await expect.poll(() => conversionStarts).toBe(2)
})

test('mobile switches converted MP4 audio by preparing the selected source track', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Mobile browser audio switching is verified on iOS and Android.')
  const jobIds = [
    '30303030303030303030303030303030',
    '40404040404040404040404040404040',
    '41414141414141414141414141414141',
  ]
  const outputIds = [
    '50505050505050505050505050505050',
    '60606060606060606060606060606060',
    '61616161616161616161616161616161',
  ]
  const fixture = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/mobile-h264-compat.mp4'))
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mediaDirectProxy: true, mediaRemux: true, mediaMp4: true, audioTranscode: true, videoTranscode: true }),
  }))
  const conversionRequests: Array<Record<string, unknown>> = []
  let releaseFallbackConversion = false
  await page.route('**/v1/media/conversions', async (route) => {
    conversionRequests.push(JSON.parse(route.request().postData() || '{}'))
    const index = conversionRequests.length - 1
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: jobIds[index], status: 'processing' }),
    })
  })
  for (const index of [0, 1, 2]) {
    await page.route(`**/v1/media/conversions/${jobIds[index]}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(index === 1
        ? { jobId: jobIds[index], status: 'failed', error: 'no_compatible_output' }
        : index === 2 && !releaseFallbackConversion
        ? { jobId: jobIds[index], status: 'processing' }
        : {
          jobId: jobIds[index],
          status: 'ready',
          mode: index === 2 ? 'audioAac' : 'remux',
          bytes: fixture.length,
          url: `/v1/media/${outputIds[index]}?expires=1893456000&signature=audio-${index}`,
          subtitles: [
            { url: `/v1/media/${outputIds[index]}/${outputIds[index]}-subtitle-2.vtt?expires=1893456000&signature=subtitle-${index}`, lang: 'eng', label: 'English', forced: false },
            { url: `/v1/media/${outputIds[index]}/${outputIds[index]}-subtitle-3.vtt?expires=1893456000&signature=subtitle-${index}`, lang: 'fra', label: 'French', forced: false },
          ],
          sourceInfo: {
            container: 'matroska,webm',
            streams: [
              { codec_type: 'video', codec_name: 'h264' },
              { codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } },
              { codec_type: 'audio', codec_name: 'aac', tags: { language: 'fra', title: 'French' } },
            ],
          },
        }),
    }))
    await page.route(`**/v1/media/${outputIds[index]}?*`, (route) => route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      body: fixture,
    }))
    await page.route(`**/v1/media/${outputIds[index]}/${outputIds[index]}-subtitle-*.vtt*`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/vtt; charset=utf-8',
      body: 'WEBVTT\n\n00:00:00.100 --> 00:00:00.900\nSubtitle fixture\n',
    }))
  }

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/vp8-opus.webm')}`)
  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc.endsWith('/vp8-opus.webm'))).toBe(true)
  await page.getByRole('button', { name: 'Subtitle tracks' }).click()
  await expect.poll(() => conversionRequests.length).toBe(1)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement, outputId: string) => element.currentSrc.includes(outputId), outputIds[0])).toBe(true)
  await page.getByRole('menuitemradio', { name: 'French' }).click()
  await page.getByRole('button', { name: 'Audio tracks' }).click()
  const frenchTrack = page.getByRole('menuitemradio', { name: 'French' })
  await expect(frenchTrack).toBeVisible()
  await frenchTrack.click()
  await expect.poll(() => conversionRequests.length).toBe(2)
  expect(conversionRequests[1]).toMatchObject({ mode: 'remux', audioTrackIndex: 1 })
  await expect.poll(() => conversionRequests.length).toBe(3)
  expect(conversionRequests[2]).toMatchObject({ mode: 'audioAac', audioTrackIndex: 1 })
  await page.getByRole('button', { name: 'Audio tracks' }).click()
  await expect(page.getByRole('menuitemradio', { name: 'English' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('menuitemradio', { name: 'French' })).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('button', { name: 'Audio tracks' }).click()
  releaseFallbackConversion = true
  await expect.poll(() => video.evaluate((element: HTMLVideoElement, outputId: string) => element.currentSrc.includes(outputId), outputIds[2])).toBe(true)
  await page.getByRole('button', { name: 'Audio tracks' }).click()
  await expect(page.getByRole('menuitemradio', { name: 'French' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: 'Audio tracks' }).click()
  await page.getByRole('button', { name: 'Subtitle tracks' }).click()
  const selectedFrenchSubtitle = page.getByRole('menuitemradio', { name: 'French' })
  await expect(selectedFrenchSubtitle).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => video.evaluate((element) => Array.from(element.querySelectorAll<HTMLTrackElement>('track')).some((track) => track.track.mode === 'showing'))).toBe(true)
  await expect.poll(() => video.evaluate((element) => Array.from(element.textTracks).some((track) => track.cues?.[0]?.text === 'Subtitle fixture'))).toBe(true)
})

test('mobile HLS decoder failures are converted to a native MP4 by the worker', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'This verifies the mobile HLS-to-MP4 handoff in iOS WebKit and Chromium Android.')
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
  expect(conversionRequest).toMatchObject({ url: sourceUrl, mode: 'h264Aac', outputFormat: 'mp4' })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputMediaId}?`)
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration), { timeout: 15_000 }).toBeGreaterThan(2.9)
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 1.5 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 10_000 }).toBeGreaterThan(1.4)
})

test('mobile header-protected streams convert when the worker proxy session cannot open', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'This verifies mobile fallback for add-on request headers.')
  const sourceUrl = new URL('/header-protected-source.mp4', String(testInfo.project.use.baseURL)).toString()
  const outputMediaId = 'abababababababababababababababab'
  const jobId = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
  const fixture = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/mobile-h264-compat.mp4'))
  const requestHeaders = { authorization: 'Bearer add-on-stream-token', referer: 'https://addon.example/' }
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  await page.route('**/v1/media/sessions', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'media_proxy_unavailable' }),
  }))
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mediaRemux: true, mediaMp4: true, mediaHls: false, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  let conversionRequest: Record<string, unknown> | null = null
  await page.route('**/v1/media/conversions', async (route) => {
    conversionRequest = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'ready', mode: 'h264Aac', bytes: fixture.length, url: `/v1/media/${outputMediaId}?expires=1893456000&signature=header-conversion`, subtitles: [] }),
  }))
  await page.route(`**/v1/media/${outputMediaId}?*`, (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: fixture }))

  const query = new URLSearchParams({ source: sourceUrl, headers: JSON.stringify(requestHeaders) })
  await page.goto(`/tests/browser/player-harness.html?${query}`)
  const browserUserAgent = await page.evaluate(() => navigator.userAgent)
  const video = page.locator('video')
  await expect.poll(() => conversionRequest).toMatchObject({
    url: sourceUrl,
    mode: 'auto',
    outputFormat: 'mp4',
    mobileCompatibility: true,
    headers: { ...requestHeaders, 'user-agent': browserUserAgent },
  })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputMediaId}?`)
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
})

test('mobile playback stalls retry through the worker proxy without an error event', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'This verifies mobile direct-media stall recovery.')
  await page.clock.install()
  const sourcePath = '/stalled-mobile-source.mp4'
  const mediaId = 'dededededededededededededededede'
  const outputMediaId = 'efefefefefefefefefefefefefefefef'
  const jobId = 'abababababababababababababababab'
  const fixture = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/mobile-h264-compat.mp4'))
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  let sessionRequest: Record<string, unknown> | null = null
  await page.route(`**${sourcePath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'video/mp4', body: fixture })
  })
  await page.route('**/v1/media/sessions', async (route) => {
    sessionRequest = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ url: `/v1/media/${mediaId}?expires=1893456000&signature=stall-recovery`, expiresAt: 1893456000 }),
    })
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mediaRemux: true, mediaMp4: true, mediaHls: false, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  let conversionRequest: Record<string, unknown> | null = null
  await page.route('**/v1/media/conversions', async (route) => {
    conversionRequest = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'ready', mode: conversionRequest?.mode === 'h264AacLow' ? 'h264AacLow' : 'h264Aac', bytes: fixture.length, url: `/v1/media/${outputMediaId}?expires=1893456000&signature=stall-conversion`, subtitles: [] }),
  }))
  await page.route(`**/v1/media/${mediaId}?*`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'video/mp4', body: fixture })
  })
  await page.route(`**/v1/media/${outputMediaId}?*`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'video/mp4', body: fixture })
  })

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent(sourcePath)}`)
  const video = page.locator('video')
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true')
  await video.evaluate((element: HTMLVideoElement) => {
    element.loop = true
    Object.defineProperties(element, {
      readyState: { configurable: true, get: () => HTMLMediaElement.HAVE_CURRENT_DATA },
      currentTime: { configurable: true, get: () => 1.5, set: () => undefined },
      paused: { configurable: true, get: () => false },
    })
    element.dispatchEvent(new Event('waiting'))
  })
  await page.clock.fastForward(15_100)
  await expect.poll(() => sessionRequest).toMatchObject({ url: sourcePath, headers: {} })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${mediaId}?`)
  await video.evaluate((element: HTMLVideoElement) => element.dispatchEvent(new Event('waiting')))
  await page.clock.fastForward(15_100)
  await expect.poll(() => conversionRequest).toMatchObject({ url: sourcePath, mode: 'auto', outputFormat: 'mp4', mobileCompatibility: true })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputMediaId}?`)
  await video.evaluate((element: HTMLVideoElement) => element.dispatchEvent(new Event('waiting')))
  await page.clock.fastForward(15_100)
  await expect.poll(() => conversionRequest).toMatchObject({ url: sourcePath, mode: 'h264AacLow', outputFormat: 'mp4', mobileCompatibility: true })
})

test('mobile decoder errors go directly to H.264/AAC conversion', async ({ page }, testInfo) => {
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
  expect(modes).toEqual(['h264Aac'])
  await expect.poll(() => workerManifests.length).toBeGreaterThan(0)
  expect(workerManifests[0]).toContain('format=hls')
})

test('mobile decoder failures escalate through lower H.264 profiles', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'This verifies the mobile H.264 fallback ladder in iOS WebKit and Chromium Android.')
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
    h264Aac: '33333333333333333333333333333333',
    h264AacLow: '44444444444444444444444444444444',
    h264AacCompat: '55555555555555555555555555555555',
  }
  const outputIds: Record<string, string> = {
    h264Aac: '66666666666666666666666666666666',
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
      body: JSON.stringify({ jobId, status: 'ready', mode, bytes: 1024, url: `/v1/media/${outputIds[mode]}?expires=1893456000&signature=${mode}` }),
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
  expect(modes).toEqual(['h264Aac'])
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputIds.h264Aac}?`)
  await triggerDecoderFailure()
  await expect.poll(() => modes.length).toBe(2)
  expect(modes).toEqual(['h264Aac', 'h264AacLow'])
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputIds.h264AacLow}?`)
  await triggerDecoderFailure()
  await expect.poll(() => modes.length).toBe(3)
  expect(modes).toEqual(['h264Aac', 'h264AacLow', 'h264AacCompat'])
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

test('a stale mobile DASH capability response cannot replace a newly selected source', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'This checks mobile DASH source changes.')
  const oldSource = new URL('/old-mobile-source.mpd', String(testInfo.project.use.baseURL)).toString()
  const currentSource = new URL('/current-mobile-source.mpd', String(testInfo.project.use.baseURL)).toString()
  const jobId = 'abababababababababababababababab'
  const mediaId = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
  })
  let capabilityRequests = 0
  let releaseOldCapabilities!: () => void
  let markOldCapabilitiesDone!: () => void
  const oldCapabilitiesBlocked = new Promise<void>((resolve) => { releaseOldCapabilities = resolve })
  const oldCapabilitiesDone = new Promise<void>((resolve) => { markOldCapabilitiesDone = resolve })
  await page.route('**/v1/capabilities', async (route) => {
    const requestNumber = ++capabilityRequests
    if (requestNumber === 1) await oldCapabilitiesBlocked
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mediaRemux: true, mediaMp4: true, mediaHls: false, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
    })
    if (requestNumber === 1) markOldCapabilitiesDone()
  })
  const conversionSources: string[] = []
  await page.route('**/v1/media/conversions', async (route) => {
    conversionSources.push(JSON.parse(route.request().postData() || '{}').url as string)
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) })
  })
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'ready', mode: 'h264AacCompat', bytes: 1024, url: `/v1/media/${mediaId}?expires=1893456000&signature=current-mobile-source` }),
  }))
  await page.route(`**/v1/media/${mediaId}?*`, async (route) => {
    const fixture = await route.fetch({ url: new URL('/tests/browser/fixtures/mobile-h264-compat.mp4', route.request().url()).toString() })
    await route.fulfill({ response: fixture })
  })

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent(oldSource)}`)
  await expect.poll(() => capabilityRequests).toBe(1)
  await page.evaluate((source) => (window as Window & { __loadPlaybackSource?: (url: string) => void }).__loadPlaybackSource?.(source), currentSource)
  await expect.poll(() => capabilityRequests).toBe(2)
  await expect.poll(() => conversionSources.length).toBe(1)
  expect(conversionSources).toEqual([currentSource])
  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${mediaId}?`)
  releaseOldCapabilities()
  await oldCapabilitiesDone
  expect(conversionSources).toEqual([currentSource])
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
