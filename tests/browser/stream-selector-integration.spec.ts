import { expect, test } from '@playwright/test'

test('StreamSelector loads a browser addon source and starts the shared web player', async ({ page }, testInfo) => {
  const useMp4 = testInfo.project.name.includes('webkit')
  const fixture = useMp4 ? 'h264-aac.mp4' : 'vp8-opus.webm'
  const fixtureUrl = new URL(`/tests/browser/fixtures/${fixture}`, (testInfo.project.use.baseURL || 'http://127.0.0.1:5175').replace('127.0.0.1', 'localhost')).toString()
  await page.route('**/fixture-addon/subtitles/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ subtitles: [] }),
  }))
  await page.route('**/fixture-addon/stream/movie/tt0000001.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ streams: [{ name: '720p WEB-DL AAC', title: 'Browser fixture', url: fixtureUrl }] }),
  }))

  await page.goto('/tests/browser/stream-selector-harness.html')
  const streamChoice = page.locator('[data-stream-choice]')
  await expect(streamChoice).toBeVisible({ timeout: 15_000 })
  const mediaResponse = page.waitForResponse((response) => response.url().endsWith(`/${fixture}`))
  await streamChoice.click()

  const video = page.locator('video')
  const response = await mediaResponse
  expect(response.status()).toBe(206)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration), { timeout: 15_000 }).toBeGreaterThan(useMp4 ? 2.9 : 11.9)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false)
  await video.evaluate((element: HTMLVideoElement, target: number) => { element.currentTime = target }, useMp4 ? 1.5 : 6)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(useMp4 ? 1.5 : 6)
})

test('mobile StreamSelector passes inferred HEVC Main 10 and 4K metadata into automatic worker conversion', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Inferred mobile codec conversion is checked on phone browsers.')
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', { configurable: true, value: () => 'maybe' })
    Object.defineProperty(navigator, 'mediaCapabilities', {
      configurable: true,
      value: { decodingInfo: async (configuration: unknown) => {
        ;(window as Window & { __decodingProfiles?: unknown[] }).__decodingProfiles ||= []
        ;(window as Window & { __decodingProfiles?: unknown[] }).__decodingProfiles!.push(configuration)
        return { supported: false, smooth: false, powerEfficient: false }
      } },
    })
  })
  await page.route('**/fixture-addon/subtitles/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ subtitles: [] }),
  }))
  await page.route('**/fixture-addon/stream/movie/tt0000001.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ streams: [{
      name: 'Test addon',
      // Keep the container out of the filename so the test exercises the
      // browser's detailed capability probe instead of the MKV fast path.
      title: 'Film.2160p.WEB-DL.HEVC.Main10.DDP5.1.35Mbps.59.94fps',
      url: 'https://signed.cdn.example/film?token=redacted',
    }] }),
  }))
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ mediaMp4: true, mediaRemux: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  let conversionRequest: Record<string, unknown> | null = null
  await page.route('**/v1/media/conversions', (route) => {
    conversionRequest = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 'abababababababababababababababab', status: 'processing' }) })
  })
  await page.route('**/v1/media/conversions/abababababababababababababababab', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ jobId: 'abababababababababababababababab', status: 'failed', error: 'source_forbidden' }),
  }))

  await page.goto('/tests/browser/stream-selector-harness.html')
  await page.locator('[data-stream-choice]').click()
  await expect.poll(() => conversionRequest).toMatchObject({
    url: 'https://signed.cdn.example/film?token=redacted',
    // WebKit's capability probe rejects this HEVC Main 10 profile, so mobile
    // playback should go straight to H.264 instead of wasting time on `auto`.
    mode: 'h264Aac', outputFormat: 'mp4', mobileCompatibility: true,
  })
  const profile = await page.evaluate(() => (window as Window & { __decodingProfiles?: Array<{ video?: { contentType: string; width: number; height: number; bitrate: number; framerate: number } }> }).__decodingProfiles?.[0])
  expect(profile?.video).toMatchObject({
    contentType: 'video/mp4; codecs="hvc1.2.4.L120.B0,ec-3"',
    width: 3840, height: 2160, bitrate: 35_000_000, framerate: 59.94,
  })
  const conversionError = page.getByRole('alert')
  await expect(conversionError).toContainText('Source host: signed.cdn.example')
  await expect(conversionError).not.toContainText('redacted')
})

