import { expect, test } from '@playwright/test'

test('Aurales InAppPlayer renders video frames, tracks progress, and seeks a browser-compatible source', async ({ page }, testInfo) => {
  const useMp4 = testInfo.project.name.includes('webkit')
  const fixture = useMp4 ? 'h264-aac.mp4' : 'vp8-opus.webm'
  const seekTarget = useMp4 ? 1.5 : 6

  const mediaResponse = page.waitForResponse((response) => response.url().endsWith(`/${fixture}`))
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent(`/tests/browser/fixtures/${fixture}`)}`)
  const response = await mediaResponse
  expect(response.status()).toBe(206)

  const video = page.locator('video')
  const supportedOutputs = await video.evaluate((element: HTMLVideoElement) => ({
    pictureInPicture: Boolean(document.pictureInPictureEnabled && element.requestPictureInPicture),
    airPlay: typeof (element as HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }).webkitShowPlaybackTargetPicker === 'function',
  }))
  expect(await page.getByRole('button', { name: 'Picture in picture' }).count()).toBe(Number(supportedOutputs.pictureInPicture))
  expect(await page.getByRole('button', { name: 'AirPlay' }).count()).toBe(Number(supportedOutputs.airPlay))
  const duration = await video.evaluate((element: HTMLVideoElement) => element.duration)
  expect(duration).toBeGreaterThan(useMp4 ? 2.9 : 11.9)
  expect(duration).toBeLessThan(useMp4 ? 3.1 : 12.1)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  // A moving media clock can still be a black/empty video surface. Read a
  // downsampled same-origin frame so these fixtures prove actual decode output.
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => {
    if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || element.videoWidth === 0) return 0
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 18
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return 0
    context.drawImage(element, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let visible = 0
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 96) visible += 1
    }
    return visible
  }), { message: 'the playing fixture should contain decoded non-black video frames' }).toBeGreaterThan(250)
  await video.evaluate((element: HTMLVideoElement, target: number) => { element.currentTime = target }, seekTarget)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(seekTarget)
  await expect(page.locator('body')).not.toHaveAttribute('data-playback-error', /.+/)
})

test('touch player controls fit a phone viewport and meet the minimum hit area', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, 'Touch-sized playback controls are verified in mobile browser projects.')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  await expect(page.locator('.inapp-player-controls')).toBeVisible()

  const metrics = await page.locator('.inapp-player-controls > div').nth(1).evaluate((row) => ({
    width: row.clientWidth,
    scrollWidth: row.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    optionsDisplay: getComputedStyle(row.querySelector<HTMLElement>('.inapp-player-options')!).display,
    buttons: Array.from(row.querySelectorAll('button')).map((button) => {
      const rect = button.getBoundingClientRect()
      return { width: rect.width, height: rect.height, left: rect.left, right: rect.right }
    }),
  }))
  expect(metrics.scrollWidth, 'playback controls must not extend beyond the phone viewport').toBeLessThanOrEqual(metrics.width + 1)
  expect(metrics.optionsDisplay, 'portrait player options should use the compact settings grid').toBe('grid')
  expect(metrics.buttons.length).toBeGreaterThan(0)
  expect(metrics.buttons.every((button) => button.width >= 44 && button.height >= 44), JSON.stringify(metrics.buttons)).toBe(true)
  expect(metrics.buttons.every((button) => button.left >= 0 && button.right <= metrics.viewportWidth + 1), JSON.stringify(metrics.buttons)).toBe(true)

  const fullscreen = await page.getByRole('button', { name: 'Full screen' }).boundingBox()
  expect(fullscreen).not.toBeNull()
  expect(fullscreen!.x + fullscreen!.width).toBeLessThanOrEqual(metrics.viewportWidth + 1)

  const notice = page.locator('.inapp-player-notice')
  if (await notice.isVisible()) {
    const [noticeBox, headerBox] = await Promise.all([
      notice.boundingBox(),
      page.locator('.inapp-player-header').boundingBox(),
    ])
    expect(noticeBox).not.toBeNull()
    expect(headerBox).not.toBeNull()
    expect(noticeBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height)
  }
})

test('landscape touch player keeps transport and track controls inside the safe viewport', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, 'The landscape control deck is verified in mobile browser projects.')
  await page.setViewportSize({ width: 844, height: 390 })
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  const controls = page.locator('.inapp-player-controls')
  await expect(controls).toBeVisible()

  const layout = await controls.evaluate((element) => {
    const row = element.querySelector<HTMLElement>('.inapp-player-control-row')!
    const transport = row.querySelector<HTMLElement>('.inapp-player-transport')!
    const options = row.querySelector<HTMLElement>('.inapp-player-options')!
    return {
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      controls: element.getBoundingClientRect().toJSON(),
      display: getComputedStyle(element).display,
      rowDisplay: getComputedStyle(row).display,
      transport: transport.getBoundingClientRect().toJSON(),
      options: options.getBoundingClientRect().toJSON(),
      controlsBounds: Array.from(row.querySelectorAll('button, select, input')).map((control) => {
        const rect = control.getBoundingClientRect()
        return { left: rect.left, right: rect.right, width: rect.width, height: rect.height }
      }),
    }
  })
  expect(layout.display).toBe('flex')
  expect(layout.rowDisplay).toBe('flex')
  expect(layout.controls.height).toBeLessThanOrEqual(layout.viewportHeight + 1)
  expect(layout.transport.y + layout.transport.height).toBeLessThanOrEqual(layout.viewportHeight + 1)
  expect(layout.options.y + layout.options.height).toBeLessThanOrEqual(layout.viewportHeight + 1)
  expect(layout.options.y).toBeGreaterThanOrEqual(layout.transport.y + layout.transport.height - 1)
  expect(layout.controlsBounds.every((control) => control.left >= -1 && control.right <= layout.viewportWidth + 1), JSON.stringify(layout.controlsBounds)).toBe(true)

  await page.locator('video').evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 4 }) })
    element.dispatchEvent(new Event('error'))
  })
  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible()
  await expect(controls).toBeVisible()
  const [alertBox, transportBox] = await Promise.all([alert.boundingBox(), controls.locator('.inapp-player-transport').boundingBox()])
  expect(alertBox).not.toBeNull()
  expect(transportBox).not.toBeNull()
  expect(alertBox!.x).toBeGreaterThanOrEqual(0)
  expect(alertBox!.x + alertBox!.width).toBeLessThanOrEqual(layout.viewportWidth + 1)
  expect(alertBox!.y + alertBox!.height).toBeLessThan(transportBox!.y)
})

test('player controls stay visible when a touch stream fails before playback starts', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, 'Persistent recovery controls are verified in mobile browser projects.')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  await page.locator('video').evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 4 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible()
  await page.waitForTimeout(2900)
  await expect(page.locator('.inapp-player-controls')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible()
})

test('browser media failures explain possible causes and worker-based conversion', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('webkit'), 'Synthetic MediaError delivery is unreliable in WebKit.')
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  await page.locator('video').evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 4 }) })
    element.dispatchEvent(new Event('error'))
  })
  await expect(page.getByRole('alert')).toContainText('Its format may be incompatible')
  await expect(page.getByRole('alert')).toContainText('Browsers cannot convert media on-device')
  await expect(page.getByRole('alert')).toContainText('Add an Aurales media worker in Settings')
})

test('a failed media source clears buffering and explains why iOS fullscreen is unavailable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'ios-webkit', 'The native fullscreen prerequisite is iOS-specific.')
  await page.setViewportSize({ width: 844, height: 390 })
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  const video = page.locator('video')
  await video.evaluate((element: HTMLVideoElement & { webkitEnterFullscreen?: () => void }) => {
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 4 }) })
    Object.defineProperty(element, 'webkitEnterFullscreen', { configurable: true, value: () => element.setAttribute('data-webkit-fullscreen-requested', 'true') })
    element.dispatchEvent(new Event('error'))
  })
  await expect(page.getByRole('alert')).toBeVisible()
  await video.evaluate((element) => element.dispatchEvent(new Event('waiting')))
  await expect(page.getByText('Buffering stream...')).toBeHidden()
  await page.getByRole('button', { name: 'Full screen' }).tap()
  await expect(video).not.toHaveAttribute('data-webkit-fullscreen-requested', 'true')
  await expect(page.locator('.inapp-player-notice')).toContainText('after a playable stream has loaded')
})

test('iOS player uses Safari native fullscreen when the standard API is unavailable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'ios-webkit', 'Safari native fullscreen fallback is iOS-specific.')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  const video = page.locator('video')
  await video.evaluate((element) => {
    const safariVideo = element as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
    Object.defineProperty(safariVideo, 'requestFullscreen', { configurable: true, value: undefined })
    Object.defineProperty(safariVideo, 'webkitEnterFullscreen', {
      configurable: true,
      value: () => safariVideo.setAttribute('data-webkit-fullscreen-requested', 'true'),
    })
  })

  await page.getByRole('button', { name: 'Full screen' }).tap()
  await expect(video).toHaveAttribute('data-webkit-fullscreen-requested', 'true')
})

test('iOS player calls Safari native fullscreen directly from the tap when both APIs exist', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'ios-webkit', 'Safari native fullscreen is iOS-specific.')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  const video = page.locator('video')
  await video.evaluate((element) => {
    const safariVideo = element as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
    Object.defineProperty(safariVideo, 'requestFullscreen', {
      configurable: true,
      value: () => { safariVideo.setAttribute('data-standard-fullscreen-requested', 'true'); return Promise.resolve() },
    })
    Object.defineProperty(safariVideo, 'webkitEnterFullscreen', {
      configurable: true,
      value: () => safariVideo.setAttribute('data-webkit-fullscreen-requested', 'true'),
    })
  })

  await page.getByRole('button', { name: 'Full screen' }).tap()
  await expect(video).toHaveAttribute('data-webkit-fullscreen-requested', 'true')
  await expect(video).not.toHaveAttribute('data-standard-fullscreen-requested', 'true')
})

test('a late rejection from an earlier play request does not replace active playback with an error', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('webkit'), 'WebKit playback timing is covered by the real fixture test; synthetic autoplay races are unreliable there.')
  await page.addInitScript(() => {
    const nativePlay = HTMLMediaElement.prototype.play
    let delayFirstResult = true
    HTMLMediaElement.prototype.play = function (...args: Parameters<typeof nativePlay>) {
      if (!delayFirstResult) return nativePlay.apply(this, args)
      delayFirstResult = false
      return new Promise<void>((_resolve, reject) => {
        window.setTimeout(() => reject(new DOMException('Superseded play request', 'AbortError')), 1200)
      })
    }
  })

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  await page.waitForTimeout(1400)
  await expect(page.locator('body')).not.toHaveAttribute('data-playback-error', /.+/)
})

test('Aurales InAppPlayer converts external ASS subtitles for browser text tracks', async ({ page }) => {
  await page.route('**/sample.ass', (route) => route.fulfill({
    status: 200,
    contentType: 'text/plain; charset=utf-8',
    body: '[Script Info]\nTitle: fixture\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:02.50,Default,,0,0,0,,Browser subtitle cue',
  }))
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}&subtitle=${encodeURIComponent('/sample.ass')}`)
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => {
    const cues = video.textTracks[0]?.cues
    return cues?.length ? cues[0].text : ''
  })).toBe('Browser subtitle cue')
  await expect(page.getByLabel('Subtitle track')).toContainText('External subtitle')
})

