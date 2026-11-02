import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:12.000000,\n/hls-test/segment-000.m2ts\n#EXT-X-ENDLIST\n'

test('InAppPlayer plays and seeks an HLS VOD source', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('webkit'), 'WebKit native HLS is verified by the dedicated Safari playback test below.')
  const segment = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/hls-segment-000.m2ts'))
  // Chromium and Firefox normally use HLS.js/MSE. Force that branch even on
  // engines that report a broad native-HLS MIME capability.
  await page.addInitScript(() => {
    const canPlayType = HTMLMediaElement.prototype.canPlayType
    HTMLMediaElement.prototype.canPlayType = function (type: string) {
      if (/mpegurl/i.test(type)) return ''
      return canPlayType.call(this, type)
    }
  })
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

  await page.getByRole('button', { name: 'Play', exact: true }).click()
  expect((await segmentResponse).status()).toBe(200)
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration), { timeout: 15_000 }).toBeGreaterThan(2.9)
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 1.5 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 10_000 }).toBeGreaterThan(1.4)
  await expect(page.locator('body')).not.toHaveAttribute('data-playback-error', /.+/)
})


test('native Safari HLS plays the checked-in fixture and seeks', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('webkit'), 'Native HLS is specific to WebKit in this browser matrix.')
  const manifestBody = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/h264-aac.m3u8'), 'utf8')
  await page.route('**/tests/browser/fixtures/h264-aac.m3u8', (route) => route.fulfill({
    status: 200,
    contentType: 'application/vnd.apple.mpegurl; charset=utf-8',
    body: manifestBody,
  }))
  const manifestResponse = page.waitForResponse((response) => response.url().endsWith('/tests/browser/fixtures/h264-aac.m3u8'))
  const segmentResponse = page.waitForResponse((response) => response.url().endsWith('/tests/browser/fixtures/hls-segment-000.m2ts'))
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent('/tests/browser/fixtures/h264-aac.m3u8')}`)
  const manifest = await manifestResponse
  expect(manifest.status()).toBe(200)
  expect(manifest.headers()['content-type']).toContain('application/vnd.apple.mpegurl')

  await page.getByRole('button', { name: 'Play', exact: true }).click()
  expect((await segmentResponse).status()).toBe(200)
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  const video = page.locator('video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration), { timeout: 15_000 }).toBeGreaterThan(11.9)
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 5 })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 10_000 }).toBeGreaterThan(4.9)
  await expect(page.locator('body')).not.toHaveAttribute('data-playback-error', /.+/)
})

test('native Safari HLS recognizes a signed worker playlist without an m3u8 path suffix', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('webkit'), 'Native HLS is specific to WebKit in this browser matrix.')
  const mediaId = '0123456789abcdef0123456789abcdef'
  const segment = await readFile(resolve(process.cwd(), 'tests/browser/fixtures/hls-segment-000.m2ts'))
  const segmentPath = `/v1/media/${mediaId}/0123456789abcdef0123456789abcdef-remux.ts`
  const workerUrl = `/v1/media/${mediaId}?expires=1893456000&signature=opaque&format=hls`
  const manifestBody = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:12.000000,\n${segmentPath}?expires=1893456000&signature=opaque\n#EXT-X-ENDLIST\n`
  await page.route(`**/v1/media/${mediaId}?*`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: manifestBody,
  }))
  await page.route(`**/v1/media/${mediaId}/0123456789abcdef0123456789abcdef-remux.ts?*`, (route) => route.fulfill({
    status: 200,
    contentType: 'video/mp2t',
    body: segment,
  }))
  const manifestResponse = page.waitForResponse((response) => response.url().includes(`/v1/media/${mediaId}?`))
  await page.goto(`/tests/browser/player-harness.html?source=${encodeURIComponent(workerUrl)}`)
  await expect(page.getByText('Using native HLS playback. Available audio and subtitle tracks depend on this browser and stream.')).toBeVisible()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  expect((await manifestResponse).status()).toBe(200)
  await expect(page.locator('body')).toHaveAttribute('data-playback-started', 'true', { timeout: 15_000 })
  await expect(page.locator('body')).not.toHaveAttribute('data-playback-error', /.+/)
})