test('mobile Smart Play automatically moves to another source after a worker 403', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Mobile playback recovery.')
  const fixture = testInfo.project.name === 'ios-webkit' ? 'h264-aac.mp4' : 'vp8-opus.webm'
  const fixtureUrl = new URL(`/tests/browser/fixtures/${fixture}?fallback=1`, (testInfo.project.use.baseURL || 'http://127.0.0.1:5175').replace('127.0.0.1', 'localhost')).toString()
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    localStorage.setItem('aurales_automatic_stream_recovery', 'true')
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', { configurable: true, value: () => 'maybe' })
    Object.defineProperty(navigator, 'mediaCapabilities', { configurable: true, value: { decodingInfo: async () => ({ supported: false, smooth: false, powerEfficient: false }) } })
  })
  await page.route('**/fixture-addon/subtitles/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subtitles: [] }) }))
  await page.route('**/fixture-addon/stream/series/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ streams: [
      { name: 'Test addon', title: 'Episode.2160p.HEVC.Main10.mkv', url: 'https://signed.cdn.example/blocked.mkv?token=redacted' },
      { name: 'Test addon', title: 'Episode 720p H264', url: fixtureUrl },
    ] }),
  }))
  await page.route('**/v1/capabilities', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mediaMp4: true, mediaRemux: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }) }))
  await page.route('**/v1/media/conversions', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', status: 'processing' }) }))
  await page.route('**/v1/media/conversions/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', status: 'failed', error: 'source_forbidden' }) }))
  await page.goto('/tests/browser/stream-selector-harness.html?series=1&auto=1')
  const fallbackResponse = page.waitForResponse((response) => response.url().includes(`/${fixture}?fallback=1`))
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentSrc), { timeout: 20_000 }).toContain(`/${fixture}?fallback=1`)
  expect((await fallbackResponse).status()).toBe(206)
})

for (const workerFailure of [
  { label: 'cannot fetch its signed URL', error: 'source_not_found' },
  { label: 'cannot create a compatible copy', error: 'no_compatible_output' },
  { label: 'is unavailable during capability detection', workerUnavailable: true },
]) test(`mobile manual source choice automatically moves on when the worker ${workerFailure.label}`, async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Mobile source recovery.')
  const jobId = 'dededededededededededededededede'
  const fixture = testInfo.project.name === 'ios-webkit' ? 'h264-aac.mp4' : 'vp8-opus.webm'
  const fixtureUrl = new URL(`/tests/browser/fixtures/${fixture}?manual-fallback=1`, (testInfo.project.use.baseURL || 'http://127.0.0.1:5175').replace('127.0.0.1', 'localhost')).toString()
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    localStorage.setItem('aurales_automatic_stream_recovery', 'true')
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', { configurable: true, value: (type: string) => type.includes('hvc1.2.4.L120.B0') ? '' : 'maybe' })
  })
  await page.route('**/fixture-addon/subtitles/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subtitles: [] }) }))
  await page.route('**/fixture-addon/stream/movie/tt0000001.json', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ streams: [{ name: 'Test addon', title: 'Film.2160p.HEVC.Main10.mkv', url: 'https://signed.cdn.example/blocked.mkv?token=redacted' }] }),
  }))
  await page.route('**/fixture-addon-two/subtitles/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subtitles: [] }) }))
  await page.route('**/fixture-addon-two/stream/movie/tt0000001.json', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ streams: [{ name: 'Test addon two', title: 'Film 720p H264', url: fixtureUrl }] }),
  }))
  if (!workerFailure.workerUnavailable) {
    await page.route('**/v1/capabilities', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mediaMp4: true, mediaRemux: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }) }))
    await page.route('**/v1/media/conversions', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'processing' }) }))
    await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobId, status: 'failed', error: workerFailure.error }) }))
  }
  await page.goto('/tests/browser/stream-selector-harness.html?multi=1')
  const fallbackResponse = page.waitForResponse((response) => response.url().includes(`/${fixture}?manual-fallback=1`))
  await page.locator('[data-stream-choice]').first().click()
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentSrc), { timeout: 20_000 }).toContain(`/${fixture}?manual-fallback=1`)
  expect((await fallbackResponse).status()).toBe(206)
})