test('Aurales InAppPlayer exposes browser-native subtitle tracks in its selector', async ({ page }) => {
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  await page.locator('video').evaluate((video) => {
    video.addTextTrack('subtitles', 'Native English', 'en')
    video.dispatchEvent(new Event('loadedmetadata'))
  })
  const selector = page.getByLabel('Subtitle track')
  await expect(selector).toContainText('Native English')
  await selector.selectOption({ label: 'Native English' })
  const mode = await page.locator('video').evaluate((video) => Array.from(video.textTracks).find((track) => track.label === 'Native English')?.mode)
  expect(mode).toBe('showing')
})

test('changing stream resets browser conversion attempts for the next source', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('webkit'), 'WebKit does not reliably accept a synthetic MediaError; browser playback is covered by real fixture tests.')
  const initial = '/tests/browser/fixtures/vp8-opus.webm'
  await page.addInitScript(() => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'x'.repeat(32) }))
    // This case injects decode errors directly; keep real playback idle so a
    // short fixture cannot end while the conversion controls are being tested.
    HTMLMediaElement.prototype.play = () => Promise.resolve()
  })
  await page.route('**/v1/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mediaRemux: true }),
  }))
  const conversionSources: string[] = []
  await page.route('**/v1/media/conversions', (route) => {
    conversionSources.push(String(JSON.parse(route.request().postData() || '{}').url))
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'ffmpeg_not_configured' }),
    })
  })

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent(initial)}`)
  const video = page.locator('video')
  const causeDecodeError = () => video.evaluate((element: HTMLVideoElement) => {
    element.pause()
    if (element.readyState > 0) element.currentTime = 0
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  await causeDecodeError()
  await expect.poll(() => conversionSources.length).toBe(1)
  expect(conversionSources[0]).toContain('/vp8-opus.webm')

  await page.evaluate(() => (window as Window & { __loadNextSource?: () => void }).__loadNextSource?.())
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain('/h264-aac.mp4')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState >= 1)).toBe(true)
  await causeDecodeError()
  await expect.poll(() => conversionSources.length).toBe(2)
  expect(conversionSources[1]).toContain('/h264-aac.mp4')
})
