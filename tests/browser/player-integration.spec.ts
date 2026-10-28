import { expect, test } from '@playwright/test'

test('Aurales InAppPlayer starts, tracks progress, and seeks a browser-compatible source', async ({ page }, testInfo) => {
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
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  await video.evaluate((element: HTMLVideoElement, target: number) => { element.currentTime = target }, seekTarget)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(seekTarget)
  await expect(page.locator('body')).not.toHaveAttribute('data-playback-error', /.+/)
})

test('a late rejection from an earlier play request does not replace active playback with an error', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Play' }).click()
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
  await page.route('**/v1/media/conversions', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'ffmpeg_not_configured' }),
  }))

  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent(initial)}`)
  const video = page.locator('video')
  const causeDecodeError = () => video.evaluate((element: HTMLVideoElement) => {
    element.pause()
    if (element.readyState > 0) element.currentTime = 0
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3 }) })
    element.dispatchEvent(new Event('error'))
  })
  await causeDecodeError()
  const remux = page.getByRole('button', { name: 'Try stream-copy remux' })
  await expect(remux).toBeVisible()
  await remux.click()
  await expect(remux).toHaveCount(0)

  await page.evaluate(() => (window as Window & { __loadNextSource?: () => void }).__loadNextSource?.())
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain('/h264-aac.mp4')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState >= 1)).toBe(true)
  await causeDecodeError()
  await expect(remux).toBeVisible()
})
