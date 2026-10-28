import { expect, test } from '@playwright/test'

const liveMediaUrl = process.env.AURALES_LIVE_MEDIA_URL

test.skip(!liveMediaUrl, 'Set AURALES_LIVE_MEDIA_URL to an authorized, CORS-enabled HTTPS media URL to run live playback checks.')

test('shared InAppPlayer can play and seek a live CORS-enabled media URL with byte ranges', async ({ page }) => {
  if (!liveMediaUrl) return
  const mediaOrigin = new URL(liveMediaUrl).origin
  // Start with a local source so a signed provider URL is passed only in memory
  // instead of appearing in the harness page URL or Playwright's navigation log.
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.mp4')}`)
  const corsRangeProbe = await page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { Range: 'bytes=0-1023' } })
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength }
  }, liveMediaUrl)
  expect(corsRangeProbe).toEqual({ status: 206, bytes: 1024 })

  // Distinguish the media element's byte-range request from the CORS probe
  // above. This verifies the browser player itself can fetch seekable media.
  const rangedMediaResponse = page.waitForResponse((response) => {
    const request = response.request()
    const headers = request.headers()
    const isVideoRequest = request.resourceType() === 'media' || headers['sec-fetch-dest'] === 'video'
    return response.url().startsWith(mediaOrigin)
      && isVideoRequest
      && headers.range != null
      && response.status() === 206
  }, { timeout: 30_000 })

  await page.evaluate((url) => {
    (window as Window & { __loadPlaybackSource?: (source: string) => void }).__loadPlaybackSource?.(url)
  }, liveMediaUrl)
  const mediaResponse = await rangedMediaResponse
  expect(mediaResponse.status()).toBe(206)

  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 20_000 })

  const seekTarget = await video.evaluate((element: HTMLVideoElement) => Math.min(2, element.duration / 2))
  expect(seekTarget).toBeGreaterThan(0)
  await video.evaluate((element: HTMLVideoElement, target) => {
    element.pause()
    element.currentTime = target
  }, seekTarget)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(seekTarget)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeLessThan(seekTarget + 0.25)
  await expect(page.locator('body')).not.toHaveAttribute('data-playback-error', /.+/)
})