test('mobile refreshes an expired source URL from its addon after worker access fails', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Signed-source refresh is checked on mobile browsers.')
  const fixture = testInfo.project.name === 'ios-webkit' ? 'h264-aac.mp4' : 'vp8-opus.webm'
  const fixtureUrl = new URL(`/tests/browser/fixtures/${fixture}?fresh-signed-url=1`, (testInfo.project.use.baseURL || 'http://127.0.0.1:5175').replace('127.0.0.1', 'localhost')).toString()
  let addonRequests = 0
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    localStorage.setItem('aurales_automatic_stream_recovery', 'true')
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', {
      configurable: true,
      value: (type: string) => type.includes('hvc1.2.4.L120.B0') ? '' : 'maybe',
    })
  })
  await page.route('**/fixture-addon/subtitles/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ subtitles: [] }),
  }))
  await page.route('**/fixture-addon/stream/movie/tt0000001.json', (route) => {
    addonRequests += 1
    const stream = addonRequests === 1
      ? { name: 'Test addon', title: 'Film.2160p.HEVC.Main10.mkv', url: 'https://signed.cdn.example/expired.mkv?token=old' }
      : { name: 'Test addon', title: 'Film.720p.H264.mp4', url: fixtureUrl }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ streams: [stream] }) })
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mediaMp4: true, mediaRemux: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  const jobId = 'abababababababababababababababab'
  await page.route('**/v1/media/conversions', (route) => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'processing' }),
  }))
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'failed', error: 'source_forbidden' }),
  }))

  await page.goto('/tests/browser/stream-selector-harness.html')
  const mediaResponse = page.waitForResponse((response) => response.url().includes(`/${fixture}?fresh-signed-url=1`))
  await page.locator('[data-stream-choice]').click()
  await expect.poll(() => addonRequests).toBe(2)
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentSrc), { timeout: 20_000 }).toContain(`/${fixture}?fresh-signed-url=1`)
  expect((await mediaResponse).status()).toBe(206)
})

test('mobile resumes at the current position after refreshing a source during playback', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Position-preserving source refresh is checked on mobile browsers.')
  const fixture = testInfo.project.name === 'ios-webkit' ? 'h264-aac.mp4' : 'vp8-opus.webm'
  const base = (testInfo.project.use.baseURL || 'http://127.0.0.1:5175').replace('127.0.0.1', 'localhost')
  const firstUrl = new URL(`/tests/browser/fixtures/${fixture}?refresh=old`, base).toString()
  const refreshedUrl = new URL(`/tests/browser/fixtures/${fixture}?refresh=new`, base).toString()
  let addonRequests = 0
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    localStorage.setItem('aurales_automatic_stream_recovery', 'true')
  })
  await page.route('**/fixture-addon/subtitles/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ subtitles: [] }),
  }))
  await page.route('**/fixture-addon/stream/movie/tt0000001.json', (route) => {
    addonRequests += 1
    const url = addonRequests === 1 ? firstUrl : refreshedUrl
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ streams: [{ name: 'Test addon', title: 'Film.720p.H264.mp4', url }] }),
    })
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mediaMp4: true, mediaRemux: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }),
  }))
  const jobId = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
  await page.route('**/v1/media/conversions', (route) => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'processing' }),
  }))
  await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobId, status: 'failed', error: 'source_forbidden' }),
  }))

  await page.goto('/tests/browser/stream-selector-harness.html')
  const video = page.locator('video')
  const firstMediaResponse = page.waitForResponse((response) => response.url() === firstUrl)
  await page.locator('[data-stream-choice]').click()
  expect((await firstMediaResponse).status()).toBe(206)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.2)
  const resumePosition = await video.evaluate((element: HTMLVideoElement) => Math.min(1.5, element.duration / 2))
  await video.evaluate(async (element: HTMLVideoElement, position: number) => {
    await element.play()
    element.currentTime = position
  }, resumePosition)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 10_000 }).toBeGreaterThan(resumePosition - 0.2)
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 4 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect.poll(() => addonRequests).toBe(2)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc), { timeout: 20_000 }).toContain(`/${fixture}?refresh=new`)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(resumePosition - 0.2)
})

