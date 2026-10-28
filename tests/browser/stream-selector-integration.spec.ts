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
  await page.getByRole('button', { name: 'Play' }).click()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false)
  await video.evaluate((element: HTMLVideoElement, target: number) => { element.currentTime = target }, useMp4 ? 1.5 : 6)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(useMp4 ? 1.5 : 6)
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
