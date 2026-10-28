import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:12.000000,\n/hls-test/segment-000.m2ts\n#EXT-X-ENDLIST\n'

test('InAppPlayer plays and seeks an HLS VOD source', async ({ page }, testInfo) => {
  const segment = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/hls-segment-000.m2ts'))
  if (!testInfo.project.name.includes('webkit')) {
    // Chromium and Firefox normally use HLS.js/MSE. Force the runtime branch
    // even on engines that report a broad native-HLS MIME capability.
    await page.addInitScript(() => {
      const canPlayType = HTMLMediaElement.prototype.canPlayType
      HTMLMediaElement.prototype.canPlayType = function (type: string) {
        if (/mpegurl/i.test(type)) return ''
        return canPlayType.call(this, type)
      }
    })
  }
  await page.route('**/hls-test/master.m3u8', (route) => route.fulfill({
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: manifest,
  }))
  await page.route('**/hls-test/segment-000.m2ts', (route) => route.fulfill({
    status: 200,
    contentType: 'video/mp2t',
    body: segment,
  }))

  const segmentResponse = page.waitForResponse((response) => response.url().endsWith('/hls-test/segment-000.m2ts'))
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/hls-test/master.m3u8')}`)
  const video = page.locator('video')
  const capabilities = await video.evaluate((element: HTMLVideoElement) => ({
    nativeHls: Boolean(element.canPlayType('application/vnd.apple.mpegurl')),
    mediaSource: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
  }))
  test.skip(!capabilities.nativeHls && !capabilities.mediaSource, 'This browser engine has neither native HLS nor an HLS.js-compatible MediaSource.')

  await page.getByRole('button', { name: 'Play' }).click()
  expect((await segmentResponse).status()).toBe(200)
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration), { timeout: 15_000 }).toBeGreaterThan(2.9)
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 1.5 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 10_000 }).toBeGreaterThan(1.4)
  await expect(page.locator('body')).not.toHaveAttribute('data-playback-error', /.+/)
})