test('mobile manual source choice falls back when the browser rejects every worker video profile', async ({ page }, testInfo) => {
  test.skip(!['ios-webkit', 'android-chromium'].includes(testInfo.project.name), 'Mobile decoder recovery.')
  const fixture = 'mobile-h264-compat.mp4'
  const fixtureUrl = new URL(`/tests/browser/fixtures/${fixture}?cross-addon-fallback=1`, (testInfo.project.use.baseURL || 'http://127.0.0.1:5175').replace('127.0.0.1', 'localhost')).toString()
  const jobs = { auto: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', h264AacLow: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', h264AacCompat: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3' }
  const outputs = { auto: 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', h264AacLow: 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5', h264AacCompat: 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6' }
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    localStorage.setItem('aurales_automatic_stream_recovery', 'true')
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', { configurable: true, value: (type: string) => type.includes('hvc1.2.4.L120.B0') ? '' : 'maybe' })
  })
  await page.route('**/fixture-addon/subtitles/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subtitles: [] }) }))
  await page.route('**/fixture-addon/stream/movie/tt0000001.json', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ streams: [{ name: 'Test addon', title: 'Film.2160p.HEVC.Main10.mkv', url: 'https://signed.cdn.example/blocked.mkv?token=redacted' }] }),
  }))
  await page.route('**/fixture-addon-two/subtitles/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subtitles: [] }) }))
  await page.route('**/fixture-addon-two/stream/movie/tt0000001.json', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ streams: [{ name: 'Test addon two', title: 'Film 720p H264', url: fixtureUrl }] }),
  }))
  await page.route('**/v1/capabilities', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mediaMp4: true, mediaRemux: true, audioTranscode: true, videoTranscode: true, mobileSafeVideoTranscode: true }) }))
  const requestedModes: string[] = []
  await page.route('**/v1/media/conversions', (route) => {
    const mode = JSON.parse(route.request().postData() || '{}').mode as keyof typeof jobs
    requestedModes.push(mode)
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: jobs[mode], status: 'processing' }) })
  })
  for (const mode of Object.keys(jobs) as Array<keyof typeof jobs>) {
    const jobId = jobs[mode]
    const outputId = outputs[mode]
    await page.route(`**/v1/media/conversions/${jobId}`, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ jobId, status: 'ready', mode: mode === 'auto' ? 'h264Aac' : mode, bytes: 1024, url: `/v1/media/${outputId}?expires=1893456000&signature=${mode}`, subtitles: [] }),
    }))
    await page.route(`**/v1/media/${outputId}?*`, async (route) => {
      const response = await route.fetch({ url: new URL(`/tests/browser/fixtures/${fixture}`, route.request().url()).toString() })
      await route.fulfill({ response })
    })
  }
  await page.goto('/tests/browser/stream-selector-harness.html?multi=1')
  await page.locator('[data-stream-choice]').first().click()
  const video = page.locator('video')
  const failCurrentDecode = () => video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  // WebKit may reject the first worker output as soon as it is attached. Follow
  // the conversion queue, then reject the current output until all profiles ran.
  await expect.poll(() => requestedModes.length).toBeGreaterThan(0)
  // A real WebKit decode error can already advance auto to the smaller profile.
  if (requestedModes.length === 1) {
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputs.auto}?`)
    await failCurrentDecode()
    await expect.poll(() => requestedModes.length, { timeout: 20_000 }).toBe(2)
  }
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputs.h264AacLow}?`)
  await failCurrentDecode()
  await expect.poll(() => requestedModes.length, { timeout: 20_000 }).toBe(3)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain(`/v1/media/${outputs.h264AacCompat}?`)
  await failCurrentDecode()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc), { timeout: 20_000 }).toContain(`/${fixture}?cross-addon-fallback=1`)
  expect(requestedModes).toEqual(['h264Aac', 'h264AacLow', 'h264AacCompat'])
})

test('next episode starts its first source with a fresh recovery queue', async ({ page }, testInfo) => {
  const fixture = testInfo.project.name.includes('webkit') ? 'h264-aac.mp4' : 'vp8-opus.webm'
  const requests: string[] = []
  await page.route('**/fixture-addon/subtitles/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ subtitles: [] }),
  }))
  await page.route('**/fixture-addon/stream/series/**', (route) => {
    const url = route.request().url()
    requests.push(url)
    const episode = /:1:(\d+)\.json/.exec(decodeURIComponent(url))?.[1]
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ streams: [1, 2].map((source) => ({
        name: '720p WEB-DL AAC', title: `Episode ${episode} source ${source}`,
        url: `${new URL(`/tests/browser/fixtures/${fixture}`, (testInfo.project.use.baseURL || 'http://127.0.0.1:5175').replace('127.0.0.1', 'localhost'))}?episode=${episode}&source=${source}`,
      })) }),
    })
  })
  await page.goto('/tests/browser/stream-selector-harness.html?series=1')
  await expect(page.locator('[data-stream-choice]')).toHaveCount(2)
  await page.locator('[data-stream-choice]').first().click()
  const next = page.getByRole('button', { name: 'Skip to next episode, season 1 episode 2' })
  await expect(next).toBeVisible()
  await next.click()
  await expect(page.locator('body')).toHaveAttribute('data-episode', '1:2')
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentSrc)).toContain('episode=2&source=1')
  expect(requests.some((url) => decodeURIComponent(url).includes('tt0000001:1:2.json'))).toBe(true)
  await page.getByRole('button', { name: 'Skip to next episode, season 1 episode 3' }).click()
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentSrc)).toContain('episode=3&source=1')
  await expect(page.locator('body')).toHaveAttribute('data-episode', '1:3')
})
